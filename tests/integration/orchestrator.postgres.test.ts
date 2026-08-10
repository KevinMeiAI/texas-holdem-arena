import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { ARENA_DECISION_TIMEOUT_MS } from "../../apps/api/src/model-runtime.js";
import { PgEventStore } from "../../apps/api/src/persistence/event-store.js";
import { TournamentOrchestrator } from "../../apps/api/src/tournament/orchestrator.js";
import { MockPolicyProvider } from "../../packages/providers/src/mock-scripted.js";
import { ProviderCallError, type ModelProvider, type ProviderDecision } from "../../packages/providers/src/provider.js";
import type { FrozenModelConfig } from "../../packages/providers/src/provider.js";
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "./postgres-test-schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
let testSchema: IsolatedPostgresSchema | null = null;
let pool: Pool | null = null;

function frozenMock(model: string): FrozenModelConfig {
  return {
    provider: "mock-scripted",
    providerProfile: "auto",
    providerDefaultOutputMode: "auto",
    outputMode: "inherit",
    model,
    timeoutMs: ARENA_DECISION_TIMEOUT_MS,
    parameters: {},
  };
}

describePostgres("persisted model tournament orchestration", () => {
  beforeAll(async () => {
    testSchema = await createIsolatedPostgresSchema(databaseUrl!, "orchestrator", 3);
    pool = testSchema.pool;
    await runMigrations(pool!);
  });

  afterAll(async () => {
    await testSchema?.dispose();
  });

  it("runs two model seats through the decision outbox to one recoverable champion", async () => {
    const tournamentId = randomUUID();
    const key = Buffer.alloc(32, 41);
    const store = new PgEventStore(pool!, key);
    const providers = new Map([
      ["policy-a", new MockPolicyProvider()],
      ["policy-b", new MockPolicyProvider()],
    ]);
    const orchestrator = new TournamentOrchestrator({ eventStore: store, pool: pool!, providers });

    try {
      let runtime = await orchestrator.createAndStart({
        tournamentId,
        name: "Two policy acceptance",
        rulesetVersion: "arena-rules-v1",
        tournament: {
          seatCount: 2,
          players: [{ id: "alpha", seat: 0 }, { id: "beta", seat: 1 }],
          initialStack: 40,
          initialButton: 0,
          handsPerLevel: 1,
          blindLevels: [
            { smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 },
            { smallBlind: 10, bigBlind: 20, bigBlindAnte: 20 },
          ],
        },
        providerIdByPlayer: { alpha: "policy-a", beta: "policy-b" },
        frozenModelConfigByPlayer: { alpha: frozenMock("policy-a"), beta: frozenMock("policy-b") },
        masterSeed: new Uint8Array(32).fill(5),
      });

      for (let index = 0; index < 3; index += 1) {
        runtime = await orchestrator.runNextDecision(runtime, "integration-worker");
      }
      const midVersion = runtime.aggregateVersion;
      const midDecision = runtime.pendingDecisionId;
      const recoveredMidGame = await new TournamentOrchestrator({
        eventStore: new PgEventStore(pool!, key),
        pool: pool!,
        providers,
      }).recover(tournamentId);
      expect(recoveredMidGame).toMatchObject({
        aggregateVersion: midVersion,
        pendingDecisionId: midDecision,
        operationalStatus: "RUNNING",
        frozenModelConfigByPlayer: {
          alpha: { model: "policy-a" },
          beta: { model: "policy-b" },
        },
      });
      runtime = recoveredMidGame;

      let decisions = 3;
      while (runtime.operationalStatus !== "COMPLETED") {
        runtime = await orchestrator.runNextDecision(runtime, "integration-worker");
        decisions += 1;
        if (decisions > 500) throw new Error("Persisted tournament did not terminate");
      }

      expect(runtime.domain.championPlayerId).toMatch(/alpha|beta/);
      expect(runtime.domain.players.reduce((sum, player) => sum + player.stack, 0)).toBe(80);
      expect(runtime.pendingDecisionId).toBeNull();
      expect(runtime.seedRevealed).toBe(true);
      const chain = await store.verifyTournamentChain(tournamentId);
      expect(chain.reason).toBeUndefined();
      expect(chain.valid).toBe(true);

      const holeRows = await pool!.query<{
        public_payload: unknown;
        encrypted_private_payload: unknown;
      }>(
        `select public_payload, encrypted_private_payload from arena_events
          where tournament_id = $1 and event_type = 'HOLE_CARDS_DEALT'`,
        [tournamentId],
      );
      expect(holeRows.rows.length).toBeGreaterThan(0);
      for (const row of holeRows.rows) {
        expect(Object.keys(row.public_payload as object)).toEqual(["playerId"]);
        expect(row.encrypted_private_payload).toBeTruthy();
      }

      const unfinished = await pool!.query<{ count: string }>(
        `select count(*)::text as count from decision_requests
          where tournament_id = $1 and status <> 'SUCCEEDED'`,
        [tournamentId],
      );
      expect(Number(unfinished.rows[0]?.count)).toBe(0);
      const decisionAudit = await store.loadDecisionAudit(tournamentId, 1);
      expect(decisionAudit.length).toBeGreaterThan(0);
      expect(decisionAudit[0]).toMatchObject({
        request: expect.objectContaining({
          systemPromptHash: runtime.effectivePrompt.sha256,
          outputSchema: expect.objectContaining({ sha256: runtime.effectiveOutputSchema?.sha256 }),
        }),
        response: expect.objectContaining({ rawText: expect.any(String), parsed: expect.any(Object) }),
        provider_config_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        output_schema_hash: runtime.effectiveOutputSchema?.sha256,
      });

      const restarted = new TournamentOrchestrator({
        eventStore: new PgEventStore(pool!, key),
        pool: pool!,
        providers,
      });
      const recovered = await restarted.recover(tournamentId);
      expect(recovered).toMatchObject({
        operationalStatus: "COMPLETED",
        aggregateVersion: runtime.aggregateVersion,
        seedRevealed: true,
      });
      expect(recovered.domain.championPlayerId).toBe(runtime.domain.championPlayerId);
    } finally {
      await pool!.query("delete from tournaments where id = $1", [tournamentId]);
    }
  }, 60_000);

  it("pauses on infrastructure failure and resumes the same decision without a poker penalty", async () => {
    const tournamentId = randomUUID();
    const store = new PgEventStore(pool!, Buffer.alloc(32, 42));
    let healthy = false;
    const observedTimeouts: number[] = [];
    const flaky: ModelProvider = {
      kind: "mock-scripted",
      classifyError: (error) => error as ProviderCallError,
      decide: async (request): Promise<ProviderDecision> => {
        observedTimeouts.push(request.timeoutMs);
        if (!healthy) throw new ProviderCallError("SERVER", "provider down", true, 503);
        return {
          parsed: { type: "action", action: "call" },
          rawText: '{"type":"action","action":"call"}',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          latencyMs: 1,
          providerRequestId: null,
        };
      },
    };
    const providers = new Map<string, ModelProvider>([
      ["flaky", flaky],
      ["policy", new MockPolicyProvider()],
    ]);
    const orchestrator = new TournamentOrchestrator({ eventStore: store, pool: pool!, providers });
    try {
      let runtime = await orchestrator.createAndStart({
        tournamentId,
        name: "Infrastructure pause",
        rulesetVersion: "arena-rules-v1",
        tournament: {
          seatCount: 2,
          players: [{ id: "alpha", seat: 0 }, { id: "beta", seat: 1 }],
          initialStack: 100,
          initialButton: 0,
          handsPerLevel: 10,
          blindLevels: [{ smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 }],
        },
        providerIdByPlayer: { alpha: "flaky", beta: "policy" },
        masterSeed: new Uint8Array(32).fill(6),
      });
      const originalDecision = runtime.pendingDecisionId;
      const originalStacks = runtime.domain.currentHand?.players.map((player) => player.stack);
      runtime = await orchestrator.runNextDecision(runtime, "pause-worker");
      expect(runtime).toMatchObject({
        operationalStatus: "PAUSED_INFRA",
        pendingDecisionId: originalDecision,
      });
      expect(runtime.domain.currentHand?.players.map((player) => player.stack)).toEqual(originalStacks);

      healthy = true;
      runtime = await orchestrator.resume(runtime);
      expect(runtime.pendingDecisionId).toBe(originalDecision);
      runtime = await orchestrator.runNextDecision(runtime, "resume-worker");
      expect(runtime.operationalStatus).toBe("RUNNING");
      expect(runtime.pendingDecisionId).not.toBe(originalDecision);
      expect(runtime.domain.currentHand?.players.find((player) => player.id === "alpha")?.folded).toBe(false);
      expect(new Set(observedTimeouts)).toEqual(new Set([ARENA_DECISION_TIMEOUT_MS]));
    } finally {
      await pool!.query("delete from tournaments where id = $1", [tournamentId]);
    }
  }, 30_000);
});
