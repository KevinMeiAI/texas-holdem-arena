import { describe, expect, it } from "vitest";
import type { ProjectedArenaEvent } from "../../../../packages/contracts/src/visibility.js";
import { parseCard } from "../../../../packages/domain/src/cards.js";
import { BroadcastViewBuilder } from "./broadcast-view.js";

function event(sequence: number, type: string, publicPayload: unknown, privatePayload?: unknown, actorId: string | null = null): ProjectedArenaEvent {
  return {
    tournamentId: "tournament",
    sequence,
    aggregateVersion: sequence,
    type,
    actorId,
    handNo: 4,
    publicPayload,
    ...(privatePayload === undefined ? {} : { privatePayload }),
    eventHash: String(sequence).padStart(64, "0"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("broadcast view", () => {
  it("combines broadcast-only hole cards, equity, and the current-street action", () => {
    const builder = new BroadcastViewBuilder();
    const state = {
      tournamentId: "tournament",
      players: [
        { id: "hero", seat: 0, stack: 900, folded: false, allIn: false, streetCommitted: 100, totalCommitted: 100 },
        { id: "villain", seat: 1, stack: 1_000, folded: false, allIn: false, streetCommitted: 0, totalCommitted: 0 },
      ],
      hand: { handNo: 4, phase: "RIVER", positions: { button: 0, smallBlind: 0, bigBlind: 1, headsUp: true }, blinds: { smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 }, boards: [["2c", "3d", "4h", "8s", "Tc"]], currentActorId: "villain" },
    };
    const view = builder.build(state, [
      event(1, "HOLE_CARDS_DEALT", { playerId: "hero" }, { cards: [parseCard("As"), parseCard("Ks")] }),
      event(2, "HOLE_CARDS_DEALT", { playerId: "villain" }, { cards: [parseCard("Ah"), parseCard("Qh")] }),
      event(3, "STREET_DEALT", { street: "FLOP", cards: [parseCard("2c"), parseCard("3d"), parseCard("4h")] }),
      event(4, "ACTION_APPLIED", { street: "FLOP", command: { action: "bet" }, classification: "bet", paid: 100, amountTo: 100 }, undefined, "hero"),
      event(5, "STREET_DEALT", { street: "TURN", cards: [parseCard("8s")] }),
      event(6, "STREET_DEALT", { street: "RIVER", cards: [parseCard("Tc")] }),
      event(7, "ACTION_APPLIED", { street: "RIVER", command: { action: "check" }, classification: "check", paid: 0, amountTo: 0 }, undefined, "hero"),
    ]);

    expect(view).toMatchObject({ handNo: 4, street: "RIVER", board: ["2c", "3d", "4h", "8s", "Tc"], pot: 100, blinds: { smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 }, currentActorId: "villain", estimated: false, samples: 1 });
    expect(view?.players).toEqual([
      expect.objectContaining({ playerId: "hero", holeCards: ["As", "Ks"], equity: 1, lastAction: expect.objectContaining({ action: "check" }) }),
      expect.objectContaining({ playerId: "villain", holeCards: ["Ah", "Qh"], equity: 0, lastAction: null }),
    ]);
  });

  it("builds replayable street frames with reconstructed stacks for a fast all-in runout", () => {
    const builder = new BroadcastViewBuilder();
    const state = {
      tournamentId: "tournament",
      completedHands: 4,
      players: [
        { id: "hero", seat: 0, stack: 200, folded: false, allIn: false, streetCommitted: 0, totalCommitted: 0 },
        { id: "villain", seat: 1, stack: 0, folded: false, allIn: false, streetCommitted: 0, totalCommitted: 0 },
      ],
      hand: null,
    };
    const timeline = builder.buildTimeline(state, [
      { ...event(1, "BLIND_LEVEL_SELECTED", { handNo: 4, level: { smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 } }), handNo: null },
      event(2, "HAND_STARTED", { positions: { button: 0, smallBlind: 0, bigBlind: 1, headsUp: true } }),
      event(3, "FORCED_BET_POSTED", { playerId: "hero", amount: 5, live: true }),
      event(4, "FORCED_BET_POSTED", { playerId: "villain", amount: 10, live: true }),
      event(5, "HOLE_CARDS_DEALT", { playerId: "hero" }, { cards: [parseCard("As"), parseCard("Ah")] }),
      event(6, "HOLE_CARDS_DEALT", { playerId: "villain" }, { cards: [parseCard("Ks"), parseCard("Kh")] }),
      event(7, "BETTING_ROUND_STARTED", { street: "PREFLOP", actorId: "hero", currentBet: 10 }),
      event(8, "ACTION_APPLIED", { street: "PREFLOP", command: { action: "all_in" }, classification: "raise", paid: 95, amountTo: 100 }, undefined, "hero"),
      event(9, "ACTION_APPLIED", { street: "PREFLOP", command: { action: "all_in" }, classification: "call", paid: 90, amountTo: 100 }, undefined, "villain"),
      event(10, "STREET_DEALT", { street: "FLOP", cards: [parseCard("2c"), parseCard("3d"), parseCard("4h")] }),
      event(11, "STREET_DEALT", { street: "TURN", cards: [parseCard("8s")] }),
      event(12, "STREET_DEALT", { street: "RIVER", cards: [parseCard("Tc")] }),
      event(13, "SHOWDOWN_REVEALED", { players: [] }),
      event(14, "POT_AWARDED", { award: { playerId: "hero", amount: 200 } }),
      event(15, "HAND_COMPLETED", { result: { stacks: { hero: 200, villain: 0 } } }),
    ]);

    expect(timeline.map((frame) => frame.sequence)).toEqual([7, 8, 9, 10, 11, 12, 13]);
    expect(timeline[0]).toMatchObject({ handNo: 4, street: "PREFLOP", board: [], pot: 15, blinds: { smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 }, currentActorId: "hero", estimated: true });
    expect(timeline[1]?.players).toEqual([
      expect.objectContaining({ playerId: "hero", streetCommitted: 100 }),
      expect.objectContaining({ playerId: "villain", streetCommitted: 10 }),
    ]);
    expect(timeline[3]?.players).toEqual([
      expect.objectContaining({ playerId: "hero", streetCommitted: 0 }),
      expect.objectContaining({ playerId: "villain", streetCommitted: 0 }),
    ]);
    expect(timeline.at(-1)).toMatchObject({
      handNo: 4,
      street: "SHOWDOWN",
      board: ["2c", "3d", "4h", "8s", "Tc"],
      pot: 200,
      players: [
        expect.objectContaining({ playerId: "hero", stack: 0, equity: 1 }),
        expect.objectContaining({ playerId: "villain", stack: 0, equity: 0 }),
      ],
    });
  });
});
