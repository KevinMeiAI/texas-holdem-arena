import type { ArenaEvent } from "./types";

export type SpectatorEventTone = "aggressive" | "passive" | "fold" | "deal" | "result" | "warning";

export interface SpectatorTimelineEvent {
  event: ArenaEvent;
  tone: SpectatorEventTone;
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

/**
 * Projects the immutable audit stream into a compact spectator timeline.
 * Raw events remain available to the action ledger and decision audit panels.
 */
export function spectatorTimeline(events: ArenaEvent[]): SpectatorTimelineEvent[] {
  const dealtHands = new Set<number | null>();
  return [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .filter((event) => visibleEventTypes.has(event.type))
    .filter((event) => {
      if (event.type !== "HOLE_CARDS_DEALT") return true;
      if (dealtHands.has(event.handNo)) return false;
      dealtHands.add(event.handNo);
      return true;
    })
    .map((event) => ({ event, tone: eventTone(event) }));
}
