import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  createHandForkRequestSchema,
  handForkSourceErrorCodeSchema,
  type AdminHandFork,
  type CreateHandForkRequest,
  type HandForkSourceCandidate,
} from "../../../../../packages/contracts/src/index.js";
import { requireAdmin, type AdminAuthContext } from "../../auth/routes.js";
import { HandForkPersistenceConflictError } from "./hand-fork-repository.js";
import { HandForkSourceCatalogError } from "./hand-fork-source-catalog.js";
import { HandForkSourceError } from "./hand-fork-source.js";
import {
  HandForkServiceStoppedError,
  HandForkTargetUnavailableError,
} from "./hand-fork-service.js";

const uuidSchema = z.string().uuid();
const handNoParamSchema = z.string().regex(/^[1-9]\d*$/).transform(Number).refine(
  Number.isSafeInteger,
  "handNo must be a positive safe integer",
);
const sourceParamsSchema = z.object({
  tournamentId: uuidSchema,
  handNo: handNoParamSchema,
}).strict();
const idParamsSchema = z.object({ id: uuidSchema }).strict();
const listQuerySchema = z.object({
  limit: z.string().regex(/^[1-9]\d*$/).transform(Number).refine(
    (value) => Number.isSafeInteger(value) && value <= 200,
    "limit must be between 1 and 200",
  ).optional(),
}).strict();
const emptyBodySchema = z.object({}).strict();

export interface HandForkRouteCatalog {
  list(tournamentId: string, handNo: number): Promise<HandForkSourceCandidate[]>;
}

export interface HandForkRouteService {
  create(input: CreateHandForkRequest, adminUserId: string | null): Promise<AdminHandFork>;
  list(limit?: number): Promise<AdminHandFork[]>;
  get(id: string): Promise<AdminHandFork | null>;
  cancel(id: string): Promise<AdminHandFork | null>;
}

export interface HandForkRouteContext extends AdminAuthContext {
  pool: Pick<Pool, "query">;
  catalog: HandForkRouteCatalog;
  handForks: HandForkRouteService;
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
}

async function auditHandFork(
  pool: Pick<Pool, "query">,
  adminUserId: string,
  action: "hand_fork.create" | "hand_fork.cancel",
  targetId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `insert into audit_events
      (id, admin_user_id, action, target_type, target_id, metadata)
     values ($1, $2, $3, 'hand_fork', $4, $5::jsonb)`,
    [randomUUID(), adminUserId, action, targetId, JSON.stringify(metadata)],
  );
}

async function auditCompletedMutation(
  request: FastifyRequest,
  context: HandForkRouteContext,
  adminUserId: string,
  action: "hand_fork.create" | "hand_fork.cancel",
  targetId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await auditHandFork(context.pool, adminUserId, action, targetId, metadata);
  } catch (error) {
    // The mutation has already committed. Returning 500 here would invite a
    // browser retry and can duplicate a paid experiment. Keep the successful
    // business response and surface the missing audit record to operators.
    request.log.error({
      action,
      targetId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    }, "hand fork audit write failed after mutation");
  }
}

function sendHandForkError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof HandForkSourceCatalogError) {
    return reply.code(404).send({
      error: error.code === "TOURNAMENT_NOT_FOUND" ? "tournament_not_found" : "hand_not_found",
    });
  }
  if (error instanceof HandForkSourceError) {
    const reasonCode = handForkSourceErrorCodeSchema.safeParse(error.code);
    if (!reasonCode.success) {
      request.log.error({ err: error }, "unknown hand fork source error code");
      return reply.code(500).send({ error: "hand_fork_failed" });
    }
    if (reasonCode.data === "SOURCE_NOT_FOUND") {
      return reply.code(404).send({ error: "source_decision_not_found" });
    }
    return reply.code(409).send({
      error: "hand_fork_source_unavailable",
      reasonCode: reasonCode.data,
    });
  }
  if (error instanceof HandForkTargetUnavailableError) {
    return reply.code(409).send({ error: "hand_fork_target_unavailable" });
  }
  if (error instanceof HandForkPersistenceConflictError
    || error instanceof HandForkServiceStoppedError) {
    return reply.code(409).send({ error: "hand_fork_conflict" });
  }
  request.log.error({ err: error }, "hand fork request failed");
  return reply.code(500).send({ error: "hand_fork_failed" });
}

export async function registerHandForkRoutes(
  app: FastifyInstance,
  context: HandForkRouteContext,
): Promise<void> {
  app.get<{ Params: { tournamentId: string; handNo: string } }>(
    "/api/admin/tournaments/:tournamentId/hands/:handNo/hand-fork-sources",
    async (request, reply) => {
      noStore(reply);
      if (!(await requireAdmin(request, reply, context, false))) return;
      const params = sourceParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid_hand_fork_source_query" });
      }
      try {
        return { sources: await context.catalog.list(params.data.tournamentId, params.data.handNo) };
      } catch (error) {
        return sendHandForkError(request, reply, error);
      }
    },
  );

  app.post("/api/admin/hand-forks", async (request, reply) => {
    noStore(reply);
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    const body = createHandForkRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_hand_fork_request" });
    }
    try {
      const handFork = await context.handForks.create(body.data, admin.adminUserId);
      await auditCompletedMutation(request, context, admin.adminUserId, "hand_fork.create", handFork.id, {
        sourceDecisionId: body.data.sourceDecisionId,
        modelConfigIds: body.data.modelConfigIds,
        sampleCount: body.data.sampleCount,
        timeoutMs: body.data.timeoutMs,
        maxParallelTargets: body.data.maxParallelTargets,
        status: handFork.status,
      });
      return reply.code(202).send({ handFork });
    } catch (error) {
      return sendHandForkError(request, reply, error);
    }
  });

  app.get("/api/admin/hand-forks", async (request, reply) => {
    noStore(reply);
    if (!(await requireAdmin(request, reply, context, false))) return;
    const query = listQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid_limit" });
    try {
      return { handForks: await context.handForks.list(query.data.limit ?? 50) };
    } catch (error) {
      return sendHandForkError(request, reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/admin/hand-forks/:id", async (request, reply) => {
    noStore(reply);
    if (!(await requireAdmin(request, reply, context, false))) return;
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_hand_fork_id" });
    try {
      const handFork = await context.handForks.get(params.data.id);
      return handFork
        ? { handFork }
        : reply.code(404).send({ error: "hand_fork_not_found" });
    } catch (error) {
      return sendHandForkError(request, reply, error);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/api/admin/hand-forks/:id/cancel",
    async (request, reply) => {
      noStore(reply);
      const admin = await requireAdmin(request, reply, context, true);
      if (!admin) return;
      const params = idParamsSchema.safeParse(request.params);
      const body = emptyBodySchema.safeParse(request.body ?? {});
      if (!params.success) return reply.code(400).send({ error: "invalid_hand_fork_id" });
      if (!body.success) return reply.code(400).send({ error: "invalid_hand_fork_request" });
      try {
        const handFork = await context.handForks.cancel(params.data.id);
        if (!handFork) return reply.code(404).send({ error: "hand_fork_not_found" });
        await auditCompletedMutation(request, context, admin.adminUserId, "hand_fork.cancel", handFork.id, {
          status: handFork.status,
        });
        return { handFork };
      } catch (error) {
        return sendHandForkError(request, reply, error);
      }
    },
  );
}
