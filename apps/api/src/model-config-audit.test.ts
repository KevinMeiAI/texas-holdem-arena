import { describe, expect, it } from "vitest";
import type { FrozenModelConfig } from "../../../packages/providers/src/provider.js";
import { providerRuntimeConfigHash } from "./model-config-audit.js";

function config(overrides: Partial<FrozenModelConfig> = {}): FrozenModelConfig {
  return {
    provider: "openai-compatible",
    providerProfile: "deepseek",
    providerDefaultOutputMode: "auto",
    outputMode: "inherit",
    model: "deepseek-chat",
    apiKey: "first-secret",
    baseUrl: "https://api.deepseek.com",
    timeoutMs: 180_000,
    parameters: { temperature: 0.2 },
    ...overrides,
  };
}

describe("providerRuntimeConfigHash", () => {
  it("is stable across secret rotation", () => {
    expect(providerRuntimeConfigHash(config({ apiKey: "first-secret" })))
      .toBe(providerRuntimeConfigHash(config({ apiKey: "second-secret" })));
  });

  it("changes when an auditable runtime override changes", () => {
    expect(providerRuntimeConfigHash(config({ timeoutMs: 120_000 })))
      .not.toBe(providerRuntimeConfigHash(config({ timeoutMs: 180_000 })));
  });

  it("canonicalizes nested provider parameters", () => {
    expect(providerRuntimeConfigHash(config({ parameters: { temperature: 0.2, reasoning: { effort: "high" } } })))
      .toBe(providerRuntimeConfigHash(config({ parameters: { reasoning: { effort: "high" }, temperature: 0.2 } })));
  });
});
