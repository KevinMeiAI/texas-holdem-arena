import { cardCode } from "../../../../packages/domain/src/cards.js";
import { actionOrderAfter } from "../../../../packages/domain/src/button.js";
import { buildPots } from "../../../../packages/domain/src/pots.js";
import { currentLegalActions } from "../../../../packages/domain/src/reducer.js";
import { blindLevelAt, type TournamentState } from "../../../../packages/domain/src/tournament.js";
import type { ProjectedArenaEvent } from "../../../../packages/contracts/src/visibility.js";
import type { HistoryBudgetState } from "./history-budget.js";
import { toModelLegalActions } from "./model-legal-actions.js";

export interface ModelContextInput {
  tournamentId: string;
  rulesetVersion: string;
  promptVersion: string;
  contextVersion?: string;
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

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function publicCardCode(value: unknown): string | null {
  const card = objectValue(value);
  const rank = numericValue(card.rank);
  const suit = stringValue(card.suit);
  const rankSymbol = rank === 10 ? "T" : rank === 11 ? "J" : rank === 12 ? "Q" : rank === 13 ? "K" : rank === 14 ? "A" : String(rank);
  return /^[2-9TJQKA]$/.test(rankSymbol) && /^[cdhs]$/.test(suit ?? "")
    ? `${rankSymbol}${suit}`
    : null;
}

function compactActionHistory(
  state: TournamentState,
  events: readonly ProjectedArenaEvent[],
): unknown[] {
  const hand = state.currentHand;
  if (!hand) return [];
  const stackByPlayer = new Map(hand.players.map((player) => [player.id, player.startingStack]));
  let pot = 0;
  const history: unknown[] = [];
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const payload = objectValue(event.publicPayload);
    if (event.type === "FORCED_BET_POSTED") {
      const playerId = stringValue(payload.playerId);
      const amount = numericValue(payload.amount);
      if (!playerId) continue;
      pot += amount;
      const stackAfter = Math.max(0, (stackByPlayer.get(playerId) ?? 0) - amount);
      stackByPlayer.set(playerId, stackAfter);
      history.push({
        sequence: event.sequence,
        type: "forced_bet",
        player_id: playerId,
        kind: stringValue(payload.kind),
        amount,
        live: payload.live === true,
        pot_after: pot,
        stack_after: stackAfter,
      });
      continue;
    }
    if (event.type === "BETTING_ROUND_STARTED") {
      history.push({
        sequence: event.sequence,
        type: "street_started",
        street: stringValue(payload.street),
        first_actor_id: stringValue(payload.actorId),
      });
      continue;
    }
    if (event.type === "STREET_DEALT") {
      const cards = Array.isArray(payload.cards)
        ? payload.cards.map(publicCardCode).filter((card): card is string => card !== null)
        : [];
      history.push({
        sequence: event.sequence,
        type: "board_dealt",
        street: stringValue(payload.street),
        cards,
      });
      continue;
    }
    if (event.type === "ACTION_APPLIED") {
      const playerId = event.actorId;
      if (!playerId) continue;
      const paid = numericValue(payload.paid);
      pot += paid;
      const stackAfter = Math.max(0, (stackByPlayer.get(playerId) ?? 0) - paid);
      stackByPlayer.set(playerId, stackAfter);
      history.push({
        sequence: event.sequence,
        type: "action",
        street: stringValue(payload.street),
        player_id: playerId,
        action: stringValue(objectValue(payload.command).action),
        classification: stringValue(payload.classification),
        paid,
        amount_to: numericValue(payload.amountTo),
        pot_after: pot,
        stack_after: stackAfter,
      });
      continue;
    }
    if (event.type === "UNCALLED_BET_RETURNED") {
      const playerId = stringValue(payload.playerId);
      const amount = numericValue(payload.amount);
      if (!playerId) continue;
      pot = Math.max(0, pot - amount);
      const stackAfter = (stackByPlayer.get(playerId) ?? 0) + amount;
      stackByPlayer.set(playerId, stackAfter);
      history.push({
        sequence: event.sequence,
        type: "uncalled_bet_returned",
        player_id: playerId,
        amount,
        pot_after: pot,
        stack_after: stackAfter,
      });
    }
  }
  return history;
}

function tournamentContext(state: TournamentState) {
  const { levelIndex } = blindLevelAt(state);
  const handsUntilNextLevel = state.handsPerLevel - (state.completedHands % state.handsPerLevel);
  const next = blindLevelAt(state, state.completedHands + handsUntilNextLevel);
  const playersRemaining = state.currentHand?.players.length
    ?? state.players.filter((player) => player.status === "ACTIVE").length;
  const averageStack = state.totalChips / playersRemaining;
  const bigBlind = state.currentHand?.bigBlind ?? blindLevelAt(state).level.bigBlind;
  return {
    objective: "CHAMPION_ONLY",
    runout_policy: "SINGLE_BOARD",
    players_remaining: playersRemaining,
    total_chips: state.totalChips,
    average_stack: averageStack,
    average_stack_bb: averageStack / bigBlind,
    blind_level_number: levelIndex + 1,
    hands_until_next_level: handsUntilNextLevel,
    next_blind_level: {
      level_number: next.levelIndex + 1,
      small_blind: next.level.smallBlind,
      big_blind: next.level.bigBlind,
      big_blind_ante: next.level.bigBlindAnte,
    },
  };
}

function potContext(state: TournamentState, playerId: string) {
  const hand = state.currentHand;
  if (!hand) throw new Error("Tournament has no current hand");
  const hero = hand.players.find((player) => player.id === playerId);
  if (!hero) throw new Error("Model player is not active in the current hand");
  const legal = hand.betting?.currentActorId === playerId ? currentLegalActions(hand) : null;
  const totalBeforeAction = hand.players.reduce((sum, player) => sum + player.totalCommitted, 0);
  const callAmount = legal?.call?.amount ?? null;
  const totalAfterCall = callAmount === null ? null : totalBeforeAction + callAmount;
  const preview = buildPots(hand.players.map((player) => ({
    playerId: player.id,
    seat: player.seat,
    amount: player.totalCommitted - player.deadCommitted,
    deadAmount: player.deadCommitted,
    folded: player.folded,
  })));
  const opponents = hand.players.filter((player) => player.id !== playerId && !player.folded);
  return {
    total_before_action: totalBeforeAction,
    total_after_call: totalAfterCall,
    call_amount: callAmount,
    provisional_layers_if_closed_now: preview.pots.map((pot) => ({
      index: pot.index,
      amount: pot.amount,
      dead_amount: pot.deadAmount ?? 0,
      eligible_player_ids: pot.eligible,
    })),
    uncalled_returns_if_closed_now: preview.returned.map((item) => ({
      player_id: item.playerId,
      amount: item.amount,
    })),
    effective_stack_by_opponent: Object.fromEntries(opponents.map((opponent) => [
      opponent.id,
      Math.min(hero.stack, opponent.stack),
    ])),
    spr_before_action_by_opponent: Object.fromEntries(opponents.map((opponent) => [
      opponent.id,
      totalBeforeAction > 0 ? Math.min(hero.stack, opponent.stack) / totalBeforeAction : null,
    ])),
    spr_after_call_by_opponent: Object.fromEntries(opponents.map((opponent) => [
      opponent.id,
      totalAfterCall && callAmount !== null
        ? Math.min(Math.max(0, hero.stack - callAmount), opponent.stack) / totalAfterCall
        : null,
    ])),
  };
}

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
  const legacyV1 = input.contextVersion === "model-context-v1" || (!input.contextVersion && input.promptVersion === "arena-system-v1");
  const promptVersionNumber = Number(input.promptVersion.match(/^arena-system-v(\d+)$/)?.[1] ?? 0);
  const requestedContextVersion = input.contextVersion ?? (promptVersionNumber <= 1
    ? "model-context-v1"
    : promptVersionNumber >= 7 ? "model-context-v3" : "model-context-v2");
  if (!new Set(["model-context-v1", "model-context-v2", "model-context-v3", "model-context-v4"]).has(requestedContextVersion)) {
    throw new Error(`Unsupported model context version: ${requestedContextVersion}`);
  }
  const professionalContext = requestedContextVersion === "model-context-v3" || requestedContextVersion === "model-context-v4";
  const strictContext = requestedContextVersion === "model-context-v4";
  return {
    schema_version: requestedContextVersion,
    tournament_id: input.tournamentId,
    ruleset_version: input.rulesetVersion,
    prompt_version: input.promptVersion,
    hand_no: hand.handNo,
    completed_hands: input.state.completedHands,
    ...(professionalContext ? { tournament: tournamentContext(input.state) } : {}),
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
      ...(professionalContext ? {
        starting_stack: hero.startingStack,
        dead_committed: hero.deadCommitted,
      } : {}),
      street_committed: hero.streetCommitted,
      total_committed: hero.totalCommitted,
      hole_cards: hero.holeCards.map(cardCode),
    },
    ...(strictContext ? { opponents: hand.players.filter((player) => player.id !== input.playerId).map((player) => ({
      player_id: player.id,
      seat: player.seat,
      stack: player.stack,
      stack_bb: player.stack / hand.bigBlind,
      starting_stack: player.startingStack,
      dead_committed: player.deadCommitted,
      folded: player.folded,
      all_in: player.allIn,
      street_committed: player.streetCommitted,
      total_committed: player.totalCommitted,
    })) } : { players: hand.players.map((player) => ({
      player_id: player.id,
      seat: player.seat,
      stack: player.stack,
      stack_bb: player.stack / hand.bigBlind,
      ...(professionalContext ? {
        starting_stack: player.startingStack,
        dead_committed: player.deadCommitted,
      } : {}),
      folded: player.folded,
      all_in: player.allIn,
      street_committed: player.streetCommitted,
      total_committed: player.totalCommitted,
    })) }),
    ...(strictContext ? { board: hand.boards[0]?.map(cardCode) ?? [] } : { boards: hand.boards.map((board) => board.map(cardCode)) }),
    ...(professionalContext ? { pot: potContext(input.state, input.playerId) } : { pots: hand.pots }),
    betting: hand.betting ? {
      street: hand.betting.street,
      current_actor_id: hand.betting.currentActorId,
      current_bet: hand.betting.currentBet,
      last_full_raise_size: hand.betting.lastFullRaiseSize,
      ...(professionalContext ? { last_aggressor_id: hand.betting.lastAggressorId ?? null } : {}),
      call_amount: legal?.call?.amount ?? 0,
    } : null,
    legal_actions: strictContext ? toModelLegalActions(legal) : legal,
    ...(professionalContext
      ? { action_history: compactActionHistory(input.state, input.currentHandEvents) }
      : { current_hand_events: input.currentHandEvents }),
    ...(professionalContext ? {} : { history_budget: input.historyBudget }),
  };
}
