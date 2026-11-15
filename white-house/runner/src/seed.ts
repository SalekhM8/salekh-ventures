import { pathToFileURL } from "node:url";
import pg from "pg";

/**
 * Seed tenant one: the tenant, its owner, the four floors with their launch
 * departments, a default daily budget per room, and which rooms have a live
 * agent. Safe to run again: it only adds what is missing and never changes
 * what is already there.
 *
 * Run as the owner of the database, like the migrations:
 *
 *   DATABASE_URL=... WH_OWNER_NAME=... WH_OWNER_EMAIL=... npm run seed
 *
 * What it does NOT set, on purpose:
 *   - rungs: no row means rung 1 (recommend only) for every action type;
 *   - caps: with no cap an action that needs one is refused, the safe default;
 *   - targets: none have been given, and none are invented.
 */

/** BRIEF.md section 4, plus the new Research type on two floors. */
const FLOORS = [
  { slug: "roots", name: "ROOTS", departments: ["data", "ads", "creative"] },
  { slug: "mastore", name: "Mastore HQ", departments: ["data", "ads", "creative", "customer-relations", "engineering", "research"] },
  { slug: "twilight", name: "Twilight Pharmacy", departments: ["creative", "data"] },
  { slug: "salekh-ventures", name: "Salekh Ventures", departments: ["data", "creative", "customer-relations", "engineering", "research"] },
] as const;

/** Rooms whose agent is built. Everything else is a room with nobody in it yet. */
const LIVE_ROOMS: ReadonlyArray<readonly [string, string]> = [
  ["salekh-ventures", "data"],
  ["salekh-ventures", "research"],
  ["mastore", "research"],
];

/**
 * DEFAULT daily budgets in pounds, for Salekh to adjust. Each is the monthly
 * estimate in BRIEF.md section 14 divided by the number of floors that have
 * that department at launch and by 30 days, rounded up to a penny. They are
 * estimates of estimates: replace them after a week of real runs.
 */
const MONTHLY_GBP = { chief: 53, customerRelations: 53 + 1, ads: 19, engineering: 18, creative: 14, data: 10, rootsCompliance: 5 };
const perDay = (monthly: number, floors: number): number => Math.ceil((monthly / floors / 30) * 100) / 100;
const floorsWith = (department: string): number => FLOORS.filter((f) => (f.departments as readonly string[]).includes(department)).length;

function defaultBudget(floor: string, department: string): { daily_limit_gbp: number; default: true; basis: string } {
  const from14 = (monthly: number, label: string) => ({
    daily_limit_gbp: perDay(monthly, floorsWith(department)),
    default: true as const,
    basis: `BRIEF.md section 14: ${label} at £${monthly} a month, across ${floorsWith(department)} floors, over 30 days`,
  });
  switch (department) {
    case "data": return from14(MONTHLY_GBP.data, "Data");
    case "ads": return from14(MONTHLY_GBP.ads, "Ads");
    case "engineering": return from14(MONTHLY_GBP.engineering, "Engineering");
    case "customer-relations": return from14(MONTHLY_GBP.customerRelations, "Customer Relations drafts and sorting");
    case "creative": {
      const base = from14(MONTHLY_GBP.creative, "Creative");
      if (floor !== "roots") return base;
      // The ROOTS compliance pre check is a Creative cost on that floor only.
      const withCheck = Math.ceil((MONTHLY_GBP.creative / floorsWith("creative") / 30 + MONTHLY_GBP.rootsCompliance / 30) * 100) / 100;
      return { ...base, daily_limit_gbp: withCheck, basis: `${base.basis}, plus the ROOTS compliance pre check at £${MONTHLY_GBP.rootsCompliance} a month` };
    }
    default:
      // Research has no line in section 14. This is a PLACEHOLDER equal to Creative's, not an estimate.
      return {
        daily_limit_gbp: perDay(MONTHLY_GBP.creative, floorsWith("creative")),
        default: true,
        basis: "PLACEHOLDER: no line for this department in BRIEF.md section 14. Set to the Creative figure until Salekh gives one",
      };
  }
}

export interface SeedInput {
  connectionString: string;
  tenantSlug: string;
  tenantName: string;
  ownerName?: string;
  ownerEmail?: string;
}

const REASON = "seed default, for Salekh to adjust";

export async function seed(input: SeedInput): Promise<{ tenantId: string; tenantSlug: string }> {
  // The owner is a real person. Their name and email come from the environment, never from this file.
  if (!input.ownerName?.trim()) throw new Error("WH_OWNER_NAME is not set. The seed does not invent an owner.");
  if (!input.ownerEmail?.trim()) throw new Error("WH_OWNER_EMAIL is not set. The seed does not invent an owner.");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.tenantSlug)) throw new Error("the tenant slug must be lower case letters, digits and hyphens");

  const client = new pg.Client({ connectionString: input.connectionString });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended('white-house-seed', 0))");
    await client.query("insert into tenants (name, slug) values ($1, $2) on conflict (slug) do nothing", [input.tenantName, input.tenantSlug]);
    const tenantId = (await client.query("select tenant_id from tenants where slug = $1", [input.tenantSlug])).rows[0].tenant_id as string;

    const owner = await client.query("select 1 from members where tenant_id = $1 and role = 'owner' limit 1", [tenantId]);
    if (owner.rows.length === 0) {
      await client.query(
        "insert into members (tenant_id, display_name, email, role, may_approve) values ($1, $2, $3, 'owner', true)",
        [tenantId, input.ownerName.trim(), input.ownerEmail.trim()],
      );
    }

    const addConfig = async (businessId: string | null, kind: string, key: string, value: unknown) => {
      const exists = await client.query(
        "select 1 from config_versions where tenant_id = $1 and business_id is not distinct from $2 and kind = $3 and key = $4 limit 1",
        [tenantId, businessId, kind, key],
      );
      if (exists.rows.length > 0) return; // already set, perhaps changed since: leave it alone
      await client.query(
        `insert into config_versions (tenant_id, business_id, kind, key, value, version, changed_by_kind, reason)
         values ($1, $2, $3, $4, $5::jsonb, 1, 'system', $6)`,
        [tenantId, businessId, kind, key, JSON.stringify(value), REASON],
      );
    };

    for (const floor of FLOORS) {
      await client.query(
        "insert into businesses (tenant_id, slug, name, departments) values ($1, $2, $3, $4) on conflict (tenant_id, slug) do nothing",
        [tenantId, floor.slug, floor.name, floor.departments],
      );
      const row = (await client.query("select business_id, departments from businesses where tenant_id = $1 and slug = $2", [tenantId, floor.slug])).rows[0];
      const missing = floor.departments.filter((d) => !(row.departments as string[]).includes(d));
      if (missing.length > 0) {
        await client.query("update businesses set departments = departments || $2::text[] where business_id = $1", [row.business_id, missing]);
      }
      for (const department of floor.departments) {
        await addConfig(row.business_id, "budget", department, defaultBudget(floor.slug, department));
        if (LIVE_ROOMS.some(([f, d]) => f === floor.slug && d === department)) {
          await addConfig(row.business_id, "schedule", department, { live: true, runs: "on request" });
        }
      }
    }
    // The Chief of Staff is one for the whole house, so its budget has no floor. (It has no agent yet.)
    await addConfig(null, "budget", "chief-of-staff", {
      daily_limit_gbp: perDay(MONTHLY_GBP.chief, 1),
      default: true,
      basis: `BRIEF.md section 14: Chief of Staff at £${MONTHLY_GBP.chief} a month, over 30 days`,
    });

    await client.query("commit");
    return { tenantId, tenantSlug: input.tenantSlug };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

/** The name of the environment variable that holds a tenant's model API key. */
export function apiKeyEnvName(tenantSlug: string): string {
  return `ANTHROPIC_API_KEY_${tenantSlug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  seed({
    connectionString,
    tenantSlug: process.env.WH_TENANT_SLUG ?? "salekh",
    tenantName: process.env.WH_TENANT_NAME ?? "Salekh",
    ownerName: process.env.WH_OWNER_NAME,
    ownerEmail: process.env.WH_OWNER_EMAIL,
  })
    .then(({ tenantId, tenantSlug }) => {
      console.log(`Seeded tenant "${tenantSlug}".`);
      console.log(`WH_TENANT_ID=${tenantId}`);
      console.log(`The model key for this tenant is read from ${apiKeyEnvName(tenantSlug)}.`);
    })
    .catch((err: unknown) => {
      console.error((err as Error).message);
      process.exit(1);
    });
}
