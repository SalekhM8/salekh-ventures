// Phase 1 "passes when" 6: the kill switch stops it, and a cap blocks it.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { control, eventTypes, makeWorld, openHarness, request, rows, setCap, yes } from "./helpers.js";

const h = openHarness();
after(() => h.close());

const engage = (w, businessId = null, db = h.gatewayDb) =>
  control.engageKillSwitch(db, { tenantId: w.tenantId, businessId, memberId: w.ownerId, reason: "test fixture" });
const resume = (w, businessId = null, db = h.uiDb) =>
  control.resumeKillSwitch(db, { tenantId: w.tenantId, businessId, memberId: w.ownerId, reason: "test fixture" });

test("the global kill switch stops everything, and resuming from the UI lets it through again", async () => {
  const w = await makeWorld(h, { rung: 4 });
  await engage(w);
  for (const businessId of [w.businessId, w.otherBusinessId]) {
    const res = await w.gateway.submit(request(w, { businessId }));
    assert.deepEqual([res.outcome, res.reason], ["refused", "kill_switch"]);
  }
  assert.equal(w.connector.executions.length, 0);
  await resume(w);
  assert.equal((await w.gateway.submit(request(w))).outcome, "executed");
  const types = await eventTypes(w);
  assert.ok(types.includes("kill_switch_engaged") && types.includes("kill_switch_resumed"));
});

test("a floor's kill switch stops that floor only", async () => {
  const w = await makeWorld(h, { rung: 4 });
  await engage(w, w.businessId);
  const stopped = await w.gateway.submit(request(w));
  assert.deepEqual([stopped.outcome, stopped.reason], ["refused", "kill_switch"]);
  const other = await w.gateway.submit(request(w, { businessId: w.otherBusinessId }));
  assert.equal(other.outcome, "executed");
  assert.equal(w.connector.executions.length, 1);
  // resuming globally does not lift a floor's own switch
  await engage(w);
  await resume(w);
  assert.equal((await w.gateway.submit(request(w))).reason, "kill_switch");
  await resume(w, w.businessId);
  assert.equal((await w.gateway.submit(request(w))).outcome, "executed");
});

test("the kill switch is checked first, before anything else is looked at", async () => {
  const w = await makeWorld(h, { rung: 4 });
  await engage(w);
  const res = await w.gateway.submit(request(w, { actionType: "not.on.the.list" }));
  assert.equal(res.reason, "kill_switch");
});

test("the kill switch stops an action that was already waiting for a yes", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  await engage(w);
  const res = await w.gateway.answerApproval(yes(w, waiting));
  assert.deepEqual([res.outcome, res.reason], ["refused", "kill_switch"]);
  assert.equal(w.connector.executions.length, 0);
  // after a resume the recorded yes can be carried out, once
  await resume(w);
  const done = await w.gateway.executeApproval({ tenantId: w.tenantId, approvalId: waiting.approvalId });
  assert.equal(done.outcome, "executed");
  assert.equal(w.connector.executions.length, 1);
});

test("while the kill switch is set no run starts", async () => {
  const w = await makeWorld(h);
  await engage(w, w.businessId);
  const run = { tenantId: w.tenantId, businessId: w.businessId, department: "data", trigger: "schedule", model: null };
  const res = await control.startRun(h.gatewayDb, run, { now: w.clock.now() });
  assert.deepEqual([res.started, res.reason], [false, "kill_switch"]);
  await resume(w, w.businessId);
  assert.equal((await control.startRun(h.gatewayDb, run, { now: w.clock.now() })).started, true);
});

test("resuming needs the UI: the gateway's database role cannot do it", async () => {
  const w = await makeWorld(h, { rung: 4 });
  await engage(w);
  await assert.rejects(resume(w, null, h.gatewayDb), /row-level security/);
  assert.equal((await w.gateway.submit(request(w))).reason, "kill_switch");
});

test("only an owner can resume, and only a member can engage", async () => {
  const w = await makeWorld(h, { rung: 4 });
  await engage(w);
  for (const memberId of [w.viewerId, w.approverId, w.disabledId]) {
    await assert.rejects(
      control.resumeKillSwitch(h.uiDb, { tenantId: w.tenantId, businessId: null, memberId, reason: "test fixture" }),
      (err) => err.code === "not_permitted",
    );
  }
  const other = await makeWorld(h);
  await assert.rejects(
    control.engageKillSwitch(h.gatewayDb, { tenantId: w.tenantId, businessId: null, memberId: other.ownerId, reason: "x" }),
    (err) => err.code === "not_permitted",
  );
});

// ---- caps ----

test("a cap blocks the action that would go over it", async () => {
  const w = await makeWorld(h, { rung: 4, capLimit: 10 });
  const six = { target: "fixture-target", units: 6 };
  assert.equal((await w.gateway.submit(request(w, { payload: six }))).outcome, "executed");
  const blocked = await w.gateway.submit(request(w, { payload: six }));
  assert.deepEqual([blocked.outcome, blocked.reason], ["refused", "cap_exceeded"]);
  // exactly up to the cap is allowed, one over is not
  assert.equal((await w.gateway.submit(request(w, { payload: { target: "fixture-target", units: 4 } }))).outcome, "executed");
  assert.equal((await w.gateway.submit(request(w))).reason, "cap_exceeded");
  assert.equal(w.connector.executions.length, 2);
  const [used] = await rows(h, "select sum(cap_units)::int as n from actions where tenant_id = $1", [w.tenantId]);
  assert.equal(used.n, 10);
});

test("a cap is per floor and per day", async () => {
  const w = await makeWorld(h, { rung: 4, capLimit: 10 });
  const ten = { target: "fixture-target", units: 10 };
  assert.equal((await w.gateway.submit(request(w, { payload: ten }))).outcome, "executed");
  assert.equal((await w.gateway.submit(request(w))).reason, "cap_exceeded");
  assert.equal((await w.gateway.submit(request(w, { businessId: w.otherBusinessId, payload: ten }))).outcome, "executed");
  w.clock.advance(24 * 60 * 60 * 1000);
  assert.equal((await w.gateway.submit(request(w, { payload: ten }))).outcome, "executed");
});

test("with no cap configured the action is refused", async () => {
  const w = await makeWorld(h, { rung: 4, capLimit: null });
  const res = await w.gateway.submit(request(w));
  assert.deepEqual([res.outcome, res.reason], ["refused", "cap_not_configured"]);
  assert.equal(w.connector.executions.length, 0);
});

test("the cap counts the outside system's own figure when that is higher than the log", async () => {
  const w = await makeWorld(h, { rung: 4, capLimit: 10 });
  w.connector.setLiveCapUsage(10);
  assert.equal((await w.gateway.submit(request(w))).reason, "cap_exceeded");
  w.connector.setLiveCapUsage(9);
  assert.equal((await w.gateway.submit(request(w))).outcome, "executed");
});

test("five actions at the same moment cannot squeeze past the cap together", async () => {
  const w = await makeWorld(h, { rung: 4, capLimit: 10 });
  const four = { target: "fixture-target", units: 4 };
  const results = await Promise.all(Array.from({ length: 5 }, () => w.gateway.submit(request(w, { payload: four }))));
  assert.equal(results.filter((r) => r.outcome === "executed").length, 2);
  assert.equal(results.filter((r) => r.reason === "cap_exceeded").length, 3);
  assert.equal(w.connector.executions.length, 2);
});

test("the cap is checked again when a yes arrives", async () => {
  const w = await makeWorld(h, { rung: 2, capLimit: 10 });
  const six = { target: "fixture-target", units: 6 };
  const a = await w.gateway.submit(request(w, { payload: six }));
  const b = await w.gateway.submit(request(w, { payload: six }));
  assert.equal(b.outcome, "waiting_approval", "nothing has been spent yet, so both may wait");
  assert.equal((await w.gateway.answerApproval(yes(w, a))).outcome, "executed");
  const res = await w.gateway.answerApproval(yes(w, b));
  assert.deepEqual([res.outcome, res.reason], ["refused", "cap_exceeded"]);
  assert.equal(w.connector.executions.length, 1);
});

test("a cap can be lowered and takes effect at once", async () => {
  const w = await makeWorld(h, { rung: 4, capLimit: 10 });
  assert.equal((await w.gateway.submit(request(w, { payload: { target: "fixture-target", units: 5 } }))).outcome, "executed");
  await setCap(w, 5);
  assert.equal((await w.gateway.submit(request(w))).reason, "cap_exceeded");
});
