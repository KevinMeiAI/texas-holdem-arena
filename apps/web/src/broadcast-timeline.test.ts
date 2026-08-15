import { describe, expect, it } from "vitest";
import type { ArenaBroadcast } from "./types";
import { unseenBroadcastFrames } from "./broadcast-timeline";

function frame(sequence: number): ArenaBroadcast {
  return {
    version: "test",
    equityVersion: "test",
    handNo: 1,
    sequence,
    street: "PREFLOP",
    board: [],
    pot: 0,
    positions: null,
    blinds: null,
    currentActorId: null,
    estimated: false,
    samples: 1,
    players: [],
  };
}

describe("broadcast timeline queue", () => {
  it("returns only unseen frames in sequence order without duplicates", () => {
    expect(unseenBroadcastFrames(
      [frame(12), frame(10), frame(11), frame(12), frame(9)],
      9,
      new Set([11]),
    ).map((item) => item.sequence)).toEqual([10, 12]);
  });
});
