import { describe, expect, it } from "vitest";
import {
  DECISION_BRANCH_SOCIAL_CARD_PROJECTION_VERSION,
  DECISION_BRANCH_SOCIAL_CARD_RENDERER_VERSION,
  type DecisionBranchSocialCardProjection,
} from "../../../../../packages/contracts/src/decision-branch-social-card.js";
import {
  renderDecisionBranchSocialCard,
  renderDecisionBranchSocialCardSvg,
} from "./decision-branch-social-card-renderer.js";

function projection(): DecisionBranchSocialCardProjection {
  return {
    version: DECISION_BRANCH_SOCIAL_CARD_PROJECTION_VERSION,
    locale: "en",
    tournamentName: "Model Masters",
    handNo: 12,
    street: "TURN",
    title: "One spot, four different model instincts",
    hero: {
      displayName: "Source Model",
      position: "BTN",
      holeCards: ["As", "Kd"],
      stackChips: 8_400,
      stackBigBlinds: 84,
    },
    board: ["Qc", "Jh", "7s", "2d"],
    potBeforeActionChips: 4_500,
    potBeforeActionBigBlinds: 45,
    callAmountChips: 900,
    callAmountBigBlinds: 9,
    originalDecision: { action: "raise", displayAmountTo: 2_400 },
    sampleCountPerModel: 10,
    targetCount: 6,
    displayedTargets: [
      {
        ordinal: 1,
        displayName: "Kimi K3",
        providerBrand: "kimi",
        validActionTrials: 8,
        completedTrials: 10,
        fallbackTrials: 1,
        infrastructureErrorTrials: 1,
        pairwiseAgreement: 3 / 7,
        actionDistribution: [
          { action: "call", count: 4, share: .5 },
          { action: "raise", count: 4, share: .5 },
        ],
      },
      {
        ordinal: 2,
        displayName: "Model Without Valid Output",
        providerBrand: "xai",
        validActionTrials: 0,
        completedTrials: 10,
        fallbackTrials: 7,
        infrastructureErrorTrials: 3,
        pairwiseAgreement: null,
        actionDistribution: [],
      },
      {
        ordinal: 3,
        displayName: "DeepSeek",
        providerBrand: "deepseek",
        validActionTrials: 10,
        completedTrials: 10,
        fallbackTrials: 0,
        infrastructureErrorTrials: 0,
        pairwiseAgreement: 1,
        actionDistribution: [{ action: "fold", count: 10, share: 1 }],
      },
      {
        ordinal: 4,
        displayName: "Gemini",
        providerBrand: "gemini",
        validActionTrials: 10,
        completedTrials: 10,
        fallbackTrials: 0,
        infrastructureErrorTrials: 0,
        pairwiseAgreement: 2 / 9,
        actionDistribution: [
          { action: "check", count: 1, share: .1 },
          { action: "call", count: 2, share: .2 },
          { action: "bet", count: 1, share: .1 },
          { action: "raise", count: 2, share: .2 },
          { action: "all_in", count: 4, share: .4 },
        ],
      },
    ],
    additionalTargetCount: 2,
    completedAt: "2026-08-20T01:02:03.000Z",
  };
}

function expectPngDimensions(png: Buffer, width: number, height: number): void {
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
  expect(png.readUInt32BE(16)).toBe(width);
  expect(png.readUInt32BE(20)).toBe(height);
}

describe("Decision Branch social card renderer", () => {
  it("renders a deterministic 1200 by 675 PNG", () => {
    const rendered = Array.from({ length: 3 }, () => renderDecisionBranchSocialCard(projection()));
    const first = rendered[0];
    if (!first) throw new Error("Expected a rendered card");

    expect(first.rendererVersion).toBe(DECISION_BRANCH_SOCIAL_CARD_RENDERER_VERSION);
    expect(first.mimeType).toBe("image/png");
    expect(first.width).toBe(1_200);
    expect(first.height).toBe(675);
    expect(first.png.length).toBeGreaterThan(10_000);
    expectPngDimensions(first.png, 1_200, 675);
    expect(new Set(rendered.map((entry) => entry.projectionHash)).size).toBe(1);
    expect(new Set(rendered.map((entry) => entry.pngSha256)).size).toBe(1);
    expect(rendered.every((entry) => entry.png.equals(first.png))).toBe(true);
  });

  it("keeps tied modal actions, zero-action outcomes, fallback, and API errors distinct", () => {
    const svg = renderDecisionBranchSocialCardSvg(projection());
    expect(svg).toMatch(/data-target-ordinal="1"[^>]*data-valid-action-trials="8"[^>]*data-modal-actions="call,raise"[^>]*data-fallback-trials="1"[^>]*data-infrastructure-error-trials="1"/);
    expect(svg).toMatch(/data-target-ordinal="2"[^>]*data-valid-action-trials="0"[^>]*data-zero-valid-actions="true"[^>]*data-modal-actions=""[^>]*data-fallback-trials="7"[^>]*data-infrastructure-error-trials="3"/);
    expect(svg).toMatch(/data-target-ordinal="3"[^>]*data-valid-action-trials="10"[^>]*data-modal-actions="fold"[^>]*data-fallback-trials="0"[^>]*data-infrastructure-error-trials="0"/);
    expect(svg).toMatch(/data-target-ordinal="4"[^>]*data-valid-action-trials="10"[^>]*data-modal-actions="all_in"[^>]*data-fallback-trials="0"[^>]*data-infrastructure-error-trials="0"/);
    expect(svg.match(/data-target-ordinal=/g)).toHaveLength(4);
    expect(svg).toContain('data-additional-target-count="2"');
    expect(svg).toContain('data-methodology="decision-only" data-continuation-simulated="false"');
    expect(svg.match(/data-action-grid="distribution"/g)).toHaveLength(3);
    expect(svg.match(/data-action-grid="empty"/g)).toHaveLength(1);
    expect(svg.match(/data-action=/g)).toHaveLength(18);
    expect(svg).toContain('data-action="call" data-count="4" data-share="0.5" data-modal-action="true"');
    expect(svg).toContain('data-action="raise" data-count="4" data-share="0.5" data-modal-action="true"');
  });

  it("contains no host-font, remote-image, live-text, or network dependency", () => {
    const svg = renderDecisionBranchSocialCardSvg(projection());
    expect(svg).not.toMatch(/<text\b/i);
    expect(svg).not.toMatch(/<image\b/i);
    expect(svg).not.toMatch(/font-family|@font-face|xlink:href|\shref=/i);
  });

  it("uses the same English-safe visual grammar for the Chinese URL locale", () => {
    const english = renderDecisionBranchSocialCardSvg(projection());
    const chineseLocale = renderDecisionBranchSocialCardSvg({ ...projection(), locale: "zh-CN" });
    expect(chineseLocale).toBe(english);
    expect(chineseLocale).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("degrades long or markup-like model names deterministically without dropping the model", () => {
    const input: DecisionBranchSocialCardProjection = {
      ...projection(),
      displayedTargets: projection().displayedTargets.map((target, index) => index === 0 ? {
        ...target,
        displayName: "Model </title><script>alert(1)</script> With An Extremely Long Public Display Name",
      } : target),
    };
    const first = renderDecisionBranchSocialCard(input);
    const second = renderDecisionBranchSocialCard(input);
    const svg = renderDecisionBranchSocialCardSvg(input);
    expect(first.textFallbackApplied).toBe(true);
    expect(first.pngSha256).toBe(second.pngSha256);
    expect(svg).toContain('data-target-ordinal="1"');
    const labelBudgets = [...svg.matchAll(/data-model-label-length="(\d+)" data-model-label-budget="(\d+)"/g)];
    expect(labelBudgets).toHaveLength(4);
    expect(labelBudgets.every((match) => Number(match[1]) <= Number(match[2]))).toBe(true);
    expect(labelBudgets[0]?.slice(1)).toEqual(["17", "17"]);
    expect(svg).not.toMatch(/<script|<\/title|EXTREMELY LONG PUBLIC DISPLAY NAME/i);
  });

  it("rejects projections outside the strict public contract", () => {
    expect(() => renderDecisionBranchSocialCard({
      ...projection(),
      privatePrompt: "must never render",
    })).toThrow();
  });
});
