import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

/**
 * The migration runner. Applies the plain SQL files in db/migrations in name
 * order, each in its own transaction, and records each in schema_migrations.
 *
 * It connects as the owner of the database, never as one of the White House
 * roles, and is run as a deliberate step from a developer machine or the
 * deploy pipeline:
 *
 *   DATABASE_URL=postgres://owner:...@host/db npm run migrate
 *
 * The runner container does not run it and does not carry the SQL files.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

export function defaultMigrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? path.resolve(here, "../../db/migrations");
}

export async function checksumOf(name: string, dir = defaultMigrationsDir()): Promise<string> {
  const sql = await readFile(path.join(dir, name), "utf8");
  return createHash("sha256").update(sql).digest("hex");
}

export interface MigrateOptions {
  connectionString: string;
  dir?: string;
}

/** Returns the names of the files applied by this call. */
export async function migrate(options: MigrateOptions): Promise<string[]> {
  const dir = options.dir ?? defaultMigrationsDir();
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    // One runner at a time.
    await client.query("select pg_advisory_lock(hashtextextended('white-house-migrations', 0))");
    await client.query(
      `create table if not exists schema_migrations (
         name       text primary key,
         checksum   text not null,
         applied_at timestamptz not null default now()
       )`,
    );
    const done = new Map<string, string>();
    for (const row of (await client.query("select name, checksum from schema_migrations")).rows) {
      done.set(row.name as string, row.checksum as string);
    }
    for (const name of files) {
      const sql = await readFile(path.join(dir, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const before = done.get(name);
      if (before !== undefined) {
        if (before !== checksum) {
          throw new Error(`migration ${name} has changed since it was applied. Write a new migration instead.`);
        }
        continue;
      }
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [name, checksum]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${name} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(name);
    }
  } finally {
    await client.end();
  }
  return applied;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  migrate({ connectionString })
    .then((applied) => {
      console.log(applied.length === 0 ? "Nothing to apply." : `Applied: ${applied.join(", ")}`);
    })
    .catch((err: unknown) => {
      console.error((err as Error).message);
      process.exit(1);
    });
}
