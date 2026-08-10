import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  arenaOutputSchema,
  buildEffectiveSystemPrompt,
  type CanonicalModelRequest,
  type ExpectedModelOutput,
} from "../../../../packages/contracts/src/index.js";
import { createProvider } from "../../../../packages/providers/src/provider-factory.js";
import { inspectOutputPolicy } from "../../../../packages/providers/src/output-policy.js";
import {
  preflightProvider,
  type FrozenModelConfig,
} from "../../../../packages/providers/src/provider.js";
import { requireAdmin, type AdminAuthContext } from "../auth/routes.js";
import { ModelConfigService } from "./model-service.js";

const providerType = z.enum([
  "openai-responses",
  "anthropic-messages",
  "google-gemini",
  "openai-compatible",
  "mock-scripted",
]);
const providerProfile = z.enum(["auto", "openai", "anthropic", "gemini", "deepseek", "kimi", "zhipu", "generic"]);
const outputMode = z.enum(["auto", "json_schema", "json_object", "prompt"]);
const modelOutputMode = z.enum(["inherit", "auto", "json_schema", "json_object", "prompt"]);

const providerSchema = z.object({
  label: z.string().trim().min(1).max(100),
  providerType,
  providerProfile: providerProfile.default("auto"),
  defaultOutputMode: outputMode.default("auto"),
  baseUrl: z.union([z.string().url().refine((value) => /^https?:/.test(value)), z.literal(""), z.null()]).optional(),
  apiKey: z.union([z.string().max(10_000), z.null()]).optional(),
}).strict();

const modelSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  providerConnectionId: z.string().uuid(),
  modelId: z.string().trim().min(1).max(200),
  parameters: z.record(z.string(), z.unknown()).default({}),
  outputMode: modelOutputMode.default("inherit"),
}).strict();

const providerUpdateSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  providerType: providerType.optional(),
  providerProfile: providerProfile.optional(),
  defaultOutputMode: outputMode.optional(),
  baseUrl: z.union([z.string().url().refine((value) => /^https?:/.test(value)), z.literal(""), z.null()]).optional(),
  apiKey: z.union([z.string().max(10_000), z.null()]).optional(),
}).strict().refine(
  (input) => Object.keys(input).length > 0,
  "At least one provider field is required",
);

const modelUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  providerConnectionId: z.string().uuid().optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  outputMode: modelOutputMode.optional(),
  enabled: z.boolean().optional(),
}).strict().refine(
  (input) => Object.keys(input).length > 0,
  "At least one model field is required",
);

const idSchema = z.string().uuid();

async function audit(
  pool: Pool,
  adminUserId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: unknown = {},
): Promise<void> {
  await pool.query(
    `insert into audit_events (id, admin_user_id, action, target_type, target_id, metadata)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [randomUUID(), adminUserId, action, targetType, targetId, JSON.stringify(metadata)],
  );
}

function preflightRequest(expectedOutput: ExpectedModelOutput): CanonicalModelRequest {
  const prompt = buildEffectiveSystemPrompt();
  return {
    requestId: randomUUID(),
    expectedOutput,
    systemPrompt: prompt.text,
    systemPromptHash: prompt.sha256,
    userPayload: expectedOutput === "RUNOUT_VOTE" ? {
      schema_version: "arena-preflight-v1",
      preflight: true,
      phase: "RUNOUT_VOTE",
      hero: { player_id: "preflight-player", stack: 1_000, hole_cards: ["As", "Kh"] },
      legal_actions: null,
      runout_negotiation: { current_voter_id: "preflight-player", prior_messages: [] },
      history_budget: { remaining_queries: 0 },
    } : {
      schema_version: "arena-preflight-v1",
      preflight: true,
      phase: "FLOP",
      hero: { player_id: "preflight-player", stack: 1_000, hole_cards: ["As", "Kh"] },
      legal_actions: { check: true },
      runout_negotiation: null,
      history_budget: { remaining_queries: 0 },
    },
    timeoutMs: 15_000,
  };
}

async function runPreflight(config: FrozenModelConfig) {
  const provider = createProvider(config);
  const policy = inspectOutputPolicy(config);
  const expectedOutputs: ExpectedModelOutput[] = ["ACTION_OR_HISTORY", "RUNOUT_VOTE"];
  const checks = [];
  for (const expectedOutput of expectedOutputs) {
    const schema = arenaOutputSchema(expectedOutput);
    const result = await preflightProvider(
      provider,
      preflightRequest(expectedOutput),
      (decision) => {
        if (expectedOutput === "RUNOUT_VOTE") {
          return decision.parsed.type === "runout_vote"
            ? null
            : "Provider did not return a runout vote";
        }
        return decision.parsed.type === "action" && decision.parsed.action === "check"
          ? null
          : "Provider did not return the requested legal check action";
      },
    );
    checks.push({
      expectedOutput,
      schema: {
        version: schema.version,
        name: schema.name,
        sha256: schema.sha256,
        applied: policy.effectiveMode === "json_schema",
      },
      ...result,
    });
  }
  return {
    ok: checks.every((check) => check.ok),
    latencyMs: checks.reduce((total, check) => total + check.latencyMs, 0),
    errorKind: checks.find((check) => !check.ok)?.errorKind ?? null,
    effectiveMode: policy.effectiveMode,
    effectiveProviderProfile: policy.effectiveProviderProfile,
    outputModeSupported: policy.supported,
    outputModeMessage: policy.message,
    schemaVersion: arenaOutputSchema("ACTION_OR_HISTORY").version,
    checks,
  };
}

export async function registerAdminModelRoutes(
  app: FastifyInstance,
  context: AdminAuthContext & { pool: Pool; models: ModelConfigService },
): Promise<void> {
  app.get("/api/admin/providers", async (request, reply) => {
    if (!(await requireAdmin(request, reply, context))) return;
    return { providers: await context.models.listProviders() };
  });

  app.get<{ Params: { id: string } }>("/api/admin/providers/:id", async (request, reply) => {
    if (!(await requireAdmin(request, reply, context))) return;
    if (!idSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "invalid_provider_id" });
    }
    const provider = await context.models.getProvider(request.params.id);
    return provider ? { provider } : reply.code(404).send({ error: "provider_not_found" });
  });

  app.post("/api/admin/providers", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    const parsed = providerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_provider", issues: parsed.error.issues });
    const { baseUrl, apiKey, ...providerInput } = parsed.data;
    const provider = await context.models.createProvider({
      ...providerInput,
      baseUrl: baseUrl || null,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
    await audit(context.pool, admin.adminUserId, "provider.create", "provider", provider.id);
    return reply.code(201).send({ provider });
  });

  app.patch<{ Params: { id: string } }>("/api/admin/providers/:id", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    if (!idSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "invalid_provider_id" });
    }
    const parsed = providerUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_provider", issues: parsed.error.issues });
    }
    const { baseUrl, apiKey, ...rest } = parsed.data;
    const provider = await context.models.updateProvider(request.params.id, {
      ...rest,
      ...(Object.hasOwn(parsed.data, "baseUrl") ? { baseUrl: baseUrl || null } : {}),
      ...(Object.hasOwn(parsed.data, "apiKey") ? { apiKey } : {}),
    });
    if (!provider) return reply.code(404).send({ error: "provider_not_found" });
    await audit(context.pool, admin.adminUserId, "provider.update", "provider", provider.id);
    return { provider };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/providers/:id", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    if (!idSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "invalid_provider_id" });
    }
    try {
      const deleted = await context.models.deleteProvider(request.params.id);
      if (!deleted) return reply.code(404).send({ error: "provider_not_found" });
      await audit(context.pool, admin.adminUserId, "provider.delete", "provider", request.params.id);
      return { ok: true };
    } catch {
      return reply.code(409).send({ error: "provider_in_use" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/admin/providers/:id/test", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    const parsed = z.object({ modelId: z.string().min(1), parameters: z.record(z.string(), z.unknown()).default({}) })
      .strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_preflight" });
    try {
      const config = await context.models.providerRuntimeConfig(
        request.params.id,
        parsed.data.modelId,
        parsed.data.parameters,
      );
      const result = await runPreflight(config);
      await audit(context.pool, admin.adminUserId, "provider.test", "provider", request.params.id, {
        ok: result.ok,
        errorKind: result.errorKind,
      });
      return { result };
    } catch (error) {
      return reply.code(400).send({
        error: "preflight_failed",
        message: error instanceof Error ? error.message : "Unknown preflight failure",
      });
    }
  });

  app.get("/api/admin/models", async (request, reply) => {
    if (!(await requireAdmin(request, reply, context))) return;
    return { models: await context.models.listModels() };
  });

  app.get<{ Params: { id: string } }>("/api/admin/models/:id", async (request, reply) => {
    if (!(await requireAdmin(request, reply, context))) return;
    if (!idSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "invalid_model_id" });
    }
    const model = await context.models.getModel(request.params.id);
    return model ? { model } : reply.code(404).send({ error: "model_not_found" });
  });

  app.post("/api/admin/models", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    const parsed = modelSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_model", issues: parsed.error.issues });
    try {
      const model = await context.models.createModel(parsed.data);
      await audit(context.pool, admin.adminUserId, "model.create", "model", model?.id ?? null);
      return reply.code(201).send({ model });
    } catch {
      return reply.code(400).send({ error: "provider_not_found" });
    }
  });

  app.patch<{ Params: { id: string } }>("/api/admin/models/:id", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    if (!idSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "invalid_model_id" });
    }
    const parsed = modelUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_model", issues: parsed.error.issues });
    }
    try {
      const model = await context.models.updateModel(request.params.id, parsed.data);
      if (!model) return reply.code(404).send({ error: "model_not_found" });
      await audit(context.pool, admin.adminUserId, "model.update", "model", model.id);
      return { model };
    } catch {
      return reply.code(400).send({ error: "provider_not_found" });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/admin/models/:id", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    if (!idSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "invalid_model_id" });
    }
    if (!(await context.models.deleteModel(request.params.id))) {
      return reply.code(404).send({ error: "model_not_found" });
    }
    await audit(context.pool, admin.adminUserId, "model.delete", "model", request.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/admin/models/:id/preflight", async (request, reply) => {
    const admin = await requireAdmin(request, reply, context, true);
    if (!admin) return;
    try {
      const result = await runPreflight(await context.models.runtimeConfig(request.params.id));
      await audit(context.pool, admin.adminUserId, "model.preflight", "model", request.params.id, {
        ok: result.ok,
        errorKind: result.errorKind,
      });
      return { result };
    } catch (error) {
      return reply.code(400).send({
        error: "preflight_failed",
        message: error instanceof Error ? error.message : "Unknown preflight failure",
      });
    }
  });

  app.get("/api/admin/audit", async (request, reply) => {
    if (!(await requireAdmin(request, reply, context))) return;
    const result = await context.pool.query(
      `select id, action, target_type, target_id, metadata, created_at
         from audit_events order by created_at desc limit 200`,
    );
    return { events: result.rows };
  });
}
