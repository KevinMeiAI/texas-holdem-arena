import { describe, expect, it } from "vitest";
import {
  DECISION_BRANCH_SOCIAL_CARD_PROJECTION_VERSION,
  DECISION_BRANCH_SOCIAL_CARD_RENDERER_VERSION,
  type DecisionBranchSocialCardProjection,
} from "../../../../../packages/contracts/src/decision-branch-social-card.js";
import { renderDecisionBranchSocialCardOffThread } from "./decision-branch-social-card-worker-client.js";

const fixtureWorker = new URL(
  "./test-fixtures/decision-branch-social-card-worker-protocol.mjs",
  import.meta.url,
);

function projection(title = "Worker fixture"): DecisionBranchSocialCardProjection {
  return {
    version: DECISION_BRANCH_SOCIAL_CARD_PROJECTION_VERSION,
    locale: "en",
    tournamentName: "Model Masters",
    handNo: 7,
    street: "FLOP",
    title,
    hero: {
      displayName: "Source Model",
      position: "BTN",
      holeCards: ["As", "Kd"],
      stackChips: 4_000,
      stackBigBlinds: 40,
    },
    board: ["Qc", "Jh", "7s"],
    potBeforeActionChips: 900,
    potBeforeActionBigBlinds: 9,
    callAmountChips: 0,
    callAmountBigBlinds: 0,
    originalDecision: { action: "check", displayAmountTo: null },
    sampleCountPerModel: 1,
    targetCount: 1,
    displayedTargets: [{
      ordinal: 1,
      displayName: "Kimi K3",
      providerBrand: "kimi",
      validActionTrials: 1,
      completedTrials: 1,
      fallbackTrials: 0,
      infrastructureErrorTrials: 0,
      pairwiseAgreement: null,
      actionDistribution: [{ action: "check", count: 1, share: 1 }],
    }],
    additionalTargetCount: 0,
    completedAt: "2026-08-20T01:02:03.000Z",
  };
}

describe("Decision Branch social card worker client", () => {
  it("accepts only the expected successful worker protocol", async () => {
    const rendered = await renderDecisionBranchSocialCardOffThread(
      projection(),
      1_000,
      fixtureWorker,
    );
    expect(rendered).toMatchObject({
      rendererVersion: DECISION_BRANCH_SOCIAL_CARD_RENDERER_VERSION,
      mimeType: "image/png",
      width: 1_200,
      height: 675,
      projectionHash: "a".repeat(64),
      pngSha256: "b".repeat(64),
      textFallbackApplied: false,
    });
    expect(rendered.png).toBeInstanceOf(Buffer);
    expect(rendered.png.toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("surfaces a renderer failure without waiting for the timeout", async () => {
    await expect(renderDecisionBranchSocialCardOffThread(
      projection("FIXTURE ERROR"),
      1_000,
      fixtureWorker,
    )).rejects.toThrow("fixture renderer failed");
  });

  it("rejects malformed success messages", async () => {
    await expect(renderDecisionBranchSocialCardOffThread(
      projection("FIXTURE INVALID"),
      1_000,
      fixtureWorker,
    )).rejects.toThrow("returned an invalid response");
  });

  it("terminates a hung worker at the bounded timeout", async () => {
    const startedAt = Date.now();
    await expect(renderDecisionBranchSocialCardOffThread(
      projection("FIXTURE HANG"),
      40,
      fixtureWorker,
    )).rejects.toThrow("timed out after 40ms");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
