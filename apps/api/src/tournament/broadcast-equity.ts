import {
  assertUniqueCards,
  cardCode,
  createDeck,
  type Card,
} from "../../../../packages/domain/src/cards.js";
import {
  compareHandRanks,
  evaluateBest,
  type HandRank,
} from "../../../../packages/domain/src/evaluator.js";

export const BROADCAST_EQUITY_VERSION = "arena-broadcast-equity-v1";

export interface BroadcastEquityPlayer {
  playerId: string;
  holeCards: readonly [Card, Card];
  folded: boolean;
}

export interface BroadcastPlayerEquity {
  playerId: string;
  equity: number | null;
  outrightWinProbability: number | null;
  tieProbability: number | null;
}

export interface BroadcastEquityResult {
  version: typeof BROADCAST_EQUITY_VERSION;
  estimated: boolean;
  samples: number;
  players: BroadcastPlayerEquity[];
}

export interface BroadcastEquityOptions {
  exactCombinationLimit?: number;
  sampleCount?: number;
  seed: string;
}

function chooseCount(total: number, count: number): number {
  if (count < 0 || count > total) return 0;
  const effective = Math.min(count, total - count);
  let result = 1;
  for (let index = 1; index <= effective; index += 1) {
    result = result * (total - effective + index) / index;
  }
  return Math.round(result);
}

function stringSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function exactRunouts(deck: readonly Card[], count: number, visit: (cards: Card[]) => void): void {
  const current: Card[] = [];
  const walk = (start: number) => {
    if (current.length === count) {
      visit([...current]);
      return;
    }
    const needed = count - current.length;
    for (let index = start; index <= deck.length - needed; index += 1) {
      current.push(deck[index]!);
      walk(index + 1);
      current.pop();
    }
  };
  walk(0);
}

function sampledRunouts(
  deck: readonly Card[],
  count: number,
  samples: number,
  seed: number,
  visit: (cards: Card[]) => void,
): void {
  const random = mulberry32(seed);
  for (let sample = 0; sample < samples; sample += 1) {
    const shuffled = [...deck];
    for (let index = 0; index < count; index += 1) {
      const target = index + Math.floor(random() * (shuffled.length - index));
      [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
    }
    visit(shuffled.slice(0, count));
  }
}

export function calculateBroadcastEquity(
  players: readonly BroadcastEquityPlayer[],
  board: readonly Card[],
  options: BroadcastEquityOptions,
): BroadcastEquityResult {
  if (board.length > 5) throw new Error("Broadcast equity board cannot exceed five cards");
  if (new Set(players.map((player) => player.playerId)).size !== players.length) {
    throw new Error("Broadcast equity player IDs must be unique");
  }
  const allKnownCards = [...board, ...players.flatMap((player) => [...player.holeCards])];
  assertUniqueCards(allKnownCards);
  const contenders = players.filter((player) => !player.folded);
  if (contenders.length === 0) throw new Error("Broadcast equity requires at least one contender");
  if (contenders.length === 1) {
    return {
      version: BROADCAST_EQUITY_VERSION,
      estimated: false,
      samples: 1,
      players: players.map((player) => ({
        playerId: player.playerId,
        equity: player.folded ? null : 1,
        outrightWinProbability: player.folded ? null : 1,
        tieProbability: player.folded ? null : 0,
      })),
    };
  }

  const used = new Set(allKnownCards.map(cardCode));
  const deck = createDeck().filter((card) => !used.has(cardCode(card)));
  const cardsNeeded = 5 - board.length;
  if (cardsNeeded > deck.length) throw new Error("Broadcast equity has insufficient remaining cards");
  const combinations = chooseCount(deck.length, cardsNeeded);
  const exactCombinationLimit = options.exactCombinationLimit ?? 25_000;
  // Five thousand deterministic runouts keep the rounded broadcast percentage
  // stable without blocking the tournament process for a full pre-flop census.
  const sampleCount = options.sampleCount ?? 5_000;
  if (!Number.isSafeInteger(exactCombinationLimit) || exactCombinationLimit < 1
    || !Number.isSafeInteger(sampleCount) || sampleCount < 1) {
    throw new Error("Broadcast equity limits must be positive safe integers");
  }
  const exact = combinations <= exactCombinationLimit;
  const iterations = exact ? Math.max(1, combinations) : sampleCount;
  const equityShares = new Map(contenders.map((player) => [player.playerId, 0]));
  const outrightWins = new Map(contenders.map((player) => [player.playerId, 0]));
  const ties = new Map(contenders.map((player) => [player.playerId, 0]));
  let visited = 0;

  const visit = (runout: Card[]) => {
    const finalBoard = [...board, ...runout];
    const ranked = contenders.map((player) => ({
      playerId: player.playerId,
      rank: evaluateBest([...player.holeCards, ...finalBoard]),
    }));
    const best = ranked.reduce<HandRank | null>(
      (current, item) => current === null || compareHandRanks(item.rank, current) > 0 ? item.rank : current,
      null,
    );
    const winners = ranked.filter((item) => best !== null && compareHandRanks(item.rank, best) === 0);
    const share = 1 / winners.length;
    for (const winner of winners) {
      equityShares.set(winner.playerId, (equityShares.get(winner.playerId) ?? 0) + share);
      if (winners.length === 1) outrightWins.set(winner.playerId, (outrightWins.get(winner.playerId) ?? 0) + 1);
      else ties.set(winner.playerId, (ties.get(winner.playerId) ?? 0) + 1);
    }
    visited += 1;
  };

  if (cardsNeeded === 0) visit([]);
  else if (exact) exactRunouts(deck, cardsNeeded, visit);
  else sampledRunouts(deck, cardsNeeded, iterations, stringSeed(options.seed), visit);
  if (visited === 0) throw new Error("Broadcast equity did not visit any runouts");

  return {
    version: BROADCAST_EQUITY_VERSION,
    estimated: !exact,
    samples: visited,
    players: players.map((player) => ({
      playerId: player.playerId,
      equity: player.folded ? null : (equityShares.get(player.playerId) ?? 0) / visited,
      outrightWinProbability: player.folded ? null : (outrightWins.get(player.playerId) ?? 0) / visited,
      tieProbability: player.folded ? null : (ties.get(player.playerId) ?? 0) / visited,
    })),
  };
}
