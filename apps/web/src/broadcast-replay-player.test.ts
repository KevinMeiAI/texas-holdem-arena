import { describe, expect, it } from "vitest";
import {
  broadcastReplayDataForKey,
  broadcastReplayReducer,
  buildBroadcastReplaySnapshot,
  initialBroadcastReplayState,
  shouldAdvanceBroadcastReplay,
  type BroadcastReplayState,
} from "./broadcast-replay-player";
import type { ArenaBroadcast, ArenaEvent } from "./types";

function frame(sequence: number): ArenaBroadcast {
  return {
    version: "test",
    equityVersion: "test",
    handNo: 1,
    sequence,
    street: "PREFLOP",
    board: [],
    pot: 100,
    pots: [],
    positions: null,
    blinds: null,
    currentActorId: null,
    estimated: false,
    samples: 1,
    players: [],
  };
}

function event(
  sequence: number,
  type: string,
  publicPayload: Record<string, unknown> = {},
  actorId: string | null = null,
): ArenaEvent {
  return {
    tournamentId: "tournament",
    sequence,
    aggregateVersion: sequence,
    type,
    actorId,
    handNo: 1,
    publicPayload,
    eventHash: `hash-${sequence}`,
    createdAt: "2026-08-19T00:00:00.000Z",
  };
}

describe("broadcast replay player", () => {
  it("does not become active merely because a completed tournament has replay data", () => {
    const data = {
      timeline: [frame(10)],
      events: [event(10, "ACTION_APPLIED", { classification: "check", command: { action: "check" } }, "alpha")],
    };

    expect(buildBroadcastReplaySnapshot(data, initialBroadcastReplayState, false).active).toBe(false);
    expect(buildBroadcastReplaySnapshot(data, initialBroadcastReplayState, true).active).toBe(false);

    const loading = broadcastReplayReducer(initialBroadcastReplayState, { type: "START" });
    expect(buildBroadcastReplaySnapshot(data, loading, true).active).toBe(false);
    const playing = broadcastReplayReducer(loading, { type: "DATA_READY", stepCount: 1 });
    expect(buildBroadcastReplaySnapshot(data, playing, true).active).toBe(true);
    expect(shouldAdvanceBroadcastReplay(
      playing,
      buildBroadcastReplaySnapshot(data, playing, false),
    )).toBe(false);
  });

  it("never accepts data returned for a different replay identity", () => {
    const data = { timeline: [frame(10)], events: [] };
    expect(broadcastReplayDataForKey("moment:new:2", "moment:old:1", data)).toBeNull();
    expect(broadcastReplayDataForKey("moment:new:2", "moment:new:2", data)).toBe(data);
    expect(broadcastReplayDataForKey(null, null, data)).toBeNull();
  });

  it("resets playback on tournament changes while preserving the selected rate", () => {
    const playing: BroadcastReplayState = { status: "playing", stepIndex: 7, rate: 1.5 };
    expect(broadcastReplayReducer(playing, { type: "RESET" })).toEqual({
      status: "idle",
      stepIndex: 0,
      rate: 1.5,
    });
  });

  it("pauses, resumes, advances, and ends without changing playback rate", () => {
    let state = broadcastReplayReducer(initialBroadcastReplayState, { type: "SET_RATE", rate: 2 });
    state = broadcastReplayReducer(state, { type: "START" });
    state = broadcastReplayReducer(state, { type: "DATA_READY", stepCount: 2 });
    expect(state).toEqual({ status: "playing", stepIndex: 0, rate: 2 });

    state = broadcastReplayReducer(state, { type: "PAUSE" });
    expect(broadcastReplayReducer(state, { type: "ADVANCE", stepCount: 2 }).stepIndex).toBe(0);
    state = broadcastReplayReducer(state, { type: "RESUME" });
    state = broadcastReplayReducer(state, { type: "ADVANCE", stepCount: 2 });
    expect(state).toEqual({ status: "playing", stepIndex: 1, rate: 2 });
    state = broadcastReplayReducer(state, { type: "ADVANCE", stepCount: 2 });
    expect(state).toEqual({ status: "ended", stepIndex: 2, rate: 2 });
  });

  it("derives the authoritative frame, merged settlement, and eliminated players at each sequence", () => {
    const data = {
      timeline: [frame(10), frame(20)],
      events: [
        event(10, "ACTION_APPLIED", { classification: "call", command: { action: "call" }, paid: 50 }, "beta"),
        event(18, "POT_AWARDED", { award: { potIndex: 0, playerId: "alpha", amount: 40 } }),
        event(20, "POT_AWARDED", { award: { potIndex: 1, playerId: "alpha", amount: 60 } }),
        event(21, "HAND_COMPLETED"),
        event(22, "PLAYER_ELIMINATED", { finishingPosition: 2 }, "beta"),
        { ...event(30, "TOURNAMENT_COMPLETED"), handNo: null },
      ],
    };
    const playing: BroadcastReplayState = { status: "playing", stepIndex: 1, rate: 1 };
    const settlement = buildBroadcastReplaySnapshot(data, playing, true);

    expect(settlement.steps).toEqual([10, 20, 21, 22, 30]);
    expect(settlement.sequence).toBe(20);
    expect(settlement.frame?.sequence).toBe(20);
    expect(settlement.settlement).toEqual({
      sequence: 20,
      winnerPlayerIds: ["alpha"],
      amountsByPlayer: { alpha: 100 },
      isFinalAward: true,
    });
    expect(settlement.eliminatedPlayerIds.size).toBe(0);

    const afterElimination = buildBroadcastReplaySnapshot(data, { ...playing, stepIndex: 3 }, true);
    expect(afterElimination.sequence).toBe(22);
    expect(afterElimination.eliminatedPlayerIds).toEqual(new Set(["beta"]));
  });

  it("keeps a moment replay inside its window and applies its starting baseline", () => {
    const data = {
      timeline: [frame(25), frame(35)],
      events: [
        event(25, "ACTION_APPLIED", { classification: "raise", command: { action: "raise" } }, "alpha"),
        event(28, "PLAYER_ELIMINATED", { finishingPosition: 3 }, "beta"),
        event(35, "ACTION_APPLIED", { classification: "call", command: { action: "call" } }, "gamma"),
      ],
      window: {
        startSequence: 20,
        endSequence: 30,
        initialFrame: frame(18),
        initialEliminatedPlayerIds: ["delta"],
      },
    };
    const playing: BroadcastReplayState = { status: "playing", stepIndex: 0, rate: 1 };

    const opening = buildBroadcastReplaySnapshot(data, playing, true);
    expect(opening.steps).toEqual([20, 25, 28]);
    expect(opening.sequence).toBe(20);
    expect(opening.frame?.sequence).toBe(18);
    expect(opening.eliminatedPlayerIds).toEqual(new Set(["delta"]));

    const ended = buildBroadcastReplaySnapshot(
      data,
      { ...playing, status: "ended", stepIndex: opening.steps.length },
      true,
    );
    expect(ended.sequence).toBe(30);
    expect(ended.frame?.sequence).toBe(25);
    expect(ended.visibleEvents.map((item) => item.sequence)).toEqual([25, 28]);
    expect(ended.eliminatedPlayerIds).toEqual(new Set(["delta", "beta"]));

    expect(buildBroadcastReplaySnapshot(data, playing, false).eliminatedPlayerIds).toEqual(new Set());
  });

  it("keeps the final causal table frame when a moment window includes tournament completion", () => {
    const terminalEvent = { ...event(31, "TOURNAMENT_COMPLETED"), handNo: null };
    const data = {
      timeline: [frame(25), frame(29)],
      events: [
        event(29, "HAND_COMPLETED"),
        terminalEvent,
      ],
      window: {
        startSequence: 20,
        endSequence: 31,
        initialFrame: frame(18),
        initialEliminatedPlayerIds: [],
      },
    };
    const ended: BroadcastReplayState = { status: "ended", stepIndex: 4, rate: 1 };
    const snapshot = buildBroadcastReplaySnapshot(data, ended, true);

    expect(snapshot.sequence).toBe(31);
    expect(snapshot.frame?.sequence).toBe(29);
    expect(snapshot.visibleEvents.at(-1)?.type).toBe("TOURNAMENT_COMPLETED");

    const fullReplaySnapshot = buildBroadcastReplaySnapshot(
      { timeline: data.timeline, events: data.events },
      { status: "playing", stepIndex: 2, rate: 1 },
      true,
    );
    expect(fullReplaySnapshot.sequence).toBe(31);
    expect(fullReplaySnapshot.frame).toBeNull();
  });

  it("rejects invalid or non-causal moment windows", () => {
    const playing: BroadcastReplayState = { status: "playing", stepIndex: 0, rate: 1 };
    const base = { timeline: [frame(25)], events: [] };
    const reversed = buildBroadcastReplaySnapshot({
      ...base,
      window: {
        startSequence: 30,
        endSequence: 20,
        initialFrame: null,
        initialEliminatedPlayerIds: [],
      },
    }, playing, true);
    const futureBaseline = buildBroadcastReplaySnapshot({
      ...base,
      window: {
        startSequence: 20,
        endSequence: 30,
        initialFrame: frame(21),
        initialEliminatedPlayerIds: [],
      },
    }, playing, true);

    expect(reversed.active).toBe(false);
    expect(futureBaseline.active).toBe(false);
  });

  it("clears transient winner presentation once a replay window ends", () => {
    const data = {
      timeline: [frame(20)],
      events: [event(20, "POT_AWARDED", { award: { potIndex: 0, playerId: "alpha", amount: 100 } })],
      window: {
        startSequence: 20,
        endSequence: 20,
        initialFrame: frame(19),
        initialEliminatedPlayerIds: [],
      },
    };
    const playing: BroadcastReplayState = { status: "playing", stepIndex: 1, rate: 1 };
    const ended: BroadcastReplayState = { status: "ended", stepIndex: 1, rate: 1 };

    expect(buildBroadcastReplaySnapshot(data, playing, true).settlement?.winnerPlayerIds).toEqual(["alpha"]);
    expect(buildBroadcastReplaySnapshot(data, ended, true).settlement).toBeNull();
  });
});
