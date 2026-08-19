import { describe, expect, it } from "vitest";
import {
  publicMomentDtoSchema,
  type PublicMomentDto,
} from "../../../packages/contracts/src/moments";
import {
  buildMomentStoryCardModel,
  canonicalMomentUrl,
  momentStoryCardFilename,
} from "./moment-story-card-model";
import type { ArenaBroadcast, ArenaPlayer, ArenaState } from "./types";

const MOMENT_ID = "11111111-1111-4111-8111-111111111111";
const TOURNAMENT_ID = "22222222-2222-4222-8222-222222222222";

function player(id: string, seat: number): ArenaPlayer {
  return {
    id,
    displayName: id.toUpperCase(),
    seat,
    stack: seat * 10_000,
    status: "ACTIVE",
    finishingPosition: null,
    folded: false,
    allIn: false,
    streetCommitted: 0,
    totalCommitted: 0,
  };
}

const players = [
  player("alpha", 5),
  player("beta", 1),
  player("gamma", 4),
  player("delta", 0),
  player("epsilon", 3),
];

const state: ArenaState = {
  tournamentId: TOURNAMENT_ID,
  name: "Models Invitational",
  rulesetVersion: "holdem-v1",
  eventClass: "EXHIBITION",
  promptHash: "a".repeat(64),
  status: "COMPLETED",
  completedHands: 12,
  championPlayerId: "alpha",
  seedCommitment: "b".repeat(64),
  seedRevealed: true,
  players,
  hand: null,
};

function moment(overrides: Partial<PublicMomentDto> = {}): PublicMomentDto {
  const facts = {
    id: MOMENT_ID,
    tournamentId: TOURNAMENT_ID,
    handNo: 12,
    startSequence: 100,
    focusSequence: 110,
    endSequence: 120,
    factsVersion: "arena-moment-facts-v1",
    detectorVersion: "arena-moment-detector-v1",
    scoringVersion: "arena-moment-scoring-v1",
    broadcastViewVersion: "spectator-v1",
    equityVersion: "equity-v1",
    source: {
      eventHash: "c".repeat(64),
      eventCount: 21,
      startEventHash: "d".repeat(64),
      endEventHash: "e".repeat(64),
    },
    score: 90,
    scoreBreakdown: {
      potImpact: 20,
      tournamentImpact: 30,
      actionDrama: 16,
      equityDrama: 18,
      rarity: 6,
    },
    recommendationRank: 1,
    primaryTag: "FINAL_HAND",
    tags: ["FINAL_HAND", "ALL_IN"],
    participantPlayerIds: players.map(({ id }) => id),
    featuredPlayerIds: ["alpha", "beta", "gamma", "delta", "epsilon"],
    winnerPlayerIds: ["alpha"],
    eliminatedPlayerIds: ["beta"],
    showdownPlayerIds: ["alpha", "beta"],
    board: ["As", "Kh", "Qd", "Jc", "Ts"],
    bigBlind: 100,
    potChips: 5_000,
    potBigBlinds: 50,
    totalChipShare: 1,
    startingStacks: { alpha: 1_000, beta: 1_000, gamma: 1_000, delta: 1_000, epsilon: 1_000 },
    endingStacks: { alpha: 3_000, beta: 0, gamma: 1_000, delta: 500, epsilon: 500 },
    netChanges: { alpha: 2_000, beta: -1_000, gamma: 0, delta: -500, epsilon: -500 },
    actionCount: 8,
    preflopRaiseCount: 2,
    overbetSequences: [],
    sidePotCount: 0,
    splitPot: false,
    leadChange: true,
    maxDecisionLatencyMs: 2_000,
    winningHandCategories: ["STRAIGHT_FLUSH"],
    actions: [],
    allInLock: null,
    equityTransitions: [],
  };
  return publicMomentDtoSchema.parse({
    id: MOMENT_ID,
    tournamentId: TOURNAMENT_ID,
    handNo: 12,
    status: "PUBLISHED",
    slug: "final-hand-h12",
    titleZh: "河牌前，谁会拿下冠军？",
    titleEn: "Who takes the title on the river?",
    summaryZh: "五个模型同桌的最后悬念。",
    summaryEn: "The last question at a five-model table.",
    coverSequence: 110,
    playbackStartSequence: 100,
    playbackEndSequence: 120,
    spoilerMode: "SUSPENSE",
    isPrimary: true,
    publicationRevision: 2,
    publishedAt: "2026-08-20T00:00:00.000Z",
    primaryTag: "FINAL_HAND",
    tags: ["FINAL_HAND", "ALL_IN"],
    score: 90,
    facts,
    ...overrides,
  });
}

function coverFrame(): ArenaBroadcast {
  return {
    version: "spectator-v1",
    equityVersion: "equity-v1",
    handNo: 12,
    sequence: 110,
    street: "FLOP",
    board: ["As", "Kh", "Qd"],
    pot: 1_500,
    pots: [],
    positions: { button: 5, smallBlind: 0, bigBlind: 1, headsUp: false },
    blinds: { smallBlind: 50, bigBlind: 100, bigBlindAnte: 0 },
    currentActorId: "gamma",
    estimated: true,
    samples: 10_000,
    players: players.map((item, index) => ({
      playerId: item.id,
      seat: item.seat,
      holeCards: index === 0 ? ["Ah", "Ad"] : ["2c", "3c"],
      stack: 800 + index * 100,
      folded: index === 4,
      allIn: index === 1,
      streetCommitted: 100,
      equity: index === 4 ? null : 0.5 - index * 0.05,
      outrightWinProbability: null,
      tieProbability: null,
      lastAction: null,
    })),
  };
}

describe("moment story card model", () => {
  it("keeps suspense cards causal, outcome-free, and limited to three featured seats", () => {
    const model = buildMomentStoryCardModel({
      moment: moment(),
      state,
      coverFrame: coverFrame(),
      playerBrands: { delta: "deepseek", beta: "kimi", epsilon: "gemini" },
      locale: "zh-CN",
    });

    expect(model.size).toEqual({ width: 1_200, height: 675 });
    expect(model.handLabel).toBe("H012");
    expect(model.tagLabel).toBe("关键牌局");
    expect(model.board).toEqual(["As", "Kh", "Qd"]);
    expect(model.potChips).toBe(1_500);
    expect(model.potBigBlinds).toBe(15);
    expect(model.featuredPlayers.map(({ playerId }) => playerId)).toEqual(["delta", "beta", "epsilon"]);
    expect(model.featuredPlayers.map(({ position }) => position)).toEqual(["SB", "BB", null]);
    expect(model.featuredPlayers[0]?.providerBrand).toBe("deepseek");
    expect(model.additionalFeaturedCount).toBe(2);
    expect(model.outcome).toBeNull();

    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain("winnerPlayerIds");
    expect(serialized).not.toContain("netChanges");
    expect(serialized).not.toContain("Jc");
    expect(serialized).not.toContain("Ts");
    expect(serialized).not.toContain("5000");
  });

  it("does not fall back to terminal stacks, board, or pot without a suspense cover", () => {
    const model = buildMomentStoryCardModel({
      moment: moment(),
      state,
      coverFrame: null,
      playerBrands: {},
      locale: "en",
    });

    expect(model.tagLabel).toBe("Key hand");
    expect(model.board).toEqual([]);
    expect(model.potChips).toBeNull();
    expect(model.potBigBlinds).toBeNull();
    expect(model.featuredPlayers.every((item) => (
      item.stack === null && item.holeCards.length === 0 && item.equityPercent === null
    ))).toBe(true);
    expect(model.outcome).toBeNull();
  });

  it("reveals a seat-ordered multi-winner result and cloned net changes", () => {
    const published = moment({
      spoilerMode: "RESULT",
      primaryTag: "SPLIT_POT",
      tags: ["SPLIT_POT", "ALL_IN"],
      facts: {
        ...moment().facts,
        primaryTag: "SPLIT_POT",
        tags: ["SPLIT_POT", "ALL_IN"],
        splitPot: true,
        winnerPlayerIds: ["alpha", "delta", "alpha"],
      },
    });
    const model = buildMomentStoryCardModel({
      moment: published,
      state,
      coverFrame: coverFrame(),
      playerBrands: {},
      locale: "en",
    });

    expect(model.tagLabel).toBe("Split pot");
    expect(model.board).toEqual(["As", "Kh", "Qd", "Jc", "Ts"]);
    expect(model.potChips).toBe(5_000);
    expect(model.potBigBlinds).toBe(50);
    expect(model.outcome?.winners).toEqual([
      { playerId: "delta", displayName: "DELTA" },
      { playerId: "alpha", displayName: "ALPHA" },
    ]);
    expect(model.outcome?.netChanges).toEqual(published.facts.netChanges);
    expect(model.outcome?.netChanges).not.toBe(published.facts.netChanges);
    expect(model.featuredPlayers.find(({ playerId }) => playerId === "delta")?.stack).toBe(500);
  });

  it("builds stable canonical links and rejects unsafe origins or slugs", () => {
    expect(canonicalMomentUrl("https://arena.example/app?from=admin", "final-hand-h12"))
      .toBe("https://arena.example/moments/final-hand-h12");
    expect(() => canonicalMomentUrl("file:///tmp/index.html", "final-hand-h12"))
      .toThrow(/HTTP\(S\)/);
    expect(() => canonicalMomentUrl("https://arena.example", "../admin"))
      .toThrow(/slug/i);
  });

  it("produces an ASCII filename without path separators", () => {
    expect(momentStoryCardFilename({ handNo: 12, slug: "final-hand-h12" }))
      .toBe("arena-h012-final-hand-h12.png");
    expect(momentStoryCardFilename({ handNo: -1, slug: " ../../河牌 决胜!! " }))
      .toBe("arena-h000-moment.png");
  });
});
