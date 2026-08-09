export interface PotContribution {
  playerId: string;
  seat: number;
  /** Live wagers participate in unmatched-return and side-pot cap logic. */
  amount: number;
  /** Antes are dead money: never returned and added to the main pot. */
  deadAmount?: number;
  folded: boolean;
}

export interface PotLayer {
  index: number;
  lowerBound: number;
  upperBound: number;
  amount: number;
  deadAmount?: number;
  contributors: string[];
  eligible: string[];
}

export interface PotBuildResult {
  adjustedContributions: PotContribution[];
  returned: { playerId: string; amount: number }[];
  pots: PotLayer[];
}

export interface RankedPlayer {
  playerId: string;
  seat: number;
  rank: unknown;
}

export interface PotAward {
  potIndex: number;
  boardIndex: number;
  playerId: string;
  amount: number;
}

function assertIntegerAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Chip amounts must be non-negative safe integers");
  }
}

export function buildPots(contributions: readonly PotContribution[]): PotBuildResult {
  if (contributions.length < 2) throw new Error("At least two contributions are required");
  if (new Set(contributions.map((item) => item.playerId)).size !== contributions.length) {
    throw new Error("Contribution player IDs must be unique");
  }
  for (const contribution of contributions) {
    assertIntegerAmount(contribution.amount);
    assertIntegerAmount(contribution.deadAmount ?? 0);
  }

  const adjusted = contributions.map((contribution) => ({ ...contribution }));
  const descending = [...adjusted].sort((a, b) => b.amount - a.amount);
  const returned: { playerId: string; amount: number }[] = [];
  if (descending[0] && descending[1] && descending[0].amount > descending[1].amount) {
    const amount = descending[0].amount - descending[1].amount;
    const target = adjusted.find((item) => item.playerId === descending[0]!.playerId);
    if (!target) throw new Error("Uncalled contribution owner is missing");
    target.amount -= amount;
    returned.push({ playerId: target.playerId, amount });
  }

  const levels = [...new Set(adjusted.map((item) => item.amount).filter((amount) => amount > 0))]
    .sort((a, b) => a - b);
  const pots: PotLayer[] = [];
  let lowerBound = 0;
  for (const upperBound of levels) {
    const participants = adjusted.filter((item) => item.amount >= upperBound);
    const amount = (upperBound - lowerBound) * participants.length;
    if (amount > 0) {
      pots.push({
        index: pots.length,
        lowerBound,
        upperBound,
        amount,
        deadAmount: 0,
        contributors: participants.map((item) => item.playerId),
        eligible: participants.filter((item) => !item.folded).map((item) => item.playerId),
      });
    }
    lowerBound = upperBound;
  }

  const deadTotal = adjusted.reduce((sum, item) => sum + (item.deadAmount ?? 0), 0);
  if (deadTotal > 0) {
    const deadContributors = adjusted
      .filter((item) => (item.deadAmount ?? 0) > 0)
      .map((item) => item.playerId);
    if (pots[0]) {
      pots[0].amount += deadTotal;
      pots[0].deadAmount = deadTotal;
      pots[0].contributors = [...new Set([...pots[0].contributors, ...deadContributors])];
    } else {
      pots.push({
        index: 0,
        lowerBound: 0,
        upperBound: 0,
        amount: deadTotal,
        deadAmount: deadTotal,
        contributors: deadContributors,
        eligible: adjusted.filter((item) => !item.folded).map((item) => item.playerId),
      });
    }
  }

  return { adjustedContributions: adjusted, returned, pots };
}

function clockwiseWinners(
  winners: readonly RankedPlayer[],
  buttonSeat: number,
  seatCount: number,
): RankedPlayer[] {
  return [...winners].sort((left, right) => {
    const leftDistance = (left.seat - buttonSeat + seatCount) % seatCount || seatCount;
    const rightDistance = (right.seat - buttonSeat + seatCount) % seatCount || seatCount;
    return leftDistance - rightDistance;
  });
}

export function awardPots(
  pots: readonly PotLayer[],
  boardRanks: readonly RankedPlayer[][],
  compare: (left: unknown, right: unknown) => number,
  buttonSeat: number,
  seatCount: number,
): PotAward[] {
  if (boardRanks.length < 1 || boardRanks.length > 2) {
    throw new Error("One or two boards are supported");
  }
  const awards: PotAward[] = [];

  for (const pot of pots) {
    const boardAmounts = boardRanks.length === 2
      ? [Math.ceil(pot.amount / 2), Math.floor(pot.amount / 2)]
      : [pot.amount];

    boardRanks.forEach((rankedPlayers, boardIndex) => {
      const eligible = rankedPlayers.filter((player) => pot.eligible.includes(player.playerId));
      if (eligible.length === 0) throw new Error(`Pot ${pot.index} has no ranked eligible player`);
      let best = eligible[0]!;
      for (const player of eligible.slice(1)) {
        if (compare(player.rank, best.rank) > 0) best = player;
      }
      const winners = clockwiseWinners(
        eligible.filter((player) => compare(player.rank, best.rank) === 0),
        buttonSeat,
        seatCount,
      );
      const boardAmount = boardAmounts[boardIndex] ?? 0;
      const share = Math.floor(boardAmount / winners.length);
      let remainder = boardAmount % winners.length;
      for (const winner of winners) {
        const amount = share + (remainder > 0 ? 1 : 0);
        remainder = Math.max(0, remainder - 1);
        if (amount > 0) awards.push({ potIndex: pot.index, boardIndex, playerId: winner.playerId, amount });
      }
    });
  }

  return awards;
}
