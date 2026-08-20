import { describe, expect, it } from "vitest";
import type { PublicDecisionBranchSummary } from "../../../packages/contracts/src/decision-branches";
import {
  aggregateDecisionBranchActions,
  buildDecisionBranchDiscoveryCardModel,
} from "./decision-branch-discovery-model";

const BRANCH_ID = "11111111-1111-4111-8111-111111111111";
const HERO_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_A = "33333333-3333-4333-8333-333333333333";
const TARGET_B = "44444444-4444-4444-8444-444444444444";
const TARGET_C = "55555555-5555-4555-8555-555555555555";
const TARGET_D = "66666666-6666-4666-8666-666666666666";

function branch(
  overrides: Partial<PublicDecisionBranchSummary> = {},
): PublicDecisionBranchSummary {
  return {
    id: BRANCH_ID,
    status: "PUBLISHED",
    slug: "river-pressure-test",
    titleZh: "河牌压力测试",
    titleEn: "River pressure test",
    summaryZh: null,
    summaryEn: null,
    publishedAt: "2026-08-20T08:00:00.000Z",
    tournamentId: "77777777-7777-4777-8777-777777777777",
    tournamentName: "Arena Final",
    handNo: 27,
    actionSequence: 19,
    street: "RIVER",
    hero: {
      competitorId: HERO_ID,
      displayName: "DeepSeek V4",
      position: "BTN",
      providerBrand: "deepseek",
    },
    originalDecision: { action: "raise", displayAmountTo: 2_400 },
    targetCount: 4,
    sampleCountPerModel: 10,
    targets: [
      {
        ordinal: 3,
        competitorId: TARGET_C,
        displayName: "Gemini 3 Pro",
        providerBrand: "gemini",
        modelActionTrials: 10,
        fallbackTrials: 0,
        infrastructureErrorTrials: 0,
        actionDistribution: [
          { action: "raise", count: 5, share: 0.5 },
          { action: "call", count: 3, share: 0.3 },
          { action: "fold", count: 2, share: 0.2 },
        ],
      },
      {
        ordinal: 1,
        competitorId: TARGET_A,
        displayName: "Kimi K3",
        providerBrand: "kimi",
        modelActionTrials: 8,
        fallbackTrials: 1,
        infrastructureErrorTrials: 1,
        actionDistribution: [
          { action: "call", count: 5, share: 5 / 8 },
          { action: "raise", count: 3, share: 3 / 8 },
        ],
      },
      {
        ordinal: 4,
        competitorId: TARGET_D,
        displayName: "Grok 4",
        providerBrand: "xai",
        modelActionTrials: 10,
        fallbackTrials: 0,
        infrastructureErrorTrials: 0,
        actionDistribution: [{ action: "raise", count: 10, share: 1 }],
      },
      {
        ordinal: 2,
        competitorId: TARGET_B,
        displayName: "GPT-5.6",
        providerBrand: "chatgpt",
        modelActionTrials: 0,
        fallbackTrials: 6,
        infrastructureErrorTrials: 4,
        actionDistribution: [],
      },
    ],
    relatedPlayerRoles: ["DECISION_MAKER", "COMPARED_MODEL"],
    ...overrides,
  };
}

describe("decision branch discovery model", () => {
  it("uses localized copy, shared action/street formatters, and the canonical public path", () => {
    const model = buildDecisionBranchDiscoveryCardModel(branch(), "zh-CN");
    expect(model).toMatchObject({
      href: "/branches/river-pressure-test",
      title: "河牌压力测试",
      handLabel: "H027",
      streetLabel: "河牌圈",
      originalDecisionLabel: "加注至 2,400",
      sampleLabel: "4 个模型 · 每个 10 次",
    });

    const english = buildDecisionBranchDiscoveryCardModel(branch({
      titleEn: null,
      originalDecision: { action: "all_in", displayAmountTo: 3_200 },
    }), "en");
    expect(english.title).toBe("Hand 027 · Decision branch");
    expect(english.streetLabel).toBe("River");
    expect(english.originalDecisionLabel).toBe("All-in 3,200");
    expect(english.sampleLabel).toBe("4 models · 10 runs each");
  });

  it("aggregates valid model actions across every target and ignores fallback and infrastructure outcomes", () => {
    const result = aggregateDecisionBranchActions(branch().targets, "en");
    expect(result).toEqual([
      { action: "raise", count: 18, share: 18 / 28, label: "Raise", shareLabel: "64%" },
      { action: "call", count: 8, share: 8 / 28, label: "Call", shareLabel: "29%" },
    ]);
  });

  it("breaks equal-count ties with canonical poker-action order", () => {
    const targets = branch({
      targetCount: 1,
      targets: [{
        ordinal: 1,
        competitorId: TARGET_A,
        displayName: "Kimi K3",
        providerBrand: "kimi",
        modelActionTrials: 8,
        fallbackTrials: 1,
        infrastructureErrorTrials: 1,
        actionDistribution: [
          { action: "raise", count: 4, share: 0.5 },
          { action: "call", count: 4, share: 0.5 },
        ],
      }],
    }).targets;
    expect(aggregateDecisionBranchActions(targets, "zh-CN").map((entry) => entry.action))
      .toEqual(["call", "raise"]);
  });

  it("orders and caps target logos while preserving multi-role player context", () => {
    const model = buildDecisionBranchDiscoveryCardModel(branch(), "zh-CN");
    expect(model.visibleTargets.map((target) => target.displayName)).toEqual([
      "Kimi K3",
      "GPT-5.6",
      "Gemini 3 Pro",
    ]);
    expect(model.visibleTargets.map((target) => target.ordinal)).toEqual([1, 2, 3]);
    expect(model.additionalTargetCount).toBe(1);
    expect(model.relatedRoles).toEqual([
      { role: "DECISION_MAKER", label: "原决策选手" },
      { role: "COMPARED_MODEL", label: "复测模型" },
    ]);
  });

  it("returns no misleading split when every sample ended outside model actions", () => {
    const empty = branch({
      targetCount: 1,
      sampleCountPerModel: 10,
      targets: [{
        ordinal: 1,
        competitorId: TARGET_B,
        displayName: "GPT-5.6",
        providerBrand: "chatgpt",
        modelActionTrials: 0,
        fallbackTrials: 4,
        infrastructureErrorTrials: 6,
        actionDistribution: [],
      }],
    });
    expect(buildDecisionBranchDiscoveryCardModel(empty, "en").primarySplit).toEqual([]);
  });
});
