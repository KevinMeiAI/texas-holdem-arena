import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { CONSISTENCY_SCENARIOS } from "./consistency-scenarios.js";
import type { ModelConfigService } from "./model-service.js";
import {
  ConsistencyTestService,
  deriveConsistencyBatchStatus,
  summarizeConsistencySamples,
  type PublicConsistencySample,
} from "./consistency-service.js";

describe("consistency batch status", () => {
  it("derives active, successful, partial, and failed batch states from child runs", () => {
    expect(deriveConsistencyBatchStatus(["QUEUED", "QUEUED"])).toBe("QUEUED");
    expect(deriveConsistencyBatchStatus(["RUNNING", "QUEUED", "COMPLETED"])).toBe("RUNNING");
    expect(deriveConsistencyBatchStatus(["COMPLETED", "COMPLETED"])).toBe("COMPLETED");
    expect(deriveConsistencyBatchStatus(["COMPLETED", "FAILED"])).toBe("PARTIAL");
    expect(deriveConsistencyBatchStatus(["FAILED", "CANCELLED"])).toBe("FAILED");
    expect(deriveConsistencyBatchStatus(["CANCELLED", "CANCELLED"])).toBe("CANCELLED");
  });
});

function sample(
  scenarioId: string,
  sampleIndex: number,
  input: Partial<PublicConsistencySample> & Pick<PublicConsistencySample, "outcome">,
): PublicConsistencySample {
  return {
    id: `${scenarioId}-${sampleIndex}`,
    scenarioId,
    sampleIndex,
    action: null,
    amountTo: null,
    decisionSummary: null,
    parsedOutput: null,
    rawText: null,
    errorKind: null,
    errorMessage: null,
    latencyMs: 1_000,
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    transportAudit: null,
    visibleInputHash: "a".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

describe("consistency summaries", () => {
  it("distinguishes modal action share from pairwise agreement", () => {
    const scenario = CONSISTENCY_SCENARIOS[0]!;
    const samples = [
      ...Array.from({ length: 8 }, (_, index) => sample(scenario.id, index + 1, {
        outcome: "VALID_ACTION",
        action: "call",
      })),
      ...Array.from({ length: 2 }, (_, index) => sample(scenario.id, index + 9, {
        outcome: "VALID_ACTION",
        action: "fold",
      })),
    ];
    const summary = summarizeConsistencySamples([scenario], samples);
    expect(summary.scenarios[0]).toMatchObject({
      dominantAction: "call",
      dominantCount: 8,
      dominantShare: 0.8,
      validityRate: 1,
    });
    expect(summary.scenarios[0]!.pairwiseAgreement).toBeCloseTo(29 / 45);
    expect(summary.totalTokens).toBe(1_200);
  });

  it("keeps invalid decisions outside the action distribution", () => {
    const scenario = CONSISTENCY_SCENARIOS[0]!;
    const samples = [
      ...Array.from({ length: 8 }, (_, index) => sample(scenario.id, index + 1, {
        outcome: "VALID_ACTION",
        action: "call",
      })),
      ...Array.from({ length: 2 }, (_, index) => sample(scenario.id, index + 9, {
        outcome: "PROTOCOL_ERROR",
        errorKind: "INVALID_RESPONSE",
      })),
    ];
    const scenarioSummary = summarizeConsistencySamples([scenario], samples).scenarios[0]!;
    expect(scenarioSummary.validityRate).toBe(0.8);
    expect(scenarioSummary.dominantShare).toBe(1);
    expect(scenarioSummary.outcomes.PROTOCOL_ERROR).toBe(2);
  });

  it("reports sizing and dimension summaries without mixing scenario actions", () => {
    const scenarios = CONSISTENCY_SCENARIOS.slice(0, 2);
    const samples = [
      sample(scenarios[0]!.id, 1, { outcome: "VALID_ACTION", action: "raise", amountTo: 700 }),
      sample(scenarios[0]!.id, 2, { outcome: "VALID_ACTION", action: "raise", amountTo: 900 }),
      sample(scenarios[1]!.id, 1, { outcome: "VALID_ACTION", action: "fold" }),
      sample(scenarios[1]!.id, 2, { outcome: "VALID_ACTION", action: "call" }),
    ];
    const summary = summarizeConsistencySamples(scenarios, samples);
    expect(summary.scenarios[0]!.sizing.raise).toEqual({
      count: 2,
      median: 800,
      min: 700,
      max: 900,
      values: [700, 900],
    });
    expect(summary.meanDominantShare).toBe(0.75);
    expect(summary.dimensions.street?.PREFLOP?.scenarios).toBe(2);
  });
});

describe("consistency worker lifecycle", () => {
  it("waits for an active worker before shutdown resolves", async () => {
    let finishClaim!: (value: { rowCount: number; rows: never[] }) => void;
    const blockedClaim = new Promise<{ rowCount: number; rows: never[] }>((resolve) => {
      finishClaim = resolve;
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("set status = 'QUEUED'")) return { rowCount: 0, rows: [] };
      if (sql.startsWith("select id from consistency_runs")) return { rowCount: 1, rows: [{ id: "run-1" }] };
      if (sql.includes("set status = 'RUNNING'")) return blockedClaim;
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new ConsistencyTestService(
      { query } as unknown as Pool,
      {} as ModelConfigService,
      new Uint8Array(32),
    );
    await service.restorePending();
    let shutdownFinished = false;

    const shutdown = service.shutdown().then(() => { shutdownFinished = true; });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);

    finishClaim({ rowCount: 0, rows: [] });
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });
});
