import { describe, expect, it } from "vitest";
import {
  createHandForkRequestSchema,
  handForkSourceSummarySchema,
  handForkTrialSchema,
  handForkTurnMetadataSchema,
} from "./hand-forks.js";

const UUID_ONE = "00000000-0000-4000-8000-000000000001";
const UUID_TWO = "00000000-0000-4000-8000-000000000002";

describe("hand fork contracts", () => {
  it("accepts one to nine unique target models with bounded execution settings", () => {
    expect(createHandForkRequestSchema.parse({
      sourceDecisionId: UUID_ONE,
      modelConfigIds: [UUID_ONE, UUID_TWO],
      sampleCount: 10,
      timeoutMs: 180_000,
    })).toMatchObject({
      maxParallelTargets: 3,
      sampleCount: 10,
    });

    expect(() => createHandForkRequestSchema.parse({
      sourceDecisionId: UUID_ONE,
      modelConfigIds: [UUID_TWO, UUID_TWO],
      sampleCount: 10,
      timeoutMs: 180_000,
    })).toThrow(/unique/i);
  });

  it("models an admin-only source summary without weakening legal-action bounds", () => {
    const source = handForkSourceSummarySchema.parse({
      tournamentId: UUID_ONE,
      tournamentName: "Final table",
      handNo: 42,
      decisionId: UUID_TWO,
      playerId: "seat-3",
      playerDisplayName: "Kimi K3",
      street: "TURN",
      heroPosition: "BTN",
      holeCards: ["Ah", "Kd"],
      legalActions: {
        allowed: ["fold", "call", "raise", "all_in"],
        call: { amount: 120, will_be_all_in: false },
        bet: null,
        raise: { min_amount_to: 360, max_amount_to: 1_800 },
        all_in: { resulting_street_commitment: 1_800, classification: "raise" },
      },
      originalAction: "call",
      originalAmountTo: null,
      originalDecisionSummary: "Pot control with showdown value.",
      originalUsedFallback: false,
      actionEventSequence: 288,
    });
    expect(source.holeCards).toEqual(["Ah", "Kd"]);

    expect(() => handForkSourceSummarySchema.parse({
      ...source,
      legalActions: {
        ...source.legalActions,
        raise: { min_amount_to: 1_800, max_amount_to: 360 },
      },
    })).toThrow(/maximum/i);
  });

  it("never represents a response hash without a recorded encrypted response", () => {
    expect(() => handForkTurnMetadataSchema.parse({
      turnIndex: 1,
      requestHash: "a".repeat(64),
      responseHash: "b".repeat(64),
      responseRecorded: false,
      outcome: "SUCCESS",
      errorKind: null,
      latencyMs: 200,
      usage: null,
      providerConfigHash: "c".repeat(64),
      outputSchemaVersion: "arena-output-v3",
      outputSchemaHash: "d".repeat(64),
      adapterVersion: "adapter-v1",
      appliedOutputMode: "json_schema",
      finishReason: "stop",
      refusalHash: null,
      refusalRecorded: false,
      responseModel: "model",
      createdAt: "2026-08-20T00:00:00.000Z",
    })).toThrow(/responseRecorded/);
  });

  it("keeps amountTo bidirectional for source and trial actions", () => {
    const source = {
      tournamentId: UUID_ONE,
      tournamentName: "Final table",
      handNo: 42,
      decisionId: UUID_TWO,
      playerId: "seat-3",
      playerDisplayName: "Model",
      street: "FLOP",
      heroPosition: "BTN",
      holeCards: ["Ah", "Kd"],
      legalActions: {
        allowed: ["check", "bet", "all_in"],
        call: null,
        bet: { min_amount_to: 100, max_amount_to: 1_000 },
        raise: null,
        all_in: { resulting_street_commitment: 1_000, classification: "bet" },
      },
      originalAction: "raise",
      originalAmountTo: null,
      originalDecisionSummary: null,
      originalUsedFallback: false,
      actionEventSequence: 10,
    };
    expect(() => handForkSourceSummarySchema.parse(source)).toThrow(/originalAmountTo/);

    const trial = {
      id: UUID_ONE,
      sampleIndex: 1,
      status: "COMPLETED",
      outcome: "MODEL_ACTION",
      action: "bet",
      amountTo: null,
      decisionSummary: null,
      usedFallback: false,
      firstTurnValid: true,
      historyQueryCount: 0,
      protocolFailures: 0,
      infrastructureFailures: 0,
      callCount: 1,
      totalLatencyMs: 10,
      usage: null,
      visibleInputHash: "a".repeat(64),
      errorKind: null,
      errorMessage: null,
      createdAt: "2026-08-20T00:00:00.000Z",
      completedAt: "2026-08-20T00:00:01.000Z",
    };
    expect(() => handForkTrialSchema.parse(trial)).toThrow(/amountTo/);
    expect(() => handForkTrialSchema.parse({ ...trial, action: "call", amountTo: 100 })).toThrow(/amountTo/);
  });

  it("exposes only an encrypted-refusal marker and hash", () => {
    const base = {
      turnIndex: 1,
      requestHash: "a".repeat(64),
      responseHash: null,
      responseRecorded: false,
      outcome: "INFRA_ERROR",
      errorKind: "SERVER",
      latencyMs: null,
      usage: null,
      providerConfigHash: "c".repeat(64),
      outputSchemaVersion: "arena-output-v3",
      outputSchemaHash: "d".repeat(64),
      adapterVersion: "adapter-v1",
      appliedOutputMode: "json_schema",
      finishReason: "stop",
      refusalHash: "e".repeat(64),
      refusalRecorded: false,
      responseModel: "model",
      createdAt: "2026-08-20T00:00:00.000Z",
    };
    expect(() => handForkTurnMetadataSchema.parse(base)).toThrow(/refusalRecorded/);
    const parsed = handForkTurnMetadataSchema.parse({ ...base, refusalRecorded: true });
    expect(parsed).not.toHaveProperty("refusal");
  });
});
