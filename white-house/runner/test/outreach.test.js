// The prospecting pipeline against a real Postgres, with a scripted driver. No model, no web.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { control, openHarness, rows, seedTenant } from "./helpers.js";
import { asModelAnswer, makeHouse } from "./house-helpers.js";
import { addSuppression, listForAnalysis, matchHiddenAdvert, nextAreas, prospectStats, purgeProspects, recordAnalysis, recordProspect, scoreAndFilter } from "../dist/outreach/store.js";
import { changeOutreachSettings, readOutreachSettings, suppress } from "../dist/outreach/admin.js";
import { DEFAULT_OUTREACH_SETTINGS } from "../dist/outreach/settings.js";
import { createScheduler } from "../dist/scheduler.js";
import { makeClock } from "./helpers.js";
import { cachedReach, purgeFetchedPages } from "../dist/outreach/page-cache.js";
import { ReachError } from "../dist/control/connectors/agent-reach.js";
import { createScriptedModel } from "../dist/agents/model-caller.js";

const h = openHarness();
const open = [];
after(async () => {
  await Promise.all(open.filter((x) => x.close).map((x) => x.close()));
  await h.close();
});
const NOW = new Date("2026-11-16T10:00:00Z");
const ROOM = "fixture-floor-one:outreach";

// ---- the master list: deduplication ----

const found = (over = {}) => ({
  name: "Fixture Smile Dental", website: "https://www.fixture-smile.example.test", postcode: "B1 1AA", area: "Fixtureton",
  signal: "hiring_front_desk", evidence: "Fixture advert for a receptionist", source_url: "https://jobs.example.test/fixture-1", ...over,
});
const record = (ids, input, businessId = ids.businessId) =>
  recordProspect(h.gatewayDb, { tenantId: ids.tenantId, businessId, runId: null }, input, { now: NOW });

test("one row per business: the same domain, company number or name at a postcode is refused", async () => {
  const ids = await seedTenant(h);
  const first = await record(ids, found({ companies_house_number: "1234567" }));
  assert.equal(first.recorded, true);
  const again = [
    found({ name: "Completely Different Name", postcode: "B2 2BB", website: "http://fixture-smile.example.test/contact-us" }),
    found({ name: "Completely Different Name", postcode: "B2 2BB", website: "HTTPS://WWW.FIXTURE-SMILE.EXAMPLE.TEST" }),
    found({ name: "Another Name Entirely", postcode: "B3 3CC", website: "https://other-site.example.test", companies_house_number: "01234567" }),
    found({ name: "fixture smile dental ltd.", postcode: "b11aa", website: undefined }),
    found({ name: "The Fixture Smile Dental Clinic", postcode: "B1 1AA", website: "https://second-site.example.test" }),
  ];
  for (const input of again) {
    assert.deepEqual(await record(ids, input), { recorded: false, why: "already_known" }, JSON.stringify(input));
  }
  // genuinely different businesses are recorded
  assert.equal((await record(ids, found({ name: "Fixture Glow Aesthetics", website: "https://fixture-glow.example.test", postcode: "B1 1AA" }))).recorded, true);
  assert.equal((await record(ids, found({ name: "Fixture Smile Dental", website: undefined, postcode: "M1 1AA" }))).recorded, true, "the same name in another place");
  // a second signal for a known business is added to it, not made into a second row
  const second = await record(ids, found({ signal: "meta_ads", evidence: "Fixture advert seen", source_url: "https://ads.example.test/fixture" }));
  assert.deepEqual(second, { recorded: false, why: "already_known" });
  const list = await rows(h, "select name, domain_key, companies_house_number, postcode_key, stage, signals from prospects where tenant_id = $1 order by found_at, name", [ids.tenantId]);
  assert.equal(list.length, 3);
  const smile = list.find((p) => p.domain_key === "fixture-smile.example.test");
  assert.deepEqual([smile.companies_house_number, smile.postcode_key, smile.stage], ["01234567", "B11AA", "found"]);
  assert.deepEqual(smile.signals.map((s) => s.signal), ["hiring_front_desk", "meta_ads"]);
  // another floor and another tenant keep their own lists
  assert.equal((await record(ids, found(), ids.otherBusinessId)).recorded, true);
  const other = await seedTenant(h);
  assert.equal((await record(other, found())).recorded, true);
  const events = await rows(h, "select stage, reason from prospect_events where tenant_id = $1 and business_id = $2", [ids.tenantId, ids.businessId]);
  assert.deepEqual(events.map((e) => [e.stage, e.reason]), [["found", "hiring_front_desk"], ["found", "hiring_front_desk"], ["found", "hiring_front_desk"]]);
});

test("ten attempts to record one business at the same moment make one row", async () => {
  const ids = await seedTenant(h);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => record(ids, found({ website: i % 2 ? "http://fixture-smile.example.test" : "https://www.fixture-smile.example.test/" }))));
  assert.equal(results.filter((r) => r.recorded).length, 1);
  assert.equal((await rows(h, "select 1 from prospects where tenant_id = $1", [ids.tenantId])).length, 1);
});

test("what cannot be a prospect is refused: no source, no way to tell it apart, a bad signal", async () => {
  const ids = await seedTenant(h);
  for (const bad of [
    found({ source_url: "not a url" }), found({ source_url: undefined }), found({ signal: "made_up" }), found({ name: "" }),
    found({ website: undefined, postcode: undefined }), found({ website: "https://www.facebook.com/fixture", postcode: undefined }),
  ]) {
    const res = await record(ids, bad);
    assert.deepEqual([res.recorded, res.why], [false, "invalid"], JSON.stringify(bad));
  }
  assert.equal((await rows(h, "select 1 from prospects where tenant_id = $1", [ids.tenantId])).length, 0);
});

// ---- suppressions ----

test("a suppressed business is refused, by domain, company number or name and postcode", async () => {
  const ids = await seedTenant(h);
  const suppress = (kind, value, businessId = null) => addSuppression(h.uiDb, { tenantId: ids.tenantId, businessId, kind, value, reason: "test fixture: asked not to be contacted", source: "opt_out", memberId: ids.ownerId });
  await suppress("domain", "https://WWW.fixture-smile.example.test/anything");
  await suppress("company_number", "7654321");
  await suppress("name_postcode", { name: "Fixture Glow Aesthetics Ltd", postcode: "b2 2bb" });
  assert.deepEqual(await record(ids, found()), { recorded: false, why: "suppressed" });
  assert.deepEqual(await record(ids, found({ name: "Other", website: "https://other.example.test", companies_house_number: "07654321" })), { recorded: false, why: "suppressed" });
  assert.deepEqual(await record(ids, found({ name: "Fixture Glow Aesthetics", website: "https://glow.example.test", postcode: "B2 2BB" })), { recorded: false, why: "suppressed" });
  assert.deepEqual(await record(ids, found(), ids.otherBusinessId), { recorded: false, why: "suppressed" }, "a tenant wide suppression holds on every floor");
  assert.equal((await rows(h, "select 1 from prospects where tenant_id = $1", [ids.tenantId])).length, 0);
  // adding the same one twice is not an error and makes no second row
  await suppress("domain", "fixture-smile.example.test");
  assert.equal((await rows(h, "select 1 from suppressions where tenant_id = $1", [ids.tenantId])).length, 3);
  // another tenant's suppressions do not apply
  const other = await seedTenant(h);
  assert.equal((await record(other, found())).recorded, true);
});

test("nothing can change or delete a suppression: no role, not even a superuser", async () => {
  const ids = await seedTenant(h);
  await addSuppression(h.uiDb, { tenantId: ids.tenantId, businessId: null, kind: "domain", value: "fixture-smile.example.test", reason: "test fixture", memberId: ids.ownerId });
  for (const db of [h.gatewayDb, h.uiDb, h.agentDb]) {
    for (const sql of ["delete from suppressions", "update suppressions set reason = 'changed'", "truncate suppressions"]) {
      await assert.rejects(db.tx(ids.tenantId, (tx) => tx.query(sql)), /permission denied|must be owner/, sql);
    }
  }
  for (const sql of ["delete from suppressions where tenant_id = $1", "update suppressions set value_key = 'x' where tenant_id = $1"]) {
    await assert.rejects(h.admin.query(sql, [ids.tenantId]), /suppressions are permanent/, sql);
  }
  await assert.rejects(h.admin.query("truncate suppressions"), /suppressions are permanent/);
  assert.equal((await rows(h, "select 1 from suppressions where tenant_id = $1", [ids.tenantId])).length, 1);
  // agent tools cannot even read the list, or the prospects
  for (const table of ["suppressions", "prospects", "prospect_events"]) {
    await assert.rejects(h.agentDb.tx(ids.tenantId, (tx) => tx.query(`select * from ${table}`)), /permission denied/);
  }
  await assert.rejects(h.gatewayDb.tx(ids.tenantId, (tx) => tx.query("delete from prospects")), /permission denied/);
  await assert.rejects(h.gatewayDb.tx(ids.tenantId, (tx) => tx.query("delete from prospect_events")), /permission denied/);
  await assert.rejects(h.gatewayDb.tx(ids.tenantId, (tx) => tx.query("update prospect_events set reason = 'x'")), /permission denied/);
});

// ---- the pipeline: code fetches, the cheap model reads, the better model drafts ----

const SMILE = "https://www.fixture-smile.example.test/";
const GLOW = "https://fixture-glow.example.test/";
const SOLO = "https://fixture-solo.example.test/";
const JOB = "https://www.linkedin.com/jobs/view/111";
const CONTACT = "Alex Fixture-Owner";
const EMAIL = "alex.fixture-owner@fixture-smile.example.test";
const PAGES = {
  [SMILE]: `Fixture Smile Dental. General and cosmetic dentistry in Fixtureton. Dental implants from our team of six. Practice owner: ${CONTACT}. Call 0121 496 0000 or email ${EMAIL}. Use our contact form. Opening hours: Mon to Fri 9 to 5. Fixture Smile Dental Ltd, company number 01234567. 1 Fixture Street, Fixtureton B1 1AA. Rated 3.9 from 41 reviews. Patient story: Jordan Fixture-Patient had gum disease.`,
  [GLOW]: "Fixture Glow Aesthetics. Skin treatments by our four practitioners. Message us at instagram.com/fixtureglow. Opening hours: Mon to Sat 10 to 6. 2 Fixture Road, Fixtureton B1 2BB.",
  [SOLO]: `Fixture Solo Dental. Veneers. I am Jo Fixture-Solo, a sole practitioner. Call 0121 496 0001. 3 Fixture Lane, Fixtureton B1 3CC. ${"x".repeat(50_000)}`,
};
const item = (url, title, text = PAGES[url] ?? "") => ({ title, url, text });

function fakeReach(over = {}) {
  const calls = { search: [], read: [], jobs: [] };
  const total = () => calls.search.length + calls.read.length + calls.jobs.length;
  // The tool's own answers, turned into the errors the connector raises for them.
  const limitWeb = () => {
    if (over.webLimited || (over.webLimitedAfter !== undefined && total() > over.webLimitedAfter)) throw new ReachError("reach_rate_limited", "the search tool reported a rate limit", over.waitSeconds === undefined ? 2501 : over.waitSeconds);
  };
  return {
    calls,
    jobs: async (query, location) => {
      calls.jobs.push([query, location]);
      if (over.needLogin) throw new ReachError("reach_need_login", "the source needs a signed in session");
      if (over.paused) throw new ReachError("reach_paused", "the source is broken upstream and the channel is paused", 118);
      if (over.fail) throw new Error("fixture: source refused");
      return over.noLeads ? [] : [
        item(JOB, "Receptionist", "Fixture Smile Dental, Fixtureton. We are looking for a receptionist."),
        item("https://www.linkedin.com/jobs/view/222", "Receptionist (dental)", "Fixture Recruiters, on behalf of a confidential client."),
        ...(over.jobs ?? []),
      ];
    },
    webSearch: async (query) => {
      calls.search.push(query);
      limitWeb();
      if (over.fail) throw new Error("fixture: source refused");
      if (over.noLeads) return [];
      if (query.startsWith('"Fixture Smile Dental"')) return [item("https://directory.example.test/fixture-smile", "Fixture Smile Dental on a directory"), item(SMILE, "Fixture Smile Dental")];
      if (query.includes(" in Fixtureton")) {
        return [
          item(SMILE, "Fixture Smile Dental"), item(GLOW, "Fixture Glow Aesthetics"), item("https://fixture-quiet.example.test/", "Fixture Quiet Dental", "A fixture clinic."),
          item("http://fixture-smile.example.test/contact", "Contact Fixture Smile Dental", "Fixture contact page."), item(SOLO, "Fixture Solo Dental"),
          ...(over.sites ?? []),
        ];
      }
      return [];
    },
    webRead: async (url) => {
      calls.read.push(url);
      limitWeb();
      const text = over.pages?.[url] ?? PAGES[url];
      return text ? item(url, "Fixture page", text) : null;
    },
    jobRead: async () => null,
  };
}

const NO_ENQUIRIES = { proposed: 0, approved: 0, rejected: 0, sent: 0, replied_person: 0, replied_automatic: 0, no_reply: 0, scored: 0 };
const told = (value, page = 1) => ({ value, page });
const nothing = { value: null, page: null };
const ANALYSIS = {
  "Fixture Smile Dental": {
    is_match: true, what_they_sell: told("Fixture general and cosmetic dentistry"), highest_value_service: told("Fixture dental implants"),
    staff_count: told(6), locations: told(1), opening_hours: told("Mon to Fri 9 to 5"), legal_form: told("limited_company"),
    reviews: { count: 41, rating: 3.9, page: 1 }, contact_person: { name: CONTACT, role: "Practice owner", page: 1 }, signals: [],
  },
  "Fixture Glow Aesthetics": {
    is_match: true, what_they_sell: told("Fixture skin treatments"), highest_value_service: nothing, staff_count: told(4), locations: nothing,
    opening_hours: told("Mon to Sat 10 to 6"), legal_form: nothing, reviews: { count: null, rating: null, page: null },
    // a name that is not on the page it is said to come from
    contact_person: { name: "Sam Fixture-Directory", role: "Manager", page: 1 }, signals: [],
  },
  "Fixture Solo Dental": {
    is_match: true, what_they_sell: told("Fixture dentistry"), highest_value_service: told("Fixture veneers"), staff_count: nothing, locations: nothing,
    opening_hours: { value: "Always open", page: 9 }, legal_form: told("sole_trader"), reviews: { count: null, rating: null, page: null },
    contact_person: { name: "Jo Fixture-Solo", role: "Dentist", page: 1 }, signals: [],
  },
};
const GOOD_DRAFT = {
  why: "They are advertising for a receptionist and offer implants.",
  sample_reply: "Thank you for getting in touch about implants. One of the team will confirm a time for a consultation.",
  first_message: "Hi Alex, I saw the advert for a receptionist. I build an enquiries agent for dental clinics. Would a short call be useful?",
  call_opener: "I saw the front desk advert and had one idea for it.",
};
const BAD_DRAFT = { ...GOOD_DRAFT, first_message: "Subject: your enquiries\n\nDear Alex, we tested your enquiry form and you took 2 days to reply." };

/** Plays the model at each of its three fixed points. `hooks[stage]` lets a test interfere. */
function fakeModel(hooks = {}) {
  const requests = [];
  const model = createScriptedModel(async (request) => {
    requests.push(request);
    await hooks[request.stage]?.(request, requests.filter((r) => r.stage === request.stage).length);
    if (request.stage === "find") {
      if (hooks.findError) return { error: "api_error" };
      const numbered = [...request.user.matchAll(/^\[(\d+)\] .*\naddress: (\S+)/gm)].map((m) => [Number(m[1]), m[2]]);
      const about = {
        [JOB]: { is_match: true, business_name: "Fixture Smile Dental", area: "Fixtureton", own_site: false, hidden_employer: false, signal: "hiring_front_desk", evidence: "a receptionist" },
        "https://www.linkedin.com/jobs/view/222": { is_match: true, business_name: "", area: "", own_site: false, hidden_employer: true, signal: "none", evidence: "" },
        [SMILE]: { is_match: true, business_name: "Fixture Smile Dental", area: "Fixtureton", own_site: true, hidden_employer: false, signal: "none", evidence: "" },
        [GLOW]: { is_match: true, business_name: "Fixture Glow Aesthetics", area: "Fixtureton", own_site: true, hidden_employer: false, signal: "meta_ads", evidence: "fixture advert" },
        [SOLO]: { is_match: true, business_name: "Fixture Solo Dental", area: "Fixtureton", own_site: true, hidden_employer: false, signal: "weak_social", evidence: "fixture last post" },
      };
      Object.assign(about, hooks.about ?? {});
      return { data: { leads: numbered.filter(([, url]) => about[url]).map(([lead, url]) => ({ lead, ...about[url] })) }, costUsd: hooks.findCostUsd ?? 0.2, usage: { inputTokens: 1000, outputTokens: 100 } };
    }
    if (request.stage === "analyse") {
      const answers = { ...ANALYSIS, ...(hooks.analysis ?? {}) };
      const name = Object.keys(answers).find((n) => request.user.startsWith(`Business: ${n},`));
      if (hooks.analyseError?.(name)) return { error: "api_error" };
      return { data: asModelAnswer({ part_of_group: nothing, highest_value_price: nothing, ...answers[name] }), costUsd: hooks.analyseCostUsd ?? 0.1, usage: { inputTokens: 2000, outputTokens: 200 } };
    }
    const first = requests.filter((r) => r.stage === "draft" && r.user.includes("Business: Fixture Smile Dental")).length === 1;
    return { data: first ? BAD_DRAFT : GOOD_DRAFT, costUsd: 0.1, usage: { inputTokens: 500, outputTokens: 300 } };
  });
  return { requests, model };
}

const companiesHouse = {
  lookup: async ({ number }) =>
    number === "01234567"
      ? { status: "yes", company: { name: "FIXTURE SMILE DENTAL LIMITED", number: "01234567", status: "active", type: "ltd", postcode: "B1 1AA", matched_by: "number", source_url: "https://find-and-update.company-information.service.gov.uk/company/01234567" }, directors: ["Alex Fixture-Owner"] }
      : { status: "not_found" },
};
// No waiting between calls in tests: the gap has its own test.
const SETTINGS = { area: "Fixtureshire", areas: ["Fixtureton"], areas_per_run: 1, front_desk_roles: ["receptionist"], job_search_hint: "dental", min_seconds_between_fetches: 0 };

async function outreachHouse(hooks = {}, opts = {}) {
  const play = fakeModel(hooks);
  const reach = "reach" in opts ? opts.reach : fakeReach(opts.reachOver);
  const x = await makeHouse(h, {
    sleep: opts.sleep,
    outreach: { budget: opts.budget ?? 5, settings: { ...SETTINGS, ...opts.settings } }, model: play.model, reach,
    companiesHouse: "companiesHouse" in opts ? opts.companiesHouse : companiesHouse, server: opts.server ?? false,
  });
  open.push(x);
  await addSuppression(h.uiDb, { tenantId: x.w.tenantId, businessId: null, kind: "domain", value: "fixture-quiet.example.test", reason: "test fixture", memberId: x.w.ownerId });
  return { x, reach, requests: play.requests };
}
const run = async (x) => {
  const res = await x.runtime.startRun(ROOM, {});
  assert.equal(res.status, 202, JSON.stringify(res));
  await x.runtime.idle();
  return res.runId;
};
const prospects = (x) => rows(h, "select * from prospects where tenant_id = $1 order by name", [x.w.tenantId]);
const allEvents = (x) => control.listEvents(h.gatewayDb, { tenantId: x.w.tenantId, withPayload: true });
const stagesOf = async (x) => (await allEvents(x)).filter((e) => e.type === "stage").map((e) => e.summary);
const DAY = 24 * 60 * 60 * 1000;

test("a full run: both routes find, code reads the pages, the list is filtered, scored, compared and drafted", async () => {
  const { x, reach, requests } = await outreachHouse();
  await run(x);

  // the model is called at three fixed points only, the cheap one to read and the better one to draft
  assert.deepEqual(requests.map((r) => [r.stage, r.model]), [
    ["find", "claude-haiku-5-5"], ["analyse", "claude-haiku-5-5"], ["analyse", "claude-haiku-5-5"], ["analyse", "claude-haiku-5-5"],
    ["draft", "claude-sonnet-5-5"], ["draft", "claude-sonnet-5-5"],
  ]);
  for (const r of requests) {
    assert.ok(r.user.length < 60_000, `${r.stage} prompt is ${r.user.length} characters`);
    assert.ok(r.system.includes("Fixture root rules") && r.system.includes(`Fixture outreach-${r.stage} role`));
  }
  // route one started from job adverts, for each place and role in the settings; route two from the kind of business and the place
  assert.deepEqual(reach.calls.jobs, [["receptionist dental", "Fixtureton"]]);
  assert.ok(reach.calls.search.includes("private dental and aesthetics clinics in Fixtureton"));
  assert.ok(reach.calls.search.some((q) => q.startsWith('"Fixture Smile Dental" Fixtureton')), "the employer in the advert was looked up to find its own site");
  // a page 50,000 characters long reached the model cut to 6,000
  const solo = requests.find((r) => r.stage === "analyse" && r.user.startsWith("Business: Fixture Solo Dental"));
  assert.ok((solo.user.match(/x/g) ?? []).length <= 6000);

  const list = await prospects(x);
  assert.deepEqual(list.map((p) => [p.name, p.stage, p.filter_reason, p.search_area]), [
    ["Fixture Glow Aesthetics", "filtered_out", "no_named_contact", "Fixtureton"],
    ["Fixture Smile Dental", "shortlisted", null, "Fixtureton"],
    ["Fixture Solo Dental", "filtered_out", "not_limited_company", "Fixtureton"],
  ]);
  const [glow, smile, solo2] = list;
  // found from the advert: its address, title and the date seen are the evidence. The site was found by code.
  assert.deepEqual(smile.signals, [{ signal: "hiring_front_desk", evidence: "Job advert: Receptionist (the advert does not show when it was posted)", source_url: JOB, source_opened: true, seen_on: "2026-11-16" }]);
  assert.equal(smile.domain_key, "fixture-smile.example.test");
  // the contact routes, company number and postcode were read off the page by code
  assert.deepEqual(smile.contact_routes.map((r) => [r.kind, r.value, r.source_url]), [["email", EMAIL, SMILE], ["phone", "0121 496 0000", SMILE], ["form", SMILE, SMILE]]);
  assert.deepEqual([smile.companies_house_number, smile.postcode_key, smile.is_limited_company], ["01234567", "B11AA", "yes"]);
  assert.deepEqual(glow.contact_routes.map((r) => [r.kind, r.value]), [["instagram", "https://instagram.com/fixtureglow"]]);
  // what the model read is stored with the page it came from
  assert.deepEqual(smile.analysis.highest_value_service, { value: "Fixture dental implants", source_url: SMILE });
  assert.deepEqual(smile.analysis.opening_hours, { value: "Mon to Fri 9 to 5", source_url: SMILE });
  assert.equal(solo2.analysis.opening_hours, "not found", "a page number that does not exist is not a source");
  assert.equal(smile.analysis.runs_ads, "not found");
  assert.deepEqual([smile.contact_name, smile.contact_role, smile.contact_name_source], [CONTACT, "Practice owner", SMILE]);
  assert.deepEqual([glow.contact_name, glow.analysis.contact_person], [null, "not found"], "a name that is not on the page is not kept");
  assert.deepEqual([glow.is_limited_company, solo2.is_limited_company], ["not_found", "no"]);
  // score: signals 25 + money 20 + reach (name 5, email 1, phone 3, form 1) 10 + limited 10
  assert.deepEqual([Number(smile.score), smile.score_breakdown.reply_speed, smile.test_result], [65, null, null]);
  assert.equal(solo2.purge_after.getTime() - solo2.filtered_out_at.getTime(), 90 * DAY);

  // the draft that read like an email and claimed a test was sent back once; the second was kept
  assert.match(requests[5].user, /Your last draft was not accepted/);
  assert.match(requests[5].user, /tested/);
  assert.match(requests[5].user, /reads like an email/);
  assert.equal(smile.card.first_message, GOOD_DRAFT.first_message);
  assert.equal(smile.card.lead_agent, "Enquiries");
  assert.ok(requests[4].user.includes("Lead with this one agent: Enquiries") && requests[4].user.includes("never an email") && requests[4].user.includes("NOT DONE"));
  assert.ok(!requests[4].user.includes(EMAIL), "the drafting model is not given contact details it does not need");

  // local competitors: the other two businesses found for the same place, stored as links
  const links = await rows(h, "select p.name, c.comparison, c.test_comparison from prospect_competitors c join prospects p on p.prospect_id = c.competitor_id where c.prospect_id = $1 order by p.name", [smile.prospect_id]);
  assert.deepEqual(links.map((l) => [l.name, l.test_comparison]), [["Fixture Glow Aesthetics", null], ["Fixture Solo Dental", null]]);
  assert.deepEqual(links[0].comparison.opening_hours, { value: "Mon to Sat 10 to 6", source_url: GLOW });

  // one output: the shortlist
  const outputs = await rows(h, "select * from outputs where tenant_id = $1", [x.w.tenantId]);
  assert.equal(outputs.length, 1);
  const out = outputs[0];
  assert.deepEqual([out.title, out.department], ["Shortlist, 2026-11-16", "outreach"]);
  for (const part of [
    "Searched this run: Fixtureton", "Found: 3", "Already known: 1", "Refused as suppressed: 1", "Shortlisted: 1", "no_named_contact: 1", "not_limited_company: 1",
    "## 1. Fixture Smile Dental", "**Profile**", "**Capture score: none.** Not tested yet. This card rests on fit and signals alone.", "Job advert: Receptionist (the advert does not show when it was posted), seen 2026-11-16 (source: https://www.linkedin.com/jobs/view/111)",
    "**Why they can afford it**", "sells Fixture dental implants", "6 staff shown", `Who: ${CONTACT}, Practice owner`,
    "**Against local competitors**",
    "| | Fixture Smile Dental | Fixture Glow Aesthetics | Fixture Solo Dental |",
    "| Reviews | 3.9 from 41 [1] | not found | not found |",
    "| Ways to enquire | email [1], phone [1], form [1] | instagram [2] | phone [3] |",
    "| Front desk job advert | advert found [4] | not found | not found |",
    "| Opening hours | Mon to Fri 9 to 5 [1] | Mon to Sat 10 to 6 [2] | not found |",
    "| Reply to the test enquiry | Not tested yet | Not tested yet | Not tested yet |",
    "| Capture score | Not tested yet | Not tested yet | Not tested yet |",
    "Sources:\n1. https://www.fixture-smile.example.test/\n2. https://fixture-glow.example.test/\n3. https://fixture-solo.example.test/\n4. https://www.linkedin.com/jobs/view/111",
    "Fixture Glow Aesthetics publishes instagram for enquiries; this was not found for Fixture Smile Dental.",
    "Searches and page reads: 11 made, 0 from today's cache",
    "Best route: phone, 0121 496 0000. Why: a phone number is published", "Salekh does not email prospects", "**First message, to send by hand (phone)**",
    GOOD_DRAFT.first_message, "Lead agent: Enquiries. Fit score: 65 out of 100", "None is an email", "voice", "Reply speed is not part of the score",
    "1 job adverts were skipped because a recruitment agency posted them without naming the employer",
    "Cost of this run (estimate from list prices): £0.35", "Per business looked at: £0.1167", "Per business shortlisted: £0.35",
  ]) assert.ok(out.body.includes(part), `the shortlist is missing "${part}"\n${out.body}`);
  assert.ok(!out.body.includes("## 2."), "one card only");
  assert.ok(!out.body.includes("Jordan Fixture-Patient") && !out.body.includes("gum disease"), "nothing about a patient reaches the card");
  assert.equal((out.body.match(/Fixture Glow Aesthetics publishes instagram/g) ?? []).length, 1, "each difference is said once");
  assert.deepEqual(out.data.tally, { found: 3, already_known: 1, suppressed: 1, analysed: 3, filtered_out: { no_named_contact: 1, not_limited_company: 1 }, shortlisted: 1, stale_adverts: 0, unconfirmed_adverts: 0, would_pass_with_companies_house: 0,
    enquiries_proposed: { prospect: 0, rival: 0 }, enquiries_dropped: 0, scored_after_test: 0, not_testable: 0, reissued: 0, no_website: 0 });
  assert.ok(requests[4].user.includes("Fixture Glow Aesthetics publishes instagram for enquiries"), "the drafting model is given only the differences that go against the prospect");
  assert.deepEqual(out.data.cards, [{ prospect_id: smile.prospect_id, score: 65, capture_score: null, reissue: false, estimated_leak: null, no_leak_reason: "not tested yet", competitor_ids: [glow.prospect_id, solo2.prospect_id] }]);
  assert.deepEqual(out.data.areas_searched, ["Fixtureton"]);
  assert.deepEqual(out.data.costs.find, { model_calls: 1, tokens_in: 1000, tokens_out: 100, cost_usd: 0.2, cost_gbp: 0.1 });
  assert.deepEqual([out.data.costs.analyse.model_calls, out.data.costs.analyse.tokens_in, out.data.costs.draft.model_calls, out.data.costs.total_gbp], [3, 6000, 2, 0.35]);
  assert.deepEqual([out.data.costs.per_business_looked_at_gbp, out.data.costs.per_business_shortlisted_gbp], [0.1167, 0.35]);

  // each stage is one run, carrying the tokens and cost of all its model calls
  const runs = await rows(h, "select trigger, model, status, tokens_in::int as tokens_in, tokens_out::int as tokens_out, cost_usd, cost_gbp from runs where tenant_id = $1 order by trigger", [x.w.tenantId]);
  assert.deepEqual(runs.map((r) => [r.trigger, r.model, r.status, r.tokens_in, r.tokens_out, Number(r.cost_usd), Number(r.cost_gbp)]), [
    ["outreach:analyse", "claude-haiku-5-5", "done", 6000, 600, 0.3, 0.15],
    ["outreach:draft", "claude-sonnet-5-5", "done", 1000, 600, 0.2, 0.1],
    ["outreach:find", "claude-haiku-5-5", "done", 1000, 100, 0.2, 0.1],
  ]);
  const [ledger] = await rows(h, "select cost_gbp, run_count from budget_ledger where tenant_id = $1 and department = 'outreach'", [x.w.tenantId]);
  assert.deepEqual([Number(ledger.cost_gbp), ledger.run_count], [0.35, 3]);

  // every stage is on the prospect's own record
  const trail = await rows(h, "select p.name, e.stage, e.reason from prospect_events e join prospects p using (prospect_id) where e.tenant_id = $1 order by e.seq", [x.w.tenantId]);
  assert.deepEqual(trail.filter((t) => t.name === "Fixture Smile Dental").map((t) => [t.stage, t.reason]), [["found", "hiring_front_desk"], ["analysed", "analysed"], ["shortlisted", "passed_filters"]]);
  assert.deepEqual(trail.filter((t) => t.name === "Fixture Solo Dental").map((t) => [t.stage, t.reason]), [["found", "weak_social"], ["analysed", "analysed"], ["filtered_out", "not_limited_company"]]);
  assert.deepEqual(await rows(h, "select 1 from enquiries where tenant_id = $1", [x.w.tenantId]), [], "with no test mailbox, no enquiry is even drafted");
});

test("the event stream shows each stage in fixed words with numbers only, and no business or personal details anywhere", async () => {
  const { x } = await outreachHouse({}, { server: true });
  await run(x);
  assert.deepEqual(await stagesOf(x), [
    "Finding businesses", "Job adverts skipped, employer hidden by a recruiter: 1", "Analysing 1 of 3", "Analysing 2 of 3", "Analysing 3 of 3",
    "Scoring and filtering 3", "Drafting 1 of 1", "Shortlist ready: 1 of 3 passed",
  ]);
  const events = await allEvents(x);
  const types = events.filter((e) => e.department === "outreach").map((e) => e.type);
  assert.deepEqual([types.filter((t) => t === "started").length, types.filter((t) => t === "done").length, types.filter((t) => t === "output").length, types.at(-1)], [3, 3, 1, "stage"]);
  const everything = JSON.stringify(events);
  for (const secret of [CONTACT, EMAIL, "0121 496 0000", "Fixture-Directory", "Jo Fixture-Solo", "Fixture Smile", "Fixture Glow", "fixture-smile.example.test", "Jordan"]) {
    assert.ok(!everything.includes(secret), `"${secret}" reached the event stream`);
  }
  x.w.clock.advance(1000);
  const house = await x.call("GET", "/v1/house");
  const text = JSON.stringify(house.body);
  for (const secret of [CONTACT, EMAIL, "Fixture Smile", "Fixture Glow"]) assert.ok(!text.includes(secret), `"${secret}" reached /v1/house`);
  const room = house.body.rooms.find((r) => r.id === ROOM);
  assert.deepEqual([room.state, room.outputs.map((o) => o.title)], ["done", ["Shortlist, 2026-11-16"]]);
  const full = await x.call("GET", `/v1/outputs/${room.outputs[0].id}`);
  assert.ok(full.body.body.includes(CONTACT), "the person meant to read the card can");
});

test("while it runs the room says which stage it is at, in fixed words", async () => {
  const tasks = [];
  let x;
  const peek = async () => {
    x.w.clock.advance(1000);
    const room = (await x.runtime.house()).rooms.find((r) => r.id === ROOM);
    const line = `${room.state}: ${room.task}`;
    if (tasks.at(-1) !== line) tasks.push(line);
  };
  ({ x } = await outreachHouse({ find: peek, analyse: peek, draft: peek }));
  await run(x);
  assert.deepEqual(tasks, ["working: Finding businesses", "working: Analysing 1 of 3", "working: Analysing 2 of 3", "working: Analysing 3 of 3", "working: Drafting 1 of 1"]);
  assert.equal((await x.runtime.startRun(ROOM, {})).status, 202, "and it can be run again afterwards");
  await x.runtime.idle();
});

test("with no Companies House key the pipeline still runs, and the card says the company was not checked", async () => {
  const { x } = await outreachHouse({}, { companiesHouse: null });
  await run(x);
  const smile = (await prospects(x)).find((p) => p.name === "Fixture Smile Dental");
  assert.deepEqual([smile.is_limited_company, smile.stage, Number(smile.score)], ["not_checked", "shortlisted", 55]);
  const [out] = await rows(h, "select body from outputs where tenant_id = $1", [x.w.tenantId]);
  assert.match(out.body, /Limited company: not checked/);
  assert.match(out.body, /Companies House was not checked/);
  // what the key is worth: Glow failed only for want of a named person, which the register might have supplied
  const [data] = await rows(h, "select data from outputs where tenant_id = $1", [x.w.tenantId]);
  assert.equal(data.data.tally.would_pass_with_companies_house, 1);
  assert.match(out.body, /1 failed only because no person was named\. With a Companies House key/);
  const broken = await outreachHouse({}, { companiesHouse: { lookup: async () => { throw new Error("fixture outage"); } } });
  await run(broken.x);
  assert.equal((await prospects(broken.x)).find((p) => p.name === "Fixture Smile Dental").is_limited_company, "not_checked", "an outage does not stop the run");
});

test("with no search tool configured the find stage stops with a fixed reason", async () => {
  const { x, requests } = await outreachHouse({}, { reach: null });
  const runId = await run(x);
  assert.equal(requests.length, 0);
  assert.deepEqual((await rows(h, "select status, error from runs where run_id = $1", [runId]))[0], { status: "failed", error: "search_not_configured" });
  assert.deepEqual((await stagesOf(x)).at(-1), "Stopped: the search tool is not configured");
});

test("the budget is checked before each stage: a spent budget stops the run and keeps what was found", async () => {
  // fixture rate 0.5: a find stage costing 12 dollars spends 6 pounds of a 5 pound budget
  const hooks = { findCostUsd: 12 };
  const { x, requests } = await outreachHouse(hooks);
  await run(x);
  assert.deepEqual(requests.map((r) => r.stage), ["find"]);
  assert.deepEqual((await prospects(x)).map((p) => p.stage), ["found", "found", "found"]);
  assert.equal((await rows(h, "select 1 from outputs where tenant_id = $1", [x.w.tenantId])).length, 0);
  const events = (await allEvents(x)).filter((e) => e.department === "outreach");
  assert.deepEqual(events.slice(-2).map((e) => [e.type, e.reasonCode, e.summary]), [
    ["run_refused", "budget_exceeded", "Run not started: this department has spent its daily budget"],
    ["stage", "stopped_budget", "Stopped before analysing: the daily budget is spent"],
  ]);
  assert.deepEqual(await x.runtime.startRun(ROOM, {}), { status: 409, reason: "over_budget" });
  // the next day it carries on from where it stopped
  x.w.clock.advance(DAY);
  requests.length = 0;
  hooks.findCostUsd = 0.2;
  await run(x);
  assert.deepEqual(requests.map((r) => r.stage), ["analyse", "analyse", "analyse", "find", "draft", "draft"], "the businesses left from yesterday are analysed before anything new is looked for");
  assert.ok(!requests[3].user.includes(GLOW) && !requests[3].user.includes(SOLO), "businesses already on the list are dropped by code before the model is asked");
  assert.deepEqual((await stagesOf(x)).filter((line) => line.startsWith("Analysing businesses left")), ["Analysing businesses left from earlier runs: 3"]);
  assert.deepEqual((await prospects(x)).map((p) => p.stage), ["filtered_out", "shortlisted", "filtered_out"]);
  const [out] = await rows(h, "select data from outputs where tenant_id = $1", [x.w.tenantId]);
  assert.deepEqual([out.data.tally.found, out.data.tally.already_known, out.data.tally.analysed, out.data.tally.shortlisted], [0, 4, 3, 1]);
});

test("inside a stage, the kill switch and the budget are checked before every model call", async () => {
  let x;
  ({ x } = await outreachHouse({ analyse: async (_request, n) => { if (n === 2) await control.engageKillSwitch(h.gatewayDb, { tenantId: x.w.tenantId, businessId: null, memberId: x.w.ownerId, reason: "test fixture" }); } }));
  await run(x);
  assert.deepEqual((await prospects(x)).map((p) => p.stage).sort(), ["analysed", "analysed", "found"], "the call in hand finishes, the next is not made");
  const last = (await allEvents(x)).filter((e) => e.department === "outreach").at(-1);
  assert.deepEqual([last.type, last.reasonCode, last.summary], ["stage", "stopped_kill_switch", "Stopped before analysing 3 of 3: the kill switch is set"]);
  assert.equal((await rows(h, "select 1 from outputs where tenant_id = $1", [x.w.tenantId])).length, 0);
  assert.equal((await rows(h, "select status from runs where tenant_id = $1 and trigger = 'outreach:analyse'", [x.w.tenantId]))[0].status, "done", "what was spent is still recorded");
  assert.deepEqual((await x.runtime.startRun(ROOM, {})).reason, "kill_switch");

  // each analysis costs 6 dollars, 3 pounds: the third would start with 6.10 of 5 pounds already spent
  const spend = await outreachHouse({ analyseCostUsd: 6 });
  await run(spend.x);
  assert.deepEqual((await stagesOf(spend.x)).at(-1), "Stopped before analysing 3 of 3: the daily budget is spent");
  assert.equal(spend.requests.filter((r) => r.stage === "analyse").length, 2);
});

test("sources that refuse or fail are skipped, and a find stage with nothing to go on shows the room as failed", async () => {
  const over = {};
  const { x, reach, requests } = await outreachHouse({}, { reachOver: over });
  await run(x);
  const before = (await prospects(x)).map((p) => [p.name, p.stage]);
  // on the second day every source refuses
  x.w.clock.advance(DAY);
  over.fail = true;
  requests.length = 0;
  const calls = reach.calls.jobs.length + reach.calls.search.length;
  const runId = await run(x);
  assert.deepEqual((await rows(h, "select status, error from runs where run_id = $1", [runId]))[0], { status: "failed", error: "find_failed" });
  assert.deepEqual((await stagesOf(x)).slice(-2), ["Sources refused or failed and were skipped: 4 of 4", "Stopped: the find stage failed"]);
  assert.equal(requests.length, 0, "no model was asked");
  assert.equal(reach.calls.jobs.length + reach.calls.search.length - calls, 4, "each source was tried once and not again");
  assert.deepEqual((await prospects(x)).map((p) => [p.name, p.stage]), before, "what was already recorded stays");
  x.w.clock.advance(1000);
  assert.equal((await x.runtime.house()).rooms.find((r) => r.id === ROOM).state, "failed");
});

test("a model that fails at the find stage fails the stage; one analysis that fails is tried once more and then set aside", async () => {
  const dead = await outreachHouse({ findError: true });
  const runId = await run(dead.x);
  assert.deepEqual((await rows(h, "select status, error from runs where run_id = $1", [runId]))[0], { status: "failed", error: "find_failed" });
  assert.equal((await prospects(dead.x)).length, 0);

  const { x, requests } = await outreachHouse({ analyseError: (name) => name === "Fixture Glow Aesthetics" });
  await run(x);
  assert.equal(requests.filter((r) => r.stage === "draft").length, 2, "the others carried on to the draft");
  let glow = (await prospects(x)).find((p) => p.name === "Fixture Glow Aesthetics");
  assert.deepEqual([glow.stage, glow.analysis_attempts], ["found", 1]);
  x.w.clock.advance(DAY);
  await run(x);
  glow = (await prospects(x)).find((p) => p.name === "Fixture Glow Aesthetics");
  assert.deepEqual([glow.stage, glow.filter_reason, glow.analysis_attempts], ["filtered_out", "analysis_failed", 2]);
});

test("settings: only the UI's role can change them, the batch size is honoured, and nonsense stops the run", async () => {
  const { x, requests } = await outreachHouse({}, { settings: { business_type: "fixture solicitors", find_per_run: 2, shortlist_size: 1 } });
  await run(x);
  assert.ok(requests[0].user.includes("fixture solicitors"));
  assert.equal((await prospects(x)).length, 2, "two looked at, as asked");
  await assert.rejects(
    h.gatewayDb.tx(x.w.tenantId, (tx) => tx.query(
      `insert into config_versions (tenant_id, business_id, kind, key, value, version, changed_by_kind, reason) values ($1, $2, 'setting', 'outreach', '{"find_per_run": 500}', 99, 'system', 'gateway tries')`,
      [x.w.tenantId, x.w.businessId])),
    /row-level security/);
  await control.setConfig(h.uiDb, { tenantId: x.w.tenantId, businessId: x.w.businessId, kind: "setting", key: "outreach", value: { find_per_run: 5000 }, memberId: x.w.ownerId, reason: "test fixture" });
  x.w.clock.advance(1000);
  assert.deepEqual(await x.runtime.startRun(ROOM, {}), { status: 409, reason: "bad_settings" });
});

test("runs move round the country: each takes the next few places and records that they were searched", async () => {
  const { x, reach } = await outreachHouse({}, { reachOver: { noLeads: true }, settings: { areas: ["Aton", "Bton", "Cton", "Dton", "Eton"], areas_per_run: 2 } });
  const searched = () => reach.calls.search.filter((q) => q.startsWith("private dental") && q.includes(" in ")).map((q) => q.split(" in ")[1]);
  await run(x);
  assert.deepEqual(searched(), ["Aton", "Bton"]);
  x.w.clock.advance(DAY);
  await run(x);
  x.w.clock.advance(DAY);
  await run(x);
  assert.deepEqual(searched(), ["Aton", "Bton", "Cton", "Dton", "Eton", "Aton"], "the list is worked through, then starts again with the place searched longest ago");
  const coverage = await rows(h, "select area, times_searched from search_coverage where tenant_id = $1 order by area", [x.w.tenantId]);
  assert.deepEqual(coverage, [{ area: "Aton", times_searched: 2 }, { area: "Bton", times_searched: 1 }, { area: "Cton", times_searched: 1 }, { area: "Dton", times_searched: 1 }, { area: "Eton", times_searched: 1 }]);
  const outs = await rows(h, "select data from outputs where tenant_id = $1 order by created_at", [x.w.tenantId]);
  assert.deepEqual(outs.map((o) => o.data.areas_searched), [["Aton", "Bton"], ["Cton", "Dton"], ["Eton", "Aton"]]);
  // with no list of places the territory itself is searched
  const ids = await seedTenant(h);
  assert.deepEqual(await nextAreas(h.gatewayDb, { tenantId: ids.tenantId, businessId: ids.businessId, runId: null }, [], 3, NOW), []);
});

test("nothing is fetched twice in a day: the page cache is in the database and is cleared after a day", async () => {
  const ids = await seedTenant(h);
  const reach = fakeReach();
  let now = NOW;
  const counts = { fetched: 0, fromCache: 0 };
  const cached = cachedReach(h.gatewayDb, { tenantId: ids.tenantId, businessId: ids.businessId }, reach, () => now, counts);
  const first = await cached.webRead(SMILE);
  const second = await cached.webRead(SMILE);
  await cached.webSearch("fixture query", 5);
  await cached.webSearch("fixture query", 5);
  await cached.jobs("receptionist", "Fixtureton", 5);
  await cached.jobs("receptionist", "Fixtureton", 5);
  assert.deepEqual(second, first);
  assert.deepEqual([reach.calls.read.length, reach.calls.search.length, reach.calls.jobs.length, counts], [1, 1, 1, { fetched: 3, fromCache: 3 }]);
  // another floor has its own cache, and the next day it is fetched afresh
  await cachedReach(h.gatewayDb, { tenantId: ids.tenantId, businessId: ids.otherBusinessId }, reach, () => now, counts).webRead(SMILE);
  now = new Date(NOW.getTime() + DAY);
  await cached.webRead(SMILE);
  assert.equal(reach.calls.read.length, 3);
  assert.equal(await purgeFetchedPages(h.gatewayDb, { tenantId: ids.tenantId }, now), 0, "yesterday's are kept one more day");
  assert.equal(await purgeFetchedPages(h.gatewayDb, { tenantId: ids.tenantId }, new Date(NOW.getTime() + 2 * DAY)), 4);
  await assert.rejects(h.agentDb.tx(ids.tenantId, (tx) => tx.query("select * from fetched_pages")), /permission denied/);
  await assert.rejects(h.uiDb.tx(ids.tenantId, (tx) => tx.query("delete from fetched_pages")), /permission denied/);
});

test("LinkedIn profile pages are never fetched by an agent either: the hook refuses them for every department", async () => {
  const got = {};
  const fetches = {
    profile: "https://www.linkedin.com/in/fixture-person", regional: "https://uk.linkedin.com/in/fixture-person/", bare: "linkedin.com/in/fixture-person",
    upper: "HTTPS://WWW.LINKEDIN.COM/IN/Fixture-Person", pub: "https://www.linkedin.com/pub/fixture-person/1/2/3", viaRedirect: "https://www.google.com/url?q=https%3A%2F%2Fwww.linkedin.com%2Fin%2Ffixture-person",
    company: "https://www.linkedin.com/company/fixture-smile", ordinary: "https://fixture-smile.example.test/in/team",
  };
  const research = await makeHouse(h, { server: false, script: async (spec) => {
    for (const [key, url] of Object.entries(fetches)) got[key] = await spec.call("WebFetch", { url, prompt: "fixture" });
    await spec.call("mcp__wh__write_output", { title: "Fixture", body: "Fixture" });
    return { ok: true, resultText: "", costUsd: 0, numTurns: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } };
  } });
  open.push(research);
  await research.runtime.startRun("fixture-floor-one:research", { brief: "Fixture brief" });
  await research.runtime.idle();
  for (const key of ["profile", "regional", "bare", "upper", "pub", "viaRedirect"]) assert.equal(got[key].isError, true, key);
  for (const key of ["company", "ordinary"]) assert.notEqual(got[key].isError, true, key);
  const blocked = (await allEvents(research)).filter((e) => e.reasonCode === "url_blocked");
  assert.equal(blocked.length, 6);
  assert.ok(blocked.every((e) => e.summary === "A web address that is off limits was refused"));
});

// ---- retention and the weekly numbers ----

test("a prospect filtered out more than 90 days ago is purged: details go, the keys that stop it being found again stay", async () => {
  const { x } = await outreachHouse();
  await run(x);
  assert.equal(await purgeProspects(h.gatewayDb, { tenantId: x.w.tenantId }, new Date(x.w.clock.now().getTime() + 89 * DAY)), 0);
  assert.equal(await purgeProspects(h.gatewayDb, { tenantId: x.w.tenantId }, new Date(x.w.clock.now().getTime() + 91 * DAY)), 2);
  const list = await prospects(x);
  const solo = list.find((p) => p.domain_key === "fixture-solo.example.test");
  assert.deepEqual(
    [solo.name, solo.website, solo.contact_name, solo.contact_role, solo.contact_name_source, solo.contact_routes, solo.analysis, solo.signals, solo.name_key, solo.stage, solo.filter_reason],
    ["(removed)", null, null, null, null, [], null, [], null, "filtered_out", "not_limited_company"]);
  assert.ok(solo.purged_at && solo.name_postcode_hash);
  assert.equal(list.find((p) => p.name === "Fixture Smile Dental").contact_name, CONTACT, "a shortlisted prospect is not touched");
  const again = await recordProspect(h.gatewayDb, { tenantId: x.w.tenantId, businessId: x.w.businessId, runId: null }, found({ name: "Fixture Solo Dental", website: "https://www.fixture-solo.example.test/", postcode: "B1 3CC" }), { now: NOW });
  assert.deepEqual(again, { recorded: false, why: "already_known" }, "it still cannot be found a second time");
  assert.equal(await purgeProspects(h.gatewayDb, { tenantId: x.w.tenantId }, new Date(x.w.clock.now().getTime() + 200 * DAY)), 0, "purged once");
});

test("weekly numbers: counts per stage for a date range", async () => {
  const { x } = await outreachHouse();
  await run(x);
  const stats = await prospectStats(h.gatewayDb, { tenantId: x.w.tenantId, from: "2026-11-16", to: "2026-11-17" });
  assert.deepEqual(stats, {
    from: "2026-11-16", to: "2026-11-17",
    stages: { found: 3, analysed: 3, filtered_out: 2, shortlisted: 1, tested: 0, messaged: 0, replied: 0, call_booked: 0, paid: 0, opted_out: 0 },
    filtered_out_by_reason: { no_named_contact: 1, not_limited_company: 1 },
    found_by_signal: { hiring_front_desk: 1, meta_ads: 1, weak_social: 1 },
    enquiries: { prospect: NO_ENQUIRIES, rival: NO_ENQUIRIES },
    by_type: { clinics: { found: 3, analysed: 3, filtered_out: 2, shortlisted: 1 } },
  });
  assert.equal((await prospectStats(h.gatewayDb, { tenantId: x.w.tenantId, from: "2026-11-17", to: "2026-11-24" })).stages.found, 0);
  await assert.rejects(prospectStats(h.gatewayDb, { tenantId: x.w.tenantId, from: "yesterday", to: "today" }), (err) => err.code === "invalid_request");
});

// ---- second round: groups, adverts first, advert age, unconfirmed adverts, the fetch limit ----

const PARK = "https://fixture-park.example.test/";
const CHAIN = "https://portmandentex-fixtureton.example.test/";
const site = (url, name, text) => ({ title: name, url, text });
const own = (name, signal = "none") => ({ is_match: true, business_name: name, area: "Fixtureton", own_site: true, hidden_employer: false, signal, evidence: signal === "none" ? "" : "fixture evidence" });

test("groups and chains are set aside with their own reason, and are never offered as a local competitor", async () => {
  const { x, requests } = await outreachHouse(
    {
      about: { [PARK]: own("Fixture Park Dental", "weak_social"), [CHAIN]: own("PortmanDentex Fixtureton", "weak_social") },
      analysis: { "Fixture Park Dental": { ...ANALYSIS["Fixture Smile Dental"], contact_person: { name: "Pat Fixture-Principal", role: "Principal dentist", page: 1 }, part_of_group: told("Fixture Dental Group") } },
    },
    { reachOver: {
      sites: [site(PARK, "Fixture Park Dental", ""), site(CHAIN, "PortmanDentex Fixtureton", "")],
      pages: { [PARK]: "Fixture Park Dental, Fixtureton B1 4DD. Principal dentist: Pat Fixture-Principal. Call 0121 496 0005. Proudly part of the Fixture Dental Group, with over 120 practices nationwide." },
    } },
  );
  await run(x);
  const list = await prospects(x);
  const by = Object.fromEntries(list.map((p) => [p.name, p]));
  assert.deepEqual([by["Fixture Park Dental"].stage, by["Fixture Park Dental"].filter_reason], ["filtered_out", "part_of_group"], "its own page says it is part of a group");
  assert.deepEqual(by["Fixture Park Dental"].analysis.group, { value: "Fixture Dental Group", source_url: PARK });
  assert.equal(by["Fixture Park Dental"].contact_name, "Pat Fixture-Principal", "a principal at one of a group's clinics does not make it a prospect");
  // a group on the excluded list is set aside as soon as it is found: no analysis is spent on it
  assert.deepEqual([by["PortmanDentex Fixtureton"].stage, by["PortmanDentex Fixtureton"].filter_reason, by["PortmanDentex Fixtureton"].analysis], ["filtered_out", "part_of_group", null]);
  assert.ok(!requests.some((r) => r.stage === "analyse" && r.user.includes("PortmanDentex")));
  assert.equal(by["Fixture Smile Dental"].stage, "shortlisted");
  const competitors = await rows(h, "select p.name from prospect_competitors c join prospects p on p.prospect_id = c.competitor_id where c.tenant_id = $1 order by 1", [x.w.tenantId]);
  assert.deepEqual(competitors.map((c) => c.name), ["Fixture Glow Aesthetics", "Fixture Solo Dental"]);
  const [out] = await rows(h, "select body, data from outputs where tenant_id = $1", [x.w.tenantId]);
  assert.equal(out.data.tally.filtered_out.part_of_group, 2);
  assert.ok(!out.body.includes("| Fixture Park Dental") && !out.body.includes("PortmanDentex"));
  // found again another day, the group is simply already known
  assert.deepEqual(await record({ tenantId: x.w.tenantId, businessId: x.w.businessId }, found({ name: "PortmanDentex Fixtureton", website: CHAIN, postcode: undefined })), { recorded: false, why: "already_known" });
});

test("an advert older than the threshold is not a signal; a recent one says when it was posted", async () => {
  const OLD = "https://www.linkedin.com/jobs/view/333";
  const NEW = "https://www.linkedin.com/jobs/view/444";
  const advert = (name) => ({ is_match: true, business_name: name, area: "Fixtureton", own_site: false, hidden_employer: false, signal: "hiring_front_desk", evidence: "a receptionist" });
  const reachOver = { jobs: [
    item(OLD, "Receptionist", "Fixture Olden Dental, Fixtureton. Posted 5 months ago. 42 applicants."),
    item(NEW, "Patient coordinator", "Fixture Newly Dental, Fixtureton. 2 weeks ago."),
  ] };
  const { x, reach } = await outreachHouse({ about: { [OLD]: advert("Fixture Olden Dental"), [NEW]: advert("Fixture Newly Dental") } }, { reachOver });
  const sites = { '"Fixture Olden Dental"': "https://fixture-olden.example.test/", '"Fixture Newly Dental"': "https://fixture-newly.example.test/" };
  const search = reach.webSearch;
  reach.webSearch = async (query, limit) => {
    const hit = Object.keys(sites).find((name) => query.startsWith(name));
    return hit ? [item(sites[hit], hit.replaceAll('"', ""), "fixture")] : search(query, limit);
  };
  await run(x);
  const by = Object.fromEntries((await prospects(x)).map((p) => [p.name, p]));
  assert.deepEqual(by["Fixture Olden Dental"].signals, [], "recorded, so it is not found again, but with no signal");
  assert.deepEqual(by["Fixture Newly Dental"].signals.map((s) => [s.signal, s.evidence, s.advert_age_days]), [["hiring_front_desk", "Job advert: Patient coordinator (posted 2 weeks ago)", 14]]);
  const [out] = await rows(h, "select body, data from outputs where tenant_id = $1", [x.w.tenantId]);
  assert.equal(out.data.tally.stale_adverts, 1);
  assert.match(out.body, /1 job adverts were older than 60 days and were not counted as a signal/);
});

test("businesses found from an advert are analysed first; the others fill what is left of the batch", async () => {
  const ids = await seedTenant(h);
  const scope = { tenantId: ids.tenantId, businessId: ids.businessId, runId: null };
  const add = (name, signal, at) => recordProspect(h.gatewayDb, scope, found({ name, website: `https://${name.toLowerCase().replaceAll(" ", "-")}.example.test`, postcode: undefined, signal }), { now: new Date(NOW.getTime() + at) });
  await add("Fixture First Plain", "none", 0);
  await add("Fixture Second Plain", "weak_social", 1000);
  await add("Fixture Third Advert", "hiring_front_desk", 2000);
  await add("Fixture Fourth Advert", "hiring_front_desk", 3000);
  assert.deepEqual((await listForAnalysis(h.gatewayDb, scope, 3)).map((p) => p.name), ["Fixture Third Advert", "Fixture Fourth Advert", "Fixture First Plain"]);
});

test("a recruiter's advert is tied to a business by postcode only as unconfirmed, and that alone never passes the filter", async () => {
  const ids = await seedTenant(h);
  const scope = { tenantId: ids.tenantId, businessId: ids.businessId, runId: null };
  const add = (name, postcode) => recordProspect(h.gatewayDb, scope, found({ name, website: `https://${name.toLowerCase().replaceAll(" ", "-")}.example.test`, postcode, signal: "none" }), { now: NOW, searchArea: "Fixtureton" });
  const one = await add("Fixture One Dental", "B1 1AA");
  await add("Fixture Two Dental", "B2 2BB");
  await add("Fixture Three Dental", "B2 3CC");
  const advert = (text, n = 1) => ({ title: "Dental receptionist", url: `https://www.linkedin.com/jobs/view/90${n}`, text });
  const match = (a, area = "Fixtureton") => matchHiddenAdvert(h.gatewayDb, scope, a, area, NOW);
  assert.equal(await match(advert("Our client, a private practice in Fixtureton (B1 1AA), needs a receptionist.")), true, "a full postcode that one business has");
  assert.equal(await match(advert("Our client, a private practice in Fixtureton (B1 1AA), needs a receptionist.")), false, "the same advert is not added twice");
  assert.equal(await match(advert("A confidential client in the B2 area.", 2)), false, "two businesses in that district: no guess is made");
  assert.equal(await match(advert("A confidential client in Fixtureton.", 3)), false, "no postcode, no match");
  assert.equal(await match(advert("Our client in B1 1AA.", 4), "Elsewhere"), false, "only businesses found for that place");
  const [row] = await rows(h, "select signals from prospects where prospect_id = $1", [one.prospectId]);
  assert.deepEqual(row.signals.map((s) => [s.signal, s.unconfirmed, s.source_url]), [["hiring_front_desk", true, "https://www.linkedin.com/jobs/view/901"]]);
  assert.match(row.signals[0].evidence, /^UNCONFIRMED\. A recruiter's advert that does not name the employer, matched to this business by postcode only/);

  // analysed in full, with a named contact, a route, money and a confirmed company: still not a prospect on a guess
  const src = "https://fixture-one-dental.example.test/";
  const fact = (value) => ({ value, source_url: src });
  const stored = await recordAnalysis(h.gatewayDb, scope, one.prospectId, {
    what_they_sell: fact("fixture dentistry"), highest_value_service: fact("fixture implants"), staff_count: { count: 6, source_url: src }, locations: "not found", runs_ads: "not found",
    reviews: "not found", enquiry_routes: [{ kind: "phone", value: "0121 496 0009", source_url: src }], contact_person: { name: "Fixture Contact", role: "Owner", source_url: src },
    company_number: "not found", legal_form: "not found", postcode: "not found",
  }, { now: NOW, companiesHouse: { lookup: async () => ({ status: "yes", company: { name: "FIXTURE ONE DENTAL LTD", number: "09999999", status: "active", type: "ltd", postcode: null, matched_by: "name", source_url: "https://find-and-update.company-information.service.gov.uk/company/09999999" }, directors: [] }) } });
  assert.deepEqual(stored, { ok: true });
  const scored = await scoreAndFilter(h.gatewayDb, scope, DEFAULT_OUTREACH_SETTINGS, NOW);
  assert.deepEqual([scored.considered, scored.filtered, scored.passed.length], [1, { no_signal: 1 }, 0]);
  // with a confirmed signal the same business passes, and the guess still adds nothing to its score
  const two = await recordProspect(h.gatewayDb, scope, found({ name: "Fixture Nine Dental", website: "https://fixture-nine.example.test", postcode: "B9 9ZZ", signal: "weak_social" }), { now: NOW, searchArea: "Fixtureton" });
  await match(advert("Client at B9 9ZZ.", 5));
  await recordAnalysis(h.gatewayDb, scope, two.prospectId, {
    what_they_sell: "not found", highest_value_service: fact("fixture implants"), staff_count: "not found", locations: "not found", runs_ads: "not found", reviews: "not found",
    enquiry_routes: [{ kind: "phone", value: "0121 496 0010", source_url: "https://fixture-nine.example.test/" }], contact_person: { name: "Fixture Nine", role: "Owner", source_url: "https://fixture-nine.example.test/" },
    company_number: "not found", legal_form: "not found", postcode: "not found",
  }, { now: NOW, companiesHouse: null });
  const again = await scoreAndFilter(h.gatewayDb, scope, DEFAULT_OUTREACH_SETTINGS, NOW);
  assert.deepEqual([again.passed.length, again.passed[0].breakdown.signals], [1, 10], "weak social 10, and nothing for the unconfirmed advert");
});

test("a run makes only so many searches and page reads, reports the count, and carries on", async () => {
  const { x, reach } = await outreachHouse({}, { settings: { max_fetches_per_run: 10 } });
  await run(x);
  assert.equal(reach.calls.jobs.length + reach.calls.search.length + reach.calls.read.length, 10);
  const [out] = await rows(h, "select body, data from outputs where tenant_id = $1", [x.w.tenantId]);
  assert.deepEqual([out.data.fetches.fetched, out.data.fetches.refusedAtLimit > 0], [10, true]);
  assert.match(out.body, /Searches and page reads: 10 made, 0 from today's cache, \d+ not made at the limit/);
  assert.match(out.body, /The run reached its limit of 10 searches and page reads/);
});

// ---- the daily schedule ----

async function scheduledHouse(start, opts = {}) {
  const clock = makeClock(new Date(start));
  const play = fakeModel();
  const x = await makeHouse(h, { clock, outreach: { budget: opts.budget ?? 5, settings: SETTINGS }, model: play.model, reach: fakeReach(opts.reachOver ?? { noLeads: true }), server: false });
  open.push(x);
  if (opts.dailyAt !== null) await changeOutreachSettings(h.uiDb, x.w.tenantId, ROOM, { dailyAt: opts.dailyAt ?? "08:00" });
  const scheduler = () => createScheduler({ db: h.gatewayDb, tenantId: x.w.tenantId, now: clock.now, startRun: (roomId) => x.runtime.startRun(roomId, {}) });
  const scheduled = async () => (await allEvents(x)).filter((e) => e.type === "scheduled").map((e) => [e.department, e.reasonCode, e.summary]);
  const runsStarted = async () => (await rows(h, "select 1 from runs where tenant_id = $1 and trigger = 'outreach:find'", [x.w.tenantId])).length;
  return { x, clock, scheduler, scheduled, runsStarted };
}

test("the scheduler starts a room once its daily time has passed, once a day, and not again after a restart", async () => {
  const s = await scheduledHouse("2026-11-16T07:30:00Z");
  const first = s.scheduler();
  assert.deepEqual(await first.tick(), [], "07:30 in London: not yet");
  s.clock.advance(30 * 60 * 1000);
  assert.deepEqual(await first.tick(), [{ roomId: ROOM, outcome: "started" }]);
  await s.x.runtime.idle();
  assert.equal(await s.runsStarted(), 1);
  s.clock.advance(60 * 1000);
  assert.deepEqual(await first.tick(), [], "the same day, a minute later");
  // the runner restarts: a new scheduler with nothing in memory
  s.clock.advance(3 * 60 * 60 * 1000);
  assert.deepEqual(await s.scheduler().tick(), []);
  assert.equal(await s.runsStarted(), 1);
  assert.deepEqual(await s.scheduled(), [["outreach", "due", "Scheduled run due"], ["outreach", "started", "Scheduled run started"]]);
  // the next morning, a runner that only comes up at 09:40 still does the day's run, once
  s.clock.advance(22 * 60 * 60 * 1000 + 9 * 60 * 1000);
  const [a, b] = await Promise.all([s.scheduler().tick(), s.scheduler().tick()]);
  assert.deepEqual([...a, ...b], [{ roomId: ROOM, outcome: "started" }], "two runners looking at the same moment start one run");
  await s.x.runtime.idle();
  assert.equal(await s.runsStarted(), 2);
});

test("a scheduled run that cannot start is skipped for the day with a fixed reason, and unscheduled rooms are left alone", async () => {
  const s = await scheduledHouse("2026-11-16T08:05:00Z");
  await control.engageKillSwitch(h.gatewayDb, { tenantId: s.x.w.tenantId, businessId: null, memberId: s.x.w.ownerId, reason: "test fixture" });
  assert.deepEqual(await s.scheduler().tick(), [{ roomId: ROOM, outcome: "skipped", reason: "kill_switch" }]);
  await control.resumeKillSwitch(h.uiDb, { tenantId: s.x.w.tenantId, businessId: null, memberId: s.x.w.ownerId, reason: "test fixture" });
  s.clock.advance(60 * 60 * 1000);
  assert.deepEqual(await s.scheduler().tick(), [], "not tried again later the same day");
  assert.equal(await s.runsStarted(), 0);
  assert.deepEqual((await s.scheduled()).at(-1), ["outreach", "skipped_kill_switch", "Scheduled run skipped: the kill switch is set"]);

  // the next day the budget is already spent
  s.clock.advance(DAY);
  const spent = await control.startRun(h.gatewayDb, { tenantId: s.x.w.tenantId, businessId: s.x.w.businessId, department: "outreach", trigger: "test fixture", model: null }, { now: s.clock.now() });
  await control.finishRun(h.gatewayDb, { tenantId: s.x.w.tenantId, runId: spent.runId, status: "done", tokensIn: 0, tokensOut: 0, tokensCached: 0, costGbp: 5 }, { now: s.clock.now() });
  assert.deepEqual(await s.scheduler().tick(), [{ roomId: ROOM, outcome: "skipped", reason: "over_budget" }]);
  assert.deepEqual((await s.scheduled()).at(-1), ["outreach", "skipped_over_budget", "Scheduled run skipped: the daily budget is spent"]);
  // data and research are live on this floor with no daily time: nothing was ever scheduled for them
  assert.ok((await s.scheduled()).every(([department]) => department === "outreach"));

  const off = await scheduledHouse("2026-11-16T12:00:00Z", { dailyAt: null });
  assert.deepEqual(await off.scheduler().tick(), []);
  // British Summer Time: 07:10 UTC in July is 08:10 in London
  const summer = await scheduledHouse("2026-07-01T07:10:00Z");
  assert.deepEqual(await summer.scheduler().tick(), [{ roomId: ROOM, outcome: "started" }]);
  await summer.x.runtime.idle();
  const winter = await scheduledHouse("2026-11-16T07:10:00Z");
  assert.deepEqual(await winter.scheduler().tick(), []);
});

// ---- from the command line ----

test("settings can be read and changed by an owner through the UI's role, each change a new version", async () => {
  const { x } = await outreachHouse();
  const before = await readOutreachSettings(h.uiDb, x.w.tenantId, ROOM);
  assert.deepEqual([before.settings.areas_per_run, before.settings.find_per_run, before.dailyAt], [1, 50, null]);
  const after = await changeOutreachSettings(h.uiDb, x.w.tenantId, ROOM, {
    areasPerRun: 5, batchSize: 30, excludeGroups: ["Fixture Dental Group", "mydentist"], includeGroups: ["riverdale healthcare"], dailyAt: "08:00",
  });
  assert.deepEqual([after.settings.areas_per_run, after.settings.find_per_run, after.dailyAt], [5, 30, "08:00"]);
  assert.deepEqual(after.settings.excluded_groups, ["PortmanDentex", "Rodericks Dental Partners", "mydentist", "Colosseum Dental", "Thérapie Clinic", "Fixture Dental Group"]);
  assert.deepEqual(after.settings.areas, ["Fixtureton"], "what was not changed is kept");
  const versions = await rows(h, "select kind, version, changed_by_member, reason from config_versions where tenant_id = $1 and business_id = $2 and key = 'outreach' and kind in ('setting', 'schedule') order by kind, version", [x.w.tenantId, x.w.businessId]);
  assert.deepEqual(versions.map((v) => [v.kind, v.version, v.changed_by_member]), [["schedule", 1, x.w.ownerId], ["schedule", 2, x.w.ownerId], ["setting", 1, x.w.ownerId], ["setting", 2, x.w.ownerId]]);
  const [schedule] = await rows(h, "select value from config_versions where tenant_id = $1 and business_id = $2 and kind = 'schedule' and key = 'outreach' order by version desc limit 1", [x.w.tenantId, x.w.businessId]);
  assert.deepEqual(schedule.value, { live: true, daily_at: "08:00" }, "the live flag is kept");
  assert.equal((await changeOutreachSettings(h.uiDb, x.w.tenantId, ROOM, { dailyAt: "off" })).dailyAt, null);
  // nonsense is refused and nothing is stored; the gateway's role cannot change a setting at all
  await assert.rejects(changeOutreachSettings(h.uiDb, x.w.tenantId, ROOM, { batchSize: 0 }), (err) => err.code === "bad_settings");
  await assert.rejects(changeOutreachSettings(h.uiDb, x.w.tenantId, ROOM, { dailyAt: "8am" }), (err) => err.code === "invalid_request");
  await assert.rejects(changeOutreachSettings(h.uiDb, x.w.tenantId, "fixture-floor-one:nowhere", { batchSize: 5 }), (err) => err.code === "invalid_request");
  await assert.rejects(changeOutreachSettings(h.gatewayDb, x.w.tenantId, ROOM, { batchSize: 40 }), /row-level security/);
  assert.equal((await readOutreachSettings(h.uiDb, x.w.tenantId, ROOM)).settings.find_per_run, 30);
});

test("a website or a company number can be suppressed for good, with a reason", async () => {
  const ids = await seedTenant(h);
  assert.deepEqual(await suppress(h.uiDb, ids.tenantId, "https://www.Fixture-Smile.example.test/contact", "test fixture: asked not to be contacted"), { kind: "domain", added: true });
  assert.deepEqual(await suppress(h.uiDb, ids.tenantId, "fixture-smile.example.test", "test fixture: again"), { kind: "domain", added: false });
  assert.deepEqual(await suppress(h.uiDb, ids.tenantId, "1234567", "test fixture"), { kind: "company_number", added: true });
  assert.deepEqual(await suppress(h.uiDb, ids.tenantId, "SC123456", "test fixture"), { kind: "company_number", added: true });
  const stored = await rows(h, "select kind, value_key, reason, source, added_by from suppressions where tenant_id = $1 order by value_key", [ids.tenantId]);
  assert.deepEqual(stored.map((r) => [r.kind, r.value_key, r.source, r.added_by]), [
    ["company_number", "01234567", "manual", ids.ownerId], ["company_number", "SC123456", "manual", ids.ownerId], ["domain", "fixture-smile.example.test", "manual", ids.ownerId],
  ]);
  assert.equal(stored[2].reason, "test fixture: asked not to be contacted");
  assert.deepEqual(await record(ids, found()), { recorded: false, why: "suppressed" });
  for (const [value, reason] of [["not a website", "x"], ["", "x"], ["fixture.example.test", ""], ["fixture.example.test", "   "]]) {
    await assert.rejects(suppress(h.uiDb, ids.tenantId, value, reason), (err) => err.code === "invalid_request", `${value} / ${reason}`);
  }
  await assert.rejects(suppress(h.agentDb, ids.tenantId, "other.example.test", "agent tries"), /permission denied/);
});

// ---- third round: living within the search tool's limits ----

test("a rate limit stops that channel at once, a source that needs a login is left out, and with nothing to work with the run fails with a fixed reason", async () => {
  const { x, reach, requests } = await outreachHouse({}, { reachOver: { webLimited: true, needLogin: true }, settings: { areas: ["Aton", "Bton", "Cton"], areas_per_run: 3, front_desk_roles: ["receptionist", "front of house", "patient coordinator"] } });
  const runId = await run(x);
  assert.deepEqual([reach.calls.jobs.length, reach.calls.search.length, reach.calls.read.length], [1, 1, 0], "one call found out each limit; the other fourteen searches were never made");
  assert.equal(requests.length, 0);
  assert.deepEqual((await rows(h, "select status, error from runs where run_id = $1", [runId]))[0], { status: "failed", error: "search_rate_limited" });
  const stages = (await allEvents(x)).filter((e) => e.type === "stage");
  assert.deepEqual(stages.map((e) => [e.summary, e.reasonCode]), [
    ["Finding businesses", "find"],
    ["A source needs a signed in session and was left out of this run", "source_unavailable"],
    ["Web search reported a rate limit and was left alone for the rest of this run. Wait given: 2501 seconds", "rate_limited"],
    ["Stopped: the search tool's rate limit left nothing to work with", "stopped_rate_limited"],
  ]);
  assert.deepEqual(stages[2].payload, { channel: "web search", retry_after_seconds: 2501 });
  x.w.clock.advance(1000);
  assert.equal((await x.runtime.house()).rooms.find((r) => r.id === ROOM).state, "failed");
});

test("when only the job advert source needs a login, the run carries on with the others and says so", async () => {
  const { x, reach } = await outreachHouse({}, { reachOver: { needLogin: true }, settings: { front_desk_roles: ["receptionist", "front of house", "patient coordinator"] } });
  await run(x);
  assert.equal(reach.calls.jobs.length, 1, "asked once, not once per role");
  assert.deepEqual((await prospects(x)).map((p) => [p.name, p.stage, p.filter_reason]), [
    ["Fixture Glow Aesthetics", "filtered_out", "no_named_contact"], ["Fixture Smile Dental", "filtered_out", "no_signal"], ["Fixture Solo Dental", "filtered_out", "not_limited_company"],
  ]);
  const [out] = await rows(h, "select body, data from outputs where tenant_id = $1", [x.w.tenantId]);
  assert.match(out.body, /Job adverts from LinkedIn were not available on this run/);
  assert.ok(!out.body.includes("This run was cut short"));
  assert.deepEqual(out.data.cut_short, [{ channel: "linkedin jobs", why: "need_login", retry_after_seconds: null }]);
  assert.equal((await rows(h, "select status from runs where tenant_id = $1 and trigger = 'outreach:find'", [x.w.tenantId]))[0].status, "done");
});

test("cut short in the middle of analysis: what was analysed is shortlisted, the rest wait and come first next time", async () => {
  // five fetches to find, two to analyse the first business; the eighth call is refused by the tool
  const over = { webLimitedAfter: 7 };
  const { x, reach, requests } = await outreachHouse({}, { reachOver: over });
  await run(x);
  assert.equal(reach.calls.jobs.length + reach.calls.search.length + reach.calls.read.length, 8, "the refused call was the last one made");
  const list = await prospects(x);
  assert.deepEqual(list.map((p) => [p.name, p.stage, p.analysis_attempts]), [
    ["Fixture Glow Aesthetics", "found", 0], ["Fixture Smile Dental", "shortlisted", 0], ["Fixture Solo Dental", "found", 0],
  ], "the two not reached are not marked as failed");
  assert.deepEqual((await rows(h, "select trigger, status, error from runs where tenant_id = $1 order by trigger", [x.w.tenantId])).map((r) => [r.trigger, r.status, r.error]), [
    ["outreach:analyse", "done", null], ["outreach:draft", "done", null], ["outreach:find", "done", null],
  ]);
  const [out] = await rows(h, "select body, data from outputs where tenant_id = $1", [x.w.tenantId]);
  assert.ok(out.body.includes("**This run was cut short:** page reading reported a rate limit (wait given: 2501 seconds). 2 businesses are found and waiting to be analysed. They come first on the next run."), out.body.slice(0, 1500));
  assert.deepEqual([out.data.waiting_for_analysis, out.data.tally.analysed, out.data.tally.shortlisted], [2, 1, 1]);
  assert.deepEqual(out.data.cut_short.filter((c) => c.channel === "web read"), [{ channel: "web read", why: "rate_limited", retry_after_seconds: 2501 }], "it is the limit on reading pages that cuts a run short");
  assert.ok(out.body.includes("## 1. Fixture Smile Dental") && out.body.includes("No other business of this kind in this place is on the list yet"));

  // the next day the limit has lifted: the two that waited are analysed before anything new is looked for
  x.w.clock.advance(DAY);
  over.webLimitedAfter = undefined;
  requests.length = 0;
  const before = reach.calls.jobs.length;
  await run(x);
  assert.deepEqual(requests.map((r) => r.stage).slice(0, 3), ["analyse", "analyse", "find"]);
  assert.deepEqual((await rows(h, "select trigger from runs where tenant_id = $1 and started_at = $2 order by trigger", [x.w.tenantId, x.w.clock.now()])).map((r) => r.trigger), ["outreach:analyse", "outreach:find"]);
  assert.ok(reach.calls.jobs.length > before, "then it went looking for new ones");
  assert.deepEqual((await prospects(x)).map((p) => p.stage), ["filtered_out", "shortlisted", "filtered_out"]);
  const [, second] = await rows(h, "select body, data from outputs where tenant_id = $1 order by created_at", [x.w.tenantId]);
  assert.deepEqual([second.data.waiting_for_analysis, second.data.cut_short], [0, []]);
});

test("businesses waiting from earlier runs fill the batch before anything new is looked for", async () => {
  const { x, reach, requests } = await outreachHouse({}, { settings: { find_per_run: 2 } });
  const scope = { tenantId: x.w.tenantId, businessId: x.w.businessId, runId: null };
  for (const [name, url] of [["Fixture Smile Dental", SMILE], ["Fixture Glow Aesthetics", GLOW], ["Fixture Solo Dental", SOLO]]) {
    await recordProspect(h.gatewayDb, scope, found({ name, website: url, postcode: undefined, signal: "weak_social" }), { now: NOW, searchArea: "Fixtureton" });
  }
  const runId = await run(x);
  assert.deepEqual((await rows(h, "select trigger from runs where run_id = $1", [runId]))[0].trigger, "outreach:analyse");
  assert.deepEqual(requests.filter((r) => r.stage !== "draft").map((r) => r.stage), ["analyse", "analyse"]);
  assert.deepEqual([reach.calls.jobs.length, reach.calls.search.filter((q) => q.includes(" in Fixtureton")).length], [0, 0], "no search for new businesses was made");
  const [out] = await rows(h, "select body, data from outputs where tenant_id = $1", [x.w.tenantId]);
  assert.match(out.body, /Businesses left from earlier runs filled this run's batch of 2, so no new ones were looked for/);
  assert.match(out.body, /1 business is found and waiting to be analysed on the next run/);
  assert.equal(out.data.waiting_for_analysis, 1);
});

test("calls to the search tool are spaced out, and a place's advert searches stop when two in a row bring nothing new", async () => {
  const sleeps = [];
  const roles = ["receptionist", "front of house", "patient coordinator", "treatment coordinator", "practice administrator"];
  const paced = await outreachHouse({}, { sleep: async (ms) => void sleeps.push(ms), settings: { min_seconds_between_fetches: 2, front_desk_roles: roles } });
  await run(paced.x);
  const [out] = await rows(h, "select data from outputs where tenant_id = $1", [paced.x.w.tenantId]);
  assert.equal(sleeps.length, out.data.fetches.fetched - 1, "a wait before every call but the first");
  assert.ok(sleeps.every((ms) => ms > 1900 && ms <= 2000), JSON.stringify(sleeps));
  // the fixture returns the same two adverts for every role: the first search is new, the next two are not, so the last two roles are never searched
  assert.deepEqual(paced.reach.calls.jobs.map(([query]) => query), ["receptionist dental", "front of house dental", "patient coordinator dental"]);
  const barren = await outreachHouse({}, { reachOver: { noLeads: true }, settings: { front_desk_roles: roles, areas: ["Aton", "Bton"], areas_per_run: 2 } });
  await run(barren.x);
  assert.deepEqual(barren.reach.calls.jobs.map(([query, place]) => `${query} / ${place}`), ["receptionist dental / Aton", "front of house dental / Aton", "receptionist dental / Bton", "front of house dental / Bton"]);
});

test("a scheduled run that fails only on the rate limit is tried once more after the tool's wait, then the scheduler gives up for the day", async () => {
  const s = await scheduledHouse("2026-11-16T08:05:00Z", { reachOver: { webLimited: true, needLogin: true } });
  const scheduler = s.scheduler();
  assert.deepEqual(await scheduler.tick(), [{ roomId: ROOM, outcome: "started" }]);
  await s.x.runtime.idle();
  s.clock.advance(30 * 60 * 1000);
  assert.deepEqual(await scheduler.tick(), [], "the tool said to wait 2501 seconds: not yet");
  s.clock.advance(12 * 60 * 1000);
  assert.deepEqual(await s.scheduler().tick(), [{ roomId: ROOM, outcome: "retried" }], "42 minutes on, and from a restarted runner");
  await s.x.runtime.idle();
  s.clock.advance(60 * 1000);
  assert.deepEqual(await scheduler.tick(), [{ roomId: ROOM, outcome: "gave_up" }], "the second try failed on the limit too");
  s.clock.advance(3 * 60 * 60 * 1000);
  assert.deepEqual(await scheduler.tick(), [], "no third try, however long the day is");
  assert.equal(await s.runsStarted(), 2);
  assert.deepEqual((await s.scheduled()).map(([, code, summary]) => [code, summary]), [
    ["due", "Scheduled run due"], ["started", "Scheduled run started"],
    ["retry_due", "Scheduled run due again after the search tool's wait"], ["retry_started", "Scheduled run tried again after the search tool's wait"],
    ["gave_up", "Scheduled run gave up for the day: the second try failed too"],
  ]);
  // the next day starts afresh
  s.clock.advance(DAY - 3 * 60 * 60 * 1000); // 08:48 the next morning
  assert.deepEqual(await scheduler.tick(), [{ roomId: ROOM, outcome: "started" }]);
  await s.x.runtime.idle();
});

test("with no wait given the retry comes after an hour, and a run that failed for another reason is not retried", async () => {
  const s = await scheduledHouse("2026-11-16T08:05:00Z", { reachOver: { webLimited: true, needLogin: true, waitSeconds: null } });
  const scheduler = s.scheduler();
  await scheduler.tick();
  await s.x.runtime.idle();
  s.clock.advance(59 * 60 * 1000);
  assert.deepEqual(await scheduler.tick(), []);
  s.clock.advance(2 * 60 * 1000);
  assert.deepEqual(await scheduler.tick(), [{ roomId: ROOM, outcome: "retried" }]);
  await s.x.runtime.idle();

  const other = await scheduledHouse("2026-11-16T08:05:00Z", { reachOver: { fail: true } });
  await other.scheduler().tick();
  await other.x.runtime.idle();
  assert.equal((await rows(h, "select error from runs where tenant_id = $1", [other.x.w.tenantId]))[0].error, "find_failed");
  other.clock.advance(3 * 60 * 60 * 1000);
  assert.deepEqual(await other.scheduler().tick(), []);
  assert.equal(await other.runsStarted(), 1);
});

test("when finding gets nothing because of the limit but earlier businesses were analysed, the run still ends in a shortlist", async () => {
  // two fetches analyse the one business that was waiting; after that the web channel is limited and adverts need a login
  const { x, reach } = await outreachHouse({}, { reachOver: { webLimitedAfter: 2, needLogin: true } });
  await recordProspect(h.gatewayDb, { tenantId: x.w.tenantId, businessId: x.w.businessId, runId: null }, found({ website: SMILE, postcode: undefined, source_url: JOB }), { now: NOW, searchArea: "Fixtureton" });
  await run(x);
  assert.deepEqual((await rows(h, "select trigger, status, error from runs where tenant_id = $1 order by trigger", [x.w.tenantId])).map((r) => [r.trigger, r.status, r.error]), [
    ["outreach:analyse", "done", null], ["outreach:draft", "done", null], ["outreach:find", "done", null],
  ], "nothing failed: there was something to work with");
  assert.deepEqual([reach.calls.jobs.length, reach.calls.search.length, reach.calls.read.length], [1, 2, 1], "after the limit was reported once, the web channel was not asked again");
  const [out] = await rows(h, "select body, data from outputs where tenant_id = $1", [x.w.tenantId]);
  assert.deepEqual([out.data.tally.found, out.data.tally.analysed, out.data.tally.shortlisted], [0, 1, 1]);
  // searching was limited, reading was not: that is said, and the run is not called cut short
  assert.ok(!out.body.includes("This run was cut short"));
  assert.match(out.body, /Web search reported a rate limit \(wait given: 2501 seconds\) and was left alone for the rest of this run\. Page reading and everything else carried on\./);
  x.w.clock.advance(1000);
  assert.equal((await x.runtime.house()).rooms.find((r) => r.id === ROOM).state, "done");
});

test("when LinkedIn is paused upstream it is asked once, left alone for the rest of the run, and the shortlist says so", async () => {
  const { x, reach } = await outreachHouse({}, { reachOver: { paused: true }, settings: { front_desk_roles: ["receptionist", "front of house", "patient coordinator"] } });
  await run(x);
  assert.equal(reach.calls.jobs.length, 1, "not retried, and not asked about the other roles");
  const [out] = await rows(h, "select body, data from outputs where tenant_id = $1", [x.w.tenantId]);
  assert.match(out.body, /Job adverts from LinkedIn were paused by the source part way through this run \(it gave a wait of 118 seconds\)\. That source was left alone for the rest of the run, not retried\./);
  assert.deepEqual(out.data.cut_short, [{ channel: "linkedin jobs", why: "paused", retry_after_seconds: 118 }]);
  assert.ok((await stagesOf(x)).includes("A source was paused upstream and was left alone for the rest of this run. Wait given: 118 seconds"));
  assert.ok(out.data.tally.found >= 2, "the other sources still found businesses");
  const [runRow] = await rows(h, "select status, error from runs where tenant_id = $1 and trigger = 'outreach:find'", [x.w.tenantId]);
  assert.deepEqual([runRow.status, runRow.error], ["done", null]);
});
