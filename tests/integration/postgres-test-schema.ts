import { randomUUID } from "node:crypto";
import { Pool } from "pg";

export interface IsolatedPostgresSchema {
  databaseUrl: string;
  pool: Pool;
  dispose: () => Promise<void>;
}

export async function createIsolatedPostgresSchema(
  baseDatabaseUrl: string,
  label: string,
  maxConnections = 2,
): Promise<IsolatedPostgresSchema> {
  const safeLabel = label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "");
  const schema = `arena_test_${safeLabel}_${randomUUID().replaceAll("-", "")}`;
  const maintenancePool = new Pool({ connectionString: baseDatabaseUrl, max: 1 });
  await maintenancePool.query(`create schema "${schema}"`);

  const url = new URL(baseDatabaseUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const databaseUrl = url.toString();
  const pool = new Pool({ connectionString: databaseUrl, max: maxConnections });

  return {
    databaseUrl,
    pool,
    dispose: async () => {
      await pool.end();
      await maintenancePool.query(`drop schema if exists "${schema}" cascade`);
      await maintenancePool.end();
    },
  };
}
