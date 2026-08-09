import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { awardPots, buildPots } from "./pots.js";

describe("pot construction and awards", () => {
  it.each([
    [[100, 100], [200], 0],
    [[50, 100], [100], 50],
    [[100, 200, 300], [300, 200], 100],
    [[100, 300, 500], [300, 400], 200],
    [[0, 100, 100], [200], 0],
    [[10, 10, 10, 10], [40], 0],
    [[10, 20, 30, 40], [40, 30, 20], 10],
    [[25, 50, 50, 100], [100, 75], 50],
    [[5, 10, 15, 20, 25], [25, 20, 15, 10], 5],
    [[100, 100, 200, 200], [400, 200], 0],
    [[1, 2], [2], 1],
    [[1, 1, 2], [3], 1],
    [[99, 100, 101], [297, 2], 1],
    [[0, 0, 50], [], 50],
    [[0, 50, 100], [100], 50],
    [[200, 50, 50], [150], 150],
    [[7, 7, 7, 21], [28], 14],
    [[40, 80, 120, 160, 200, 240], [240, 200, 160, 120, 80], 40],
    [[1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000], [9000], 0],
    [[3, 6, 9], [9, 6], 3],
  ] as const)("builds fixture %# for contributions %j", (amounts, expectedPots, expectedReturn) => {
    const result = buildPots(amounts.map((amount, seat) => ({
      playerId: `p${seat}`,
      seat,
      amount,
      folded: false,
    })));
    expect(result.pots.map((pot) => pot.amount)).toEqual(expectedPots);
    expect(result.returned.reduce((sum, item) => sum + item.amount, 0)).toBe(expectedReturn);
  });

  it("returns an unmatched overbet and creates layered side pots", () => {
    const result = buildPots([
      { playerId: "a", seat: 0, amount: 100, folded: false },
      { playerId: "b", seat: 1, amount: 300, folded: false },
      { playerId: "c", seat: 2, amount: 500, folded: false },
    ]);
    expect(result.returned).toEqual([{ playerId: "c", amount: 200 }]);
    expect(result.pots.map((pot) => ({ amount: pot.amount, eligible: pot.eligible }))).toEqual([
      { amount: 300, eligible: ["a", "b", "c"] },
      { amount: 400, eligible: ["b", "c"] },
    ]);
  });

  it("includes folded chips but removes folded eligibility", () => {
    const result = buildPots([
      { playerId: "a", seat: 0, amount: 100, folded: false },
      { playerId: "b", seat: 1, amount: 100, folded: true },
      { playerId: "c", seat: 2, amount: 100, folded: false },
    ]);
    expect(result.pots[0]).toMatchObject({ amount: 300, eligible: ["a", "c"] });
  });

  it("adds dead contributions to the main pot without changing live side-pot caps", () => {
    const result = buildPots([
      { playerId: "a", seat: 0, amount: 120, folded: false },
      { playerId: "b", seat: 1, amount: 120, folded: false },
      { playerId: "c", seat: 2, amount: 100, deadAmount: 50, folded: false },
    ]);
    expect(result.returned).toEqual([]);
    expect(result.pots).toEqual([
      expect.objectContaining({ amount: 350, deadAmount: 50, eligible: ["a", "b", "c"] }),
      expect.objectContaining({ amount: 40, deadAmount: 0, eligible: ["a", "b"] }),
    ]);
  });

  it("splits two boards and sends odd chips clockwise from the button", () => {
    const pots = [{
      index: 0,
      lowerBound: 0,
      upperBound: 5,
      amount: 15,
      contributors: ["a", "b", "c"],
      eligible: ["a", "b", "c"],
    }];
    const awards = awardPots(
      pots,
      [
        [
          { playerId: "a", seat: 0, rank: 10 },
          { playerId: "b", seat: 1, rank: 10 },
          { playerId: "c", seat: 2, rank: 2 },
        ],
        [
          { playerId: "a", seat: 0, rank: 1 },
          { playerId: "b", seat: 1, rank: 3 },
          { playerId: "c", seat: 2, rank: 9 },
        ],
      ],
      (left, right) => Number(left) - Number(right),
      0,
      3,
    );
    expect(awards).toEqual([
      { potIndex: 0, boardIndex: 0, playerId: "b", amount: 4 },
      { potIndex: 0, boardIndex: 0, playerId: "a", amount: 4 },
      { potIndex: 0, boardIndex: 1, playerId: "c", amount: 7 },
    ]);
  });

  it("preserves every chip across returns and pot layers", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        amount: fc.integer({ min: 0, max: 20_000 }),
        deadAmount: fc.integer({ min: 0, max: 2_000 }),
      }), { minLength: 2, maxLength: 9 }),
      (amounts) => {
        const contributions = amounts.map(({ amount, deadAmount }, seat) => ({
          playerId: `p${seat}`,
          seat,
          amount,
          deadAmount,
          folded: false,
        }));
        const result = buildPots(contributions);
        const inputTotal = contributions.reduce(
          (sum, item) => sum + item.amount + (item.deadAmount ?? 0),
          0,
        );
        const returnedTotal = result.returned.reduce((sum, item) => sum + item.amount, 0);
        const potTotal = result.pots.reduce((sum, item) => sum + item.amount, 0);
        expect(returnedTotal + potTotal).toBe(inputTotal);
        expect(result.adjustedContributions.reduce(
          (sum, item) => sum + item.amount + (item.deadAmount ?? 0),
          0,
        )).toBe(potTotal);
      },
    ), { numRuns: 2_000 });
  });

  it("preserves each pot amount when awarding one or two boards", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 1, max: 2_000 }), { minLength: 2, maxLength: 9 }),
      fc.boolean(),
      (amounts, twice) => {
        const contributions = amounts.map((amount, seat) => ({
          playerId: `p${seat}`,
          seat,
          amount,
          folded: false,
        }));
        const { pots } = buildPots(contributions);
        const ranks = contributions.map((player) => ({
          playerId: player.playerId,
          seat: player.seat,
          rank: player.seat % 3,
        }));
        const awards = awardPots(
          pots,
          twice ? [ranks, ranks] : [ranks],
          (left, right) => Number(left) - Number(right),
          0,
          contributions.length,
        );
        expect(awards.reduce((sum, award) => sum + award.amount, 0))
          .toBe(pots.reduce((sum, pot) => sum + pot.amount, 0));
      },
    ), { numRuns: 1_000 });
  });
});
