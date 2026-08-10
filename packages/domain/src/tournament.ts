import { initialPositions, nextPositions, type HandPositions } from "./button.js";
import type { Card } from "./cards.js";
import { assertHandInvariants } from "./invariants.js";
import {
  reduceHand,
  startHand,
  type HandCommand,
  type HandEvent,
  type HandState,
} from "./reducer.js";

export interface BlindLevel {
  smallBlind: number;
  bigBlind: number;
  bigBlindAnte: number;
}

export interface TournamentPlayerConfig {
  id: string;
  seat: number;
}

export interface TournamentConfig {
  seatCount: number;
  players: TournamentPlayerConfig[];
  initialStack: number;
  initialButton: number;
  handsPerLevel: number;
  blindLevels: BlindLevel[];
}

export type TournamentPlayerStatus = "ACTIVE" | "ELIMINATED" | "CHAMPION";

export interface TournamentPlayer extends TournamentPlayerConfig {
  stack: number;
  status: TournamentPlayerStatus;
  eliminatedHandNo: number | null;
  finishingPosition: number | null;
  tieGroup: string | null;
}

export type TournamentStatus = "READY" | "RUNNING" | "COMPLETED";

export interface TournamentState {
  status: TournamentStatus;
  seatCount: number;
  players: TournamentPlayer[];
  initialStack: number;
  initialButton: number;
  handsPerLevel: number;
  blindLevels: BlindLevel[];
  totalChips: number;
  completedHands: number;
  currentHand: HandState | null;
  currentHandStartingStacks: Record<string, number> | null;
  previousPositions: HandPositions | null;
  championPlayerId: string | null;
}

export type TournamentEvent =
  | { type: "TOURNAMENT_STARTED"; playerIds: string[] }
  | { type: "BLIND_LEVEL_SELECTED"; handNo: number; levelIndex: number; level: BlindLevel }
  | { type: "HAND_EVENT"; event: HandEvent }
  | { type: "PLAYER_ELIMINATED"; playerId: string; handNo: number; finishingPosition: number; tieGroup: string | null }
  | { type: "TOURNAMENT_COMPLETED"; championPlayerId: string; completedHands: number };

export interface TournamentTransition {
  state: TournamentState;
  events: TournamentEvent[];
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertBlindLevel(level: BlindLevel): void {
  assertPositiveInteger(level.smallBlind, "smallBlind");
  assertPositiveInteger(level.bigBlind, "bigBlind");
  if (level.smallBlind > level.bigBlind) throw new Error("smallBlind cannot exceed bigBlind");
  if (!Number.isSafeInteger(level.bigBlindAnte) || level.bigBlindAnte < 0) {
    throw new Error("bigBlindAnte must be a non-negative integer");
  }
}

export function blindLevelAt(state: TournamentState, completedHands = state.completedHands): {
  levelIndex: number;
  level: BlindLevel;
} {
  const levelIndex = Math.floor(completedHands / state.handsPerLevel);
  const configured = state.blindLevels[levelIndex];
  if (configured) return { levelIndex, level: { ...configured } };
  const last = state.blindLevels.at(-1);
  if (!last) throw new Error("Tournament has no blind levels");
  const doublings = levelIndex - state.blindLevels.length + 1;
  const multiplier = 2 ** doublings;
  const level = {
    smallBlind: last.smallBlind * multiplier,
    bigBlind: last.bigBlind * multiplier,
    bigBlindAnte: last.bigBlindAnte * multiplier,
  };
  assertBlindLevel(level);
  return { levelIndex, level };
}

export function assertTournamentInvariants(state: TournamentState): void {
  if (state.players.reduce((sum, player) => sum + player.stack, 0) !== state.totalChips) {
    throw new Error("Tournament chip conservation failed");
  }
  for (const player of state.players) {
    if (!Number.isSafeInteger(player.stack) || player.stack < 0) {
      throw new Error("Tournament stacks must be non-negative integers");
    }
    if (player.status === "ELIMINATED" && player.stack !== 0) {
      throw new Error("Eliminated players cannot retain chips");
    }
  }
  if (state.currentHand) {
    assertHandInvariants(state.currentHand);
    for (const handPlayer of state.currentHand.players) {
      const tournamentPlayer = state.players.find((player) => player.id === handPlayer.id);
      if (!tournamentPlayer || tournamentPlayer.stack !== handPlayer.startingStack) {
        throw new Error("Active hand must start from the tournament stack snapshot");
      }
    }
  }
  const active = state.players.filter((player) => player.status === "ACTIVE");
  const champions = state.players.filter((player) => player.status === "CHAMPION");
  if (state.status === "COMPLETED") {
    if (active.length !== 0 || champions.length !== 1) {
      throw new Error("A completed tournament must have exactly one champion");
    }
    if (champions[0]!.stack !== state.totalChips || champions[0]!.finishingPosition !== 1) {
      throw new Error("Champion must hold every tournament chip and rank first");
    }
  } else if (champions.length !== 0) {
    throw new Error("An incomplete tournament cannot have a champion");
  }
}

export function createTournament(config: TournamentConfig): TournamentState {
  if (!Number.isSafeInteger(config.seatCount) || config.seatCount < 2 || config.seatCount > 9) {
    throw new Error("seatCount must be between 2 and 9");
  }
  if (config.players.length < 2 || config.players.length > config.seatCount) {
    throw new Error("Tournament requires between 2 and seatCount players");
  }
  assertPositiveInteger(config.initialStack, "initialStack");
  assertPositiveInteger(config.handsPerLevel, "handsPerLevel");
  if (config.blindLevels.length === 0) throw new Error("At least one blind level is required");
  config.blindLevels.forEach(assertBlindLevel);
  if (new Set(config.players.map((player) => player.id)).size !== config.players.length
    || new Set(config.players.map((player) => player.seat)).size !== config.players.length) {
    throw new Error("Tournament player IDs and seats must be unique");
  }
  if (config.players.some((player) => player.seat < 0 || player.seat >= config.seatCount)) {
    throw new Error("Tournament player seat is outside the table");
  }
  if (config.initialButton < 0 || config.initialButton >= config.seatCount) {
    throw new Error("Initial button is outside the table");
  }
  if (config.players.length === 2
    && !config.players.some((player) => player.seat === config.initialButton)) {
    throw new Error("Heads-up initial button must be occupied");
  }

  const state: TournamentState = {
    status: "READY",
    seatCount: config.seatCount,
    players: config.players.map((player) => ({
      ...player,
      stack: config.initialStack,
      status: "ACTIVE",
      eliminatedHandNo: null,
      finishingPosition: null,
      tieGroup: null,
    })),
    initialStack: config.initialStack,
    initialButton: config.initialButton,
    handsPerLevel: config.handsPerLevel,
    blindLevels: config.blindLevels.map((level) => ({ ...level })),
    totalChips: config.initialStack * config.players.length,
    completedHands: 0,
    currentHand: null,
    currentHandStartingStacks: null,
    previousPositions: null,
    championPlayerId: null,
  };
  assertTournamentInvariants(state);
  return state;
}

function wrapHandEvents(events: readonly HandEvent[]): TournamentEvent[] {
  return events.map((event) => ({ type: "HAND_EVENT", event }));
}

function finishCurrentHand(state: TournamentState, events: TournamentEvent[]): void {
  const hand = state.currentHand;
  const startingStacks = state.currentHandStartingStacks;
  if (!hand?.result || !startingStacks || hand.phase !== "HAND_COMPLETE") {
    throw new Error("Current hand is not complete");
  }
  state.previousPositions = { ...hand.positions };
  state.completedHands += 1;
  for (const player of state.players) {
    const stack = hand.result.stacks[player.id];
    if (stack !== undefined) player.stack = stack;
  }

  const newlyEliminated = state.players
    .filter((player) => player.status === "ACTIVE" && player.stack === 0)
    .sort((left, right) => (startingStacks[right.id] ?? 0) - (startingStacks[left.id] ?? 0));
  const survivorCount = state.players.filter((player) => player.status === "ACTIVE" && player.stack > 0).length;
  let offset = 0;
  for (let index = 0; index < newlyEliminated.length;) {
    const startingStack = startingStacks[newlyEliminated[index]!.id] ?? 0;
    const group = newlyEliminated.slice(index).filter(
      (player) => (startingStacks[player.id] ?? 0) === startingStack,
    );
    const finishingPosition = survivorCount + 1 + offset;
    const tieGroup = group.length > 1 ? `${hand.handNo}:${startingStack}` : null;
    for (const player of group) {
      player.status = "ELIMINATED";
      player.eliminatedHandNo = hand.handNo;
      player.finishingPosition = finishingPosition;
      player.tieGroup = tieGroup;
      events.push({
        type: "PLAYER_ELIMINATED",
        playerId: player.id,
        handNo: hand.handNo,
        finishingPosition,
        tieGroup,
      });
    }
    index += group.length;
    offset += group.length;
  }

  state.currentHand = null;
  state.currentHandStartingStacks = null;
  const remaining = state.players.filter((player) => player.status === "ACTIVE");
  if (remaining.length === 1) {
    const champion = remaining[0]!;
    champion.status = "CHAMPION";
    champion.finishingPosition = 1;
    state.status = "COMPLETED";
    state.championPlayerId = champion.id;
    events.push({
      type: "TOURNAMENT_COMPLETED",
      championPlayerId: champion.id,
      completedHands: state.completedHands,
    });
  }
}

export function startTournamentHand(state: TournamentState, deck: readonly Card[]): TournamentTransition {
  if (state.status === "COMPLETED") throw new Error("Tournament is complete");
  if (state.currentHand) throw new Error("Tournament already has an active hand");
  const next = structuredClone(state);
  const active = next.players.filter((player) => player.status === "ACTIVE");
  if (active.length < 2) throw new Error("Tournament requires at least two active players");
  const activeSeats = active.map((player) => player.seat);
  const positions = next.previousPositions
    ? nextPositions(next.previousPositions, activeSeats, next.seatCount)
    : initialPositions(next.initialButton, activeSeats, next.seatCount);
  const { levelIndex, level } = blindLevelAt(next);
  const events: TournamentEvent[] = [];
  if (next.status === "READY") {
    next.status = "RUNNING";
    events.push({ type: "TOURNAMENT_STARTED", playerIds: active.map((player) => player.id) });
  }
  const handNo = next.completedHands + 1;
  events.push({ type: "BLIND_LEVEL_SELECTED", handNo, levelIndex, level });
  const transition = startHand({
    handNo,
    seatCount: next.seatCount,
    players: active.map((player) => ({ id: player.id, seat: player.seat, stack: player.stack })),
    positions,
    ...level,
    deck: [...deck],
  });
  next.currentHand = transition.state;
  next.currentHandStartingStacks = Object.fromEntries(active.map((player) => [player.id, player.stack]));
  events.push(...wrapHandEvents(transition.events));
  if (next.currentHand.phase === "HAND_COMPLETE") finishCurrentHand(next, events);
  assertTournamentInvariants(next);
  return { state: next, events };
}

export function reduceTournament(state: TournamentState, command: HandCommand): TournamentTransition {
  if (state.status !== "RUNNING" || !state.currentHand) {
    throw new Error("Tournament has no running hand");
  }
  const next = structuredClone(state);
  const transition = reduceHand(next.currentHand!, command);
  next.currentHand = transition.state;
  const events = wrapHandEvents(transition.events);
  if (next.currentHand.phase === "HAND_COMPLETE") finishCurrentHand(next, events);
  assertTournamentInvariants(next);
  return { state: next, events };
}
