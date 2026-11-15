import { setConfig } from "./control/config.js";
import { createDb } from "./control/db.js";

/**
 * Change one room's daily budget, as the tenant's owner, until the settings
 * screen exists:
 *
 *   DATABASE_URL_UI=... WH_TENANT_ID=... npm run budget -- salekh-ventures:research 1.50
 */
const [roomId, amount] = process.argv.slice(2);
const limit = Number(amount);
const url = process.env.DATABASE_URL_UI;
const tenantId = process.env.WH_TENANT_ID;
if (!url || !tenantId || !roomId || !Number.isFinite(limit) || limit < 0) {
  console.error("Usage: DATABASE_URL_UI=... WH_TENANT_ID=... npm run budget -- <business>:<department> <pounds a day>");
  process.exit(1);
}
const [business, department] = roomId.split(":");
const db = createDb(url, 2);
try {
  const found = await db.tx(tenantId, async (tx) => ({
    floor: (await tx.query("select business_id from businesses where slug = $1 and $2 = any (departments)", [business, department])).rows[0],
    owner: (await tx.query("select member_id from members where role = 'owner' and status = 'active' order by created_at limit 1")).rows[0],
  }));
  if (!found.floor || !found.owner) throw new Error("no such room, or the tenant has no owner");
  const written = await setConfig(db, {
    tenantId, businessId: found.floor.business_id, kind: "budget", key: department as string,
    value: { daily_limit_gbp: limit }, memberId: found.owner.member_id, reason: "set from the command line",
  });
  console.log(`${roomId}: £${limit} a day (version ${written.version}).`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
