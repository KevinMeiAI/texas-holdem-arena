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
    runItTwiceEnabled: true,
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
      runItTwiceEnabled: true,
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
      runItTwiceEnabled: false,
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

  it("runs two complete boards sequentially after unanimous preflop all-in consent", () => {
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
      runItTwiceEnabled: true,
      deck: createDeck(),
    });
    state = act(state, { type: "ACTION", playerId: "a", action: { action: "all_in" } });
    state = act(state, { type: "ACTION", playerId: "b", action: { action: "call" } });
    expect(state.phase).toBe("RUNOUT_VOTE");
    expect(state.runoutVote?.order).toEqual(["b", "a"]);
    state = reduceHand(state, {
      type: "RUNOUT_VOTE",
      playerId: "b",
      vote: { acceptRunItTwice: true, message: "twice" },
    }).state;
    state = reduceHand(state, {
      type: "RUNOUT_VOTE",
      playerId: "a",
      vote: { acceptRunItTwice: true },
    }).state;
    expect(state.phase).toBe("HAND_COMPLETE");
    expect(state.boards).toHaveLength(2);
    expect(state.boards[0]).toHaveLength(5);
    expect(state.boards[1]).toHaveLength(5);
    expect(state.burnCards).toHaveLength(6);
    expect(state.nextCardIndex).toBe(20);
    expect(Object.values(state.result?.stacks ?? {}).reduce((sum, stack) => sum + stack, 0)).toBe(200);
    expect(state.awards.reduce((sum, award) => sum + award.amount, 0)).toBe(200);
  });

  it("uses one board after any runout rejection", () => {
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
      runItTwiceEnabled: true,
      deck: createDeck(),
    });
    state = act(state, { type: "ACTION", playerId: "a", action: { action: "all_in" } });
    state = act(state, { type: "ACTION", playerId: "b", action: { action: "call" } });
    state = reduceHand(state, {
      type: "RUNOUT_VOTE",
      playerId: "b",
      vote: { acceptRunItTwice: false },
    }).state;
    state = reduceHand(state, {
      type: "RUNOUT_VOTE",
      playerId: "a",
      vote: { acceptRunItTwice: true },
    }).state;
    expect(state.phase).toBe("HAND_COMPLETE");
    expect(state.boards).toHaveLength(1);
    expect(state.burnCards).toHaveLength(3);
  });

  it.each([
    { street: "FLOP", checks: 0, shared: 3, burns: 5, consumed: 16 },
    { street: "TURN", checks: 1, shared: 4, burns: 4, consumed: 14 },
  ] as const)("shares the already-dealt $street before completing two runouts", ({ checks, shared, burns, consumed }) => {
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
      runItTwiceEnabled: true,
      deck: createDeck(),
    });
    state = act(state, { type: "ACTION", playerId: "a", action: { action: "call" } });
    state = act(state, { type: "ACTION", playerId: "b", action: { action: "check" } });
    for (let index = 0; index < checks; index += 1) {
      state = act(state, { type: "ACTION", playerId: "b", action: { action: "check" } });
      state = act(state, { type: "ACTION", playerId: "a", action: { action: "check" } });
    }
    expect(state.boards[0]).toHaveLength(shared);
    const actor = state.betting?.currentActorId;
    if (!actor) throw new Error("Missing all-in actor");
    state = act(state, { type: "ACTION", playerId: actor, action: { action: "all_in" } });
    const caller = state.betting?.currentActorId;
    if (!caller) throw new Error("Missing all-in caller");
    state = act(state, { type: "ACTION", playerId: caller, action: { action: "call" } });
    const firstVoter = state.runoutVote?.currentVoterId;
    if (!firstVoter) throw new Error("Missing first voter");
    state = reduceHand(state, {
      type: "RUNOUT_VOTE",
      playerId: firstVoter,
      vote: { acceptRunItTwice: true },
    }).state;
    const secondVoter = state.runoutVote?.currentVoterId;
    if (!secondVoter) throw new Error("Missing second voter");
    state = reduceHand(state, {
      type: "RUNOUT_VOTE",
      playerId: secondVoter,
      vote: { acceptRunItTwice: true },
    }).state;
    expect(state.phase).toBe("HAND_COMPLETE");
    expect(state.sharedBoardCount).toBe(shared);
    expect(state.boards[0]?.slice(0, shared)).toEqual(state.boards[1]?.slice(0, shared));
    expect(state.burnCards).toHaveLength(burns);
    expect(state.nextCardIndex).toBe(consumed);
  });

  it("never negotiates runouts after the river is already dealt", () => {
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
      runItTwiceEnabled: true,
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
    expect(state.runoutVote).toBeNull();
  });
});
