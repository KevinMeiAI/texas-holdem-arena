import { cardCode } from "../../../../packages/domain/src/cards.js";
import { currentLegalActions } from "../../../../packages/domain/src/reducer.js";
import type { TournamentState } from "../../../../packages/domain/src/tournament.js";
import type { ProjectedArenaEvent } from "../../../../packages/contracts/src/visibility.js";
import type { HistoryBudgetState } from "./history-budget.js";

export interface ModelContextInput {
  tournamentId: string;
  rulesetVersion: string;
  promptVersion: string;
  state: TournamentState;
  playerId: string;
  currentHandEvents: ProjectedArenaEvent[];
  historyBudget: HistoryBudgetState;
  priorRunoutMessages?: { playerId: string; message: string }[];
}

export function buildModelContext(input: ModelContextInput): unknown {
  const hand = input.state.currentHand;
  if (!hand) throw new Error("Tournament has no current hand");
  const hero = hand.players.find((player) => player.id === input.playerId);
  if (!hero) throw new Error("Model player is not active in the current hand");
  const legal = hand.betting?.currentActorId === input.playerId ? currentLegalActions(hand) : null;
  return {
    schema_version: "model-context-v1",
    tournament_id: input.tournamentId,
    ruleset_version: input.rulesetVersion,
    prompt_version: input.promptVersion,
    hand_no: hand.handNo,
    completed_hands: input.state.completedHands,
    phase: hand.phase,
    blinds: {
      small_blind: hand.smallBlind,
      big_blind: hand.bigBlind,
      big_blind_ante: hand.bigBlindAnte,
    },
    positions: hand.positions,
    hero: {
      player_id: hero.id,
      seat: hero.seat,
      stack: hero.stack,
      stack_bb: hero.stack / hand.bigBlind,
      street_committed: hero.streetCommitted,
      total_committed: hero.totalCommitted,
      hole_cards: hero.holeCards.map(cardCode),
    },
    players: hand.players.map((player) => ({
      player_id: player.id,
      seat: player.seat,
      stack: player.stack,
      stack_bb: player.stack / hand.bigBlind,
      folded: player.folded,
      all_in: player.allIn,
      street_committed: player.streetCommitted,
      total_committed: player.totalCommitted,
    })),
    boards: hand.boards.map((board) => board.map(cardCode)),
    pots: hand.pots,
    betting: hand.betting ? {
      street: hand.betting.street,
      current_actor_id: hand.betting.currentActorId,
      current_bet: hand.betting.currentBet,
      last_full_raise_size: hand.betting.lastFullRaiseSize,
      call_amount: legal?.call?.amount ?? 0,
    } : null,
    legal_actions: legal,
    runout_negotiation: hand.phase === "RUNOUT_VOTE" ? {
      current_voter_id: hand.runoutVote?.currentVoterId,
      prior_messages: input.priorRunoutMessages ?? [],
    } : null,
    current_hand_events: input.currentHandEvents,
    history_budget: input.historyBudget,
  };
}
