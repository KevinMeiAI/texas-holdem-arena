import type { ArenaBroadcast } from "./types";

export function defaultWatchRoomTournament<T extends { status: string }>(tournaments: readonly T[]): T | null {
  return tournaments.find((tournament) => ["READY", "RUNNING", "PAUSED_INFRA"].includes(tournament.status))
    ?? tournaments.find((tournament) => tournament.status === "COMPLETED")
    ?? tournaments[0]
    ?? null;
}

export function unseenBroadcastFrames(
  timeline: readonly ArenaBroadcast[],
  afterSequence: number,
  queuedSequences: ReadonlySet<number> = new Set(),
): ArenaBroadcast[] {
  const unique = new Map<number, ArenaBroadcast>();
  for (const frame of timeline) {
    if (frame.sequence <= afterSequence || queuedSequences.has(frame.sequence)) continue;
    unique.set(frame.sequence, frame);
  }
  return [...unique.values()].sort((left, right) => left.sequence - right.sequence);
}

export function replaySequenceSteps(
  timeline: readonly ArenaBroadcast[],
  visibleEventSequences: readonly number[],
): number[] {
  const firstFrameSequence = Math.min(...timeline.map((frame) => frame.sequence));
  if (!Number.isFinite(firstFrameSequence)) return [];
  return [...new Set([
    ...timeline.map((frame) => frame.sequence),
    ...visibleEventSequences.filter((sequence) => sequence >= firstFrameSequence),
  ])].sort((left, right) => left - right);
}

export function broadcastFrameAtSequence(
  timeline: readonly ArenaBroadcast[],
  sequence: number,
): ArenaBroadcast | null {
  let selected: ArenaBroadcast | null = null;
  for (const frame of timeline) {
    if (frame.sequence > sequence) continue;
    if (!selected || frame.sequence > selected.sequence) selected = frame;
  }
  return selected;
}
