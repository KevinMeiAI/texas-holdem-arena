import { describe, expect, it } from "vitest";
import {
  DECISION_BRANCH_SNAPSHOT_V1,
  publicDecisionBranchDtoSchema,
  type PublicDecisionBranchDto,
} from "../../../../../packages/contracts/src/index.js";
import { buildDecisionBranchSocialCardProjection } from "./decision-branch-social-card-projection.js";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function target(ordinal: number) {
  return {
    ordinal,
    competitorId: uuid(100 + ordinal),
    competitorRevisionId: uuid(200 + ordinal),
    displayName: `模型 Target ${ordinal}`,
    modelId: `internal-model-${ordinal}`,
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
        decisionSummary: `trial-secret-${ordinal}-one`,
        usedFallback: false,
      },
      {
        sampleIndex: 2,
        outcome: "MODEL_ACTION" as const,
        action: "fold" as const,
        amountTo: null,
        decisionSummary: `trial-secret-${ordinal}-two`,
        usedFallback: false,
      },
    ],
  };
}

function branch(): PublicDecisionBranchDto {
  return publicDecisionBranchDtoSchema.parse({
    id: uuid(1),
    status: "PUBLISHED",
    slug: "same-spot-six-models",
    titleZh: "绝不能进入分享卡的中文标题",
    titleEn: "Six models - one all-in",
    summaryZh: "中文摘要不得进入 Projection",
    summaryEn: "summary-secret-must-stay-out",
    publicationRevision: 3,
    publishedAt: "2026-08-20T01:02:00.000Z",
    snapshot: {
      version: DECISION_BRANCH_SNAPSHOT_V1,
      source: {
        tournamentId: uuid(2),
        tournamentName: "模型锦标赛 Model Championship",
        handNo: 42,
        actionSequence: 812,
        street: "TURN",
        heroPlayerId: "hero",
        heroDisplayName: "原模型 Original Model",
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
            competitorId: uuid(3),
            providerBrand: "chatgpt",
          },
          {
            playerId: "villain",
            displayName: "Opponent Identity MUST STAY OUT",
            seat: 3,
            position: "BB",
            stack: 6_200,
            stackBigBlinds: 62,
            streetCommitted: 800,
            totalCommitted: 1_200,
            folded: false,
            allIn: false,
            competitorId: uuid(4),
            providerBrand: "claude",
          },
        ],
        actionHistory: [{
          sequence: 809,
          type: "ACTION",
          street: "TURN",
          playerId: "villain",
          label: "provider-secret",
          action: "bet",
          amount: 800,
          amountTo: 800,
          potAfter: 2_400,
          stackAfter: 6_200,
          cards: [],
        }],
        originalDecision: {
          action: "all_in",
          amountTo: null,
          decisionSummary: "original-reason-secret",
          usedFallback: false,
        },
      },
      methodology: {
        scope: "DECISION_ONLY",
        continuationSimulated: false,
        sameVisibleInput: true,
        sampleCountPerModel: 2,
        targetCount: 6,
        createdAt: "2026-08-20T01:00:00.000Z",
        completedAt: "2026-08-20T01:01:00.000Z",
      },
      targets: [target(6), target(2), target(4), target(1), target(5), target(3)],
    },
  });
}

describe("buildDecisionBranchSocialCardProjection", () => {
  it("projects the ordinal-first four targets with canonical actions and all-in total commitment", () => {
    const projection = buildDecisionBranchSocialCardProjection({
      branch: branch(),
      locale: "zh-CN",
    });
    expect(projection).toMatchObject({
      locale: "zh-CN",
      tournamentName: "Model Championship",
      handNo: 42,
      street: "TURN",
      title: "Six models - one all-in",
      hero: {
        displayName: "Original Model",
        position: "BTN",
        holeCards: ["As", "Kd"],
        stackChips: 8_000,
        stackBigBlinds: 80,
      },
      board: ["Ah", "7c", "2d", "Qc"],
      potBeforeActionChips: 2_400,
      potBeforeActionBigBlinds: 24,
      callAmountChips: 800,
      callAmountBigBlinds: 8,
      originalDecision: { action: "all_in", displayAmountTo: 8_000 },
      sampleCountPerModel: 2,
      targetCount: 6,
      additionalTargetCount: 2,
    });
    expect(projection.displayedTargets.map((entry) => entry.ordinal)).toEqual([1, 2, 3, 4]);
    expect(projection.displayedTargets.map((entry) => entry.displayName)).toEqual([
      "Target 1", "Target 2", "Target 3", "Target 4",
    ]);
    expect(projection.displayedTargets[0]!.actionDistribution.map((entry) => entry.action))
      .toEqual(["fold", "call"]);
  });

  it("does not copy private-detail-shaped or report-detail fields into the worker projection", () => {
    const projection = buildDecisionBranchSocialCardProjection({ branch: branch(), locale: "en" });
    expect(Object.keys(projection).sort()).toEqual([
      "additionalTargetCount",
      "board",
      "callAmountBigBlinds",
      "callAmountChips",
      "completedAt",
      "displayedTargets",
      "handNo",
      "hero",
      "locale",
      "originalDecision",
      "potBeforeActionBigBlinds",
      "potBeforeActionChips",
      "sampleCountPerModel",
      "street",
      "targetCount",
      "title",
      "tournamentName",
      "version",
    ]);
    expect(Object.keys(projection.displayedTargets[0]!).sort()).toEqual([
      "actionDistribution",
      "completedTrials",
      "displayName",
      "fallbackTrials",
      "infrastructureErrorTrials",
      "ordinal",
      "pairwiseAgreement",
      "providerBrand",
      "validActionTrials",
    ]);
    const serialized = JSON.stringify(projection);
    for (const forbidden of [
      "绝不能进入",
      "中文摘要",
      "summary-secret",
      "Opponent Identity",
      "provider-secret",
      "original-reason-secret",
      "trial-secret",
      "internal-model",
      "competitorRevisionId",
      "actionHistory",
      "decisionSummary",
    ]) expect(serialized).not.toContain(forbidden);
    expect(serialized).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("uses an English factual fallback instead of Chinese editorial copy", () => {
    const source = branch();
    source.titleEn = null;
    source.titleZh = "只存在中文标题";
    expect(buildDecisionBranchSocialCardProjection({ branch: source, locale: "zh-CN" }).title)
      .toBe("Hand 42 - Turn decision branch");

    source.titleEn = "仍然是中文";
    expect(buildDecisionBranchSocialCardProjection({ branch: source, locale: "en" }).title)
      .toBe("Hand 42 - Turn decision branch");
  });
});
