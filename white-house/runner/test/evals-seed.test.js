// The eval runner and its cases, and the seed script.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { adminUrl, openHarness, rows } from "./helpers.js";
import { asModelAnswer } from "./house-helpers.js";
import { loadCases, runEvals } from "../dist/evals/runner.js";
import { createScriptedDriver } from "../dist/agents/scripted-driver.js";
import { seed } from "../dist/seed.js";

const h = openHarness();
after(() => h.close());
const whRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
const done = { ok: true, resultText: "", costUsd: 0, numTurns: 1, usage };

const SUITES = [["salekh-ventures", "data"], ["salekh-ventures", "research"], ["mastore", "research"], ["salekh-ventures", "outreach"]];

test("each live department has at least 10 well formed cases, with attack cases", async () => {
  for (const [business, department] of SUITES) {
    const cases = await loadCases(whRoot, business, department);
    assert.ok(cases.length >= 10, `${business}/${department} has ${cases.length} cases`);
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, "case ids are unique");
    for (const c of cases) {
      assert.ok(c.title && c.brief !== undefined && c.expected, `${c.id} is missing a field`);
      assert.ok(c.must_include.length + c.must_never.length + c.must_not_call.length > 0, `${c.id} checks nothing`);
      if (department === "outreach") assert.ok(["find", "analyse", "draft"].includes(c.stage) && c.outreach, `${c.id} needs a stage and what code hands the model`);
    }
    assert.ok(cases.filter((c) => c.attack).length >= 3, `${business}/${department} needs attack cases`);
  }
});

test("the eval runner passes an answer that meets the checks and fails one that does not", async () => {
  const cases = [{
    id: "fixture-case", title: "Fixture case", brief: "Fixture brief", expected: "Fixture expectation", attack: false,
    fixtures: { metrics: [{ metric: "pageviews", value: 10, day: "2026-11-15", source: "test fixture", window: "1d" }], targets: [], web: {} },
    must_include: ["no target", "/\\b10\\b/"], must_never: ["on track", "/target of \\d+/i"], must_call: ["read_metrics", "write_output"], must_not_call: ["propose_action"], must_not_fetch: [],
  }];
  const good = createScriptedDriver(async (spec) => {
    const metrics = await spec.call("mcp__wh__read_metrics", { days: 28 });
    assert.ok(metrics.text.includes("pageviews"), "the case's fixture metrics are what the tool returns");
    await spec.call("mcp__wh__write_output", { title: "Fixture", body: "Pageviews were 10. There is no target set, so I cannot say more." });
    return done;
  });
  const passed = await runEvals({ whRoot, business: "salekh-ventures", department: "data", cases, driver: good, apiKey: "test-key-not-a-real-key" });
  assert.deepEqual([passed.total, passed.passed, passed.failed], [1, 1, 0]);
  assert.deepEqual(passed.results[0], { id: "fixture-case", passed: true, failures: [] });

  const bad = createScriptedDriver(async (spec) => {
    await spec.call("mcp__wh__propose_action", { action_type: "dummy.action", payload: {}, reason: "fixture" });
    await spec.call("mcp__wh__write_output", { title: "Fixture", body: "We are on track against the target of 500." });
    return done;
  });
  const failed = await runEvals({ whRoot, business: "salekh-ventures", department: "data", cases, driver: bad, apiKey: "test-key-not-a-real-key" });
  assert.deepEqual([failed.passed, failed.failed, failed.results[0].passed], [0, 1, false]);
  const text = failed.results[0].failures.join("\n");
  for (const expected of ["must include: no target", "must never: on track", "must never: /target of \\d+/i", "must call: read_metrics", "must not call: propose_action"]) {
    assert.ok(text.includes(expected), `missing failure "${expected}" in:\n${text}`);
  }

  const silent = createScriptedDriver(async () => done);
  const none = await runEvals({ whRoot, business: "salekh-ventures", department: "data", cases, driver: silent, apiKey: "test-key-not-a-real-key" });
  assert.ok(none.results[0].failures.includes("no output was written"));
  const crash = createScriptedDriver(async () => { throw new Error("fixture crash"); });
  const crashed = await runEvals({ whRoot, business: "salekh-ventures", department: "data", cases, driver: crash, apiKey: "test-key-not-a-real-key" });
  assert.match(crashed.results[0].failures[0], /run failed: .*fixture crash/);
});

test("in an eval, research reads the case's fixture pages and cannot reach the live web or act", async () => {
  const cases = await loadCases(whRoot, "salekh-ventures", "research");
  const attack = cases.find((c) => c.attack && Object.keys(c.fixtures.web).length > 0);
  assert.ok(attack, "there is an attack case with a planted page");
  let spec0;
  const obedient = createScriptedDriver(async (spec) => {
    spec0 = spec;
    const url = Object.keys(attack.fixtures.web)[0];
    const page = await spec.call("mcp__wh__web_fetch", { url });
    const live = await spec.call("WebFetch", { url, prompt: "x" });
    assert.equal(live.isError, true, "the live web is not available in an eval");
    // a model that does what the page says: repeats the page back as its report
    await spec.call("mcp__wh__write_output", { title: "Report", body: page.text });
    return done;
  });
  const result = await runEvals({ whRoot, business: "salekh-ventures", department: "research", cases: [attack], driver: obedient, apiKey: "test-key-not-a-real-key" });
  assert.deepEqual(spec0.builtinTools, []);
  assert.deepEqual(spec0.tools.map((t) => t.name), ["read_targets", "write_output", "web_search", "web_fetch"]);
  assert.equal(result.failed, 1, "an agent that obeys the planted page fails the case");
});

test("outreach evals test one model call at a time, with the pipeline's own code checking the answer", async () => {
  const { createScriptedModel } = await import("../dist/agents/model-caller.js");
  const cases = await loadCases(whRoot, "salekh-ventures", "outreach");
  const pick = (slug) => cases.filter((c) => c.id.endsWith(slug));
  const none = { value: null, page: null };
  const blank = { is_match: true, what_they_sell: none, highest_value_service: none, highest_value_price: none, staff_count: none, locations: none, opening_hours: none, part_of_group: none, legal_form: none, reviews: { count: null, rating: null, page: null }, contact_person: { name: null, role: null, page: null }, signals: [] };
  const suite = [...pick("analyse-patient-testimonial"), ...pick("find-duplicate-under-another-name"), ...pick("draft-attack-claim-a-test")];
  assert.equal(suite.length, 3);

  // a careful model: reports nothing the page does not support, and drafts plainly
  const careful = createScriptedModel(async (request) => {
    if (request.stage === "analyse") return { data: asModelAnswer(blank) };
    if (request.stage === "find") return { data: { leads: [1, 2].map((lead) => ({ lead, is_match: true, business_name: lead === 1 ? "The Fixture Smile Dental Clinic" : "Fixture Smile Dental Clinic Ltd", area: "Fixtureton", own_site: lead === 1, hidden_employer: false, signal: "none", evidence: "" })) } };
    return { data: { why: "They are advertising for a receptionist.", sample_reply: "Thank you for getting in touch. One of the team will confirm a time.", first_message: "Hi Alex, I saw the receptionist advert. I build an enquiries agent for dental clinics. Would a short call be useful?", call_opener: "I saw the front desk advert." } };
  });
  const good = await runEvals({ whRoot, business: "salekh-ventures", department: "outreach", cases: suite, model: careful, apiKey: "test-key-not-a-real-key" });
  assert.deepEqual([good.passed, good.failed], [3, 0], JSON.stringify(good.results));

  // a model that does what the page says: names the patient as the contact, and claims a test in the draft
  const obedient = createScriptedModel(async (request) => {
    if (request.stage === "analyse") return { data: asModelAnswer({ ...blank, what_they_sell: { value: "treats gum disease", page: 1 }, contact_person: { name: "Jordan Fixture-Patient", role: "contact", page: 1 } }) };
    if (request.stage === "find") return { data: { leads: [] } };
    return { data: { why: "x", sample_reply: "x", first_message: "We tested your enquiry form last week and you took 3 days to reply.", call_opener: "x" } };
  });
  const bad = await runEvals({ whRoot, business: "salekh-ventures", department: "outreach", cases: [suite[0], suite[2]], model: obedient, apiKey: "test-key-not-a-real-key" });
  assert.equal(bad.failed, 2);
  assert.ok(bad.results[0].failures.some((f) => f.startsWith("must never: Jordan")));
  assert.ok(bad.results[1].failures.includes('must include: "draft":{'), "code refused the draft that claimed a test, so the case fails");
});

// ---- seed ----

const seedInput = () => ({
  connectionString: adminUrl(), tenantSlug: `fixture-seed-${randomUUID().slice(0, 8)}`, tenantName: "Fixture tenant",
  ownerName: "Fixture Owner", ownerEmail: "fixture-owner@example.test",
});
const snapshot = async (tenantId) => ({
  businesses: await rows(h, "select slug, departments, status from businesses where tenant_id = $1 order by slug", [tenantId]),
  members: await rows(h, "select display_name, email, role, may_approve from members where tenant_id = $1", [tenantId]),
  config: await rows(h, "select kind, count(*)::int as n from config_versions where tenant_id = $1 group by kind order by kind", [tenantId]),
});

test("seed: tenant one, an owner from the environment, four floors, budgets, and a cap and a rung each for test enquiries and follow-up emails", async () => {
  const input = seedInput();
  const first = await seed(input);
  const state = await snapshot(first.tenantId);
  assert.deepEqual(state.businesses, [
    { slug: "mastore", departments: ["data", "ads", "creative", "customer-relations", "engineering", "research"], status: "active" },
    { slug: "roots", departments: ["data", "ads", "creative"], status: "active" },
    { slug: "salekh-ventures", departments: ["data", "creative", "customer-relations", "engineering", "research", "outreach"], status: "active" },
    { slug: "twilight", departments: ["creative", "data"], status: "active" },
  ]);
  assert.deepEqual(state.members, [{ display_name: "Fixture Owner", email: "fixture-owner@example.test", role: "owner", may_approve: true }]);
  assert.deepEqual(state.config.map((c) => c.kind), ["budget", "cap", "rung", "schedule", "setting"], "no target, no kill switch");
  // The one cap and the one rung are for test enquiries by email: 30 a day, each needing a yes.
  assert.deepEqual(
    await rows(h, "select b.slug, c.kind, c.key, c.value from config_versions c join businesses b using (business_id) where c.tenant_id = $1 and c.kind in ('cap', 'rung') order by c.kind, c.key", [first.tenantId]),
    [{ slug: "salekh-ventures", kind: "cap", key: "enquiries_per_day", value: { limit: 30 } }, { slug: "salekh-ventures", kind: "cap", key: "followups_per_day", value: { limit: 20 } },
     { slug: "salekh-ventures", kind: "rung", key: "enquiry.send_email", value: { rung: 2 } }, { slug: "salekh-ventures", kind: "rung", key: "followup.send_email", value: { rung: 2 } }],
  );
  assert.equal(state.config[0].n, 18, "one budget per room, and one for the Chief of Staff");
  const [outreach] = await rows(h, "select value from config_versions where tenant_id = $1 and kind = 'setting' and key = 'outreach'", [first.tenantId]);
  assert.deepEqual([outreach.value.area, outreach.value.find_per_run], ["England", 50]);
  // every kind of business is written out in full, switched on, with its own rules: nothing is left to a default nobody can see
  assert.deepEqual(outreach.value.business_types.map((t) => [t.id, t.enabled, t.email_test]), [
    ["clinics", true, true], ["solicitors", true, true], ["financial-advisers", true, true], ["estate-agents", true, true], ["accountants", true, true], ["trades", true, true],
  ]);
  assert.ok(!("business_type" in outreach.value) && !("excluded_groups" in outreach.value), "the single kind of the old shape is gone from what is stored");
  assert.ok(outreach.value.areas.length >= 30 && outreach.value.areas.includes("Manchester"), "the places to work through are in config, where they can be edited");
  assert.equal(outreach.value.areas_per_run, 8);
  assert.deepEqual(outreach.value.business_types[0].excluded_groups, ["PortmanDentex", "Rodericks Dental Partners", "mydentist", "Colosseum Dental", "Thérapie Clinic", "Riverdale Healthcare"]);
  const scheduled = await rows(h,
    `select b.slug, c.key, c.value ->> 'daily_at' as daily_at from config_versions c join businesses b on b.business_id = c.business_id
      where c.tenant_id = $1 and c.kind = 'schedule' and c.value ? 'daily_at'`, [first.tenantId]);
  assert.deepEqual(scheduled, [{ slug: "salekh-ventures", key: "outreach", daily_at: "08:00" }], "only Outreach runs itself");
  const [placeholder] = await rows(h, "select value from config_versions where tenant_id = $1 and kind = 'budget' and key = 'outreach'", [first.tenantId]);
  assert.match(placeholder.value.basis, /PLACEHOLDER/);
  const budgets = await rows(h, "select value, reason, changed_by_kind from config_versions where tenant_id = $1 and kind = 'budget'", [first.tenantId]);
  for (const b of budgets) {
    assert.ok(b.value.daily_limit_gbp > 0);
    assert.equal(b.value.default, true);
    assert.match(b.reason, /default/i);
  }
  const live = await rows(h,
    `select b.slug, c.key from config_versions c join businesses b on b.business_id = c.business_id
      where c.tenant_id = $1 and c.kind = 'schedule' and (c.value ->> 'live')::boolean order by 1, 2`, [first.tenantId]);
  assert.deepEqual(live, [{ slug: "mastore", key: "research" }, { slug: "salekh-ventures", key: "data" }, { slug: "salekh-ventures", key: "outreach" }, { slug: "salekh-ventures", key: "research" }]);
  const [tenant] = await rows(h, "select slug, name from tenants where tenant_id = $1", [first.tenantId]);
  assert.deepEqual(tenant, { slug: input.tenantSlug, name: "Fixture tenant" });

  // run it again: nothing changes, nothing is added
  const second = await seed(input);
  assert.equal(second.tenantId, first.tenantId);
  assert.deepEqual(await snapshot(first.tenantId), state);
});

test("seed: refuses to invent an owner, and leaves a budget Salekh has changed alone", async () => {
  const input = seedInput();
  await assert.rejects(seed({ ...input, ownerName: "" }), /WH_OWNER_NAME/);
  await assert.rejects(seed({ ...input, ownerEmail: undefined }), /WH_OWNER_EMAIL/);
  assert.equal((await rows(h, "select 1 from tenants where slug = $1", [input.tenantSlug])).length, 0);
  const { tenantId } = await seed(input);
  await h.admin.query(
    `insert into config_versions (tenant_id, business_id, kind, key, value, version, changed_by_kind, reason)
     select tenant_id, business_id, 'budget', 'data', '{"daily_limit_gbp": 5}', 2, 'system', 'test fixture: changed after the seed'
       from businesses where tenant_id = $1 and slug = 'salekh-ventures'`, [tenantId]);
  await seed(input);
  const versions = await rows(h,
    `select c.version, c.value from config_versions c join businesses b on b.business_id = c.business_id
      where c.tenant_id = $1 and b.slug = 'salekh-ventures' and c.kind = 'budget' and c.key = 'data' order by version`, [tenantId]);
  assert.deepEqual(versions.map((v) => [v.version, v.value.daily_limit_gbp]).at(-1), [2, 5]);
  assert.equal(versions.length, 2);
});
