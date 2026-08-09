import { assertUniqueCards, cardCode } from "./cards.js";
import type { HandState } from "./reducer.js";

function assertChips(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

export function assertHandInvariants(state: HandState): void {
  assertUniqueCards(state.deck);
  if (state.deck.length !== 52) throw new Error("A hand deck must contain 52 cards");

  const physicalBoardCards = state.boards.flatMap((board, index) => (
    index === 0 ? board : board.slice(state.sharedBoardCount)
  ));
  const usedCards = [
    ...state.players.flatMap((player) => player.holeCards),
    ...state.burnCards,
    ...physicalBoardCards,
  ];
  assertUniqueCards(usedCards);
  if (usedCards.length !== state.nextCardIndex) {
    throw new Error("Deck cursor does not match physically consumed cards");
  }
  const deckPrefix = state.deck.slice(0, state.nextCardIndex).map(cardCode).sort();
  const usedCodes = usedCards.map(cardCode).sort();
  if (deckPrefix.join(",") !== usedCodes.join(",")) {
    throw new Error("Consumed cards do not match the committed deck prefix");
  }
  if (state.boards.length === 2) {
    const firstPrefix = state.boards[0]!.slice(0, state.sharedBoardCount).map(cardCode);
    const secondPrefix = state.boards[1]!.slice(0, state.sharedBoardCount).map(cardCode);
    if (firstPrefix.join(",") !== secondPrefix.join(",")) {
      throw new Error("Run-it-twice boards must share their already-dealt prefix");
    }
  }

  const ids = state.players.map((player) => player.id);
  const seats = state.players.map((player) => player.seat);
  if (new Set(ids).size !== ids.length || new Set(seats).size !== seats.length) {
    throw new Error("Hand players must have unique IDs and seats");
  }
  for (const player of state.players) {
    assertChips(player.stack, `${player.id}.stack`);
    assertChips(player.streetCommitted, `${player.id}.streetCommitted`);
    assertChips(player.totalCommitted, `${player.id}.totalCommitted`);
    assertChips(player.deadCommitted, `${player.id}.deadCommitted`);
    if (player.streetCommitted > player.totalCommitted) {
      throw new Error("Street contribution cannot exceed total contribution");
    }
    if (player.deadCommitted > player.totalCommitted) {
      throw new Error("Dead contribution cannot exceed total contribution");
    }
    if (player.allIn !== (player.stack === 0)) {
      throw new Error("All-in flag must exactly match a zero stack");
    }
  }

  const startingTotal = state.players.reduce((sum, player) => sum + player.startingStack, 0);
  const liveTotal = state.players.reduce(
    (sum, player) => sum + player.stack + player.totalCommitted,
    0,
  );
  if (liveTotal !== startingTotal) throw new Error("Hand chip conservation failed");
  if (state.phase === "HAND_COMPLETE"
    && state.players.some((player) => player.totalCommitted !== 0 || player.deadCommitted !== 0)) {
    throw new Error("Completed hands cannot retain unsettled contributions");
  }
}
