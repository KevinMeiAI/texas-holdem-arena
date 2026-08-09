import { describe, expect, it } from "vitest";
import { createDeck } from "./cards.js";
import { evaluateFive, HandCategory } from "./evaluator.js";

describe("five-card evaluator exhaustive distribution", () => {
  it("classifies all 2,598,960 distinct five-card hands", () => {
    const deck = createDeck();
    const counts = Array.from({ length: 9 }, () => 0);
    let total = 0;

    for (let a = 0; a < 48; a += 1) {
      for (let b = a + 1; b < 49; b += 1) {
        for (let c = b + 1; c < 50; c += 1) {
          for (let d = c + 1; d < 51; d += 1) {
            for (let e = d + 1; e < 52; e += 1) {
              const category = evaluateFive([
                deck[a]!, deck[b]!, deck[c]!, deck[d]!, deck[e]!,
              ]).category;
              counts[category] = (counts[category] ?? 0) + 1;
              total += 1;
            }
          }
        }
      }
    }

    expect(total).toBe(2_598_960);
    expect(counts).toEqual([
      1_302_540,
      1_098_240,
      123_552,
      54_912,
      10_200,
      5_108,
      3_744,
      624,
      40,
    ] satisfies Record<HandCategory, number> & number[]);
  }, 120_000);
});
