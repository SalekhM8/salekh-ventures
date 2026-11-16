import { createDb } from "../control/db.js";
import { resetAnalysisAttempts } from "./store.js";

/**
 * A one-off repair, for when analyses failed through a fault of ours (for example a request the model refused).
 *
 *   npm run reset-attempts                                          businesses still waiting: attempts back to nought
 *   npm run reset-attempts -- --restore-failed-since 2026-11-16     also put back those set aside as analysis_failed since that day
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
const at = args.indexOf("--restore-failed-since");
const since = at >= 0 ? new Date(`${args[at + 1]}T00:00:00Z`) : undefined;
if ((at >= 0 && (!since || Number.isNaN(since.getTime()))) || (at < 0 && args.length > 0)) {
  console.error("Usage: npm run reset-attempts [-- --restore-failed-since YYYY-MM-DD]");
  process.exit(1);
}
const db = createDb(url, 2);
try {
  const done = await resetAnalysisAttempts(db, { tenantId, ...(since ? { restoreFailedSince: since } : {}) });
  console.log(`Attempts set back to nought for ${done.reset} businesses still waiting to be analysed.`);
  if (since) console.log(`Put back to waiting: ${done.restored} businesses set aside as analysis_failed since ${since.toISOString().slice(0, 10)}.`);
} finally {
  await db.end();
}
