import {
  arenaOutputSchema,
  type ArenaOutputSchema,
  type ExpectedModelOutput,
} from "../../contracts/src/index.js";
import {
  ProviderCallError,
  type FrozenModelConfig,
  type OutputMode,
  type ProviderProfile,
} from "./provider.js";

export type EffectiveOutputMode = Exclude<OutputMode, "auto">;

export interface OutputPolicyInspection {
  configuredMode: FrozenModelConfig["outputMode"];
  providerDefaultMode: FrozenModelConfig["providerDefaultOutputMode"];
  providerProfile: FrozenModelConfig["providerProfile"];
  effectiveProviderProfile: Exclude<ProviderProfile, "auto">;
  effectiveMode: EffectiveOutputMode;
  supported: boolean;
  message: string | null;
}

export interface ResolvedOutputPolicy extends OutputPolicyInspection {
  schema: ArenaOutputSchema | null;
}

function inferredProfile(config: FrozenModelConfig): Exclude<ProviderProfile, "auto"> {
  if (config.providerProfile !== "auto") return config.providerProfile;
  switch (config.provider) {
    case "openai-responses": return "openai";
    case "anthropic-messages": return "anthropic";
    case "google-gemini": return "gemini";
    case "openai-compatible": {
      const baseUrl = (config.baseUrl ?? "").toLowerCase();
      const model = config.model.trim().toLowerCase();
      // Prefer the API host over the model family. Compatible platforms can
      // serve third-party models, but their response_format dialect still
      // follows the platform endpoint.
      if (baseUrl.includes("api.deepseek.com")) return "deepseek";
      if (baseUrl.includes("moonshot") || baseUrl.includes("kimi")) return "kimi";
      if (baseUrl.includes("bigmodel") || baseUrl.includes("zhipu")) return "zhipu";
      if (baseUrl.includes("dashscope") || baseUrl.includes("bailian") || baseUrl.includes("aliyun")) return "qwen";
      if (baseUrl.includes("volces.com") || baseUrl.includes("volcengine")) return "doubao";
      if (baseUrl.includes("qianfan") || baseUrl.includes("aistudio.baidu.com")) return "wenxin";
      if (baseUrl.includes("hunyuan") || baseUrl.includes("tencentcloud")) return "hunyuan";
      if (baseUrl.includes("minimax") || baseUrl.includes("minimaxi")) return "minimax";
      if (baseUrl.includes("api.x.ai") || baseUrl.includes("x.ai/") || /^grok(?:[.\-_]|$)/.test(model)) return "xai";
      if (model.includes("deepseek")) return "deepseek";
      if (model.includes("moonshot") || model.includes("kimi")) return "kimi";
      if (model.includes("bigmodel") || model.includes("zhipu") || /(^|[\s/_-])glm/.test(model)) return "zhipu";
      if (/^qwen(?:[.\-_]|$)/.test(model)) return "qwen";
      if (/^doubao(?:[.\-_]|$)/.test(model)) return "doubao";
      if (/^(?:ernie|wenxin)(?:[.\-_]|$)/.test(model)) return "wenxin";
      if (/^hunyuan(?:[.\-_]|$)/.test(model)) return "hunyuan";
      if (/^minimax(?:[.\-_]|$)/.test(model)) return "minimax";
      return "generic";
    }
    case "mock-scripted": return "generic";
  }
}

function kimiSupportsJsonSchema(model: string): boolean {
  return /^kimi-k3(?:[.\-_]|$)/i.test(model.trim());
}

function qwenSupportsJsonSchema(model: string): boolean {
  return /^qwen3\.(?:8-max|7-(?:max|plus))(?:[.\-_]|$)/i.test(model.trim());
}

function wenxinSupportsJsonSchema(model: string): boolean {
  return /^ernie-(?:4\.5|4\.0-turbo|3\.5)(?:[.\-_]|$)/i.test(model.trim());
}

function automaticMode(
  config: FrozenModelConfig,
  profile: Exclude<ProviderProfile, "auto">,
): EffectiveOutputMode {
  if (config.provider === "mock-scripted") return "prompt";
  if (profile === "deepseek" || profile === "zhipu" || profile === "hunyuan"
    || profile === "minimax" || profile === "generic") return "json_object";
  if (profile === "kimi") return kimiSupportsJsonSchema(config.model) ? "json_schema" : "json_object";
  if (profile === "qwen") return qwenSupportsJsonSchema(config.model) ? "json_schema" : "json_object";
  if (profile === "wenxin") return wenxinSupportsJsonSchema(config.model) ? "json_schema" : "json_object";
  return "json_schema";
}

function supportIssue(
  config: FrozenModelConfig,
  profile: Exclude<ProviderProfile, "auto">,
  mode: EffectiveOutputMode,
): string | null {
  if (config.provider === "mock-scripted") {
    return mode === "prompt" ? null : "The local mock provider only supports prompt-enforced JSON";
  }
  if (mode === "prompt") return null;
  if (config.provider === "anthropic-messages" && mode === "json_object") {
    return "Anthropic Messages does not provide a JSON Object mode; use JSON Schema or prompt mode";
  }
  if (mode === "json_schema" && (profile === "deepseek" || profile === "zhipu")) {
    return `${profile} documents JSON Object mode but not JSON Schema mode`;
  }
  if (mode === "json_schema" && profile === "kimi" && !kimiSupportsJsonSchema(config.model)) {
    return "Kimi JSON Schema mode is enabled automatically only for kimi-k3 models; choose JSON Object or update the model ID";
  }
  if (mode === "json_schema" && profile === "qwen" && !qwenSupportsJsonSchema(config.model)) {
    return "Qwen JSON Schema mode is documented only for Qwen3.8-Max, Qwen3.7-Max and Qwen3.7-Plus series; choose JSON Object or update the model ID";
  }
  if (mode === "json_schema" && profile === "wenxin" && !wenxinSupportsJsonSchema(config.model)) {
    return "Wenxin JSON Schema mode is documented only for ERNIE 4.5, ERNIE 4.0 Turbo and ERNIE 3.5 series; choose JSON Object or update the model ID";
  }
  if (mode === "json_schema" && (profile === "hunyuan" || profile === "minimax")) {
    return `${profile} JSON Schema mode is not enabled by this compatibility profile; choose JSON Object or provide a verified custom configuration`;
  }
  return null;
}

export function inspectOutputPolicy(config: FrozenModelConfig): OutputPolicyInspection {
  const effectiveProviderProfile = inferredProfile(config);
  const requested = config.outputMode === "inherit"
    ? config.providerDefaultOutputMode
    : config.outputMode;
  const effectiveMode = requested === "auto"
    ? automaticMode(config, effectiveProviderProfile)
    : requested;
  const message = supportIssue(config, effectiveProviderProfile, effectiveMode);
  return {
    configuredMode: config.outputMode,
    providerDefaultMode: config.providerDefaultOutputMode,
    providerProfile: config.providerProfile,
    effectiveProviderProfile,
    effectiveMode,
    supported: message === null,
    message,
  };
}

export function resolveOutputPolicy(
  config: FrozenModelConfig,
  expectedOutput: ExpectedModelOutput,
  frozenSchema?: ArenaOutputSchema,
): ResolvedOutputPolicy {
  const inspection = inspectOutputPolicy(config);
  if (!inspection.supported) {
    throw new ProviderCallError("CONFIG", inspection.message ?? "Unsupported output mode", false);
  }
  return {
    ...inspection,
    schema: inspection.effectiveMode === "json_schema" ? frozenSchema ?? arenaOutputSchema(expectedOutput) : null,
  };
}
