import { describe, expect, it } from "vitest";
import {
  publicMomentDtoSchema,
  type MomentTag,
  type PublicMomentDto,
} from "../../../packages/contracts/src/moments";
import {
  localizedMomentCopy,
  momentCanonicalUrl,
  momentOutcomeProjection,
  momentPublicPlayerIds,
  momentPublicFactsProjection,
  momentReplayData,
  momentReplayKey,
  momentTagLabel,
  publicMomentTagLabel,
  sortMomentPlayersBySeat,
} from "./moment-presentation";
import type { ArenaBroadcast, ArenaEvent, ArenaPlayer } from "./types";

const MOMENT_ID = "11111111-1111-4111-8111-111111111111";
const TOURNAMENT_ID = "22222222-2222-4222-8222-222222222222";

const TAG_CASES: readonly [MomentTag, string, string][] = [
  ["FINAL_HAND", "决胜手", "Final hand"],
  ["ELIMINATION", "淘汰", "Elimination"],
  ["MULTI_ELIMINATION", "一手多淘汰", "Multi-elimination"],
  ["HEADS_UP_REACHED", "进入单挑", "Heads-up reached"],
  ["ALL_IN", "全下", "All-in"],
  ["MULTIWAY_ALL_IN", "多人全下", "Multiway all-in"],
  ["LARGE_POT", "大底池", "Large pot"],
  ["LEAD_CHANGE", "领先易主", "Lead change"],
  ["SHORT_STACK_DOUBLE", "短码翻倍", "Short-stack double"],
  ["FOUR_BET_PLUS", "四次加注+", "Four-bet+"],
  ["OVERBET", "超池下注", "Overbet"],
  ["SIDE_POT", "边池", "Side pot"],
  ["SPLIT_POT", "平分底池", "Split pot"],
  ["MULTIWAY_SHOWDOWN", "多人摊牌", "Multiway showdown"],
  ["EQUITY_REVERSAL", "胜率反转", "Equity reversal"],
  ["ALL_IN_UNDERDOG_WIN", "全下爆冷", "All-in upset"],
  ["RARE_MADE_HAND", "稀有成牌", "Rare made hand"],
  ["LONG_TANK", "长考", "Long tank"],
];

function moment(overrides: Partial<PublicMomentDto> = {}): PublicMomentDto {
  const facts = {
    id: MOMENT_ID,
    tournamentId: TOURNAMENT_ID,
    handNo: 7,
    startSequence: 100,
    focusSequence: 110,
    endSequence: 120,
    factsVersion: "arena-moment-facts-v1",
    detectorVersion: "arena-moment-detector-v1",
    scoringVersion: "arena-moment-scoring-v1",
    broadcastViewVersion: "spectator-v1",
    equityVersion: "equity-v1",
    source: {
      eventHash: "a".repeat(64),
      eventCount: 21,
      startEventHash: "b".repeat(64),
      endEventHash: "c".repeat(64),
    },
    score: 82,
    scoreBreakdown: {
      potImpact: 18,
      tournamentImpact: 24,
      actionDrama: 14,
      equityDrama: 18,
      rarity: 8,
    },
    recommendationRank: 1,
    primaryTag: "FINAL_HAND",
    tags: ["FINAL_HAND", "ALL_IN"],
    participantPlayerIds: ["alpha", "beta"],
    featuredPlayerIds: ["alpha", "beta"],
    winnerPlayerIds: ["alpha"],
    eliminatedPlayerIds: ["beta"],
    showdownPlayerIds: ["alpha", "beta"],
    board: ["As", "Kh", "Qd", "Jc", "Ts"],
    bigBlind: 100,
    potChips: 2_400,
    potBigBlinds: 24,
    totalChipShare: 1,
    startingStacks: { alpha: 1_200, beta: 1_200 },
    endingStacks: { alpha: 2_400, beta: 0 },
    netChanges: { alpha: 1_200, beta: -1_200 },
    actionCount: 2,
    preflopRaiseCount: 1,
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
    handNo: 7,
    status: "PUBLISHED",
    slug: "final-hand",
    titleZh: "最后一手",
    titleEn: "The final hand",
    summaryZh: "短码全下后完成逆转。",
    summaryEn: "The short stack turns it around.",
    coverSequence: 110,
    playbackStartSequence: 100,
    playbackEndSequence: 120,
    spoilerMode: "SUSPENSE",
    isPrimary: true,
    publicationRevision: 3,
    publishedAt: "2026-08-20T00:00:00.000Z",
    primaryTag: "FINAL_HAND",
    tags: ["FINAL_HAND", "ALL_IN"],
    score: 82,
    facts,
    ...overrides,
  });
}

function player(id: string, seat: number): ArenaPlayer {
  return {
    id,
    displayName: id.toUpperCase(),
    seat,
    stack: 1_000,
    status: "ACTIVE",
    finishingPosition: null,
    folded: false,
    allIn: false,
    streetCommitted: 0,
    totalCommitted: 0,
  };
}

function frame(sequence: number): ArenaBroadcast {
  return {
    version: "test",
    equityVersion: "test",
    handNo: 7,
    sequence,
    street: "PREFLOP",
    board: [],
    pot: 150,
    pots: [],
    positions: null,
    blinds: null,
    currentActorId: null,
    estimated: false,
    samples: 1,
    players: [],
  };
}

function event(sequence: number): ArenaEvent {
  return {
    tournamentId: TOURNAMENT_ID,
    sequence,
    aggregateVersion: sequence,
    type: "ACTION_APPLIED",
    actorId: "alpha",
    handNo: 7,
    publicPayload: { command: { action: "call" } },
    eventHash: String(sequence).padStart(64, "0"),
    createdAt: "2026-08-20T00:00:00.000Z",
  };
}

describe("moment presentation", () => {
  it("provides complete bilingual labels for every registered tag", () => {
    expect(TAG_CASES).toHaveLength(18);
    for (const [tag, zh, en] of TAG_CASES) {
      expect(momentTagLabel(tag, "zh-CN")).toBe(zh);
      expect(momentTagLabel(tag, "en")).toBe(en);
    }
  });

  it("uses only the requested language and falls back to a localized factual title", () => {
    const published = moment();
    expect(localizedMomentCopy(published, "zh-CN")).toEqual({
      title: "最后一手",
      summary: "短码全下后完成逆转。",
    });
    expect(localizedMomentCopy(published, "en")).toEqual({
      title: "The final hand",
      summary: "The short stack turns it around.",
    });

    const alternateOnly = moment({ titleEn: null, summaryEn: null });
    expect(localizedMomentCopy(alternateOnly, "en")).toEqual({
      title: "Hand 007 · Key hand",
      summary: null,
    });

    const factualFallback = moment({
      titleZh: null,
      titleEn: null,
      summaryZh: null,
      summaryEn: null,
    });
    expect(localizedMomentCopy(factualFallback, "zh-CN")).toEqual({
      title: "第 007 手 · 关键牌局",
      summary: null,
    });
    expect(localizedMomentCopy(factualFallback, "en").title).toBe("Hand 007 · Key hand");
  });

  it("returns selected players in table-seat order without duplicates or unknown ids", () => {
    const players = [player("alpha", 4), player("beta", 1), player("gamma", 7)];
    expect(sortMomentPlayersBySeat(["gamma", "missing", "alpha", "gamma", "beta"], players)
      .map((item) => item.id)).toEqual(["beta", "alpha", "gamma"]);
    expect(players.map((item) => item.id)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("uses causal participants instead of result-derived featured players before suspense ends", () => {
    const suspense = moment({
      facts: {
        ...moment().facts,
        participantPlayerIds: ["alpha", "beta", "gamma", "alpha"],
        featuredPlayerIds: ["alpha"],
        winnerPlayerIds: ["alpha"],
      },
    });

    expect(momentPublicPlayerIds(suspense, false)).toEqual(["alpha", "beta", "gamma"]);
    expect(momentPublicPlayerIds(suspense, true)).toEqual(["alpha"]);
    expect(momentPublicPlayerIds(moment({ ...suspense, spoilerMode: "RESULT" }), false))
      .toEqual(["alpha"]);
  });

  it("withholds suspense outcomes until playback ends and clones revealed facts", () => {
    const players = [player("alpha", 3), player("beta", 1)];
    const suspense = moment();
    expect(momentOutcomeProjection(suspense, players, false)).toBeNull();

    const revealed = momentOutcomeProjection(suspense, players, true);
    expect(revealed).toEqual({
      winnerPlayerIds: ["alpha"],
      winners: [players[0]],
      eliminatedPlayerIds: ["beta"],
      netChanges: { alpha: 1_200, beta: -1_200 },
    });
    revealed!.netChanges.alpha = 0;
    expect(suspense.facts.netChanges.alpha).toBe(1_200);

    const resultFirst = moment({ spoilerMode: "RESULT" });
    expect(momentOutcomeProjection(resultFirst, players, false)?.winnerPlayerIds).toEqual(["alpha"]);
  });

  it("degrades result-revealing tags and final facts before suspense playback ends", () => {
    const suspense = moment();
    expect(publicMomentTagLabel(suspense, "zh-CN", false)).toBe("关键牌局");
    expect(publicMomentTagLabel(suspense, "en", false)).toBe("Key hand");
    expect(publicMomentTagLabel(suspense, "en", true)).toBe("Final hand");
    expect(publicMomentTagLabel(moment({
      primaryTag: "ALL_IN",
      tags: ["ALL_IN"],
      facts: { ...suspense.facts, primaryTag: "ALL_IN", tags: ["ALL_IN"] },
    }), "en", false)).toBe("All-in");

    expect(momentPublicFactsProjection(suspense, null, false)).toEqual({
      board: null,
      potChips: null,
      potBigBlinds: null,
    });
    expect(momentPublicFactsProjection(suspense, frame(105), false)).toEqual({
      board: [],
      potChips: 150,
      potBigBlinds: 1.5,
    });
    expect(momentPublicFactsProjection(suspense, null, true)).toEqual({
      board: suspense.facts.board,
      potChips: 2_400,
      potBigBlinds: 24,
    });
    expect(momentPublicFactsProjection(moment({ spoilerMode: "RESULT" }), null, false).potChips)
      .toBe(2_400);
  });

  it("keys replay identity by immutable moment id and publication revision", () => {
    const published = moment();
    expect(momentReplayKey(published)).toBe(`moment:${MOMENT_ID}:3`);
    expect(momentReplayKey({ ...published, publicationRevision: 4 }))
      .toBe(`moment:${MOMENT_ID}:4`);
  });

  it("builds a canonical public URL without carrying query or hash state", () => {
    expect(momentCanonicalUrl("final-hand", "https://arena.example/watch?theme=dark#table"))
      .toBe("https://arena.example/moments/final-hand");
  });

  it("adapts a replay response into a causal window without inventing a baseline", () => {
    const published = moment();
    const initialFrame = frame(99);
    const timeline = [frame(105), frame(115)];
    const events = [event(105), event(115)];
    const initialEliminatedPlayerIds = ["delta"];
    const data = momentReplayData({
      moment: published,
      timeline,
      events,
      initialFrame,
      initialEliminatedPlayerIds,
    });

    expect(data).toEqual({
      timeline,
      events,
      window: {
        startSequence: 100,
        endSequence: 120,
        initialFrame,
        initialEliminatedPlayerIds: ["delta"],
      },
    });
    expect(data.timeline).not.toBe(timeline);
    expect(data.events).not.toBe(events);
    expect(data.window.initialEliminatedPlayerIds).not.toBe(initialEliminatedPlayerIds);

    const withoutBaseline = momentReplayData({
      moment: published,
      timeline: [],
      events: [],
      initialFrame: null,
      initialEliminatedPlayerIds: [],
    });
    expect(withoutBaseline.window.initialFrame).toBeNull();
  });
});
