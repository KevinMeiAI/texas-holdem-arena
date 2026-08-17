import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ModelConfigService, ProviderConnectionNotFoundError } from "./model-service.js";

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
