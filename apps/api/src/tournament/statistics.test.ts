import { describe, expect, it } from "vitest";
import {
  buildArenaLeaderboards,
  calculateTournamentStatistics,
  type StatisticsEvent,
  type StatisticsTournamentState,
} from "./statistics.js";

function event(
  sequence: number,
  type: string,
  handNo: number | null,
  publicPayload: unknown,
  actorId: string | null = null,
  privatePayload?: unknown,
): StatisticsEvent {
  return { sequence, type, handNo, publicPayload, actorId, ...(privatePayload === undefined ? {} : { privatePayload }) };
}

const state: StatisticsTournamentState = {
  tournamentId: "00000000-0000-4000-8000-000000000001",
  completedHands: 2,
  championPlayerId: "a",
  players: [
    { id: "a", displayName: "Alpha", seat: 0, stack: 240, finishingPosition: 1 },
    { id: "b", displayName: "Beta", seat: 1, stack: 0, finishingPosition: 3 },
    { id: "c", displayName: "Gamma", seat: 2, stack: 60, finishingPosition: 2 },
  ],
};

const events: StatisticsEvent[] = [
  event(1, "BLIND_LEVEL_SELECTED", null, { handNo: 1, level: { smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 } }),
  event(2, "HAND_STARTED", 1, { handNo: 1, positions: { button: 0, smallBlind: 1, bigBlind: 2 } }),
  event(3, "HOLE_CARDS_DEALT", 1, { playerId: "a" }, null, { cards: [{ rank: 14, suit: "s" }, { rank: 14, suit: "h" }] }),
  event(4, "HOLE_CARDS_DEALT", 1, { playerId: "b" }, null, { cards: [{ rank: 12, suit: "s" }, { rank: 12, suit: "h" }] }),
  event(5, "HOLE_CARDS_DEALT", 1, { playerId: "c" }, null, { cards: [{ rank: 13, suit: "s" }, { rank: 13, suit: "h" }] }),
  event(6, "ACTION_APPLIED", 1, { street: "PREFLOP", classification: "raise", paid: 30, amountTo: 30 }, "c"),
  event(7, "ACTION_APPLIED", 1, { street: "PREFLOP", classification: "raise", paid: 50, amountTo: 50 }, "a"),
  event(8, "ACTION_APPLIED", 1, { street: "PREFLOP", classification: "fold", paid: 0, amountTo: 0 }, "b"),
  event(9, "ACTION_APPLIED", 1, { street: "PREFLOP", classification: "call", paid: 20, amountTo: 50 }, "c"),
  event(10, "SHOWDOWN_REVEALED", 1, { players: [{ playerId: "a" }, { playerId: "c" }] }),
  event(11, "POT_CREATED", 1, { pot: { index: 0, contributors: ["a", "c"], eligible: ["a", "c"] } }),
  event(12, "POT_AWARDED", 1, { award: { potIndex: 0, boardIndex: 0, playerId: "a", amount: 100 } }),
  event(13, "HAND_COMPLETED", 1, { result: { stacks: { a: 150, b: 90, c: 60 }, winnerPlayerIds: ["a"] } }),
  event(14, "MODEL_DECISION_RECORDED", 1, {
    playerId: "a", providerCalls: 1, protocolFailures: 0, usedFallback: false,
    providerMetrics: [{ outcome: "SUCCESS", errorKind: null, latencyMs: 100, usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } }],
  }, "a"),
  event(15, "BLIND_LEVEL_SELECTED", null, { handNo: 2, level: { smallBlind: 10, bigBlind: 20, bigBlindAnte: 0 } }),
  event(16, "HAND_STARTED", 2, { handNo: 2, positions: { button: 1, smallBlind: 2, bigBlind: 0 } }),
  event(17, "HOLE_CARDS_DEALT", 2, { playerId: "a" }, null, { cards: [{ rank: 14, suit: "s" }, { rank: 14, suit: "h" }] }),
  event(18, "HOLE_CARDS_DEALT", 2, { playerId: "b" }, null, { cards: [{ rank: 13, suit: "s" }, { rank: 13, suit: "h" }] }),
  event(19, "HOLE_CARDS_DEALT", 2, { playerId: "c" }, null, { cards: [{ rank: 12, suit: "s" }, { rank: 12, suit: "h" }] }),
  event(20, "STREET_DEALT", 2, { street: "FLOP", boardIndex: 0, cards: [{ rank: 2, suit: "c" }, { rank: 3, suit: "d" }, { rank: 4, suit: "h" }] }),
  event(21, "STREET_DEALT", 2, { street: "TURN", boardIndex: 0, cards: [{ rank: 9, suit: "s" }] }),
  event(22, "ACTION_APPLIED", 2, { street: "TURN", classification: "raise", paid: 90, amountTo: 90, command: { action: "all_in" } }, "b"),
  event(23, "ACTION_APPLIED", 2, { street: "TURN", classification: "fold", paid: 0, amountTo: 0 }, "c"),
  event(24, "ACTION_APPLIED", 2, { street: "TURN", classification: "call", paid: 90, amountTo: 90 }, "a"),
  event(25, "STREET_DEALT", 2, { street: "RIVER", boardIndex: 0, cards: [{ rank: 7, suit: "c" }] }),
  event(26, "SHOWDOWN_REVEALED", 2, { players: [{ playerId: "a" }, { playerId: "b" }] }),
  event(27, "POT_CREATED", 2, { pot: { index: 0, contributors: ["a", "b"], eligible: ["a", "b"] } }),
  event(28, "POT_AWARDED", 2, { award: { potIndex: 0, boardIndex: 0, playerId: "a", amount: 180 } }),
  event(29, "HAND_COMPLETED", 2, { result: { stacks: { a: 240, b: 0, c: 60 }, winnerPlayerIds: ["a"] } }),
  event(30, "PLAYER_ELIMINATED", 2, { finishingPosition: 3, tieGroup: null }, "b"),
  event(31, "MODEL_DECISION_RECORDED", 2, {
    playerId: "b", providerCalls: 2, protocolFailures: 1, usedFallback: false,
    providerMetrics: [
      { outcome: "PROTOCOL_ERROR", errorKind: "INVALID_RESPONSE", latencyMs: null, usage: null },
      { outcome: "SUCCESS", errorKind: null, latencyMs: 400, usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } },
    ],
  }, "b"),
  event(32, "TOURNAMENT_PAUSED_INFRA", null, { playerId: "b", errorKind: "TIMEOUT", attempts: 3 }),
];

describe("tournament statistics", () => {
  it("derives competitive, poker, all-in and provider metrics from authoritative events", () => {
    const result = calculateTournamentStatistics(state, events);
    const alpha = result.statistics.players.find((player) => player.playerId === "a")!;
    const beta = result.statistics.players.find((player) => player.playerId === "b")!;

    expect(result.statistics).toMatchObject({ completedHands: 2, initialStack: 100, totalChips: 300 });
    expect(alpha).toMatchObject({
      finishingPosition: 1,
      knockouts: 1,
      handsPlayed: 2,
      chipLeadHands: 2,
      peakStack: 240,
      vpipHands: 1,
      pfrHands: 1,
      threeBetHands: 1,
      showdownHands: 2,
      showdownWins: 2,
      allInHands: 1,
      allInWins: 1,
      decisions: 1,
      validDecisions: 1,
      firstPassDecisions: 1,
      totalTokens: 10,
    });
    expect(alpha.netBigBlinds).toBeCloseTo(9.5);
    expect(alpha.allInExpectedBigBlinds).toBeGreaterThan(0);
    expect(alpha.allInActualBigBlinds).toBe(9);
    expect(beta.infrastructurePauses).toBe(1);
    expect(beta.protocolCorrections).toBe(1);
    expect(beta.firstPassRate).toBe(0);
    expect(alpha.allInLuckBigBlinds + beta.allInLuckBigBlinds).toBeCloseTo(0);
  });

  it("keeps competitive rating separate from reliability and efficiency", () => {
    const result = calculateTournamentStatistics(state, events);
    const boards = buildArenaLeaderboards([{
      createdAt: "2026-08-10T00:00:00.000Z",
      statistics: result.statistics,
      internals: result.internals,
    }]);

    expect(boards.competition[0]).toMatchObject({ modelId: "a", rating: 1516, points: 10, championships: 1 });
    expect(boards.competition.at(-1)?.modelId).toBe("b");
    expect(boards.reliability.find((entry) => entry.modelId === "a")?.firstPassRate).toBe(1);
    expect(boards.efficiency.find((entry) => entry.modelId === "a")?.averageLatencyMs).toBe(100);
    expect(boards.styles.find((entry) => entry.modelId === "a")?.profile).toBe("松凶");
    expect(boards.methodology.separation).toContain("never alter");
  });

  it("uses the latest frozen display name for a persistent model identity", () => {
    const result = calculateTournamentStatistics(state, events);
    const renamed = {
      ...result.statistics,
      players: result.statistics.players.map((player) => (
        player.playerId === "a" ? { ...player, displayName: "Alpha Prime" } : player
      )),
    };
    const boards = buildArenaLeaderboards([
      { createdAt: "2026-08-10T00:00:00.000Z", statistics: result.statistics, internals: result.internals },
      { createdAt: "2026-08-11T00:00:00.000Z", statistics: renamed, internals: result.internals },
    ]);

    expect(boards.competition.find((entry) => entry.modelId === "a")?.displayName).toBe("Alpha Prime");
  });
});
