// The follow-up email after a call, against a real Postgres. No model, no mail server: both are fakes in memory.
// Every name, address and figure here is a TEST FIXTURE.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { control, openHarness, rows } from "./helpers.js";
import { makeHouse, makeWhRoot } from "./house-helpers.js";
import { createScriptedModel } from "../dist/agents/model-caller.js";
import { recordAnalysis, recordProspect } from "../dist/outreach/store.js";
import { checkRecipient, followupFacts, lintFollowup, lintModelDraft, rivalLine, testResultLine, withoutFigures, FOLLOWUP_ACTION, FOLLOWUP_CAP } from "../dist/outreach/followups.js";
import { STAGE_SCHEMAS } from "../dist/outreach/stages.js";
import { ownerMailboxFromEnv } from "../dist/control/connectors/mailbox.js";

const h = openHarness();
const open = [];
after(async () => {
  await Promise.all(open.filter((x) => x.close).map((x) => x.close()));
  await h.close();
});
const ROOM = "fixture-floor-one:outreach";
const HOUR = 60 * 60 * 1000;

const SIGN = "Salekh Mahmood, Salekh Ventures";
const GOOD = {
  subject: "Following up on our call",
  body: "Hi Jo,\n\nThanks for taking my call today. I sent an enquiry as a test and nobody replied in the first 24 hours. We build an enquiries agent for clinics, and we can automate more once we connect to your booking system.\n\nWould a 20-minute call this week suit you?\n\n" + SIGN,
};
const NOTE = "Spoke to FIXTURE-PERSON Jo, referred by FIXTURE-REFERRER. Losing £500 a month, maybe 30% of enquiries. Keen.";
const TO = { name: "Jo Fixture", email: "jo@fixture-recipient.example.test" };

// ---- the code checks ----

test("the findings list: written by code from the stored results, the business first then same-kind rivals fastest first, no money, and placed before the closing question", async () => {
  const { findingsBlock, withFindings } = await import("../dist/outreach/followups.js");
  const test = { enquiry_id: "e", sent_at: "2026-11-17T10:57:00Z", replies: [], slot: "in_hours" };
  const rival = (name, mins) => ({ name, tested: "scored", reply_minutes: mins, slot: "in_hours" });
  const block = findingsBlock({ name: "Fixture Dental", area: "Fixtureton", test }, [rival("Slow Dental", 300), rival("Quick Dental - Cosmetic", 4), { name: "Untested", tested: "not_tested", reply_minutes: null, slot: "in_hours" }]);
  assert.equal(block, "What I found in Fixtureton, same question sent on Tuesday at 10:57:\n- Fixture Dental (you): no reply within 24 hours\n- Quick Dental: replied in 4 minutes\n- Slow Dental: replied in 5 hours", "a rival not yet tested is left out");
  assert.ok(!/£|%/.test(block));
  assert.equal(findingsBlock({ name: "Fixture Dental", area: null, test }, []), null, "nobody to compare with: no list");
  const body = "Hi Jo,\n\nThanks for picking up today.\n\nWould you have 20 minutes this week?\n\nThanks,\nSalekh Mahmood, Salekh Ventures";
  assert.equal(withFindings(body, "LIST"), "Hi Jo,\n\nThanks for picking up today.\n\nLIST\n\nWould you have 20 minutes this week?\n\nThanks,\nSalekh Mahmood, Salekh Ventures");
  assert.equal(withFindings(body, null), body);
});

test("the code checks: length, signed, no £ or %, no links, a valid address; the model's draft is held to more", () => {
  assert.deepEqual(lintFollowup(GOOD, TO.email), []);
  const body = (text) => ({ ...GOOD, body: text });
  const refuses = (draft, pattern, to = null) => assert.ok(lintFollowup(draft, to).some((p) => pattern.test(p)), `${JSON.stringify(draft.body).slice(0, 80)} gave ${JSON.stringify(lintFollowup(draft, to))}`);
  refuses(body(GOOD.body.replace("today.", "today. It could save you £2,000.")), /money figure or a percentage/);
  refuses(body(GOOD.body.replace("today.", "today. You lose 30% of enquiries.")), /money figure or a percentage/);
  refuses(body(GOOD.body.replace("today.", "today. You lose thirty per cent.")), /money figure or a percentage/);
  refuses(body(GOOD.body.replace(SIGN, "Salekh")), /not signed/);
  refuses(body(GOOD.body.replace("today.", `today. ${"word ".repeat(270)}`)), /under 280/);
  refuses(body(GOOD.body.replace("today.", "today. See https://fixture.example.test")), /link/);
  refuses(body(GOOD.body.replace("today.", "today. See www.fixture")), /link/);
  refuses(body(GOOD.body.replace("today.", "today. See salekhventures.com")), /link/);
  refuses(body(GOOD.body.replace("today.", "today. Write to hello@fixture")), /link/);
  refuses(GOOD, /not a valid email address/, "not-an-address");
  refuses({ ...GOOD, subject: "" }, /subject is empty/);
  // signed over two lines is the same signature
  assert.deepEqual(lintFollowup(body(GOOD.body.replace(SIGN, "Salekh Mahmood\nSalekh Ventures"))), []);

  // the model's draft: no promises, no claim that it is already connected, the ask, no made-up numbers, the test as stored
  const rules = { numbers: ["24"], mustInclude: ["24 hours"] };
  assert.deepEqual(lintModelDraft(GOOD, rules), []);
  const modelRefuses = (draft, pattern) => assert.ok(lintModelDraft(draft, rules).some((p) => pattern.test(p)), JSON.stringify(lintModelDraft(draft, rules)));
  modelRefuses(body(GOOD.body.replace("today.", "today. I guarantee results.")), /promise/);
  modelRefuses(body(GOOD.body.replace("we can automate more once we connect to your booking system", "it is already integrated with your case system")), /already connected/);
  modelRefuses(body(GOOD.body.replace("Would a 20-minute call this week suit you?", "Let me know.")), /20-minute call this week/);
  modelRefuses(body(GOOD.body.replace("today.", "today. We helped 14 clinics.")), /numbers that are not in the facts given: 14/);
  modelRefuses(body(GOOD.body.replace("nobody replied in the first 24 hours", "the reply was slow")), /test result as given/);
});

test("a recipient is an address that looks like one, given by Salekh; figures never reach the model", () => {
  assert.deepEqual(checkRecipient(undefined), { ok: true, to: null });
  assert.deepEqual(checkRecipient({ name: "  Jo  Fixture ", email: " jo@fixture.example.test " }), { ok: true, to: { name: "Jo Fixture", email: "jo@fixture.example.test" } });
  assert.deepEqual(checkRecipient({ email: "jo@fixture.example.test" }), { ok: true, to: { name: null, email: "jo@fixture.example.test" } });
  for (const bad of [{ name: "Jo" }, { email: "jo at fixture" }, { email: "jo@" }, "jo@fixture.example.test", { email: 5 }]) assert.equal(checkRecipient(bad).ok, false, JSON.stringify(bad));
  const clean = withoutFigures("Losing £500 a month, 30% of calls, £2.5k, 40 per cent, 900 pounds. Call 3pm Thursday.");
  assert.ok(!/[£%]|500|2\.5k|\b30\b|\b40\b|900/.test(clean), clean);
  assert.match(clean, /3pm Thursday/, "a time to ring is not a figure in pounds");
  // the test, as stored
  const sent = "2026-11-16T10:00:00.000Z";
  assert.deepEqual(testResultLine({ enquiry_id: "x", sent_at: sent, replies: [] }, true), { line: "I sent an enquiry as a test and nobody replied in the first 24 hours.", phrase: "24 hours" });
  assert.equal(testResultLine({ enquiry_id: "x", sent_at: sent, replies: [] }, false), null, "not judged yet: nothing to state");
  assert.equal(testResultLine({ enquiry_id: "x", sent_at: sent, replies: [{ kind: "bounce", received_at: sent }] }, true), null, "it never arrived: nothing to state");
  assert.deepEqual(testResultLine({ enquiry_id: "x", sent_at: sent, replies: [{ kind: "person", received_at: "2026-11-16T13:00:00.000Z" }] }, true).phrase, "3 hours");
  // one rival at most: the fastest of the same slot that replied
  const rival = (name, minutes, slot = "in_hours") => ({ name, tested: "scored", reply_minutes: minutes, slot });
  assert.equal(rivalLine({ test: { sent_at: sent, replies: [], slot: "in_hours" } }, [rival("Fixture Slow", 300), rival("Fixture Fast", 4), rival("Fixture Weekend", 1, "weekend")]).line, "Fixture Fast replied to the same kind of enquiry in 4 minutes.");
  assert.equal(rivalLine({ test: null }, []), null);
  const { facts, rules } = followupFacts({ business: "Fixture Clinic", area: "Fixtureton", kind: "clinics", sells: "implants from £2,750", contactName: null, contactRole: null, recipientName: null, outcome: "interested", note: NOTE, test: null, rival: null });
  assert.ok(!/£|%|2,750|500|\b30\b/.test(facts), facts);
  assert.deepEqual(rules.mustInclude, []);
  assert.ok(Object.keys(STAGE_SCHEMAS).includes("followup"));
  // the owner's mailbox: its own token, and never the test mailbox's address
  const base = { OWNER_MAIL_ADDRESS: "hello@fixture-owner.example.test", GMAIL_OAUTH_CLIENT_ID: "id", GMAIL_OAUTH_CLIENT_SECRET: "secret" };
  assert.equal(ownerMailboxFromEnv({}).mailbox, null);
  assert.equal(ownerMailboxFromEnv({ ...base, GMAIL_OAUTH_REFRESH_TOKEN: "the test mailbox's" }).mailbox, null, "the test mailbox's token is not used");
  assert.equal(ownerMailboxFromEnv({ ...base, OWNER_GMAIL_OAUTH_REFRESH_TOKEN: "t", TEST_MAILBOX_ADDRESS: "HELLO@fixture-owner.example.test" }).mailbox, null);
  const made = ownerMailboxFromEnv({ ...base, OWNER_GMAIL_OAUTH_REFRESH_TOKEN: "t" }).mailbox;
  assert.deepEqual([made?.address, made?.transport], ["hello@fixture-owner.example.test", "gmail_api"]);
});

// ---- the database and the API ----

function fakeOwnerMailbox(address = "hello@fixture-owner.example.test") {
  const box = {
    address, sent: [],
    async send(mail) {
      const messageId = `<owner-${box.sent.length + 1}@fixture-owner.example.test>`;
      box.sent.push({ ...mail, messageId });
      return { messageId };
    },
    async sentContains(id) { return box.sent.some((m) => m.messageId === id); },
    async findReplies() { return []; },
  };
  return box;
}
function fakeTestMailbox() {
  const box = { address: "fixture-test@example.test", sent: [], async send(m) { box.sent.push(m); return { messageId: "<t@x>" }; }, async sentContains() { return true; }, async findReplies() { return []; } };
  return box;
}

async function world(opts = {}) {
  const whRoot = makeWhRoot();
  writeFileSync(path.join(whRoot, "agents", "outreach-followup.md"), "# Fixture follow-up role\n");
  const requests = [];
  const model = createScriptedModel(async (request) => {
    requests.push(request);
    if (request.stage !== "followup") throw new Error(`fixture: no model call expected at ${request.stage}`);
    return { data: (await opts.draft?.(request)) ?? GOOD, costUsd: 0.02, usage: { inputTokens: 100, outputTokens: 50 } };
  });
  const owner = opts.ownerMailbox === undefined ? fakeOwnerMailbox() : opts.ownerMailbox;
  const testBox = fakeTestMailbox();
  const x = await makeHouse(h, { outreach: { budget: 5 }, model, whRoot, mailbox: testBox, ownerMailbox: owner });
  open.push(x);
  const scope = { tenantId: x.w.tenantId, businessId: x.w.businessId, runId: null };
  if (opts.cap !== null) await control.setConfig(h.uiDb, { tenantId: x.w.tenantId, businessId: x.w.businessId, kind: "cap", key: FOLLOWUP_CAP, value: { limit: opts.cap ?? 20 }, memberId: x.w.ownerId, reason: "test fixture" });
  for (let r = 2; r <= (opts.rung ?? 2); r += 1) {
    await control.promoteRung(h.uiDb, control.actionTypes, { tenantId: x.w.tenantId, businessId: x.w.businessId, actionType: FOLLOWUP_ACTION, memberId: x.w.ownerId, reason: "test fixture" });
  }
  return { x, scope, owner, testBox, requests };
}

/** One clinic, analysed, tested (nobody replied), with a leak figure on its card and a price on its pages, and a rival. */
async function clinic(t, key) {
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
  await h.admin.query(
    `update prospects set card = $2::jsonb, capture_score = 10, test_result = $3::jsonb where prospect_id = $1`,
    [made.prospectId, JSON.stringify({ leak: { low: 4111, high: 9333 }, first_message: "x" }), JSON.stringify({ enquiry_id: "00000000-0000-4000-8000-000000000001", sent_at: now.toISOString(), replies: [], slot: "in_hours" })]);
  return { id: made.prospectId, name, site };
}

const call = (t, id, body) => t.x.call("POST", `/v1/prospects/${id}/outcome`, body);
const list = async (t) => (await t.x.call("GET", `/v1/rooms/${ROOM}/followups`)).body;
const latestFor = async (t, prospectId) => (await list(t)).followups.find((f) => f.prospectId === prospectId);
const decide = (t, f, decision, hash = f.payloadHash) => t.x.call("POST", `/v1/followups/${f.id}/decision`, decision === "send" ? { decision, payloadHash: hash } : { decision });
const followupApprovals = (t) => rows(h, "select * from approvals where tenant_id = $1 and action_type = $2 order by created_at", [t.x.w.tenantId, FOLLOWUP_ACTION]);
const followupActions = (t) => rows(h, "select * from actions where tenant_id = $1 and action_type = $2", [t.x.w.tenantId, FOLLOWUP_ACTION]);

test("drafted only after interested, call back or meeting booked WITH a note; never a guessed address; the model never sees a price or a leak", async () => {
  const t = await world();
  const [a, b, c, d, e] = [await clinic(t, "alpha"), await clinic(t, "beta"), await clinic(t, "gamma"), await clinic(t, "delta"), await clinic(t, "epsilon")];
  for (const [p, outcome, note] of [[a, "no_answer", NOTE], [b, "interested", undefined], [c, "wrong_person", NOTE]]) {
    assert.equal((await call(t, p.id, { outcome, ...(note ? { note } : {}) })).status, 200);
  }
  await t.x.runtime.idle();
  assert.equal(t.requests.length, 0, "no draft without a note, or after any other outcome");
  assert.equal((await list(t)).followups.length, 0);
  // a recipient goes only with the three outcomes, and must be an address
  assert.equal((await call(t, a.id, { outcome: "no_answer", followUpTo: TO })).status, 422);
  assert.equal((await call(t, a.id, { outcome: "interested", note: NOTE, followUpTo: { email: "nope" } })).status, 422);

  for (const [p, outcome] of [[c, "call_back"], [d, "interested"], [e, "meeting_booked"]]) assert.equal((await call(t, p.id, { outcome, note: NOTE })).status, 200);
  await t.x.runtime.idle();
  assert.equal(t.requests.length, 3);
  const listed = await list(t);
  assert.deepEqual(listed.followups.map((f) => [f.prospectId, f.status, f.to, f.payloadHash]).sort(), [c, d, e].map((p) => [p.id, "draft", null, null]).sort(),
    "no recipient was given, so none is set: the business's published address is not used");
  assert.deepEqual(listed.ownerMailbox, { configured: true, address: "hello@fixture-owner.example.test" });
  assert.equal(listed.rung, 2);
  assert.equal((await followupApprovals(t)).length, 0, "nothing to approve without a recipient");
  // the model was given the note (figures taken out), the test as stored, and no price, leak or address
  for (const r of t.requests) {
    assert.equal(r.model, "claude-sonnet-5-5");
    assert.ok(r.user.includes("FIXTURE-REFERRER"), "the note");
    assert.ok(r.user.includes("nobody replied in the first 24 hours"), "the test result as stored");
    for (const secret of ["£", "%", "2,750", "2750", "4111", "4,111", "9333", "9,333", "500", "published@", "@"]) assert.ok(!r.user.includes(secret), `the model was given "${secret}"`);
  }
  // with no recipient it cannot be sent
  const f = listed.followups.find((x) => x.prospectId === d.id);
  assert.deepEqual((await decide(t, f, "send", "0".repeat(64))).body, { reason: "no_recipient" });
  assert.equal(t.owner.sent.length, 0);
});

test("rung 2: it waits for his yes; a yes for anything else, or for what was there before an edit, sends nothing; Send sends exactly what is shown, from the owner's mailbox", async () => {
  const t = await world();
  const p = await clinic(t, "alpha");
  assert.equal((await call(t, p.id, { outcome: "interested", note: NOTE, followUpTo: TO })).status, 200);
  await t.x.runtime.idle();
  let f = await latestFor(t, p.id);
  assert.equal(f.status, "waiting_for_you");
  assert.deepEqual(f.to, TO);
  assert.equal(t.owner.sent.length, 0, "nothing goes without a yes");
  assert.equal((await t.x.roomOf(ROOM)).task, "1 follow-up email waiting for your yes");

  // a yes for a different payload
  assert.deepEqual((await decide(t, f, "send", "f".repeat(64))).body, { reason: "payload_mismatch" });
  // an edit voids the approval that was waiting, and a fresh one waits for the new text
  const [first] = await followupApprovals(t);
  const edited = await t.x.call("POST", `/v1/followups/${f.id}`, { body: GOOD.body.replace("Thanks for taking my call today.", "Thanks for the call this morning.") });
  assert.equal(edited.status, 200);
  assert.equal((await rows(h, "select status, void_reason from approvals where approval_id = $1", [first.approval_id]))[0].void_reason, "payload_changed");
  assert.equal(edited.body.followup.status, "waiting_for_you");
  assert.notEqual(edited.body.followup.payloadHash, f.payloadHash);
  assert.deepEqual((await decide(t, f, "send")).body, { reason: "payload_mismatch" }, "the old hash sends nothing");
  assert.equal(t.owner.sent.length, 0);
  // an edit that breaks a check: back to a draft that cannot be sent
  const broken = await t.x.call("POST", `/v1/followups/${f.id}`, { body: `${GOOD.body}\nIt costs £100.` });
  assert.equal(broken.body.followup.status, "draft");
  assert.ok(broken.body.followup.problems.length > 0);
  assert.deepEqual((await decide(t, broken.body.followup, "send")).body, { reason: "fails_checks" });
  const fixed = (await t.x.call("POST", `/v1/followups/${f.id}`, { body: GOOD.body, subject: "After our call" })).body.followup;
  assert.equal(fixed.status, "waiting_for_you");

  const sent = await decide(t, fixed, "send");
  assert.deepEqual(sent.body, { status: "sent" });
  assert.deepEqual(t.owner.sent.map((m) => [m.to, m.subject, m.text]), [[TO.email, "After our call", GOOD.body]]);
  assert.equal(t.testBox.sent.length, 0, "never from the test mailbox");
  f = await latestFor(t, p.id);
  assert.equal(f.status, "sent");
  assert.equal(f.from, "hello@fixture-owner.example.test");
  assert.ok(f.sentAt);
  const [action] = await followupActions(t);
  assert.deepEqual([action.status, action.verified, action.rung], ["executed", true, 2], "read back from Sent");
  assert.equal((await decide(t, f, "send")).status, 409, "sent once only");

  // "don't send" on another
  const q = await clinic(t, "beta");
  await call(t, q.id, { outcome: "call_back", note: NOTE, followUpTo: { email: "pat@fixture-beta.example.test" } });
  await t.x.runtime.idle();
  const g = await latestFor(t, q.id);
  assert.deepEqual((await decide(t, g, "dont_send")).body, { status: "not_sent", reason: "you_said_do_not_send" });
  assert.equal((await rows(h, "select a.status from approvals a join followups f on f.approval_id = a.approval_id where f.followup_id = $1", [g.id]))[0].status, "rejected");
  assert.equal(t.owner.sent.length, 1);
});

test("rung 3: the owner's switch sends without a yes, inside the checks; never without a recipient; an edit never sends by itself", async () => {
  const t = await world();
  const a = await clinic(t, "alpha");
  const b = await clinic(t, "beta");
  assert.equal((await t.x.call("POST", `/v1/rooms/${ROOM}/followup-rung`, { rung: 4 })).status, 422);
  assert.deepEqual((await t.x.call("POST", `/v1/rooms/${ROOM}/followup-rung`, { rung: 3 })).body, { rung: 3 });
  const [version] = await rows(h, "select value, changed_by_kind, changed_by_member, reason from config_versions where tenant_id = $1 and kind = 'rung' and key = $2 order by version desc limit 1", [t.x.w.tenantId, FOLLOWUP_ACTION]);
  assert.deepEqual([version.value, version.changed_by_kind, version.changed_by_member], [{ rung: 3 }, "member", t.x.w.ownerId]);
  assert.match(version.reason, /not to be asked/);
  assert.equal((await list(t)).rung, 3);

  await call(t, a.id, { outcome: "meeting_booked", note: NOTE, followUpTo: TO });
  await call(t, b.id, { outcome: "interested", note: NOTE });
  await t.x.runtime.idle();
  assert.deepEqual(t.owner.sent.map((m) => m.to), [TO.email], "with a recipient: sent without asking");
  assert.equal((await followupApprovals(t)).length, 0, "nobody's yes was recorded");
  assert.equal((await followupActions(t))[0].rung, 3);
  let fb = await latestFor(t, b.id);
  assert.equal(fb.status, "draft", "without a recipient it waits, even at rung 3");
  fb = (await t.x.call("POST", `/v1/followups/${fb.id}`, { to: { name: "Sam", email: "sam@fixture-beta.example.test" } })).body.followup;
  assert.equal(fb.status, "draft", "adding the recipient does not send it by itself");
  assert.equal(t.owner.sent.length, 1);
  assert.deepEqual((await decide(t, fb, "send")).body, { status: "sent" });
  assert.equal(t.owner.sent.length, 2);
  // and back to asking
  assert.deepEqual((await t.x.call("POST", `/v1/rooms/${ROOM}/followup-rung`, { rung: 2 })).body, { rung: 2 });
  assert.equal((await list(t)).rung, 2);
});

test("the day's cap and one per business per 24 hours", async () => {
  const t = await world({ cap: 1 });
  const a = await clinic(t, "alpha");
  const b = await clinic(t, "beta");
  await call(t, a.id, { outcome: "interested", note: NOTE, followUpTo: TO });
  await call(t, b.id, { outcome: "interested", note: NOTE, followUpTo: { email: "pat@fixture-beta.example.test" } });
  await t.x.runtime.idle();
  assert.deepEqual((await decide(t, await latestFor(t, a.id), "send")).body, { status: "sent" });
  const fb = await latestFor(t, b.id);
  assert.deepEqual((await decide(t, fb, "send")).body, { status: "approved", reason: "cap_exceeded" }, "the yes is kept; nothing goes over the cap");
  assert.equal(t.owner.sent.length, 1);

  // a fresh draft for the same business within 24 hours can be made but not sent
  assert.equal((await t.x.call("POST", `/v1/prospects/${a.id}/followup`, { note: "Second thoughts", to: TO })).status, 202);
  await t.x.runtime.idle();
  const again = await latestFor(t, a.id);
  assert.equal(again.status, "draft");
  assert.deepEqual((await decide(t, again, "send")).body, { reason: "sent_in_the_last_24_hours" });
  t.x.w.clock.advance(25 * HOUR);
  assert.deepEqual((await decide(t, again, "send")).body, { status: "sent" }, "the next day, under a new day's cap");
  assert.equal(t.owner.sent.length, 2);
});

test("a business suppressed, or that said not interested, is never sent one; the kill switch stops sending and drafting", async () => {
  const t = await world();
  const a = await clinic(t, "alpha");
  const b = await clinic(t, "beta");
  const c = await clinic(t, "gamma");
  for (const [p, email] of [[a, TO.email], [b, "pat@fixture-beta.example.test"], [c, "lee@fixture-gamma.example.test"]]) await call(t, p.id, { outcome: "interested", note: NOTE, followUpTo: { email } });
  await t.x.runtime.idle();
  // suppressed after it was drafted: checked again in the moment before sending
  await h.admin.query("insert into suppressions (tenant_id, kind, value_key, reason) values ($1, 'domain', 'fixture-alpha.example.test', 'test fixture')", [t.x.w.tenantId]);
  const fa = await latestFor(t, a.id);
  assert.deepEqual((await decide(t, fa, "send")).body, { status: "not_sent", reason: "suppressed" });
  // not interested on a later call
  t.x.w.clock.advance(60 * 1000);
  assert.equal((await call(t, b.id, { outcome: "not_interested" })).status, 200);
  assert.deepEqual((await decide(t, await latestFor(t, b.id), "send")).body, { status: "not_sent", reason: "not_interested" });
  assert.equal((await t.x.call("POST", `/v1/prospects/${b.id}/followup`, { note: "x" })).status, 409, "nor is one drafted");
  assert.equal(t.owner.sent.length, 0);

  // the kill switch
  await t.x.call("POST", "/v1/kill-switch", { on: true });
  assert.deepEqual((await decide(t, await latestFor(t, c.id), "send")).body, { status: "approved", reason: "kill_switch" });
  assert.equal(t.owner.sent.length, 0);
  const before = t.requests.length;
  await call(t, c.id, { outcome: "call_back", note: NOTE });
  await t.x.runtime.idle();
  assert.equal(t.requests.length, before, "no model call while everything is stopped");
  await t.x.call("POST", "/v1/kill-switch", { on: false });
  assert.deepEqual((await decide(t, await latestFor(t, c.id), "send")).body, { status: "sent" }, "the yes given stands once it is lifted");
});

test("no owner mailbox: drafted and approved all the same, nothing is sent, and the copy is noted; at rung 3 it waits", async () => {
  const t = await world({ ownerMailbox: null });
  const a = await clinic(t, "alpha");
  await call(t, a.id, { outcome: "interested", note: NOTE, followUpTo: TO });
  await t.x.runtime.idle();
  const listed = await list(t);
  assert.deepEqual(listed.ownerMailbox, { configured: false, address: null });
  const f = listed.followups[0];
  assert.equal(f.status, "waiting_for_you");
  assert.deepEqual((await decide(t, f, "send")).body, { status: "approved", reason: "no_mailbox" });
  assert.equal((await followupActions(t)).length, 0, "nothing was executed");
  assert.equal(t.testBox.sent.length, 0, "and never the test mailbox in its place");
  const copied = await t.x.call("POST", `/v1/followups/${f.id}`, { copied: true });
  assert.ok(copied.body.followup.copiedAt);
  assert.equal(copied.body.followup.status, "approved");

  // at rung 3 too: nothing is put to the gateway, and Send says why
  await t.x.call("POST", `/v1/rooms/${ROOM}/followup-rung`, { rung: 3 });
  const b = await clinic(t, "beta");
  await call(t, b.id, { outcome: "interested", note: NOTE, followUpTo: { email: "pat@fixture-beta.example.test" } });
  await t.x.runtime.idle();
  const fb = await latestFor(t, b.id);
  assert.equal(fb.status, "draft");
  assert.deepEqual((await decide(t, fb, "send")).body, { reason: "no_mailbox" });
  assert.equal((await followupActions(t)).length, 0);
});

test("no personal data in events or the house; the routes need the token; an answer through the approvals route is the same as the card's", async () => {
  const t = await world();
  const a = await clinic(t, "alpha");
  for (const route of [["GET", `/v1/rooms/${ROOM}/followups`], ["POST", "/v1/followups/00000000-0000-4000-8000-000000000000"], ["POST", "/v1/followups/00000000-0000-4000-8000-000000000000/decision"], ["POST", `/v1/rooms/${ROOM}/followup-rung`], ["POST", `/v1/prospects/${a.id}/followup`]]) {
    assert.equal((await t.x.call(route[0], route[1], route[0] === "POST" ? {} : undefined, null)).status, 401, route.join(" "));
  }
  assert.equal((await t.x.call("GET", "/v1/rooms/fixture-floor-one:nowhere/followups")).status, 404);
  assert.equal((await t.x.call("POST", "/v1/followups/not-a-uuid/decision", { decision: "send", payloadHash: "x" })).status, 404);
  assert.equal((await t.x.call("POST", "/v1/followups/00000000-0000-4000-8000-000000000000/decision", { decision: "maybe" })).status, 422);

  await call(t, a.id, { outcome: "interested", note: NOTE, followUpTo: TO });
  await t.x.runtime.idle();
  const f = await latestFor(t, a.id);
  const [approval] = await followupApprovals(t);
  assert.deepEqual((await t.x.call("POST", `/v1/approvals/${approval.approval_id}`, { decision: "approve", payloadHash: f.payloadHash })).body, { status: "approved" });
  assert.equal(t.owner.sent.length, 1);
  assert.equal((await latestFor(t, a.id)).status, "sent");

  const everything = JSON.stringify([await rows(h, "select * from events where tenant_id = $1", [t.x.w.tenantId]), (await t.x.call("GET", "/v1/house")).body]);
  for (const secret of [TO.email, "Jo Fixture", "FIXTURE-PERSON", "FIXTURE-REFERRER", GOOD.subject, "Thanks for taking my call", "Fixture Alpha", "fixture-recipient"]) {
    assert.ok(!everything.includes(secret), `"${secret}" reached events or the house`);
  }
  assert.ok(everything.includes("A follow-up email was drafted"));
});
