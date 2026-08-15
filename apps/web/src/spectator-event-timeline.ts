import type { ArenaEvent } from "./types";

export type SpectatorEventTone = "aggressive" | "passive" | "fold" | "deal" | "result" | "warning";

export interface SpectatorTimelineEvent {
  event: ArenaEvent;
  tone: SpectatorEventTone;
  sourceSequences: number[];
}

export interface SettlementPresentation {
  sequence: number;
  winnerPlayerIds: string[];
  amountsByPlayer: Record<string, number>;
  isFinalAward: boolean;
}

const visibleEventTypes = new Set([
  "TOURNAMENT_STARTED",
  "BLIND_LEVEL_SELECTED",
  "HAND_STARTED",
  "FORCED_BET_POSTED",
  "HOLE_CARDS_DEALT",
  "ACTION_APPLIED",
  "STREET_DEALT",
  "SHOWDOWN_REVEALED",
  "UNCALLED_BET_RETURNED",
  "POT_AWARDED",
  "HAND_COMPLETED",
  "PLAYER_ELIMINATED",
  "TOURNAMENT_COMPLETED",
  "TOURNAMENT_PAUSED_INFRA",
  "TOURNAMENT_PAUSED_ADMIN",
  "TOURNAMENT_RESUMED",
  "TOURNAMENT_CANCELLED",
]);

function actionClassification(event: ArenaEvent): string {
  const stored = event.publicPayload.classification;
  if (typeof stored === "string") return stored.toLowerCase();
  const command = event.publicPayload.command;
  if (command && typeof command === "object" && "action" in command && typeof command.action === "string") {
    return command.action.toLowerCase();
  }
  return "";
}

function eventTone(event: ArenaEvent): SpectatorEventTone {
  if (event.type === "ACTION_APPLIED") {
    const classification = actionClassification(event);
    if (classification === "bet" || classification === "raise" || classification === "short_raise") return "aggressive";
    if (classification === "fold") return "fold";
    return "passive";
  }
  if (event.type === "SHOWDOWN_REVEALED" || event.type === "UNCALLED_BET_RETURNED" || event.type === "POT_AWARDED"
    || event.type === "HAND_COMPLETED" || event.type === "PLAYER_ELIMINATED" || event.type === "TOURNAMENT_COMPLETED") {
    return "result";
  }
  if (event.type === "TOURNAMENT_PAUSED_INFRA" || event.type === "TOURNAMENT_PAUSED_ADMIN" || event.type === "TOURNAMENT_CANCELLED") {
    return "warning";
  }
  return "deal";
}

function awardDetails(event: ArenaEvent): { playerId: string; amount: number } | null {
  if (event.type !== "POT_AWARDED") return null;
  const award = event.publicPayload.award;
  if (!award || typeof award !== "object" || !("playerId" in award) || typeof award.playerId !== "string") return null;
  const amount = "amount" in award && typeof award.amount === "number" && Number.isFinite(award.amount) ? award.amount : 0;
  return { playerId: award.playerId, amount };
}

function mergeSingleWinnerAwards(events: ArenaEvent[]): { event: ArenaEvent; sourceSequences: number[] }[] {
  const awardsByHand = new Map<number | null, ArenaEvent[]>();
  for (const event of events) {
    if (event.type !== "POT_AWARDED") continue;
    const awards = awardsByHand.get(event.handNo) ?? [];
    awards.push(event);
    awardsByHand.set(event.handNo, awards);
  }
  const mergedByLastSequence = new Map<number, { event: ArenaEvent; sourceSequences: number[] }>();
  const suppressedSequences = new Set<number>();
  for (const awards of awardsByHand.values()) {
    if (awards.length < 2) continue;
    const details = awards.map(awardDetails);
    if (details.some((detail) => detail === null)) continue;
    const recipients = new Set(details.flatMap((detail) => detail ? [detail.playerId] : []));
    if (recipients.size !== 1) continue;
    const last = awards.at(-1)!;
    const lastAward = last.publicPayload.award as Record<string, unknown>;
    const amount = details.reduce((sum, detail) => sum + (detail?.amount ?? 0), 0);
    const sourceSequences = awards.map((award) => award.sequence);
    for (const sequence of sourceSequences.slice(0, -1)) suppressedSequences.add(sequence);
    mergedByLastSequence.set(last.sequence, {
      event: {
        ...last,
        publicPayload: {
          ...last.publicPayload,
          award: { ...lastAward, amount },
          mergedAwardCount: awards.length,
        },
      },
      sourceSequences,
    });
  }
  return events.flatMap((event) => {
    if (suppressedSequences.has(event.sequence)) return [];
    return [mergedByLastSequence.get(event.sequence) ?? { event, sourceSequences: [event.sequence] }];
  });
}

/**
 * Projects the immutable audit stream into a compact spectator timeline.
 * Raw events remain available to the action ledger and decision audit panels.
 */
export function spectatorTimeline(events: ArenaEvent[]): SpectatorTimelineEvent[] {
  const dealtHands = new Set<number | null>();
  const visibleEvents = [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .filter((event) => visibleEventTypes.has(event.type))
    .filter((event) => {
      if (event.type !== "HOLE_CARDS_DEALT") return true;
      if (dealtHands.has(event.handNo)) return false;
      dealtHands.add(event.handNo);
      return true;
    });
  return mergeSingleWinnerAwards(visibleEvents)
    .map(({ event, sourceSequences }) => ({ event, tone: eventTone(event), sourceSequences }));
}

export function settlementPresentationAtSequence(
  timeline: readonly SpectatorTimelineEvent[],
  sequence: number,
): SettlementPresentation | null {
  const current = timeline.find(({ event }) => event.sequence === sequence && event.type === "POT_AWARDED");
  if (!current) return null;
  const handAwards = timeline.filter(({ event }) => event.handNo === current.event.handNo && event.type === "POT_AWARDED");
  const handSettled = timeline.some(({ event }) => event.handNo === current.event.handNo && event.type === "HAND_COMPLETED");
  const isFinalAward = handSettled && handAwards.at(-1)?.event.sequence === current.event.sequence;
  const presentedAwards = isFinalAward ? handAwards : [current];
  const amountsByPlayer: Record<string, number> = {};
  for (const { event } of presentedAwards) {
    const detail = awardDetails(event);
    if (!detail) continue;
    amountsByPlayer[detail.playerId] = (amountsByPlayer[detail.playerId] ?? 0) + detail.amount;
  }
  const winnerPlayerIds = Object.keys(amountsByPlayer);
  return winnerPlayerIds.length > 0 ? {
    sequence,
    winnerPlayerIds,
    amountsByPlayer,
    isFinalAward,
  } : null;
}
