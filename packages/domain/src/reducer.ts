import { actionOrderAfter, type HandPositions } from "./button.js";
import { assertUniqueCards, type Card } from "./cards.js";
import {
  applyAction,
  createBettingRound,
  legalActions,
  type ActionCommand,
  type BettingRound,
  type Street,
} from "./betting.js";
import { compareHandRanks, evaluateBest, type HandRank } from "./evaluator.js";
import { assertHandInvariants } from "./invariants.js";
import { awardPots, buildPots, type PotAward, type PotLayer, type RankedPlayer } from "./pots.js";
export type HandPhase = Street | "SHOWDOWN" | "HAND_COMPLETE";

export interface HandPlayerInput {
  id: string;
  seat: number;
  stack: number;
}

export interface HandPlayer extends HandPlayerInput {
  startingStack: number;
  folded: boolean;
  allIn: boolean;
  holeCards: [Card, Card];
  streetCommitted: number;
  totalCommitted: number;
  deadCommitted: number;
}

export interface HandConfig {
  handNo: number;
  seatCount: number;
  players: HandPlayerInput[];
  positions: HandPositions;
  smallBlind: number;
  bigBlind: number;
  bigBlindAnte: number;
  deck: Card[];
}

export interface ShowdownRank {
  playerId: string;
  boardIndex: number;
  rank: HandRank;
}

export interface HandResult {
  stacks: Record<string, number>;
  eliminatedPlayerIds: string[];
  winnerPlayerIds: string[];
}

export interface HandState {
  handNo: number;
  seatCount: number;
  positions: HandPositions;
  smallBlind: number;
  bigBlind: number;
  bigBlindAnte: number;
  phase: HandPhase;
  players: HandPlayer[];
  deck: Card[];
  nextCardIndex: number;
  burnCards: Card[];
  boards: Card[][];
  betting: BettingRound | null;
  pots: PotLayer[];
  returned: { playerId: string; amount: number }[];
  awards: PotAward[];
  showdown: ShowdownRank[];
  result: HandResult | null;
}

export type HandEvent =
  | { type: "HAND_STARTED"; handNo: number; positions: HandPositions }
  | { type: "FORCED_BET_POSTED"; playerId: string; kind: "SMALL_BLIND" | "BIG_BLIND" | "BIG_BLIND_ANTE"; amount: number; live: boolean }
  | { type: "HOLE_CARDS_DEALT"; playerId: string; cards: [Card, Card] }
  | { type: "BETTING_ROUND_STARTED"; street: Street; actorId: string; currentBet: number }
  | { type: "ACTION_APPLIED"; street: Street; playerId: string; command: ActionCommand; classification: "fold" | "check" | "call" | "bet" | "raise" | "short_raise"; paid: number; amountTo: number }
  | { type: "STREET_DEALT"; boardIndex: number; street: Exclude<Street, "PREFLOP">; burn: Card; cards: Card[] }
  | { type: "SHOWDOWN_REVEALED"; players: { playerId: string; cards: [Card, Card] }[] }
  | { type: "UNCALLED_BET_RETURNED"; playerId: string; amount: number }
  | { type: "POT_CREATED"; pot: PotLayer }
  | { type: "POT_AWARDED"; award: PotAward }
  | { type: "HAND_COMPLETED"; result: HandResult };

export interface HandTransition {
  state: HandState;
  events: HandEvent[];
}

export type HandCommand = { type: "ACTION"; playerId: string; action: ActionCommand };

function assertPositiveChipAmount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function drawCard(state: HandState): Card {
  const card = state.deck[state.nextCardIndex];
  if (!card) throw new Error("The committed deck is exhausted");
  state.nextCardIndex += 1;
  return card;
}

function playerById(state: HandState, playerId: string): HandPlayer {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error(`Unknown hand player: ${playerId}`);
  return player;
}

function postForcedBet(
  state: HandState,
  events: HandEvent[],
  player: HandPlayer,
  amount: number,
  kind: "SMALL_BLIND" | "BIG_BLIND" | "BIG_BLIND_ANTE",
  live: boolean,
): void {
  const paid = Math.min(amount, player.stack);
  player.stack -= paid;
  player.totalCommitted += paid;
  if (live) player.streetCommitted += paid;
  else player.deadCommitted += paid;
  player.allIn = player.stack === 0;
  events.push({ type: "FORCED_BET_POSTED", playerId: player.id, kind, amount: paid, live });
}

function nextStreetForBoard(board: readonly Card[]): Exclude<Street, "PREFLOP"> {
  if (board.length === 0) return "FLOP";
  if (board.length === 3) return "TURN";
  if (board.length === 4) return "RIVER";
  throw new Error("Board is already complete or has an invalid length");
}

function dealNextStreet(state: HandState, events: HandEvent[], boardIndex: number): void {
  const board = state.boards[boardIndex];
  if (!board) throw new Error("Unknown board");
  const street = nextStreetForBoard(board);
  const burn = drawCard(state);
  state.burnCards.push(burn);
  const count = street === "FLOP" ? 3 : 1;
  const cards = Array.from({ length: count }, () => drawCard(state));
  board.push(...cards);
  if (boardIndex === 0) state.phase = street;
  events.push({ type: "STREET_DEALT", boardIndex, street, burn, cards });
}

function resetStreetContributions(state: HandState): void {
  for (const player of state.players) player.streetCommitted = 0;
}

function actionableContenders(state: HandState): HandPlayer[] {
  return state.players.filter((player) => !player.folded && !player.allIn);
}

function beginBettingRound(
  state: HandState,
  events: HandEvent[],
  street: Street,
  anchorSeat: number,
  currentBet: number,
): void {
  const actionOrder = actionOrderAfter(
    anchorSeat,
    state.players.filter((player) => !player.folded).map((player) => player.seat),
    state.seatCount,
  );
  const actor = actionOrder
    .map((seat) => state.players.find((player) => player.seat === seat))
    .find((player) => player && !player.folded && !player.allIn);
  if (!actor) throw new Error("A betting round requires an actionable player");

  state.betting = createBettingRound({
    street,
    bigBlind: state.bigBlind,
    currentBet,
    lastFullRaiseSize: state.bigBlind,
    players: state.players.map((player) => ({
      id: player.id,
      seat: player.seat,
      stack: player.stack,
      committed: player.streetCommitted,
      folded: player.folded,
      allIn: player.allIn,
      actedSinceFullRaise: false,
    })),
    currentActorId: actor.id,
    lastAggressorId: undefined,
  });
  state.phase = street;
  events.push({ type: "BETTING_ROUND_STARTED", street, actorId: actor.id, currentBet });
}

function normalizeUncalledContribution(state: HandState, events: HandEvent[]): void {
  const built = buildPots(state.players.map((player) => ({
    playerId: player.id,
    seat: player.seat,
    amount: player.totalCommitted - player.deadCommitted,
    deadAmount: player.deadCommitted,
    folded: player.folded,
  })));
  for (const item of built.returned) {
    const player = playerById(state, item.playerId);
    player.stack += item.amount;
    player.totalCommitted -= item.amount;
    player.streetCommitted = Math.max(0, player.streetCommitted - item.amount);
    player.allIn = player.stack === 0;
    state.returned.push(item);
    events.push({ type: "UNCALLED_BET_RETURNED", ...item });
  }
}

function completeSettlement(
  state: HandState,
  events: HandEvent[],
  awards: PotAward[],
): void {
  state.awards.push(...awards);
  for (const award of awards) {
    playerById(state, award.playerId).stack += award.amount;
    events.push({ type: "POT_AWARDED", award });
  }
  for (const player of state.players) {
    player.streetCommitted = 0;
    player.totalCommitted = 0;
    player.deadCommitted = 0;
    player.allIn = player.stack === 0;
  }
  const result: HandResult = {
    stacks: Object.fromEntries(state.players.map((player) => [player.id, player.stack])),
    eliminatedPlayerIds: state.players.filter((player) => player.stack === 0).map((player) => player.id),
    winnerPlayerIds: [...new Set(awards.map((award) => award.playerId))],
  };
  state.phase = "HAND_COMPLETE";
  state.betting = null;
  state.result = result;
  events.push({ type: "HAND_COMPLETED", result });
}

function createPots(state: HandState, events: HandEvent[]): PotLayer[] {
  const { pots } = buildPots(state.players.map((player) => ({
    playerId: player.id,
    seat: player.seat,
    amount: player.totalCommitted - player.deadCommitted,
    deadAmount: player.deadCommitted,
    folded: player.folded,
  })));
  state.pots = pots;
  for (const pot of pots) events.push({ type: "POT_CREATED", pot });
  return pots;
}

function settleUncontested(state: HandState, events: HandEvent[]): void {
  normalizeUncalledContribution(state, events);
  const winner = state.players.find((player) => !player.folded);
  if (!winner) throw new Error("An uncontested hand must have one winner");
  const pots = createPots(state, events);
  completeSettlement(state, events, pots.map((pot) => ({
    potIndex: pot.index,
    boardIndex: 0,
    playerId: winner.id,
    amount: pot.amount,
  })));
}

function settleShowdown(state: HandState, events: HandEvent[]): void {
  normalizeUncalledContribution(state, events);
  state.phase = "SHOWDOWN";
  const contenders = state.players.filter((player) => !player.folded);
  events.push({
    type: "SHOWDOWN_REVEALED",
    players: contenders.map((player) => ({ playerId: player.id, cards: player.holeCards })),
  });
  const pots = createPots(state, events);
  const rankedPlayers: RankedPlayer[] = contenders.map((player) => {
    const rank = evaluateBest([...player.holeCards, ...state.boards[0]!]);
    state.showdown.push({ playerId: player.id, boardIndex: 0, rank });
    return { playerId: player.id, seat: player.seat, rank };
  });
  const awards = awardPots(
    pots,
    rankedPlayers,
    (left, right) => compareHandRanks(left as HandRank, right as HandRank),
    state.positions.button,
    state.seatCount,
  );
  completeSettlement(state, events, awards);
}

function completeSingleRunout(state: HandState, events: HandEvent[]): void {
  while (state.boards[0]!.length < 5) dealNextStreet(state, events, 0);
  settleShowdown(state, events);
}

function runOutBoardAndShowDown(state: HandState, events: HandEvent[]): void {
  normalizeUncalledContribution(state, events);
  if (state.boards[0]!.length === 5) {
    settleShowdown(state, events);
    return;
  }
  completeSingleRunout(state, events);
}

function advanceAfterBetting(state: HandState, events: HandEvent[]): void {
  if (state.betting?.uncontestedWinnerId) {
    settleUncontested(state, events);
    return;
  }
  if (state.phase === "RIVER") {
    settleShowdown(state, events);
    return;
  }
  if (actionableContenders(state).length < 2) {
    runOutBoardAndShowDown(state, events);
    return;
  }
  resetStreetContributions(state);
  dealNextStreet(state, events, 0);
  beginBettingRound(state, events, state.phase as Street, state.positions.button, 0);
}

export function startHand(config: HandConfig): HandTransition {
  if (!Number.isSafeInteger(config.handNo) || config.handNo <= 0) throw new Error("handNo must be positive");
  if (!Number.isSafeInteger(config.seatCount) || config.seatCount < 2 || config.seatCount > 9) {
    throw new Error("seatCount must be between 2 and 9");
  }
  if (config.players.length < 2 || config.players.length > config.seatCount) {
    throw new Error("A hand requires 2-seatCount active players");
  }
  assertPositiveChipAmount(config.smallBlind, "smallBlind");
  assertPositiveChipAmount(config.bigBlind, "bigBlind");
  if (!Number.isSafeInteger(config.bigBlindAnte) || config.bigBlindAnte < 0) {
    throw new Error("bigBlindAnte must be a non-negative integer");
  }
  if (config.smallBlind > config.bigBlind) throw new Error("smallBlind cannot exceed bigBlind");
  if (config.deck.length !== 52) throw new Error("A hand deck must contain 52 cards");
  assertUniqueCards(config.deck);
  if (new Set(config.players.map((player) => player.id)).size !== config.players.length
    || new Set(config.players.map((player) => player.seat)).size !== config.players.length) {
    throw new Error("Hand player IDs and seats must be unique");
  }
  for (const player of config.players) assertPositiveChipAmount(player.stack, `${player.id}.stack`);
  const activeSeats = config.players.map((player) => player.seat);
  if (!activeSeats.includes(config.positions.smallBlind) || !activeSeats.includes(config.positions.bigBlind)) {
    throw new Error("Blind positions must belong to active players");
  }

  const state: HandState = {
    handNo: config.handNo,
    seatCount: config.seatCount,
    positions: { ...config.positions },
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
    bigBlindAnte: config.bigBlindAnte,
    phase: "PREFLOP",
    players: config.players.map((player) => ({
      ...player,
      startingStack: player.stack,
      folded: false,
      allIn: false,
      holeCards: [] as unknown as [Card, Card],
      streetCommitted: 0,
      totalCommitted: 0,
      deadCommitted: 0,
    })),
    deck: [...config.deck],
    nextCardIndex: 0,
    burnCards: [],
    boards: [[]],
    betting: null,
    pots: [],
    returned: [],
    awards: [],
    showdown: [],
    result: null,
  };
  const events: HandEvent[] = [{ type: "HAND_STARTED", handNo: state.handNo, positions: state.positions }];
  const smallBlindPlayer = state.players.find((player) => player.seat === state.positions.smallBlind)!;
  const bigBlindPlayer = state.players.find((player) => player.seat === state.positions.bigBlind)!;
  postForcedBet(state, events, smallBlindPlayer, state.smallBlind, "SMALL_BLIND", true);
  // The live big blind has priority over the BBA when the big blind is short.
  postForcedBet(state, events, bigBlindPlayer, state.bigBlind, "BIG_BLIND", true);
  if (state.bigBlindAnte > 0) {
    postForcedBet(state, events, bigBlindPlayer, state.bigBlindAnte, "BIG_BLIND_ANTE", false);
  }

  const dealOrder = actionOrderAfter(state.positions.button, activeSeats, state.seatCount);
  const dealt = new Map<string, Card[]>();
  for (let pass = 0; pass < 2; pass += 1) {
    for (const seat of dealOrder) {
      const player = state.players.find((candidate) => candidate.seat === seat)!;
      const cards = dealt.get(player.id) ?? [];
      cards.push(drawCard(state));
      dealt.set(player.id, cards);
    }
  }
  for (const player of state.players) {
    const cards = dealt.get(player.id);
    if (!cards || cards.length !== 2) throw new Error("Hole-card deal failed");
    player.holeCards = [cards[0]!, cards[1]!];
    events.push({ type: "HOLE_CARDS_DEALT", playerId: player.id, cards: player.holeCards });
  }

  const actionable = actionableContenders(state);
  const closingActor = actionable.length === 1 ? actionable[0] : undefined;
  const closingActionRequired = closingActor !== undefined
    && closingActor.streetCommitted < state.bigBlind;
  if (actionable.length < 2 && !closingActionRequired) {
    runOutBoardAndShowDown(state, events);
  } else {
    beginBettingRound(state, events, "PREFLOP", state.positions.bigBlind, state.bigBlind);
  }
  assertHandInvariants(state);
  return { state, events };
}

export function reduceHand(state: HandState, command: HandCommand): HandTransition {
  if (state.phase === "HAND_COMPLETE") throw new Error("Hand is already complete");
  const next = structuredClone(state);
  const events: HandEvent[] = [];

  if (!next.betting || next.betting.currentActorId !== command.playerId) {
    throw new Error("Player is not the current betting actor");
  }
  const before = next.betting;
  const available = legalActions(before);
  const priorPlayer = before.players.find((player) => player.id === command.playerId)!;
  const updated = applyAction(before, command.action);
  const updatedPlayer = updated.players.find((player) => player.id === command.playerId)!;
  const paid = updatedPlayer.committed - priorPlayer.committed;
  next.betting = updated;
  for (const bettingPlayer of updated.players) {
    const handPlayer = playerById(next, bettingPlayer.id);
    const committedDelta = bettingPlayer.committed - handPlayer.streetCommitted;
    handPlayer.stack = bettingPlayer.stack;
    handPlayer.streetCommitted = bettingPlayer.committed;
    handPlayer.totalCommitted += committedDelta;
    handPlayer.folded = bettingPlayer.folded;
    handPlayer.allIn = bettingPlayer.allIn;
  }
  const amountTo = updatedPlayer.committed;
  // Reading legal actions here also guarantees the all-in classification was
  // computed from the exact pre-action state, even though the event remains
  // transport-neutral.
  if (command.action.action === "all_in" && !available.allIn) {
    throw new Error("All-in classification is missing");
  }
  const classification = command.action.action === "all_in"
    ? available.allIn!.classification
    : command.action.action;
  events.push({
    type: "ACTION_APPLIED",
    street: before.street,
    playerId: command.playerId,
    command: command.action,
    classification,
    paid,
    amountTo,
  });
  if (updated.complete) advanceAfterBetting(next, events);

  assertHandInvariants(next);
  return { state: next, events };
}

export function currentLegalActions(state: HandState) {
  if (!state.betting) return null;
  return legalActions(state.betting);
}
