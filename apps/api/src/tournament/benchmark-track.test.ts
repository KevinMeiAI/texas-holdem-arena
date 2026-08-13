import { describe, expect, it } from "vitest";
import { benchmarkTrackIdentity } from "./benchmark-track.js";

describe("benchmark track identity", () => {
  it("is deterministic and changes with decision-relevant tournament settings", () => {
    const base = {
      protocolBundleId: "arena-native-v10",
      rulesetVersion: "arena-rules-v2",
      systemPromptHash: "a".repeat(64),
      historyMode: "query_only" as const,
      interfaceTrack: "native" as const,
      providerOutputModes: ["json_schema"],
      tournamentFormat: { seatCount: 6, initialStack: 20_000 },
    };
    expect(benchmarkTrackIdentity(base)).toEqual(benchmarkTrackIdentity(base));
    expect(benchmarkTrackIdentity(base).cohortId).not.toBe(benchmarkTrackIdentity({
      ...base,
      tournamentFormat: { seatCount: 6, initialStack: 10_000 },
    }).cohortId);
    expect(benchmarkTrackIdentity(base).cohortId).not.toBe(benchmarkTrackIdentity({
      ...base,
      providerOutputModes: ["json_object"],
    }).cohortId);
    expect(benchmarkTrackIdentity(base).cohortId).not.toBe(benchmarkTrackIdentity({
      ...base,
      interfaceTrack: "normalized",
    }).cohortId);
    expect(benchmarkTrackIdentity(base).cohortId).not.toBe(benchmarkTrackIdentity({
      ...base,
      historyMode: "disabled",
    }).cohortId);
    expect(benchmarkTrackIdentity(base).cohortId).not.toBe(benchmarkTrackIdentity({
      ...base,
      systemPromptHash: "b".repeat(64),
    }).cohortId);
  });
});
