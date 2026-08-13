import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { ModelConfigService } from "../../apps/api/src/admin/model-service.js";
import { SystemPromptVersionService } from "../../apps/api/src/admin/system-prompt-service.js";
import { ArenaService } from "../../apps/api/src/tournament/arena-service.js";
import { PgEventStore } from "../../apps/api/src/persistence/event-store.js";
import { createDealSchedule } from "../../packages/fairness/src/deal-schedule.js";
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "./postgres-test-schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
let testSchema: IsolatedPostgresSchema | null = null;
let pool: Pool | null = null;

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for benchmark series state");
}

describePostgres("paired benchmark series", () => {
  beforeAll(async () => {
    testSchema = await createIsolatedPostgresSchema(databaseUrl!, "benchmark_series", 6);
    pool = testSchema.pool;
    await runMigrations(pool!);
  });

  afterAll(async () => {
    await testSchema?.dispose();
  });

  it("recovers one paused rotation, rotates seats, reuses deals and reveals only after the series", async () => {
    const key = Buffer.alloc(32, 61);
    const models = new ModelConfigService(pool!, key);
    const provider = await models.createProvider({
      label: "Benchmark mock",
      providerType: "mock-scripted",
      providerProfile: "auto",
      defaultOutputMode: "auto",
    });
    const alpha = await models.createModel({
      displayName: "Alpha",
      providerConnectionId: provider.id,
      modelId: "mock-policy-v1",
      parameters: {},
      outputMode: "inherit",
    });
    const beta = await models.createModel({
      displayName: "Beta",
      providerConnectionId: provider.id,
      modelId: "mock-policy-v1",
      parameters: {},
      outputMode: "inherit",
    });
    expect(alpha).not.toBeNull();
    expect(beta).not.toBeNull();

    const firstService = new ArenaService(pool!, key, models, 10);
    const promptVersion = (await new SystemPromptVersionService(pool!, key).list())
      .find((version) => version.isDefault)!;
    const created = await firstService.createBenchmarkSeries({
      name: "Paired acceptance",
      modelConfigIds: [alpha!.id, beta!.id],
      rotations: 2,
      initialStack: 100,
      handsPerLevel: 1,
      decisionTimeoutMs: 30_000,
      interfaceTrack: "normalized",
      historyMode: "disabled",
      systemPromptVersionId: promptVersion.id,
      blindLevels: [
        { smallBlind: 25, bigBlind: 50, bigBlindAnte: 0 },
        { smallBlind: 50, bigBlind: 100, bigBlindAnte: 100 },
      ],
    });
    await firstService.pause(created.tournamentId);
    await waitFor(
      () => firstService.publicState(created.tournamentId) as Promise<{ status: string }>,
      (state) => state.status === "PAUSED_INFRA",
    );
    await firstService.shutdown();

    const pausedCount = await pool!.query<{ count: string }>(
      "select count(*)::text as count from tournaments where benchmark_series_id = $1",
      [created.seriesId],
    );
    expect(Number(pausedCount.rows[0]?.count)).toBe(1);

    const restoredService = new ArenaService(pool!, key, models, 0);
    await restoredService.restoreActive();
    const restoredCount = await pool!.query<{ count: string }>(
      "select count(*)::text as count from tournaments where benchmark_series_id = $1",
      [created.seriesId],
    );
    expect(Number(restoredCount.rows[0]?.count)).toBe(1);
    await restoredService.resume(created.tournamentId);

    const series = await waitFor(
      async () => (await pool!.query<{
        status: string;
        deal_schedule_id: string;
        deal_schedule_commitment: string;
        revealed_deal_schedule_seed: string | null;
      }>("select * from benchmark_series where id = $1", [created.seriesId])).rows[0]!,
      (row) => row.status === "COMPLETED",
    );
    await restoredService.shutdown();
    expect(series.revealed_deal_schedule_seed).toBeTypeOf("string");
    const disclosed = createDealSchedule(Buffer.from(series.revealed_deal_schedule_seed!, "base64"));
    expect(disclosed.id).toBe(series.deal_schedule_id);
    expect(disclosed.commitment).toBe(series.deal_schedule_commitment);

    const tournamentRows = await pool!.query<{
      id: string;
      benchmark_rotation: number;
      public_state: {
        seedRevealed: boolean;
        masterSeedBase64?: string;
        players: { id: string; seat: number }[];
      };
      configuration: {
        benchmarkTrack: { interfaceTrack: string; historyMode: string };
        decisionConfig: { history: { maxQueries: number; maxApproxTokens: number } };
      };
      system_prompt_version_id: string | null;
      prompt_hash: string | null;
    }>(
      `select id, benchmark_rotation, public_state, configuration,
              system_prompt_version_id, prompt_hash from tournaments
        where benchmark_series_id = $1 order by benchmark_rotation`,
      [created.seriesId],
    );
    expect(tournamentRows.rows).toHaveLength(2);
    expect(tournamentRows.rows.map((row) => row.public_state.seedRevealed)).toEqual([false, false]);
    expect(tournamentRows.rows.every((row) => row.public_state.masterSeedBase64 === undefined)).toBe(true);
    expect(tournamentRows.rows[0]!.public_state.players.map((player) => player.id)).toEqual([alpha!.revisionId, beta!.revisionId]);
    expect(tournamentRows.rows[1]!.public_state.players.map((player) => player.id)).toEqual([beta!.revisionId, alpha!.revisionId]);
    const store = new PgEventStore(pool!, key);
    expect(tournamentRows.rows.map((row) => row.configuration.benchmarkTrack)).toEqual([
      expect.objectContaining({ interfaceTrack: "normalized", historyMode: "disabled" }),
      expect.objectContaining({ interfaceTrack: "normalized", historyMode: "disabled" }),
    ]);
    expect(tournamentRows.rows.map((row) => row.configuration.decisionConfig.history)).toEqual([
      expect.objectContaining({ maxQueries: 0, maxApproxTokens: 0 }),
      expect.objectContaining({ maxQueries: 0, maxApproxTokens: 0 }),
    ]);
    expect(tournamentRows.rows.map((row) => row.system_prompt_version_id)).toEqual([
      promptVersion.id,
      promptVersion.id,
    ]);
    expect(tournamentRows.rows.map((row) => row.prompt_hash)).toEqual([
      promptVersion.sha256,
      promptVersion.sha256,
    ]);

    const snapshots = await Promise.all(tournamentRows.rows.map((row) => store.loadLatestSnapshot(row.id)));
    for (const snapshot of snapshots) {
      const runtime = snapshot?.privateState as {
        frozenModelConfigByPlayer?: Record<string, { outputMode: string }>;
        decisionConfig?: { history: { maxQueries: number; maxApproxTokens: number } };
      } | undefined;
      expect(Object.values(runtime?.frozenModelConfigByPlayer ?? {}).map((config) => config.outputMode))
        .toEqual(["prompt", "prompt"]);
      expect(runtime?.decisionConfig?.history).toMatchObject({ maxQueries: 0, maxApproxTokens: 0 });
    }

    const handOneCards = await Promise.all(tournamentRows.rows.map(async (row) => (
      (await store.loadEvents(row.id, { includePrivate: true }))
        .filter((event) => event.event.handNo === 1 && ["HOLE_CARDS_DEALT", "BOARD_DEALT"].includes(event.event.type))
        .map((event) => ({
          type: event.event.type,
          publicPayload: event.event.type === "BOARD_DEALT" ? event.event.publicPayload : null,
          privatePayload: event.privatePayload && typeof event.privatePayload === "object"
            ? (event.privatePayload as { cards?: unknown }).cards ?? null
            : null,
        }))
    )));
    expect(handOneCards[1]).toEqual(handOneCards[0]);
    const reveals = await pool!.query<{ count: string }>(
      `select count(*)::text as count from arena_events
        where tournament_id = any($1::uuid[]) and event_type = 'RANDOMNESS_REVEALED'`,
      [tournamentRows.rows.map((row) => row.id)],
    );
    expect(Number(reveals.rows[0]?.count)).toBe(0);
  }, 30_000);

  it("cancels the whole series without launching another rotation", async () => {
    const key = Buffer.alloc(32, 61);
    const models = new ModelConfigService(pool!, key);
    const configured = await models.listModels();
    const service = new ArenaService(pool!, key, models, 10);
    const created = await service.createBenchmarkSeries({
      name: "Cancelled paired acceptance",
      modelConfigIds: configured.map((model) => model.id),
      rotations: 2,
      initialStack: 1_000,
      handsPerLevel: 100,
      decisionTimeoutMs: 30_000,
      blindLevels: [{ smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 }],
    });
    await service.cancel(created.tournamentId);
    const cancelled = await waitFor(
      async () => (await pool!.query<{ status: string; revealed_deal_schedule_seed: string | null }>(
        "select status, revealed_deal_schedule_seed from benchmark_series where id = $1",
        [created.seriesId],
      )).rows[0]!,
      (row) => row.status === "CANCELLED",
    );
    await service.shutdown();
    expect(cancelled.revealed_deal_schedule_seed).toBeTypeOf("string");
    const count = await pool!.query<{ count: string }>(
      "select count(*)::text as count from tournaments where benchmark_series_id = $1",
      [created.seriesId],
    );
    expect(Number(count.rows[0]?.count)).toBe(1);
  }, 30_000);

});
