import { describe, expect, it } from "vitest";
import { parseCard } from "./cards.js";
import { compareHandRanks, evaluateBest, evaluateFive, HandCategory } from "./evaluator.js";

const cards = (value: string) => value.split(" ").map(parseCard);

describe("hand evaluator", () => {
  it.each([
    ["As Ks Qs Js Ts", HandCategory.StraightFlush, [14]],
    ["Ah Ad Ac As 2c", HandCategory.FourOfAKind, [14, 2]],
    ["Kh Kd Ks 2c 2d", HandCategory.FullHouse, [13, 2]],
    ["Ac Jc 8c 4c 2c", HandCategory.Flush, [14, 11, 8, 4, 2]],
    ["As 2d 3h 4c 5s", HandCategory.Straight, [5]],
    ["Qh Qd Qs 9c 2d", HandCategory.ThreeOfAKind, [12, 9, 2]],
    ["Jh Jd 4s 4c Ah", HandCategory.TwoPair, [11, 4, 14]],
    ["Th Td As 7c 3h", HandCategory.OnePair, [10, 14, 7, 3]],
    ["As Jd 9h 5c 2s", HandCategory.HighCard, [14, 11, 9, 5, 2]],
  ])("evaluates %s", (input, category, tiebreak) => {
    const rank = evaluateFive(cards(input));
    expect(rank.category).toBe(category);
    expect(rank.tiebreak).toEqual(tiebreak);
  });

  it("selects the best five cards from seven", () => {
    const rank = evaluateBest(cards("As Ah Ad Kc Kd 2s 3c"));
    expect(rank.category).toBe(HandCategory.FullHouse);
    expect(rank.tiebreak).toEqual([14, 13]);
  });

  it("lets the board play and tie", () => {
    const left = evaluateBest(cards("As Kd Qh Jc Ts 2s 2d"));
    const right = evaluateBest(cards("As Kd Qh Jc Ts 3s 3d"));
    expect(compareHandRanks(left, right)).toBe(0);
  });
});
