import { describe, expect, it } from "vitest";
import { initialPositions } from "./button.js";
import { createDeck } from "./cards.js";
import { currentLegalActions, reduceHand, startHand, type HandState } from "./reducer.js";

function threeHand() {
  return startHand({
    handNo: 1,
    seatCount: 3,
    players: [
      { id: "a", seat: 0, stack: 1_000 },
      { id: "b", seat: 1, stack: 1_000 },
      { id: "c", seat: 2, stack: 1_000 },
    ],
    positions: initialPositions(0, [0, 1, 2], 3),
    smallBlind: 50,
    bigBlind: 100,
    bigBlindAnte: 0,
    deck: createDeck(),
  });
}

function act(state: HandState, action: Parameters<typeof reduceHand>[1] & { type: "ACTION" }): HandState {
  return reduceHand(state, action).state;
}

describe("pure hand reducer", () => {
  it("posts the live big blind before a short player's big-blind ante", () => {
    const transition = startHand({
      handNo: 1,
      seatCount: 3,
      players: [
        { id: "a", seat: 0, stack: 1_000 },
        { id: "b", seat: 1, stack: 1_000 },
        { id: "c", seat: 2, stack: 120 },
      ],
      positions: initialPositions(0, [0, 1, 2], 3),
      smallBlind: 50,
      bigBlind: 100,
      bigBlindAnte: 100,
      deck: createDeck(),
    });
    expect(transition.state.players.find((player) => player.id === "c")).toMatchObject({
      stack: 0,
      streetCommitted: 100,
      totalCommitted: 120,
      deadCommitted: 20,
      allIn: true,
    });
    expect(transition.events.filter((event) => event.type === "FORCED_BET_POSTED")).toEqual([
      expect.objectContaining({ playerId: "b", kind: "SMALL_BLIND", amount: 50, live: true }),
      expect.objectContaining({ playerId: "c", kind: "BIG_BLIND", amount: 100, live: true }),
      expect.objectContaining({ playerId: "c", kind: "BIG_BLIND_ANTE", amount: 20, live: false }),
    ]);
  });

  it("records engine-resolved all-in classification independently of the model label", () => {
    let { state } = startHand({
      handNo: 1,
      seatCount: 2,
      players: [{ id: "a", seat: 0, stack: 10 }, { id: "b", seat: 1, stack: 100 }],
      positions: initialPositions(0, [0, 1], 2),
      smallBlind: 5,
      bigBlind: 10,
      bigBlindAnte: 0,
      deck: createDeck(),
    });
    const transition = reduceHand(state, { type: "ACTION", playerId: "a", action: { action: "call" } });
    state = transition.state;
    expect(state.players.find((player) => player.id === "a")?.allIn).toBe(true);
    expect(transition.events).toContainEqual(expect.objectContaining({
      type: "ACTION_APPLIED",
      command: { action: "call" },
      classification: "call",
    }));
  });

  it("gives the small blind a closing call-or-fold decision against a short all-in big blind", () => {
    const transition = startHand({
      handNo: 1,
      seatCount: 2,
      players: [{ id: "sb", seat: 0, stack: 100 }, { id: "bb", seat: 1, stack: 8 }],
      positions: initialPositions(0, [0, 1], 2),
      smallBlind: 5,
      bigBlind: 10,
      bigBlindAnte: 0,
      deck: createDeck(),
    });

    expect(transition.state.phase).toBe("PREFLOP");
    expect(transition.state.betting?.currentActorId).toBe("sb");
    expect(currentLegalActions(transition.state)).toMatchObject({
      fold: true,
      call: { amount: 5, allIn: false },
      raise: undefined,
      allIn: undefined,
    });

    const folded = reduceHand(transition.state, {
      type: "ACTION",
      playerId: "sb",
      action: { action: "fold" },
    });
    expect(folded.state.phase).toBe("HAND_COMPLETE");
    expect(folded.state.result?.stacks).toEqual({ sb: 95, bb: 13 });
  });

  it("gives the lone live player closing action when every blind is short and all-in", () => {
    const { state } = startHand({
      handNo: 1,
      seatCount: 3,
      players: [
        { id: "button", seat: 0, stack: 100 },
        { id: "sb", seat: 1, stack: 5 },
        { id: "bb", seat: 2, stack: 8 },
      ],
      positions: initialPositions(0, [0, 1, 2], 3),
      smallBlind: 5,
      bigBlind: 10,
      bigBlindAnte: 0,
      deck: createDeck(),
    });

    expect(state.betting?.currentActorId).toBe("button");
    expect(currentLegalActions(state)).toMatchObject({
      fold: true,
      call: { amount: 10, allIn: false },
      raise: undefined,
      allIn: undefined,
    });
  });

  it("keeps BBA dead money in the main pot and out of side-pot eligibility", () => {
    let { state } = startHand({
      handNo: 1,
      seatCount: 3,
      players: [
        { id: "a", seat: 0, stack: 120 },
        { id: "b", seat: 1, stack: 120 },
        { id: "c", seat: 2, stack: 150 },
      ],
      positions: initialPositions(0, [0, 1, 2], 3),
      smallBlind: 50,
      bigBlind: 100,
      bigBlindAnte: 50,
      deck: createDeck(),
    });
    state = act(state, { type: "ACTION", playerId: "a", action: { action: "all_in" } });
    state = act(state, { type: "ACTION", playerId: "b", action: { action: "all_in" } });
    expect(state.phase).toBe("HAND_COMPLETE");
    expect(state.returned).toEqual([]);
    expect(state.pots.map((pot) => ({ amount: pot.amount, deadAmount: pot.deadAmount, eligible: pot.eligible })))
      .toEqual([
        { amount: 350, deadAmount: 50, eligible: ["a", "b", "c"] },
        { amount: 40, deadAmount: 0, eligible: ["a", "b"] },
      ]);
    expect(state.players.reduce((sum, player) => sum + player.stack, 0)).toBe(390);
  });

  it("settles immediately when every opponent folds and retains folded hole cards", () => {
    let { state } = threeHand();
    expect(state.betting?.currentActorId).toBe("a");
    state = act(state, { type: "ACTION", playerId: "a", action: { action: "fold" } });
    state = act(state, { type: "ACTION", playerId: "b", action: { action: "fold" } });
    expect(state.phase).toBe("HAND_COMPLETE");
    expect(state.result?.stacks).toEqual({ a: 1_000, b: 950, c: 1_050 });
    expect(state.players.find((player) => player.id === "a")?.holeCards).toHaveLength(2);
    expect(state.players.find((player) => player.id === "b")?.holeCards).toHaveLength(2);
  });

  it("runs one complete board immediately after a preflop all-in call", () => {
    let { state } = startHand({
      handNo: 1,
      seatCount: 2,
      players: [
        { id: "a", seat: 0, stack: 100 },
        { id: "b", seat: 1, stack: 100 },
      ],
      positions: initialPositions(0, [0, 1], 2),
      smallBlind: 5,
      bigBlind: 10,
      bigBlindAnte: 0,
      deck: createDeck(),
    });
    state = act(state, { type: "ACTION", playerId: "a", action: { action: "all_in" } });
    state = act(state, { type: "ACTION", playerId: "b", action: { action: "call" } });
    expect(state.phase).toBe("HAND_COMPLETE");
    expect(state.boards).toHaveLength(1);
    expect(state.boards[0]).toHaveLength(5);
    expect(state.burnCards).toHaveLength(3);
    expect(state.nextCardIndex).toBe(12);
    expect(Object.values(state.result?.stacks ?? {}).reduce((sum, stack) => sum + stack, 0)).toBe(200);
    expect(state.awards.reduce((sum, award) => sum + award.amount, 0)).toBe(200);
  });

  it.each([
    { checks: 0, boardBeforeAllIn: 3, pendingBurns: 2 },
    { checks: 1, boardBeforeAllIn: 4, pendingBurns: 1 },
  ])("preserves the dealt board and completes the remaining streets once", ({ checks, boardBeforeAllIn, pendingBurns }) => {
    let { state } = startHand({
      handNo: 1,
      seatCount: 2,
      players: [
        { id: "a", seat: 0, stack: 100 },
        { id: "b", seat: 1, stack: 100 },
      ],
      positions: initialPositions(0, [0, 1], 2),
      smallBlind: 5,
      bigBlind: 10,
      bigBlindAnte: 0,
      deck: createDeck(),
    });
    state = act(state, { type: "ACTION", playerId: "a", action: { action: "call" } });
    state = act(state, { type: "ACTION", playerId: "b", action: { action: "check" } });
    for (let index = 0; index < checks; index += 1) {
      state = act(state, { type: "ACTION", playerId: "b", action: { action: "check" } });
      state = act(state, { type: "ACTION", playerId: "a", action: { action: "check" } });
    }
    expect(state.boards[0]).toHaveLength(boardBeforeAllIn);
    const burnsBeforeAllIn = state.burnCards.length;
    const actor = state.betting?.currentActorId;
    if (!actor) throw new Error("Missing all-in actor");
    state = act(state, { type: "ACTION", playerId: actor, action: { action: "all_in" } });
    const caller = state.betting?.currentActorId;
    if (!caller) throw new Error("Missing all-in caller");
    state = act(state, { type: "ACTION", playerId: caller, action: { action: "call" } });
    expect(state.phase).toBe("HAND_COMPLETE");
    expect(state.boards).toHaveLength(1);
    expect(state.boards[0]).toHaveLength(5);
    expect(state.burnCards).toHaveLength(burnsBeforeAllIn + pendingBurns);
  });

  it("settles immediately after an all-in call on the river", () => {
    let { state } = startHand({
      handNo: 1,
      seatCount: 2,
      players: [
        { id: "a", seat: 0, stack: 500 },
        { id: "b", seat: 1, stack: 500 },
      ],
      positions: initialPositions(0, [0, 1], 2),
      smallBlind: 5,
      bigBlind: 10,
      bigBlindAnte: 0,
      deck: createDeck(),
    });
    state = act(state, { type: "ACTION", playerId: "a", action: { action: "call" } });
    state = act(state, { type: "ACTION", playerId: "b", action: { action: "check" } });
    for (let street = 0; street < 2; street += 1) {
      const first = state.betting?.currentActorId;
      if (!first) throw new Error("Missing actor");
      state = act(state, { type: "ACTION", playerId: first, action: { action: "check" } });
      const second = state.betting?.currentActorId;
      if (!second) throw new Error("Missing actor");
      state = act(state, { type: "ACTION", playerId: second, action: { action: "check" } });
    }
    expect(state.phase).toBe("RIVER");
    const first = state.betting?.currentActorId;
    if (!first) throw new Error("Missing river actor");
    state = act(state, { type: "ACTION", playerId: first, action: { action: "all_in" } });
    const second = state.betting?.currentActorId;
    if (!second) throw new Error("Missing river caller");
    expect(currentLegalActions(state)?.call).toBeDefined();
    state = act(state, { type: "ACTION", playerId: second, action: { action: "call" } });
    expect(state.phase).toBe("HAND_COMPLETE");
    expect(state.boards).toHaveLength(1);
  });
});
