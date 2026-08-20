import { describe, expect, it } from "vitest";
import {
  MOMENT_SOCIAL_CARD_PROJECTION_VERSION,
  parseSocialCardProjection,
  type SuspenseSocialCardProjection,
} from "./moment-social-card.js";

function suspenseProjection(): SuspenseSocialCardProjection {
  return {
    version: MOMENT_SOCIAL_CARD_PROJECTION_VERSION,
    locale: "en",
    tournamentName: "Model Masters",
    handNo: 12,
    title: "A decision at the turn",
    summary: "Play the moment to reveal the result.",
    tagLabel: "Key hand",
    additionalPlayerCount: 3,
    spoilerMode: "SUSPENSE",
    coverStreetLabel: "TURN",
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
}

describe("socialCardProjectionSchema", () => {
  it("accepts the narrow suspense projection", () => {
    expect(parseSocialCardProjection(suspenseProjection())).toEqual(suspenseProjection());
  });

  it.each([
    ["final board", { finalBoard: ["Ts"] }],
    ["winner", { winners: [{ playerId: "player-alpha", displayName: "Alpha", netChange: 4_500 }] }],
    ["net changes", { netChanges: { "player-alpha": 4_500 } }],
  ])("rejects a suspense projection carrying %s", (_label, forbiddenFields) => {
    expect(() => parseSocialCardProjection({
      ...suspenseProjection(),
      ...forbiddenFields,
    })).toThrow();
  });

  it("rejects terminal player state nested inside a suspense player", () => {
    const projection = suspenseProjection();
    expect(() => parseSocialCardProjection({
      ...projection,
      players: [{
        ...projection.players[0],
        endingStack: 12_900,
        netChange: 4_500,
      }],
    })).toThrow();
  });

  it("rejects real hole-card values at the suspense type boundary", () => {
    const projection = suspenseProjection();
    expect(() => parseSocialCardProjection({
      ...projection,
      players: [{
        ...projection.players[0],
        coverHoleCards: ["Ah", "Ad"],
      }],
    })).toThrow();
  });

  it("rejects a river card in the causal suspense cover", () => {
    expect(() => parseSocialCardProjection({
      ...suspenseProjection(),
      coverBoard: ["As", "Kd", "Qc", "Jh", "Ts"],
    })).toThrow();
  });
});
