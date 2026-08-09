import { describe, expect, it } from "vitest";
import type { LoadedArenaEvent } from "./events.js";
import { projectArenaEvent, type ProjectionRole } from "./visibility.js";

const secretMarker = "FOLDED-HOLE-CARDS-AsAh";
const loaded: LoadedArenaEvent = {
  event: {
    tournamentId: "11111111-1111-4111-8111-111111111111",
    sequence: 4,
    aggregateVersion: 4,
    type: "HOLE_CARDS_DEALT",
    actorId: null,
    handNo: 3,
    publicPayload: { playerId: "p1" },
    encryptedPrivatePayload: {
      algorithm: "aes-256-gcm",
      nonce: "nonce",
      ciphertext: "ciphertext",
      authTag: "tag",
    },
    privateVisibility: "PLAYER_HOLE_CARDS",
    privateOwnerId: "p1",
    prevHash: "0".repeat(64),
    eventHash: "1".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  privatePayload: { cards: secretMarker },
};

function projection(role: ProjectionRole, completed = false, playerId?: string) {
  return projectArenaEvent(loaded, {
    role,
    ...(playerId ? { playerId } : {}),
    completedHandNos: new Set(completed ? [3] : []),
  });
}

describe("role-separated event projections", () => {
  it("shows private cards only to the owning model during a hand", () => {
    expect(JSON.stringify(projection("MODEL_SELF", false, "p1"))).toContain(secretMarker);
    expect(JSON.stringify(projection("MODEL_SELF", false, "p2"))).not.toContain(secretMarker);
  });

  it("hides folded cards from spectators until hand completion", () => {
    expect(JSON.stringify(projection("SPECTATOR_LIVE"))).not.toContain(secretMarker);
    expect(JSON.stringify(projection("SPECTATOR_LIVE", true))).toContain(secretMarker);
    expect(JSON.stringify(projection("SPECTATOR_REPLAY", true))).toContain(secretMarker);
  });

  it("permits explicit administrator audit projection", () => {
    expect(JSON.stringify(projection("ADMIN_AUDIT"))).toContain(secretMarker);
  });
});
