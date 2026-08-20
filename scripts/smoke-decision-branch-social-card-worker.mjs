import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  DECISION_BRANCH_SOCIAL_CARD_PROJECTION_VERSION,
} from "../dist-server/packages/contracts/src/decision-branch-social-card.js";
import {
  renderDecisionBranchSocialCardOffThread,
} from "../dist-server/apps/api/src/tournament/decision-branches/decision-branch-social-card-worker-client.js";

const projection = {
  version: DECISION_BRANCH_SOCIAL_CARD_PROJECTION_VERSION,
  locale: "en",
  tournamentName: "Worker Smoke",
  handNo: 12,
  street: "TURN",
  title: "Same spot, different models",
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
  originalDecision: { action: "call", displayAmountTo: null },
  sampleCountPerModel: 10,
  targetCount: 1,
  displayedTargets: [{
    ordinal: 1,
    displayName: "Alpha",
    providerBrand: "chatgpt",
    validActionTrials: 10,
    completedTrials: 10,
    fallbackTrials: 0,
    infrastructureErrorTrials: 0,
    pairwiseAgreement: 29 / 45,
    actionDistribution: [
      { action: "fold", count: 2, share: .2 },
      { action: "call", count: 8, share: .8 },
    ],
  }],
  additionalTargetCount: 0,
  completedAt: "2026-08-20T01:02:03.000Z",
};

let eventLoopTicks = 0;
const heartbeat = setInterval(() => { eventLoopTicks += 1; }, 1);
const startedAt = performance.now();
let rendered;
try {
  rendered = await renderDecisionBranchSocialCardOffThread(projection);
} finally {
  clearInterval(heartbeat);
}
const elapsedMs = Math.round(performance.now() - startedAt);

assert.equal(rendered.mimeType, "image/png");
assert.equal(rendered.width, 1_200);
assert.equal(rendered.height, 675);
assert.equal(rendered.png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
assert.ok(rendered.png.length > 10_000, "rendered PNG should contain real image data");
assert.ok(eventLoopTicks > 0, "worker render should not monopolize the API event loop");

process.stdout.write(`${JSON.stringify({
  bytes: rendered.png.length,
  width: rendered.width,
  height: rendered.height,
  elapsedMs,
  eventLoopTicks,
})}\n`);
