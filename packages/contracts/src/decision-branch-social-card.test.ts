import { describe, expect, it } from "vitest";
import {
  DECISION_BRANCH_SOCIAL_CARD_PROJECTION_VERSION,
  DECISION_BRANCH_SOCIAL_CARD_SIZE,
  parseDecisionBranchSocialCardProjection,
  type DecisionBranchSocialCardProjection,
} from "./decision-branch-social-card.js";

function target(ordinal: number) {
  return {
    ordinal,
    displayName: `Model ${ordinal}`,
    providerBrand: "deepseek" as const,
    validActionTrials: 8,
    completedTrials: 10,
    fallbackTrials: 1,
    infrastructureErrorTrials: 1,
    pairwiseAgreement: 19 / 28,
    actionDistribution: [
      { action: "fold" as const, count: 3, share: 3 / 8 },
      { action: "call" as const, count: 5, share: 5 / 8 },
    ],
  };
}

function projection(): DecisionBranchSocialCardProjection {
  return {
    version: DECISION_BRANCH_SOCIAL_CARD_PROJECTION_VERSION,
    locale: "en",
    tournamentName: "Model Championship",
    handNo: 42,
    street: "TURN",
    title: "Same spot, different models",
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
    sampleCountPerModel: 10,
    targetCount: 5,
    displayedTargets: [target(1), target(2), target(3), target(4)],
    additionalTargetCount: 1,
    completedAt: "2026-08-20T01:01:00.000Z",
  };
}

describe("decisionBranchSocialCardProjectionSchema", () => {
  it("accepts the strict 1200 by 675 public projection", () => {
    expect(DECISION_BRANCH_SOCIAL_CARD_SIZE).toEqual({ width: 1_200, height: 675 });
    expect(parseDecisionBranchSocialCardProjection(projection())).toEqual(projection());
  });

  it.each([
    ["action history", { actionHistory: [{ privatePayload: "secret" }] }],
    ["provider request", { providerRequest: { authorization: "secret" } }],
    ["opponent cards", { opponentHoleCards: ["2c", "2h"] }],
  ])("rejects a root-level %s field", (_label, forbidden) => {
    expect(() => parseDecisionBranchSocialCardProjection({
      ...projection(),
      ...forbidden,
    })).toThrow();
  });

  it("rejects trial evidence or internal identities nested in a displayed target", () => {
    const value = projection();
    expect(() => parseDecisionBranchSocialCardProjection({
      ...value,
      displayedTargets: [{
        ...value.displayedTargets[0],
        competitorRevisionId: "11111111-1111-4111-8111-111111111111",
        trials: [{ decisionSummary: "private reasoning" }],
      }, ...value.displayedTargets.slice(1)],
    })).toThrow();
  });

  it("keeps valid-action and terminal-outcome denominators separate", () => {
    const value = projection();
    const invalid = structuredClone(value);
    invalid.displayedTargets[0]!.actionDistribution[1]!.share = 0.5;
    expect(() => parseDecisionBranchSocialCardProjection(invalid)).toThrow(/denominator/i);

    const invalidTotal = structuredClone(value);
    invalidTotal.displayedTargets[0]!.fallbackTrials = 0;
    expect(() => parseDecisionBranchSocialCardProjection(invalidTotal)).toThrow(/completed trials/i);
  });

  it("requires canonical action order and an exact first-four remainder", () => {
    const value = projection();
    const wrongOrder = structuredClone(value);
    wrongOrder.displayedTargets[0]!.actionDistribution.reverse();
    expect(() => parseDecisionBranchSocialCardProjection(wrongOrder)).toThrow(/canonical/i);

    expect(() => parseDecisionBranchSocialCardProjection({
      ...value,
      additionalTargetCount: 0,
    })).toThrow(/first four/i);
  });

  it("rejects cards from a later street and unsized all-in decisions", () => {
    const value = projection();
    expect(() => parseDecisionBranchSocialCardProjection({
      ...value,
      board: [...value.board, "Js"],
    })).toThrow(/decision street/i);
    expect(() => parseDecisionBranchSocialCardProjection({
      ...value,
      originalDecision: { action: "all_in", displayAmountTo: null },
    })).toThrow(/display amount/i);
  });

  it("allows zero valid model actions without a misleading zero-percent distribution", () => {
    const value = projection();
    value.displayedTargets = value.displayedTargets.map((entry) => ({
      ...entry,
      validActionTrials: 0,
      fallbackTrials: 7,
      infrastructureErrorTrials: 3,
      pairwiseAgreement: null,
      actionDistribution: [],
    }));
    expect(parseDecisionBranchSocialCardProjection(value).displayedTargets[0])
      .toMatchObject({ validActionTrials: 0, pairwiseAgreement: null, actionDistribution: [] });
  });
});
