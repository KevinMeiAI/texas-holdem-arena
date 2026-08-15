import type { ArenaBroadcast } from "./types";

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
