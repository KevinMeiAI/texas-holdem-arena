import { describe, expect, it } from "vitest";
import type { StoredArenaEvent } from "../../contracts/src/events.js";
import { canonicalJson } from "./canonical-json.js";
import { GENESIS_EVENT_HASH, hashArenaEvent, verifyEventChain } from "./event-hash.js";

function event(
  sequence: number,
  previousHash: string,
  publicPayload: unknown,
): StoredArenaEvent {
  const hashable = {
    tournamentId: "11111111-1111-4111-8111-111111111111",
    sequence,
    aggregateVersion: sequence,
    type: "TEST_EVENT",
    actorId: null,
    handNo: 1,
    publicPayload,
    encryptedPrivatePayload: null,
    privateVisibility: "NONE" as const,
    privateOwnerId: null,
  };
  return {
    ...hashable,
    prevHash: previousHash,
    eventHash: hashArenaEvent(hashable, previousHash),
    createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
  };
}

describe("canonical event hash chain", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: [3, { b: true, a: false }] } }))
      .toBe('{"a":{"x":[3,{"a":false,"b":true}],"y":2},"z":1}');
    expect(() => canonicalJson(new Date())).toThrow(/plain objects/);
  });

  it("verifies an intact chain and detects payload tampering", () => {
    const first = event(1, GENESIS_EVENT_HASH, { chips: 100 });
    const second = event(2, first.eventHash, { chips: 120 });
    expect(verifyEventChain([first, second])).toMatchObject({ valid: true, verifiedEvents: 2 });
    const tampered = structuredClone(second);
    tampered.publicPayload = { chips: 121 };
    expect(verifyEventChain([first, tampered])).toMatchObject({
      valid: false,
      errorSequence: 2,
      reason: "event_hash_mismatch",
    });
    const mixed = structuredClone(second);
    mixed.tournamentId = "22222222-2222-4222-8222-222222222222";
    expect(verifyEventChain([first, mixed])).toMatchObject({
      valid: false,
      reason: "mixed_tournament_chain",
    });
  });
});
