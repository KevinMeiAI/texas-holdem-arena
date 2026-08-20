import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { runMigrations } from "../../../db/migrate.js";
import { ModelConfigService } from "./admin/model-service.js";
import { registerAdminModelRoutes } from "./admin/routes.js";
import { registerConsistencyRoutes } from "./admin/consistency-routes.js";
import { ConsistencyTestService } from "./admin/consistency-service.js";
import { registerSystemPromptRoutes } from "./admin/system-prompt-routes.js";
import { SystemPromptVersionService } from "./admin/system-prompt-service.js";
import { AuthService } from "./auth/auth-service.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { CompetitorIdentityService } from "./competitors/identity-service.js";
import { CompetitorProfileService } from "./competitors/profile-service.js";
import { registerCompetitorRoutes } from "./competitors/routes.js";
import type { AppConfig } from "./config.js";
import { PgEventStore } from "./persistence/event-store.js";
import { decodeMasterKey } from "./security/encryption.js";
import { ArenaService } from "./tournament/arena-service.js";
import { HistoryQueryService } from "./tournament/history-query-service.js";
import { PgHandForkRepository } from "./tournament/hand-forks/hand-fork-repository.js";
import { registerHandForkRoutes } from "./tournament/hand-forks/hand-fork-routes.js";
import { HandForkService } from "./tournament/hand-forks/hand-fork-service.js";
import { handForkSourceResolver } from "./tournament/hand-forks/hand-fork-source.js";
import { pgHandForkSourceCatalog } from "./tournament/hand-forks/hand-fork-source-catalog.js";
import { registerTournamentRoutes } from "./tournament/routes.js";
import {
  MomentService,
  PgMomentRepository,
  registerMomentRoutes,
  suspenseCoverSafety,
} from "./tournament/moments/index.js";

export interface BuiltApp {
  app: FastifyInstance;
  pool: Pool | null;
  masterKey: Buffer | null;
}

export async function registerWebAssets(app: FastifyInstance, webRoot: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: webRoot,
    setHeaders(response, filePath) {
      if (filePath.endsWith("index.html")) {
        response.header("Cache-Control", "no-store");
      } else if (/[\\/]assets[\\/]/.test(filePath)) {
        response.header("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  });
  app.setNotFoundHandler((request, reply) => {
    const requestUrl = request.raw.url ?? "";
    if (requestUrl.startsWith("/api/") || requestUrl.startsWith("/assets/")) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.sendFile("index.html");
  });
}

export async function buildApp(config: AppConfig): Promise<BuiltApp> {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "production" ? "info" : "debug",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.body.password",
          "req.body.apiKey",
          "*.apiKey",
          "*.api_key",
          "*.holeCards",
          "*.privatePayload",
        ],
        censor: "[REDACTED]",
      },
    },
  });
  await app.register(fastifyCookie);

  const pool = config.databaseUrl ? new Pool({ connectionString: config.databaseUrl, max: 8 }) : null;
  const masterKey = config.masterKeyBase64 ? decodeMasterKey(config.masterKeyBase64) : null;
  let arena: ArenaService | null = null;
  let consistency: ConsistencyTestService | null = null;
  let handForks: HandForkService | null = null;
  let moments: MomentService | null = null;
  let momentBacklog: Promise<void> | null = null;
  if (pool) {
    await runMigrations(pool);
    const auth = new AuthService(pool);
    await auth.bootstrap(config.adminEmail, config.adminPassword);
    if (masterKey) {
      const authContext = { auth, config };
      const models = new ModelConfigService(pool, masterKey);
      const systemPrompts = new SystemPromptVersionService(pool, masterKey);
      await systemPrompts.syncCatalog();
      consistency = new ConsistencyTestService(pool, models, masterKey);
      const arenaService = new ArenaService(pool, masterKey, models);
      arena = arenaService;
      const forkSourceResolver = handForkSourceResolver(new PgEventStore(pool, masterKey));
      const forkService = new HandForkService({
        repository: new PgHandForkRepository(pool, masterKey),
        sourceResolver: forkSourceResolver,
        models,
        history: new HistoryQueryService(pool),
        onWorkerError: (error) => app.log.error({ err: error }, "hand fork worker failed"),
      });
      handForks = forkService;
      const forkCatalog = pgHandForkSourceCatalog(pool, forkSourceResolver);
      const momentService = new MomentService(new PgMomentRepository(pool), async ({
        tournamentId,
        handNo,
        coverSequence,
      }) => {
        const replay = await arenaService.broadcastReplayState(tournamentId);
        if (!replay) throw new Error(`Cannot validate moment cover for missing tournament: ${tournamentId}`);
        return suspenseCoverSafety({
          handNo,
          sequence: coverSequence,
          frames: replay.timeline,
          events: replay.events,
        }).safe;
      });
      moments = momentService;
      arenaService.setTournamentCompletedHandler(async (tournamentId) => {
        const input = await arenaService.momentDetectionInput(tournamentId);
        if (input) await momentService.rebuildAutomatically(input);
      }, (tournamentId, error) => {
        app.log.error({ err: error, tournamentId }, "automatic moment detection failed");
      });
      const competitorProfiles = new CompetitorProfileService(
        pool,
        new CompetitorIdentityService(pool),
        arenaService,
        momentService,
      );
      await registerAuthRoutes(app, authContext);
      await registerAdminModelRoutes(app, {
        ...authContext,
        pool,
        models,
      });
      await registerConsistencyRoutes(app, { ...authContext, pool, consistency });
      await registerSystemPromptRoutes(app, { ...authContext, pool, systemPrompts });
      await registerTournamentRoutes(app, { ...authContext, pool, arena });
      await registerHandForkRoutes(app, {
        ...authContext,
        pool,
        catalog: forkCatalog,
        handForks: forkService,
      });
      await registerMomentRoutes(app, { ...authContext, arena, moments: momentService });
      await registerCompetitorRoutes(app, { competitorProfiles });
      await consistency.restorePending();
      await forkService.restorePending();
      await arena.restoreActive();
      // Recover the authoritative Arena worker first, then start the
      // rebuildable content-index scan in the background.
      momentBacklog = momentService.restoreMissingCompletedTournaments(
        (tournamentId) => arenaService.momentDetectionInput(tournamentId),
        (tournamentId, error) => {
          app.log.error({ err: error, tournamentId }, "moment detection backlog item failed");
        },
      ).then(() => undefined).catch((error) => {
        app.log.error({ err: error }, "moment detection backlog scan failed");
      });
    }
  }

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    if (!pool) {
      return reply.code(503).send({
        status: "not_ready",
        checks: { database: "DATABASE_URL is not configured" },
      });
    }
    if (!masterKey) {
      return reply.code(503).send({
        status: "not_ready",
        checks: { database: "ok", masterKey: "ARENA_MASTER_KEY is not configured" },
      });
    }
    try {
      await pool.query("select 1 as ready");
      const migration = await pool.query<{ count: string }>(
        "select count(*)::text as count from arena_schema_migrations",
      );
      const admins = await pool.query<{ count: string }>("select count(*)::text as count from admin_users");
      const adminReady = Number(admins.rows[0]?.count ?? 0) > 0;
      return reply.code(adminReady ? 200 : 503).send({
        status: adminReady ? "ready" : "not_ready",
        checks: {
          database: "ok",
          masterKey: "ok",
          admin: adminReady ? "ok" : "not_initialized",
          migrations: Number(migration.rows[0]?.count ?? 0),
        },
      });
    } catch (error) {
      app.log.error({ err: error }, "database readiness check failed");
      return reply.code(503).send({ status: "not_ready", checks: { database: "unavailable" } });
    }
  });

  app.get("/api/public/meta", async () => ({
    name: "Texas Hold'em Arena",
    version: "0.1.0",
    mode: "single-table-tournament",
    status: "admin-api",
  }));

  const webRoot = resolve(process.cwd(), "dist-web");
  if (existsSync(webRoot)) {
    await registerWebAssets(app, webRoot);
  }

  app.addHook("onClose", async () => {
    await consistency?.shutdown();
    await handForks?.shutdown();
    await arena?.shutdown();
    await momentBacklog;
    await moments?.waitForAutomaticRuns();
    await pool?.end();
  });
  return { app, pool, masterKey };
}
