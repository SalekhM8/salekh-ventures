import { pathToFileURL } from "node:url";
import { createDb, type Db } from "./control/db.js";
import { parseOutreachSettings, toStoredForm } from "./outreach/settings.js";
import type { CarriedConfig } from "./seed.js";

/**
 * npm run export-config              prints the JSON, to read
 * npm run export-config -- --base64  prints it as one line of base64, for WH_BOOTSTRAP_CONFIG on the server
 *
 * The non-personal configuration of one tenant, for carrying to another database: the settings, schedules,
 * budgets, rungs and caps now in force, and the suppressions that name a business (a domain or a company
 * number) with their reasons.
 *
 * What is NOT in it, on purpose: prospects, approvals, enquiries, message text, events, members, targets,
 * the kill switch, and any suppression that is an email address, a phone number or a name at a postcode
 * (those are about people; the count left out is printed on stderr so nothing is dropped unnoticed).
 *
 * A suppression the owner has lifted by putting the business back (0019) is not carried either: the put-back itself
 * names a prospect, which is not carried, so the server set up from this would otherwise hold a business he chose to
 * contact again. Only his own call-list holds can be lifted (wh_suppression_lifted); an opt-out or a complaint never is.
 *
 * Reads DATABASE_URL_GATEWAY and WH_TENANT_ID from the environment, or from runner/.env. Read only.
 */
const KINDS = ["setting", "schedule", "budget", "rung", "cap"];

export async function exportConfig(db: Db, tenantId: string, now = new Date()): Promise<{ blob: CarriedConfig & { version: 1; exported_at: string }; leftOut: number; putBack: number }> {
  return db.tx(tenantId, async (tx) => {
    const config = (await tx.query(
      `select distinct on (c.business_id, c.kind, c.key) b.slug as business, c.kind, c.key, c.value
         from config_versions c left join businesses b on b.business_id = c.business_id
        where c.kind = any ($1) and c.key not in ('outreach.patch', 'outreach.defaults')
        order by c.business_id, c.kind, c.key, c.version desc`,
      [KINDS],
    )).rows.map((r) => ({
      business: (r.business as string | null) ?? null, kind: r.kind as string, key: r.key as string,
      // The outreach settings go out in the current shape, with every kind of business written in full, whatever shape they were stored in.
      value: (r.kind === "setting" && r.key === "outreach" ? toStoredForm(parseOutreachSettings(r.value)) : r.value) as unknown,
    }));
    config.sort((a, b) => `${a.business ?? ""}|${a.kind}|${a.key}`.localeCompare(`${b.business ?? ""}|${b.kind}|${b.key}`));
    const all = (await tx.query(
      "select b.slug as business, s.kind, s.value_key, s.reason, s.source, wh_suppression_lifted(s.suppression_id) as lifted from suppressions s left join businesses b on b.business_id = s.business_id order by s.kind, s.value_key",
    )).rows;
    const putBack = all.filter((s) => s.lifted === true && (s.kind === "domain" || s.kind === "company_number")).length;
    const suppressions = all.filter((s) => (s.kind === "domain" || s.kind === "company_number") && s.lifted !== true)
      .map((s) => ({ business: (s.business as string | null) ?? null, kind: s.kind as string, value_key: s.value_key as string, reason: s.reason as string, source: s.source as string }));
    return { blob: { version: 1 as const, exported_at: now.toISOString(), config, suppressions }, leftOut: all.length - suppressions.length - putBack, putBack };
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
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
  const db = createDb(url, 2);
  try {
    const { blob, leftOut, putBack } = await exportConfig(db, tenantId);
    const json = JSON.stringify(blob);
    console.log(process.argv.includes("--base64") ? Buffer.from(json, "utf8").toString("base64") : JSON.stringify(blob, null, 2));
    console.error(`${blob.config.length} configuration values and ${blob.suppressions.length} suppressions of businesses.` +
      (leftOut > 0 ? ` LEFT OUT: ${leftOut} suppressions that are an email address, a phone number or a name at a postcode. They are about people and are not carried. Add them again on the server by hand if they must hold there.` : "") +
      (putBack > 0 ? ` Not carried: ${putBack} holds you lifted by putting the business back on the call list.` : ""));
  } finally {
    await db.end();
  }
}
