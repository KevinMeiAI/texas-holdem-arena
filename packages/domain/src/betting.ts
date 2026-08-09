export type Street = "PREFLOP" | "FLOP" | "TURN" | "RIVER";
export type BettingAction = "fold" | "check" | "call" | "bet" | "raise" | "all_in";

export interface BettingPlayer {
  id: string;
  seat: number;
  stack: number;
  committed: number;
  folded: boolean;
  allIn: boolean;
  actedSinceFullRaise: boolean;
}

export interface BettingRound {
  street: Street;
  bigBlind: number;
  currentBet: number;
  lastFullRaiseSize: number;
  players: BettingPlayer[];
  currentActorId: string | undefined;
  lastAggressorId: string | undefined;
  complete: boolean;
  uncontestedWinnerId: string | undefined;
}

export interface LegalActions {
  fold: boolean;
  check: boolean;
  call: { amount: number; allIn: boolean } | undefined;
  bet: { minAmountTo: number; maxAmountTo: number } | undefined;
  raise: { minAmountTo: number; maxAmountTo: number } | undefined;
  allIn: { amountTo: number; classification: "call" | "bet" | "raise" | "short_raise" } | undefined;
}

export type ActionCommand =
  | { action: "fold" | "check" | "call" | "all_in" }
  | { action: "bet" | "raise"; amountTo: number };

function assertChipAmount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

export function createBettingRound(input: Omit<BettingRound, "complete" | "uncontestedWinnerId">): BettingRound {
  assertChipAmount(input.bigBlind, "bigBlind");
  assertChipAmount(input.currentBet, "currentBet");
  assertChipAmount(input.lastFullRaiseSize, "lastFullRaiseSize");
  if (!input.players.some((player) => player.id === input.currentActorId)) {
    throw new Error("Current actor is not present");
  }
  if (new Set(input.players.map((player) => player.id)).size !== input.players.length) {
    throw new Error("Betting player IDs must be unique");
  }
  if (new Set(input.players.map((player) => player.seat)).size !== input.players.length) {
    throw new Error("Betting player seats must be unique");
  }
  for (const player of input.players) {
    assertChipAmount(player.stack, "stack");
    assertChipAmount(player.committed, "committed");
  }
  return { ...input, complete: false, uncontestedWinnerId: undefined };
}

function actor(round: BettingRound): BettingPlayer {
  const player = round.players.find((candidate) => candidate.id === round.currentActorId);
  if (!player || player.folded || player.allIn) throw new Error("There is no actionable current actor");
  return player;
}

export function legalActions(round: BettingRound): LegalActions {
  if (round.complete) throw new Error("Betting round is complete");
  const player = actor(round);
  const toCall = Math.max(0, round.currentBet - player.committed);
  const amountTo = player.committed + player.stack;
  // Tournament rules reopen action after cumulative short all-ins when the
  // total increase faced since this player's last action reaches a full raise.
  // `committed` is that player's amount-to at their last action, so no extra
  // mutable raise-right counter is needed.
  const raiseRightOpen = !player.actedSinceFullRaise
    || round.currentBet - player.committed >= round.lastFullRaiseSize;
  const canIncrease = amountTo > round.currentBet && raiseRightOpen;
  const minimumRaiseTo = round.currentBet + round.lastFullRaiseSize;
  const minimumBetTo = round.bigBlind;

  let allIn: LegalActions["allIn"];
  if (player.stack > 0) {
    const classification = amountTo <= round.currentBet
      ? "call"
      : round.currentBet === 0
        ? "bet"
        : amountTo - round.currentBet >= round.lastFullRaiseSize
          ? "raise"
          : "short_raise";
    if (amountTo <= round.currentBet || canIncrease) allIn = { amountTo, classification };
  }

  return {
    fold: toCall > 0,
    check: toCall === 0,
    call: toCall > 0 ? { amount: Math.min(toCall, player.stack), allIn: player.stack <= toCall } : undefined,
    bet: round.currentBet === 0 && amountTo >= minimumBetTo
      ? { minAmountTo: minimumBetTo, maxAmountTo: amountTo }
      : undefined,
    raise: round.currentBet > 0 && canIncrease && amountTo >= minimumRaiseTo
      ? { minAmountTo: minimumRaiseTo, maxAmountTo: amountTo }
      : undefined,
    allIn,
  };
}

function pay(player: BettingPlayer, amount: number): void {
  assertChipAmount(amount, "payment");
  if (amount > player.stack) throw new Error("Player cannot pay more than their stack");
  player.stack -= amount;
  player.committed += amount;
  if (player.stack === 0) player.allIn = true;
}

function needsAction(player: BettingPlayer, currentBet: number): boolean {
  return !player.folded
    && !player.allIn
    && (!player.actedSinceFullRaise || player.committed < currentBet);
}

function nextActorAfter(round: BettingRound, seat: number): BettingPlayer | undefined {
  const ordered = [...round.players].sort((a, b) => a.seat - b.seat);
  const start = ordered.findIndex((player) => player.seat > seat);
  const rotated = start === -1
    ? ordered
    : [...ordered.slice(start), ...ordered.slice(0, start)];
  return rotated.find((player) => needsAction(player, round.currentBet));
}

function finishOrAdvance(round: BettingRound, actingSeat: number): void {
  const contenders = round.players.filter((player) => !player.folded);
  if (contenders.length === 1) {
    round.complete = true;
    round.uncontestedWinnerId = contenders[0]!.id;
    round.currentActorId = undefined;
    return;
  }
  const next = nextActorAfter(round, actingSeat);
  if (!next) {
    round.complete = true;
    round.currentActorId = undefined;
    return;
  }
  round.currentActorId = next.id;
}

export function applyAction(round: BettingRound, command: ActionCommand): BettingRound {
  if (round.complete) throw new Error("Betting round is complete");
  const next: BettingRound = structuredClone(round);
  const player = actor(next);
  const available = legalActions(next);
  const actingSeat = player.seat;

  if (command.action === "fold") {
    if (!available.fold) throw new Error("Fold is not legal");
    player.folded = true;
    player.actedSinceFullRaise = true;
  } else if (command.action === "check") {
    if (!available.check) throw new Error("Check is not legal");
    player.actedSinceFullRaise = true;
  } else if (command.action === "call") {
    if (!available.call) throw new Error("Call is not legal");
    pay(player, available.call.amount);
    player.actedSinceFullRaise = true;
  } else if (command.action === "bet" || command.action === "raise") {
    const bounds = command.action === "bet" ? available.bet : available.raise;
    if (!bounds) throw new Error(`${command.action} is not legal`);
    if (!Number.isSafeInteger(command.amountTo)
      || command.amountTo < bounds.minAmountTo
      || command.amountTo > bounds.maxAmountTo) {
      throw new Error(`${command.action} amountTo is outside the legal range`);
    }
    const increment = command.amountTo - next.currentBet;
    pay(player, command.amountTo - player.committed);
    next.currentBet = command.amountTo;
    next.lastFullRaiseSize = increment;
    for (const other of next.players) {
      if (other.id !== player.id && !other.folded && !other.allIn) other.actedSinceFullRaise = false;
    }
    player.actedSinceFullRaise = true;
    next.lastAggressorId = player.id;
  } else {
    if (!available.allIn) throw new Error("All-in is not legal");
    const previousBet = next.currentBet;
    const amountTo = available.allIn.amountTo;
    pay(player, player.stack);
    if (amountTo > previousBet) {
      const increment = amountTo - previousBet;
      const isFullRaise = previousBet === 0
        ? amountTo >= next.bigBlind
        : increment >= next.lastFullRaiseSize;
      next.currentBet = amountTo;
      if (isFullRaise) {
        next.lastFullRaiseSize = increment;
        for (const other of next.players) {
          if (other.id !== player.id && !other.folded && !other.allIn) other.actedSinceFullRaise = false;
        }
      }
      next.lastAggressorId = player.id;
    }
    player.actedSinceFullRaise = true;
  }

  finishOrAdvance(next, actingSeat);
  return next;
}
