import type { LoadedArenaEvent, StoredArenaEvent } from "./events.js";

export type ProjectionRole = "MODEL_SELF" | "SPECTATOR_LIVE" | "SPECTATOR_REPLAY" | "ADMIN_AUDIT";

export interface ProjectionRequest {
  role: ProjectionRole;
  playerId?: string;
  completedHandNos: ReadonlySet<number>;
}

export interface ProjectedArenaEvent {
  tournamentId: string;
  sequence: number;
  aggregateVersion: number;
  type: string;
  actorId: string | null;
  handNo: number | null;
  publicPayload: unknown;
  privatePayload?: unknown;
  eventHash: string;
  createdAt: string;
}

function mayReadPrivate(event: StoredArenaEvent, request: ProjectionRequest): boolean {
  if (!event.encryptedPrivatePayload || event.privateVisibility === "NONE") return false;
  if (event.privateVisibility === "ADMIN_AUDIT") return request.role === "ADMIN_AUDIT";
  if (request.role === "ADMIN_AUDIT") return true;
  if (request.role === "MODEL_SELF") return request.playerId === event.privateOwnerId;
  return event.handNo !== null && request.completedHandNos.has(event.handNo);
}

export function projectArenaEvent(
  loaded: LoadedArenaEvent,
  request: ProjectionRequest,
): ProjectedArenaEvent {
  const { event } = loaded;
  const base: ProjectedArenaEvent = {
    tournamentId: event.tournamentId,
    sequence: event.sequence,
    aggregateVersion: event.aggregateVersion,
    type: event.type,
    actorId: event.actorId,
    handNo: event.handNo,
    publicPayload: event.publicPayload,
    eventHash: event.eventHash,
    createdAt: event.createdAt,
  };
  return mayReadPrivate(event, request) && loaded.privatePayload !== undefined
    ? { ...base, privatePayload: loaded.privatePayload }
    : base;
}
