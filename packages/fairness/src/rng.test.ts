import { describe, expect, it } from "vitest";
import { createDeck } from "../../domain/src/cards.js";
import { deriveSeed, DeterministicRng, seedCommitment } from "./rng.js";

describe("verifiable deterministic RNG", () => {
  const seed = new Uint8Array(32).fill(7);

  it("produces stable domain-separated shuffles", () => {
    const first = new DeterministicRng(deriveSeed(seed, "hand:1")).shuffle(createDeck());
    const second = new DeterministicRng(deriveSeed(seed, "hand:1")).shuffle(createDeck());
    const other = new DeterministicRng(deriveSeed(seed, "hand:2")).shuffle(createDeck());
    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
    expect(new Set(first.map((card) => `${card.rank}${card.suit}`)).size).toBe(52);
  });

  it("binds a commitment to tournament and ruleset", () => {
    expect(seedCommitment(seed, "t1", "rules-v1")).toHaveLength(64);
    expect(seedCommitment(seed, "t1", "rules-v1")).not.toBe(seedCommitment(seed, "t2", "rules-v1"));
  });
});
