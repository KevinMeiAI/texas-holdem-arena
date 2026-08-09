export const SUITS = ["c", "d", "h", "s"] as const;
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;

export type Suit = (typeof SUITS)[number];
export type Rank = (typeof RANKS)[number];

export interface Card {
  rank: Rank;
  suit: Suit;
}

const RANK_TO_SYMBOL: Record<Rank, string> = {
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "T",
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
};

const SYMBOL_TO_RANK = new Map(
  Object.entries(RANK_TO_SYMBOL).map(([rank, symbol]) => [symbol, Number(rank) as Rank]),
);

export function cardCode(card: Card): string {
  return `${RANK_TO_SYMBOL[card.rank]}${card.suit}`;
}

export function parseCard(code: string): Card {
  if (!/^[2-9TJQKA][cdhs]$/.test(code)) {
    throw new Error(`Invalid card code: ${code}`);
  }
  const rank = SYMBOL_TO_RANK.get(code[0] ?? "");
  const suit = code[1] as Suit | undefined;
  if (!rank || !suit) throw new Error(`Invalid card code: ${code}`);
  return { rank, suit };
}

export function createDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
}

export function assertUniqueCards(cards: readonly Card[]): void {
  const codes = cards.map(cardCode);
  if (new Set(codes).size !== codes.length) {
    throw new Error("Cards must be unique");
  }
}
