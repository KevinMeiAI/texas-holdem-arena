import { assertUniqueCards, type Card } from "./cards.js";

export enum HandCategory {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
}

export interface HandRank {
  category: HandCategory;
  tiebreak: number[];
  cards: Card[];
}

function straightHigh(ranks: readonly number[]): number | undefined {
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let index = 0; index <= unique.length - 5; index += 1) {
    const high = unique[index];
    if (high === undefined) continue;
    let consecutive = true;
    for (let offset = 1; offset < 5; offset += 1) {
      if (unique[index + offset] !== high - offset) {
        consecutive = false;
        break;
      }
    }
    if (consecutive) return high;
  }
  return undefined;
}

export function evaluateFive(cards: readonly Card[]): HandRank {
  if (cards.length !== 5) throw new Error("evaluateFive requires exactly five cards");
  assertUniqueCards(cards);

  const ranks = cards.map((card) => card.rank);
  const counts = new Map<number, number>();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  const groups = [...counts.entries()].sort(
    ([rankA, countA], [rankB, countB]) => countB - countA || rankB - rankA,
  );
  const isFlush = cards.every((card) => card.suit === cards[0]?.suit);
  const highStraight = straightHigh(ranks);

  if (isFlush && highStraight !== undefined) {
    return { category: HandCategory.StraightFlush, tiebreak: [highStraight], cards: [...cards] };
  }
  if (groups[0]?.[1] === 4) {
    return {
      category: HandCategory.FourOfAKind,
      tiebreak: [groups[0][0], groups[1]?.[0] ?? 0],
      cards: [...cards],
    };
  }
  if (groups[0]?.[1] === 3 && groups[1]?.[1] === 2) {
    return {
      category: HandCategory.FullHouse,
      tiebreak: [groups[0][0], groups[1][0]],
      cards: [...cards],
    };
  }
  if (isFlush) {
    return {
      category: HandCategory.Flush,
      tiebreak: [...ranks].sort((a, b) => b - a),
      cards: [...cards],
    };
  }
  if (highStraight !== undefined) {
    return { category: HandCategory.Straight, tiebreak: [highStraight], cards: [...cards] };
  }
  if (groups[0]?.[1] === 3) {
    return {
      category: HandCategory.ThreeOfAKind,
      tiebreak: [groups[0][0], ...groups.slice(1).map(([rank]) => rank).sort((a, b) => b - a)],
      cards: [...cards],
    };
  }
  if (groups[0]?.[1] === 2 && groups[1]?.[1] === 2) {
    const pairs = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    return {
      category: HandCategory.TwoPair,
      tiebreak: [...pairs, groups[2]?.[0] ?? 0],
      cards: [...cards],
    };
  }
  if (groups[0]?.[1] === 2) {
    return {
      category: HandCategory.OnePair,
      tiebreak: [groups[0][0], ...groups.slice(1).map(([rank]) => rank).sort((a, b) => b - a)],
      cards: [...cards],
    };
  }
  return {
    category: HandCategory.HighCard,
    tiebreak: [...ranks].sort((a, b) => b - a),
    cards: [...cards],
  };
}

export function compareHandRanks(left: HandRank, right: HandRank): number {
  if (left.category !== right.category) return Math.sign(left.category - right.category);
  const length = Math.max(left.tiebreak.length, right.tiebreak.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left.tiebreak[index] ?? 0) - (right.tiebreak[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function combinationsOfFive(cards: readonly Card[]): Card[][] {
  const result: Card[][] = [];
  for (let a = 0; a < cards.length - 4; a += 1) {
    for (let b = a + 1; b < cards.length - 3; b += 1) {
      for (let c = b + 1; c < cards.length - 2; c += 1) {
        for (let d = c + 1; d < cards.length - 1; d += 1) {
          for (let e = d + 1; e < cards.length; e += 1) {
            result.push([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
          }
        }
      }
    }
  }
  return result;
}

export function evaluateBest(cards: readonly Card[]): HandRank {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error("evaluateBest requires five to seven cards");
  }
  assertUniqueCards(cards);
  let best: HandRank | undefined;
  for (const combination of combinationsOfFive(cards)) {
    const candidate = evaluateFive(combination);
    if (!best || compareHandRanks(candidate, best) > 0) best = candidate;
  }
  if (!best) throw new Error("No five-card combination found");
  return best;
}
