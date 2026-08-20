import { describe, expect, it } from "vitest";
import type { PublicMomentDto } from "../../../../../packages/contracts/src/moments.js";
import type { PublicTournamentIdentityContext } from "../arena-service.js";
import { buildSocialCardProjection } from "./moment-social-card-projection.js";

function moment(spoilerMode: "SUSPENSE" | "RESULT"): PublicMomentDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tournamentId: "22222222-2222-4222-8222-222222222222",
    handNo: 12,
    status: "PUBLISHED",
    slug: "river-turnaround",
    titleZh: "河牌逆转",
    titleEn: "River turnaround",
    summaryZh: "谁能拿下这个关键底池？",
    summaryEn: "Who takes down this defining pot?",
    coverSequence: 10,
    playbackStartSequence: 8,
    playbackEndSequence: 18,
    spoilerMode,
    isPrimary: true,
    publicationRevision: 3,
    publishedAt: "2026-08-20T01:02:03.000Z",
    primaryTag: "EQUITY_REVERSAL",
    tags: ["EQUITY_REVERSAL"],
    score: 88,
    facts: {
      id: "11111111-1111-4111-8111-111111111111",
      tournamentId: "22222222-2222-4222-8222-222222222222",
      handNo: 12,
      startSequence: 8,
      focusSequence: 10,
      endSequence: 18,
      factsVersion: "arena-moment-facts-v1",
      detectorVersion: "arena-moment-detector-v2",
      scoringVersion: "arena-moment-scoring-v1",
      broadcastViewVersion: "arena-broadcast-view-v1",
      equityVersion: "arena-broadcast-equity-v1",
      source: {
        eventHash: "a".repeat(64),
        eventCount: 11,
        startEventHash: "b".repeat(64),
        endEventHash: "c".repeat(64),
      },
      score: 88,
      scoreBreakdown: { potImpact: 20, tournamentImpact: 25, actionDrama: 15, equityDrama: 20, rarity: 8 },
      recommendationRank: 1,
      primaryTag: "EQUITY_REVERSAL",
      tags: ["EQUITY_REVERSAL"],
      participantPlayerIds: ["p1", "p2"],
      featuredPlayerIds: ["p1", "p2"],
      winnerPlayerIds: ["p2"],
      eliminatedPlayerIds: ["p1"],
      showdownPlayerIds: ["p1", "p2"],
      board: ["As", "Kd", "Qc", "Jh", "Ts"],
      bigBlind: 100,
      potChips: 6_666,
      potBigBlinds: 66.66,
      totalChipShare: 0.4,
      startingStacks: { p1: 1_200, p2: 1_200 },
      endingStacks: { p1: 0, p2: 7_777 },
      netChanges: { p1: -1_200, p2: 6_666 },
      actionCount: 2,
      preflopRaiseCount: 1,
      overbetSequences: [],
      sidePotCount: 0,
      splitPot: false,
      leadChange: true,
      maxDecisionLatencyMs: 1_200,
      winningHandCategories: [],
      actions: [],
      allInLock: null,
      equityTransitions: [],
    },
  };
}

function identity(): PublicTournamentIdentityContext {
  return {
    tournament: { id: "22222222-2222-4222-8222-222222222222", name: "Model Masters" },
    players: [
      { id: "spectator", displayName: "Not in this hand", seat: 0, competitorId: null, providerBrand: "gemini" },
      { id: "p1", displayName: "Alpha", seat: 3, competitorId: null, providerBrand: "chatgpt" },
      { id: "p2", displayName: "Beta", seat: 5, competitorId: null, providerBrand: "claude" },
    ],
  };
}

describe("buildSocialCardProjection", () => {
  it("projects an English-first neutral suspense card without rebuilding replay state", () => {
    const projection = buildSocialCardProjection({
      moment: moment("SUSPENSE"),
      identity: identity(),
      locale: "zh-CN",
    });
    expect(projection.spoilerMode).toBe("SUSPENSE");
    if (projection.spoilerMode !== "SUSPENSE") throw new Error("Expected suspense projection");
    expect(projection.title).toBe("River turnaround");
    expect(projection.summary).toBe("Who takes down this defining pot?");
    expect(projection.coverBoard).toEqual([]);
    expect(projection.coverPotChips).toBeNull();
    expect(projection.tagLabel).toBe("Key hand");
    expect(projection.players.map((player) => player.playerId)).toEqual(["p1", "p2"]);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("finalBoard");
    expect(serialized).not.toContain("winners");
    expect(serialized).not.toContain("endingStack");
    expect(serialized).not.toContain("netChange");
    expect(serialized).not.toContain("7,777");
    expect(serialized).not.toContain("6666");
    expect(serialized).not.toContain('"Ts"');
  });

  it("uses an English generic title when only Chinese editorial copy exists", () => {
    const suspense = moment("SUSPENSE");
    suspense.titleEn = null;
    suspense.summaryEn = null;
    const projection = buildSocialCardProjection({
      moment: suspense,
      identity: identity(),
      locale: "zh-CN",
    });
    if (projection.spoilerMode !== "SUSPENSE") throw new Error("Expected suspense projection");
    expect(projection.title).toBe("Hand 12 · Key hand");
    expect(projection.summary).toBeNull();
  });

  it("features recent causal actors without using winner order", () => {
    const suspense = moment("SUSPENSE");
    suspense.facts.participantPlayerIds = ["p1", "p2", "p3", "p4"];
    suspense.facts.actions = [
      { sequence: 9, street: "TURN", playerId: "p3", action: "CHECK", classification: "CHECK", paid: 0, amountTo: 0 },
      { sequence: 10, street: "TURN", playerId: "p4", action: "BET", classification: "BET", paid: 400, amountTo: 400 },
    ];
    const identities = identity();
    identities.players.push(
      { id: "p3", displayName: "Gamma", seat: 1, competitorId: null, providerBrand: "gemini" },
      { id: "p4", displayName: "Delta", seat: 7, competitorId: null, providerBrand: "deepseek" },
    );
    const projection = buildSocialCardProjection({
      moment: suspense,
      identity: identities,
      locale: "en",
    });
    if (projection.spoilerMode !== "SUSPENSE") throw new Error("Expected suspense projection");
    expect(projection.coverStreetLabel).toBe("Turn");
    expect(projection.coverBoard).toEqual(["As", "Kd", "Qc", "Jh"]);
    expect(projection.players.map((player) => player.playerId)).toEqual(["p3", "p1", "p4"]);
    expect(projection.players.map((player) => player.playerId)).not.toContain("p2");
  });

  it("includes final outcome fields only for result cards", () => {
    const projection = buildSocialCardProjection({
      moment: moment("RESULT"),
      identity: identity(),
      locale: "en",
    });
    expect(projection.spoilerMode).toBe("RESULT");
    if (projection.spoilerMode !== "RESULT") throw new Error("Expected result projection");
    expect(projection.finalBoard).toEqual(["As", "Kd", "Qc", "Jh", "Ts"]);
    expect(projection.finalPotChips).toBe(6_666);
    expect(projection.winners).toEqual([{ playerId: "p2", displayName: "Beta", netChange: 6_666 }]);
  });
});
