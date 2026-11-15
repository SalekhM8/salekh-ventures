import pg from "pg";
import { ControlError } from "./errors.js";

/** A connection inside a transaction that has its tenant set. */
export type Tx = pg.PoolClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * A pool of connections for ONE database role (agent tools, gateway or UI).
 *
 * All work goes through `tx`, which opens a transaction and sets the tenant
 * for that transaction only. Row level security then limits every statement
 * to that tenant's rows. A query run outside `tx` has no tenant and sees
 * nothing.
 */
export class Db {
  readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async tx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!isUuid(tenantId)) {
      throw new ControlError("invalid_request", "tenant id is not a uuid");
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (err) {
      try {
        await client.query("rollback");
      } catch {
        // The connection is already broken. The original error is the useful one.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  end(): Promise<void> {
    return this.pool.end();
  }
}

export function createDb(connectionString: string, max = 10): Db {
  return new Db(new pg.Pool({ connectionString, max }));
}

/** Postgres error code for a unique constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

/** Serialise work on one named thing for the rest of the transaction. */
export async function lock(tx: Tx, ...parts: (string | null)[]): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [parts.map((p) => p ?? "-").join("|")]);
}
