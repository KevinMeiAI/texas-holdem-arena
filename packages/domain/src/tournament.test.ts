import { describe, expect, it } from "vitest";
import { createDeck, parseCard, cardCode, type Card } from "./cards.js";
import type { ActionCommand } from "./betting.js";
import { currentLegalActions } from "./reducer.js";
import {
  createTournament,
  reduceTournament,
  startTournamentHand,
  type TournamentState,
} from "./tournament.js";
import { DeterministicRng } from "../../fairness/src/rng.js";

function deckWithPrefix(codes: string): Card[] {
  const prefix = codes.split(" ").map(parseCard);
  const used = new Set(prefix.map(cardCode));
  return [...prefix, ...createDeck().filter((card) => !used.has(cardCode(card)))];
}

function actionOptions(state: TournamentState): ActionCommand[] {
  const legal = currentLegalActions(state.currentHand!);
  if (!legal) throw new Error("Missing legal actions");
  const result: ActionCommand[] = [];
  if (legal.check) result.push({ action: "check" });
  if (legal.call) result.push({ action: "call" });
  if (legal.fold) result.push({ action: "fold" });
  if (legal.bet) result.push({ action: "bet", amountTo: legal.bet.minAmountTo });
  if (legal.raise) result.push({ action: "raise", amountTo: legal.raise.minAmountTo });
  if (legal.allIn) result.push({ action: "all_in" });
  return result;
}

describe("single-table tournament reducer", () => {
  it("advances blind levels by completed hands and enables the configured BBA", () => {
    let state = createTournament({
      seatCount: 2,
      players: [{ id: "a", seat: 0 }, { id: "b", seat: 1 }],
      initialStack: 100,
      initialButton: 0,
      handsPerLevel: 1,
      blindLevels: [
        { smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 },
        { smallBlind: 10, bigBlind: 20, bigBlindAnte: 20 },
      ],
      runItTwiceEnabled: true,
    });
    state = startTournamentHand(state, createDeck()).state;
    state = reduceTournament(state, {
      type: "ACTION",
      playerId: "a",
      action: { action: "fold" },
    }).state;
    expect(state.completedHands).toBe(1);
    state = startTournamentHand(state, createDeck()).state;
    expect(state.currentHand).toMatchObject({
      handNo: 2,
      smallBlind: 10,
      bigBlind: 20,
      bigBlindAnte: 20,
    });
  });

  it("awards one champion and tied places for equal-stack same-hand eliminations", () => {
    let state = createTournament({
      seatCount: 3,
      players: [
        { id: "a", seat: 0 },
        { id: "b", seat: 1 },
        { id: "c", seat: 2 },
      ],
      initialStack: 20,
      initialButton: 0,
      handsPerLevel: 10,
      blindLevels: [{ smallBlind: 1, bigBlind: 2, bigBlindAnte: 0 }],
      runItTwiceEnabled: false,
    });
    state = startTournamentHand(state, deckWithPrefix(
      "Kc Qc As Kd Qd Ah 3h 2h 4c 7d 8c 9s Ts Jc",
    )).state;
    state = reduceTournament(state, {
      type: "ACTION",
      playerId: "a",
      action: { action: "all_in" },
    }).state;
    state = reduceTournament(state, {
      type: "ACTION",
      playerId: "b",
      action: { action: "call" },
    }).state;
    state = reduceTournament(state, {
      type: "ACTION",
      playerId: "c",
      action: { action: "call" },
    }).state;
    expect(state.status).toBe("COMPLETED");
    expect(state.championPlayerId).toBe("a");
    expect(state.players.find((player) => player.id === "a")).toMatchObject({
      status: "CHAMPION",
      stack: 60,
      finishingPosition: 1,
    });
    expect(state.players.filter((player) => player.status === "ELIMINATED")).toEqual([
      expect.objectContaining({ id: "b", finishingPosition: 2, tieGroup: "1:20" }),
      expect.objectContaining({ id: "c", finishingPosition: 2, tieGroup: "1:20" }),
    ]);
  });

  it("completes 10,000 deterministic scripted tournaments without invariant failure", () => {
    const rng = new DeterministicRng(new Uint8Array(32).fill(19));
    for (let tournamentNo = 0; tournamentNo < 10_000; tournamentNo += 1) {
      const playerCount = 2 + rng.int(8);
      let state = createTournament({
        seatCount: playerCount,
        players: Array.from({ length: playerCount }, (_, seat) => ({ id: `p${seat}`, seat })),
        initialStack: 40,
        initialButton: rng.int(playerCount),
        handsPerLevel: 1,
        blindLevels: [
          { smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 },
          { smallBlind: 10, bigBlind: 20, bigBlindAnte: 20 },
        ],
        runItTwiceEnabled: true,
      });
      let commandCount = 0;
      while (state.status !== "COMPLETED") {
        if (!state.currentHand) {
          state = startTournamentHand(state, rng.shuffle(createDeck())).state;
          continue;
        }
        if (state.currentHand.phase === "RUNOUT_VOTE") {
          const playerId = state.currentHand.runoutVote?.currentVoterId;
          if (!playerId) throw new Error("Missing runout voter");
          state = reduceTournament(state, {
            type: "RUNOUT_VOTE",
            playerId,
            vote: { acceptRunItTwice: rng.int(3) !== 0 },
          }).state;
        } else {
          const playerId = state.currentHand.betting?.currentActorId;
          if (!playerId) throw new Error("Missing betting actor");
          const options = actionOptions(state);
          const action = options[rng.int(options.length)];
          if (!action) throw new Error("No scripted action available");
          state = reduceTournament(state, { type: "ACTION", playerId, action }).state;
        }
        commandCount += 1;
        if (commandCount > 2_000) throw new Error(`Tournament ${tournamentNo} did not terminate`);
      }
      expect(state.players.filter((player) => player.status === "CHAMPION")).toHaveLength(1);
      expect(state.players.reduce((sum, player) => sum + player.stack, 0)).toBe(40 * playerCount);
    }
  }, 120_000);
});
