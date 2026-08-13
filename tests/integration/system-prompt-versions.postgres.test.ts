import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { SystemPromptVersionService } from "../../apps/api/src/admin/system-prompt-service.js";
import { PgEventStore } from "../../apps/api/src/persistence/event-store.js";
import { TournamentOrchestrator } from "../../apps/api/src/tournament/orchestrator.js";
import { runMigrations } from "../../db/migrate.js";
import { MockPolicyProvider } from "../../packages/providers/src/mock-scripted.js";
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "./postgres-test-schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
let testSchema: IsolatedPostgresSchema | null = null;
let pool: Pool | null = null;

describePostgres("immutable system prompt catalog", () => {
  beforeAll(async () => {
    testSchema = await createIsolatedPostgresSchema(databaseUrl!, "system_prompt_versions", 2);
    pool = testSchema.pool;
    await runMigrations(pool!);
  });

  afterAll(async () => {
    await testSchema?.dispose();
  });

  it("imports an unknown frozen prompt from an existing tournament snapshot", async () => {
    const masterKey = Buffer.alloc(32, 73);
    const tournamentId = randomUUID();
    const historicalText = "You are a frozen historical poker policy. Return one legal action.";
    const historicalPrompt = {
      version: "arena-system-historical/acceptance",
      text: historicalText,
      sha256: createHash("sha256").update(historicalText, "utf8").digest("hex"),
    };
    const providers = new Map([
      ["policy-a", new MockPolicyProvider()],
      ["policy-b", new MockPolicyProvider()],
    ]);
    const orchestrator = new TournamentOrchestrator({
      eventStore: new PgEventStore(pool!, masterKey),
      pool: pool!,
      providers,
    });

    const runtime = await orchestrator.createAndStart({
      tournamentId,
      name: "Pre-catalog frozen prompt",
      rulesetVersion: "arena-rules-v2",
      protocolBundleId: "arena-native-v11",
      effectiveSystemPrompt: historicalPrompt,
      tournament: {
        seatCount: 2,
        players: [{ id: "alpha", seat: 0 }, { id: "beta", seat: 1 }],
        initialStack: 100,
        initialButton: 0,
        handsPerLevel: 10,
        blindLevels: [{ smallBlind: 5, bigBlind: 10, bigBlindAnte: 0 }],
      },
      providerIdByPlayer: { alpha: "policy-a", beta: "policy-b" },
      masterSeed: new Uint8Array(32).fill(17),
    });
    expect(runtime.systemPromptVersionId).toBeUndefined();

    const catalog = new SystemPromptVersionService(pool!, masterKey);
    await catalog.syncCatalog();
    const imported = (await catalog.list()).find((version) => version.sha256 === historicalPrompt.sha256);
    expect(imported).toMatchObject({
      source: "HISTORICAL",
      status: "ARCHIVED",
      runtimeVersion: historicalPrompt.version,
      protocolBundleId: "arena-native-v11",
      systemPrompt: historicalText,
      tournamentCount: 1,
    });
    const linked = await pool!.query<{ system_prompt_version_id: string | null }>(
      "select system_prompt_version_id from tournaments where id = $1",
      [tournamentId],
    );
    expect(linked.rows[0]?.system_prompt_version_id).toBe(imported?.id);

    await catalog.syncCatalog();
    expect((await catalog.list()).filter((version) => version.sha256 === historicalPrompt.sha256)).toHaveLength(1);
  });
});
