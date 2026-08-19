import { describe, expect, it } from "vitest";
import type { MomentSourceEvent } from "./moment-detector.js";
import { detectTournamentMoments } from "./moment-detector.js";
import {
  BROADCAST_VIEW_VERSION,
  type BroadcastView,
  type BroadcastViewPlayer,
} from "../broadcast-view.js";
import { BROADCAST_EQUITY_VERSION } from "../broadcast-equity.js";
import { MOMENT_DETECTOR_VERSION } from "../../../../../packages/contracts/src/moments.js";

const TOURNAMENT_ID = "00000000-0000-4000-8000-000000000091";

function event(
  sequence: number,
  type: string,
  publicPayload: unknown,
  options: { actorId?: string | null; handNo?: number | null } = {},
): MomentSourceEvent {
  return {
    sequence,
    type,
    actorId: options.actorId ?? null,
    handNo: options.handNo === undefined ? 1 : options.handNo,
    publicPayload,
    eventHash: sequence.toString(16).padStart(64, "0"),
  };
}

function player(
  playerId: string,
  seat: number,
  holeCards: [string, string],
  equity: number,
  options: { folded?: boolean; allIn?: boolean; stack?: number } = {},
): BroadcastViewPlayer {
  return {
    playerId,
    seat,
    holeCards,
    stack: options.stack ?? 0,
    folded: options.folded ?? false,
    allIn: options.allIn ?? true,
    streetCommitted: 0,
    equity,
    outrightWinProbability: equity,
    tieProbability: 0,
    lastAction: null,
  };
}

function frame(
  sequence: number,
  street: string,
  board: string[],
  players: BroadcastViewPlayer[],
  currentActorId: string | null,
): BroadcastView {
  return {
    version: BROADCAST_VIEW_VERSION,
    equityVersion: BROADCAST_EQUITY_VERSION,
    handNo: 1,
    sequence,
    street,
    board,
    pot: sequence >= 10 ? 200 : 15,
    pots: [],
    positions: { button: 0, smallBlind: 0, bigBlind: 1, headsUp: true },
    blinds: { smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 },
    currentActorId,
    estimated: board.length < 5,
    samples: board.length < 5 ? 5_000 : 1,
    players,
  };
}

function finalAllInEvents(): MomentSourceEvent[] {
  return [
    event(1, "BLIND_LEVEL_SELECTED", { handNo: 1, level: { smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 } }, { handNo: null }),
    event(2, "HAND_STARTED", { positions: { button: 0, smallBlind: 0, bigBlind: 1, headsUp: true } }),
    event(3, "FORCED_BET_POSTED", { playerId: "a", amount: 5, live: true }),
    event(4, "FORCED_BET_POSTED", { playerId: "b", amount: 10, live: true }),
    event(5, "HOLE_CARDS_DEALT", { playerId: "a" }),
    event(6, "HOLE_CARDS_DEALT", { playerId: "b" }),
    event(7, "BETTING_ROUND_STARTED", { street: "PREFLOP", actorId: "a", currentBet: 10 }),
    event(8, "MODEL_DECISION_RECORDED", {
      providerMetrics: [{ latencyMs: 72_000 }],
    }, { actorId: "a" }),
    event(9, "ACTION_APPLIED", {
      street: "PREFLOP", command: { action: "all_in" }, classification: "raise", paid: 95, amountTo: 100,
    }, { actorId: "a" }),
    event(10, "ACTION_APPLIED", {
      street: "PREFLOP", command: { action: "all_in" }, classification: "call", paid: 90, amountTo: 100,
    }, { actorId: "b" }),
    event(11, "STREET_DEALT", { street: "FLOP", cards: [] }),
    event(12, "STREET_DEALT", { street: "TURN", cards: [] }),
    event(13, "STREET_DEALT", { street: "RIVER", cards: [] }),
    event(14, "SHOWDOWN_REVEALED", { players: [{ playerId: "a" }, { playerId: "b" }] }),
    event(15, "POT_CREATED", { pot: { index: 0, amount: 200, eligible: ["a", "b"] } }),
    event(16, "POT_AWARDED", { award: { potIndex: 0, boardIndex: 0, playerId: "b", amount: 200 } }),
    event(17, "HAND_COMPLETED", { result: { stacks: { a: 0, b: 200 }, winnerPlayerIds: ["b"] } }),
    event(18, "PLAYER_ELIMINATED", { finishingPosition: 2, tieGroup: null }, { actorId: "a" }),
    event(19, "TOURNAMENT_COMPLETED", { championPlayerId: "b", completedHands: 1 }, { handNo: null }),
  ];
}

function finalAllInFrames(): BroadcastView[] {
  const aCards: [string, string] = ["As", "Ah"];
  const bCards: [string, string] = ["2s", "2h"];
  return [
    frame(7, "PREFLOP", [], [
      player("a", 0, aCards, 0.80, { allIn: false, stack: 95 }),
      player("b", 1, bCards, 0.20, { allIn: false, stack: 90 }),
    ], "a"),
    frame(10, "PREFLOP", [], [
      player("a", 0, aCards, 0.80),
      player("b", 1, bCards, 0.20),
    ], null),
    frame(11, "FLOP", ["2c", "3d", "3h"], [
      player("a", 0, aCards, 0.90),
      player("b", 1, bCards, 0.10),
    ], null),
    frame(12, "TURN", ["2c", "3d", "3h", "8s"], [
      player("a", 0, aCards, 0.20),
      player("b", 1, bCards, 0.80),
    ], null),
    frame(13, "RIVER", ["2c", "3d", "3h", "8s", "Tc"], [
      player("a", 0, aCards, 0),
      player("b", 1, bCards, 1),
    ], null),
  ];
}

describe("moment detector", () => {
  it("derives deterministic, versioned facts without changing the source event chain", () => {
    const input = {
      tournamentId: TOURNAMENT_ID,
      tournamentStatus: "COMPLETED",
      events: finalAllInEvents(),
      broadcastFrames: finalAllInFrames(),
    } as const;
    const eventsBefore = structuredClone(input.events);
    const first = detectTournamentMoments(input);
    const second = detectTournamentMoments(input);

    expect(first).toEqual(second);
    expect(input.events).toEqual(eventsBefore);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      handNo: 1,
      primaryTag: "FINAL_HAND",
      recommendationRank: 1,
      startSequence: 1,
      focusSequence: 12,
      detectorVersion: MOMENT_DETECTOR_VERSION,
      endSequence: 19,
      winnerPlayerIds: ["b"],
      eliminatedPlayerIds: ["a"],
      potChips: 200,
      potBigBlinds: 20,
      startingStacks: { a: 100, b: 100 },
      endingStacks: { a: 0, b: 200 },
      maxDecisionLatencyMs: 72_000,
      winningHandCategories: ["FULL_HOUSE"],
    });
    expect(first[0]?.tags).toEqual(expect.arrayContaining([
      "FINAL_HAND",
      "ELIMINATION",
      "ALL_IN",
      "LARGE_POT",
      "EQUITY_REVERSAL",
      "ALL_IN_UNDERDOG_WIN",
      "RARE_MADE_HAND",
      "LONG_TANK",
    ]));
    expect(first[0]?.source.eventCount).toBe(19);
  });

  it("does not use a river equity reversal as the default suspense cover", () => {
    const frames = finalAllInFrames().map((item) => {
      if (item.sequence !== 12) return item;
      return {
        ...item,
        players: [
          { ...item.players[0]!, equity: 0.80, outrightWinProbability: 0.80 },
          { ...item.players[1]!, equity: 0.20, outrightWinProbability: 0.20 },
        ],
      };
    });
    const detected = detectTournamentMoments({
      tournamentId: TOURNAMENT_ID,
      tournamentStatus: "COMPLETED",
      events: finalAllInEvents(),
      broadcastFrames: frames,
    });

    expect(detected[0]?.equityTransitions).toContainEqual(expect.objectContaining({
      fromSequence: 12,
      toSequence: 13,
    }));
    expect(detected[0]?.focusSequence).toBe(12);
  });

  it("does not call a fold-driven contender change an equity reversal", () => {
    const events = finalAllInEvents().map((item) => ({ ...item }));
    const frames = [
      frame(7, "PREFLOP", [], [
        player("a", 0, ["As", "Ah"], 0.20, { allIn: false }),
        player("b", 1, ["Ks", "Kh"], 0.30, { allIn: false }),
        player("c", 2, ["Qs", "Qh"], 0.50, { allIn: false }),
      ], "a"),
      frame(11, "FLOP", ["2c", "3d", "4h"], [
        player("a", 0, ["As", "Ah"], 0.80),
        player("b", 1, ["Ks", "Kh"], 0.20),
        player("c", 2, ["Qs", "Qh"], 0, { folded: true }),
      ], null),
    ];
    events.splice(6, 0, event(7, "HOLE_CARDS_DEALT", { playerId: "c" }));
    // Restore a strictly increasing authoritative sequence after inserting a participant.
    const resequenced = events.map((item, index) => ({
      ...item,
      sequence: index + 1,
      eventHash: (index + 1).toString(16).padStart(64, "0"),
    }));
    const detected = detectTournamentMoments({
      tournamentId: TOURNAMENT_ID,
      tournamentStatus: "COMPLETED",
      events: resequenced,
      broadcastFrames: frames,
    });

    expect(detected[0]?.tags).not.toContain("EQUITY_REVERSAL");
  });

  it("recognizes a call that consumes the short stack as an all-in and sums retry latency", () => {
    const events = finalAllInEvents().map((item) => {
      if (item.type === "ACTION_APPLIED") {
        const payload = item.publicPayload as Record<string, unknown>;
        return { ...item, publicPayload: { ...payload, command: { action: "call" } } };
      }
      if (item.type === "MODEL_DECISION_RECORDED") {
        return {
          ...item,
          publicPayload: { providerMetrics: [{ latencyMs: 40_000 }, { latencyMs: 25_000 }] },
        };
      }
      return item;
    });
    const detected = detectTournamentMoments({
      tournamentId: TOURNAMENT_ID,
      tournamentStatus: "COMPLETED",
      events,
      broadcastFrames: finalAllInFrames(),
    });

    expect(detected[0]?.tags).toEqual(expect.arrayContaining(["ALL_IN", "LONG_TANK"]));
    expect(detected[0]?.maxDecisionLatencyMs).toBe(65_000);
    expect(detected[0]?.allInLock?.sequence).toBe(10);
  });

  it("does not lock equity while two live stacks can still contest a side pot", () => {
    const inserted = [
      ...finalAllInEvents().slice(0, 6),
      event(0, "HOLE_CARDS_DEALT", { playerId: "c" }),
      ...finalAllInEvents().slice(6),
    ];
    const events = inserted.map((item, index) => {
      const publicPayload = item.type === "HAND_COMPLETED"
        ? { result: { stacks: { a: 0, b: 200, c: 100 }, winnerPlayerIds: ["b"] } }
        : item.publicPayload;
      return {
        ...item,
        sequence: index + 1,
        publicPayload,
        eventHash: (index + 1).toString(16).padStart(64, "0"),
      };
    });
    const frames = finalAllInFrames().map((item) => ({
      ...item,
      sequence: item.sequence >= 7 ? item.sequence + 1 : item.sequence,
      players: [
        { ...item.players[0]!, equity: 0.55 },
        { ...item.players[1]!, allIn: false, stack: 90, equity: 0.35 },
        player("c", 2, ["Qs", "Qh"], 0.10, { allIn: false, stack: 100 }),
      ],
    }));
    const detected = detectTournamentMoments({
      tournamentId: TOURNAMENT_ID,
      tournamentStatus: "COMPLETED",
      events,
      broadcastFrames: frames,
    });

    expect(detected[0]?.tags).toContain("ALL_IN");
    expect(detected[0]?.tags).not.toContain("MULTIWAY_ALL_IN");
    expect(detected[0]?.tags).not.toContain("ALL_IN_UNDERDOG_WIN");
    expect(detected[0]?.allInLock).toBeNull();
  });

  it("rejects incomplete tournaments before generating any content", () => {
    expect(() => detectTournamentMoments({
      tournamentId: TOURNAMENT_ID,
      tournamentStatus: "RUNNING",
      events: finalAllInEvents(),
      broadcastFrames: finalAllInFrames(),
    })).toThrow("only be derived after a tournament is completed");
  });
});
