import { describe, expect, it } from "vitest";
import {
  adminHandForkSchema,
  type AdminHandFork,
} from "../../../../../packages/contracts/src/index.js";
import {
  buildDecisionBranchSnapshot,
  DecisionBranchProjectionError,
  type DecisionBranchIdentityContext,
} from "./decision-branch-projection.js";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const hash = (character: string) => character.repeat(64);
const visibleInputHash = hash("d");

function targetSummary() {
  return {
    requestedSamples: 2,
    terminalTrials: 2,
    terminalCoverage: 1,
    completedTrials: 2,
    reliabilityEligibleTrials: 2,
    firstTurnObservedTrials: 2,
    modelActionTrials: 2,
    actionDistributionTrials: 2,
    modelActionCoverage: 1,
    fallbackTrials: 0,
    infrastructureErrorTrials: 0,
    cancelledTrials: 0,
    modalAction: "fold" as const,
    modalCount: 1,
    modalShare: 0.5,
    pairwiseAgreement: 0,
    pairwiseComparisonPairs: 1,
    actionDistribution: { call: 1, fold: 1 },
    sizing: {},
    firstTurnValidRate: 1,
    historyQueryRate: 0.5,
    correctionRate: 0,
    latencyObservedTrials: 2,
    averageLatencyMs: 1_500,
    p95LatencyMs: 1_800,
    tokenObservedTrials: 0,
    totalTokens: null,
  };
}

function fork(): AdminHandFork {
  const createdAt = "2026-08-20T01:00:00.000Z";
  const completedAt = "2026-08-20T01:01:00.000Z";
  return adminHandForkSchema.parse({
    id: uuid(1),
    status: "COMPLETED",
    source: {
      tournamentId: uuid(2),
      tournamentName: "Model Championship",
      handNo: 42,
      decisionId: uuid(3),
      playerId: "hero",
      playerDisplayName: "Original Model",
      street: "TURN",
      heroPosition: "BTN",
      holeCards: ["As", "Kd"],
      legalActions: {
        allowed: ["fold", "call", "raise", "all_in"],
        call: { amount: 800, will_be_all_in: false },
        bet: null,
        raise: { min_amount_to: 1_600, max_amount_to: 8_000 },
        all_in: { resulting_street_commitment: 8_000, classification: "raise" },
      },
      originalAction: "call",
      originalAmountTo: null,
      originalDecisionSummary: "Continue against the polarized sizing.",
      originalUsedFallback: false,
      actionEventSequence: 812,
    },
    sourceIntegrity: {
      expectedAggregateVersion: 812,
      sourceEventHash: hash("a"),
      sourceRequestHash: hash("b"),
      sourcePayloadHash: hash("c"),
      visibleInputHash,
      legalContractHash: hash("e"),
      protocolBundleId: "arena-protocol-v1",
      rulesetVersion: "arena-rules-v2",
      contextVersion: "model-context-v4",
      systemPromptHash: hash("f"),
      outputSchemaHash: hash("1"),
      parserPolicyVersion: "arena-parser-strict-v1",
      adapterProtocolVersion: "arena-adapters-v2",
      historyProtocolVersion: "arena-history-v2",
      correctionProtocolVersion: "arena-correction-v2",
    },
    sampleCount: 2,
    timeoutMs: 180_000,
    maxParallelTargets: 1,
    summary: {
      totalTargets: 1,
      terminalTargets: 1,
      targetTerminalCoverage: 1,
      completedTargets: 1,
      failedTargets: 0,
      cancelledTargets: 0,
      requestedTrials: 2,
      terminalTrials: 2,
      trialTerminalCoverage: 1,
      completedTrials: 2,
      cancelledTrials: 0,
      modelActionTrials: 2,
      fallbackTrials: 0,
      infrastructureErrorTrials: 0,
    },
    errorMessage: null,
    createdByAdminUserId: uuid(4),
    startedAt: createdAt,
    completedAt,
    createdAt,
    updatedAt: completedAt,
    targets: [{
      id: uuid(5),
      ordinal: 1,
      modelConfigId: uuid(6),
      competitorRevisionId: uuid(7),
      competitorFamilyId: uuid(8),
      modelDisplayName: "DeepSeek Counterfactual",
      modelId: "deepseek-v4",
      providerProfile: "deepseek",
      modelConfigurationHash: hash("2"),
      effectiveOutputMode: "json_schema",
      sampleCount: 2,
      status: "COMPLETED",
      terminalTrials: 2,
      summary: targetSummary(),
      errorMessage: null,
      startedAt: createdAt,
      completedAt,
      createdAt,
      updatedAt: completedAt,
      trials: [
        {
          id: uuid(9),
          sampleIndex: 1,
          status: "COMPLETED",
          outcome: "MODEL_ACTION",
          action: "call",
          amountTo: null,
          decisionSummary: "Top pair can continue.",
          usedFallback: false,
          firstTurnValid: true,
          historyQueryCount: 1,
          protocolFailures: 0,
          infrastructureFailures: 0,
          callCount: 2,
          totalLatencyMs: 1_800,
          usage: null,
          visibleInputHash,
          errorKind: null,
          errorMessage: null,
          createdAt,
          completedAt,
        },
        {
          id: uuid(10),
          sampleIndex: 2,
          status: "COMPLETED",
          outcome: "MODEL_ACTION",
          action: "fold",
          amountTo: null,
          decisionSummary: "The sizing is too value heavy.",
          usedFallback: false,
          firstTurnValid: true,
          historyQueryCount: 0,
          protocolFailures: 0,
          infrastructureFailures: 0,
          callCount: 1,
          totalLatencyMs: 1_200,
          usage: null,
          visibleInputHash,
          errorKind: null,
          errorMessage: null,
          createdAt,
          completedAt,
        },
      ],
    }],
  });
}

function arenaState() {
  return {
    schema_version: "model-context-v4",
    tournament_id: uuid(2),
    hand_no: 42,
    blinds: { small_blind: 50, big_blind: 100, big_blind_ante: 100 },
    positions: {
      hero_position: "BTN",
      by_player: [
        { player_id: "hero", seat: 0, position: "BTN" },
        { player_id: "villain", seat: 3, position: "BB" },
      ],
    },
    hero: {
      player_id: "hero",
      seat: 0,
      stack: 8_000,
      stack_bb: 80,
      street_committed: 0,
      total_committed: 1_200,
      hole_cards: ["As", "Kd"],
    },
    opponents: [{
      player_id: "villain",
      seat: 3,
      stack: 6_200,
      stack_bb: 62,
      folded: false,
      all_in: false,
      street_committed: 800,
      total_committed: 1_200,
    }],
    board: ["Ah", "7c", "2d", "Qc"],
    pot: { total_before_action: 2_400, call_amount: 800 },
    betting: {
      street: "TURN",
      current_actor_id: "hero",
      current_bet: 800,
      call_amount: 800,
    },
    action_history: [
      {
        sequence: 807,
        type: "board_dealt",
        street: "TURN",
        cards: ["Qc"],
      },
      {
        sequence: 809,
        type: "action",
        street: "TURN",
        player_id: "villain",
        action: "bet",
        classification: "bet",
        paid: 800,
        amount_to: 800,
        pot_after: 2_400,
        stack_after: 6_200,
      },
      {
        sequence: 900,
        type: "board_dealt",
        street: "RIVER",
        cards: ["2s"],
      },
    ],
    systemPrompt: "must never be copied",
    providerRequest: { authorization: "secret" },
  };
}

function identity(): DecisionBranchIdentityContext {
  return {
    tournament: { id: uuid(2), name: "Model Championship" },
    players: [
      { id: "hero", displayName: "Original Model", seat: 0, competitorId: uuid(11), providerBrand: "chatgpt" },
      { id: "villain", displayName: "Opponent", seat: 3, competitorId: uuid(12), providerBrand: "claude" },
    ],
  };
}

describe("decision branch public projection", () => {
  it("freezes the decision spot and model choices without copying private fork internals", () => {
    const snapshot = buildDecisionBranchSnapshot({
      fork: fork(),
      arenaState: arenaState(),
      identity: identity(),
    });
    expect(snapshot.source).toMatchObject({
      street: "TURN",
      board: ["Ah", "7c", "2d", "Qc"],
      potBeforeAction: 2_400,
      callAmount: 800,
      heroHoleCards: ["As", "Kd"],
    });
    expect(snapshot.source.actionHistory.map((entry) => entry.sequence)).toEqual([807, 809]);
    expect(snapshot.targets[0]).toMatchObject({
      competitorId: uuid(8),
      competitorRevisionId: uuid(7),
      providerBrand: "deepseek",
      modalAction: "fold",
      modalShare: 0.5,
      actionDistribution: [
        { action: "fold", count: 1, share: 0.5 },
        { action: "call", count: 1, share: 0.5 },
      ],
    });
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [
      "must never be copied",
      "authorization",
      "modelConfigId",
      "sourceIntegrity",
      "errorMessage",
      "systemPromptHash",
      visibleInputHash,
    ]) expect(serialized).not.toContain(forbidden);
  });

  it("adapts the legacy players and boards context shape without exposing hero twice", () => {
    const legacy = arenaState() as Record<string, unknown>;
    legacy.boards = [(legacy.board as string[])];
    delete legacy.board;
    legacy.players = [legacy.hero, ...(legacy.opponents as unknown[])];
    delete legacy.opponents;
    delete legacy.action_history;
    legacy.current_hand_events = [{
      sequence: 809,
      type: "ACTION_APPLIED",
      actorId: "villain",
      publicPayload: {
        street: "TURN",
        command: { action: "bet", amountTo: 800 },
        classification: "bet",
        paid: 800,
        amountTo: 800,
      },
      privatePayload: { holeCards: ["2c", "2h"] },
    }];
    const snapshot = buildDecisionBranchSnapshot({ fork: fork(), arenaState: legacy, identity: identity() });
    expect(snapshot.source.board).toEqual(["Ah", "7c", "2d", "Qc"]);
    expect(snapshot.source.players.map((player) => player.playerId)).toEqual(["hero", "villain"]);
    expect(snapshot.source.actionHistory).toEqual([expect.objectContaining({
      sequence: 809,
      type: "ACTION",
      action: "bet",
      amount: 800,
    })]);
    expect(JSON.stringify(snapshot)).not.toContain("2c");
  });

  it("rejects non-terminal experiments and mismatched visible-input trials", () => {
    const incomplete = fork();
    incomplete.status = "PARTIAL";
    expect(() => buildDecisionBranchSnapshot({ fork: incomplete, arenaState: arenaState(), identity: identity() }))
      .toThrow(DecisionBranchProjectionError);

    const mismatched = fork();
    mismatched.targets[0]!.trials![0]!.visibleInputHash = hash("9");
    expect(() => buildDecisionBranchSnapshot({ fork: mismatched, arenaState: arenaState(), identity: identity() }))
      .toThrow(/frozen visible input/i);
  });

  it("fails closed if an opponent hole card appears in the source payload", () => {
    const unsafe = arenaState();
    (unsafe.opponents[0] as unknown as Record<string, unknown>).hole_cards = ["2c", "2h"];
    expect(() => buildDecisionBranchSnapshot({ fork: fork(), arenaState: unsafe, identity: identity() }))
      .toThrow(/opponent hole cards/i);
  });
});
