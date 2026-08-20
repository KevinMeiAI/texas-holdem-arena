import { describe, expect, it } from "vitest";
import type { HandForkLegalActions } from "../../../packages/contracts/src/hand-forks";
import {
  buildDecisionBranchActionMatrix,
  decisionBranchActionLabel,
  decisionBranchActionWithAmountLabel,
  decisionBranchForcedBetLabel,
  decisionBranchLegalActionPresentations,
  decisionBranchModalActions,
  localizedDecisionBranchCopy,
  type DecisionBranchActionMatrixTargetInput,
} from "./decision-branch-page-model";

const COMPETITOR_A = "11111111-1111-4111-8111-111111111111";
const COMPETITOR_B = "22222222-2222-4222-8222-222222222222";

function target(
  overrides: Partial<DecisionBranchActionMatrixTargetInput> = {},
): DecisionBranchActionMatrixTargetInput {
  return {
    ordinal: 1,
    competitorId: COMPETITOR_A,
    displayName: "Kimi K3",
    modelId: "kimi-k3",
    providerBrand: "kimi",
    requestedSamples: 10,
    completedTrials: 10,
    modelActionTrials: 8,
    fallbackTrials: 1,
    infrastructureErrorTrials: 1,
    pairwiseAgreement: 19 / 28,
    actionDistribution: [
      { action: "call", count: 3, share: 3 / 8 },
      { action: "raise", count: 3, share: 3 / 8 },
      { action: "all_in", count: 2, share: 2 / 8 },
    ],
    ...overrides,
  };
}

function legalActions(): HandForkLegalActions {
  return {
    allowed: ["fold", "call", "raise", "all_in"],
    call: { amount: 240, will_be_all_in: true },
    bet: null,
    raise: { min_amount_to: 600, max_amount_to: 2_400 },
    all_in: { resulting_street_commitment: 2_400, classification: "short_raise" },
  };
}

describe("decision branch page model", () => {
  it("selects only the requested language and uses a localized factual fallback", () => {
    const branch = {
      titleZh: "河牌英雄跟注",
      titleEn: "River hero call",
      summaryZh: "同一决策点的重复测试。",
      summaryEn: "Repeated tests at the same decision.",
      snapshot: { source: { handNo: 7 } },
    };
    expect(localizedDecisionBranchCopy(branch, "zh-CN")).toEqual({
      title: "河牌英雄跟注",
      summary: "同一决策点的重复测试。",
    });
    expect(localizedDecisionBranchCopy(branch, "en")).toEqual({
      title: "River hero call",
      summary: "Repeated tests at the same decision.",
    });

    expect(localizedDecisionBranchCopy({
      ...branch,
      titleEn: null,
      summaryEn: null,
    }, "en")).toEqual({
      title: "Hand 007 · Decision branch",
      summary: null,
    });
    expect(localizedDecisionBranchCopy({
      ...branch,
      titleZh: "   ",
      summaryZh: null,
    }, "zh-CN")).toEqual({
      title: "第 007 手 · 决策分叉",
      summary: null,
    });
  });

  it("provides complete bilingual action and amount-to labels", () => {
    expect(["fold", "check", "call", "bet", "raise", "all_in"].map((action) => (
      decisionBranchActionLabel(action as Parameters<typeof decisionBranchActionLabel>[0], "zh-CN")
    ))).toEqual(["弃牌", "过牌", "跟注", "下注", "加注", "全下"]);
    expect(["fold", "check", "call", "bet", "raise", "all_in"].map((action) => (
      decisionBranchActionLabel(action as Parameters<typeof decisionBranchActionLabel>[0], "en")
    ))).toEqual(["Fold", "Check", "Call", "Bet", "Raise", "All-in"]);
    expect(decisionBranchActionWithAmountLabel("raise", 1_250, "zh-CN")).toBe("加注至 1,250");
    expect(decisionBranchActionWithAmountLabel("bet", 1_250, "en")).toBe("Bet to 1,250");
    expect(decisionBranchActionWithAmountLabel("call", null, "en")).toBe("Call");
    expect(decisionBranchActionWithAmountLabel("all_in", null, "zh-CN", 2_400)).toBe("全下 2,400");
    expect(decisionBranchActionWithAmountLabel("all_in", null, "en", 2_400)).toBe("All-in 2,400");
    expect(decisionBranchActionWithAmountLabel("all_in", null, "en")).toBe("All-in");
  });

  it("localizes known forced bets without exposing internal enum labels", () => {
    expect(decisionBranchForcedBetLabel("SMALL_BLIND", "zh-CN")).toBe("小盲");
    expect(decisionBranchForcedBetLabel("big_blind", "en")).toBe("Big blind");
    expect(decisionBranchForcedBetLabel("BIG_BLIND_ANTE", "zh-CN")).toBe("大盲前注");
    expect(decisionBranchForcedBetLabel("ANTE", "en")).toBe("Ante");
    expect(decisionBranchForcedBetLabel("CUSTOM", "en")).toBe("CUSTOM");
    expect(decisionBranchForcedBetLabel(null, "zh-CN")).toBe("强制下注");
  });

  it("projects legal-action amounts and all-in classifications without losing semantics", () => {
    expect(decisionBranchLegalActionPresentations(legalActions(), "zh-CN")).toEqual([
      { action: "fold", label: "弃牌", detail: null, qualifier: null, text: "弃牌" },
      { action: "call", label: "跟注", detail: "240", qualifier: "全下", text: "跟注 240 · 全下" },
      { action: "raise", label: "加注", detail: "600–2,400", qualifier: null, text: "加注至 600–2,400" },
      { action: "all_in", label: "全下", detail: "2,400", qualifier: "短加注", text: "全下 2,400（短加注）" },
    ]);
    expect(decisionBranchLegalActionPresentations(legalActions(), "en").map((item) => item.text)).toEqual([
      "Fold",
      "Call 240 · all-in",
      "Raise to 600–2,400",
      "All-in 2,400 (short raise)",
    ]);
  });

  it("returns every tied modal action in canonical poker-action order", () => {
    expect(decisionBranchModalActions([
      { action: "raise", count: 4 },
      { action: "call", count: 4 },
      { action: "fold", count: 2 },
    ])).toEqual(["call", "raise"]);
    expect(decisionBranchModalActions([])).toEqual([]);
  });

  it("builds a stable matrix and keeps action and terminal-outcome denominators separate", () => {
    const matrix = buildDecisionBranchActionMatrix({
      source: {
        legalActions: { allowed: ["fold", "call", "raise", "all_in"] },
        originalDecision: { action: "raise", amountTo: 600, usedFallback: false },
      },
      targets: [
        target({ ordinal: 2, competitorId: COMPETITOR_B, displayName: "DeepSeek", providerBrand: "deepseek" }),
        target(),
      ],
    });

    expect(matrix.columns).toEqual([
      { action: "fold", legal: true, original: false, observed: false },
      { action: "call", legal: true, original: false, observed: true },
      { action: "raise", legal: true, original: true, observed: true },
      { action: "all_in", legal: true, original: false, observed: true },
    ]);
    expect(matrix.original).toEqual({ action: "raise", amountTo: 600, usedFallback: false });
    expect(matrix.rows.map((row) => row.ordinal)).toEqual([1, 2]);
    expect(matrix.rows[0]?.modalActions).toEqual(["call", "raise"]);
    expect(matrix.rows[0]?.cells).toEqual([
      { action: "fold", count: 0, share: 0, isModal: false },
      { action: "call", count: 3, share: 3 / 8, isModal: true },
      { action: "raise", count: 3, share: 3 / 8, isModal: true },
      { action: "all_in", count: 2, share: 2 / 8, isModal: false },
    ]);
    expect(matrix.rows[0]?.denominators).toEqual({
      actionDistribution: 8,
      terminalOutcomes: 10,
      requested: 10,
    });
    expect(matrix.rows[0]?.fallbackShare).toBe(0.1);
    expect(matrix.rows[0]?.infrastructureErrorShare).toBe(0.1);
  });

  it("uses null shares instead of a misleading zero percent when no model action completed", () => {
    const matrix = buildDecisionBranchActionMatrix({
      source: {
        legalActions: { allowed: ["check", "bet"] },
        originalDecision: { action: "check", amountTo: null, usedFallback: false },
      },
      targets: [target({
        completedTrials: 10,
        modelActionTrials: 0,
        fallbackTrials: 7,
        infrastructureErrorTrials: 3,
        actionDistribution: [],
        pairwiseAgreement: null,
      })],
    });
    expect(matrix.rows[0]?.cells.map((cell) => cell.share)).toEqual([null, null]);
    expect(matrix.rows[0]?.modalActions).toEqual([]);
    expect(matrix.rows[0]?.fallbackShare).toBe(0.7);
    expect(matrix.rows[0]?.infrastructureErrorShare).toBe(0.3);
  });

  it("includes an observed action outside the declared legal set so evidence is never hidden", () => {
    const matrix = buildDecisionBranchActionMatrix({
      source: {
        legalActions: { allowed: ["check", "bet"] },
        originalDecision: { action: "check", amountTo: null, usedFallback: false },
      },
      targets: [target({
        modelActionTrials: 1,
        completedTrials: 1,
        requestedSamples: 1,
        fallbackTrials: 0,
        infrastructureErrorTrials: 0,
        actionDistribution: [{ action: "raise", count: 1, share: 1 }],
      })],
    });
    expect(matrix.columns.map((column) => column.action)).toEqual(["check", "bet", "raise"]);
    expect(matrix.columns.at(-1)).toEqual({ action: "raise", legal: false, original: false, observed: true });
  });
});
