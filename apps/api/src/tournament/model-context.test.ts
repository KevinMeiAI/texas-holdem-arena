import { describe, expect, it } from "vitest";
import { cardCode, createDeck } from "../../../../packages/domain/src/cards.js";
import { createTournament, startTournamentHand } from "../../../../packages/domain/src/tournament.js";
import { HistoryBudget } from "./history-budget.js";
import { buildModelContext } from "./model-context.js";

describe("model-self context projection", () => {
  it("includes the hero hand but never an opponent's private cards or deck", () => {
    let state = createTournament({
      seatCount: 2,
      players: [{ id: "hero", seat: 0 }, { id: "villain", seat: 1 }],
      initialStack: 1_000,
      initialButton: 0,
      handsPerLevel: 10,
      blindLevels: [{ smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 }],
      runItTwiceEnabled: true,
    });
    state = startTournamentHand(state, createDeck()).state;
    const hand = state.currentHand!;
    const heroCodes = hand.players.find((player) => player.id === "hero")!.holeCards.map(cardCode);
    const villainCodes = hand.players.find((player) => player.id === "villain")!.holeCards.map(cardCode);
    const budget = new HistoryBudget({ maxQueries: 2, maxEventsPerQuery: 80, maxApproxTokens: 4_000 });
    const serialized = JSON.stringify(buildModelContext({
      tournamentId: "11111111-1111-4111-8111-111111111111",
      rulesetVersion: "arena-rules-v1",
      promptVersion: "arena-system-v1",
      state,
      playerId: "hero",
      currentHandEvents: [],
      historyBudget: budget.state,
    }));
    for (const code of heroCodes) expect(serialized).toContain(code);
    for (const code of villainCodes) expect(serialized).not.toContain(code);
    expect(serialized).not.toContain("nextCardIndex");
    expect(serialized).not.toContain("burnCards");
  });
});
