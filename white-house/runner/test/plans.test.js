// The Closer: a one-page plan before the next call, against a real Postgres. No model: a fake in memory.
// Every name, address and figure here is a TEST FIXTURE.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { openHarness, rows } from "./helpers.js";
import { makeHouse, makeWhRoot } from "./house-helpers.js";
import { createScriptedModel } from "../dist/agents/model-caller.js";
import { recordAnalysis, recordProspect } from "../dist/outreach/store.js";
import { foundBlock, lintPlanPart, modelFacts, priceBlock, renderPlan, PRICE_LIST } from "../dist/outreach/plans.js";
import { estimateLeak } from "../dist/outreach/enquiry-rules.js";
import { DEFAULT_OUTREACH_SETTINGS, forType } from "../dist/outreach/settings.js";
import { STAGE_SCHEMAS } from "../dist/outreach/stages.js";

const h = openHarness();
const open = [];
after(async () => {
  await Promise.all(open.filter((x) => x.close).map((x) => x.close()));
  await h.close();
});
const ROOM = "fixture-floor-one:outreach";

const GOOD = {
  opening: "Thanks for picking up last time. I sent an enquiry as a test and nobody replied in the first 24 hours, so I wanted to show you what that looks like from the other side.",
  setup: [
    "An agent that answers every enquiry within minutes, day and night, once it's connected to your inbox.",
    "Chasing people who asked a question and then went quiet.",
    "Booking people straight into a consultation slot you choose.",
  ],
  objections: [
    { objection: "We already reply to everyone.", answer: "That's good to hear. The test is the honest picture of one evening, and I'm happy to send another so you can see it yourself." },
    { objection: "Is it going to sound like a robot?", answer: "Every reply is in your words and you approve how it talks before it goes live." },
    { objection: "What does it cost?", answer: "It's a monthly fee with a setup cost, and I'll go through it with you now." },
  ],
  next_step: "Ask for a short slot this week to set up the first agent together.",
};

const NOTE = "Spoke to FIXTURE-PERSON Jo. Keen. Says they lose maybe £800 a month. Wants a plan before Friday.";

async function world(opts = {}) {
  const whRoot = makeWhRoot();
  writeFileSync(path.join(whRoot, "agents", "outreach-closer.md"), "# Fixture closer role\n");
  writeFileSync(path.join(whRoot, "agents", "outreach-followup.md"), "# Fixture follow-up role\n");
  const requests = [];
  const model = createScriptedModel(async (request) => {
    requests.push(request);
    if (request.stage === "plan") return { data: (await opts.part?.(request, requests.filter((r) => r.stage === "plan").length)) ?? GOOD, costUsd: 0.02, usage: { inputTokens: 100, outputTokens: 50 } };
    if (request.stage === "followup") return { data: { subject: "Following up", body: "Hi,\n\nThanks.\n\nWould a 20-minute call this week suit you?\n\nSalekh Mahmood, Salekh Ventures" }, costUsd: 0.01, usage: { inputTokens: 10, outputTokens: 5 } };
    throw new Error(`fixture: no model call expected at ${request.stage}`);
  });
  const x = await makeHouse(h, { outreach: { budget: 5 }, model, whRoot });
  open.push(x);
  const scope = { tenantId: x.w.tenantId, businessId: x.w.businessId, runId: null };
  return { x, scope, requests };
}

/** One clinic, analysed, tested (nobody replied), with its own published price; and a rival that replied in 4 minutes. */
async function clinic(t, key, { rival = true } = {}) {
  const site = `https://fixture-${key}.example.test/`;
  const name = `Fixture ${key[0].toUpperCase()}${key.slice(1)} Dental`;
  const now = t.x.w.clock.now();
  const made = await recordProspect(h.gatewayDb, t.scope, { name, website: site, postcode: `B1 ${key.length}AA`, area: "Fixtureton", signal: "weak_social", evidence: "fixture", source_url: site }, { now, searchArea: "Fixtureton" });
  assert.equal(made.recorded, true);
  const fact = (value) => ({ value, source_url: site });
  await recordAnalysis(h.gatewayDb, t.scope, made.prospectId, {
    what_they_sell: fact("fixture implants from £2,750"), highest_value_service: fact("fixture implants"),
    highest_value_price: { amount: 2750, source_url: `${site}prices` },
    staff_count: { count: 6, source_url: site }, locations: "not found", runs_ads: "not found", reviews: "not found",
    enquiry_routes: [{ kind: "email", value: `published@fixture-${key}.example.test`, source_url: site }],
    contact_person: { name: `Fixture ${key} Owner`, role: "Owner", source_url: site },
    company_number: "not found", legal_form: "not found", postcode: "not found",
  }, { now, companiesHouse: null });
  const sentAt = "2026-11-17T10:57:00.000Z";
  await h.admin.query(`update prospects set capture_score = 12, test_result = $2::jsonb where prospect_id = $1`,
    [made.prospectId, JSON.stringify({ enquiry_id: "00000000-0000-4000-8000-000000000001", sent_at: sentAt, replies: [], slot: "in_hours" })]);
  if (rival) {
    const r = await recordProspect(h.gatewayDb, t.scope, { name: `Fixture Quick ${key}`, website: `https://quick-${key}.example.test/`, postcode: "B2 1AA", area: "Fixtureton", signal: "weak_social", evidence: "fixture", source_url: site }, { now, searchArea: "Fixtureton" });
    await h.admin.query(`insert into prospect_competitors (tenant_id, business_id, prospect_id, competitor_id, comparison) values ($1, $2, $3, $4, $5::jsonb)`,
      [t.x.w.tenantId, t.x.w.businessId, made.prospectId, r.prospectId, JSON.stringify({ prospect_id: r.prospectId, name: `Fixture Quick ${key}`, tested: "scored", reply_minutes: 4, slot: "in_hours" })]);
  }
  return { id: made.prospectId, name };
}

const call = (t, id, body) => t.x.call("POST", `/v1/prospects/${id}/outcome`, body);
const plansOf = async (t) => (await t.x.call("GET", `/v1/rooms/${ROOM}/plans`)).body;

// ---- the code checks ----

test("the price is written by code from the strategy's list: never invented, and an amount it does not give says 'you set this'", () => {
  const block = priceBlock();
  assert.match(block, /One agent: about £250 to £500 a month\./);
  assert.match(block, /A bundle: £1,500 to £5,000 a month, for three or more agents\./);
  assert.match(block, /Setup fee: you set this\./, "the strategy gives no setup amount, so none is made up");
  assert.match(block, /Never guarantee sales or a return/);
  // every pound figure in the price block is one written in the list
  const listed = new Set(JSON.stringify(PRICE_LIST).match(/£[\d,]+/g));
  for (const figure of block.match(/£[\d,]+/g)) assert.ok(listed.has(figure), `${figure} is not in the price list`);
  // with an amount set, it is said as set
  assert.match(priceBlock({ ...PRICE_LIST, setup_fee: "£900" }), /Setup fee: £900\./);
});

test("the model's part: no £ or %, no made-up numbers, no semicolons or dashes, no clichés or promises, three to five of each", () => {
  const allowed = ["24"];
  assert.deepEqual(lintPlanPart(GOOD, allowed), []);
  const refuses = (part, pattern) => assert.ok(lintPlanPart(part, allowed).some((p) => pattern.test(p)), JSON.stringify(lintPlanPart(part, allowed)));
  const opening = (text) => ({ ...GOOD, opening: text });
  refuses(opening("It's only £300 a month."), /money figure/);
  refuses(opening("You lose 30% of enquiries."), /money figure/);
  refuses(opening("It costs a few hundred pounds."), /money figure/);
  refuses({ ...GOOD, objections: [...GOOD.objections.slice(0, 2), { objection: "Price?", answer: "Setup is 900 and then it's monthly." }] }, /numbers that are not in the facts given: 900/);
  refuses(opening("We helped 14 clinics last month."), /numbers that are not in the facts given: 14/);
  refuses(opening("Thanks for the call; I tested you."), /semicolon/);
  refuses(opening("Thanks for the call — I tested you."), /dash/);
  refuses(opening("This will streamline your front desk."), /cliché/);
  refuses(opening("I guarantee more patients."), /promise/);
  refuses(opening("It is already connected to your booking system."), /already connected/);
  refuses({ ...GOOD, setup: GOOD.setup.slice(0, 2) }, /three to five setup/);
  refuses({ ...GOOD, objections: GOOD.objections.slice(0, 1) }, /three to five objections/);
  assert.ok(Object.keys(STAGE_SCHEMAS).includes("plan"));
});

test("the facts the model is given carry no price, no leak and no figure from the note", () => {
  const leak = { estimated: true, low: 4111, high: 9333, basis: "own_price", workings: "£2,750 (their published price) × assumptions" };
  const f = { business: "Fixture Clinic", area: "Fixtureton", kind: "clinics", outcome: "interested", note: NOTE, captureScore: 12, test: "I sent an enquiry as a test and nobody replied in the first 24 hours.", rival: "Fixture Quick replied to the same kind of enquiry in 4 minutes.", findings: null, leak };
  const m = modelFacts(f);
  for (const secret of ["£", "%", "800", "2,750", "4111", "4,111", "9333", "9,333"]) assert.ok(!m.text.includes(secret), `the model was given "${secret}"`);
  assert.ok(m.text.includes("FIXTURE-PERSON"), "the note, figures taken out");
  assert.ok(m.numbers.includes("24") && m.numbers.includes("4"));
  // the leak goes in the code's part, said as an estimate with its workings
  const found = foundBlock(f);
  assert.match(found, /Could be losing: £4,111 to £9,333 a month\.\*\* This is an estimate, not a measurement\./);
  assert.match(found, /Workings: £2,750 \(their published price\)/);
  const body = renderPlan(f, GOOD);
  assert.match(body, /^# Plan for Fixture Clinic/);
  assert.match(body, /nothing here is sent to them/);
  assert.match(body, /## Price/);
});

// ---- the database and the API ----

test("interested or meeting booked writes a plan by itself; no answer, call back or wrong person do not; the plan's facts match the stored profile", async () => {
  const t = await world();
  const [a, b, c, d] = [await clinic(t, "alpha"), await clinic(t, "beta"), await clinic(t, "gamma"), await clinic(t, "delta", { rival: false })];
  for (const [p, outcome] of [[a, "no_answer"], [b, "call_back"], [c, "wrong_person"]]) assert.equal((await call(t, p.id, { outcome })).status, 200);
  await t.x.runtime.idle();
  assert.equal(t.requests.filter((r) => r.stage === "plan").length, 0);
  assert.deepEqual((await plansOf(t)).plans, []);

  t.x.w.clock.advance(60 * 60 * 1000); // a later call
  assert.equal((await call(t, a.id, { outcome: "interested", note: NOTE })).status, 200);
  assert.equal((await call(t, d.id, { outcome: "meeting_booked" })).status, 200);
  await t.x.runtime.idle();
  const listed = await plansOf(t);
  assert.deepEqual(listed.plans.map((p) => [p.prospectId, p.trigger]).sort(), [[a.id, "outcome"], [d.id, "outcome"]].sort());
  assert.deepEqual(listed.making, []);

  const plan = listed.plans.find((p) => p.prospectId === a.id);
  // the facts, as stored: the test, the rival, the score and the leak worked out exactly as the card works it out
  const settings = forType(DEFAULT_OUTREACH_SETTINGS, "clinics");
  const leak = estimateLeak({ amount: 2750, source_url: "https://fixture-alpha.example.test/prices" }, { minutesToReply: null }, settings);
  assert.equal(leak.estimated, true);
  assert.ok(plan.body.includes(`Could be losing: £${leak.low.toLocaleString("en-GB")} to £${leak.high.toLocaleString("en-GB")} a month.`), plan.body);
  assert.ok(plan.body.includes(`Workings: ${leak.workings}.`));
  assert.ok(plan.body.includes("Test: I sent an enquiry as a test and nobody replied in the first 24 hours."));
  assert.ok(plan.body.includes("Fastest rival: Fixture Quick alpha replied to the same kind of enquiry in 4 minutes."));
  assert.ok(plan.body.includes("- Fixture Alpha Dental (you): no reply within 24 hours"));
  assert.ok(plan.body.includes("Score: 12 out of 100."), plan.body);
  assert.ok(plan.body.includes(GOOD.opening) && plan.body.includes(GOOD.next_step));
  const [stored] = await rows(h, "select facts, trigger, call_outcome_id, model from plans where plan_id = $1", [plan.id]);
  assert.equal(stored.facts.leak.low, leak.low);
  assert.equal(stored.facts.note, NOTE, "Salekh's own note, kept as he wrote it");
  assert.equal(stored.model, "claude-sonnet-5-5");
  assert.ok(stored.call_outcome_id);
  // the only pound figures in the plan are the leak, its workings and the price list: nothing else
  const allowed = new Set([...(leak.workings.match(/£[\d,]+/g) ?? []), `£${leak.low.toLocaleString("en-GB")}`, `£${leak.high.toLocaleString("en-GB")}`, ...JSON.stringify(PRICE_LIST).match(/£[\d,]+/g)]);
  for (const figure of plan.body.match(/£[\d,]+/g)) assert.ok(allowed.has(figure), `${figure} was not written by code`);

  // the model never saw a price, a leak, the note's figure or an address
  for (const r of t.requests.filter((x) => x.stage === "plan")) {
    for (const secret of ["£", "%", "2,750", "2750", "800", "published@", String(leak.low), String(leak.high)]) assert.ok(!r.user.includes(secret), `the model was given "${secret}"`);
  }
  // a business with no rival tested: no rival line, no list
  const noRival = listed.plans.find((p) => p.prospectId === d.id);
  assert.ok(!noRival.body.includes("Fastest rival"));
});

test("Make a plan: on demand, a new row each time (append only), refused after not interested; a part that breaks the rules is sent back once, then nothing is stored", async () => {
  // `bad`: how many of the next answers break the rules.
  let bad = 0;
  const t = await world({ part: () => (bad-- > 0 ? { ...GOOD, opening: "It's just £250 a month; easy." } : GOOD) });
  const a = await clinic(t, "alpha");
  assert.equal((await t.x.call("POST", `/v1/prospects/${a.id}/plan`, {})).status, 202);
  await t.x.runtime.idle();
  assert.equal((await t.x.call("POST", `/v1/prospects/${a.id}/plan`, {})).status, 202);
  await t.x.runtime.idle();
  const all = await rows(h, "select plan_id, trigger from plans where prospect_id = $1 order by created_at", [a.id]);
  assert.deepEqual(all.map((p) => p.trigger), ["asked", "asked"]);
  assert.equal((await plansOf(t)).plans.length, 1, "the newest one is shown");

  // nobody may change or delete a plan
  for (const db of [h.gatewayDb, h.uiDb, h.agentDb]) {
    await assert.rejects(db.tx(t.x.w.tenantId, (tx) => tx.query("update plans set body = 'changed'")), /permission denied/);
    await assert.rejects(db.tx(t.x.w.tenantId, (tx) => tx.query("delete from plans")), /permission denied/);
  }

  // the first answer breaks the rules, the second passes: stored once, and the second request told what was wrong
  bad = 1;
  const before = t.requests.length;
  const b = await clinic(t, "beta");
  await t.x.call("POST", `/v1/prospects/${b.id}/plan`, {});
  await t.x.runtime.idle();
  const asked = t.requests.slice(before).filter((r) => r.stage === "plan");
  assert.equal(asked.length, 2);
  assert.match(asked[1].user, /money figure/);
  assert.equal((await rows(h, "select 1 from plans where prospect_id = $1", [b.id])).length, 1);

  // both answers break the rules: nothing is stored
  bad = 99;
  const c = await clinic(t, "gamma");
  await t.x.call("POST", `/v1/prospects/${c.id}/plan`, {});
  await t.x.runtime.idle();
  assert.equal((await rows(h, "select 1 from plans where prospect_id = $1", [c.id])).length, 0);
  const [ev] = await rows(h, "select summary from events where tenant_id = $1 and reason_code = 'plan_not_written'", [t.x.w.tenantId]);
  assert.equal(ev.summary, "A plan could not be written to the rules");

  // not interested: no plan
  t.x.w.clock.advance(60 * 60 * 1000);
  await call(t, a.id, { outcome: "not_interested" });
  assert.deepEqual((await t.x.call("POST", `/v1/prospects/${a.id}/plan`, {})).body, { reason: "not_interested" });
  assert.equal((await t.x.call("POST", "/v1/prospects/00000000-0000-4000-8000-00000000abcd/plan", {})).status, 404);
  // events carry no names and no figures
  for (const e of await rows(h, "select summary, payload from events where tenant_id = $1 and reason_code like 'plan_%'", [t.x.w.tenantId])) {
    assert.ok(!/Fixture|£/.test(`${e.summary}${JSON.stringify(e.payload ?? {})}`), e.summary);
  }
});
