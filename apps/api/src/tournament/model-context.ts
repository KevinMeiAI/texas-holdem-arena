import { cardCode } from "../../../../packages/domain/src/cards.js";
import { actionOrderAfter } from "../../../../packages/domain/src/button.js";
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
}

const NON_BLIND_POSITION_LABELS: Readonly<Record<number, readonly string[]>> = {
  2: [],
  3: [],
  4: ["CO"],
  5: ["HJ", "CO"],
  6: ["LJ", "HJ", "CO"],
  7: ["UTG", "LJ", "HJ", "CO"],
  8: ["UTG", "UTG+1", "LJ", "HJ", "CO"],
  9: ["UTG", "UTG+1", "MP", "LJ", "HJ", "CO"],
};

function positionContext(state: TournamentState, playerId: string) {
  const hand = state.currentHand;
  if (!hand) throw new Error("Tournament has no current hand");
  const activeSeats = hand.players.map((player) => player.seat);
  const playerIdBySeat = new Map(hand.players.map((player) => [player.seat, player.id]));
  const preflopActionOrder = actionOrderAfter(hand.positions.bigBlind, activeSeats, hand.seatCount)
    .map((seat) => playerIdBySeat.get(seat)!)
    .filter(Boolean);
  const postflopActionOrder = actionOrderAfter(hand.positions.button, activeSeats, hand.seatCount)
    .map((seat) => playerIdBySeat.get(seat)!)
    .filter(Boolean);
  const deadButton = !hand.positions.headsUp && !activeSeats.includes(hand.positions.button);
  const nominalTableSize = hand.players.length + (deadButton ? 1 : 0);
  const nonBlindLabels = NON_BLIND_POSITION_LABELS[nominalTableSize];
  if (!nonBlindLabels) throw new Error(`Unsupported positional table size: ${nominalTableSize}`);
  const nonBlindPlayerIds = preflopActionOrder.filter((id) => {
    const seat = hand.players.find((player) => player.id === id)?.seat;
    return seat !== undefined
      && seat !== hand.positions.button
      && seat !== hand.positions.smallBlind
      && seat !== hand.positions.bigBlind;
  });
  if (nonBlindPlayerIds.length !== nonBlindLabels.length) {
    throw new Error("Positional labels do not match active tournament seats");
  }
  const labelByPlayerId = new Map(nonBlindPlayerIds.map((id, index) => [id, nonBlindLabels[index]!]));
  for (const player of hand.players) {
    if (hand.positions.headsUp && player.seat === hand.positions.button) {
      labelByPlayerId.set(player.id, "BTN/SB");
    } else if (player.seat === hand.positions.smallBlind) {
      labelByPlayerId.set(player.id, "SB");
    } else if (player.seat === hand.positions.bigBlind) {
      labelByPlayerId.set(player.id, "BB");
    } else if (player.seat === hand.positions.button) {
      labelByPlayerId.set(player.id, "BTN");
    }
  }
  const byPlayer = hand.players.map((player) => ({
    player_id: player.id,
    seat: player.seat,
    position: labelByPlayerId.get(player.id) ?? "UNKNOWN",
    preflop_order_index: preflopActionOrder.indexOf(player.id) + 1,
    postflop_order_index: postflopActionOrder.indexOf(player.id) + 1,
  }));
  return {
    button_seat: hand.positions.button,
    small_blind_seat: hand.positions.smallBlind,
    big_blind_seat: hand.positions.bigBlind,
    heads_up: hand.positions.headsUp,
    dead_button: deadButton,
    hero_position: labelByPlayerId.get(playerId) ?? "UNKNOWN",
    by_player: byPlayer,
    preflop_action_order: preflopActionOrder,
    postflop_action_order: postflopActionOrder,
  };
}

export function buildModelContext(input: ModelContextInput): unknown {
  const hand = input.state.currentHand;
  if (!hand) throw new Error("Tournament has no current hand");
  const hero = hand.players.find((player) => player.id === input.playerId);
  if (!hero) throw new Error("Model player is not active in the current hand");
  const legal = hand.betting?.currentActorId === input.playerId ? currentLegalActions(hand) : null;
  const legacyV1 = input.promptVersion === "arena-system-v1";
  return {
    schema_version: legacyV1 ? "model-context-v1" : "model-context-v2",
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
    positions: legacyV1 ? hand.positions : positionContext(input.state, input.playerId),
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
    current_hand_events: input.currentHandEvents,
    history_budget: input.historyBudget,
  };
}
