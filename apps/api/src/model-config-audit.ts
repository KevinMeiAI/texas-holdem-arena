import { createHash } from "node:crypto";
import type { FrozenModelConfig } from "../../../packages/providers/src/provider.js";
import { canonicalJson } from "../../../packages/fairness/src/canonical-json.js";

/**
 * Hash the exact provider runtime configuration while excluding credentials.
 *
 * Runtime-only overrides such as a Hand Fork timeout deliberately affect this
 * hash. The competitor revision hash remains a separate, database-backed
 * identity for the saved model configuration.
 */
export function providerRuntimeConfigHash(config: FrozenModelConfig): string {
  const { apiKey: _secret, ...auditable } = config;
  return createHash("sha256").update(canonicalJson(auditable)).digest("hex");
}
