import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import {
  EventStoreConcurrencyError,
  PgEventStore,
} from "../../apps/api/src/persistence/event-store.js";
import { recoverAggregate } from "../../apps/api/src/persistence/recovery.js";
import { HistoryQueryService } from "../../apps/api/src/tournament/history-query-service.js";
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "./postgres-test-schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
let testSchema: IsolatedPostgresSchema | null = null;
let pool: Pool | null = null;

describePostgres("PostgreSQL authoritative event store", () => {
  beforeAll(async () => {
    testSchema = await createIsolatedPostgresSchema(databaseUrl!, "event_store", 2);
    pool = testSchema.pool;
    await runMigrations(pool!);
  });

  afterAll(async () => {
    await testSchema?.dispose();
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
      const resumeState = {
        historyResults: [],
        protocolFailures: 0,
        correction: null,
        calls: [{ attempt: 1, outcome: "SUCCESS", errorKind: null, latencyMs: 12, usage: null }],
      };
      await store.saveDecisionResumeState(claimed!.id, resumeState);
      expect(await store.loadDecisionResumeState(claimed!.id)).toEqual(resumeState);
      await store.appendDecisionTurn({
        decisionId: claimed!.id,
        turnIndex: 1,
        request: { systemPromptHash: "b".repeat(64), userPayload: { hole_cards: ["As", "Ah"] } },
        response: { rawText: '{"type":"action","action":"check"}', parsed: { type: "action", action: "check" } },
        outcome: "SUCCESS",
        errorKind: null,
        providerConfigHash: "c".repeat(64),
        outputSchemaVersion: "arena-output-v2",
        outputSchemaHash: "d".repeat(64),
        latencyMs: 12,
        usage: { totalTokens: 20 },
      });
      expect(await store.loadDecisionAudit(tournamentId, 1)).toEqual([
        expect.objectContaining({
          decision_id: claimed!.id,
          player_id: "p1",
          turn_index: 1,
          request: expect.objectContaining({ userPayload: { hole_cards: ["As", "Ah"] } }),
          response: expect.objectContaining({ parsed: { type: "action", action: "check" } }),
          provider_config_hash: "c".repeat(64),
          output_schema_hash: "d".repeat(64),
        }),
      ]);
      await store.append({
        tournamentId,
        expectedVersion: 2,
        events: [{
          type: "ACTION_APPLIED",
          actorId: "p1",
          handNo: 1,
          publicPayload: {
            street: "PREFLOP",
            command: { action: "check" },
            paid: 0,
            amountTo: 10,
          },
          privateVisibility: "NONE",
          privateOwnerId: null,
        }],
        completeDecision: {
          id: claimed!.id,
          workerId: "worker-a",
          finalResponse: { action: "check" },
        },
      });

      const history = new HistoryQueryService(pool!);
      expect(await history.execute(tournamentId, 2, {
        kind: "player_actions",
        player_id: "p1",
        streets: ["PREFLOP"],
        actions: ["check"],
        limit: 10,
      })).toEqual([
        expect.objectContaining({
          kind: "contextual_player_action",
          player_id: "p1",
          hand_no: 1,
          action: "check",
          classification: "check",
          board_before_action: [],
          pot_before_action: 0,
        }),
      ]);
      await expect(history.execute(tournamentId, 1, {
        kind: "hand",
        hand_no: 1,
        limit: 10,
      })).rejects.toThrow(/current or a future hand/);

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
      expect(loaded).toHaveLength(3);
      expect(loaded[1]?.privatePayload).toEqual({ cards: ["As", "Ah"] });
      expect(await store.verifyTournamentChain(tournamentId)).toMatchObject({
        valid: true,
        verifiedEvents: 3,
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
        (state, event) => ({
          ...(state as Record<string, unknown>),
          replayedType: event.event.type,
        }),
      );
      expect(recovered).toMatchObject({
        aggregateVersion: 3,
        eventSequence: 3,
        replayedEvents: 1,
        state: {
          deck: ["hidden"],
          holeCards: { p1: ["As", "Ah"] },
          replayedType: "ACTION_APPLIED",
        },
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
