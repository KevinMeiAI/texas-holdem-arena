import { describe, expect, it } from "vitest";
import type { AdminHandFork, HandForkTargetSummary } from "../../../packages/contracts/src/hand-forks";
import {
  actionDistributionEntries,
  availableHandForkSources,
  completedHandForkTournaments,
  handForkProgress,
  handForkCreateAttempt,
  handForkSourceAuditExclusions,
  isHandForkActive,
  parseHandForkCreateAttempts,
} from "./hand-fork-admin-model";

describe("hand fork admin presentation model", () => {
  it("uses requested trials as the progress denominator before an aggregate summary exists", () => {
    const fork = {
      status: "RUNNING",
      summary: null,
      targets: [
        { sampleCount: 10, terminalTrials: 4 },
        { sampleCount: 5, terminalTrials: 1 },
      ],
    } as AdminHandFork;

    expect(handForkProgress(fork)).toEqual({ terminal: 5, total: 15, ratio: 1 / 3 });
    expect(isHandForkActive(fork.status)).toBe(true);
    expect(isHandForkActive("PARTIAL")).toBe(false);
  });

  it("keeps only completed tournaments with hands and sorts newest first", () => {
    const tournaments = [
      { id: "old", status: "COMPLETED", createdAt: "2026-08-10T00:00:00.000Z", publicState: { completedHands: 4 } },
      { id: "live", status: "RUNNING", createdAt: "2026-08-12T00:00:00.000Z", publicState: { completedHands: 9 } },
      { id: "empty", status: "COMPLETED", createdAt: "2026-08-13T00:00:00.000Z", publicState: { completedHands: 0 } },
      { id: "new", status: "COMPLETED", createdAt: "2026-08-11T00:00:00.000Z", publicState: { completedHands: 7 } },
    ] as never;

    expect(completedHandForkTournaments(tournaments).map((tournament) => tournament.id)).toEqual(["new", "old"]);
  });

  it("exposes only audited sources and orders action counts consistently", () => {
    const sources = [
      { availability: "UNAVAILABLE", decisionId: "one", reasonCode: "LEGAL_CONTRACT_MISMATCH" },
      { availability: "AVAILABLE", decisionId: "two" },
      { availability: "UNAVAILABLE", decisionId: "three", reasonCode: "SOURCE_SNAPSHOT_MISSING" },
      { availability: "UNAVAILABLE", decisionId: "four", reasonCode: "LEGAL_CONTRACT_MISMATCH" },
    ] as never;
    expect(availableHandForkSources(sources).map((source) => source.decisionId)).toEqual(["two"]);
    expect(handForkSourceAuditExclusions(sources)).toEqual([
      { reasonCode: "LEGAL_CONTRACT_MISMATCH", count: 2 },
      { reasonCode: "SOURCE_SNAPSHOT_MISSING", count: 1 },
    ]);

    const summary = {
      actionDistribution: { raise: 2, fold: 1, call: 3 },
    } as unknown as HandForkTargetSummary;
    expect(actionDistributionEntries(summary)).toEqual([["fold", 1], ["call", 3], ["raise", 2]]);
  });

  it("reuses the create key after an ambiguous failure and rotates it after parameters change", () => {
    const parameters = {
      sourceDecisionId: "00000000-0000-4000-8000-000000000001",
      modelConfigIds: ["00000000-0000-4000-8000-000000000002"],
      sampleCount: 10,
      timeoutMs: 180_000,
      maxParallelTargets: 3,
    };
    let sequence = 0;
    const createId = () => `request-${++sequence}`;
    const first = handForkCreateAttempt(null, parameters, createId);
    const retry = handForkCreateAttempt(first, parameters, createId);
    const changed = handForkCreateAttempt(first, { ...parameters, sampleCount: 20 }, createId);

    expect(retry).toBe(first);
    expect(changed.clientRequestId).not.toBe(first.clientRequestId);
    expect(sequence).toBe(2);
  });

  it("restores pending create keys across a page reload and ignores corrupt entries", () => {
    expect(parseHandForkCreateAttempts(JSON.stringify([
      { fingerprint: "request-a", clientRequestId: "00000000-0000-4000-8000-000000000001" },
      { fingerprint: "request-a", clientRequestId: "00000000-0000-4000-8000-000000000002" },
      { fingerprint: "", clientRequestId: "broken" },
      null,
    ]))).toEqual([
      { fingerprint: "request-a", clientRequestId: "00000000-0000-4000-8000-000000000002" },
    ]);
    expect(parseHandForkCreateAttempts("not json")).toEqual([]);
  });
});
