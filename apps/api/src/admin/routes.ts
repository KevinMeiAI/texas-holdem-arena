import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  arenaOutputSchema,
  buildEffectiveSystemPrompt,
  decisionProtocolBundle,
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
const providerProfile = z.enum([
  "auto", "openai", "anthropic", "gemini", "deepseek", "kimi", "zhipu",
  "qwen", "doubao", "wenxin", "hunyuan", "minimax", "xai", "generic",
]);
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

type PreflightScenario = "check" | "raise_exact" | "call_null" | "history_query" | "correction_recovery";

function preflightRequest(expectedOutput: ExpectedModelOutput, scenario: PreflightScenario): CanonicalModelRequest {
  const bundle = decisionProtocolBundle();
  const prompt = buildEffectiveSystemPrompt(bundle.systemPromptVersion);
  const legalActions = scenario === "raise_exact"
    ? { allowed: ["raise"], call: null, bet: null, raise: { min_amount_to: 700, max_amount_to: 700 }, all_in: null }
    : scenario === "call_null"
      ? { allowed: ["call"], call: { amount: 200, will_be_all_in: false }, bet: null, raise: null, all_in: null }
      : { allowed: ["check"], call: null, bet: null, raise: null, all_in: null };
  return {
    requestId: randomUUID(),
    expectedOutput,
    systemPrompt: prompt.text,
    systemPromptHash: prompt.sha256,
    outputSchema: arenaOutputSchema(expectedOutput, bundle.outputSchemaVersion),
    userPayload: {
      arena_control: {
        mode: scenario === "correction_recovery" ? "protocol_correction" : "preflight",
        preflight_task: scenario,
        error_codes: scenario === "correction_recovery" ? ["AMOUNT_TO_MUST_BE_NULL"] : [],
        history_budget_remaining: { queries: scenario === "history_query" ? 1 : 0, bytes: 16_000 },
      },
      arena_state: {
        schema_version: "arena-preflight-v3",
        preflight: true,
        phase: "FLOP",
        betting: { current_actor_id: "preflight-player" },
        hero: { player_id: "preflight-player", stack: 1_000, hole_cards: ["As", "Kh"] },
        legal_actions: legalActions,
      },
      history_results: [],
      history_budget_remaining: {
        queries: 0,
        approximate_tokens: 0,
        max_records_per_query: 80,
      },
    },
    timeoutMs: 60_000,
    parserPolicy: bundle.parserPolicyVersion,
    adapterProtocolVersion: bundle.adapterProtocolVersion,
  };
}

async function runPreflight(config: FrozenModelConfig, level: "quick" | "full" = "quick") {
  const provider = createProvider(config);
  const policy = inspectOutputPolicy(config);
  const bundle = decisionProtocolBundle();
  const scenarios: PreflightScenario[] = level === "quick"
    ? ["check"]
    : ["check", "raise_exact", "call_null", "history_query", "correction_recovery"];
  const checks = [];
  for (const scenario of scenarios) {
    const expectedOutput: ExpectedModelOutput = "ACTION_OR_HISTORY";
    const schema = arenaOutputSchema(expectedOutput, bundle.outputSchemaVersion);
    const result = await preflightProvider(
      provider,
      preflightRequest(expectedOutput, scenario),
      (decision) => {
        if (scenario === "history_query") {
          return decision.parsed.type === "history_query" ? null : "Provider did not return a history query";
        }
        const expectedAction = scenario === "raise_exact" ? "raise" : scenario === "call_null" ? "call" : "check";
        if (decision.parsed.type !== "action" || decision.parsed.action !== expectedAction) {
          return `Provider did not return the requested legal ${expectedAction} action`;
        }
        return scenario === "raise_exact" && decision.parsed.amount_to !== 700
          ? "Provider did not honor the exact raise bound"
          : null;
      },
    );
    checks.push({
      scenario,
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
    level,
    protocolBundleId: bundle.id,
    outputModeSupported: policy.supported,
    outputModeMessage: policy.message,
    schemaVersion: arenaOutputSchema("ACTION_OR_HISTORY", bundle.outputSchemaVersion).version,
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
      if (!deleted) {
        const provider = await context.models.getProvider(request.params.id);
        return provider
          ? reply.code(409).send({ error: "provider_in_use" })
          : reply.code(404).send({ error: "provider_not_found" });
      }
      await audit(context.pool, admin.adminUserId, "provider.delete", "provider", request.params.id);
      return { ok: true };
    } catch {
      return reply.code(500).send({ error: "provider_delete_failed" });
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
      const level = (request.query as { level?: unknown } | undefined)?.level === "full" ? "full" : "quick";
      const bundle = decisionProtocolBundle();
      const model = await context.models.currentRevision(request.params.id);
      if (!model) throw new Error("Model configuration not found or disabled");
      const cached = await context.pool.query<{ result: unknown }>(
        `select result from provider_preflight_cache
          where configuration_hash = $1 and protocol_bundle_id = $2
            and preflight_level = $3 and expires_at > now()`,
        [model.configurationHash, bundle.id, level],
      );
      const result = (cached.rows[0]?.result as Awaited<ReturnType<typeof runPreflight>> | undefined) ?? await runPreflight(
        await context.models.runtimeConfigForRevision(model.revisionId),
        level,
      );
      if (!cached.rows[0]) {
        await context.pool.query(
          `insert into provider_preflight_cache
            (configuration_hash, protocol_bundle_id, preflight_level, result, expires_at)
           values ($1, $2, $3, $4::jsonb, now() + interval '24 hours')
           on conflict (configuration_hash, protocol_bundle_id, preflight_level)
           do update set result = excluded.result, expires_at = excluded.expires_at, created_at = now()`,
          [model.configurationHash, bundle.id, level, JSON.stringify(result)],
        );
      }
      await audit(context.pool, admin.adminUserId, "model.preflight", "model", request.params.id, {
        ok: result.ok,
        errorKind: result.errorKind,
      });
      return { result, cached: Boolean(cached.rows[0]) };
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
