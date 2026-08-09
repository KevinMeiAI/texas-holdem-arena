import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import {
  EventStoreConcurrencyError,
  PgEventStore,
} from "../../apps/api/src/persistence/event-store.js";
import { recoverAggregate } from "../../apps/api/src/persistence/recovery.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 2 }) : null;

describePostgres("PostgreSQL authoritative event store", () => {
  beforeAll(async () => {
    await runMigrations(pool!);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("appends with CAS, decrypts private events, restores snapshots and detects tampering", async () => {
    const tournamentId = randomUUID();
    const store = new PgEventStore(pool!, Buffer.alloc(32, 23));
    await store.createTournament({
      id: tournamentId,
      name: "Integration table",
      rulesetVersion: "arena-rules-v1",
      configuration: { seats: 2 },
      promptHash: "a".repeat(64),
    });

    try {
      const appended = await store.append({
        tournamentId,
        expectedVersion: 0,
        nextStatus: "RUNNING",
        events: [
          {
            type: "HAND_STARTED",
            actorId: null,
            handNo: 1,
            publicPayload: { button: 0 },
            privateVisibility: "NONE",
            privateOwnerId: null,
          },
          {
            type: "HOLE_CARDS_DEALT",
            actorId: null,
            handNo: 1,
            publicPayload: { playerId: "p1" },
            privatePayload: { cards: ["As", "Ah"] },
            privateVisibility: "PLAYER_HOLE_CARDS",
            privateOwnerId: "p1",
          },
        ],
        snapshot: {
          publicState: { handNo: 1, phase: "PREFLOP" },
          privateState: { deck: ["hidden"], holeCards: { p1: ["As", "Ah"] } },
        },
        decisionRequest: {
          id: randomUUID(),
          handNo: 1,
          playerId: "p1",
          requestKind: "ACTION",
          promptHash: "b".repeat(64),
          idempotencyKey: "hand:1:decision:1",
        },
      });
      expect(appended).toMatchObject({ aggregateVersion: 2, nextSequence: 3 });
      expect(appended.finalHash).toMatch(/^[a-f0-9]{64}$/);
      const claimed = await store.claimNextDecision(tournamentId, "worker-a", 10_000);
      expect(claimed).toMatchObject({
        handNo: 1,
        playerId: "p1",
        expectedAggregateVersion: 2,
        attemptCount: 1,
      });
      expect(await store.claimNextDecision(tournamentId, "worker-b", 10_000)).toBeNull();
      await store.completeDecision(claimed!.id, "worker-a", { action: "check" });

      await expect(store.append({
        tournamentId,
        expectedVersion: 0,
        events: [{
          type: "STALE",
          actorId: null,
          handNo: null,
          publicPayload: {},
          privateVisibility: "NONE",
          privateOwnerId: null,
        }],
      })).rejects.toBeInstanceOf(EventStoreConcurrencyError);

      const loaded = await store.loadEvents(tournamentId, { includePrivate: true });
      expect(loaded).toHaveLength(2);
      expect(loaded[1]?.privatePayload).toEqual({ cards: ["As", "Ah"] });
      expect(await store.verifyTournamentChain(tournamentId)).toMatchObject({
        valid: true,
        verifiedEvents: 2,
      });

      const snapshot = await store.loadLatestSnapshot(tournamentId);
      expect(snapshot).toMatchObject({
        eventSequence: 2,
        aggregateVersion: 2,
        publicState: { handNo: 1, phase: "PREFLOP" },
        privateState: { deck: ["hidden"], holeCards: { p1: ["As", "Ah"] } },
      });

      const restartedStore = new PgEventStore(pool!, Buffer.alloc(32, 23));
      const recovered = await recoverAggregate(
        restartedStore,
        tournamentId,
        () => ({ impossible: true }),
        (state) => state,
      );
      expect(recovered).toMatchObject({
        aggregateVersion: 2,
        eventSequence: 2,
        replayedEvents: 0,
        state: { deck: ["hidden"], holeCards: { p1: ["As", "Ah"] } },
      });

      await pool!.query(
        `update arena_events set public_payload = '{"button":1}'::jsonb
          where tournament_id = $1 and sequence = 1`,
        [tournamentId],
      );
      expect(await store.verifyTournamentChain(tournamentId)).toMatchObject({
        valid: false,
        errorSequence: 1,
        reason: "event_hash_mismatch",
      });
    } finally {
      await pool!.query("delete from tournaments where id = $1", [tournamentId]);
    }
  });
});
