import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireAdmin, type AdminAuthContext } from "../auth/routes.js";
import {
  ConsistencyTestService,
  publicConsistencyScenarioRegistry,
} from "./consistency-service.js";

const runIdSchema = z.string().uuid();
const createRunSchema = z.discriminatedUnion("tier", [
  z.object({
    tier: z.literal("single"),
    scenarioId: z.string().min(1).max(120),
    sampleCount: z.number().int().min(1).max(30).default(10),
    systemPromptVersionId: z.string().uuid().optional(),
    timeoutMs: z.number().int().min(30_000).max(600_000).optional(),
  }).strict(),
  z.object({
    tier: z.enum(["quick", "standard", "full"]),
    sampleCount: z.number().int().min(1).max(30).default(10),
    systemPromptVersionId: z.string().uuid().optional(),
    timeoutMs: z.number().int().min(30_000).max(600_000).optional(),
  }).strict(),
]);

async function audit(
  pool: Pool,
  adminUserId: string,
  action: string,
  targetId: string,
  metadata: unknown = {},
): Promise<void> {
  await pool.query(
    `insert into audit_events (id, admin_user_id, action, target_type, target_id, metadata)
     values ($1, $2, $3, 'consistency_run', $4, $5::jsonb)`,
    [randomUUID(), adminUserId, action, targetId, JSON.stringify(metadata)],
  );
}

export async function registerConsistencyRoutes(
  app: FastifyInstance,
  context: AdminAuthContext & { pool: Pool; consistency: ConsistencyTestService },
): Promise<void> {
  app.get("/api/admin/consistency/scenarios", async (request, reply) => {
    if (!(await requireAdmin(request, reply, context))) return;
    return publicConsistencyScenarioRegistry();
  });

  app.get("/api/admin/consistency-runs", async (request, reply) => {
    if (!(await requireAdmin(request, reply, context))) return;
    const rawModelId = (request.query as { modelConfigId?: unknown } | undefined)?.modelConfigId;
    const modelConfigId = rawModelId === undefined ? undefined : z.string().uuid().safeParse(rawModelId);
    if (modelConfigId && !modelConfigId.success) {
      return reply.code(400).send({ error: "invalid_model_config_id" });
    }
    return { runs: await context.consistency.listRuns(modelConfigId?.data) };
  });

  app.get<{ Params: { id: string } }>("/api/admin/consistency-runs/:id", async (request, reply) => {
    if (!(await requireAdmin(request, reply, context))) return;
    const id = runIdSchema.safeParse(request.params.id);
    if (!id.success) return reply.code(400).send({ error: "invalid_consistency_run_id" });
    const run = await context.consistency.getRun(id.data);
    return run ? { run } : reply.code(404).send({ error: "consistency_run_not_found" });
  });

  app.post<{ Params: { id: string } }>("/api/admin/models/:id/consistency-runs", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    const modelConfigId = z.string().uuid().safeParse(request.params.id);
    const parsed = createRunSchema.safeParse(request.body);
    if (!modelConfigId.success || !parsed.success) {
      return reply.code(400).send({
        error: "invalid_consistency_run",
        ...(!parsed.success ? { issues: parsed.error.issues } : {}),
      });
    }
    try {
      const run = await context.consistency.createRun({
        modelConfigId: modelConfigId.data,
        ...parsed.data,
        adminUserId: admin.adminUserId,
      });
      await audit(context.pool, admin.adminUserId, "consistency_run.create", run.id, {
        modelConfigId: run.modelConfigId,
        tier: run.tier,
        sampleCount: run.sampleCount,
        totalSamples: run.totalSamples,
      });
      return reply.code(202).send({ run });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start consistency test";
      const conflict = /one_open_consistency_run_per_model|duplicate key/i.test(message);
      return reply.code(conflict ? 409 : 400).send({ error: "consistency_run_create_failed", message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/admin/consistency-runs/:id/cancel", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    const id = runIdSchema.safeParse(request.params.id);
    if (!id.success) return reply.code(400).send({ error: "invalid_consistency_run_id" });
    const run = await context.consistency.cancelRun(id.data);
    if (!run) return reply.code(404).send({ error: "consistency_run_not_found" });
    await audit(context.pool, admin.adminUserId, "consistency_run.cancel", run.id, { status: run.status });
    return { run };
  });
}
