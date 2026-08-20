import { describe, expect, it } from "vitest";
import {
  DECISION_BRANCH_SNAPSHOT_V1,
  decisionBranchPublicationSchema,
  decisionBranchSnapshotV1Schema,
  publicDecisionBranchSummarySchema,
  storedDecisionBranchSnapshotSchema,
} from "./decision-branches.js";

const ids = {
  publication: "11111111-1111-4111-8111-111111111111",
  fork: "22222222-2222-4222-8222-222222222222",
  tournament: "33333333-3333-4333-8333-333333333333",
  heroCompetitor: "44444444-4444-4444-8444-444444444444",
  villainCompetitor: "55555555-5555-4555-8555-555555555555",
  targetCompetitor: "66666666-6666-4666-8666-666666666666",
  targetRevision: "77777777-7777-4777-8777-777777777777",
};

function snapshot() {
  return {
    version: DECISION_BRANCH_SNAPSHOT_V1,
    source: {
      tournamentId: ids.tournament,
      tournamentName: "Model Championship",
      handNo: 42,
      actionSequence: 812,
      street: "TURN" as const,
      heroPlayerId: "hero",
      heroDisplayName: "Original Model",
      heroPosition: "BTN",
      heroHoleCards: ["As", "Kd"],
      board: ["Ah", "7c", "2d", "Qc"],
      blinds: { smallBlind: 50, bigBlind: 100, bigBlindAnte: 100 },
      potBeforeAction: 2_400,
      potBigBlinds: 24,
      currentBet: 800,
      callAmount: 800,
      legalActions: {
        allowed: ["fold", "call", "raise", "all_in"],
        call: { amount: 800, will_be_all_in: false },
        bet: null,
        raise: { min_amount_to: 1_600, max_amount_to: 8_000 },
        all_in: { resulting_street_commitment: 8_000, classification: "raise" },
      },
      players: [
        {
          playerId: "hero",
          displayName: "Original Model",
          seat: 0,
          position: "BTN",
          stack: 8_000,
          stackBigBlinds: 80,
          streetCommitted: 0,
          totalCommitted: 1_200,
          folded: false,
          allIn: false,
          competitorId: ids.heroCompetitor,
          providerBrand: "chatgpt" as const,
        },
        {
          playerId: "villain",
          displayName: "Opponent",
          seat: 3,
          position: "BB",
          stack: 6_200,
          stackBigBlinds: 62,
          streetCommitted: 800,
          totalCommitted: 1_200,
          folded: false,
          allIn: false,
          competitorId: ids.villainCompetitor,
          providerBrand: "claude" as const,
        },
      ],
      actionHistory: [{
        sequence: 809,
        type: "ACTION" as const,
        street: "TURN" as const,
        playerId: "villain",
        label: "bet",
        action: "bet" as const,
        amount: 800,
        amountTo: 800,
        potAfter: 2_400,
        stackAfter: 6_200,
        cards: [],
      }],
      originalDecision: {
        action: "call" as const,
        amountTo: null,
        decisionSummary: "Top pair remains ahead of enough value bets.",
        usedFallback: false,
      },
    },
    methodology: {
      scope: "DECISION_ONLY" as const,
      continuationSimulated: false as const,
      sameVisibleInput: true as const,
      sampleCountPerModel: 2,
      targetCount: 1,
      createdAt: "2026-08-20T01:00:00.000Z",
      completedAt: "2026-08-20T01:01:00.000Z",
    },
    targets: [{
      ordinal: 1,
      competitorId: ids.targetCompetitor,
      competitorRevisionId: ids.targetRevision,
      displayName: "Counterfactual Model",
      modelId: "model-v1",
      providerBrand: "deepseek" as const,
      effectiveOutputMode: "json_schema" as const,
      requestedSamples: 2,
      completedTrials: 2,
      modelActionTrials: 2,
      fallbackTrials: 0,
      infrastructureErrorTrials: 0,
      modalAction: "call" as const,
      modalShare: 0.5,
      pairwiseAgreement: 0,
      firstTurnValidRate: 1,
      historyQueryRate: 0.5,
      correctionRate: 0,
      averageLatencyMs: 1_500,
      p95LatencyMs: 1_800,
      actionDistribution: [
        { action: "call" as const, count: 1, share: 0.5 },
        { action: "fold" as const, count: 1, share: 0.5 },
      ],
      sizing: [],
      trials: [
        {
          sampleIndex: 1,
          outcome: "MODEL_ACTION" as const,
          action: "call" as const,
          amountTo: null,
          decisionSummary: "Call keeps weaker hands in range.",
          usedFallback: false,
        },
        {
          sampleIndex: 2,
          outcome: "MODEL_ACTION" as const,
          action: "fold" as const,
          amountTo: null,
          decisionSummary: "The turn sizing is too value dense.",
          usedFallback: false,
        },
      ],
    }],
  };
}

describe("decision branch contracts", () => {
  it("accepts a frozen, decision-only public snapshot", () => {
    const parsed = decisionBranchSnapshotV1Schema.parse(snapshot());
    expect(parsed.methodology).toMatchObject({
      scope: "DECISION_ONLY",
      continuationSimulated: false,
      sameVisibleInput: true,
    });
    expect(parsed.source.heroHoleCards).toEqual(["As", "Kd"]);
    expect(parsed.targets[0]?.trials).toHaveLength(2);
  });

  it("rejects fields that could smuggle private fork payloads into a public snapshot", () => {
    const unsafe = {
      ...snapshot(),
      systemPrompt: "private prompt",
      targets: [{
        ...snapshot().targets[0],
        modelConfigId: "88888888-8888-4888-8888-888888888888",
        rawResponse: "secret transport body",
      }],
    };
    expect(decisionBranchSnapshotV1Schema.safeParse(unsafe).success).toBe(false);
  });

  it("keeps historical snapshots readable only through a registered version", () => {
    expect(storedDecisionBranchSnapshotSchema.parse(snapshot()).version)
      .toBe(DECISION_BRANCH_SNAPSHOT_V1);
    expect(storedDecisionBranchSnapshotSchema.safeParse({
      ...snapshot(),
      version: "arena-decision-branch-public-v99",
    }).success).toBe(false);
  });

  it("requires complete target denominators and consistent action totals", () => {
    const invalid = snapshot();
    invalid.targets[0]!.completedTrials = 1;
    expect(decisionBranchSnapshotV1Schema.safeParse(invalid).success).toBe(false);
  });

  it("requires public metadata only once a branch is published", () => {
    const base = {
      id: ids.publication,
      handForkId: ids.fork,
      status: "DRAFT" as const,
      slug: null,
      titleZh: null,
      titleEn: null,
      summaryZh: null,
      summaryEn: null,
      snapshotVersion: DECISION_BRANCH_SNAPSHOT_V1,
      snapshotHash: "a".repeat(64),
      snapshot: snapshot(),
      revision: 1,
      createdByAdminUserId: null,
      publishedAt: null,
      createdAt: "2026-08-20T01:00:00.000Z",
      updatedAt: "2026-08-20T01:00:00.000Z",
    };
    expect(decisionBranchPublicationSchema.parse(base).status).toBe("DRAFT");
    expect(decisionBranchPublicationSchema.safeParse({
      ...base,
      status: "PUBLISHED",
    }).success).toBe(false);
  });

  it("accepts only the lightweight, role-aware public discovery summary", () => {
    const summary = {
      id: ids.publication,
      status: "PUBLISHED" as const,
      slug: "turn-call-study",
      titleZh: "转牌跟注实验",
      titleEn: "Turn call study",
      summaryZh: null,
      summaryEn: null,
      publishedAt: "2026-08-20T02:00:00.000Z",
      tournamentId: ids.tournament,
      tournamentName: "Model Championship",
      handNo: 42,
      actionSequence: 812,
      street: "TURN" as const,
      hero: {
        competitorId: ids.heroCompetitor,
        displayName: "Original Model",
        position: "BTN",
        providerBrand: "chatgpt" as const,
      },
      originalDecision: { action: "call" as const, displayAmountTo: null },
      targetCount: 1,
      sampleCountPerModel: 2,
      targets: [{
        ordinal: 1,
        competitorId: ids.targetCompetitor,
        displayName: "Counterfactual Model",
        providerBrand: "deepseek" as const,
        modelActionTrials: 2,
        fallbackTrials: 0,
        infrastructureErrorTrials: 0,
        actionDistribution: [
          { action: "call" as const, count: 1, share: 0.5 },
          { action: "fold" as const, count: 1, share: 0.5 },
        ],
      }],
      relatedPlayerRoles: ["DECISION_MAKER" as const],
    };
    expect(publicDecisionBranchSummarySchema.parse(summary)).toEqual(summary);
    expect(publicDecisionBranchSummarySchema.safeParse({
      ...summary,
      snapshot: snapshot(),
    }).success).toBe(false);
    expect(publicDecisionBranchSummarySchema.safeParse({
      ...summary,
      relatedPlayerRoles: ["DESISION_MAKER"],
    }).success).toBe(false);
  });
});
