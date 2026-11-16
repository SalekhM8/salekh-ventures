import { createDb } from "../control/db.js";
import { prospectStats } from "./store.js";

/**
 * Weekly numbers: counts per stage for a range of days.
 *
 *   npm run prospect-stats                          the last seven days
 *   npm run prospect-stats -- 2026-11-16 2026-11-23 from, and up to but not including, to
 *
 * Reads DATABASE_URL_GATEWAY and WH_TENANT_ID from the environment, or from
 * runner/.env when they are not set.
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
const iso = (date: Date) => date.toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
const [from = iso(new Date(tomorrow.getTime() - 7 * 24 * 60 * 60 * 1000)), to = iso(tomorrow)] = process.argv.slice(2);
const db = createDb(url, 2);
try {
  const stats = await prospectStats(db, { tenantId, from, to });
  console.log(`Prospects, ${stats.from} up to ${stats.to}`);
  for (const [stage, n] of Object.entries(stats.stages)) console.log(`  ${stage.padEnd(13)} ${n}`);
  const reasons = Object.entries(stats.filtered_out_by_reason);
  if (reasons.length) console.log(`  filtered out by reason: ${reasons.map(([r, n]) => `${r} ${n}`).join(", ")}`);
  for (const purpose of ["prospect", "rival"] as const) {
    const e = stats.enquiries[purpose];
    console.log(`  test enquiries to ${purpose === "prospect" ? "possible clients" : "rivals"}: proposed ${e.proposed}, approved ${e.approved}, rejected ${e.rejected}, sent ${e.sent}, ` +
      `replied (person) ${e.replied_person}, replied (automatic only) ${e.replied_automatic}, no reply ${e.no_reply}, scored ${e.scored}`);
  }
  for (const [type, stages] of Object.entries(stats.by_type).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${type}: ${Object.entries(stages).map(([stage, n]) => `${stage} ${n}`).join(", ")}`);
  }
  const signals = Object.entries(stats.found_by_signal);
  if (signals.length) console.log(`  found by signal: ${signals.map(([s, n]) => `${s} ${n}`).join(", ")}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
