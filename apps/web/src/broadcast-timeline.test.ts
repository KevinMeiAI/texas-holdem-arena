import { describe, expect, it } from "vitest";
import type { ArenaBroadcast } from "./types";
import { broadcastFrameAtSequence, defaultWatchRoomTournament, replaySequenceSteps, unseenBroadcastFrames } from "./broadcast-timeline";

function frame(sequence: number): ArenaBroadcast {
  return {
    version: "test",
    equityVersion: "test",
    handNo: 1,
    sequence,
    street: "PREFLOP",
    board: [],
    pot: 0,
    pots: [],
    positions: null,
    blinds: null,
    currentActorId: null,
    estimated: false,
    samples: 1,
    players: [],
  };
}

describe("broadcast timeline queue", () => {
  it("anchors the watch room to a live tournament, then the latest completed one", () => {
    const completed = { id: "completed", status: "COMPLETED" };
    const cancelled = { id: "cancelled", status: "CANCELLED" };
    const live = { id: "live", status: "RUNNING" };
    expect(defaultWatchRoomTournament([completed, live])).toBe(live);
    expect(defaultWatchRoomTournament([cancelled, completed])).toBe(completed);
    expect(defaultWatchRoomTournament([cancelled])).toBe(cancelled);
    expect(defaultWatchRoomTournament([])).toBeNull();
  });

  it("returns only unseen frames in sequence order without duplicates", () => {
    expect(unseenBroadcastFrames(
      [frame(12), frame(10), frame(11), frame(12), frame(9)],
      9,
      new Set([11]),
    ).map((item) => item.sequence)).toEqual([10, 12]);
  });

  it("builds uniform replay steps from visible events and broadcast frames", () => {
    const timeline = [frame(12), frame(20), frame(28)];
    expect(replaySequenceSteps(timeline, [1, 10, 12, 14, 20, 24, 30])).toEqual([12, 14, 20, 24, 28, 30]);
    expect(replaySequenceSteps(timeline, [12, 30], new Set([20]))).toEqual([12, 28, 30]);
    expect(broadcastFrameAtSequence(timeline, 24)?.sequence).toBe(20);
    expect(broadcastFrameAtSequence(timeline, 11)).toBeNull();
  });
});
