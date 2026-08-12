import { createHash } from "node:crypto";
import { canonicalJson } from "../../fairness/src/canonical-json.js";
import type { ArenaOutputSchema } from "../../contracts/src/output-schema.js";
import type { OutputMode, ProviderTransportAudit } from "./provider.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function transportAudit(input: {
  adapterVersion: string;
  renderedUserText: string;
  wireBody: unknown;
  appliedOutputMode: OutputMode;
  schema?: ArenaOutputSchema | null;
  finishReason?: unknown;
  refusal?: unknown;
  responseModel?: unknown;
  systemFingerprint?: unknown;
}): ProviderTransportAudit {
  return {
    adapterVersion: input.adapterVersion,
    renderedUserTextSha256: sha256(input.renderedUserText),
    redactedWireBodySha256: sha256(canonicalJson(input.wireBody)),
    appliedOutputMode: input.appliedOutputMode,
    appliedSchemaSha256: input.schema?.sha256 ?? null,
    finishReason: typeof input.finishReason === "string" ? input.finishReason : null,
    refusal: typeof input.refusal === "string" ? input.refusal : null,
    responseModel: typeof input.responseModel === "string" ? input.responseModel : null,
    systemFingerprint: typeof input.systemFingerprint === "string" ? input.systemFingerprint : null,
  };
}
