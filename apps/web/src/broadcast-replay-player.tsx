import { useEffect, useLayoutEffect, useMemo, useReducer } from "react";
import { broadcastFrameAtSequence, replaySequenceSteps } from "./broadcast-timeline";
import {
  settlementPresentationAtSequence,
  spectatorTimeline,
  type SettlementPresentation,
} from "./spectator-event-timeline";
import type { ArenaBroadcast, ArenaEvent } from "./types";

export type BroadcastReplayStatus = "idle" | "loading" | "playing" | "paused" | "ended";

export interface BroadcastReplayState {
  status: BroadcastReplayStatus;
  stepIndex: number;
  rate: number;
}

export type BroadcastReplayAction =
  | { type: "RESET" }
  | { type: "START" }
  | { type: "DATA_READY"; stepCount: number }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "ADVANCE"; stepCount: number }
  | { type: "SET_RATE"; rate: number };

export const initialBroadcastReplayState: BroadcastReplayState = {
  status: "idle",
  stepIndex: 0,
  rate: 1,
};

export function broadcastReplayReducer(
  state: BroadcastReplayState,
  action: BroadcastReplayAction,
): BroadcastReplayState {
  if (action.type === "RESET") {
    return { ...initialBroadcastReplayState, rate: state.rate };
  }
  if (action.type === "START") {
    return { ...state, status: "loading", stepIndex: 0 };
  }
  if (action.type === "DATA_READY") {
    if (state.status !== "loading") return state;
    return { ...state, status: action.stepCount > 0 ? "playing" : "ended", stepIndex: 0 };
  }
  if (action.type === "PAUSE") {
    return state.status === "playing" ? { ...state, status: "paused" } : state;
  }
  if (action.type === "RESUME") {
    return state.status === "paused" ? { ...state, status: "playing" } : state;
  }
  if (action.type === "ADVANCE") {
    if (state.status !== "playing" || action.stepCount === 0) return state;
    return state.stepIndex >= action.stepCount - 1
      ? { ...state, status: "ended", stepIndex: action.stepCount }
      : { ...state, stepIndex: state.stepIndex + 1 };
  }
  if (!Number.isFinite(action.rate) || action.rate <= 0) return state;
  return { ...state, rate: action.rate };
}

interface BroadcastReplayDataBase {
  timeline: ArenaBroadcast[];
  events: ArenaEvent[];
}

export interface FullBroadcastReplayData extends BroadcastReplayDataBase {
  window?: never;
}

export interface WindowedBroadcastReplayData extends BroadcastReplayDataBase {
  window: {
    startSequence: number;
    endSequence: number;
    initialFrame: ArenaBroadcast | null;
    initialEliminatedPlayerIds: readonly string[];
  };
}

export type BroadcastReplayData = FullBroadcastReplayData | WindowedBroadcastReplayData;

export interface BroadcastReplaySnapshot {
  active: boolean;
  sequence: number;
  frame: ArenaBroadcast | null;
  settlement: SettlementPresentation | null;
  visibleEvents: ArenaEvent[];
  eliminatedPlayerIds: Set<string>;
  steps: number[];
  progress: number;
}

interface PreparedBroadcastReplay {
  data: BroadcastReplayData | null;
  lookupTimeline: ArenaBroadcast[];
  events: ArenaEvent[];
  spectatorEvents: ReturnType<typeof spectatorTimeline>;
  steps: number[];
  terminalSequence: number;
  playbackEndSequence: number | null;
  initialEliminatedPlayerIds: readonly string[];
}

function eliminatedPlayers(events: readonly ArenaEvent[]): Set<string> {
  return new Set(events.flatMap((event) => {
    if (event.type !== "PLAYER_ELIMINATED") return [];
    const playerId = event.actorId ?? event.publicPayload.playerId;
    return typeof playerId === "string" ? [playerId] : [];
  }));
}

function prepareBroadcastReplay(data: BroadcastReplayData | null): PreparedBroadcastReplay {
  const replayWindow = data?.window;
  const playbackStartSequence = replayWindow?.startSequence ?? null;
  const playbackEndSequence = replayWindow?.endSequence ?? null;
  const validWindow = !replayWindow || (
    Number.isFinite(replayWindow.startSequence)
    && Number.isFinite(replayWindow.endSequence)
    && replayWindow.startSequence <= replayWindow.endSequence
    && (replayWindow.initialFrame === null
      || replayWindow.initialFrame.sequence <= replayWindow.startSequence)
  );
  const insideWindow = (sequence: number) => validWindow
    && (playbackStartSequence === null || sequence >= playbackStartSequence)
    && (playbackEndSequence === null || sequence <= playbackEndSequence);
  const timeline = (data?.timeline ?? []).filter((frame) => insideWindow(frame.sequence));
  const events = (data?.events ?? []).filter((event) => insideWindow(event.sequence));
  const spectatorEvents = spectatorTimeline(events);
  const suppressedFrames = new Set(spectatorEvents.flatMap(({ event, sourceSequences }) => (
    event.type === "POT_AWARDED" ? sourceSequences.filter((sequence) => sequence !== event.sequence) : []
  )));
  const steps = replayWindow === undefined
    ? replaySequenceSteps(
        timeline,
        spectatorEvents.map(({ event }) => event.sequence),
        suppressedFrames,
      )
    : [...new Set([
        ...(validWindow && replayWindow.initialFrame ? [replayWindow.startSequence] : []),
        ...timeline.map((frame) => frame.sequence).filter((sequence) => !suppressedFrames.has(sequence)),
        ...spectatorEvents.map(({ event }) => event.sequence),
      ])].sort((left, right) => left - right);
  const lookupTimeline = replayWindow?.initialFrame
    ? [
        replayWindow.initialFrame,
        ...timeline.filter((frame) => frame.sequence !== replayWindow.initialFrame?.sequence),
      ]
    : timeline;
  const terminalSequences = events.flatMap((event) => (
    event.type === "TOURNAMENT_COMPLETED" || event.type === "TOURNAMENT_CANCELLED"
      ? [event.sequence]
      : []
  ));
  return {
    data: validWindow ? data : null,
    lookupTimeline,
    events,
    spectatorEvents,
    steps,
    terminalSequence: terminalSequences.length > 0
      ? Math.min(...terminalSequences)
      : Number.POSITIVE_INFINITY,
    playbackEndSequence,
    initialEliminatedPlayerIds: replayWindow?.initialEliminatedPlayerIds ?? [],
  };
}

function replaySnapshot(
  prepared: PreparedBroadcastReplay,
  state: BroadcastReplayState,
  requested: boolean,
): BroadcastReplaySnapshot {
  const {
    events,
    initialEliminatedPlayerIds,
    lookupTimeline,
    playbackEndSequence,
    spectatorEvents,
    steps,
    terminalSequence,
  } = prepared;
  const active = requested
    && prepared.data !== null
    && (state.status === "playing" || state.status === "paused" || state.status === "ended");
  const sequence = state.stepIndex >= steps.length
    ? playbackEndSequence ?? Number.POSITIVE_INFINITY
    : steps[state.stepIndex] ?? 0;
  const keepWindowTerminalFrame = playbackEndSequence !== null;
  const frame = active && (sequence < terminalSequence || keepWindowTerminalFrame)
    ? broadcastFrameAtSequence(lookupTimeline, sequence)
    : null;
  const settlement = active && state.status !== "ended"
    ? settlementPresentationAtSequence(spectatorEvents, sequence)
    : null;
  const visibleEvents = active
    ? events.filter((event) => event.sequence <= sequence)
    : [];
  return {
    active,
    sequence,
    frame,
    settlement,
    visibleEvents,
    eliminatedPlayerIds: active
      ? new Set([
          ...initialEliminatedPlayerIds,
          ...eliminatedPlayers(visibleEvents),
        ])
      : new Set(),
    steps,
    progress: steps.length === 0 ? 0 : Math.min(state.stepIndex + 1, steps.length),
  };
}

export function buildBroadcastReplaySnapshot(
  data: BroadcastReplayData | null,
  state: BroadcastReplayState,
  requested: boolean,
): BroadcastReplaySnapshot {
  return replaySnapshot(prepareBroadcastReplay(data), state, requested);
}

export function broadcastReplayDataForKey(
  replayKey: string | null,
  dataKey: string | null,
  data: BroadcastReplayData | null,
): BroadcastReplayData | null {
  return replayKey !== null && dataKey === replayKey ? data : null;
}

export function shouldAdvanceBroadcastReplay(
  state: BroadcastReplayState,
  snapshot: BroadcastReplaySnapshot,
): boolean {
  return snapshot.active && state.status === "playing" && snapshot.steps.length > 0;
}

export interface UseBroadcastReplayPlayerOptions {
  replayKey: string | null;
  dataKey: string | null;
  requested: boolean;
  data: BroadcastReplayData | null;
  frameIntervalMs?: number;
  settlementHoldMs?: number;
}

export function useBroadcastReplayPlayer({
  replayKey,
  dataKey,
  requested,
  data,
  frameIntervalMs = 1_400,
  settlementHoldMs = 2_000,
}: UseBroadcastReplayPlayerOptions) {
  const [state, dispatch] = useReducer(broadcastReplayReducer, initialBroadcastReplayState);
  const matchingData = broadcastReplayDataForKey(replayKey, dataKey, data);
  const prepared = useMemo(() => prepareBroadcastReplay(matchingData), [matchingData]);
  const snapshot = useMemo(
    () => replaySnapshot(prepared, state, requested),
    [prepared, requested, state],
  );

  useLayoutEffect(() => {
    dispatch({ type: "RESET" });
  }, [replayKey]);

  useEffect(() => {
    if (!requested) {
      if (state.status !== "idle") dispatch({ type: "RESET" });
      return;
    }
    if (!matchingData || state.status !== "loading") return;
    dispatch({ type: "DATA_READY", stepCount: snapshot.steps.length });
  }, [matchingData, requested, snapshot.steps.length, state.status]);

  useEffect(() => {
    if (!shouldAdvanceBroadcastReplay(state, snapshot)) return;
    const timer = window.setTimeout(() => {
      dispatch({ type: "ADVANCE", stepCount: snapshot.steps.length });
    }, (frameIntervalMs + (snapshot.settlement?.isFinalAward ? settlementHoldMs : 0)) / state.rate);
    return () => window.clearTimeout(timer);
  }, [
    frameIntervalMs,
    settlementHoldMs,
    snapshot.active,
    snapshot.settlement?.isFinalAward,
    snapshot.steps.length,
    state.rate,
    state.status,
    state.stepIndex,
  ]);

  return {
    ...snapshot,
    status: state.status,
    rate: state.rate,
    start: () => {
      if (replayKey !== null) dispatch({ type: "START" });
    },
    pause: () => dispatch({ type: "PAUSE" }),
    resume: () => dispatch({ type: "RESUME" }),
    reset: () => dispatch({ type: "RESET" }),
    setRate: (rate: number) => dispatch({ type: "SET_RATE", rate }),
  };
}
