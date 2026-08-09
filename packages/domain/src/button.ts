export interface HandPositions {
  button: number;
  smallBlind: number;
  bigBlind: number;
  headsUp: boolean;
}

function assertSeats(activeSeats: readonly number[], seatCount: number): void {
  if (activeSeats.length < 2) throw new Error("At least two active seats are required");
  if (new Set(activeSeats).size !== activeSeats.length) throw new Error("Active seats must be unique");
  if (activeSeats.some((seat) => seat < 0 || seat >= seatCount)) {
    throw new Error("Active seat is outside the table");
  }
}

export function firstActiveAfter(
  seat: number,
  activeSeats: readonly number[],
  seatCount: number,
): number {
  const active = new Set(activeSeats);
  for (let offset = 1; offset <= seatCount; offset += 1) {
    const candidate = (seat + offset) % seatCount;
    if (active.has(candidate)) return candidate;
  }
  throw new Error("No active seat found");
}

export function initialPositions(
  button: number,
  activeSeats: readonly number[],
  seatCount: number,
): HandPositions {
  assertSeats(activeSeats, seatCount);
  if (activeSeats.length === 2) {
    if (!activeSeats.includes(button)) throw new Error("Heads-up button must be active");
    return {
      button,
      smallBlind: button,
      bigBlind: firstActiveAfter(button, activeSeats, seatCount),
      headsUp: true,
    };
  }
  const smallBlind = firstActiveAfter(button, activeSeats, seatCount);
  return {
    button,
    smallBlind,
    bigBlind: firstActiveAfter(smallBlind, activeSeats, seatCount),
    headsUp: false,
  };
}

export function nextPositions(
  previous: HandPositions,
  activeSeats: readonly number[],
  seatCount: number,
): HandPositions {
  assertSeats(activeSeats, seatCount);
  if (activeSeats.length === 2) {
    const bigBlind = firstActiveAfter(previous.bigBlind, activeSeats, seatCount);
    const button = firstActiveAfter(bigBlind, activeSeats, seatCount);
    return { button, smallBlind: button, bigBlind, headsUp: true };
  }
  const button = (previous.button + 1) % seatCount;
  return initialPositions(button, activeSeats, seatCount);
}

export function actionOrderAfter(
  anchorSeat: number,
  activeSeats: readonly number[],
  seatCount: number,
): number[] {
  const result: number[] = [];
  let cursor = anchorSeat;
  for (let count = 0; count < activeSeats.length; count += 1) {
    cursor = firstActiveAfter(cursor, activeSeats, seatCount);
    result.push(cursor);
  }
  return result;
}
