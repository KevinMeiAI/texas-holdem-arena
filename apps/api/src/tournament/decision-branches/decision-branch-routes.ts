import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  decisionBranchEditorialPatchSchema,
  type DecisionBranchPublication,
  type PublicDecisionBranchDto,
} from "../../../../../packages/contracts/src/index.js";
import { requireAdmin, type AdminAuthContext } from "../../auth/routes.js";
import { DecisionBranchSlugConflictError } from "./decision-branch-repository.js";
import { DecisionBranchServiceError } from "./decision-branch-service.js";

const uuidSchema = z.string().uuid();
const idParamsSchema = z.object({ id: uuidSchema }).strict();
const createRequestSchema = z.object({ sourceHandForkId: uuidSchema }).strict();
const expectedRevisionSchema = z.number().int().positive();
const publicationRequestSchema = decisionBranchEditorialPatchSchema.extend({
  expectedRevision: expectedRevisionSchema,
});
const editorialUpdateSchema = publicationRequestSchema.refine(
  (patch) => Object.keys(patch).some((key) => key !== "expectedRevision"),
  "At least one editorial field is required",
);
const hideRequestSchema = z.object({ expectedRevision: expectedRevisionSchema }).strict();
const adminListQuerySchema = z.object({
  limit: z.string().regex(/^[1-9]\d*$/).transform(Number).refine(
    (value) => Number.isSafeInteger(value) && value <= 200,
    "limit must be between 1 and 200",
  ).optional(),
}).strict();
const publicListQuerySchema = z.object({
  limit: z.string().regex(/^[1-9]\d*$/).transform(Number).refine(
    (value) => Number.isSafeInteger(value) && value <= 24,
    "limit must be between 1 and 24",
  ).optional(),
}).strict();
const publicSlugSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(120);

export interface DecisionBranchRouteService {
  createDraft(
    handForkId: string,
    adminUserId: string,
  ): Promise<{ publication: DecisionBranchPublication; created: boolean }>;
  listAdmin(limit?: number): Promise<DecisionBranchPublication[]>;
  getAdmin(id: string): Promise<DecisionBranchPublication | null>;
  edit(
    id: string,
    patch: unknown,
    expectedRevision: number,
    adminUserId: string,
  ): Promise<DecisionBranchPublication>;
  publish(
    id: string,
    patch: unknown,
    expectedRevision: number,
    adminUserId: string,
  ): Promise<DecisionBranchPublication>;
  hide(
    id: string,
    expectedRevision: number,
    adminUserId: string,
  ): Promise<DecisionBranchPublication>;
  getPublicBySlug(slug: string): Promise<PublicDecisionBranchDto | null>;
  listPublic(limit?: number): Promise<PublicDecisionBranchDto[]>;
}

export interface DecisionBranchRouteContext extends AdminAuthContext {
  decisionBranches: DecisionBranchRouteService;
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
}

function serviceErrorResponse(error: DecisionBranchServiceError): {
  status: 404 | 409;
  body: { error: string; message: string };
} {
  switch (error.code) {
    case "NOT_FOUND":
      return { status: 404, body: { error: "decision_branch_not_found", message: error.message } };
    case "SOURCE_UNAVAILABLE":
      return {
        status: 409,
        body: { error: "decision_branch_source_unavailable", message: error.message },
      };
    case "IDENTITY_UNAVAILABLE":
      return {
        status: 409,
        body: { error: "decision_branch_identity_unavailable", message: error.message },
      };
    case "UNSAFE_SOURCE":
      return {
        status: 409,
        body: { error: "decision_branch_source_unsafe", message: error.message },
      };
    case "CONFLICT":
      return { status: 409, body: { error: "decision_branch_conflict", message: error.message } };
  }
}

function sendDecisionBranchError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof DecisionBranchServiceError) {
    const response = serviceErrorResponse(error);
    return reply.code(response.status).send(response.body);
  }
  if (error instanceof DecisionBranchSlugConflictError) {
    return reply.code(409).send({
      error: "decision_branch_slug_conflict",
      message: "This decision branch URL is already in use",
    });
  }
  request.log.error({ err: error }, "decision branch request failed");
  return reply.code(500).send({ error: "decision_branch_failed" });
}

export async function registerDecisionBranchRoutes(
  app: FastifyInstance,
  context: DecisionBranchRouteContext,
): Promise<void> {
  app.post("/api/admin/decision-branches", async (request, reply) => {
    noStore(reply);
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    const body = createRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: "invalid_decision_branch_create_request",
        issues: body.error.issues,
      });
    }
    try {
      const result = await context.decisionBranches.createDraft(
        body.data.sourceHandForkId,
        admin.adminUserId,
      );
      return reply.code(result.created ? 201 : 200).send({
        decisionBranch: result.publication,
        created: result.created,
      });
    } catch (error) {
      return sendDecisionBranchError(request, reply, error);
    }
  });

  app.get("/api/admin/decision-branches", async (request, reply) => {
    noStore(reply);
    if (!(await requireAdmin(request, reply, context, false))) return;
    const query = adminListQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid_decision_branch_list_query" });
    try {
      return { decisionBranches: await context.decisionBranches.listAdmin(query.data.limit ?? 50) };
    } catch (error) {
      return sendDecisionBranchError(request, reply, error);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/admin/decision-branches/:id",
    async (request, reply) => {
      noStore(reply);
      if (!(await requireAdmin(request, reply, context, false))) return;
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_decision_branch_id" });
      try {
        const publication = await context.decisionBranches.getAdmin(params.data.id);
        return publication
          ? { decisionBranch: publication }
          : reply.code(404).send({ error: "decision_branch_not_found" });
      } catch (error) {
        return sendDecisionBranchError(request, reply, error);
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/admin/decision-branches/:id",
    async (request, reply) => {
      noStore(reply);
      const admin = await requireAdmin(request, reply, context, true);
      if (!admin) return;
      const params = idParamsSchema.safeParse(request.params);
      const body = editorialUpdateSchema.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return reply.code(400).send({
          error: "invalid_decision_branch_editorial_update",
          ...(!body.success ? { issues: body.error.issues } : {}),
        });
      }
      try {
        const { expectedRevision, ...patch } = body.data;
        return {
          decisionBranch: await context.decisionBranches.edit(
            params.data.id,
            patch,
            expectedRevision,
            admin.adminUserId,
          ),
        };
      } catch (error) {
        return sendDecisionBranchError(request, reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/decision-branches/:id/publish",
    async (request, reply) => {
      noStore(reply);
      const admin = await requireAdmin(request, reply, context, true);
      if (!admin) return;
      const params = idParamsSchema.safeParse(request.params);
      const body = publicationRequestSchema.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return reply.code(400).send({
          error: "invalid_decision_branch_publication",
          ...(!body.success ? { issues: body.error.issues } : {}),
        });
      }
      try {
        const { expectedRevision, ...patch } = body.data;
        return {
          decisionBranch: await context.decisionBranches.publish(
            params.data.id,
            patch,
            expectedRevision,
            admin.adminUserId,
          ),
        };
      } catch (error) {
        return sendDecisionBranchError(request, reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/decision-branches/:id/hide",
    async (request, reply) => {
      noStore(reply);
      const admin = await requireAdmin(request, reply, context, true);
      if (!admin) return;
      const params = idParamsSchema.safeParse(request.params);
      const body = hideRequestSchema.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: "invalid_decision_branch_hide_request" });
      }
      try {
        return {
          decisionBranch: await context.decisionBranches.hide(
            params.data.id,
            body.data.expectedRevision,
            admin.adminUserId,
          ),
        };
      } catch (error) {
        return sendDecisionBranchError(request, reply, error);
      }
    },
  );

  app.get("/api/public/decision-branches", async (request, reply) => {
    noStore(reply);
    const query = publicListQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid_decision_branch_list_query" });
    try {
      return { decisionBranches: await context.decisionBranches.listPublic(query.data.limit ?? 12) };
    } catch (error) {
      return sendDecisionBranchError(request, reply, error);
    }
  });

  app.get<{ Params: { slug: string } }>(
    "/api/public/decision-branches/:slug",
    async (request, reply) => {
      noStore(reply);
      const slug = publicSlugSchema.safeParse(request.params.slug);
      if (!slug.success) return reply.code(404).send({ error: "decision_branch_not_found" });
      try {
        const publication = await context.decisionBranches.getPublicBySlug(slug.data);
        return publication
          ? { decisionBranch: publication }
          : reply.code(404).send({ error: "decision_branch_not_found" });
      } catch (error) {
        return sendDecisionBranchError(request, reply, error);
      }
    },
  );
}
