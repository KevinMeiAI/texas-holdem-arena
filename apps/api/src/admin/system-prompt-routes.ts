import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireAdmin, type AdminAuthContext } from "../auth/routes.js";
import { SystemPromptVersionService } from "./system-prompt-service.js";

const createPromptSchema = z.object({
  name: z.string().trim().min(1).max(120),
  systemPrompt: z.string().max(100_000).refine((value) => value.trim().length > 0, "System prompt cannot be blank"),
  protocolBundleId: z.enum(["arena-native-v10", "arena-native-v11"]).default("arena-native-v11"),
}).strict();

const statusSchema = z.object({ archived: z.boolean() }).strict();

async function audit(pool: Pool, adminUserId: string, action: string, targetId: string, metadata: unknown = {}) {
  await pool.query(
    `insert into audit_events (id, admin_user_id, action, target_type, target_id, metadata)
     values ($1, $2, $3, 'system_prompt_version', $4, $5::jsonb)`,
    [randomUUID(), adminUserId, action, targetId, JSON.stringify(metadata)],
  );
}

export async function registerSystemPromptRoutes(
  app: FastifyInstance,
  context: AdminAuthContext & { pool: Pool; systemPrompts: SystemPromptVersionService },
): Promise<void> {
  app.get("/api/admin/system-prompts", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, false);
    if (!admin) return;
    return { versions: await context.systemPrompts.list() };
  });

  app.post("/api/admin/system-prompts", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    const parsed = createPromptSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_system_prompt", issues: parsed.error.issues });
    try {
      const version = await context.systemPrompts.create({ ...parsed.data, adminUserId: admin.adminUserId });
      await audit(context.pool, admin.adminUserId, "system_prompt_version.create", version.id, {
        sha256: version.sha256,
        protocolBundleId: version.protocolBundleId,
      });
      return reply.code(201).send({ version });
    } catch (error) {
      return reply.code(409).send({
        error: "system_prompt_create_failed",
        message: error instanceof Error ? error.message : "Unable to save system prompt version",
      });
    }
  });

  app.patch<{ Params: { id: string } }>("/api/admin/system-prompts/:id/status", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    const id = z.string().uuid().safeParse(request.params.id);
    const parsed = statusSchema.safeParse(request.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ error: "invalid_system_prompt_status" });
    try {
      const version = await context.systemPrompts.setArchived(id.data, parsed.data.archived);
      if (!version) return reply.code(404).send({ error: "system_prompt_not_found" });
      await audit(context.pool, admin.adminUserId, parsed.data.archived
        ? "system_prompt_version.archive"
        : "system_prompt_version.restore", version.id);
      return { version };
    } catch (error) {
      return reply.code(409).send({
        error: "system_prompt_status_failed",
        message: error instanceof Error ? error.message : "Unable to change system prompt status",
      });
    }
  });
}
