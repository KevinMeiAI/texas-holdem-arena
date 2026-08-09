import { describe, expect, it } from "vitest";
import { firstActiveAfter, initialPositions, nextPositions } from "./button.js";

function subsets(values: readonly number[], minimumSize: number): number[][] {
  const result: number[][] = [];
  for (let mask = 0; mask < 2 ** values.length; mask += 1) {
    const subset = values.filter((_, index) => (mask & (1 << index)) !== 0);
    if (subset.length >= minimumSize) result.push(subset);
  }
  return result;
}

describe("tournament button and blinds", () => {
  it("uses a dead button with three or more players", () => {
    const previous = initialPositions(0, [0, 1, 2, 3], 4);
    expect(previous).toEqual({ button: 0, smallBlind: 1, bigBlind: 2, headsUp: false });
    const next = nextPositions(previous, [0, 2, 3], 4);
    expect(next).toEqual({ button: 1, smallBlind: 2, bigBlind: 3, headsUp: false });
  });

  it("switches to heads-up without repeating the previous big blind", () => {
    const previous = initialPositions(0, [0, 1, 2], 3);
    const next = nextPositions(previous, [0, 2], 3);
    expect(next).toEqual({ button: 2, smallBlind: 2, bigBlind: 0, headsUp: true });
  });

  it("alternates heads-up positions", () => {
    const first = initialPositions(1, [1, 4], 6);
    const second = nextPositions(first, [1, 4], 6);
    expect(second).toEqual({ button: 4, smallBlind: 4, bigBlind: 1, headsUp: true });
  });

  it("enumerates valid positions for every 2-9 seat active combination", () => {
    for (let seatCount = 2; seatCount <= 9; seatCount += 1) {
      const seats = Array.from({ length: seatCount }, (_, index) => index);
      for (const active of subsets(seats, 2)) {
        for (const button of seats) {
          if (active.length === 2 && !active.includes(button)) continue;
          const positions = initialPositions(button, active, seatCount);
          expect(active).toContain(positions.smallBlind);
          expect(active).toContain(positions.bigBlind);
          expect(positions.smallBlind).not.toBe(positions.bigBlind);
          if (active.length === 2) {
            expect(positions.button).toBe(positions.smallBlind);
          } else {
            expect(positions.smallBlind).toBe(firstActiveAfter(button, active, seatCount));
            expect(positions.bigBlind).toBe(firstActiveAfter(positions.smallBlind, active, seatCount));
          }
        }
      }
    }
  });

  it("enumerates every three-plus to heads-up transition without skipping the next big blind", () => {
    for (let seatCount = 3; seatCount <= 9; seatCount += 1) {
      const seats = Array.from({ length: seatCount }, (_, index) => index);
      for (const priorActive of subsets(seats, 3)) {
        for (const button of seats) {
          const previous = initialPositions(button, priorActive, seatCount);
          for (const survivors of subsets(priorActive, 2).filter((active) => active.length === 2)) {
            const next = nextPositions(previous, survivors, seatCount);
            expect(next.bigBlind).toBe(firstActiveAfter(previous.bigBlind, survivors, seatCount));
            expect(next.button).toBe(firstActiveAfter(next.bigBlind, survivors, seatCount));
            expect(next.smallBlind).toBe(next.button);
          }
        }
      }
    }
  });
});
