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
import type { AppConfig } from "./config.js";
import { decodeMasterKey } from "./security/encryption.js";
import { ArenaService } from "./tournament/arena-service.js";
import { registerTournamentRoutes } from "./tournament/routes.js";

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
      arena = new ArenaService(pool, masterKey, models);
      await registerAuthRoutes(app, authContext);
      await registerAdminModelRoutes(app, {
        ...authContext,
        pool,
        models,
      });
      await registerConsistencyRoutes(app, { ...authContext, pool, consistency });
      await registerSystemPromptRoutes(app, { ...authContext, pool, systemPrompts });
      await registerTournamentRoutes(app, { ...authContext, pool, arena });
      await consistency.restorePending();
      await arena.restoreActive();
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
    consistency?.shutdown();
    await arena?.shutdown();
    await pool?.end();
  });
  return { app, pool, masterKey };
}
