import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  MOMENT_SOCIAL_CARD_PROJECTION_VERSION,
} from "../dist-server/packages/contracts/src/moment-social-card.js";
import {
  renderMomentSocialCardOffThread,
} from "../dist-server/apps/api/src/tournament/moments/moment-social-card-worker-client.js";

const projection = {
  version: MOMENT_SOCIAL_CARD_PROJECTION_VERSION,
  locale: "en",
  tournamentName: "Worker Smoke",
  handNo: 12,
  title: "The turn changes everything",
  summary: "A deterministic social-card worker smoke test.",
  tagLabel: "Key hand",
  additionalPlayerCount: 0,
  spoilerMode: "SUSPENSE",
  coverStreetLabel: "Turn",
  coverBoard: ["As", "Kd", "Qc", "Jh"],
  coverPotChips: 4_500,
  coverPotBigBlinds: 45,
  players: [{
    playerId: "player-alpha",
    displayName: "Alpha",
    seat: 0,
    providerBrand: "chatgpt",
    position: "BTN",
    coverStack: 8_400,
    coverEquityPercent: 72.4,
    foldedAtCover: false,
    allInAtCover: false,
  }],
};

let eventLoopTicks = 0;
const heartbeat = setInterval(() => { eventLoopTicks += 1; }, 1);
const startedAt = performance.now();
let rendered;
try {
  rendered = await renderMomentSocialCardOffThread(projection);
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
