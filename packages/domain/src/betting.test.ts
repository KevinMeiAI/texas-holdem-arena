import { describe, expect, it } from "vitest";
import { applyAction, createBettingRound, legalActions, type BettingPlayer } from "./betting.js";

function player(id: string, seat: number, stack = 1_000): BettingPlayer {
  return { id, seat, stack, committed: 0, folded: false, allIn: false, actedSinceFullRaise: false };
}

describe("betting round", () => {
  it("checks around and completes", () => {
    let round = createBettingRound({
      street: "FLOP",
      bigBlind: 100,
      currentBet: 0,
      lastFullRaiseSize: 100,
      players: [player("a", 0), player("b", 1), player("c", 2)],
      currentActorId: "a",
      lastAggressorId: undefined,
    });
    round = applyAction(round, { action: "check" });
    round = applyAction(round, { action: "check" });
    round = applyAction(round, { action: "check" });
    expect(round.complete).toBe(true);
  });

  it("does not reopen raising after a short all-in", () => {
    const c = player("c", 2, 150);
    let round = createBettingRound({
      street: "FLOP",
      bigBlind: 100,
      currentBet: 0,
      lastFullRaiseSize: 100,
      players: [player("a", 0), player("b", 1), c],
      currentActorId: "a",
      lastAggressorId: undefined,
    });
    round = applyAction(round, { action: "bet", amountTo: 100 });
    round = applyAction(round, { action: "call" });
    round = applyAction(round, { action: "all_in" });
    expect(round.currentActorId).toBe("a");
    const actions = legalActions(round);
    expect(actions.call?.amount).toBe(50);
    expect(actions.raise).toBeUndefined();
    expect(actions.allIn).toBeUndefined();
  });

  it("keeps raising open for a player who has not acted before a short all-in", () => {
    const b = player("b", 1, 150);
    let round = createBettingRound({
      street: "FLOP",
      bigBlind: 100,
      currentBet: 0,
      lastFullRaiseSize: 100,
      players: [player("a", 0), b, player("c", 2)],
      currentActorId: "a",
      lastAggressorId: undefined,
    });
    round = applyAction(round, { action: "bet", amountTo: 100 });
    round = applyAction(round, { action: "all_in" });
    expect(round.currentActorId).toBe("c");
    expect(legalActions(round).raise).toEqual({ minAmountTo: 250, maxAmountTo: 1_000 });
  });

  it("reopens raising when multiple short all-ins cumulatively form a full raise", () => {
    const b = player("b", 1, 150);
    const c = player("c", 2, 200);
    let round = createBettingRound({
      street: "FLOP",
      bigBlind: 100,
      currentBet: 0,
      lastFullRaiseSize: 100,
      players: [player("a", 0), b, c, player("d", 3)],
      currentActorId: "a",
      lastAggressorId: undefined,
    });
    round = applyAction(round, { action: "bet", amountTo: 100 });
    round = applyAction(round, { action: "all_in" });
    round = applyAction(round, { action: "all_in" });
    round = applyAction(round, { action: "call" });
    expect(round.currentActorId).toBe("a");
    expect(legalActions(round).raise).toEqual({ minAmountTo: 300, maxAmountTo: 1_000 });
  });

  it("reopens raising after a full all-in raise", () => {
    const c = player("c", 2, 250);
    let round = createBettingRound({
      street: "FLOP",
      bigBlind: 100,
      currentBet: 0,
      lastFullRaiseSize: 100,
      players: [player("a", 0), player("b", 1), c],
      currentActorId: "a",
      lastAggressorId: undefined,
    });
    round = applyAction(round, { action: "bet", amountTo: 100 });
    round = applyAction(round, { action: "call" });
    round = applyAction(round, { action: "all_in" });
    expect(legalActions(round).raise).toEqual({ minAmountTo: 400, maxAmountTo: 1_000 });
  });

  it("allows an under-call all-in and closes when everyone else matches", () => {
    const b = player("b", 1, 40);
    let round = createBettingRound({
      street: "FLOP",
      bigBlind: 100,
      currentBet: 0,
      lastFullRaiseSize: 100,
      players: [player("a", 0), b, player("c", 2)],
      currentActorId: "a",
      lastAggressorId: undefined,
    });
    round = applyAction(round, { action: "bet", amountTo: 100 });
    round = applyAction(round, { action: "all_in" });
    round = applyAction(round, { action: "call" });
    expect(round.complete).toBe(true);
    expect(round.players.find((candidate) => candidate.id === "b")).toMatchObject({ committed: 40, stack: 0, allIn: true });
  });
});
