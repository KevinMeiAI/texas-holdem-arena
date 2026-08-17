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

  it("uses JSON Object for documented object profiles and prompt mode for unverified profiles", () => {
    expect(inspectOutputPolicy(config({})).effectiveMode).toBe("json_object");
    expect(inspectOutputPolicy(config({ providerProfile: "deepseek" })).effectiveMode).toBe("json_object");
    expect(inspectOutputPolicy(config({ providerProfile: "zhipu" })).effectiveMode).toBe("json_object");
    expect(inspectOutputPolicy(config({ providerProfile: "hunyuan" })).effectiveMode).toBe("prompt");
    expect(inspectOutputPolicy(config({ providerProfile: "minimax" })).effectiveMode).toBe("prompt");
  });

  it("recognizes common compatible endpoints when the Provider profile is automatic", () => {
    expect(inspectOutputPolicy(config({ model: "deepseek-chat", baseUrl: "https://api.deepseek.com" })))
      .toMatchObject({ effectiveProviderProfile: "deepseek", effectiveMode: "json_object" });
    expect(inspectOutputPolicy(config({ model: "kimi-k3", baseUrl: "https://api.moonshot.cn/v1" })))
      .toMatchObject({ effectiveProviderProfile: "kimi", effectiveMode: "json_schema" });
    expect(inspectOutputPolicy(config({ model: "glm-4.5", baseUrl: "https://open.bigmodel.cn/api/paas/v4" })))
      .toMatchObject({ effectiveProviderProfile: "zhipu", effectiveMode: "json_object" });
    expect(inspectOutputPolicy(config({ model: "qwen3.8-max", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" })))
      .toMatchObject({ effectiveProviderProfile: "qwen", effectiveMode: "json_schema" });
    expect(inspectOutputPolicy(config({ model: "doubao-seed-1-6-251015", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" })))
      .toMatchObject({ effectiveProviderProfile: "doubao", effectiveMode: "json_schema" });
    expect(inspectOutputPolicy(config({ model: "ernie-4.5-turbo-128k", baseUrl: "https://qianfan.baidubce.com/v2" })))
      .toMatchObject({ effectiveProviderProfile: "wenxin", effectiveMode: "json_schema" });
    expect(inspectOutputPolicy(config({ model: "hunyuan-turbos-latest", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1" })))
      .toMatchObject({ effectiveProviderProfile: "hunyuan", effectiveMode: "prompt" });
    expect(inspectOutputPolicy(config({ model: "MiniMax-M2.5", baseUrl: "https://api.minimax.io/v1" })))
      .toMatchObject({ effectiveProviderProfile: "minimax", effectiveMode: "prompt" });
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

  it("matches the documented Qwen JSON Schema model families", () => {
    for (const model of ["qwen3.8-max", "qwen3.8-max-preview", "qwen3.7-max", "qwen3.7-plus-20260801"]) {
      expect(inspectOutputPolicy(config({ providerProfile: "qwen", model })).effectiveMode).toBe("json_schema");
    }
    for (const model of ["qwen3-max", "qwen3.7-flash", "qwen3.7-coder", "qwen-plus"]) {
      expect(inspectOutputPolicy(config({ providerProfile: "qwen", model })).effectiveMode).toBe("json_object");
    }
  });

  it("uses Wenxin schema only for the model families listed by the official API", () => {
    for (const model of ["ernie-4.5", "ernie-4.5-turbo-128k-preview", "ernie-4.0-turbo-8k", "ernie-3.5-8k"]) {
      expect(inspectOutputPolicy(config({ providerProfile: "wenxin", model })).effectiveMode).toBe("json_schema");
    }
    expect(inspectOutputPolicy(config({ providerProfile: "wenxin", model: "ernie-5.1" })).effectiveMode)
      .toBe("prompt");
  });

  it("uses Doubao schema only for model families listed with structured output", () => {
    for (const model of [
      "doubao-seed-evolving",
      "doubao-seed-2-1-pro-260628",
      "doubao-seed-2-0-lite-260428",
      "doubao-seed-1-8-251228",
      "doubao-seed-1-6-flash-250828",
      "doubao-seed-character-260628",
    ]) {
      expect(inspectOutputPolicy(config({ providerProfile: "doubao", model })).effectiveMode).toBe("json_schema");
    }
    expect(inspectOutputPolicy(config({ providerProfile: "doubao", model: "doubao-seed-2-0-pro-260215" })).effectiveMode)
      .toBe("prompt");
  });

  it("lets the compatible endpoint determine the profile for hosted third-party models", () => {
    expect(inspectOutputPolicy(config({ model: "deepseek-v3", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" })))
      .toMatchObject({ effectiveProviderProfile: "qwen", effectiveMode: "json_object" });
    expect(inspectOutputPolicy(config({ model: "deepseek-v3", baseUrl: "https://aistudio.baidu.com/llm/lmapi/v3" })))
      .toMatchObject({ effectiveProviderProfile: "wenxin", effectiveMode: "prompt" });
  });

  it("reports unsupported explicit modes as configuration errors", () => {
    const deepseekSchema = config({ providerProfile: "deepseek", outputMode: "json_schema" });
    expect(inspectOutputPolicy(deepseekSchema)).toMatchObject({ supported: false });
    expect(() => resolveOutputPolicy(deepseekSchema, "ACTION_OR_HISTORY"))
      .toThrow(/DeepSeek|deepseek/);
    expect(inspectOutputPolicy(config({ providerProfile: "qwen", model: "qwen-plus", outputMode: "json_schema" })))
      .toMatchObject({ supported: false });
    expect(inspectOutputPolicy(config({ providerProfile: "wenxin", model: "ernie-5.1", outputMode: "json_schema" })))
      .toMatchObject({ supported: false });
    expect(inspectOutputPolicy(config({ providerProfile: "doubao", model: "doubao-seed-2-0-pro-260215", outputMode: "json_schema" })))
      .toMatchObject({ supported: false });
    expect(inspectOutputPolicy(config({ providerProfile: "minimax", outputMode: "json_schema" })))
      .toMatchObject({ supported: false });
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
