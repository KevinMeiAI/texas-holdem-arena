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
      const fingerprint = `${config.baseUrl ?? ""} ${config.model}`.toLowerCase();
      if (fingerprint.includes("deepseek")) return "deepseek";
      if (fingerprint.includes("moonshot") || fingerprint.includes("kimi")) return "kimi";
      if (fingerprint.includes("bigmodel") || fingerprint.includes("zhipu") || /(^|[\s/_-])glm/.test(fingerprint)) return "zhipu";
      return "generic";
    }
    case "mock-scripted": return "generic";
  }
}

function kimiSupportsJsonSchema(model: string): boolean {
  return /^kimi-k3(?:[.\-_]|$)/i.test(model.trim());
}

function automaticMode(
  config: FrozenModelConfig,
  profile: Exclude<ProviderProfile, "auto">,
): EffectiveOutputMode {
  if (config.provider === "mock-scripted") return "prompt";
  if (profile === "deepseek" || profile === "zhipu" || profile === "generic") return "json_object";
  if (profile === "kimi") return kimiSupportsJsonSchema(config.model) ? "json_schema" : "json_object";
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
