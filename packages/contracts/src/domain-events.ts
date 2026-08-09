import type { HandEvent } from "../../domain/src/reducer.js";
import type { TournamentEvent } from "../../domain/src/tournament.js";
import type { NewArenaEvent } from "./events.js";

function publicEvent(
  type: string,
  handNo: number | null,
  publicPayload: unknown,
  actorId: string | null = null,
): NewArenaEvent {
  return {
    type,
    actorId,
    handNo,
    publicPayload,
    privateVisibility: "NONE",
    privateOwnerId: null,
  };
}

export function handEventToArenaEvent(handNo: number, event: HandEvent): NewArenaEvent {
  if (event.type === "HOLE_CARDS_DEALT") {
    return {
      type: event.type,
      actorId: null,
      handNo,
      publicPayload: { playerId: event.playerId },
      privatePayload: { cards: event.cards },
      privateVisibility: "PLAYER_HOLE_CARDS",
      privateOwnerId: event.playerId,
    };
  }
  if (event.type === "STREET_DEALT") {
    return {
      type: event.type,
      actorId: null,
      handNo,
      publicPayload: {
        boardIndex: event.boardIndex,
        street: event.street,
        cards: event.cards,
      },
      privatePayload: { burn: event.burn },
      privateVisibility: "ADMIN_AUDIT",
      privateOwnerId: null,
    };
  }
  if (event.type === "ACTION_APPLIED") {
    return publicEvent(event.type, handNo, {
      street: event.street,
      command: event.command,
      paid: event.paid,
      amountTo: event.amountTo,
    }, event.playerId);
  }
  if (event.type === "RUNOUT_VOTE_CAST") {
    return publicEvent(event.type, handNo, {
      acceptRunItTwice: event.acceptRunItTwice,
      message: event.message,
      source: event.source,
    }, event.playerId);
  }
  const { type, ...payload } = event;
  return publicEvent(type, handNo, payload);
}

export function tournamentEventToArenaEvents(
  event: TournamentEvent,
  currentHandNo: number | null,
): NewArenaEvent[] {
  if (event.type === "HAND_EVENT") {
    const handNo = "handNo" in event.event && typeof event.event.handNo === "number"
      ? event.event.handNo
      : currentHandNo;
    if (handNo === null) {
      throw new Error("Wrapped hand event requires its hand number in persistence context");
    }
    return [handEventToArenaEvent(handNo, event.event)];
  }
  if (event.type === "PLAYER_ELIMINATED") {
    const { type, playerId, ...payload } = event;
    return [publicEvent(type, event.handNo, payload, playerId)];
  }
  const { type, ...payload } = event;
  return [publicEvent(type, null, payload)];
}
