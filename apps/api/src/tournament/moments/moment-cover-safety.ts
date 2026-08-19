import type { BroadcastView } from "../broadcast-view.js";

const REVEAL_EVENT_TYPES = new Set(["SHOWDOWN_REVEALED", "HAND_COMPLETED"]);
const REVEAL_STREETS = new Set(["SHOWDOWN", "HAND_COMPLETE"]);
const EQUITY_EPSILON = 1e-12;

export interface MomentCoverEvent {
  sequence: number;
  type: string;
  handNo: number | null;
}

export interface SuspenseCoverSource {
  handNo: number;
  sequence: number;
  frames: readonly BroadcastView[];
  events: readonly MomentCoverEvent[];
}

export type SuspenseCoverUnsafeReason =
  | "REVEAL_EVENT"
  | "TERMINAL_STREET"
  | "RIVER_COMPLETE"
  | "SINGLE_CONTENDER"
  | "DETERMINISTIC_EQUITY";

export interface SuspenseCoverSafety {
  safe: boolean;
  frame: BroadcastView | null;
  reason: SuspenseCoverUnsafeReason | null;
}

function frameAtOrBefore(
  frames: readonly BroadcastView[],
  handNo: number,
  sequence: number,
): BroadcastView | null {
  return [...frames]
    .filter((frame) => frame.handNo === handNo && frame.sequence <= sequence)
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1) ?? null;
}

function revealOccurred(
  events: readonly MomentCoverEvent[],
  handNo: number,
  sequence: number,
): boolean {
  return events.some((event) => (
    event.handNo === handNo
    && event.sequence <= sequence
    && REVEAL_EVENT_TYPES.has(event.type)
  ));
}

function deterministicEquity(frame: BroadcastView): boolean {
  const equities = frame.players
    .filter((player) => !player.folded && player.equity !== null)
    .map((player) => player.equity!);
  if (equities.length < 2) return false;
  const leaders = equities.filter((equity) => equity >= 1 - EQUITY_EPSILON);
  return leaders.length === 1
    && equities.filter((equity) => equity < 1 - EQUITY_EPSILON)
      .every((equity) => equity <= EQUITY_EPSILON);
}

export function suspenseCoverSafety(source: SuspenseCoverSource): SuspenseCoverSafety {
  const frame = frameAtOrBefore(source.frames, source.handNo, source.sequence);
  if (revealOccurred(source.events, source.handNo, source.sequence)) {
    return { safe: false, frame, reason: "REVEAL_EVENT" };
  }
  // A missing past frame renders the neutral cover and cannot expose future
  // information. The detector itself only selects concrete frames.
  if (!frame) return { safe: true, frame: null, reason: null };
  if (REVEAL_STREETS.has(frame.street.toUpperCase())) {
    return { safe: false, frame, reason: "TERMINAL_STREET" };
  }
  if (frame.board.length >= 5) {
    return { safe: false, frame, reason: "RIVER_COMPLETE" };
  }
  if (frame.players.filter((player) => !player.folded).length < 2) {
    return { safe: false, frame, reason: "SINGLE_CONTENDER" };
  }
  if (deterministicEquity(frame)) {
    return { safe: false, frame, reason: "DETERMINISTIC_EQUITY" };
  }
  return { safe: true, frame, reason: null };
}

export function latestSafeSuspenseCoverFrame(input: {
  handNo: number;
  startSequence: number;
  endSequence: number;
  frames: readonly BroadcastView[];
  events: readonly MomentCoverEvent[];
}): BroadcastView | null {
  const candidates = input.frames
    .filter((frame) => (
      frame.handNo === input.handNo
      && frame.sequence >= input.startSequence
      && frame.sequence <= input.endSequence
    ))
    .sort((left, right) => right.sequence - left.sequence);
  return candidates.find((frame) => suspenseCoverSafety({
    handNo: input.handNo,
    sequence: frame.sequence,
    frames: input.frames,
    events: input.events,
  }).safe) ?? null;
}
