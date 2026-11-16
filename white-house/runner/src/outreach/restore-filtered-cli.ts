import { createDb } from "../control/db.js";
import { RESTORABLE_REASONS, restoreFiltered } from "./store.js";

/**
 * Put back to "analysed" the businesses that were dropped, before ever being tested, for a reason that no
 * longer stops a test: nobody named, or a limited company not confirmed. They are sorted again on the next run.
 *
 *   npm run restore-filtered -- --since 2026-11-16
 *   npm run restore-filtered -- --since 2026-11-16 --reasons no_named_contact
 *
 * Reads DATABASE_URL_GATEWAY and WH_TENANT_ID from the environment, or from runner/.env when they are not set.
 */
try {
  if (!process.env.DATABASE_URL_GATEWAY) process.loadEnvFile(".env");
} catch {
  // No .env file: the environment has to provide them.
}
const url = process.env.DATABASE_URL_GATEWAY;
const tenantId = process.env.WH_TENANT_ID;
if (!url || !tenantId) {
  console.error("DATABASE_URL_GATEWAY and WH_TENANT_ID are needed.");
  process.exit(1);
}
const args = process.argv.slice(2);
const value = (flag: string) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
const since = value("--since") ? new Date(`${value("--since")}T00:00:00Z`) : undefined;
const reasons = (value("--reasons") ?? RESTORABLE_REASONS.join(",")).split(",").map((r) => r.trim()).filter(Boolean);
if (!since || Number.isNaN(since.getTime()) || reasons.some((r) => !(RESTORABLE_REASONS as readonly string[]).includes(r))) {
  console.error(`Usage: npm run restore-filtered -- --since YYYY-MM-DD [--reasons ${RESTORABLE_REASONS.join(",")}]`);
  process.exit(1);
}
const db = createDb(url, 2);
try {
  const counts = await restoreFiltered(db, { tenantId, reasons, since });
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  console.log(total === 0 ? "Nothing to put back." : `Put back to analysed: ${Object.entries(counts).map(([reason, n]) => `${n} that were ${reason}`).join(", ")}. They are sorted again on the next run.`);
} finally {
  await db.end();
}
