import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { runMigrations } from "../../db/migrate.js";
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "./postgres-test-schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
let testSchema: IsolatedPostgresSchema | null = null;
let maintenancePool: Pool | null = null;

function cookiesFrom(header: string | string[] | undefined): string {
  const values = Array.isArray(header) ? header : header ? [header] : [];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

describePostgres("administrator auth and model configuration API", () => {
  beforeAll(async () => {
    testSchema = await createIsolatedPostgresSchema(databaseUrl!, "admin_api", 2);
    maintenancePool = testSchema.pool;
    await runMigrations(maintenancePool!);
  });

  afterAll(async () => {
    await testSchema?.dispose();
  });

  it("bootstraps one admin, enforces CSRF and never returns a provider key", async () => {
    let tournamentId: string | undefined;
    const { app } = await buildApp({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: testSchema!.databaseUrl,
      nodeEnv: "test",
      masterKeyBase64: Buffer.alloc(32, 51).toString("base64"),
      adminEmail: "admin@integration.test",
      adminPassword: "integration-password",
      cookieSecure: false,
    });
    try {
      expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
      expect((await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "admin@integration.test", password: "wrong" },
      })).statusCode).toBe(401);

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "admin@integration.test", password: "integration-password" },
      });
      expect(login.statusCode).toBe(200);
      const loginBody = login.json<{ csrfToken: string; session: { adminUserId: string } }>();
      const cookie = cookiesFrom(login.headers["set-cookie"]);
      expect(cookie).toContain("arena_session=");
      expect(cookie).toContain("arena_csrf=");

      expect((await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: { cookie },
        payload: { label: "Local mock", providerType: "mock-scripted", apiKey: "TOP-SECRET-KEY" },
      })).statusCode).toBe(403);

      const providerResponse = await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        headers: {
          cookie,
          "x-arena-csrf": loginBody.csrfToken,
        },
        payload: { label: "Local mock", providerType: "mock-scripted", apiKey: "TOP-SECRET-KEY" },
      });
      expect(providerResponse.statusCode).toBe(201);
      const provider = providerResponse.json<{ provider: { id: string; keyLastFour: string; providerProfile: string; defaultOutputMode: string } }>().provider;
      expect(provider.keyLastFour).toBe("-KEY");
      expect(provider).toMatchObject({ providerProfile: "auto", defaultOutputMode: "auto" });
      expect(providerResponse.body).not.toContain("TOP-SECRET-KEY");

      const providers = await app.inject({
        method: "GET",
        url: "/api/admin/providers",
        headers: { cookie },
      });
      expect(providers.statusCode).toBe(200);
      expect(providers.body).not.toContain("TOP-SECRET-KEY");

      const updatedProvider = await app.inject({
        method: "PATCH",
        url: `/api/admin/providers/${provider.id}`,
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
        payload: { label: "Local policies" },
      });
      expect(updatedProvider.json()).toMatchObject({ provider: { label: "Local policies", keyLastFour: "-KEY" } });
      expect(updatedProvider.body).not.toContain("TOP-SECRET-KEY");

      const modelResponse = await app.inject({
        method: "POST",
        url: "/api/admin/models",
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
        payload: {
          displayName: "Policy Alpha",
          providerConnectionId: provider.id,
          modelId: "mock-policy-v1",
          parameters: {},
        },
      });
      expect(modelResponse.statusCode).toBe(201);
      const modelId = modelResponse.json<{ model: { id: string } }>().model.id;
      const secondModelResponse = await app.inject({
        method: "POST",
        url: "/api/admin/models",
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
        payload: {
          displayName: "Policy Beta",
          providerConnectionId: provider.id,
          modelId: "mock-policy-v1",
          parameters: {},
        },
      });
      expect(secondModelResponse.statusCode).toBe(201);
      const secondModelId = secondModelResponse.json<{ model: { id: string } }>().model.id;
      const updatedModel = await app.inject({
        method: "PATCH",
        url: `/api/admin/models/${modelId}`,
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
        payload: { displayName: "Policy Alpha Prime", parameters: { style: "balanced" } },
      });
      expect(updatedModel.json()).toMatchObject({
        model: {
          displayName: "Policy Alpha Prime",
          parameters: { style: "balanced" },
          outputMode: "inherit",
          effectiveOutputMode: "prompt",
          outputModeSupported: true,
        },
      });
      const alphaRevisionId = updatedModel.json<{ model: { revisionId: string } }>().model.revisionId;
      const betaRevisionId = secondModelResponse.json<{ model: { revisionId: string } }>().model.revisionId;
      const preflight = await app.inject({
        method: "POST",
        url: `/api/admin/models/${modelId}/preflight`,
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
      });
      expect(preflight.statusCode).toBe(200);
      expect(preflight.json()).toMatchObject({
        result: {
          ok: true,
          effectiveMode: "prompt",
          schemaVersion: "arena-output-v3",
          checks: [
            { expectedOutput: "ACTION_OR_HISTORY", ok: true, schema: { applied: false } },
          ],
        },
      });

      const rejectedSharedPrompt = await app.inject({
        method: "POST",
        url: "/api/admin/tournaments",
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
        payload: {
          name: "Deprecated prompt field",
          modelConfigIds: [modelId, secondModelId],
          sharedStrategyPrompt: "This field must no longer be accepted.",
          initialStack: 100,
          handsPerLevel: 1,
          blindLevels: [{ smallBlind: 25, bigBlind: 50, bigBlindAnte: 0 }],
        },
      });
      expect(rejectedSharedPrompt.statusCode).toBe(400);
      expect(rejectedSharedPrompt.json()).toMatchObject({ error: "invalid_tournament" });

      const tournamentResponse = await app.inject({
        method: "POST",
        url: "/api/admin/tournaments",
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
        payload: {
          name: "API acceptance table",
          modelConfigIds: [modelId, secondModelId],
          initialStack: 100,
          handsPerLevel: 1,
          decisionTimeoutMs: 240_000,
          blindLevels: [
            { smallBlind: 25, bigBlind: 50, bigBlindAnte: 0 },
            { smallBlind: 50, bigBlind: 100, bigBlindAnte: 100 },
          ],
        },
      });
      expect(tournamentResponse.statusCode).toBe(201);
      tournamentId = tournamentResponse.json<{ tournamentId: string }>().tournamentId;

      let liveState: { state?: { status?: string; decisionTimeoutMs?: number } } = {};
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const live = await app.inject({ method: "GET", url: `/api/public/tournaments/${tournamentId}` });
        liveState = live.json();
        if (liveState.state?.status === "COMPLETED") break;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      expect(liveState.state?.status).toBe("COMPLETED");
      expect(liveState.state?.decisionTimeoutMs).toBe(240_000);

      const frozenTournament = await maintenancePool!.query<{
        configuration: {
          benchmarkTrack: { interfaceTrack: string; historyMode: string };
          decisionConfig: { history: { maxQueries: number; maxApproxTokens: number } };
        };
      }>("select configuration from tournaments where id = $1", [tournamentId]);
      expect(frozenTournament.rows[0]?.configuration.benchmarkTrack).toMatchObject({
        interfaceTrack: "native",
        historyMode: "query_only",
      });
      expect(frozenTournament.rows[0]?.configuration.decisionConfig.history).toMatchObject({
        maxQueries: 2,
        maxApproxTokens: 4_000,
      });

      const handsResponse = await app.inject({
        method: "GET",
        url: `/api/public/tournaments/${tournamentId}/hands`,
      });
      const hands = handsResponse.json<{ hands: { handNo: number; completed: boolean }[] }>().hands;
      expect(hands.length).toBeGreaterThan(0);
      expect(hands.every((hand) => hand.completed)).toBe(true);
      const stackHistoryResponse = await app.inject({
        method: "GET",
        url: `/api/public/tournaments/${tournamentId}/stack-history`,
      });
      expect(stackHistoryResponse.statusCode).toBe(200);
      const stackPoints = stackHistoryResponse.json<{
        points: { handNo: number; stacks: Record<string, number> }[];
      }>().points;
      expect(stackPoints).toHaveLength(hands.length);
      expect(stackPoints.map((point) => point.handNo)).toEqual(hands.map((hand) => hand.handNo));
      expect(stackPoints.at(-1)?.stacks).toMatchObject({
        [alphaRevisionId]: expect.any(Number),
        [betaRevisionId]: expect.any(Number),
      });
      expect(Object.values(stackPoints.at(-1)?.stacks ?? {}).reduce((sum, stack) => sum + stack, 0)).toBe(200);
      const replay = await app.inject({
        method: "GET",
        url: `/api/public/tournaments/${tournamentId}/hands/${hands[0]!.handNo}/replay`,
      });
      const replayEvents = replay.json<{ events: { type: string; privatePayload?: unknown }[] }>().events;
      expect(replayEvents.filter((event) => event.type === "HOLE_CARDS_DEALT"))
        .toEqual(expect.arrayContaining([expect.objectContaining({ privatePayload: expect.any(Object) })]));

      const leaderboard = await app.inject({ method: "GET", url: "/api/public/leaderboard" });
      const leaderboardEntries = leaderboard.json<{
        leaderboard: { modelId: string; tournaments: number }[];
      }>().leaderboard;
      expect(leaderboardEntries).toEqual(expect.arrayContaining([
        expect.objectContaining({ modelId: alphaRevisionId, tournaments: expect.any(Number) }),
        expect.objectContaining({ modelId: betaRevisionId, tournaments: expect.any(Number) }),
      ]));

      const stored = await maintenancePool!.query<{ encrypted_api_key: string }>(
        "select encrypted_api_key::text from provider_connections where id = $1",
        [provider.id],
      );
      expect(stored.rows[0]?.encrypted_api_key).not.toContain("TOP-SECRET-KEY");
    } finally {
      await app.close();
    }
  }, 30_000);
});
