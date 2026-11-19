// What the runner needs to run on a server with nobody at a shell: the database set up at start, the three
// logins with the least they need, configuration carried over once, a standby that owns nothing, a run with
// no search tool installed, auth on every route, and a schedule that keeps London time whatever the machine's.
//
// The machine's own time zone is set far from London on purpose, before anything reads the clock.
process.env.TZ = "Pacific/Kiritimati";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { adminUrl, control, makeClock, openHarness, rows, seedTenant, serverUrl } from "./helpers.js";
import { asModelAnswer, makeHouse, TEST_TOKEN } from "./house-helpers.js";
import { createScriptedModel } from "../dist/agents/model-caller.js";
import { ADMIN_ONLY_ENV, BOOTSTRAP_FAILED, bootstrap, bootstrapFromEnv, connectionUrls, parseCarriedConfig, scrub } from "../dist/bootstrap.js";
import { agentReachFromEnv, notConfiguredReach } from "../dist/control/connectors/agent-reach.js";
import { DIRECT_READ_AGENT, robotsAllow, toText } from "../dist/control/connectors/direct-read.js";
import { toPlace } from "../dist/control/connectors/places.js";
import { exportConfig } from "../dist/export-config.js";
import { changeOutreachSettings } from "../dist/outreach/admin.js";
import { ENQUIRY_ACTION, ENQUIRY_CAP } from "../dist/outreach/enquiries.js";
import { addSuppression } from "../dist/outreach/store.js";
import { createScheduler } from "../dist/scheduler.js";
import { createRunnerServer } from "../dist/server.js";
import { serverEnv } from "../dist/start.js";

const h = openHarness();
const open = [];
const BOOT_DB = "wh_boot_test";
const PREFIX = "wh_boottest";
const TENANT = "5f0c1b9e-7a3d-4c58-9e21-0b6f4d2a8c11"; // fixture: stands for the id already used on the developer's machine
const PASSWORDS = { agent: "fixture-agent-password-1", gateway: "fixture-gateway-password-2", ui: "fixture-ui-password-3" };
const bootAdmin = adminUrl(BOOT_DB);
const loginUrl = (role, password = PASSWORDS[role]) => {
  const url = new URL(serverUrl());
  url.username = `${PREFIX}_${role}`;
  url.password = password;
  url.pathname = `/${BOOT_DB}`;
  return url.toString();
};
const asAdmin = async (database, fn) => {
  const client = new pg.Client({ connectionString: adminUrl(database) });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
};
const dropBootDb = () => asAdmin("postgres", async (c) => {
  await c.query(`drop database if exists ${BOOT_DB} with (force)`);
  for (const role of ["agent", "gateway", "ui"]) await c.query(`drop role if exists ${PREFIX}_${role}`);
});

before(async () => {
  await dropBootDb();
  await asAdmin("postgres", (c) => c.query(`create database ${BOOT_DB}`));
});
after(async () => {
  await Promise.all(open.filter((x) => x.close).map((x) => x.close()));
  await Promise.all(open.filter((x) => x.end).map((x) => x.end()));
  await h.close();
  await dropBootDb();
});

const blob = (over = {}) => ({
  version: 1, exported_at: "2026-11-17T09:00:00.000Z",
  config: [
    { business: "salekh-ventures", kind: "setting", key: "outreach", value: { business_type: "private dental and aesthetics clinics", area: "England", areas: ["Carriedton", "Carriedham"], areas_per_run: 2, excluded_groups: ["Fixture Group"], leak_assumptions: { enquiries_a_month: { low: 11, high: 44 } } } },
    { business: "salekh-ventures", kind: "schedule", key: "outreach", value: { live: true, runs: "daily", daily_at: "07:30" } },
    { business: "salekh-ventures", kind: "budget", key: "outreach", value: { daily_limit_gbp: 3 } },
    { business: "salekh-ventures", kind: "rung", key: "enquiry.send_email", value: { rung: 2 } },
    { business: "salekh-ventures", kind: "cap", key: "enquiries_per_day", value: { limit: 12 } },
    { business: "no-such-floor", kind: "budget", key: "data", value: { daily_limit_gbp: 9 } },
  ],
  suppressions: [{ business: null, kind: "domain", value_key: "fixture-carried.example.test", reason: "asked not to be contacted", source: "opt_out" }],
  ...over,
});
const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
const boot = (over = {}) => bootstrap({
  adminUrl: bootAdmin, passwords: PASSWORDS, tenantId: TENANT, tenantSlug: "fixture-boot", tenantName: "Fixture Boot",
  ownerName: "Fixture Owner", ownerEmail: "fixture-owner@example.test", rolePrefix: PREFIX, ...over,
});
const bootRows = (sql, params = []) => asAdmin(BOOT_DB, async (c) => (await c.query(sql, params)).rows);
const current = async (kind, key) => (await bootRows(
  "select c.value, c.reason, c.version from config_versions c join businesses b using (business_id) where c.tenant_id = $1 and b.slug = 'salekh-ventures' and c.kind = $2 and c.key = $3 order by c.version desc limit 1", [TENANT, kind, key]))[0];

// ---- the database, set up at start ----

test("what is carried over is checked before any of it is used: no people, no message text, no rung past its ceiling", () => {
  const good = parseCarriedConfig(encode(blob()));
  assert.deepEqual([good.config.length, good.suppressions.length], [6, 1]);
  const refuses = (value, pattern) => assert.throws(() => parseCarriedConfig(typeof value === "string" ? value : encode(value)), pattern);
  refuses("not base64 json %%%", /not base64 JSON/);
  refuses(blob({ suppressions: [{ business: null, kind: "email", value_key: "fixture-person@example.test", reason: "x", source: "opt_out" }] }), /not valid/);
  refuses(blob({ suppressions: [{ business: null, kind: "name_postcode", value_key: "abc", reason: "x", source: "manual" }] }), /not valid/);
  refuses(blob({ prospects: [{ name: "Fixture Clinic" }] }), /not valid/);
  refuses(blob({ config: [{ business: "salekh-ventures", kind: "setting", key: "outreach", value: {}, message: "Hello, could you tell me the price" }] }), /not valid/);
  refuses(blob({ config: [{ business: "salekh-ventures", kind: "target", key: "x", value: {} }] }), /not valid/);
  refuses(blob({ config: [{ business: "salekh-ventures", kind: "kill_switch", key: "x", value: { on: false } }] }), /not valid/);
  refuses(blob({ config: [{ business: "salekh-ventures", kind: "rung", key: "enquiry.send_email", value: { rung: 4 } }] }), /rung outside 1 to 3/);
  refuses(blob({ config: [{ business: "salekh-ventures", kind: "rung", key: "payments.refund", value: { rung: 2 } }] }), /action type this runner does not have/);
  refuses(blob({ config: [{ business: "salekh-ventures", kind: "setting", key: "outreach", value: { find_per_run: "lots" } }] }), /./);
  refuses(blob({ version: 2 }), /not valid/);
});

test("bootstrap: two instances starting together set the database up once; a second start changes nothing; configuration is carried over on the first boot only", async () => {
  // ---- the first boot, by two instances at the same moment ----
  const [one, two] = await Promise.all([boot({ carried: parseCarriedConfig(encode(blob())) }), boot({ carried: parseCarriedConfig(encode(blob())) })]);
  assert.deepEqual([one.tenantId, two.tenantId], [TENANT, TENANT], "the tenant has the id that was given, so it matches the developer's machine");
  assert.deepEqual([one.migrationsApplied.length + two.migrationsApplied.length, [one.firstBoot, two.firstBoot].filter(Boolean).length], [20, 1], "each migration applied once; one of the two was the first boot");
  assert.deepEqual(one.roles, [`${PREFIX}_agent`, `${PREFIX}_gateway`, `${PREFIX}_ui`]);
  const counts = async () => (await bootRows(
    `select (select count(*)::int from tenants) as tenants, (select count(*)::int from businesses) as floors, (select count(*)::int from members) as members,
            (select count(*)::int from config_versions) as config, (select count(*)::int from suppressions) as suppressions, (select count(*)::int from schema_migrations) as migrations,
            (select count(*)::int from prospects) as prospects, (select count(*)::int from approvals) as approvals`))[0];
  const first = await counts();
  assert.deepEqual([first.tenants, first.floors, first.members, first.suppressions, first.migrations, first.prospects, first.approvals], [1, 4, 1, 1, 20, 0, 0]);
  assert.deepEqual(await bootRows("select slug, timezone from tenants"), [{ slug: "fixture-boot", timezone: "Europe/London" }]);

  // what was carried is in force, as version 1, and says where it came from
  const outreach = await current("setting", "outreach");
  const carriedClinics = outreach.value.business_types.find((t) => t.id === "clinics");
  assert.deepEqual([outreach.value.areas, carriedClinics.excluded_groups, carriedClinics.leak_assumptions.enquiries_a_month, outreach.version, outreach.reason],
    [["Carriedton", "Carriedham"], ["Fixture Group"], { low: 11, high: 44 }, 1, "carried over from the development database at first boot"]);
  // the blob was in the shape from before there was more than one kind: it arrives in the current one, clinics on and the rest off
  assert.deepEqual(outreach.value.business_types.map((t) => [t.id, t.enabled]), [["clinics", true], ["solicitors", false], ["financial-advisers", false], ["estate-agents", false], ["accountants", false], ["trades", false]]);
  assert.deepEqual([(await current("schedule", "outreach")).value.daily_at, (await current("budget", "outreach")).value, (await current("rung", "enquiry.send_email")).value, (await current("cap", "enquiries_per_day")).value],
    ["07:30", { daily_limit_gbp: 3 }, { rung: 2 }, { limit: 12 }]);
  // what was not carried took the seed's default
  assert.equal((await current("budget", "data")).reason, "seed default, for Salekh to adjust");
  assert.deepEqual(await bootRows("select kind, value_key, reason, source, business_id from suppressions"), [{ kind: "domain", value_key: "fixture-carried.example.test", reason: "asked not to be contacted", source: "opt_out", business_id: null }]);
  assert.equal((await bootRows("select 1 from config_versions where key = 'data' and value ->> 'daily_limit_gbp' = '9'")).length, 0, "a floor this house does not have is ignored");

  // ---- a second start, with a different blob: nothing changes ----
  const other = blob();
  other.config[0].value.areas = ["Otherton"];
  other.suppressions = [{ business: null, kind: "domain", value_key: "fixture-other.example.test", reason: "x", source: "manual" }];
  const again = await boot({ carried: parseCarriedConfig(encode(other)) });
  assert.deepEqual([again.migrationsApplied, again.firstBoot, again.carriedApplied, again.tenantId], [[], false, false, TENANT]);
  assert.deepEqual(await counts(), first, "run twice: not one row more");
  assert.deepEqual((await current("setting", "outreach")).value.areas, ["Carriedton", "Carriedham"]);
  // ...and a third, with none
  assert.deepEqual((await boot()).carriedApplied, false);
  assert.deepEqual(await counts(), first);

  // ---- kinds of business are switched on from the environment, because the server has no shell to run the settings command from ----
  const versionsOf = async () => (await bootRows("select count(*)::int as n from config_versions where tenant_id = $1 and kind = 'setting' and key = 'outreach'", [TENANT]))[0].n;
  const beforeSwitch = await versionsOf();
  const switched = await boot({ enabledTypes: ["clinics", "solicitors", "trades"] });
  assert.equal(switched.settingsUpdated, 1);
  const afterSwitch = await current("setting", "outreach");
  assert.deepEqual([afterSwitch.value.business_types.filter((t) => t.enabled).map((t) => t.id), afterSwitch.reason, afterSwitch.value.areas, await versionsOf()],
    [["clinics", "solicitors", "trades"], "kinds of business set from WH_OUTREACH_ENABLED_TYPES at start", ["Carriedton", "Carriedham"], beforeSwitch + 1], "a new version: the old one stays in the history, and nothing else in the settings moves");
  assert.equal((await boot({ enabledTypes: ["clinics", "solicitors", "trades"] })).settingsUpdated, 0, "the same list again writes nothing");
  assert.equal((await boot()).settingsUpdated, 0, "and with no list the kinds are left as they are");
  assert.equal(await versionsOf(), beforeSwitch + 1);
  await assert.rejects(boot({ enabledTypes: ["clinics", "online-shops"] }), /not in the settings: online-shops/);
  const afterAll = await counts();
  assert.deepEqual({ ...afterAll, config: first.config + 1 }, { ...first, config: first.config + 1 });

  // ---- the owner's switch for test enquiries, on a server with no shell ----
  const rungRows = () => bootRows("select c.value, c.version, c.changed_by_kind, c.changed_by_member is not null as by_member, c.reason from config_versions c join businesses b using (business_id) where c.tenant_id = $1 and b.slug = 'salekh-ventures' and c.kind = 'rung' and c.key = 'enquiry.send_email' order by c.version", [TENANT]);
  assert.deepEqual((await rungRows()).map((r) => r.value.rung), [2]);
  assert.equal((await boot({ enquiryRung: 3 })).rungChanged, 1);
  assert.deepEqual((await rungRows()).at(-1), { value: { rung: 3 }, version: 2, changed_by_kind: "member", by_member: true, reason: "set by the owner through the server's settings" });
  assert.equal((await boot({ enquiryRung: 3 })).rungChanged, 0, "the same again writes nothing");
  assert.equal((await boot()).rungChanged, 0, "and with none given the rung is left where it is");
  for (const bad of [4, 1, 0, Number.NaN, 2.5]) await assert.rejects(boot({ enquiryRung: bad }), /WH_ENQUIRY_RUNG must be 2 \(each enquiry needs a yes\) or 3 \(sent without asking\)/, String(bad));
  assert.deepEqual((await rungRows()).map((r) => r.value.rung), [2, 3], "a refused value changed nothing");
  assert.equal((await boot({ enquiryRung: 2 })).rungChanged, 1, "and it can be taken back down the same way");
  assert.deepEqual((await rungRows()).map((r) => r.value.rung), [2, 3, 2]);
  const afterRung = await counts();
  assert.deepEqual({ ...afterRung, config: 0 }, { ...first, config: 0 });

  // ---- the owner's settings patch: applied once, checked like any settings, refused whole when any of it is wrong ----
  const settingRows = () => bootRows("select c.key, c.value, c.version, c.changed_by_kind, c.reason from config_versions c join businesses b using (business_id) where c.tenant_id = $1 and b.slug = 'salekh-ventures' and c.kind = 'setting' order by c.key, c.version", [TENANT]);
  const patch = { non_working_dates: ["2026-12-25", "2026-12-28"], enquiry_send_until: "21:00", capture_weights: { followed_up: 5 }, business_types: [{ id: "trades", leak_assumptions: { enquiries_a_month: { low: 5, high: 15 } } }] };
  const beforePatch = await settingRows();
  const patched = await boot({ settingsPatch: encode(patch) });
  assert.equal(patched.patchApplied, 1);
  const afterPatch = await settingRows();
  const outreachNow = afterPatch.filter((r) => r.key === "outreach").at(-1);
  assert.deepEqual([afterPatch.length - beforePatch.length, outreachNow.changed_by_kind, outreachNow.reason, outreachNow.value.non_working_dates, outreachNow.value.enquiry_send_until, outreachNow.value.enquiry_send_from],
    [2, "member", "set by the owner through the server's settings", ["2026-12-25", "2026-12-28"], "21:00", "07:00"], "a new version in the owner's name, and a note of the patch's hash");
  // only what the patch names has moved: a nested value, and one kind's assumption, with everything beside them left alone
  assert.deepEqual([outreachNow.value.capture_weights.followed_up, outreachNow.value.capture_weights.within_15_minutes], [5, 50]);
  const tradesNow = outreachNow.value.business_types.find((t) => t.id === "trades");
  assert.deepEqual([tradesNow.leak_assumptions.enquiries_a_month, tradesNow.leak_assumptions.share_lost_to_a_slow_reply, tradesNow.search_phrases.length, outreachNow.value.business_types.length, outreachNow.value.areas],
    [{ low: 5, high: 15 }, { low: 0.1, high: 0.3 }, 5, 6, ["Carriedton", "Carriedham"]]);
  assert.match(afterPatch.filter((r) => r.key === "outreach.patch").at(-1).value.sha256, /^[0-9a-f]{64}$/);
  // a restart with the same patch applies nothing; so does one with the same patch written with its keys in another order
  assert.equal((await boot({ settingsPatch: encode(patch) })).patchApplied, 0);
  assert.equal((await boot({ settingsPatch: encode({ enquiry_send_until: "21:00", business_types: patch.business_types, capture_weights: { followed_up: 5 }, non_working_dates: patch.non_working_dates }) })).patchApplied, 0);
  assert.equal((await settingRows()).length, afterPatch.length, "not one row more");
  // a different patch is applied
  assert.equal((await boot({ settingsPatch: encode({ enquiry_send_until: "21:30" }) })).patchApplied, 1);
  assert.equal((await settingRows()).filter((r) => r.key === "outreach").at(-1).value.enquiry_send_until, "21:30");
  // anything wrong in it stops the start, and nothing of it is applied
  const settled = await settingRows();
  for (const [bad, why] of [
    [{ rung: 3 }, /not valid/], [{ enquiry_rung: 3 }, /not valid/], [{ enquiries_per_day: 500 }, /not valid/], [{ surprise: true }, /not valid/],
    [{ enquiry_send_until: "25:00" }, /not valid/], [{ max_places_calls_per_run: 99999 }, /not valid/], [{ enquiry_send_until: "20:00", capture_weights: { surprise: 1 } }, /not valid/],
    [{ business_types: [{ id: "online-shops" }] }, /not valid/], [{ business_types: "all" }, /must be a list/], [[1, 2], /must be a JSON object/],
  ]) await assert.rejects(boot({ settingsPatch: encode(bad) }), why, JSON.stringify(bad));
  await assert.rejects(boot({ settingsPatch: "%%% not base64 json" }), /not base64 JSON/);
  assert.deepEqual(await settingRows(), settled, "a refused patch changed nothing, not even the part of it that was valid");

  // ---- a default that changed in code reaches settings stored with the old one, once ----
  const latest = async () => (await settingRows()).filter((r) => r.key === "outreach").at(-1);
  const store = async (over) => {
    const now = await latest();
    await bootRows(`insert into config_versions (tenant_id, business_id, kind, key, value, version, changed_by_kind, reason)
      select $1, business_id, 'setting', 'outreach', $2::jsonb, $3, 'system', 'test fixture' from businesses where tenant_id = $1 and slug = 'salekh-ventures'`, [TENANT, JSON.stringify({ ...now.value, ...over }), now.version + 1]);
  };
  // as the server was: settings written out in full when the defaults were 20 calls and 09:00 to 17:30 on weekdays, and no note of which changes have been applied
  await store({ max_places_calls_per_run: 20, enquiry_send_from: "09:00", enquiry_send_until: "17:30", enquiry_send_days: [1, 2, 3, 4, 5] });
  await bootRows("delete from config_versions where tenant_id = $1 and key = 'outreach.defaults'", [TENANT]);
  assert.equal((await boot()).settingsUpdated, 1);
  let adopted = await latest();
  assert.deepEqual([adopted.value.max_places_calls_per_run, adopted.value.enquiry_send_from, adopted.value.enquiry_send_until, adopted.value.enquiry_send_days, adopted.reason],
    [40, "07:00", "21:30", [1, 2, 3, 4, 5, 6, 7], "defaults that have changed adopted (max_places_calls_per_run, enquiry_send_from, enquiry_send_until, enquiry_send_days)"]);
  assert.equal((await boot()).settingsUpdated, 0, "once");
  // put back to the old figure on purpose afterwards: it is a choice now, and stays
  await store({ max_places_calls_per_run: 20 });
  assert.equal((await boot()).settingsUpdated, 0);
  assert.equal((await latest()).value.max_places_calls_per_run, 20);
  await store({ max_places_calls_per_run: 40 });

  // the same slug under another id is refused, not quietly made into a second tenant
  await assert.rejects(boot({ tenantId: "11111111-2222-4333-8444-555555555555" }), /another id/);
  assert.equal((await counts()).tenants, 1);
});

test("the three logins: each a member of its own role and nothing else, with no powers of its own, and each held to what its role may do", async () => {
  const attrs = await bootRows(
    `select r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls, r.rolreplication, r.rolcanlogin,
            array(select g.rolname::text from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid order by 1) as member_of
       from pg_roles r where r.rolname like $1 order by 1`, [`${PREFIX}\\_%`]);
  assert.deepEqual(attrs.map((r) => [r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls, r.rolreplication, r.rolcanlogin, r.member_of]), [
    [`${PREFIX}_agent`, false, false, false, false, false, true, ["wh_agent"]],
    [`${PREFIX}_gateway`, false, false, false, false, false, true, ["wh_gateway"]],
    [`${PREFIX}_ui`, false, false, false, false, false, true, ["wh_ui"]],
  ]);
  const dbs = Object.fromEntries(["agent", "gateway", "ui"].map((role) => [role, control.createDb(loginUrl(role), 2)]));
  open.push(...Object.values(dbs));
  const floor = (await bootRows("select business_id from businesses where slug = 'salekh-ventures'"))[0].business_id;
  const owner = (await bootRows("select member_id from members"))[0].member_id;
  const denied = (err) => err.code === "42501";
  const q = (role, sql, params = []) => dbs[role].tx(TENANT, (tx) => tx.query(sql, params));

  // each login can do its own job...
  assert.equal((await q("gateway", "select count(*)::int as n from businesses")).rows[0].n, 4);
  assert.equal((await q("ui", "select count(*)::int as n from config_versions")).rows[0].n > 10, true);
  await control.setConfig(dbs.ui, { tenantId: TENANT, businessId: floor, kind: "budget", key: "outreach", value: { daily_limit_gbp: 4 }, memberId: owner, reason: "test fixture" });
  // ...and not another's
  await assert.rejects(q("agent", "select 1 from enquiries"), denied, "the agent tools' login cannot read enquiries");
  await assert.rejects(q("agent", "select 1 from businesses"), denied, "nor even the list of floors");
  assert.deepEqual((await q("agent", "select count(*)::int as n from metrics")).rows, [{ n: 0 }], "it can read what agent tools read");
  await assert.rejects(q("agent", "select 1 from suppressions"), denied);
  await assert.rejects(q("agent", "insert into config_versions (tenant_id, business_id, kind, key, value, version, changed_by_kind, reason) values ($1, $2, 'budget', 'outreach', '{}', 99, 'system', 'x')", [TENANT, floor]), denied);
  await assert.rejects(q("gateway", "update enquiries set body = body"), denied, "the gateway's login cannot rewrite an approved enquiry");
  await assert.rejects(q("gateway", "delete from prospects"), denied);
  await assert.rejects(q("gateway", "delete from suppressions"), (err) => err.code === "42501" || /suppress/i.test(err.message));
  await assert.rejects(control.setConfig(dbs.gateway, { tenantId: TENANT, businessId: floor, kind: "cap", key: "enquiries_per_day", value: { limit: 999 }, memberId: owner, reason: "test fixture" }), (err) => err.code === "42501" || err.code === "forbidden" || /permission|not allowed|only/i.test(err.message),
    "the gateway's login cannot do what the UI's can: it cannot raise a cap");
  await assert.rejects(q("ui", "insert into prospects (tenant_id, business_id, name, domain_key) values ($1, $2, 'x', 'x.example.test')", [TENANT, floor]), denied, "the UI's login cannot add to the master list");
  await assert.rejects(q("ui", "delete from config_versions"), denied, "nobody rewrites the history of a setting");
  await assert.rejects(q("ui", "update enquiries set status = 'approved'"), denied, "the UI's login cannot mark an enquiry approved behind the gateway's back");
  // none of them can step outside its role, or act as the database's owner
  for (const role of ["agent", "gateway", "ui"]) {
    await assert.rejects(q(role, "set role postgres"), (err) => ["42501", "22023"].includes(err.code), role);
    await assert.rejects(q(role, `set role ${role === "ui" ? "wh_gateway" : "wh_ui"}`), (err) => ["42501", "22023"].includes(err.code), role);
    await assert.rejects(q(role, "create role fixture_escalation"), denied, role);
    await assert.rejects(q(role, "create table fixture_escalation (x int)"), denied, role);
    await assert.rejects(q(role, "alter table prospects disable row level security"), denied, role);
    await assert.rejects(q(role, "delete from schema_migrations"), denied, role);
    await assert.rejects(q(role, "insert into schema_migrations (name, checksum) values ('9999_fixture.sql', 'x')"), denied, role);
    // row level security still holds: another tenant's id shows nothing
    if (role !== "agent") assert.equal((await dbs[role].tx("99999999-8888-4777-8666-555555555555", (tx) => tx.query("select count(*)::int as n from businesses"))).rows[0].n, 0, role);
  }

  // a password is set again on every start: changing it is changing the variable and restarting
  const changed = { ...PASSWORDS, gateway: "fixture-gateway-password-changed" };
  // (The local test database lets every local connection in without checking a password, so a refused login cannot
  // be shown here. What is checked is the stored password itself: it changes for the one login and for no other.)
  const stored = async () => Object.fromEntries((await bootRows("select rolname, rolpassword from pg_authid where rolname like $1", [`${PREFIX}\\_%`])).map((r) => [r.rolname.slice(PREFIX.length + 1), r.rolpassword]));
  const before = await stored();
  assert.ok(Object.values(before).every((hash) => typeof hash === "string" && hash.startsWith("SCRAM-SHA-256$") && !Object.values(PASSWORDS).some((p) => hash.includes(p))), "passwords are stored hashed, never as given");
  await boot({ passwords: changed });
  const afterChange = await stored();
  assert.notEqual(afterChange.gateway, before.gateway);
  const connect = async (url) => { const c = new pg.Client({ connectionString: url }); try { await c.connect(); return "in"; } catch (err) { return err.code; } finally { await c.end().catch(() => undefined); } };
  assert.deepEqual([await connect(loginUrl("gateway", changed.gateway)), await connect(loginUrl("ui"))], ["in", "in"]);
  await boot();
  // weak or shared passwords are refused before anything is touched
  await assert.rejects(boot({ passwords: { ...PASSWORDS, ui: "short" } }), /shorter than 16/);
  await assert.rejects(boot({ passwords: { ...PASSWORDS, ui: PASSWORDS.agent } }), /three different passwords/);
});

test("from the environment: a failed setup stops the start with a fixed message that holds no URL and no password; the server's URLs are built from parts", async () => {
  const env = {
    DATABASE_URL_ADMIN: bootAdmin, WH_TENANT_ID: TENANT, WH_TENANT_SLUG: "fixture-boot", WH_TENANT_NAME: "Fixture Boot", WH_OWNER_NAME: "Fixture Owner", WH_OWNER_EMAIL: "fixture-owner@example.test",
    WH_DB_PASSWORD_AGENT: PASSWORDS.agent, WH_DB_PASSWORD_GATEWAY: PASSWORDS.gateway, WH_DB_PASSWORD_UI: PASSWORDS.ui,
    // so that this test leaves no login behind on the database server it borrows
    WH_DB_ROLE_PREFIX: PREFIX,
  };
  await assert.rejects(bootstrapFromEnv({ WH_TENANT_ID: TENANT }, () => {}), (err) => err.message === `${BOOTSTRAP_FAILED}: not set: DATABASE_URL_ADMIN, WH_DB_PASSWORD_AGENT, WH_DB_PASSWORD_GATEWAY, WH_DB_PASSWORD_UI, WH_OWNER_NAME, WH_OWNER_EMAIL`);
  // the owner's URL leads nowhere: fails loudly, and the message carries neither the URL nor the password in it
  const wrong = new URL(bootAdmin);
  wrong.password = "SECRET-OWNER-PASSWORD-123";
  wrong.port = "1";
  await assert.rejects(bootstrapFromEnv({ ...env, DATABASE_URL_ADMIN: wrong.toString() }, () => {}),
    (err) => err.message.startsWith(`${BOOTSTRAP_FAILED} while setting up the database:`) && !err.message.includes("SECRET-OWNER") && !/postgres(ql)?:\/\//.test(err.message));
  await assert.rejects(bootstrapFromEnv({ ...env, WH_BOOTSTRAP_CONFIG: "%%%" }, () => {}), (err) => err.message.startsWith(`${BOOTSTRAP_FAILED} while reading WH_BOOTSTRAP_CONFIG:`));
  await assert.rejects(bootstrapFromEnv({ ...env, WH_TENANT_ID: "not-a-uuid" }, () => {}), (err) => err.message.startsWith(BOOTSTRAP_FAILED));
  for (const bad of ["4", "three", "23", " "]) await assert.rejects(bootstrapFromEnv({ ...env, WH_ENQUIRY_RUNG: bad }, () => {}), (err) => err.message.startsWith(`${BOOTSTRAP_FAILED} while setting up the database: WH_ENQUIRY_RUNG must be 2`), `"${bad}" is refused loudly`);
  assert.equal(scrub(`could not connect to ${wrong.toString()} with password SECRET-OWNER-PASSWORD-123 or ${PASSWORDS.ui}`, { ...env, DATABASE_URL_ADMIN: wrong.toString() }),
    "could not connect to [database url] with password [secret] or [secret]");
  // and it works, saying what it did in one line with nothing secret in it
  const lines = [];
  const done = await bootstrapFromEnv(env, (line) => lines.push(line));
  assert.equal(done.firstBoot, false);
  assert.deepEqual(lines, ["bootstrap: 0 migrations applied, 3 logins set, tenant ready, not the first boot: configuration left as it is"]);

  // the server's three URLs
  assert.deepEqual(connectionUrls({ DATABASE_HOST: "postgres.railway.internal", DATABASE_PORT: "5433", DATABASE_NAME: "railway", WH_DB_PASSWORD_GATEWAY: "p@ss/word:1", WH_DB_PASSWORD_UI: "fixture-ui", WH_DB_PASSWORD_AGENT: "fixture-agent" }), {
    agent: "postgres://wh_live_agent:fixture-agent@postgres.railway.internal:5433/railway",
    gateway: "postgres://wh_live_gateway:p%40ss%2Fword%3A1@postgres.railway.internal:5433/railway",
    ui: "postgres://wh_live_ui:fixture-ui@postgres.railway.internal:5433/railway",
  });
  assert.deepEqual(connectionUrls({ DATABASE_URL_GATEWAY: "postgres://given", DATABASE_HOST: "h", DATABASE_NAME: "d", WH_DB_PASSWORD_GATEWAY: "x", WH_DB_PASSWORD_UI: "y" }), { gateway: "postgres://given", ui: "postgres://wh_live_ui:y@h:5432/d" }, "a URL given outright wins; a login with no password gets none");
  assert.deepEqual(connectionUrls({}), {});
  assert.deepEqual(connectionUrls({ DATABASE_HOST: "h", DATABASE_NAME: "d", WH_DB_PASSWORD_UI: "y", WH_DB_ROLE_PREFIX: "wh_other" }), { ui: "postgres://wh_other_ui:y@h:5432/d" });

  // what the server process is started with: everything except the owner's way in
  const given = { ...env, WH_BOOTSTRAP: "1", WH_BOOTSTRAP_CONFIG: "abc", DATABASE_URL: bootAdmin, PGPASSWORD: "x", POSTGRES_PASSWORD: "y", MIGRATIONS_DIR: "/opt/x", WH_API_TOKEN: "t", PORT: "8080", NOTHING: undefined };
  delete given.WH_DB_ROLE_PREFIX;
  const child = serverEnv(given);
  for (const name of [...ADMIN_ONLY_ENV, "WH_BOOTSTRAP", "MIGRATIONS_DIR"]) assert.ok(!(name in child), name);
  assert.deepEqual([child.WH_API_TOKEN, child.PORT, child.WH_DB_PASSWORD_GATEWAY, "NOTHING" in child], ["t", "8080", PASSWORDS.gateway, false]);
  assert.ok(ADMIN_ONLY_ENV.includes("DATABASE_URL_ADMIN") && ADMIN_ONLY_ENV.includes("DATABASE_URL"));
});

test("export-config: the configuration in force and the suppressions of businesses, and nothing about people, prospects or messages", async () => {
  const x = await makeHouse(h, { outreach: { budget: 5, settings: { area: "Fixtureshire", areas: ["Fixtureton"], excluded_groups: ["Fixture Group"] } }, server: false });
  open.push(x);
  const ROOM = "fixture-floor-one:outreach";
  await changeOutreachSettings(h.uiDb, x.w.tenantId, ROOM, { dailyAt: "08:00", enquiriesPerDay: 12, allowEnquiries: true });
  await changeOutreachSettings(h.uiDb, x.w.tenantId, ROOM, { enquiriesPerDay: 15 });
  const suppress = (kind, value, reason) => addSuppression(h.uiDb, { tenantId: x.w.tenantId, businessId: null, kind, value, reason, memberId: x.w.ownerId });
  await suppress("domain", "fixture-quiet.example.test", "asked not to be contacted");
  await suppress("company_number", "01234567", "a client already");
  await suppress("email", "fixture-person@example.test", "PERSONAL-REASON");
  await x.runtime.setKillSwitch({ on: false });
  const { blob: out, leftOut } = await exportConfig(h.gatewayDb, x.w.tenantId, new Date("2026-11-17T09:00:00Z"));
  assert.deepEqual([out.version, out.exported_at, leftOut], [1, "2026-11-17T09:00:00.000Z", 1]);
  const find = (kind, key) => out.config.find((c) => c.business === "fixture-floor-one" && c.kind === kind && c.key === key)?.value;
  assert.deepEqual([find("setting", "outreach").areas, find("setting", "outreach").business_types.find((t) => t.id === "clinics").excluded_groups, find("schedule", "outreach").daily_at, find("cap", ENQUIRY_CAP), find("rung", ENQUIRY_ACTION), find("budget", "outreach")],
    [["Fixtureton"], ["Fixture Group"], "08:00", { limit: 15 }, { rung: 2 }, { daily_limit_gbp: 5 }], "the latest version of each, not its history");
  assert.deepEqual([...new Set(out.config.map((c) => c.kind))].sort(), ["budget", "cap", "rung", "schedule", "setting"], "no kill switch, no targets");
  assert.deepEqual(out.suppressions.map((s) => [s.kind, s.value_key, s.reason]), [["company_number", "01234567", "a client already"], ["domain", "fixture-quiet.example.test", "asked not to be contacted"]]);
  const text = JSON.stringify(out);
  for (const gone of ["@", "PERSONAL-REASON", "fixture-person", x.w.tenantId, x.w.ownerId, "Fixture owner"]) assert.ok(!text.includes(gone), gone);
  assert.deepEqual(Object.keys(out).sort(), ["config", "exported_at", "suppressions", "version"]);
  // it is exactly what the bootstrap accepts (the test world's own dummy action aside, which the real runner does not have)
  const forServer = { ...out, config: out.config.filter((c) => !(c.kind === "rung" && c.key.startsWith("dummy."))) };
  assert.equal(parseCarriedConfig(encode(forServer)).config.length, forServer.config.length);
});

// ---- a restart in the middle of a run ----

test("a run left running by a process that died is closed at start as interrupted, the room is no longer stuck, and a pipeline run is started again once", async () => {
  const x = await makeHouse(h, { outreach: { budget: 5 }, server: true });
  open.push(x);
  const begin = (department, trigger) => control.startRun(h.gatewayDb, { tenantId: x.w.tenantId, businessId: x.w.businessId, department, trigger, model: "claude-haiku-5-5" }, { now: x.w.clock.now() });
  // as the dead process left it: an outreach run part way through analysing, and a Data run
  const outreach = await begin("outreach", "outreach:analyse");
  const data = await begin("data", "requested");
  await h.gatewayDb.tx(x.w.tenantId, (tx) => control.emitEvent(tx, { tenantId: x.w.tenantId, businessId: x.w.businessId, department: "outreach", runId: outreach.runId, type: "stage", summary: "Analysing 31 of 47", reasonCode: "analyse", now: x.w.clock.now() }));
  const [waiting] = await rows(h, "insert into prospects (tenant_id, business_id, name, domain_key) values ($1, $2, 'Fixture Midway Dental', 'fixture-midway.example.test') returning prospect_id", [x.w.tenantId, x.w.businessId]);
  x.w.clock.advance(1000);
  assert.deepEqual([(await x.roomOf("fixture-floor-one:outreach")).state, (await x.roomOf("fixture-floor-one:outreach")).task], ["working", "Analysing 31 of 47"], "stuck, as it was on the server");

  const cut = await x.runtime.closeInterrupted();
  assert.deepEqual(cut, { closed: 2, restart: ["fixture-floor-one:outreach"] }, "both are closed; only the pipeline run is one to start again");
  assert.deepEqual((await rows(h, "select department, status, error, ended_at is not null as ended from runs where tenant_id = $1 order by department", [x.w.tenantId])).map((r) => [r.department, r.status, r.error, r.ended]),
    [["data", "failed", "interrupted_by_restart", true], ["outreach", "failed", "interrupted_by_restart", true]]);
  const events = await control.listEvents(h.gatewayDb, { tenantId: x.w.tenantId });
  assert.deepEqual(events.filter((e) => e.reasonCode === "interrupted_by_restart").map((e) => [e.type, e.summary]), Array(2).fill(["failed", "The run was cut off by a restart of the server and has been closed"]));
  x.w.clock.advance(1000);
  assert.notEqual((await x.roomOf("fixture-floor-one:outreach")).state, "working");
  // the business that was mid-analysis is still to be analysed, with nothing held against it
  assert.deepEqual((await rows(h, "select stage, analysis_attempts from prospects where prospect_id = $1", [waiting.prospect_id]))[0], { stage: "found", analysis_attempts: 0 });
  // nothing is running now: a second call does nothing, and the room can be started again
  assert.deepEqual(await x.runtime.closeInterrupted(), { closed: 0, restart: [] });
  // it falls over again the same day: the run is closed, but it is not started a second time (no loop)
  await begin("outreach", "outreach:find");
  assert.deepEqual(await x.runtime.closeInterrupted(), { closed: 1, restart: [] });
  // the next day it would be
  x.w.clock.advance(24 * 60 * 60 * 1000);
  await begin("outreach", "outreach:find");
  assert.deepEqual(await x.runtime.closeInterrupted(), { closed: 1, restart: ["fixture-floor-one:outreach"] });
  // a standby touches nothing
  const idle = await makeHouse(h, { outreach: { budget: 5 }, role: "standby", server: false });
  open.push(idle);
  await control.startRun(h.gatewayDb, { tenantId: idle.w.tenantId, businessId: idle.w.businessId, department: "outreach", trigger: "outreach:find", model: "claude-haiku-5-5" }, { now: idle.w.clock.now() });
  assert.deepEqual(await idle.runtime.closeInterrupted(), { closed: 0, restart: [] });
});

// ---- one mailbox, one owner ----

test("a standby starts no run, sends nothing and never looks in the mailbox; it still shows the house", async () => {
  const touched = [];
  const mailbox = {
    address: "fixture-test-mailbox@example.test",
    send: async () => { touched.push("send"); return { messageId: "<x@fixture>" }; },
    sentContains: async () => { touched.push("sent"); return true; },
    findReplies: async () => { touched.push("find"); return []; },
  };
  const x = await makeHouse(h, { outreach: { budget: 5 }, role: "standby", mailbox, server: true });
  open.push(x);
  for (const room of ["fixture-floor-one:outreach", "fixture-floor-one:data", "fixture-floor-one:research"]) {
    assert.deepEqual(await x.runtime.startRun(room, { brief: "fixture brief" }), { status: 409, reason: "standby" }, room);
  }
  const viaApi = await x.call("POST", "/v1/rooms/fixture-floor-one:data/run", {});
  assert.deepEqual([viaApi.status, viaApi.body], [409, { reason: "standby" }]);
  assert.equal(await x.runtime.collectReplies(), null);
  // an enquiry waiting for a yes (made by the primary, in a shared database, say): the standby does not take the yes
  const payload = { enquiry_id: "00000000-0000-4000-8000-000000000001", prospect_id: "00000000-0000-4000-8000-000000000002", to: "hello@fixture.example.test", subject: "s", body: "b" };
  await control.setConfig(h.uiDb, { tenantId: x.w.tenantId, businessId: x.w.businessId, kind: "cap", key: ENQUIRY_CAP, value: { limit: 5 }, memberId: x.w.ownerId, reason: "test fixture" });
  await control.promoteRung(h.uiDb, control.actionTypes, { tenantId: x.w.tenantId, businessId: x.w.businessId, actionType: ENQUIRY_ACTION, memberId: x.w.ownerId, reason: "test fixture" });
  const waiting = await x.runtime.gateway.submit({ tenantId: x.w.tenantId, businessId: x.w.businessId, department: "outreach", actionType: ENQUIRY_ACTION, actionKey: "fixture-standby", payload, reason: "Test enquiry by email" });
  assert.equal(waiting.outcome, "waiting_approval");
  assert.deepEqual(await x.runtime.answerApproval(waiting.approvalId, { decision: "approve", payloadHash: waiting.payloadHash }), { status: 409, reason: "standby" });
  assert.deepEqual((await x.runtime.decideBatch({ decisions: [{ id: waiting.approvalId, decision: "approve", payloadHash: waiting.payloadHash }] })).results, [{ id: waiting.approvalId, status: "invalid", reason: "standby" }]);
  assert.deepEqual(await rows(h, "select status from approvals where approval_id = $1", [waiting.approvalId]), [{ status: "pending" }]);
  // Even an enquiry that needs no yes (rung 3) and is put straight to the gateway cannot go: a standby does not hold the mailbox at all.
  await control.promoteRung(h.uiDb, control.actionTypes, { tenantId: x.w.tenantId, businessId: x.w.businessId, actionType: ENQUIRY_ACTION, memberId: x.w.ownerId, reason: "test fixture" });
  const [{ prospect_id: prospectId }] = await rows(h, "insert into prospects (tenant_id, business_id, name, domain_key) values ($1, $2, 'Fixture Standby Dental', 'fixture-standby.example.test') returning prospect_id", [x.w.tenantId, x.w.businessId]);
  const [{ enquiry_id: enquiryId }] = await rows(h, "insert into enquiries (tenant_id, business_id, prospect_id, to_address, to_address_key, subject, body) values ($1, $2, $3, $4, $4, 's', 'b') returning enquiry_id", [x.w.tenantId, x.w.businessId, prospectId, "hello@fixture-standby.example.test"]);
  const direct = await x.runtime.gateway.submit({ tenantId: x.w.tenantId, businessId: x.w.businessId, department: "outreach", actionType: ENQUIRY_ACTION, actionKey: "fixture-standby-rung-3",
    payload: { enquiry_id: enquiryId, prospect_id: prospectId, to: "hello@fixture-standby.example.test", subject: "s", body: "b" }, reason: "Test enquiry by email" });
  assert.equal(direct.outcome, "execution_failed");
  assert.deepEqual(await rows(h, "select status from enquiries where enquiry_id = $1", [enquiryId]), [{ status: "proposed" }]);
  await x.runtime.idle();
  assert.deepEqual(touched, [], "the mailbox was never touched");
  assert.deepEqual(await rows(h, "select 1 from runs where tenant_id = $1", [x.w.tenantId]), []);
  // it still answers the house and the health check
  assert.equal((await x.call("GET", "/v1/house")).status, 200);
  // the default is primary: the same trigger is accepted there
  const primary = await makeHouse(h, { server: false });
  open.push(primary);
  assert.equal((await primary.runtime.startRun("fixture-floor-one:data", {})).status, 202);
  await primary.runtime.idle();
});

// ---- no search tool on the server ----

test("with no search tool installed the connector is 'not configured' for every action, and a run still finds by Places, reads directly and proposes enquiries, saying so once", async () => {
  assert.equal(agentReachFromEnv(undefined), null);
  assert.equal(agentReachFromEnv(""), null);
  assert.equal(agentReachFromEnv("/fixture/no/such/agent-reach"), null, "a path with nothing at it is the same as none");
  const none = notConfiguredReach();
  for (const call of [() => none.webSearch("q", 5), () => none.webRead("https://fixture.example.test/"), () => none.jobs("q", "Fixtureton", 5), () => none.jobRead("https://www.linkedin.com/jobs/view/1")]) {
    await assert.rejects(call(), (err) => err.code === "reach_not_configured");
  }

  const words = "A fixture family practice offering general, cosmetic and implant dentistry, with early and late appointments on weekdays. ".repeat(2);
  const pages = (key) => ({
    "/": `<html><body><nav><a href="/contact-us">Contact</a></nav><h1>Fixture ${key} Dental</h1><p>Fixture implants in Fixtureton. ${words}</p></body></html>`,
    "/contact-us": `<html><body><h1>Contact</h1><p><a href="mailto:hello@fixture-${key}.example.test">Email us</a>. Principal dentist: Kim Fixture-${key}. ${words}</p></body></html>`,
  });
  const reader = {
    allowedByRobots: (url, robots) => robotsAllow(robots, url, DIRECT_READ_AGENT), robots: async () => null, sitemap: async () => [],
    read: async (url) => { const u = new URL(url); const key = /fixture-(\w+)\./.exec(u.hostname)[1]; return { url, ...toText(pages(key)[u.pathname] ?? "", url) }; },
  };
  const place = (key) => toPlace({ id: `place-${key}`, displayName: { text: `Fixture ${key} Dental` }, formattedAddress: `1 Fixture Street, Fixtureton B${key.length} ${key.length}AA, UK`, businessStatus: "OPERATIONAL", websiteUri: `https://fixture-${key}.example.test/` });
  const requests = [];
  const model = createScriptedModel(async (request) => {
    requests.push(request.stage);
    const usage = { inputTokens: 100, outputTokens: 50 };
    if (request.stage === "enquiry") return { data: { subject: "Price of fixture implants", body: "Hello,\n\nCould you tell me the price of fixture implants, and when the next consultation is available?\n\nThank you,\nSalekh" }, costUsd: 0.01, usage };
    if (request.stage === "analyse") {
      const nothing = { value: null, page: null };
      const person = /Principal dentist: (Kim Fixture-\w+)/.exec(request.user)[1];
      return { data: asModelAnswer({ is_match: true, what_they_sell: { value: "Fixture dentistry", page: 1 }, highest_value_service: { value: "Fixture implants", page: 1 }, highest_value_price: nothing, staff_count: nothing,
        locations: nothing, opening_hours: nothing, part_of_group: nothing, legal_form: nothing, reviews: { count: null, rating: null, page: null }, contact_person: { name: person, role: "Principal dentist", page: 2 }, signals: [] }), costUsd: 0.01, usage };
    }
    throw new Error(`fixture: no model call was expected at ${request.stage}`);
  });
  const mailbox = { address: "fixture-test-mailbox@example.test", send: async () => ({ messageId: "<x@fixture>" }), sentContains: async () => true, findReplies: async () => [] };
  const settings = { area: "Fixtureshire", areas: ["Fixtureton"], areas_per_run: 1, min_seconds_between_fetches: 0, business_types: [{ id: "clinics" }], enquiry_slots: ["in_hours"] };
  const x = await makeHouse(h, { outreach: { budget: 5, settings }, model, reach: null, places: { searchText: async () => ({ places: [place("kappa"), place("sigma")], nextPageToken: null }) }, directReader: reader, mailbox, server: false, sleep: async () => {} });
  open.push(x);
  await control.setConfig(h.uiDb, { tenantId: x.w.tenantId, businessId: x.w.businessId, kind: "cap", key: ENQUIRY_CAP, value: { limit: 30 }, memberId: x.w.ownerId, reason: "test fixture" });
  await control.promoteRung(h.uiDb, control.actionTypes, { tenantId: x.w.tenantId, businessId: x.w.businessId, actionType: ENQUIRY_ACTION, memberId: x.w.ownerId, reason: "test fixture" });
  assert.equal((await x.runtime.startRun("fixture-floor-one:outreach", {})).status, 202);
  await x.runtime.idle();

  assert.deepEqual((await rows(h, "select name, stage from prospects where tenant_id = $1 order by name", [x.w.tenantId])).map((p) => [p.name, p.stage]), [["Fixture kappa Dental", "analysed"], ["Fixture sigma Dental", "analysed"]]);
  assert.equal((await rows(h, "select 1 from enquiries where tenant_id = $1 and status = 'proposed'", [x.w.tenantId])).length, 2);
  assert.ok(!requests.includes("find"), "no advert search, so no call to classify adverts");
  const [out] = await rows(h, "select body, data from outputs where tenant_id = $1", [x.w.tenantId]);
  assert.equal(out.body.split("Job adverts are not searched on this server").length, 2, "said once");
  for (const gone of ["This run was cut short", "signed in session", "paused by the source", "reported a rate limit", "only partly searched"]) assert.ok(!out.body.includes(gone), gone);
  assert.deepEqual([out.data.cut_short, out.data.fetches.fetched > 0, out.data.tally.analysed], [[], true, 2]);
  const events = await control.listEvents(h.gatewayDb, { tenantId: x.w.tenantId });
  assert.ok(!events.some((e) => ["rate_limited", "source_unavailable", "source_paused", "source_refused"].includes(e.reasonCode)), "the missing tool is not reported as a fault, action by action");
  assert.ok((await rows(h, "select status, error from runs where tenant_id = $1", [x.w.tenantId])).every((r) => r.status === "done" && r.error === null));

  // without Places or the direct reader there is nothing to work with, and the run says so as before
  const bare = await makeHouse(h, { outreach: { budget: 5, settings }, model, reach: null, server: false });
  open.push(bare);
  await bare.runtime.startRun("fixture-floor-one:outreach", {});
  await bare.runtime.idle();
  assert.deepEqual((await rows(h, "select status, error from runs where tenant_id = $1", [bare.w.tenantId])).map((r) => [r.status, r.error]), [["failed", "search_not_configured"]]);
});

// ---- the API on a public address ----

const ROUTES = [
  ["GET", "/v1/house"], ["GET", "/v1/outputs/00000000-0000-4000-8000-000000000001"], ["POST", "/v1/outputs/00000000-0000-4000-8000-000000000001/score"],
  ["GET", "/v1/rooms/fixture-floor-one:data/approvals"], ["POST", "/v1/approvals/00000000-0000-4000-8000-000000000001"], ["POST", "/v1/approvals/batch"],
  ["POST", "/v1/kill-switch"], ["POST", "/v1/rooms/fixture-floor-one:data/run"], ["POST", "/v1/rooms/fixture-floor-one:data/acknowledge"], ["POST", "/v1/ask"],
  ["GET", "/v1/"], ["GET", "/v1/anything/else"], ["DELETE", "/v1/house"], ["PUT", "/v1/kill-switch"],
];

test("every route but the health check needs the token; the health check says ok and nothing else; nothing a caller sends reaches the log", async () => {
  const x = await makeHouse(h, { server: true });
  open.push(x);
  const call = (method, route, headers = {}) => fetch(`${x.base}${route}`, { method, headers: { "content-type": "application/json", ...headers }, ...(method === "GET" ? {} : { body: "{}" }) });

  const health = await call("GET", "/health");
  assert.deepEqual([health.status, await health.json()], [200, { status: "ok" }]);
  for (const [method, route] of [["GET", "/"], ["GET", "/healthz"], ["POST", "/health"], ["GET", "/house"], ["GET", "/v2/house"], ["GET", "/%"]]) assert.equal((await call(method, route)).status, 404, `${method} ${route}`);

  // no token, each route: 401, and the state of the house is untouched
  for (const [method, route] of ROUTES.slice(0, 9)) {
    const res = await call(method, route);
    assert.deepEqual([res.status, await res.json()], [401, { error: "unauthorised" }], `${method} ${route}`);
  }
  assert.deepEqual(await rows(h, "select 1 from runs where tenant_id = $1", [x.w.tenantId]), []);
  assert.deepEqual(await rows(h, "select 1 from config_versions where tenant_id = $1 and kind = 'kill_switch'", [x.w.tenantId]), []);
  // with the token, every one of them is reached (whatever it then answers, it is not 401)
  for (const [method, route] of ROUTES) assert.notEqual((await call(method, route, { authorization: `Bearer ${TEST_TOKEN}` })).status, 401, `${method} ${route}`);

  // wrong tokens of every shape, on a server of their own so the count of failures starts at nought
  const fresh = createRunnerServer({ runtime: x.runtime, token: TEST_TOKEN });
  await new Promise((resolve) => fresh.listen(0, "127.0.0.1", resolve));
  open.push({ close: () => new Promise((resolve) => { fresh.close(resolve); fresh.closeAllConnections(); }) });
  const base = `http://127.0.0.1:${fresh.address().port}`;
  const wrong = [undefined, "", "Bearer", "Bearer ", `Bearer ${TEST_TOKEN}x`, `Bearer ${TEST_TOKEN.slice(0, -1)}`, `bearer ${TEST_TOKEN}`, `Basic ${TEST_TOKEN}`, TEST_TOKEN, `Bearer  ${TEST_TOKEN}`];
  for (const authorization of wrong) {
    const res = await fetch(`${base}/v1/house`, { headers: authorization === undefined ? {} : { authorization } });
    assert.equal(res.status, 401, JSON.stringify(authorization));
  }
  // ten failures from one address: the eleventh is told to wait, and the right token still gets through
  const eleventh = await fetch(`${base}/v1/house`);
  assert.deepEqual([eleventh.status, await eleventh.json(), eleventh.headers.get("retry-after")], [429, { error: "too_many_attempts" }, "300"]);
  assert.equal((await fetch(`${base}/v1/house`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } })).status, 200, "the site's own server is never locked out by somebody else's guessing");
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("failed attempts are counted per caller, by the proxy's header only when that is switched on, and forgotten after the window; an error's own words never reach the log", async () => {
  let now = 1_000_000;
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args.join(" ")); };
  try {
    const runtime = { house: async () => { throw new Error("SECRET-ERROR-TEXT with fixture-person@example.test"); } };
    const make = async (trustProxy) => {
      const server = createRunnerServer({ runtime, token: TEST_TOKEN, trustProxy, now: () => now });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      open.push({ close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) });
      return `http://127.0.0.1:${server.address().port}`;
    };
    const proxied = await make(true);
    const from = (base, address, token) => fetch(`${base}/v1/house`, { headers: { "x-forwarded-for": `${address}, 10.0.0.1`, ...(token ? { authorization: `Bearer ${token}` } : {}) } }).then((r) => r.status);
    for (let i = 0; i < 10; i += 1) assert.equal(await from(proxied, "203.0.113.5"), 401);
    assert.equal(await from(proxied, "203.0.113.5"), 429);
    assert.equal(await from(proxied, "203.0.113.6"), 401, "another caller is not affected");
    now += 5 * 60_000 + 1;
    assert.equal(await from(proxied, "203.0.113.5"), 401, "after the window the count starts again");
    // without the switch the header is ignored: a caller cannot dodge the count by inventing addresses
    const direct = await make(false);
    for (let i = 0; i < 10; i += 1) assert.equal(await from(direct, `198.51.100.${i}`), 401);
    assert.equal(await from(direct, "198.51.100.99"), 429);

    // a route that throws: 500 with a fixed body, and a log line with the route's first word and the error's kind only
    const res = await fetch(`${proxied}/v1/house?secret=SECRET-QUERY`, { headers: { authorization: `Bearer ${TEST_TOKEN}`, "x-forwarded-for": "203.0.113.77" } });
    assert.deepEqual([res.status, await res.json()], [500, { error: "internal_error" }]);
    assert.deepEqual(logged, ["GET /v1/house failed: Error"]);
  } finally {
    console.error = original;
  }
});

// ---- time ----

test("the daily run is at 08:00 in London whatever the machine's own clock says, on both sides of both clock changes", async () => {
  assert.equal(new Date("2027-03-27T12:00:00Z").getTimezoneOffset(), -840, "this test really is running fourteen hours ahead of London");
  const clock = makeClock(new Date("2027-03-27T07:59:00Z"));
  const x = await makeHouse(h, { outreach: { budget: 5 }, clock, server: false });
  open.push(x);
  await changeOutreachSettings(h.uiDb, x.w.tenantId, "fixture-floor-one:outreach", { dailyAt: "08:00" });
  const started = [];
  const scheduler = createScheduler({ db: h.gatewayDb, tenantId: x.w.tenantId, now: clock.now, startRun: async (roomId) => { started.push(`${roomId} at ${clock.now().toISOString()}`); return { status: 202, runId: undefined }; } });
  const at = async (iso) => { clock.advance(new Date(iso).getTime() - clock.now().getTime()); return (await scheduler.tick()).map((r) => r.outcome); };

  // Saturday 27 March 2027, winter time: London is on UTC
  assert.deepEqual(await at("2027-03-27T07:59:00Z"), []);
  assert.deepEqual(await at("2027-03-27T08:00:00Z"), ["started"]);
  assert.deepEqual(await at("2027-03-27T20:00:00Z"), [], "once a day");
  // Sunday 28 March: the clocks went forward at 01:00 UTC, so 08:00 in London is 07:00 UTC
  assert.deepEqual(await at("2027-03-28T06:59:00Z"), []);
  assert.deepEqual(await at("2027-03-28T07:00:00Z"), ["started"]);
  // Saturday 30 October, still summer time
  assert.deepEqual(await at("2027-10-30T06:59:00Z"), []);
  assert.deepEqual(await at("2027-10-30T07:00:00Z"), ["started"]);
  // Sunday 31 October: the clocks went back, so 08:00 in London is 08:00 UTC again
  assert.deepEqual(await at("2027-10-31T07:00:00Z"), [], "07:00 UTC is only 07:00 in London now");
  assert.deepEqual(await at("2027-10-31T07:59:00Z"), []);
  assert.deepEqual(await at("2027-10-31T08:00:00Z"), ["started"]);
  assert.deepEqual(started.map((s) => s.split(" at ")[1]), ["2027-03-27T08:00:00.000Z", "2027-03-28T07:00:00.000Z", "2027-10-30T07:00:00.000Z", "2027-10-31T08:00:00.000Z"]);
  // one "due" mark per London day, none doubled across the change
  const days = await rows(h, "select (created_at at time zone 'Europe/London')::date::text as day from events where tenant_id = $1 and type = 'scheduled' and reason_code = 'due' order by 1", [x.w.tenantId]);
  assert.deepEqual(days.map((d) => d.day), ["2027-03-27", "2027-03-28", "2027-10-30", "2027-10-31"]);
});
