import { describe, expect, it } from "vitest";
import { initialPositions } from "../../../../packages/domain/src/button.js";
import { createDeck } from "../../../../packages/domain/src/cards.js";
import { reduceHand, startHand } from "../../../../packages/domain/src/reducer.js";
import { protocolFallbackAction, toDomainAction } from "./model-action.js";

function hand() {
  return startHand({
    handNo: 1,
    seatCount: 2,
    players: [{ id: "a", seat: 0, stack: 1_000 }, { id: "b", seat: 1, stack: 1_000 }],
    positions: initialPositions(0, [0, 1], 2),
    smallBlind: 5,
    bigBlind: 10,
    bigBlindAnte: 0,
    runItTwiceEnabled: true,
    deck: createDeck(),
  }).state;
}

describe("model action validation", () => {
  it("converts amount_to only inside authoritative bounds", () => {
    const state = hand();
    expect(toDomainAction(state, { type: "action", action: "raise", amount_to: 20 }))
      .toEqual({ action: "raise", amountTo: 20 });
    expect(() => toDomainAction(state, { type: "action", action: "raise", amount_to: 19 }))
      .toThrow(/legal range/);
    expect(() => toDomainAction(state, { type: "action", action: "check" }))
      .toThrow(/legal action/);
  });

  it("uses check-else-fold after the second protocol failure", () => {
    let state = hand();
    expect(protocolFallbackAction(state)).toEqual({ action: "fold" });
    state = reduceHand(state, {
      type: "ACTION",
      playerId: "a",
      action: { action: "call" },
    }).state;
    expect(protocolFallbackAction(state)).toEqual({ action: "check" });
  });
});
