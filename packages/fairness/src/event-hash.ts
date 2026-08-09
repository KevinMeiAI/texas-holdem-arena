import { createHash } from "node:crypto";
import type { EncryptedPayload, StoredArenaEvent } from "../../contracts/src/events.js";
import { canonicalJson } from "./canonical-json.js";

export const GENESIS_EVENT_HASH = "0".repeat(64);

export interface HashableArenaEvent {
  tournamentId: string;
  sequence: number;
  aggregateVersion: number;
  type: string;
  actorId: string | null;
  handNo: number | null;
  publicPayload: unknown;
  encryptedPrivatePayload: EncryptedPayload | null;
  privateVisibility: StoredArenaEvent["privateVisibility"];
  privateOwnerId: string | null;
}

export function hashArenaEvent(event: HashableArenaEvent, prevHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(prevHash)) throw new Error("Previous event hash is invalid");
  return createHash("sha256")
    .update(canonicalJson(event))
    .update("\0")
    .update(prevHash)
    .digest("hex");
}

export interface ChainVerification {
  valid: boolean;
  verifiedEvents: number;
  errorSequence?: number;
  reason?: string;
  finalHash: string;
}

export function verifyEventChain(events: readonly StoredArenaEvent[]): ChainVerification {
  let prevHash = GENESIS_EVENT_HASH;
  let priorSequence = 0;
  let priorVersion = 0;
  const tournamentId = events[0]?.tournamentId;
  for (const event of events) {
    if (event.tournamentId !== tournamentId) {
      return {
        valid: false,
        verifiedEvents: priorSequence,
        errorSequence: event.sequence,
        reason: "mixed_tournament_chain",
        finalHash: prevHash,
      };
    }
    if (event.sequence !== priorSequence + 1) {
      return {
        valid: false,
        verifiedEvents: priorSequence,
        errorSequence: event.sequence,
        reason: "non_contiguous_sequence",
        finalHash: prevHash,
      };
    }
    if (event.aggregateVersion !== priorVersion + 1 || event.prevHash !== prevHash) {
      return {
        valid: false,
        verifiedEvents: priorSequence,
        errorSequence: event.sequence,
        reason: "broken_chain_link",
        finalHash: prevHash,
      };
    }
    const calculated = hashArenaEvent({
      tournamentId: event.tournamentId,
      sequence: event.sequence,
      aggregateVersion: event.aggregateVersion,
      type: event.type,
      actorId: event.actorId,
      handNo: event.handNo,
      publicPayload: event.publicPayload,
      encryptedPrivatePayload: event.encryptedPrivatePayload,
      privateVisibility: event.privateVisibility,
      privateOwnerId: event.privateOwnerId,
    }, prevHash);
    if (calculated !== event.eventHash) {
      return {
        valid: false,
        verifiedEvents: priorSequence,
        errorSequence: event.sequence,
        reason: "event_hash_mismatch",
        finalHash: prevHash,
      };
    }
    prevHash = event.eventHash;
    priorSequence = event.sequence;
    priorVersion = event.aggregateVersion;
  }
  return { valid: true, verifiedEvents: events.length, finalHash: prevHash };
}
