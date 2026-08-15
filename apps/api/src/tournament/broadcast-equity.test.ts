import { describe, expect, it } from "vitest";
import { parseCard } from "../../../../packages/domain/src/cards.js";
import { calculateBroadcastEquity } from "./broadcast-equity.js";

const cards = (value: string) => value.split(" ").map(parseCard);

describe("broadcast showdown equity", () => {
  it("is exact and deterministic when the board is complete", () => {
    const [heroA, heroK, villainA, villainQ] = cards("As Ks Ah Qh");
    const result = calculateBroadcastEquity([
      { playerId: "hero", holeCards: [heroA!, heroK!], folded: false },
      { playerId: "villain", holeCards: [villainA!, villainQ!], folded: false },
    ], cards("2c 3d 4h 8s Tc"), { seed: "river" });

    expect(result).toMatchObject({ estimated: false, samples: 1 });
    expect(result.players).toEqual([
      expect.objectContaining({ playerId: "hero", equity: 1, outrightWinProbability: 1, tieProbability: 0 }),
      expect.objectContaining({ playerId: "villain", equity: 0, outrightWinProbability: 0, tieProbability: 0 }),
    ]);
  });

  it("splits tied equity and omits folded players", () => {
    const [heroA, heroK, villainA, villainQ, folded2, folded3] = cards("As Ks Ah Qh 2d 3d");
    const result = calculateBroadcastEquity([
      { playerId: "hero", holeCards: [heroA!, heroK!], folded: false },
      { playerId: "villain", holeCards: [villainA!, villainQ!], folded: false },
      { playerId: "folded", holeCards: [folded2!, folded3!], folded: true },
    ], cards("Tc Jc Qc Kc Ac"), { seed: "tie" });

    expect(result.players).toEqual([
      expect.objectContaining({ playerId: "hero", equity: 0.5, outrightWinProbability: 0, tieProbability: 1 }),
      expect.objectContaining({ playerId: "villain", equity: 0.5, outrightWinProbability: 0, tieProbability: 1 }),
      expect.objectContaining({ playerId: "folded", equity: null, outrightWinProbability: null, tieProbability: null }),
    ]);
  });

  it("uses every dealt hand as dead cards and produces repeatable estimates", () => {
    const [heroA, heroK, villainQ, villainJ, folded2, folded3] = cards("As Ks Qh Jh 2d 3d");
    const players = [
      { playerId: "hero", holeCards: [heroA!, heroK!] as const, folded: false },
      { playerId: "villain", holeCards: [villainQ!, villainJ!] as const, folded: false },
      { playerId: "folded", holeCards: [folded2!, folded3!] as const, folded: true },
    ];
    const first = calculateBroadcastEquity(players, [], { seed: "same", exactCombinationLimit: 1, sampleCount: 500 });
    const second = calculateBroadcastEquity(players, [], { seed: "same", exactCombinationLimit: 1, sampleCount: 500 });

    expect(first).toEqual(second);
    expect(first).toMatchObject({ estimated: true, samples: 500 });
    expect(first.players.reduce((sum, player) => sum + (player.equity ?? 0), 0)).toBeCloseTo(1, 10);
  });
});
