import { pathToFileURL } from "node:url";
import pg from "pg";
import { z } from "zod";
import { actionTypes } from "./control/action-types.js";
import { isUuid } from "./control/db.js";
import { canonicalJson, hashPayload } from "./control/hash.js";
import { defaultMigrationsDir, migrate } from "./migrate.js";
import { parseOutreachSettings, toStoredForm } from "./outreach/settings.js";
import { seed, type CarriedConfig } from "./seed.js";

/**
 * Everything the database needs, done from inside the runner's container at start, because on the server
 * there is no shell and the database has no public address.
 *
 * As the database's owner (DATABASE_URL_ADMIN, which exists for this step and no other):
 *   1. apply every migration that has not been applied;
 *   2. create or update the three login roles the runner uses, each a member of one White House role and
 *      nothing more: no superuser, no create role, no create database, no bypass of row level security;
 *   3. seed the tenant, its floors and rooms and the defaults, adding only what is missing;
 *   4. on the first boot only (the tenant has no outreach settings yet), apply the configuration carried
 *      over from the development database, if one was given.
 *
 * One at a time: an advisory lock is held for the whole of it, so two instances starting together cannot
 * both bootstrap. Safe to run on every start: the second time it changes nothing but the passwords, which
 * are set again so that changing a password is just changing the variable and restarting.
 *
 * Any failure stops the start with a fixed message. The owner's URL is never logged.
 */

export const BOOTSTRAP_FAILED = "BOOTSTRAP FAILED";

const carriedSchema = z.strictObject({
  version: z.literal(1),
  exported_at: z.string().max(40).optional(),
  config: z.array(z.strictObject({
    business: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(60).nullable(),
    // Not targets and not the kill switch: those are set by a person, on the server, when they are wanted.
    kind: z.enum(["setting", "schedule", "budget", "rung", "cap"]),
    key: z.string().min(1).max(100),
    value: z.record(z.string(), z.unknown()),
  })).max(500),
  // Businesses only. An email address, a phone number or a person's name at a postcode is never carried.
  suppressions: z.array(z.strictObject({
    business: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(60).nullable(),
    kind: z.enum(["domain", "company_number"]),
    value_key: z.string().min(1).max(300),
    reason: z.string().min(1).max(500),
    source: z.enum(["manual", "opt_out", "complaint"]),
  })).max(5000),
});

/** WH_BOOTSTRAP_CONFIG: base64 of the JSON that `npm run export-config` prints. Checked before any of it is used. */
export function parseCarriedConfig(base64: string): CarriedConfig {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(base64.trim(), "base64").toString("utf8"));
  } catch {
    throw new Error("WH_BOOTSTRAP_CONFIG is not base64 JSON");
  }
  const parsed = carriedSchema.safeParse(json);
  if (!parsed.success) throw new Error(`WH_BOOTSTRAP_CONFIG is not valid: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  for (const c of parsed.data.config) {
    if (c.kind === "rung") {
      // A rung can never be carried past the ceiling fixed in code for that action, or onto an action this code does not have.
      const type = actionTypes.get(c.key);
      const rung = Number((c.value as { rung?: unknown }).rung);
      if (!type) throw new Error(`WH_BOOTSTRAP_CONFIG sets a rung for an action type this runner does not have: ${c.key}`);
      if (!Number.isInteger(rung) || rung < 1 || rung > type.maxRung) throw new Error(`WH_BOOTSTRAP_CONFIG sets a rung outside 1 to ${type.maxRung} for ${c.key}`);
    }
    // The outreach settings are checked, and carried in the current shape whatever shape they were exported in.
    if (c.kind === "setting" && c.key === "outreach") c.value = toStoredForm(parseOutreachSettings(c.value));
  }
  return parsed.data;
}

export interface BootstrapOptions {
  /** The database owner's URL. Used here and nowhere else. */
  adminUrl: string;
  passwords: { agent: string; gateway: string; ui: string };
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  ownerName: string | undefined;
  ownerEmail: string | undefined;
  /** Applied on the first boot only. */
  carried?: CarriedConfig | null;
  migrationsDir?: string;
  /** The login roles are `<prefix>_agent`, `<prefix>_gateway` and `<prefix>_ui`. */
  rolePrefix?: string;
  /**
   * The kinds of business to have switched on, by id, and every other kind off. The server has no shell to run
   * the settings command from, so this is how a kind is switched on or off there. null or absent: left as they are.
   */
  enabledTypes?: string[] | null;
  /**
   * The owner's switch for test enquiries, on a server with no shell: 2 (each needs a yes) or 3 (sent without
   * asking, inside the limits). Written as a new version of the rung, in the owner's name, only when it differs
   * from what is in force. Anything but 2 or 3, or anything past the action's ceiling, stops the start.
   */
  enquiryRung?: number | null;
  /**
   * The owner's changes to the outreach settings, on a server with no shell: base64 of a JSON object holding only
   * what is to change. Checked by the same rules as the settings themselves and applied once: its hash is kept,
   * and a start that finds the same hash does nothing.
   */
  settingsPatch?: string | null;
}

export const PATCH_REASON = "set by the owner through the server's settings";
const PATCH_KEY = "outreach.patch";

/** Lay `patch` over `base`. Objects are merged key by key; anything else, a list included, replaces what was there. */
function merge(base: unknown, patch: unknown): unknown {
  const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!plain(base) || !plain(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = merge(base[key], value);
  return out;
}

/**
 * Apply WH_OUTREACH_SETTINGS_PATCH to every floor's outreach settings, as a new version in the owner's name.
 * `business_types` is merged kind by kind (by id), so one kind's assumptions can be changed without restating the
 * rest; a kind that is not already there must be given in full. The result must pass the settings' own checks:
 * an unknown key, a value past its limit, or anything that is not a setting (a rung, a cap, a budget) stops the start.
 */
async function applySettingsPatch(client: pg.Client, tenantId: string, base64: string): Promise<number> {
  let patch: unknown;
  try {
    patch = JSON.parse(Buffer.from(base64.trim(), "base64").toString("utf8"));
  } catch {
    throw new Error("WH_OUTREACH_SETTINGS_PATCH is not base64 JSON");
  }
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("WH_OUTREACH_SETTINGS_PATCH must be a JSON object");
  const hash = hashPayload(patch as Record<string, unknown>);
  const owner = (await client.query("select member_id from members where tenant_id = $1 and role = 'owner' and status = 'active' order by created_at limit 1", [tenantId])).rows[0];
  if (!owner) throw new Error("the tenant has no active owner to change the settings in the name of");
  const rows = (await client.query(
    `select distinct on (business_id) business_id, value, version from config_versions
      where tenant_id = $1 and kind = 'setting' and key = 'outreach' order by business_id, version desc`,
    [tenantId],
  )).rows;
  let applied = 0;
  for (const row of rows) {
    const last = (await client.query(
      "select value, version from config_versions where tenant_id = $1 and business_id = $2 and kind = 'setting' and key = $3 order by version desc limit 1",
      [tenantId, row.business_id, PATCH_KEY],
    )).rows[0];
    if (last?.value?.sha256 === hash) continue; // this very patch has been applied before: a restart does not apply it again
    const current = toStoredForm(parseOutreachSettings(row.value)) as Record<string, unknown>;
    const { business_types: kinds, ...rest } = patch as { business_types?: unknown } & Record<string, unknown>;
    const next = merge(current, rest) as Record<string, unknown>;
    if (kinds !== undefined) {
      if (!Array.isArray(kinds)) throw new Error("WH_OUTREACH_SETTINGS_PATCH is not valid: business_types must be a list");
      const list = (current.business_types as { id: string }[]).map((t) => ({ ...t }));
      for (const entry of kinds as { id?: unknown }[]) {
        const at = list.findIndex((t) => t.id === entry?.id);
        if (at >= 0) list[at] = merge(list[at], entry) as { id: string };
        else list.push(entry as { id: string });
      }
      next.business_types = list;
    }
    let checked: Record<string, unknown>;
    try {
      checked = toStoredForm(parseOutreachSettings(next)) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`WH_OUTREACH_SETTINGS_PATCH is not valid: ${err instanceof Error ? err.message : "it does not pass the settings' checks"}`);
    }
    if (canonicalJson(checked) !== canonicalJson(row.value)) {
      await client.query(
        `insert into config_versions (tenant_id, business_id, kind, key, value, version, changed_by_kind, changed_by_member, reason)
         values ($1, $2, 'setting', 'outreach', $3::jsonb, $4, 'member', $5, $6)`,
        [tenantId, row.business_id, JSON.stringify(checked), Number(row.version) + 1, owner.member_id, PATCH_REASON],
      );
    }
    await client.query(
      `insert into config_versions (tenant_id, business_id, kind, key, value, version, changed_by_kind, reason)
       values ($1, $2, 'setting', $3, $4::jsonb, $5, 'system', 'the hash of the last settings patch applied, so it is not applied twice')`,
      [tenantId, row.business_id, PATCH_KEY, JSON.stringify({ sha256: hash }), Number(last?.version ?? 0) + 1],
    );
    applied += 1;
  }
  return applied;
}

export const RUNG_REASON = "set by the owner through the server's settings";

async function setEnquiryRung(client: pg.Client, tenantId: string, rung: number): Promise<number> {
  const type = actionTypes.get("enquiry.send_email");
  if (!type) throw new Error("this runner has no enquiry.send_email action");
  if (rung !== 2 && rung !== 3) throw new Error("WH_ENQUIRY_RUNG must be 2 (each enquiry needs a yes) or 3 (sent without asking)");
  if (rung > type.maxRung) throw new Error(`WH_ENQUIRY_RUNG is above the ceiling of ${type.maxRung} fixed in code for test enquiries`);
  const owner = (await client.query("select member_id from members where tenant_id = $1 and role = 'owner' and status = 'active' order by created_at limit 1", [tenantId])).rows[0];
  if (!owner) throw new Error("the tenant has no active owner to set the rung in the name of");
  // Every floor that has an Outreach room.
  const floors = (await client.query("select business_id from businesses where tenant_id = $1 and 'outreach' = any (departments)", [tenantId])).rows;
  let changed = 0;
  for (const floor of floors) {
    const current = (await client.query(
      "select value, version from config_versions where tenant_id = $1 and business_id = $2 and kind = 'rung' and key = 'enquiry.send_email' order by version desc limit 1",
      [tenantId, floor.business_id],
    )).rows[0];
    if (Number(current?.value?.rung ?? 1) === rung) continue;
    await client.query(
      `insert into config_versions (tenant_id, business_id, kind, key, value, version, changed_by_kind, changed_by_member, reason)
       values ($1, $2, 'rung', 'enquiry.send_email', $3::jsonb, $4, 'member', $5, $6)`,
      [tenantId, floor.business_id, JSON.stringify({ rung }), Number(current?.version ?? 0) + 1, owner.member_id, RUNG_REASON],
    );
    changed += 1;
  }
  return changed;
}

export interface BootstrapResult {
  migrationsApplied: string[];
  roles: string[];
  tenantId: string;
  firstBoot: boolean;
  carriedApplied: boolean;
  /** Rooms whose outreach settings were written again: brought to the current shape, or a kind switched on or off. */
  settingsUpdated: number;
  /** Rooms whose rung for test enquiries was changed by WH_ENQUIRY_RUNG on this start. */
  rungChanged: number;
  /** Rooms the settings patch was applied to on this start. 0 when there was none, or it had been applied before. */
  patchApplied: number;
}

/**
 * Outreach settings stored in an older shape (one kind of business, named at the top) are written again in the
 * current one, as a new version: nothing is edited in place and the old version stays in the history. When a
 * list of kinds is given, exactly those are switched on. Does nothing when nothing would change.
 */
async function bringOutreachSettingsUpToDate(client: pg.Client, tenantId: string, enabled: string[] | null): Promise<number> {
  const rows = (await client.query(
    `select distinct on (business_id) business_id, value, version from config_versions
      where tenant_id = $1 and kind = 'setting' and key = 'outreach' order by business_id, version desc`,
    [tenantId],
  )).rows;
  let updated = 0;
  for (const row of rows) {
    const settings = parseOutreachSettings(row.value);
    const next = toStoredForm(settings) as { business_types: { id: string; enabled: boolean }[] };
    if (enabled) {
      const unknown = enabled.filter((id) => !next.business_types.some((t) => t.id === id));
      if (unknown.length > 0) throw new Error(`WH_OUTREACH_ENABLED_TYPES names a kind of business that is not in the settings: ${unknown.join(", ")}`);
      next.business_types = next.business_types.map((t) => ({ ...t, enabled: enabled.includes(t.id) }));
    }
    // Compared with keys in a fixed order: the database does not keep the order a value was written in.
    if (canonicalJson(next) === canonicalJson(row.value)) continue;
    await client.query(
      `insert into config_versions (tenant_id, business_id, kind, key, value, version, changed_by_kind, reason)
       values ($1, $2, 'setting', 'outreach', $3::jsonb, $4, 'system', $5)`,
      [tenantId, row.business_id, JSON.stringify(next), Number(row.version) + 1, enabled ? "kinds of business set from WH_OUTREACH_ENABLED_TYPES at start" : "brought to the current shape at start"],
    );
    updated += 1;
  }
  return updated;
}

export const DEFAULT_ROLE_PREFIX = "wh_live";
const ROLES = ["agent", "gateway", "ui"] as const;

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const prefix = options.rolePrefix ?? DEFAULT_ROLE_PREFIX;
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(prefix)) throw new Error("the role prefix must be lower case letters, digits and underscores");
  if (!isUuid(options.tenantId)) throw new Error("WH_TENANT_ID is not a uuid");
  for (const role of ROLES) {
    if (typeof options.passwords[role] !== "string" || options.passwords[role].length < 16) throw new Error(`the password for the ${role} login is missing or shorter than 16 characters`);
  }
  if (new Set(ROLES.map((r) => options.passwords[r])).size !== ROLES.length) throw new Error("the three logins must have three different passwords");

  const client = new pg.Client({ connectionString: options.adminUrl });
  await client.connect();
  try {
    // One bootstrap at a time, for as long as this connection lives.
    await client.query("select pg_advisory_lock(hashtextextended('white-house-bootstrap', 0))");

    const migrationsApplied = await migrate({ connectionString: options.adminUrl, dir: options.migrationsDir ?? defaultMigrationsDir() });

    const database = (await client.query("select current_database() as name")).rows[0].name as string;
    const roles: string[] = [];
    for (const role of ROLES) {
      const login = `${prefix}_${role}`;
      const exists = (await client.query("select 1 from pg_roles where rolname = $1", [login])).rows.length > 0;
      // Names and the password are quoted by the database itself (%I and %L), never pasted into the statement by hand.
      const statement = (await client.query(
        `select format('${exists ? "alter" : "create"} role %I with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit password %L', $1::text, $2::text) as sql`,
        [login, options.passwords[role]],
      )).rows[0].sql as string;
      await client.query(statement);
      await client.query((await client.query("select format('grant %I to %I', $1::text, $2::text) as sql", [`wh_${role}`, login])).rows[0].sql as string);
      await client.query((await client.query("select format('grant connect on database %I to %I', $1::text, $2::text) as sql", [database, login])).rows[0].sql as string);
      // A login belongs to its own White House role and to no other.
      const others = (await client.query(
        "select g.rolname from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member where u.rolname = $1 and g.rolname <> $2",
        [login, `wh_${role}`],
      )).rows;
      for (const other of others) await client.query((await client.query("select format('revoke %I from %I', $1::text, $2::text) as sql", [other.rolname, login])).rows[0].sql as string);
      roles.push(login);
    }

    // "First boot" is decided before the seed runs, because the seed itself adds default outreach settings.
    const firstBoot = (await client.query("select 1 from config_versions where tenant_id = $1 and kind = 'setting' and key = 'outreach' limit 1", [options.tenantId])).rows.length === 0;
    const carried = firstBoot && options.carried ? options.carried : undefined;
    const seeded = await seed({
      connectionString: options.adminUrl, tenantId: options.tenantId, tenantSlug: options.tenantSlug, tenantName: options.tenantName,
      ownerName: options.ownerName, ownerEmail: options.ownerEmail, ...(carried ? { carried } : {}),
    });
    const settingsUpdated = await bringOutreachSettingsUpToDate(client, seeded.tenantId, options.enabledTypes ?? null);
    const patchApplied = options.settingsPatch ? await applySettingsPatch(client, seeded.tenantId, options.settingsPatch) : 0;
    const rungChanged = options.enquiryRung === undefined || options.enquiryRung === null ? 0 : await setEnquiryRung(client, seeded.tenantId, options.enquiryRung);
    return { migrationsApplied, roles, tenantId: seeded.tenantId, firstBoot, carriedApplied: carried !== undefined, settingsUpdated, rungChanged, patchApplied };
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ---- from the environment --------------------------------------------------------

type Env = Record<string, string | undefined>;

/** Variables that hold the database owner's way in. The server process and everything it starts must not have them. */
export const ADMIN_ONLY_ENV = ["DATABASE_URL_ADMIN", "WH_BOOTSTRAP_CONFIG", "WH_OUTREACH_SETTINGS_PATCH", "DATABASE_URL", "DATABASE_PUBLIC_URL", "DATABASE_PRIVATE_URL", "PGPASSWORD", "POSTGRES_PASSWORD", "PGUSER", "POSTGRES_USER"] as const;

/**
 * The three connection URLs the server uses. Given outright (DATABASE_URL_GATEWAY and so on) they are used as
 * they are. Otherwise each is built from DATABASE_HOST, DATABASE_PORT and DATABASE_NAME with that login's password.
 */
export function connectionUrls(env: Env, rolePrefix = env.WH_DB_ROLE_PREFIX || DEFAULT_ROLE_PREFIX): { gateway?: string; ui?: string; agent?: string } {
  const out: { gateway?: string; ui?: string; agent?: string } = {};
  for (const role of ROLES) {
    const given = env[`DATABASE_URL_${role.toUpperCase()}`];
    const password = env[`WH_DB_PASSWORD_${role.toUpperCase()}`];
    if (given) out[role] = given;
    else if (env.DATABASE_HOST && env.DATABASE_NAME && password) {
      const url = new URL("postgres://placeholder");
      url.hostname = env.DATABASE_HOST;
      url.port = env.DATABASE_PORT ?? "5432";
      url.username = `${rolePrefix}_${role}`;
      url.password = password;
      url.pathname = `/${env.DATABASE_NAME}`;
      out[role] = url.toString();
    }
  }
  return out;
}

/** Run the bootstrap from the environment. Throws an Error whose message is safe to print: it never holds a URL or a password. */
export async function bootstrapFromEnv(env: Env, log: (line: string) => void = console.log): Promise<BootstrapResult> {
  const missing = ["DATABASE_URL_ADMIN", "WH_TENANT_ID", "WH_DB_PASSWORD_AGENT", "WH_DB_PASSWORD_GATEWAY", "WH_DB_PASSWORD_UI", "WH_OWNER_NAME", "WH_OWNER_EMAIL"].filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`${BOOTSTRAP_FAILED}: not set: ${missing.join(", ")}`);
  let step = "reading WH_BOOTSTRAP_CONFIG";
  try {
    const carried = env.WH_BOOTSTRAP_CONFIG ? parseCarriedConfig(env.WH_BOOTSTRAP_CONFIG) : null;
    step = "setting up the database";
    const result = await bootstrap({
      adminUrl: env.DATABASE_URL_ADMIN as string,
      passwords: { agent: env.WH_DB_PASSWORD_AGENT as string, gateway: env.WH_DB_PASSWORD_GATEWAY as string, ui: env.WH_DB_PASSWORD_UI as string },
      tenantId: env.WH_TENANT_ID as string, tenantSlug: env.WH_TENANT_SLUG ?? "salekh", tenantName: env.WH_TENANT_NAME ?? "Salekh",
      ownerName: env.WH_OWNER_NAME, ownerEmail: env.WH_OWNER_EMAIL, carried,
      ...(env.MIGRATIONS_DIR ? { migrationsDir: env.MIGRATIONS_DIR } : {}),
      ...(env.WH_OUTREACH_SETTINGS_PATCH ? { settingsPatch: env.WH_OUTREACH_SETTINGS_PATCH } : {}),
      ...(env.WH_ENQUIRY_RUNG !== undefined && env.WH_ENQUIRY_RUNG !== "" ? { enquiryRung: /^[0-9]$/.test(env.WH_ENQUIRY_RUNG.trim()) ? Number(env.WH_ENQUIRY_RUNG.trim()) : Number.NaN } : {}),
      ...(env.WH_OUTREACH_ENABLED_TYPES ? { enabledTypes: env.WH_OUTREACH_ENABLED_TYPES.split(",").map((id) => id.trim()).filter(Boolean) } : {}),
      // Only for running two houses on one database server (as the tests do). The server leaves it unset.
      ...(env.WH_DB_ROLE_PREFIX ? { rolePrefix: env.WH_DB_ROLE_PREFIX } : {}),
    });
    log(`bootstrap: ${result.migrationsApplied.length} migrations applied, ${result.roles.length} logins set, tenant ready` +
      `${result.firstBoot ? (result.carriedApplied ? ", first boot: carried configuration applied" : ", first boot: defaults only") : ", not the first boot: configuration left as it is"}` +
      `${result.patchApplied > 0 ? ", the owner's settings patch applied" : ""}` +
      `${result.rungChanged > 0 ? `, test enquiries set to rung ${env.WH_ENQUIRY_RUNG?.trim()} (${env.WH_ENQUIRY_RUNG?.trim() === "3" ? "sent without asking" : "each needs a yes"})` : ""}` +
      `${result.settingsUpdated > 0 ? `, outreach settings written again for ${result.settingsUpdated} ${result.settingsUpdated === 1 ? "room" : "rooms"}` : ""}`);
    return result;
  } catch (err) {
    // The message is passed on only after anything that could be a URL or a password is taken out of it.
    const detail = scrub(err instanceof Error ? err.message : "error", env);
    throw new Error(`${BOOTSTRAP_FAILED} while ${step}: ${detail}`);
  }
}

/** Take every secret this process was given out of a line before it is printed. */
export function scrub(text: string, env: Env): string {
  let out = text.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, "[database url]");
  for (const name of ["DATABASE_URL_ADMIN", "WH_DB_PASSWORD_AGENT", "WH_DB_PASSWORD_GATEWAY", "WH_DB_PASSWORD_UI", "PGPASSWORD", "POSTGRES_PASSWORD"]) {
    const value = env[name];
    if (value && value.length >= 4) out = out.split(value).join("[secret]");
  }
  try {
    const password = env.DATABASE_URL_ADMIN ? decodeURIComponent(new URL(env.DATABASE_URL_ADMIN).password) : "";
    if (password.length >= 4) out = out.split(password).join("[secret]");
  } catch { /* not a URL: nothing more to take out */ }
  return out.slice(0, 400);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  bootstrapFromEnv(process.env).then(() => process.exit(0)).catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
