// The Chief of Staff reading Salekh's instructions, against a real Postgres. The model is scripted: no test calls the API.
// Every name and instruction here is a TEST FIXTURE.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { control, openHarness } from "./helpers.js";
import { makeHouse, makeWhRoot } from "./house-helpers.js";
import { createScriptedModel } from "../dist/agents/model-caller.js";
import { ALLOWED_CHANGES, markTicketDone, openTickets, OWNER_ONLY, route } from "../dist/chief/instructions.js";
import { readKillSwitch, readRung } from "../dist/control/config.js";
import { FOLLOWUP_ACTION } from "../dist/outreach/followups.js";
import { chiefSchema } from "../dist/outreach/stages.js";

const h = openHarness();
const open = [];
after(async () => {
  await Promise.all(open.filter((x) => x.close).map((x) => x.close()));
  await h.close();
});

const read = (over) => ({ restated: "Fixture restated line.", department: "outreach", kind: "setting", change: "none", floor: "", kind_id: "", place: "", question: "", ticket: "", ...over });
const FLOOR = { businessId: "b", slug: "fixture-floor-one", name: "Fixture Floor One", kinds: [{ id: "clinics", name: "clinics", enabled: true }, { id: "solicitors", name: "solicitors", enabled: true }, { id: "trades", name: "trades", enabled: false }], places: ["Leeds", "York"] };

// ---- plain code: what a reading may lead to ----

test("a reading is held to the closed list: raising a rung or lifting a stop is never proposed, and anything unclear is a question", () => {
  assert.equal(route(read({ change: "kind_off", kind_id: "solicitors" }), [FLOOR]).status, "proposed");
  assert.deepEqual(route(read({ change: "kind_off", kind_id: "Solicitors" }), [FLOOR]).change, { what: "kind_off", floor: "fixture-floor-one", kind_id: "solicitors" });
  assert.equal(route(read({ change: "add_place", place: "Hull" }), [FLOOR]).change.place, "Hull");
  assert.equal(route(read({ change: "remove_place", place: "york" }), [FLOOR]).change.place, "York", "the place as it is stored");
  assert.equal(route(read({ change: "followups_ask_first" }), [FLOOR]).status, "proposed");
  assert.equal(route(read({ change: "pause_floor" }), [FLOOR]).status, "proposed");

  for (const what of ["followups_send_without_asking", "resume_floor"]) {
    const d = route(read({ change: what }), [FLOOR]);
    assert.equal(d.status, "not_done", what);
    assert.equal(d.change, null);
    assert.equal(d.note, OWNER_ONLY[what]);
    assert.ok(!ALLOWED_CHANGES.includes(what));
  }

  // unclear: one question back
  const q = (over, floors = [FLOOR]) => { const d = route(read(over), floors); assert.equal(d.status, "needs_answer", JSON.stringify(over)); assert.ok(d.question); return d.question; };
  assert.equal(q({ kind: "question", question: "Which kind of business do you mean?" }), "Which kind of business do you mean?");
  q({ kind: "question", question: "" });
  q({ change: "none" });
  assert.match(q({ change: "kind_off", kind_id: "" }), /clinics, solicitors, trades/);
  assert.match(q({ change: "kind_off", kind_id: "vets" }), /Which kind/);
  q({ change: "add_place", place: "" });
  q({ change: "add_place", place: "http://fixture.example.test" });
  assert.match(q({ change: "remove_place", place: "Bath" }), /Bath isn't one of the places/);
  q({ kind: "engineering", ticket: "" });
  const two = { ...FLOOR, slug: "fixture-floor-two", name: "Fixture Floor Two" };
  assert.match(q({ change: "pause_floor" }, [FLOOR, two]), /Fixture Floor One or Fixture Floor Two/);
  assert.equal(route(read({ change: "pause_floor", floor: "fixture-floor-two" }), [FLOOR, two]).change.floor, "fixture-floor-two");

  // already so: nothing to do
  assert.equal(route(read({ change: "kind_on", kind_id: "clinics" }), [FLOOR]).status, "done");
  assert.equal(route(read({ change: "add_place", place: "leeds" }), [FLOOR]).status, "done");
  assert.equal(route(read({ change: "pause_floor" }), []).status, "not_done", "no outreach floor at all");

  const e = route(read({ kind: "engineering", department: "engineering", ticket: "Make the profiles shorter." }), [FLOOR]);
  assert.deepEqual([e.status, e.ticket, e.change], ["waiting_engineering", "Make the profiles shorter.", null]);
  assert.ok(route(read({ restated: "x".repeat(500) }), [FLOOR]).restated.length <= 300);
});

// ---- the whole path, through the API ----

async function chiefHouse(opts = {}) {
  const whRoot = makeWhRoot();
  writeFileSync(path.join(whRoot, "agents", "chief-of-staff.md"), "# Fixture chief of staff role\n");
  const asked = [];
  const answers = [...(opts.answers ?? [])];
  const model = opts.model === null ? null : createScriptedModel(async (request) => {
    asked.push(request);
    assert.equal(request.stage, "chief");
    assert.equal(request.schema, chiefSchema);
    return { data: read(answers.shift() ?? {}), costUsd: 0.01 };
  });
  const house = await makeHouse(h, { outreach: { budget: 5 }, model, whRoot, rung: opts.rung });
  open.push(house);
  const { w } = house;
  if (opts.budget !== false) {
    await control.setConfig(h.uiDb, { tenantId: w.tenantId, businessId: null, kind: "budget", key: "chief-of-staff", value: { daily_limit_gbp: 1 }, memberId: w.ownerId, reason: "test fixture" });
  }
  const say = async (text, answersId) => {
    const r = await house.call("POST", "/v1/ask", answersId ? { text, answers: answersId } : { text });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await house.runtime.idle();
    return r.body.id;
  };
  const list = async () => (await house.call("GET", "/v1/instructions")).body.instructions;
  const one = async (id) => (await list()).find((i) => i.id === id);
  const settings = async () => (await control.getCurrentConfig(h.uiDb, { tenantId: w.tenantId, businessId: w.businessId, kind: "setting", key: "outreach" }))?.value ?? {};
  return { house, w, asked, say, list, one, settings };
}

test("'stop emailing lawyers': understood, proposed, nothing changes until his yes, then made as the owner", async () => {
  const c = await chiefHouse({ answers: [{ restated: "Stop looking for solicitors.", change: "kind_off", kind_id: "solicitors" }] });
  const id = await c.say("stop emailing lawyers");
  assert.match(c.asked[0].user, /Instruction \(now\): stop emailing lawyers/);
  assert.match(c.asked[0].user, /"solicitors" solicitors for conveyancing and family law \(on\)/, "the model is told the kinds there are");
  let i = await c.one(id);
  assert.deepEqual([i.status, i.restated, i.department, i.kind], ["proposed", "Stop looking for solicitors.", "outreach", "setting"]);
  assert.equal(i.change, "Stop looking for solicitors for conveyancing and family law.");
  const before = await c.settings();
  assert.ok(!(before.business_types ?? []).some((t) => t.id === "solicitors" && t.enabled === false), "nothing changed yet");

  const yes = await c.house.call("POST", `/v1/instructions/${id}`, { decision: "yes" });
  assert.equal(yes.status, 200);
  assert.equal(yes.body.instruction.status, "done");
  const after = await c.settings();
  assert.equal(after.business_types.find((t) => t.id === "solicitors").enabled, false);
  assert.equal(after.business_types.find((t) => t.id === "clinics").enabled, true);
  const version = (await h.admin.query("select changed_by_kind, changed_by_member, reason from config_versions where tenant_id = $1 and kind = 'setting' and key = 'outreach' order by version desc limit 1", [c.w.tenantId])).rows[0];
  assert.deepEqual([version.changed_by_kind, version.changed_by_member], ["member", c.w.ownerId]);
  assert.match(version.reason, /Chief of Staff/);

  // A second press does nothing more.
  const again = await c.house.call("POST", `/v1/instructions/${id}`, { decision: "yes" });
  assert.equal(again.status, 409);
  // Nothing he typed is in an event.
  const leaked = await h.admin.query("select count(*)::int as n from events where tenant_id = $1 and (summary ilike '%lawyers%' or payload::text ilike '%lawyers%')", [c.w.tenantId]);
  assert.equal(leaked.rows[0].n, 0);
});

test("a no changes nothing; a place is added on a yes", async () => {
  const c = await chiefHouse({ answers: [{ change: "kind_off", kind_id: "trades" }, { change: "add_place", place: "Fixtureton" }] });
  const no = await c.say("no more builders");
  assert.equal((await c.house.call("POST", `/v1/instructions/${no}`, { decision: "no" })).body.instruction.status, "not_done");
  assert.ok(!((await c.settings()).business_types ?? []).some((t) => t.id === "trades" && !t.enabled));
  const add = await c.say("search fixtureton too");
  const added = await c.house.call("POST", `/v1/instructions/${add}`, { decision: "yes" });
  assert.equal(added.body.instruction.status, "done", JSON.stringify(added.body));
  assert.ok((await c.settings()).areas.includes("Fixtureton"));
});

test("it can never raise the follow-up rung: 'send without asking' is refused, and 'ask me first' only ever lowers it", async () => {
  const c = await chiefHouse({ answers: [{ change: "followups_send_without_asking" }, { change: "followups_ask_first" }, { change: "followups_ask_first" }] });
  const rung = () => h.gatewayDb.tx(c.w.tenantId, (tx) => readRung(tx, c.w.businessId, FOLLOWUP_ACTION));
  assert.equal(await rung(), 1, "fixture: follow-ups at rung 1");

  const up = await c.say("just send the follow ups, dont ask me");
  const refused = await c.one(up);
  assert.equal(refused.status, "not_done");
  assert.match(refused.note, /Only you can do that one/);
  assert.equal((await c.house.call("POST", `/v1/instructions/${up}`, { decision: "yes" })).status, 409, "nothing to say yes to");
  assert.equal(await rung(), 1);

  // From rung 1, "ask me first" leaves it at 1: it is never raised to 2.
  const first = await c.say("ask me before follow ups go");
  await c.house.call("POST", `/v1/instructions/${first}`, { decision: "yes" });
  assert.equal(await rung(), 1);

  // From 3, it comes down to 2.
  await c.house.call("POST", "/v1/rooms/fixture-floor-one:outreach/followup-rung", { rung: 2 });
  await c.house.call("POST", "/v1/rooms/fixture-floor-one:outreach/followup-rung", { rung: 3 });
  assert.equal(await rung(), 3);
  const down = await c.say("ask me before follow ups go");
  assert.equal((await c.house.call("POST", `/v1/instructions/${down}`, { decision: "yes" })).body.instruction.status, "done");
  assert.equal(await rung(), 2);
});

test("it can pause a floor but never lift a stop, even with a change written into the store by hand", async () => {
  const c = await chiefHouse({ answers: [{ change: "pause_floor" }, { change: "resume_floor" }] });
  const stopped = () => h.gatewayDb.tx(c.w.tenantId, (tx) => readKillSwitch(tx, c.w.businessId));
  const pause = await c.say("pause outreach");
  assert.equal(await stopped(), null, "not before his yes");
  await c.house.call("POST", `/v1/instructions/${pause}`, { decision: "yes" });
  assert.equal(await stopped(), "floor");

  const resume = await c.say("start it again");
  assert.equal((await c.one(resume)).status, "not_done");
  assert.match((await c.one(resume)).note, /Resume/);
  assert.equal(await stopped(), "floor");

  // A proposed change that is not on the list (put in the database directly) is still not made.
  await h.admin.query(
    `insert into instruction_updates (tenant_id, instruction_id, status, kind, change, by_kind) values ($1, $2, 'proposed', 'setting', '{"what":"resume_floor","floor":"fixture-floor-one"}'::jsonb, 'system')`,
    [c.w.tenantId, resume]);
  const tried = await c.house.call("POST", `/v1/instructions/${resume}`, { decision: "yes" });
  assert.equal(tried.body.instruction.status, "not_done");
  assert.match(tried.body.instruction.note, /isn't a change I'm allowed to make/);
  assert.equal(await stopped(), "floor", "still stopped");
});

test("an ambiguous ask gets one question; his answer is read with the question and what he said first", async () => {
  const c = await chiefHouse({ answers: [{ kind: "question", restated: "Ask which kind of business.", question: "Which kind of business should I stop emailing?" }, { change: "kind_off", kind_id: "accountants" }] });
  const first = await c.say("stop emailing them");
  const q = await c.one(first);
  assert.deepEqual([q.status, q.question], ["needs_answer", "Which kind of business should I stop emailing?"]);
  assert.equal((await c.house.call("POST", `/v1/instructions/${first}`, { decision: "yes" })).status, 409);

  const reply = await c.say("the accountants", first);
  assert.equal((await c.one(first)).status, "answered");
  assert.match(c.asked[1].user, /Earlier he said: stop emailing them\nYou asked: Which kind of business should I stop emailing\?\nInstruction \(now\): the accountants/);
  const r = await c.one(reply);
  assert.equal(r.answers, first);
  assert.equal(r.status, "proposed");
  // An answer to something that asked nothing is refused.
  assert.equal((await c.house.call("POST", "/v1/ask", { text: "again", answers: reply })).status, 409);
});

test("a code change becomes an engineering ticket: waiting until a session marks it done with a note", async () => {
  const c = await chiefHouse({ answers: [{ kind: "engineering", department: "engineering", restated: "Make the profiles shorter: needs engineering.", ticket: "He asked: make the profiles shorter. Done: each profile fits one phone screen." }] });
  const id = await c.say("make the profiles shorter");
  const i = await c.one(id);
  assert.deepEqual([i.status, i.department], ["waiting_engineering", "engineering"]);
  const tickets = await openTickets(h.gatewayDb, c.w.tenantId);
  assert.deepEqual(tickets.map((t) => [t.id, t.said]), [[id, "make the profiles shorter"]]);
  assert.match(tickets[0].ticket, /one phone screen/);
  assert.equal((await c.house.call("POST", `/v1/instructions/${id}`, { decision: "yes" })).status, 409, "he cannot mark it done by saying yes");

  await assert.rejects(markTicketDone(h.gatewayDb, c.w.tenantId, id, " "), /note/);
  assert.equal(await markTicketDone(h.gatewayDb, c.w.tenantId, id, "Profiles are now half the length. Live on the call list."), "done");
  assert.equal(await markTicketDone(h.gatewayDb, c.w.tenantId, id, "again"), "not_waiting");
  const done = await c.one(id);
  assert.deepEqual([done.status, done.note], ["done", "Profiles are now half the length. Live on the call list."]);
  assert.deepEqual(await openTickets(h.gatewayDb, c.w.tenantId), []);
});

test("without a model, or a budget, it says so plainly; text is checked", async () => {
  const none = await chiefHouse({ model: null });
  const id = await none.say("stop emailing lawyers");
  assert.deepEqual([(await none.one(id)).status, (await none.one(id)).note], ["not_done", "I can't read instructions yet: no model is connected to me."]);
  assert.equal((await none.house.call("POST", "/v1/ask", { text: "" })).status, 422);
  assert.equal((await none.house.call("POST", "/v1/ask", { text: "x".repeat(1001) })).status, 422);
  assert.equal((await none.house.call("POST", `/v1/instructions/${id}`, { decision: "maybe" })).status, 422);

  const poor = await chiefHouse({ budget: false });
  const p = await poor.say("stop emailing lawyers");
  assert.match((await poor.one(p)).note, /no daily budget/);
  assert.equal(poor.asked.length, 0, "no model call without a budget");
});

test("instructions are append only for every role", async () => {
  const c = await chiefHouse({ answers: [{ change: "pause_floor" }] });
  const id = await c.say("pause outreach");
  for (const db of [h.gatewayDb, h.uiDb]) {
    for (const sql of ["update instructions set said = 'changed'", "delete from instructions", "update instruction_updates set status = 'done'", "delete from instruction_updates"]) {
      await assert.rejects(db.tx(c.w.tenantId, (tx) => tx.query(sql)), (err) => err.code === "42501", sql);
    }
  }
  await assert.rejects(h.agentDb.tx(c.w.tenantId, (tx) => tx.query("select 1 from instructions")), (err) => err.code === "42501", "agent tools cannot see them");
  assert.ok(await c.one(id));
});
