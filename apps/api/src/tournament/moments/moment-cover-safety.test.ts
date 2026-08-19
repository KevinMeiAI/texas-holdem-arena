import { describe, expect, it } from "vitest";
import { BROADCAST_EQUITY_VERSION } from "../broadcast-equity.js";
import {
  BROADCAST_VIEW_VERSION,
  type BroadcastView,
  type BroadcastViewPlayer,
} from "../broadcast-view.js";
import {
  latestSafeSuspenseCoverFrame,
  suspenseCoverSafety,
  type MomentCoverEvent,
} from "./moment-cover-safety.js";

function player(
  playerId: string,
  seat: number,
  equity: number | null,
  folded = false,
): BroadcastViewPlayer {
  return {
    playerId,
    seat,
    holeCards: ["As", "Ah"],
    stack: 0,
    folded,
    allIn: true,
    streetCommitted: 0,
    equity,
    outrightWinProbability: equity,
    tieProbability: 0,
    lastAction: null,
  };
}

function frame(
  sequence: number,
  street: string,
  board: string[],
  players = [player("a", 0, 0.8), player("b", 1, 0.2)],
): BroadcastView {
  return {
    version: BROADCAST_VIEW_VERSION,
    equityVersion: BROADCAST_EQUITY_VERSION,
    handNo: 4,
    sequence,
    street,
    board,
    pot: 200,
    pots: [],
    positions: null,
    blinds: null,
    currentActorId: null,
    estimated: board.length < 5,
    samples: 500,
    players,
  };
}

function event(sequence: number, type: string): MomentCoverEvent {
  return { sequence, type, handNo: 4 };
}

describe("suspense moment cover safety", () => {
  it("keeps the final unresolved turn frame and rejects the deterministic river", () => {
    const frames = [
      frame(30, "TURN", ["2c", "3d", "4h", "8s"]),
      frame(31, "RIVER", ["2c", "3d", "4h", "8s", "Tc"], [
        player("a", 0, 1),
        player("b", 1, 0),
      ]),
    ];

    expect(suspenseCoverSafety({ handNo: 4, sequence: 30, frames, events: [] }))
      .toMatchObject({ safe: true, frame: { sequence: 30 }, reason: null });
    expect(suspenseCoverSafety({ handNo: 4, sequence: 31, frames, events: [] }))
      .toMatchObject({ safe: false, frame: { sequence: 31 }, reason: "RIVER_COMPLETE" });
    expect(latestSafeSuspenseCoverFrame({
      handNo: 4,
      startSequence: 20,
      endSequence: 40,
      frames,
      events: [],
    })?.sequence).toBe(30);
  });

  it("rejects a cover after showdown even when its last available frame looks earlier", () => {
    const frames = [frame(30, "TURN", ["2c", "3d", "4h", "8s"])];
    expect(suspenseCoverSafety({
      handNo: 4,
      sequence: 32,
      frames,
      events: [event(32, "SHOWDOWN_REVEALED")],
    })).toMatchObject({ safe: false, reason: "REVEAL_EVENT" });
  });

  it("rejects fold-resolved and explicit 100/0 covers without needing a river", () => {
    const foldResolved = frame(25, "FLOP", ["2c", "3d", "4h"], [
      player("a", 0, 1),
      player("b", 1, 0, true),
    ]);
    const locked = frame(26, "TURN", ["2c", "3d", "4h", "8s"], [
      player("a", 0, 1),
      player("b", 1, 0),
    ]);

    expect(suspenseCoverSafety({ handNo: 4, sequence: 25, frames: [foldResolved], events: [] }))
      .toMatchObject({ safe: false, reason: "SINGLE_CONTENDER" });
    expect(suspenseCoverSafety({ handNo: 4, sequence: 26, frames: [locked], events: [] }))
      .toMatchObject({ safe: false, reason: "DETERMINISTIC_EQUITY" });
  });

  it("treats a missing causal frame as a neutral non-spoiling cover", () => {
    expect(suspenseCoverSafety({
      handNo: 4,
      sequence: 20,
      frames: [frame(21, "PREFLOP", [])],
      events: [],
    })).toEqual({ safe: true, frame: null, reason: null });
  });
});
