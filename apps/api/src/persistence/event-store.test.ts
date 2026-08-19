import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../../../../packages/fairness/src/canonical-json.js";
import { encryptJson } from "../security/encryption.js";
import { PgEventStore } from "./event-store.js";

describe("decision leases", () => {
  it("renews a lease only while the same worker still owns the decision", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const store = new PgEventStore({ query } as unknown as Pool, new Uint8Array(32));

    await expect(store.renewDecisionLease("decision-1", "worker-a", 210_000)).resolves.toBe(true);
    await expect(store.renewDecisionLease("decision-1", "worker-b", 210_000)).resolves.toBe(false);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("lease_expires_at"),
      ["decision-1", "worker-a", 210_000],
    );
  });
});

describe("fork source audit reads", () => {
  const tournamentId = "11111111-1111-4111-8111-111111111111";
  const decisionId = "22222222-2222-4222-8222-222222222222";
  const masterKey = new Uint8Array(32);

  it("loads and verifies one exact aggregate snapshot", async () => {
    const privateState = { aggregateVersion: 7, pendingDecisionId: decisionId };
    const publicState = { status: "RUNNING" };
    const encryptedPrivateState = encryptJson(
      privateState,
      masterKey,
      `arena:snapshot:${tournamentId}:7:7`,
    );
    const checksum = createHash("sha256").update(canonicalJson({
      tournamentId,
      eventSequence: 7,
      aggregateVersion: 7,
      publicState,
      encryptedPrivateState,
    })).digest("hex");
    const query = vi.fn(async () => ({ rows: [{
      tournament_id: tournamentId,
      event_sequence: "7",
      aggregate_version: "7",
      public_state: publicState,
      encrypted_private_state: encryptedPrivateState,
      checksum,
    }] }));
    const store = new PgEventStore({ query } as unknown as Pool, masterKey);

    await expect(store.loadSnapshotAtAggregateVersion(tournamentId, 7)).resolves.toEqual({
      tournamentId,
      eventSequence: 7,
      aggregateVersion: 7,
      publicState,
      privateState,
      checksum,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("aggregate_version = $2"), [tournamentId, 7]);
  });

  it("rejects an exact snapshot whose checksum was changed", async () => {
    const encryptedPrivateState = encryptJson(
      { aggregateVersion: 7 },
      masterKey,
      `arena:snapshot:${tournamentId}:7:7`,
    );
    const query = vi.fn(async () => ({ rows: [{
      tournament_id: tournamentId,
      event_sequence: "7",
      aggregate_version: "7",
      public_state: {},
      encrypted_private_state: encryptedPrivateState,
      checksum: "0".repeat(64),
    }] }));
    const store = new PgEventStore({ query } as unknown as Pool, masterKey);

    await expect(store.loadSnapshotAtAggregateVersion(tournamentId, 7))
      .rejects.toThrow("Snapshot checksum verification failed");
  });

  it("loads the exact encrypted first-turn request with its decision boundary", async () => {
    const request = { requestId: decisionId, userPayload: { arena_state: { hand_no: 4 } } };
    const encryptedRequest = encryptJson(
      request,
      masterKey,
      `arena:decision-turn:${decisionId}:1:request`,
    );
    const requestHash = createHash("sha256").update(canonicalJson(request)).digest("hex");
    const query = vi.fn(async () => ({ rows: [{
      decision_id: decisionId,
      tournament_id: tournamentId,
      tournament_name: "Source tournament",
      tournament_status: "COMPLETED",
      hand_no: 4,
      player_id: "hero",
      expected_aggregate_version: "31",
      next_expected_aggregate_version: "38",
      request_kind: "ACTION",
      decision_status: "SUCCEEDED",
      turn_index: 1,
      request_hash: requestHash,
      encrypted_request: encryptedRequest,
    }] }));
    const store = new PgEventStore({ query } as unknown as Pool, masterKey);

    await expect(store.loadDecisionTurnRequest(decisionId, 1)).resolves.toEqual({
      decisionId,
      tournamentId,
      tournamentName: "Source tournament",
      tournamentStatus: "COMPLETED",
      handNo: 4,
      playerId: "hero",
      expectedAggregateVersion: 31,
      nextExpectedAggregateVersion: 38,
      requestKind: "ACTION",
      decisionStatus: "SUCCEEDED",
      turnIndex: 1,
      requestHash,
      request,
    });
  });

  it("rejects a decrypted first-turn request whose hash does not match", async () => {
    const request = { requestId: decisionId };
    const encryptedRequest = encryptJson(
      request,
      masterKey,
      `arena:decision-turn:${decisionId}:1:request`,
    );
    const query = vi.fn(async () => ({ rows: [{
      decision_id: decisionId,
      tournament_id: tournamentId,
      tournament_name: "Source tournament",
      tournament_status: "COMPLETED",
      hand_no: 4,
      player_id: "hero",
      expected_aggregate_version: "31",
      next_expected_aggregate_version: null,
      request_kind: "ACTION",
      decision_status: "SUCCEEDED",
      turn_index: 1,
      request_hash: "f".repeat(64),
      encrypted_request: encryptedRequest,
    }] }));
    const store = new PgEventStore({ query } as unknown as Pool, masterKey);

    await expect(store.loadDecisionTurnRequest(decisionId, 1))
      .rejects.toThrow("Decision request audit hash mismatch");
  });
});
