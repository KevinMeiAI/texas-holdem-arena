import { createHash } from "node:crypto";
import { canonicalJson } from "../../../../packages/fairness/src/canonical-json.js";

export interface BenchmarkTrackInput {
  protocolBundleId: string;
  rulesetVersion: string;
  systemPromptHash: string;
  historyMode: "query_only" | "disabled" | "baseline_stats_plus_query";
  interfaceTrack: "native" | "normalized";
  providerOutputModes: string[];
  tournamentFormat: unknown;
}

export interface BenchmarkTrackIdentity extends BenchmarkTrackInput {
  id: string;
  cohortId: string;
}

export function benchmarkTrackIdentity(input: BenchmarkTrackInput): BenchmarkTrackIdentity {
  const fingerprint = createHash("sha256").update(canonicalJson(input)).digest("hex").slice(0, 16);
  return {
    ...input,
    id: `${input.interfaceTrack}/${input.protocolBundleId}/${fingerprint}`,
    cohortId: `${input.interfaceTrack}/${input.protocolBundleId}/${input.rulesetVersion}/${input.historyMode}/${fingerprint}`,
  };
}
