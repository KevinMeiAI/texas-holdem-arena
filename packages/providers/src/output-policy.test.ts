import { describe, expect, it } from "vitest";
import type { FrozenModelConfig } from "./provider.js";
import { inspectOutputPolicy, resolveOutputPolicy } from "./output-policy.js";

function config(overrides: Partial<FrozenModelConfig>): FrozenModelConfig {
  return {
    provider: "openai-compatible",
    providerProfile: "auto",
    providerDefaultOutputMode: "auto",
    outputMode: "inherit",
    model: "example-model",
    baseUrl: "https://provider.test/v1",
    timeoutMs: 1_000,
    parameters: {},
    ...overrides,
  };
}

describe("provider output policy", () => {
  it("chooses native JSON Schema for OpenAI, Claude and Gemini", () => {
    expect(inspectOutputPolicy(config({ provider: "openai-responses" })).effectiveMode).toBe("json_schema");
    expect(inspectOutputPolicy(config({ provider: "anthropic-messages" })).effectiveMode).toBe("json_schema");
    expect(inspectOutputPolicy(config({ provider: "google-gemini" })).effectiveMode).toBe("json_schema");
  });

  it("keeps generic, DeepSeek and GLM compatible endpoints on JSON Object", () => {
    expect(inspectOutputPolicy(config({})).effectiveMode).toBe("json_object");
    expect(inspectOutputPolicy(config({ providerProfile: "deepseek" })).effectiveMode).toBe("json_object");
    expect(inspectOutputPolicy(config({ providerProfile: "zhipu" })).effectiveMode).toBe("json_object");
  });

  it("recognizes common compatible endpoints when the Provider profile is automatic", () => {
    expect(inspectOutputPolicy(config({ model: "deepseek-chat", baseUrl: "https://api.deepseek.com" })))
      .toMatchObject({ effectiveProviderProfile: "deepseek", effectiveMode: "json_object" });
    expect(inspectOutputPolicy(config({ model: "kimi-k3", baseUrl: "https://api.moonshot.cn/v1" })))
      .toMatchObject({ effectiveProviderProfile: "kimi", effectiveMode: "json_schema" });
    expect(inspectOutputPolicy(config({ model: "glm-4.5", baseUrl: "https://open.bigmodel.cn/api/paas/v4" })))
      .toMatchObject({ effectiveProviderProfile: "zhipu", effectiveMode: "json_object" });
    expect(inspectOutputPolicy(config({ model: "example-model", baseUrl: "https://api.x.ai/v1" })))
      .toMatchObject({ effectiveProviderProfile: "xai", effectiveMode: "json_schema" });
    expect(inspectOutputPolicy(config({ model: "grok-4", baseUrl: "https://compatible.example/v1" })))
      .toMatchObject({ effectiveProviderProfile: "xai", effectiveMode: "json_schema" });
  });

  it("selects JSON Schema for an explicit xAI profile", () => {
    expect(inspectOutputPolicy(config({ providerProfile: "xai", model: "grok-4" })))
      .toMatchObject({ effectiveProviderProfile: "xai", effectiveMode: "json_schema", supported: true });
  });

  it("selects Kimi K3 schema mode while older model names remain on JSON Object", () => {
    expect(inspectOutputPolicy(config({ providerProfile: "kimi", model: "kimi-k3.0" })).effectiveMode)
      .toBe("json_schema");
    expect(inspectOutputPolicy(config({ providerProfile: "kimi", model: "kimi-k2.6" })).effectiveMode)
      .toBe("json_object");
  });

  it("reports unsupported explicit modes as configuration errors", () => {
    const deepseekSchema = config({ providerProfile: "deepseek", outputMode: "json_schema" });
    expect(inspectOutputPolicy(deepseekSchema)).toMatchObject({ supported: false });
    expect(() => resolveOutputPolicy(deepseekSchema, "ACTION_OR_HISTORY"))
      .toThrow(/DeepSeek|deepseek/);
  });

  it("attaches the platform-owned schema only in JSON Schema mode", () => {
    expect(resolveOutputPolicy(config({ provider: "google-gemini" }), "ACTION_OR_HISTORY").schema)
      .toMatchObject({ version: "arena-output-v2", name: "arena_action_or_history" });
    expect(resolveOutputPolicy(config({ outputMode: "json_object" }), "ACTION_OR_HISTORY").schema).toBeNull();
  });

  it("uses the tournament-frozen schema instead of regenerating it from current code", () => {
    const frozen = {
      version: "arena-output-frozen",
      name: "frozen_action_schema",
      schema: { type: "object", properties: { frozen: { type: "boolean" } } },
      sha256: "f".repeat(64),
    };
    expect(resolveOutputPolicy(
      config({ provider: "google-gemini" }),
      "ACTION_OR_HISTORY",
      frozen,
    ).schema).toBe(frozen);
  });
});
