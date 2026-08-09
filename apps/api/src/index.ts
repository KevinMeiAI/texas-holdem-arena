import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { runMigrations } from "../../../db/migrate.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = Fastify({
  logger: {
    level: config.nodeEnv === "production" ? "info" : "debug",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.apiKey",
        "*.api_key",
        "*.holeCards",
        "*.privatePayload",
      ],
      censor: "[REDACTED]",
    },
  },
});

const pool = config.databaseUrl
  ? new Pool({ connectionString: config.databaseUrl, max: 5 })
  : undefined;

if (pool) {
  await runMigrations(pool);
}

app.get("/health", async () => ({ status: "ok" }));

app.get("/ready", async (_request, reply) => {
  if (!pool) {
    return reply.code(503).send({
      status: "not_ready",
      checks: { database: "DATABASE_URL is not configured" },
    });
  }

  try {
    await pool.query("select 1 as ready");
    const migration = await pool.query<{ count: string }>(
      "select count(*)::text as count from arena_schema_migrations",
    );
    return {
      status: "ready",
      checks: { database: "ok", migrations: Number(migration.rows[0]?.count ?? 0) },
    };
  } catch (error) {
    app.log.error({ err: error }, "database readiness check failed");
    return reply.code(503).send({
      status: "not_ready",
      checks: { database: "unavailable" },
    });
  }
});

app.get("/api/public/meta", async () => ({
  name: "Texas Hold'em Arena",
  version: "0.1.0",
  mode: "single-table-tournament",
  status: "foundation",
}));

const webRoot = resolve(process.cwd(), "dist-web");
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, {
    root: webRoot,
    wildcard: false,
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/api/")) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.sendFile("index.html");
  });
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await pool?.end();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, "server failed to start");
  process.exit(1);
}
