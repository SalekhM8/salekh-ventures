// Prospecting: the pure parts (keys for deduplication, filter rules, score) and the
// Companies House connector with a stubbed HTTP layer. No database, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { domainKey, nameKey, namePostcodeHash, namesNearlyMatch, postcodeKey, shortHours } from "../dist/outreach/normalise.js";
import { DEFAULT_OUTREACH_SETTINGS, parseOutreachSettings } from "../dist/outreach/settings.js";
import { applyFilters, bestRoute, isGroup, leadAgentFor, lintDraft, namedGroup, scoreProspect } from "../dist/outreach/score.js";
import { advertAge } from "../dist/outreach/stages.js";
import { extractFromPages, pickPages } from "../dist/outreach/extract.js";
import { compare } from "../dist/outreach/store.js";
import { createAgentReachConnector, agentReachFromEnv, ReachError } from "../dist/control/connectors/agent-reach.js";
import { estimateCostUsd } from "../dist/agents/model-caller.js";
import { companiesHouseFromKey, createCompaniesHouseConnector } from "../dist/control/connectors/companies-house.js";

// ---- keys ----

test("a website is reduced to one key whatever its scheme, www, case, path or port", () => {
  const same = [
    "https://www.fixture-smile.example.test", "http://fixture-smile.example.test/", "HTTPS://WWW.Fixture-Smile.example.test/contact?x=1#top",
    "fixture-smile.example.test", "www.fixture-smile.example.test/treatments", "http://fixture-smile.example.test:8080/", " https://fixture-smile.example.test ",
  ];
  for (const url of same) assert.equal(domainKey(url), "fixture-smile.example.test", url);
  assert.equal(domainKey("https://book.fixture-smile.example.test"), "book.fixture-smile.example.test", "another host is another key");
  for (const bad of ["", null, undefined, "not a url", "mailto:x@example.test", "https://", "javascript:alert(1)"]) assert.equal(domainKey(bad), null, String(bad));
  // a page on a shared platform is not the business's own domain, so it is no key at all
  for (const shared of ["https://www.facebook.com/fixturesmile", "https://instagram.com/fixturesmile", "https://g.page/fixture", "https://www.google.com/maps/place/x", "https://linktr.ee/fixture"]) {
    assert.equal(domainKey(shared), null, shared);
  }
});

test("postcodes and names are normalised, and near identical names match", () => {
  assert.equal(postcodeKey("b1  1aa"), "B11AA");
  assert.equal(postcodeKey(" B1 1AA "), "B11AA");
  assert.equal(postcodeKey("not a postcode"), null);
  assert.equal(nameKey("The Fixture Smile Dental Clinic Ltd."), nameKey("fixture smile dental clinic limited"));
  assert.equal(nameKey("Fixture & Sons Dental"), nameKey("Fixture and Sons Dental"));
  assert.equal(namePostcodeHash("Fixture Smile Dental Ltd", "B1 1AA"), namePostcodeHash("FIXTURE SMILE DENTAL LIMITED", "b11aa"));
  assert.match(namePostcodeHash("Fixture Smile Dental", "B1 1AA"), /^[0-9a-f]{64}$/);
  assert.equal(namePostcodeHash("Fixture Smile Dental", null), null, "no postcode, no key");
  for (const [a, b] of [
    ["Fixture Smile Dental", "Fixture Smile Dental Clinic"], ["Fixture Smile Dental Practice", "Fixture Smile Dental"],
    ["Fixture Smile Dental Care", "The Fixture Smile Dental Centre"], ["Fixture Smile", "Fixture Smile Dental & Aesthetics"],
  ]) assert.equal(namesNearlyMatch(a, b), true, `${a} / ${b}`);
  for (const [a, b] of [["Fixture Smile Dental", "Fixture Glow Aesthetics"], ["Fixture Dental", "Another Dental"], ["Dental Clinic", "Dental Practice"]]) {
    assert.equal(namesNearlyMatch(a, b), false, `${a} / ${b}`);
  }
});

// ---- settings ----

test("settings: the first target, England worked through place by place, and a bad value refused", () => {
  const d = DEFAULT_OUTREACH_SETTINGS;
  assert.deepEqual([d.business_type, d.area, d.find_per_run, d.shortlist_size, d.areas_per_run], ["private dental and aesthetics clinics", "England", 50, 20, 8]);
  assert.ok(d.areas.length >= 30 && d.areas.includes("Birmingham") && d.areas.includes("Leeds") && new Set(d.areas).size === d.areas.length);
  assert.deepEqual(d.front_desk_roles, ["receptionist", "front of house", "patient coordinator", "treatment coordinator", "practice administrator"]);
  assert.deepEqual(d.signals, ["hiring_front_desk", "meta_ads", "weak_social", "poor_reviews"]);
  assert.deepEqual([d.advert_max_age_days, d.max_fetches_per_run, d.min_seconds_between_fetches, d.chain_locations, d.filters.exclude_groups], [60, 300, 1.5, 10, true]);
  assert.ok(d.excluded_groups.includes("PortmanDentex") && d.excluded_groups.includes("Rodericks Dental Partners"));
  assert.deepEqual(parseOutreachSettings({}), d, "missing fields take the defaults");
  assert.deepEqual(parseOutreachSettings({ areas: ["Leeds"], find_per_run: 5 }).areas, ["Leeds"]);
  for (const bad of [{ find_per_run: 0 }, { find_per_run: 5000 }, { signals: [] }, { signals: ["made_up"] }, { area: "" }, { front_desk_roles: [] }, { filters: { require_named_contact: "yes" } }, { unknown_setting: 1 }, "text", null]) {
    assert.throws(() => parseOutreachSettings(bad), (err) => err.code === "bad_settings", JSON.stringify(bad));
  }
});

// ---- filters and score ----

const src = "https://fixture-smile.example.test/about";
const full = (over = {}) => ({
  signals: ["hiring_front_desk"],
  isLimitedCompany: "yes",
  contactName: "Fixture Contact",
  routes: [{ kind: "email" }, { kind: "phone" }, { kind: "form" }],
  analysis: {
    what_they_sell: { value: "fixture dentistry", source_url: src },
    highest_value_service: { value: "fixture implants", source_url: src },
    staff_count: { count: 6, source_url: src },
    locations: { count: 1, source_url: src },
    runs_ads: { value: "no", source_url: src },
    reviews: "not found",
    legal_form: "not found",
  },
  ...over,
});
const S = DEFAULT_OUTREACH_SETTINGS;

test("filter rules: limited company, a named person, a sign of money and a way to enquire", () => {
  assert.deepEqual(applyFilters(full(), S), { keep: true });
  assert.deepEqual(applyFilters(full({ isLimitedCompany: "no" }), S), { keep: false, reason: "not_limited_company" });
  assert.deepEqual(applyFilters(full({ isLimitedCompany: "not_found" }), S), { keep: false, reason: "limited_company_not_confirmed" });
  assert.deepEqual(applyFilters(full({ isLimitedCompany: "not_checked" }), S), { keep: true }, "not checked is kept and flagged on the card");
  const strict = parseOutreachSettings({ filters: { allow_unchecked_limited_company: false } });
  assert.deepEqual(applyFilters(full({ isLimitedCompany: "not_checked" }), strict), { keep: false, reason: "limited_company_not_confirmed" });
  const soleTrader = full({ isLimitedCompany: "not_checked" });
  soleTrader.analysis.legal_form = { value: "sole_trader", source_url: src };
  assert.deepEqual(applyFilters(soleTrader, S), { keep: false, reason: "not_limited_company" }, "what the business says about itself counts");
  assert.deepEqual(applyFilters(full({ contactName: null }), S), { keep: false, reason: "no_named_contact" });
  assert.deepEqual(applyFilters(full({ signals: [] }), S), { keep: false, reason: "no_signal" });
  assert.deepEqual(applyFilters(full({ signals: [] }), parseOutreachSettings({ filters: { require_signal: false } })), { keep: true });
  assert.deepEqual(applyFilters(full({ routes: [] }), S), { keep: false, reason: "no_contact_route" });
  const poor = full();
  poor.analysis = { ...poor.analysis, highest_value_service: "not found", staff_count: { count: 2, source_url: src }, runs_ads: "not found" };
  assert.deepEqual(applyFilters(poor, S), { keep: false, reason: "no_money_signal" });
  for (const money of [{ staff_count: { count: 3, source_url: src } }, { runs_ads: { value: "yes", source_url: src } }, { locations: { count: 2, source_url: src } }, { highest_value_service: { value: "x", source_url: src } }]) {
    assert.deepEqual(applyFilters({ ...poor, analysis: { ...poor.analysis, ...money } }, S), { keep: true }, JSON.stringify(money));
  }
  assert.deepEqual(applyFilters({ ...full(), analysis: null }, S), { keep: false, reason: "not_analysed" });
  // each rule can be switched off in settings
  const loose = parseOutreachSettings({ filters: { require_named_contact: false, require_money_signal: false } });
  assert.deepEqual(applyFilters({ ...poor, contactName: null }, loose), { keep: true });
});

test("the score is the documented sum, and says reply speed is not part of it yet", () => {
  // signals 25 + money (service 10 + staff of 6: 10) 20 + reach (name 5 + email 1 + phone 3 + form 1) 10 + limited 10
  const a = scoreProspect(full(), S);
  assert.equal(a.score, 65);
  assert.deepEqual(a.breakdown, { signals: 25, money: 20, reach: 10, limited_company: 10, reply_speed: null, reply_speed_note: "not tested yet, so not part of this score" });
  // every signal at once is capped at 45, money at 30, routes at 10
  const b = full({ signals: ["hiring_front_desk", "meta_ads", "weak_social", "poor_reviews"], routes: [{ kind: "email" }, { kind: "whatsapp" }, { kind: "phone" }, { kind: "instagram" }, { kind: "form" }] });
  b.analysis = { ...b.analysis, runs_ads: { value: "yes", source_url: src }, locations: { count: 3, source_url: src } };
  assert.deepEqual(scoreProspect(b, S).breakdown, { signals: 45, money: 30, reach: 15, limited_company: 10, reply_speed: null, reply_speed_note: "not tested yet, so not part of this score" });
  assert.equal(scoreProspect(b, S).score, 100);
  // the least that can pass the filters
  const c = full({ signals: ["weak_social"], isLimitedCompany: "not_checked", routes: [{ kind: "form" }] });
  c.analysis = { ...c.analysis, highest_value_service: "not found", staff_count: { count: 3, source_url: src } };
  assert.deepEqual([scoreProspect(c, S).score, scoreProspect(c, S).breakdown.money, scoreProspect(c, S).breakdown.limited_company], [21, 5, 0]);
  // weights are settings
  const heavy = parseOutreachSettings({ score_weights: { signal: { weak_social: 40 } } });
  assert.equal(scoreProspect(c, heavy).breakdown.signals, 40);
  assert.equal(scoreProspect({ ...full(), signals: [] }, S).breakdown.signals, 0);
});

test("the lead agent comes from the strongest signal, by the strategy's table", () => {
  assert.equal(leadAgentFor(["hiring_front_desk"], S), "Enquiries");
  assert.equal(leadAgentFor(["meta_ads"], S), "Ads with data");
  assert.equal(leadAgentFor(["weak_social"], S), "Content");
  assert.equal(leadAgentFor(["weak_social", "meta_ads", "hiring_front_desk"], S), "Enquiries");
  assert.equal(leadAgentFor(["weak_social", "meta_ads"], S), "Ads with data");
});

test("the best route is one Salekh can use by hand, never email", () => {
  const r = (kind) => ({ kind, value: `${kind}-value` });
  assert.equal(bestRoute([r("email"), r("form"), r("phone"), r("instagram"), r("whatsapp")]).kind, "whatsapp");
  assert.equal(bestRoute([r("email"), r("form"), r("phone"), r("instagram")]).kind, "instagram");
  assert.deepEqual(bestRoute([r("email"), r("phone")]), { kind: "phone", value: "phone-value", why: "a phone number is published and nothing for direct messages was found, so a call is the direct way" });
  assert.equal(bestRoute([r("email"), r("form")]).kind, "form");
  assert.equal(bestRoute([r("email")]), null, "email alone is no route for him");
  assert.equal(bestRoute([]), null);
});

test("the comparison is one table with sources listed once, then only the differences that go against the prospect", () => {
  const one = "https://one.example.test/";
  const self = { prospect_id: "a", name: "Fixture One", website: null, reviews: { count: 41, rating: 3.9, source_url: one }, front_desk_advert: { advertised: true, source_url: "https://jobs.example.test/1" }, routes: [{ kind: "phone", source_url: one }], opening_hours: "not found", test_result: null };
  const two = { prospect_id: "b", name: "Fixture Two", website: null, reviews: { count: 120, rating: 4.8, source_url: "https://two.example.test/" }, front_desk_advert: "not found", routes: [{ kind: "phone", source_url: "https://two.example.test/" }, { kind: "whatsapp", source_url: "https://two.example.test/contact" }], opening_hours: { value: "Mon to Sat 9 to 6", source_url: "https://two.example.test/" }, test_result: null };
  const three = { prospect_id: "c", name: "Fixture | Three", website: null, reviews: { count: 10, rating: 3.1, source_url: "https://three.example.test/" }, front_desk_advert: "not found", routes: [], opening_hours: "not found", test_result: null };
  const got = compare(self, [two, three]);
  assert.equal(got.table, [
    "| | Fixture One | Fixture Two | Fixture / Three |",
    "| --- | --- | --- | --- |",
    "| Reviews | 3.9 from 41 [1] | 4.8 from 120 [2] | 3.1 from 10 [3] |",
    "| Ways to enquire | phone [1] | phone [2], whatsapp [4] | not found |",
    "| Front desk job advert | advert found [5] | not found | not found |",
    "| Opening hours | Hours not listed | Mon to Sat 9 to 6 [2] | Hours not listed |",
    "| Reply to the test enquiry | Not tested yet | Not tested yet | Not tested yet |",
    "| Capture score | Not tested yet | Not tested yet | Not tested yet |",
    "",
    "Sources:",
    "1. https://one.example.test/", "2. https://two.example.test/", "3. https://three.example.test/", "4. https://two.example.test/contact", "5. https://jobs.example.test/1",
  ].join("\n"));
  assert.deepEqual(got.unfavourable, [
    "Fixture Two publishes whatsapp for enquiries; this was not found for Fixture One.",
    "Fixture Two shows 4.8 from 120 reviews; Fixture One shows 3.9 from 41.",
    "Fixture Two publishes its opening hours; none were found for Fixture One.",
  ], "nothing is said about the competitor it does better than, and nothing about the advert");
  for (const line of got.unfavourable) assert.ok(!/\b(better|worse|best|poor|great|slow|fast|only|just|sadly|unfortunately)\b/i.test(line), line);
  assert.equal(compare(self, []), null);
});

test("a group or chain is recognised from its pages, the excluded list or the number of premises; a few sites of one owner is not a group", () => {
  const base = full();
  assert.equal(isGroup(base, S), false);
  assert.equal(isGroup({ ...base, analysis: { ...base.analysis, locations: { count: 3, source_url: src } } }, S), false, "an owner with three sites");
  assert.equal(isGroup({ ...base, analysis: { ...base.analysis, locations: { count: 10, source_url: src } } }, S), true);
  assert.equal(isGroup({ ...base, analysis: { ...base.analysis, group: { value: "Fixture Dental Group", source_url: src } } }, S), true);
  assert.equal(isGroup({ ...base, analysis: { ...base.analysis, group: "not found" } }, S), false);
  for (const name of ["PortmanDentex", "Portman Dentex Fixtureton", "RODERICKS DENTAL PARTNERS - Dudley", "mydentist, Fixture Road", "Therapie Clinic Fixtureton", "Thérapie Clinic"]) {
    assert.equal(isGroup({ ...base, name }, S), true, name);
  }
  assert.equal(isGroup({ ...base, website: "https://www.colosseumdental.co.uk/practices/fixture" }, S), true);
  assert.equal(isGroup({ ...base, companyName: "RIVERDALE HEALTHCARE LIMITED" }, S), true);
  assert.equal(namedGroup("Fixture Smile Dental", S), null);
  assert.deepEqual(applyFilters({ ...base, name: "PortmanDentex Fixtureton" }, S), { keep: false, reason: "part_of_group" });
  assert.deepEqual(applyFilters({ ...base, name: "PortmanDentex Fixtureton" }, parseOutreachSettings({ excluded_groups: [] })), { keep: true }, "the list is a setting");
  assert.deepEqual(applyFilters({ ...base, name: "PortmanDentex Fixtureton" }, parseOutreachSettings({ filters: { exclude_groups: false } })), { keep: true });
});

test("an advert's age is read from its own words", () => {
  assert.deepEqual(advertAge("Fixture Dental · Fixtureton · 3 weeks ago · 12 applicants"), { posted: "3 weeks ago", days: 21 });
  assert.deepEqual(advertAge("Posted 5 months ago"), { posted: "5 months ago", days: 150 });
  assert.deepEqual(advertAge("1 day ago"), { posted: "1 day ago", days: 1 });
  assert.deepEqual(advertAge("2 hours ago"), { posted: "2 hours ago", days: 0 });
  assert.deepEqual(advertAge("1 year ago"), { posted: "1 year ago", days: 365 });
  assert.equal(advertAge("Posted yesterday").days, 1);
  assert.equal(advertAge("A receptionist is wanted. Five years of experience."), null);
});

test("a draft that claims a test, quotes a number or reaches for hype is sent back", () => {
  const ok = { why: "They are advertising for a receptionist.", sample_reply: "Thanks for getting in touch. We can see you this week.", first_message: "I saw you are hiring for the front desk. I build an enquiries agent for dental clinics. Would a short call be useful?", call_opener: "I saw the front desk advert and had one idea." };
  assert.deepEqual(lintDraft(ok), []);
  const bad = {
    tested: { first_message: "We tested your enquiry form and it took you two days to reply." },
    mystery: { call_opener: "Our mystery enquiry showed a slow reply." },
    percent: { first_message: "Clinics like yours lose 40% of enquiries." },
    money: { first_message: "This would add £5,000 a month." },
    multiple: { why: "They would get 3x more bookings." },
    guarantee: { first_message: "We guarantee more bookings." },
    hype: { first_message: "Our revolutionary AI will transform your clinic." },
    long: { first_message: "word ".repeat(120) },
    email: { first_message: "Subject: quick idea\n\nI saw the advert." },
    letter: { first_message: "Dear Alex, I saw the advert. Kind regards" },
  };
  for (const [name, over] of Object.entries(bad)) assert.ok(lintDraft({ ...ok, ...over }).length > 0, name);
});

// ---- Companies House ----

const KEY = "fixture-ch-key-not-real";
function stub(routes) {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url: String(url), init });
    const u = new URL(String(url));
    const hit = routes[u.pathname + u.search] ?? routes[u.pathname];
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: (hit.status ?? 200) < 300, status: hit.status ?? 200, json: async () => hit.body };
  };
  return { calls, connector: createCompaniesHouseConnector({ apiKey: KEY, fetch: fetchStub }) };
}
const profile = (over = {}) => ({ company_name: "FIXTURE SMILE DENTAL LIMITED", company_number: "01234567", company_status: "active", type: "ltd", registered_office_address: { postal_code: "B1 1AA" }, ...over });
const officers = { items: [
  { name: "FIXTURE-DIRECTOR, Alex", officer_role: "director", appointed_on: "2020-01-01" },
  { name: "FIXTURE-OLD, Sam", officer_role: "director", appointed_on: "2010-01-01", resigned_on: "2019-01-01" },
  { name: "FIXTURE SECRETARIES LTD", officer_role: "corporate-secretary", appointed_on: "2020-01-01" },
] };

test("Companies House: a company number is looked up with the key as the basic auth user name", async () => {
  const { calls, connector } = stub({ "/company/01234567": { body: profile() }, "/company/01234567/officers": { body: officers } });
  const found = await connector.lookup({ number: "1234567", name: "Fixture Smile Dental" });
  assert.equal(found.status, "yes");
  assert.deepEqual(found.company, { name: "FIXTURE SMILE DENTAL LIMITED", number: "01234567", status: "active", type: "ltd", postcode: "B1 1AA", matched_by: "number", source_url: "https://find-and-update.company-information.service.gov.uk/company/01234567" });
  assert.deepEqual(found.directors, ["Alex Fixture-Director"], "active people who are directors, in reading order");
  assert.equal(calls[0].url, "https://api.company-information.service.gov.uk/company/01234567");
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`);
  assert.equal(calls[1].url, "https://api.company-information.service.gov.uk/company/01234567/officers?items_per_page=35");
});

test("Companies House: by name only an exact, single, active match counts", async () => {
  const item = (title, number, over = {}) => ({ title, company_number: number, company_status: "active", company_type: "ltd", address: { postal_code: "B1 1AA" }, ...over });
  const one = stub({ "/search/companies": { body: { items: [item("FIXTURE SMILE DENTAL LTD", "01234567"), item("FIXTURE SMILE HOLDINGS LIMITED", "07654321")] } }, "/company/01234567/officers": { body: officers } });
  const found = await one.connector.lookup({ name: "Fixture Smile Dental" });
  assert.deepEqual([found.status, found.company.number, found.company.matched_by], ["yes", "01234567", "name"]);
  assert.match(one.calls[0].url, /\/search\/companies\?q=Fixture%20Smile%20Dental&items_per_page=20$/);

  const two = stub({ "/search/companies": { body: { items: [item("FIXTURE SMILE DENTAL LTD", "01234567"), item("FIXTURE SMILE DENTAL LIMITED", "07654321")] } } });
  assert.equal((await two.connector.lookup({ name: "Fixture Smile Dental" })).status, "not_found", "two exact matches: not confident");
  const none = stub({ "/search/companies": { body: { items: [item("SOMETHING ELSE LTD", "01234567")] } } });
  assert.equal((await none.connector.lookup({ name: "Fixture Smile Dental" })).status, "not_found");
  const dissolved = stub({ "/search/companies": { body: { items: [item("FIXTURE SMILE DENTAL LTD", "01234567", { company_status: "dissolved" })] } } });
  assert.equal((await dissolved.connector.lookup({ name: "Fixture Smile Dental" })).status, "not_found");
  // the postcode picks between two exact matches
  const picked = stub({ "/search/companies": { body: { items: [item("FIXTURE SMILE DENTAL LTD", "01234567", { address: { postal_code: "M1 1AA" } }), item("FIXTURE SMILE DENTAL LIMITED", "07654321")] } }, "/company/07654321/officers": { body: { items: [] } } });
  assert.equal((await picked.connector.lookup({ name: "Fixture Smile Dental", postcode: "b1 1aa" })).company.number, "07654321");
});

test("Companies House: not limited, not there, an error, and no key", async () => {
  const partnership = stub({ "/company/LP012345": { body: profile({ company_number: "LP012345", type: "limited-partnership" }) } });
  assert.equal((await partnership.connector.lookup({ number: "LP012345", name: "x" })).status, "no");
  const gone = stub({ "/company/01234567": { body: profile({ company_status: "dissolved" }) } });
  assert.equal((await gone.connector.lookup({ number: "01234567", name: "x" })).status, "not_found");
  const missing = stub({ "/search/companies": { body: { items: [] } } });
  assert.equal((await missing.connector.lookup({ number: "09999999", name: "Fixture Nothing" })).status, "not_found", "an unknown number falls back to the name, then gives up");
  const refused = stub({ "/company/01234567": { status: 401, body: {} } });
  await assert.rejects(refused.connector.lookup({ number: "01234567", name: "x" }), (err) => err.code === "companies_house_http_401" && !String(err.message).includes(KEY));
  const limited = stub({ "/company/01234567": { status: 429, body: {} } });
  await assert.rejects(limited.connector.lookup({ number: "01234567", name: "x" }), (err) => err.code === "companies_house_http_429");
  await assert.rejects(stub({}).connector.lookup({ number: "../../x", name: "" }), (err) => err.code === "invalid_request");
  assert.equal(companiesHouseFromKey(undefined), null);
  assert.equal(companiesHouseFromKey(""), null);
  assert.ok(companiesHouseFromKey(KEY));
});

// ---- what code reads off a page ----

test("contact routes, a company number and a postcode are read off the pages by code", () => {
  const home = "https://fixture.example.test/";
  const contact = "https://fixture.example.test/contact";
  const got = extractFromPages([
    { url: home, text: "Fixture Clinic. Call 0121 496 0000 or +44 (0)121 496 0000. Follow https://www.instagram.com/fixtureclinic/ and facebook.com/fixtureclinic. logo@2x.png Website by Fixture Web Studio." },
    { url: contact, text: "Email Hello@Fixture.example.test or hello@fixture.example.test. WhatsApp: wa.me/447700900123. Use our contact form: Your name * Your message *. Fixture Clinic Ltd. Registered in England. Company No. 01234567. 1 Fixture St, Fixtureton B1 1AA. instagram.com/p/abc123" },
  ]);
  assert.deepEqual(got.routes, [
    { kind: "email", value: "hello@fixture.example.test", source_url: contact },
    { kind: "phone", value: "0121 496 0000", source_url: home },
    { kind: "whatsapp", value: "https://wa.me/447700900123", source_url: contact },
    { kind: "instagram", value: "https://instagram.com/fixtureclinic", source_url: home },
    { kind: "facebook", value: "https://facebook.com/fixtureclinic", source_url: home },
    { kind: "form", value: contact, source_url: contact },
  ]);
  assert.deepEqual(got.companyNumber, { value: "01234567", source_url: contact });
  assert.deepEqual(got.postcode, { value: "B1 1AA", source_url: contact });
  assert.deepEqual(got.websiteBuiltBy, { value: "Fixture Web Studio", source_url: home });
  assert.deepEqual(extractFromPages([{ url: home, text: "Nothing useful here." }]), { routes: [], companyNumber: null, postcode: null, websiteBuiltBy: null });
});

test("at most one page each of contact, about or team, and treatments or prices, and only from the business's own site", () => {
  const picked = pickPages([
    "https://fixture.example.test/", "https://fixture.example.test/blog/a-post", "https://fixture.example.test/contact-us", "https://fixture.example.test/contact-us/",
    "https://other.example.test/about", "https://www.fixture.example.test/meet-the-team", "https://fixture.example.test/about", "https://fixture.example.test/treatments/implants", "https://fixture.example.test/fees",
  ], "fixture.example.test", ["https://fixture.example.test/"]);
  assert.deepEqual(picked, ["https://fixture.example.test/contact-us", "https://www.fixture.example.test/meet-the-team", "https://fixture.example.test/treatments/implants"]);
});

// ---- the search tool ----

function reachStub(response) {
  const calls = [];
  const exec = async (bin, args, timeoutMs) => {
    calls.push({ bin, args, timeoutMs });
    if (response instanceof Error) throw response;
    return typeof response === "string" ? response : JSON.stringify(response);
  };
  return { calls, reach: createAgentReachConnector({ bin: "/fixture/bin/agent-reach", exec, timeoutMs: 20_000 }) };
}
const reply = (items) => ({ schema_version: 1, ok: true, items, error: null });

test("the search tool is run with fixed arguments, a timeout and a cap on what is kept", async () => {
  const { calls, reach } = reachStub(reply([{ title: "Fixture", url: "https://fixture.example.test/", text: "t".repeat(20_000) }, { title: null, url: "not a url", text: "x" }]));
  const found = await reach.webSearch("fixture clinics in Fixtureton", 10);
  assert.deepEqual([found.length, found[0].url, found[0].text.length], [1, "https://fixture.example.test/", 1500]);
  assert.deepEqual(calls[0], { bin: "/fixture/bin/agent-reach", args: ["web", "search", "fixture clinics in Fixtureton", "--limit", "10", "--timeout", "18"], timeoutMs: 20_000 });
  const page = await reach.webRead("https://fixture.example.test/contact");
  assert.equal(page.text.length, 6000, "a page is cut to 6,000 characters");
  assert.deepEqual(calls[1].args, ["web", "read", "https://fixture.example.test/contact", "--timeout", "18"]);
  await reach.jobs("receptionist dental", "Fixtureton", 99);
  assert.deepEqual(calls[2].args, ["linkedin", "jobs", "receptionist dental", "--limit", "25", "--timeout", "18"]);
  // a query cannot be read as an option, and only these channels can ever be run
  await reach.webSearch("  --backend opencli instagram", 5);
  assert.deepEqual(calls[3].args.slice(0, 3), ["web", "search", "backend opencli instagram"]);
  for (const call of calls) assert.ok(["web", "linkedin"].includes(call.args[0]) && ["search", "read", "jobs"].includes(call.args[1]));
  assert.deepEqual(Object.keys(reach).sort(), ["jobRead", "jobs", "webRead", "webSearch"]);
});

test("job adverts only: no LinkedIn profile, company or people page is ever read or kept", async () => {
  const { calls, reach } = reachStub(reply([
    { title: "Receptionist", url: "https://www.linkedin.com/jobs/view/111", text: "advert", raw: { location: "Fixtureton, England, United Kingdom" } },
    { title: "A person", url: "https://www.linkedin.com/in/fixture-person", text: "profile" },
    { title: "People", url: "https://www.linkedin.com/company/fixture/people/", text: "people" },
  ]));
  assert.deepEqual((await reach.jobs("receptionist", "Fixtureton", 5)).map((i) => i.url), ["https://www.linkedin.com/jobs/view/111"]);
  assert.ok(!(await reach.webSearch("fixture", 5)).some((i) => i.url.includes("/in/")), "a profile is dropped from search results too");
  const before = calls.length;
  for (const url of ["https://www.linkedin.com/in/fixture-person", "https://uk.linkedin.com/pub/fixture/1/2/3", "https://www.linkedin.com/company/fixture/people/", "https://www.linkedin.com/jobs/view/111", "https://www.google.com/url?q=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fx"]) {
    await assert.rejects(reach.webRead(url), (err) => err.code === "url_blocked", url);
  }
  for (const url of ["https://www.linkedin.com/in/fixture-person", "https://www.linkedin.com/company/fixture/", "https://fixture.example.test/jobs/view/1"]) {
    await assert.rejects(reach.jobRead(url), (err) => err.code === "url_blocked", url);
  }
  await assert.rejects(reach.webRead("file:///etc/passwd"), (err) => err.code === "invalid_request");
  assert.equal(calls.length, before, "the tool was not run for any of them");
  await reach.jobRead("https://www.linkedin.com/jobs/view/111");
  assert.deepEqual(calls.at(-1).args.slice(0, 3), ["linkedin", "read", "https://www.linkedin.com/jobs/view/111"]);
});

test("a tool that fails, times out, refuses or talks nonsense is a fixed failure, and no path means no connector", async () => {
  for (const bad of [new Error("fixture: spawn failed"), "not json", { ok: false, items: [], error: "blocked" }, { ok: true }]) {
    await assert.rejects(reachStub(bad).reach.webSearch("fixture", 5), (err) => err.code === "reach_failed", JSON.stringify(String(bad)));
  }
  await assert.rejects(reachStub(reply([])).reach.webSearch("   ", 5), (err) => err.code === "invalid_request");
  assert.equal(agentReachFromEnv(undefined), null);
  assert.equal(agentReachFromEnv(""), null);
});

test("the cost of a call is worked out from list prices, and the cheap model's long prompt rate is known", () => {
  const usage = (inputTokens, outputTokens) => ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0 });
  assert.equal(estimateCostUsd("claude-haiku-5-5", usage(1_000_000, 1_000_000)), 3, "over 100,000 tokens of prompt: five times 0.10 and 0.50");
  assert.equal(estimateCostUsd("claude-haiku-5-5", usage(10_000, 1_000)), 0.0015);
  assert.equal(estimateCostUsd("claude-sonnet-5-5", usage(10_000, 1_000)), 0.03);
  assert.equal(estimateCostUsd("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0 }), 0.1);
  assert.equal(estimateCostUsd("unknown-model", usage(10_000, 1_000)), 0);
});

test("the tool's own error codes are read: a rate limit with its wait, a source that needs a login, and anything else", async () => {
  // the exact answers the tool gave on 15 Nov 2026
  const limited = { schema_version: 1, ok: false, channel: "web", action: "search", backend: null, items: [], meta: { elapsed_ms: 1, attempts: [] }, error: { code: "RATE_LIMITED", message: "Platform reported a rate limit", hint: "Wait 2501 seconds before retrying this channel." } };
  const login = { schema_version: 1, ok: false, channel: "linkedin", action: "jobs", backend: null, items: [], meta: { elapsed_ms: 4272, attempts: [{ backend: "opencli", result: "NEED_LOGIN", message: "LinkedIn search requires an active signed-in LinkedIn browser session" }] }, error: { code: "NEED_LOGIN", message: "LinkedIn search requires an active signed-in LinkedIn browser session", hint: "Run `agent-reach login linkedin` and ask the user to log in to linkedin.com in the Agent Reach browser window it opens. Never log in for them." } };
  const is = (code, seconds) => (err) => err instanceof ReachError && err.code === code && err.retryAfterSeconds === seconds;
  await assert.rejects(reachStub(limited).reach.webSearch("fixture", 5), is("reach_rate_limited", 2501));
  await assert.rejects(reachStub(limited).reach.webRead("https://fixture.example.test/"), is("reach_rate_limited", 2501));
  await assert.rejects(reachStub({ ...limited, error: { code: "RATE_LIMITED", message: "x" } }).reach.webSearch("fixture", 5), is("reach_rate_limited", null), "no hint, no wait");
  await assert.rejects(reachStub(login).reach.jobs("receptionist", "Fixtureton", 5), is("reach_need_login", null));
  await assert.rejects(reachStub({ ...limited, error: { code: "SOMETHING_NEW", message: "x", hint: "Wait 5 seconds" } }).reach.webSearch("fixture", 5), is("reach_failed", null));
  await assert.rejects(reachStub({ ok: false }).reach.webSearch("fixture", 5), is("reach_failed", null));
});

test("LinkedIn job adverts: searched nationally with no --location, once per query, and matched to a place by the advert's own location", async () => {
  // The shape of a real answer, read on 16 Nov 2026, with fixture names: the advert's text is null and its facts are under `raw`.
  const advert = (n, company, location) => ({
    title: "Dental Receptionist", url: `https://www.linkedin.com/jobs/view/90000${n}`, author: null, published_at: null, text: null,
    raw: { rank: n, title: "Dental Receptionist", company, location, listed: "2026-11-13", salary: "29K GBP/yr", url: `https://www.linkedin.com/jobs/view/90000${n}` },
  });
  const { calls, reach } = reachStub({ schema_version: 1, ok: true, channel: "linkedin", action: "jobs", backend: "opencli", error: null, meta: { attempts: [{ backend: "opencli", result: "ok" }] }, items: [
    advert(1, "Fixture Smile Dental", "Fixtureton, England, United Kingdom"), advert(2, "Fixture Other Clinic", "Elsewhere, England, United Kingdom"), advert(3, "Fixture No Place", null),
  ] });
  const here = await reach.jobs("dental receptionist", "Fixtureton", 25);
  assert.deepEqual(here, [{ title: "Dental Receptionist", url: "https://www.linkedin.com/jobs/view/900001", text: "Employer: Fixture Smile Dental. Location: Fixtureton, England, United Kingdom. Listed: 2026-11-13.", location: "Fixtureton, England, United Kingdom" }]);
  assert.deepEqual((await reach.jobs("dental receptionist", "Elsewhere, England", 25)).map((i) => i.url), ["https://www.linkedin.com/jobs/view/900002"]);
  assert.deepEqual(await reach.jobs("dental receptionist", "Nowhere", 25), [], "an advert with no location, or another place's, is not offered for this place");
  assert.equal((await reach.jobs("dental receptionist", "", 25)).length, 3, "no place: everything the search gave");
  assert.equal(calls.length, 1, "four places, one call");
  assert.ok(!calls[0].args.includes("--location"));
  await reach.jobs("clinic receptionist", "Fixtureton", 25);
  assert.equal(calls.length, 2, "another query is another call");
});

test("an upstream failure that pauses the channel is its own state, with the wait the tool gave; without a wait it is an ordinary failure", async () => {
  const broken = (attempts) => ({ schema_version: 1, ok: false, channel: "linkedin", action: "jobs", backend: null, items: [], meta: { elapsed_ms: 900, attempts }, error: { code: "UPSTREAM_BROKEN", message: "LinkedIn API error: HTTP 400", hint: null } });
  const is = (code, seconds) => (err) => err instanceof ReachError && err.code === code && err.retryAfterSeconds === seconds;
  await assert.rejects(reachStub(broken([{ backend: "opencli", result: "UPSTREAM_BROKEN", retry_after_seconds: 118.4 }])).reach.jobs("receptionist", "Fixtureton", 5), is("reach_paused", 119));
  await assert.rejects(reachStub(broken([{ backend: "opencli", result: "UPSTREAM_BROKEN" }])).reach.jobs("receptionist", "Fixtureton", 5), is("reach_failed", null));
  await assert.rejects(reachStub(broken(undefined)).reach.jobs("receptionist", "Fixtureton", 5), is("reach_failed", null));
});

test("opening hours are short in the rivals table: days with the same hours joined, never the long raw text", () => {
  const g = (d, h) => `${d}: ${h}`;
  const nine = "9:00 AM – 5:00 PM";
  const google = [g("Monday", nine), g("Tuesday", nine), g("Wednesday", nine), g("Thursday", "9:00 AM – 7:30 PM"), g("Friday", nine), g("Saturday", "10:00 AM – 2:00 PM"), g("Sunday", "Closed")].join("; ");
  assert.equal(shortHours(google), "Mon–Wed 9–5, Thu 9–7:30, Fri 9–5, Sat 10–2, Sun closed");
  assert.equal(shortHours("Monday: Open 24 hours; Tuesday: 8:30 AM – 1:00 PM, 2:00 – 6:00 PM"), "Mon 24 hours, Tue 8:30–1 & 2–6");
  assert.equal(shortHours("Monday: 09:00–17:00; Tuesday: 09:00–17:00"), "Mon–Tue 9–17");
  assert.equal(shortHours("Mon to Fri 9 to 5"), "Mon to Fri 9 to 5", "short text from a page is kept");
  const long = shortHours("We are open Monday to Friday from nine in the morning until half past five in the evening, and Saturdays by appointment");
  assert.ok(long.length <= 49 && long.endsWith("…"), long);
  for (const none of ["not found", "", null, undefined, 5]) assert.equal(shortHours(none), "Hours not listed");
});
