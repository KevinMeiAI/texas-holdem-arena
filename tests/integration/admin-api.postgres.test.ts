import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
      const promptVersionsResponse = await app.inject({
        method: "GET",
        url: "/api/admin/system-prompts",
        headers: { cookie },
      });
      expect(promptVersionsResponse.statusCode).toBe(200);
      const promptVersions = promptVersionsResponse.json<{
        versions: { id: string; name: string; sha256: string; isDefault: boolean }[];
      }>().versions;
      const defaultPrompt = promptVersions.find((version) => version.isDefault)!;
      expect(defaultPrompt).toMatchObject({ name: "Arena System v11", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      const customPromptResponse = await app.inject({
        method: "POST",
        url: "/api/admin/system-prompts",
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
        payload: {
          name: "Acceptance prompt",
          protocolBundleId: "arena-native-v11",
          systemPrompt: `${defaultPrompt.name}\nAlways obey the frozen Arena output contract.`,
        },
      });
      expect(customPromptResponse.statusCode).toBe(201);
      const customPrompt = customPromptResponse.json<{
        version: { id: string; name: string; sha256: string; status: "ACTIVE" | "ARCHIVED" };
      }>().version;

      await expect(maintenancePool!.query(
        "update system_prompt_versions set name = 'Mutated in place' where id = $1",
        [customPrompt.id],
      )).rejects.toThrow(/immutable/);
      await expect(maintenancePool!.query(
        "delete from system_prompt_versions where id = $1",
        [customPrompt.id],
      )).rejects.toThrow(/cannot be deleted/);
      await expect(maintenancePool!.query(
        "update system_prompt_versions set status = 'ARCHIVED' where id = $1",
        [defaultPrompt.id],
      )).rejects.toThrow(/only custom/);

      const rejectBundledArchive = await app.inject({
        method: "PATCH",
        url: `/api/admin/system-prompts/${defaultPrompt.id}/status`,
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
        payload: { archived: true },
      });
      expect(rejectBundledArchive.statusCode).toBe(409);

      const archiveCustom = await app.inject({
        method: "PATCH",
        url: `/api/admin/system-prompts/${customPrompt.id}/status`,
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
        payload: { archived: true },
      });
      expect(archiveCustom).toMatchObject({ statusCode: 200 });
      expect(archiveCustom.json()).toMatchObject({ version: { status: "ARCHIVED" } });

      const rejectedArchivedTournament = await app.inject({
        method: "POST",
        url: "/api/admin/tournaments",
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
        payload: {
          name: "Archived prompt must not start",
          modelConfigIds: [modelId, secondModelId],
          initialStack: 100,
          handsPerLevel: 1,
          systemPromptVersionId: customPrompt.id,
          blindLevels: [{ smallBlind: 25, bigBlind: 50, bigBlindAnte: 0 }],
        },
      });
      expect(rejectedArchivedTournament.statusCode).toBe(409);
      expect(rejectedArchivedTournament.json()).toMatchObject({
        error: "tournament_start_failed",
        message: expect.stringMatching(/Archived system prompt/),
      });

      const restoreCustom = await app.inject({
        method: "PATCH",
        url: `/api/admin/system-prompts/${customPrompt.id}/status`,
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
        payload: { archived: false },
      });
      expect(restoreCustom).toMatchObject({ statusCode: 200 });
      expect(restoreCustom.json()).toMatchObject({ version: { status: "ACTIVE" } });
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

      const rejectedDuplicateBatch = await app.inject({
        method: "POST",
        url: "/api/admin/consistency-batches",
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
        payload: {
          modelConfigIds: [modelId, modelId],
          tier: "quick",
          sampleCount: 2,
          systemPromptVersionId: defaultPrompt.id,
        },
      });
      expect(rejectedDuplicateBatch.statusCode).toBe(400);

      const batchResponse = await app.inject({
        method: "POST",
        url: "/api/admin/consistency-batches",
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
        payload: {
          modelConfigIds: [modelId, secondModelId],
          tier: "quick",
          sampleCount: 2,
          timeoutMs: 30_000,
          systemPromptVersionId: defaultPrompt.id,
        },
      });
      expect(batchResponse.statusCode).toBe(202);
      const createdBatch = batchResponse.json<{
        batch: { id: string; totalModels: number; totalSamples: number; maxParallelModels: number };
      }>().batch;
      expect(createdBatch).toMatchObject({ totalModels: 2, totalSamples: 16, maxParallelModels: 3 });

      let completedBatch: {
        status: string;
        scenarios?: { id: string }[];
        runs: {
          summary: {
            validityRate: number;
            meanPairwiseAgreement: number;
            scenarios: { uniqueInputHashes: string[] }[];
          } | null;
        }[];
      } | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const batch = await app.inject({
          method: "GET",
          url: `/api/admin/consistency-batches/${createdBatch.id}`,
          headers: { cookie },
        });
        expect(batch.statusCode).toBe(200);
        completedBatch = batch.json<{ batch: typeof completedBatch }>().batch;
        if (completedBatch?.status === "COMPLETED") break;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(completedBatch).toMatchObject({
        status: "COMPLETED",
        scenarios: expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]),
        runs: [
          { summary: { validityRate: 1, meanPairwiseAgreement: 1 } },
          { summary: { validityRate: 1, meanPairwiseAgreement: 1 } },
        ],
      });
      expect(completedBatch!.runs[0]!.summary!.scenarios[0]!.uniqueInputHashes).toEqual(
        completedBatch!.runs[1]!.summary!.scenarios[0]!.uniqueInputHashes,
      );
      const batchList = await app.inject({
        method: "GET",
        url: "/api/admin/consistency-batches",
        headers: { cookie },
      });
      expect(batchList.statusCode).toBe(200);
      expect(batchList.json()).toMatchObject({
        batches: [expect.objectContaining({ id: createdBatch.id, status: "COMPLETED" })],
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
          systemPromptVersionId: customPrompt.id,
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
      expect((liveState.state as { systemPromptVersionId?: string } | undefined)?.systemPromptVersionId).toBe(customPrompt.id);

      const frozenTournament = await maintenancePool!.query<{
        configuration: {
          benchmarkTrack: { interfaceTrack: string; historyMode: string; systemPromptHash: string };
          decisionConfig: { history: { maxQueries: number; maxApproxTokens: number } };
        };
        system_prompt_version_id: string | null;
        prompt_hash: string | null;
      }>("select configuration, system_prompt_version_id, prompt_hash from tournaments where id = $1", [tournamentId]);
      expect(frozenTournament.rows[0]?.configuration.benchmarkTrack).toMatchObject({
        interfaceTrack: "native",
        historyMode: "query_only",
      });
      expect(frozenTournament.rows[0]?.configuration.decisionConfig.history).toMatchObject({
        maxQueries: 2,
        maxApproxTokens: 4_000,
      });
      expect(frozenTournament.rows[0]?.system_prompt_version_id).toBe(customPrompt.id);
      expect(frozenTournament.rows[0]?.prompt_hash).toBe(customPrompt.sha256);
      expect(frozenTournament.rows[0]?.configuration.benchmarkTrack.systemPromptHash).toBe(customPrompt.sha256);

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

      const forkSourcesResponse = await app.inject({
        method: "GET",
        url: `/api/admin/tournaments/${tournamentId}/hands/${hands[0]!.handNo}/hand-fork-sources`,
        headers: { cookie },
      });
      expect(forkSourcesResponse.statusCode).toBe(200);
      const forkSource = forkSourcesResponse.json<{
        sources: Array<{
          availability: "AVAILABLE" | "UNAVAILABLE";
          decisionId: string;
          source?: { handNo: number; holeCards: string[] };
        }>;
      }>().sources.find((source) => source.availability === "AVAILABLE");
      expect(forkSource).toMatchObject({
        availability: "AVAILABLE",
        source: { handNo: hands[0]!.handNo, holeCards: expect.any(Array) },
      });

      const handForkBody = {
        clientRequestId: randomUUID(),
        sourceDecisionId: forkSource!.decisionId,
        modelConfigIds: [modelId, secondModelId],
        sampleCount: 2,
        timeoutMs: 30_000,
        maxParallelTargets: 2,
      };
      const handForkResponse = await app.inject({
        method: "POST",
        url: "/api/admin/hand-forks",
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
        payload: handForkBody,
      });
      expect(handForkResponse.statusCode).toBe(202);
      const handForkId = handForkResponse.json<{ handFork: { id: string } }>().handFork.id;
      const duplicateHandForkResponse = await app.inject({
        method: "POST",
        url: "/api/admin/hand-forks",
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
        payload: handForkBody,
      });
      expect(duplicateHandForkResponse.statusCode).toBe(202);
      expect(duplicateHandForkResponse.json()).toMatchObject({ handFork: { id: handForkId } });

      let completedHandFork: {
        status: string;
        summary: { requestedTrials: number; modelActionTrials: number } | null;
        targets: Array<{ status: string; terminalTrials: number; sampleCount: number }>;
      } | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const handFork = await app.inject({
          method: "GET",
          url: `/api/admin/hand-forks/${handForkId}`,
          headers: { cookie },
        });
        expect(handFork.statusCode).toBe(200);
        completedHandFork = handFork.json<{ handFork: typeof completedHandFork }>().handFork;
        if (completedHandFork?.status === "COMPLETED") break;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(completedHandFork).toMatchObject({
        status: "COMPLETED",
        summary: { requestedTrials: 4, modelActionTrials: 4 },
        targets: [
          { status: "COMPLETED", terminalTrials: 2, sampleCount: 2 },
          { status: "COMPLETED", terminalTrials: 2, sampleCount: 2 },
        ],
      });

      const leaderboard = await app.inject({ method: "GET", url: "/api/public/leaderboard" });
      const leaderboardEntries = leaderboard.json<{
        leaderboard: { modelId: string; tournaments: number }[];
      }>().leaderboard;
      expect(leaderboardEntries).toEqual(expect.arrayContaining([
        expect.objectContaining({ modelId: alphaRevisionId, tournaments: expect.any(Number) }),
        expect.objectContaining({ modelId: betaRevisionId, tournaments: expect.any(Number) }),
      ]));

      const deleteAlpha = await app.inject({
        method: "DELETE",
        url: `/api/admin/models/${modelId}`,
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
      });
      expect(deleteAlpha.statusCode).toBe(200);
      expect((await app.inject({
        method: "GET",
        url: `/api/admin/models/${modelId}`,
        headers: { cookie },
      })).statusCode).toBe(404);

      const providerStillInUse = await app.inject({
        method: "DELETE",
        url: `/api/admin/providers/${provider.id}`,
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
      });
      expect(providerStillInUse.statusCode).toBe(409);
      expect(providerStillInUse.json()).toMatchObject({ error: "provider_in_use" });

      const deleteBeta = await app.inject({
        method: "DELETE",
        url: `/api/admin/models/${secondModelId}`,
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
      });
      expect(deleteBeta.statusCode).toBe(200);
      const remainingModels = (await app.inject({
        method: "GET",
        url: "/api/admin/models",
        headers: { cookie },
      })).json<{ models: { id: string }[] }>().models;
      expect(remainingModels.map((model) => model.id)).not.toContain(modelId);
      expect(remainingModels.map((model) => model.id)).not.toContain(secondModelId);

      const deleteProvider = await app.inject({
        method: "DELETE",
        url: `/api/admin/providers/${provider.id}`,
        headers: { cookie, "x-arena-csrf": loginBody.csrfToken },
      });
      expect(deleteProvider.statusCode).toBe(200);
      expect((await app.inject({
        method: "GET",
        url: `/api/admin/providers/${provider.id}`,
        headers: { cookie },
      })).statusCode).toBe(404);

      const leaderboardAfterDelete = (await app.inject({
        method: "GET",
        url: "/api/public/leaderboard",
      })).json<{ leaderboard: { modelId: string }[] }>().leaderboard;
      expect(leaderboardAfterDelete).toEqual(expect.arrayContaining([
        expect.objectContaining({ modelId: alphaRevisionId }),
        expect.objectContaining({ modelId: betaRevisionId }),
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
