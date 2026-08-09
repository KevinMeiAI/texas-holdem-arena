import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const MIGRATION_LOCK_ID = 824_620_241;

function migrationsDirectory(): string {
  const sourceDirectory = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "migrations",
  );
  return sourceDirectory.includes("dist-server")
    ? resolve(process.cwd(), "db/migrations")
    : sourceDirectory;
}

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(`
      create table if not exists arena_schema_migrations (
        filename text primary key,
        sha256 text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const directory = migrationsDirectory();
    const filenames = (await readdir(directory))
      .filter((filename) => /^\d+_.+\.sql$/.test(filename))
      .sort();

    for (const filename of filenames) {
      const sql = await readFile(resolve(directory, filename), "utf8");
      const sha256 = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ sha256: string }>(
        "select sha256 from arena_schema_migrations where filename = $1",
        [filename],
      );

      if (existing.rowCount === 1) {
        if (existing.rows[0]?.sha256 !== sha256) {
          throw new Error(`Applied migration ${filename} has changed`);
        }
        continue;
      }

      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          "insert into arena_schema_migrations (filename, sha256) values ($1, $2)",
          [filename, sha256],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    client.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl });
  await runMigrations(pool);
  await pool.end();
}
