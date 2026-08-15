import { describe, expect, it } from "vitest";
import type { LoadedArenaEvent } from "./events.js";
import { projectArenaEvent, projectArenaEvents, type ProjectionRole } from "./visibility.js";

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

  it("exposes live hole cards only through the explicit broadcast projection", () => {
    expect(JSON.stringify(projection("SPECTATOR_LIVE"))).not.toContain(secretMarker);
    expect(JSON.stringify(projection("SPECTATOR_BROADCAST"))).toContain(secretMarker);
  });

  it("keeps administrator-only burn cards out of the broadcast projection", () => {
    const burnMarker = "BURN-CARD-7s";
    const street: LoadedArenaEvent = {
      event: {
        ...loaded.event,
        type: "STREET_DEALT",
        publicPayload: { street: "FLOP", cards: ["2c", "3d", "4h"] },
        privateVisibility: "ADMIN_AUDIT",
        privateOwnerId: null,
      },
      privatePayload: { burn: burnMarker },
    };
    const request = { completedHandNos: new Set<number>() };
    expect(JSON.stringify(projectArenaEvent(street, { role: "SPECTATOR_BROADCAST", ...request }))).not.toContain(burnMarker);
    expect(JSON.stringify(projectArenaEvent(street, { role: "ADMIN_AUDIT", ...request }))).toContain(burnMarker);
  });

  it("permits explicit administrator audit projection", () => {
    expect(JSON.stringify(projection("ADMIN_AUDIT"))).toContain(secretMarker);
  });

  it("keeps decision summaries out of live model inputs without hiding them from spectators", () => {
    const decision: LoadedArenaEvent = {
      event: {
        ...loaded.event,
        sequence: 5,
        aggregateVersion: 5,
        type: "MODEL_DECISION_RECORDED",
        actorId: "p2",
        publicPayload: {
          playerId: "p2",
          decisionSummary: "I am betting a hidden draw.",
          providerMetrics: [{ latencyMs: 999, usage: { totalTokens: 123 } }],
        },
        encryptedPrivatePayload: null,
        privateVisibility: "NONE",
        privateOwnerId: null,
        eventHash: "2".repeat(64),
      },
      privatePayload: undefined,
    };
    const modelEvents = projectArenaEvents([loaded, decision], {
      role: "MODEL_SELF",
      playerId: "p1",
      completedHandNos: new Set(),
    });
    expect(modelEvents.map((event) => event.type)).not.toContain("MODEL_DECISION_RECORDED");
    const spectatorEvents = projectArenaEvents([loaded, decision], {
      role: "SPECTATOR_LIVE",
      completedHandNos: new Set(),
    });
    expect(JSON.stringify(spectatorEvents)).toContain("I am betting a hidden draw.");
  });
});
