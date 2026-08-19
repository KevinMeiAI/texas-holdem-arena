import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { EffectiveOutputMode } from "../../../../packages/providers/src/output-policy.js";
import { canonicalJson } from "../../../../packages/fairness/src/canonical-json.js";
import { encryptJson } from "../security/encryption.js";
import { ModelConfigService, ProviderConnectionNotFoundError } from "./model-service.js";

const MODEL_CONFIG_ID = "11111111-1111-4111-8111-111111111111";
const REVISION_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_ID = "33333333-3333-4333-8333-333333333333";
const MASTER_KEY = new Uint8Array(32).fill(7);

interface FrozenRevisionFixture {
  model_config_id: string;
  competitor_revision_id: string;
  provider_connection_id: string;
  provider_type: "openai-compatible";
  provider_profile: "deepseek";
  provider_default_output_mode: "auto";
  base_url: string;
  model_id: string;
  parameters: Record<string, unknown>;
  output_mode: "inherit" | "json_schema";
  configuration_hash: string;
  legacy_identity_text: string;
  encrypted_api_key: unknown | null;
}

function currentRevisionHash(row: Omit<FrozenRevisionFixture, "configuration_hash" | "encrypted_api_key" | "legacy_identity_text">): string {
  return createHash("sha256").update(canonicalJson({
    providerConnectionId: row.provider_connection_id,
    providerType: row.provider_type,
    providerProfile: row.provider_profile,
    providerDefaultOutputMode: row.provider_default_output_mode,
    baseUrl: row.base_url,
    modelId: row.model_id,
    parameters: row.parameters,
    outputMode: row.output_mode,
  })).digest("hex");
}

function legacyRevisionHash(identityText: string): string {
  return createHash("md5").update(identityText).digest("hex")
    + createHash("md5").update(`arena:${identityText}`).digest("hex");
}

function frozenRevisionFixture(
  overrides: Partial<FrozenRevisionFixture> = {},
): FrozenRevisionFixture {
  const base = {
    model_config_id: MODEL_CONFIG_ID,
    competitor_revision_id: REVISION_ID,
    provider_connection_id: PROVIDER_ID,
    provider_type: "openai-compatible" as const,
    provider_profile: "deepseek" as const,
    provider_default_output_mode: "auto" as const,
    base_url: "https://api.deepseek.com",
    model_id: "deepseek-chat",
    parameters: { temperature: 0.2 },
    output_mode: "inherit" as const,
    legacy_identity_text: "{\"legacy\": true}",
    encrypted_api_key: null,
    ...overrides,
  };
  return {
    ...base,
    configuration_hash: overrides.configuration_hash ?? currentRevisionHash(base),
  };
}

function serviceReturning(rows: FrozenRevisionFixture[]) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows, rowCount: rows.length }));
  return {
    query,
    service: new ModelConfigService({ query } as unknown as Pool, MASTER_KEY),
  };
}

describe("model configuration credentials", () => {
  it("invalidates associated preflight results when an API key changes", async () => {
    const providerId = "11111111-1111-4111-8111-111111111111";
    const now = new Date("2026-08-17T00:00:00.000Z");
    const query = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: null };
      if (sql.includes("update provider_connections")) {
        return {
          rows: [{
            id: providerId,
            label: "DeepSeek",
            provider_type: "openai-compatible",
            provider_profile: "deepseek",
            default_output_mode: "json_schema",
            base_url: "https://api.deepseek.com",
            encrypted_api_key: {},
            key_last_four: "-new",
            created_at: now,
            updated_at: now,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("delete from provider_preflight_cache")) return { rows: [], rowCount: 2 };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release } as unknown as PoolClient)),
    } as unknown as Pool;
    const service = new ModelConfigService(pool, new Uint8Array(32));

    await service.updateProvider(providerId, { apiKey: "sk-replacement-new" });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("delete from provider_preflight_cache"),
      [providerId],
    );
    expect(query.mock.calls.findIndex(([sql]) => String(sql).includes("delete from provider_preflight_cache")))
      .toBeLessThan(query.mock.calls.findIndex(([sql]) => sql === "commit"));
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects a model that references a missing or deleted provider", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "rollback") return { rows: [], rowCount: null };
      if (sql.startsWith("select id from provider_connections")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const service = new ModelConfigService({
      connect: vi.fn(async () => ({ query, release } as unknown as PoolClient)),
    } as unknown as Pool, new Uint8Array(32));

    await expect(service.createModel({
      displayName: "Missing provider model",
      providerConnectionId: "11111111-1111-4111-8111-111111111111",
      modelId: "missing-model",
      parameters: {},
      outputMode: "inherit",
    })).rejects.toBeInstanceOf(ProviderConnectionNotFoundError);
    expect(query).toHaveBeenCalledWith("rollback");
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("model target freezing", () => {
  it("freezes the active current revision with one authoritative read and a timeout override", async () => {
    const encryptedApiKey = encryptJson(
      "sk-current",
      MASTER_KEY,
      `arena:provider:${PROVIDER_ID}:api-key`,
    );
    const row = frozenRevisionFixture({ encrypted_api_key: encryptedApiKey });
    const { query, service } = serviceReturning([row]);

    const target = await service.freezeCurrentTarget(MODEL_CONFIG_ID, 240_000);

    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/m\.current_revision_id = r\.id[\s\S]*m\.enabled = true[\s\S]*p\.deleted_at is null/),
      [MODEL_CONFIG_ID],
    );
    expect(target).toMatchObject({
      modelConfigId: MODEL_CONFIG_ID,
      competitorRevisionId: REVISION_ID,
      configurationHash: row.configuration_hash,
      effectiveOutputMode: "json_object",
      runtimeConfig: {
        provider: "openai-compatible",
        providerProfile: "deepseek",
        model: "deepseek-chat",
        apiKey: "sk-current",
        timeoutMs: 240_000,
      },
    });
    expectTypeOf(target.effectiveOutputMode).toEqualTypeOf<EffectiveOutputMode>();
  });

  it("rejects a current target that is not active and never performs a second read", async () => {
    const { query, service } = serviceReturning([]);

    await expect(service.freezeCurrentTarget(MODEL_CONFIG_ID, 180_000))
      .rejects.toThrow("Model configuration not found or disabled");
    expect(query).toHaveBeenCalledOnce();
  });

  it("accepts an exactly verified legacy migration hash", async () => {
    const legacyIdentityText = "{\"baseUrl\": \"https://api.deepseek.com\", \"modelId\": \"deepseek-chat\"}";
    const row = frozenRevisionFixture({
      legacy_identity_text: legacyIdentityText,
      configuration_hash: legacyRevisionHash(legacyIdentityText),
    });
    const { query, service } = serviceReturning([row]);

    await expect(service.freezeCurrentTarget(MODEL_CONFIG_ID, 180_000)).resolves.toMatchObject({
      configurationHash: row.configuration_hash,
      effectiveOutputMode: "json_object",
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("jsonb_build_object(");
    expect(sql).toContain("'providerConnectionId', r.provider_connection_id");
    expect(sql).toContain("'providerDefaultOutputMode', r.provider_default_output_mode");
    expect(sql).toContain("'parameters', r.parameters");
    expect(sql).toContain(")::text as legacy_identity_text");
  });

  it("rejects an arbitrary stored revision hash", async () => {
    const { service } = serviceReturning([
      frozenRevisionFixture({ configuration_hash: "a".repeat(64) }),
    ]);

    await expect(service.freezeCurrentTarget(MODEL_CONFIG_ID, 180_000))
      .rejects.toThrow("configuration hash does not match its frozen identity");
  });

  it("rehydrates only the pinned hash and effective output mode", async () => {
    const row = frozenRevisionFixture();
    const { query, service } = serviceReturning([row]);

    await expect(service.runtimeConfigForFrozenRevision(
      REVISION_ID,
      "b".repeat(64),
      "json_object",
      120_000,
    )).rejects.toThrow("configuration hash no longer matches the frozen target");
    await expect(service.runtimeConfigForFrozenRevision(
      REVISION_ID,
      row.configuration_hash,
      "prompt",
      120_000,
    )).rejects.toThrow("output mode no longer matches the frozen target");
    const target = await service.runtimeConfigForFrozenRevision(
      REVISION_ID,
      row.configuration_hash,
      "json_object",
      120_000,
    );

    expect(query.mock.calls).toHaveLength(3);
    expect(query.mock.calls.every(([sql, values]) => (
      String(sql).includes("where r.id = $1") && values?.[0] === REVISION_ID
    ))).toBe(true);
    expect(target.runtimeConfig.timeoutMs).toBe(120_000);
  });

  it("allows credential rotation without changing revision identity", async () => {
    const identityRow = frozenRevisionFixture();
    const first = frozenRevisionFixture({
      encrypted_api_key: encryptJson(
        "sk-first",
        MASTER_KEY,
        `arena:provider:${PROVIDER_ID}:api-key`,
      ),
    });
    const second = frozenRevisionFixture({
      encrypted_api_key: encryptJson(
        "sk-second",
        MASTER_KEY,
        `arena:provider:${PROVIDER_ID}:api-key`,
      ),
    });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [first], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [second], rowCount: 1 });
    const service = new ModelConfigService({ query } as unknown as Pool, MASTER_KEY);

    const created = await service.freezeCurrentTarget(MODEL_CONFIG_ID, 180_000);
    const resumed = await service.runtimeConfigForFrozenRevision(
      REVISION_ID,
      identityRow.configuration_hash,
      "json_object",
      180_000,
    );

    expect(created.configurationHash).toBe(identityRow.configuration_hash);
    expect(resumed.configurationHash).toBe(identityRow.configuration_hash);
    expect(created.runtimeConfig.apiKey).toBe("sk-first");
    expect(resumed.runtimeConfig.apiKey).toBe("sk-second");
  });
});
