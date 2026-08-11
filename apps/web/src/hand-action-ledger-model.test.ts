import { describe, expect, it } from "vitest";
import { buildHandActionLedger } from "./hand-action-ledger-model";
import type { ArenaEvent, ArenaPlayer } from "./types";

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

function event(sequence: number, type: string, publicPayload: Record<string, unknown>, actorId: string | null = null): ArenaEvent {
  return {
    tournamentId: "tournament",
    sequence,
    aggregateVersion: sequence,
    type,
    actorId,
    handNo: 1,
    publicPayload,
    eventHash: `hash-${sequence}`,
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

function dealt(sequence: number, playerId: string): ArenaEvent {
  return event(sequence, "HOLE_CARDS_DEALT", { playerId });
}

describe("hand action ledger", () => {
  it("orders participating models by seat and marks the hand's blind positions", () => {
    const players = [player("c", 2), player("out", 3), player("a", 0), player("b", 1)];
    const events = [
      event(1, "HAND_STARTED", { positions: { button: 0, smallBlind: 1, bigBlind: 2 } }),
      dealt(2, "a"), dealt(3, "b"), dealt(4, "c"),
      event(5, "ACTION_APPLIED", { street: "PREFLOP", command: { action: "call" }, classification: "call", paid: 100, amountTo: 100 }, "a"),
    ];

    const rows = buildHandActionLedger(players, events);

    expect(rows.map((row) => row.player.id)).toEqual(["a", "b", "c"]);
    expect(rows.map((row) => row.position)).toEqual([null, "SB", "BB"]);
    expect(rows[0]?.cells.PREFLOP.actions[0]).toMatchObject({ label: "跟注 100", term: "Limp" });
  });

  it("labels reliable pre-flop terms and distinguishes folded, all-in and automatic runout streets", () => {
    const players = [player("a", 0), player("b", 1), player("c", 2)];
    const events = [
      event(1, "HAND_STARTED", { positions: { button: 0, smallBlind: 1, bigBlind: 2 } }),
      dealt(2, "a"), dealt(3, "b"), dealt(4, "c"),
      event(5, "ACTION_APPLIED", { street: "PREFLOP", command: { action: "call" }, classification: "call", paid: 100, amountTo: 100 }, "a"),
      event(6, "MODEL_DECISION_RECORDED", { providerCalls: 2, protocolFailures: 1, usedFallback: false, decisionSummary: "隔离 limper" }, "b"),
      event(7, "ACTION_APPLIED", { street: "PREFLOP", command: { action: "raise", amount_to: 400 }, classification: "raise", paid: 350, amountTo: 400 }, "b"),
      event(8, "ACTION_APPLIED", { street: "PREFLOP", command: { action: "all_in" }, classification: "raise", paid: 900, amountTo: 1_000 }, "c"),
      event(9, "ACTION_APPLIED", { street: "PREFLOP", command: { action: "fold" }, classification: "fold", paid: 0, amountTo: 100 }, "a"),
      event(10, "ACTION_APPLIED", { street: "PREFLOP", command: { action: "call" }, classification: "call", paid: 600, amountTo: 1_000 }, "b"),
      event(11, "STREET_DEALT", { street: "FLOP", cards: [] }),
      event(12, "STREET_DEALT", { street: "TURN", cards: [] }),
      event(13, "STREET_DEALT", { street: "RIVER", cards: [] }),
    ];

    const rows = buildHandActionLedger(players, events);
    const alpha = rows.find((row) => row.player.id === "a")!;
    const beta = rows.find((row) => row.player.id === "b")!;
    const gamma = rows.find((row) => row.player.id === "c")!;

    expect(alpha.cells.PREFLOP.actions.map((action) => action.term)).toEqual(["Limp", null]);
    expect(alpha.cells.FLOP.state).toBe("FOLDED");
    expect(beta.cells.PREFLOP.actions[0]).toMatchObject({ term: "Open", label: "加注至 400" });
    expect(beta.cells.PREFLOP.actions[0]?.audit).toMatchObject({ providerCalls: 2, protocolFailures: 1 });
    expect(beta.cells.FLOP.state).toBe("NO_ACTION");
    expect(gamma.cells.PREFLOP.actions[0]).toMatchObject({ term: "3-Bet Jam", label: "全下加注至 1,000" });
    expect(gamma.cells.RIVER.state).toBe("ALL_IN");
  });

  it("renders a check-call chain and only calls the pre-flop aggressor's first flop bet a C-Bet", () => {
    const players = [player("a", 0), player("b", 1)];
    const events = [
      event(1, "HAND_STARTED", { positions: { button: 0, smallBlind: 0, bigBlind: 1, headsUp: true } }),
      dealt(2, "a"), dealt(3, "b"),
      event(4, "ACTION_APPLIED", { street: "PREFLOP", command: { action: "raise" }, classification: "raise", paid: 30, amountTo: 40 }, "a"),
      event(5, "ACTION_APPLIED", { street: "PREFLOP", command: { action: "call" }, classification: "call", paid: 20, amountTo: 40 }, "b"),
      event(6, "STREET_DEALT", { street: "FLOP", cards: [] }),
      event(7, "ACTION_APPLIED", { street: "FLOP", command: { action: "check" }, classification: "check", paid: 0, amountTo: 0 }, "b"),
      event(8, "ACTION_APPLIED", { street: "FLOP", command: { action: "bet" }, classification: "bet", paid: 30, amountTo: 30 }, "a"),
      event(9, "ACTION_APPLIED", { street: "FLOP", command: { action: "call" }, classification: "call", paid: 30, amountTo: 30 }, "b"),
    ];

    const rows = buildHandActionLedger(players, events);
    const alpha = rows.find((row) => row.player.id === "a")!;
    const beta = rows.find((row) => row.player.id === "b")!;

    expect(alpha.cells.FLOP.actions[0]).toMatchObject({ term: "C-Bet", label: "下注至 30" });
    expect(beta.cells.FLOP.actions.map((action) => action.label)).toEqual(["过牌", "跟注 30"]);
    expect(beta.cells.TURN.state).toBe("NOT_DEALT");
  });
});
