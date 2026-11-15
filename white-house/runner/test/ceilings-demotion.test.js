// Hard ceilings, the closed action list, the check order, and automatic demotion.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { control, count, eventTypes, makeWorld, openHarness, promoteTo, request, rows, yes } from "./helpers.js";

const h = openHarness();
after(() => h.close());

const currentRung = async (w, actionType = "dummy.action", businessId = w.businessId) => {
  const c = await control.getCurrentConfig(h.gatewayDb, { tenantId: w.tenantId, businessId, kind: "rung", key: actionType });
  return c ? c.value.rung : 1;
};

// ---- hard ceilings ----

test("a hard ceiling holds even when config says a higher rung", async () => {
  const w = await makeWorld(h, { rung: 4 });
  // Written straight into the table as superuser: the UI path refuses to do this (next test).
  await h.admin.query(
    `insert into config_versions (tenant_id, business_id, kind, key, value, version, changed_by_kind, reason)
     values ($1, $2, 'rung', 'dummy.ceiling_two', '{"rung": 4}', 1, 'system', 'test fixture: config above the ceiling')`,
    [w.tenantId, w.businessId],
  );
  const res = await w.gateway.submit(request(w, { actionType: "dummy.ceiling_two" }));
  assert.equal(res.outcome, "waiting_approval", "ceiling 2: it waits for a yes however high config says");
  assert.equal(res.rung, 2);
  assert.equal(w.connector.executions.length, 0);
  const [proposal] = await rows(h, "select config_rung, effective_rung from proposals where proposal_id = $1", [res.proposalId]);
  assert.deepEqual(proposal, { config_rung: 4, effective_rung: 2 });
  const done = await w.gateway.answerApproval(yes(w, res));
  assert.equal(done.outcome, "executed");
  assert.equal((await rows(h, "select rung from actions where action_id = $1", [done.actionId]))[0].rung, 2);
});

test("promotion is one rung at a time, by an owner, and stops at the ceiling", async () => {
  const w = await makeWorld(h, { rung: 1 });
  const promote = (actionType, memberId = w.ownerId) =>
    control.promoteRung(h.uiDb, w.actionTypes, {
      tenantId: w.tenantId, businessId: w.businessId, actionType, memberId, reason: "test fixture",
    });
  assert.equal((await promote("dummy.ceiling_two")).rung, 2);
  await assert.rejects(promote("dummy.ceiling_two"), (err) => err.code === "hard_ceiling");
  assert.equal(await currentRung(w, "dummy.ceiling_two"), 2);
  assert.equal((await promote("dummy.action")).rung, 2);
  assert.equal((await promote("dummy.action")).rung, 3);
  assert.equal((await promote("dummy.action")).rung, 4);
  await assert.rejects(promote("dummy.action"), (err) => err.code === "hard_ceiling");
  await assert.rejects(promote("not.on.the.list"), (err) => err.code === "unknown_action_type");
  for (const memberId of [w.viewerId, w.approverId, w.disabledId]) {
    await assert.rejects(promote("dummy.ceiling_two", memberId), (err) => err.code === "not_permitted");
  }
  // rungs cannot be set through the general config call
  await assert.rejects(
    control.setConfig(h.uiDb, {
      tenantId: w.tenantId, businessId: w.businessId, kind: "rung", key: "dummy.action",
      value: { rung: 4 }, memberId: w.ownerId, reason: "test fixture",
    }),
    (err) => err.code === "invalid_config",
  );
});

test("the gateway's database role cannot promote", async () => {
  const w = await makeWorld(h, { rung: 1 });
  await assert.rejects(
    control.promoteRung(h.gatewayDb, w.actionTypes, {
      tenantId: w.tenantId, businessId: w.businessId, actionType: "dummy.action", memberId: w.ownerId, reason: "test fixture",
    }),
    /row-level security/,
  );
  assert.equal(await currentRung(w), 1);
});

// ---- the closed list and the check order ----

test("an action type that is not on the list is refused", async () => {
  const w = await makeWorld(h, { rung: 4 });
  const res = await w.gateway.submit(request(w, { actionType: "ads.pause_adset" }));
  assert.deepEqual([res.outcome, res.reason], ["refused", "unknown_action_type"]);
  assert.equal(w.connector.executions.length, 0);
  const [proposal] = await rows(h, "select decision, refusal_reason from proposals where proposal_id = $1", [res.proposalId]);
  assert.deepEqual(proposal, { decision: "refused", refusal_reason: "unknown_action_type" });
});

test("a payload of the wrong shape is refused", async () => {
  const w = await makeWorld(h, { rung: 4 });
  const bad = [
    { target: "fixture-target" },
    { target: "fixture-target", units: -1 },
    { target: "fixture-target", units: 1.5 },
    { target: "", units: 1 },
    { target: "fixture-target", units: 1, extra: "field" },
    "a string",
    null,
  ];
  for (const payload of bad) {
    const res = await w.gateway.submit(request(w, { payload }));
    assert.deepEqual([res.outcome, res.reason], ["refused", "invalid_payload"], JSON.stringify(payload));
  }
  assert.equal(w.connector.executions.length, 0);
});

test("a request with no reason, or a malformed one, is rejected outright", async () => {
  const w = await makeWorld(h, { rung: 4 });
  await assert.rejects(w.gateway.submit(request(w, { reason: "" })), (err) => err.code === "invalid_request");
  await assert.rejects(w.gateway.submit(request(w, { actionKey: "" })), (err) => err.code === "invalid_request");
  await assert.rejects(w.gateway.submit(request(w, { tenantId: "nope" })), (err) => err.code === "invalid_request");
  assert.equal(await count(h, "proposals", w.tenantId), 0);
});

test("a floor that is not active is refused, and so is a floor that is not this tenant's", async () => {
  const w = await makeWorld(h, { rung: 4 });
  const other = await makeWorld(h, { rung: 4 });
  await h.admin.query("update businesses set status = 'paused' where business_id = $1", [w.businessId]);
  const paused = await w.gateway.submit(request(w));
  assert.deepEqual([paused.outcome, paused.reason], ["refused", "floor_inactive"]);
  const foreign = await w.gateway.submit(request(w, { businessId: other.businessId }));
  assert.deepEqual([foreign.outcome, foreign.reason], ["refused", "unknown_business"]);
  assert.equal(w.connector.executions.length + other.connector.executions.length, 0);
  assert.equal(await count(h, "proposals", other.tenantId), 0);
});

test("checks run in the order the brief gives", async () => {
  // floor active is checked before the action list
  const w1 = await makeWorld(h, { rung: 4 });
  await h.admin.query("update businesses set status = 'paused' where business_id = $1", [w1.businessId]);
  assert.equal((await w1.gateway.submit(request(w1, { actionType: "not.on.the.list" }))).reason, "floor_inactive");
  // the action list before the cap
  const w2 = await makeWorld(h, { rung: 4, capLimit: null });
  assert.equal((await w2.gateway.submit(request(w2, { actionType: "not.on.the.list" }))).reason, "unknown_action_type");
  // the cap before the key, the key before the budget
  const w3 = await makeWorld(h, { rung: 4, capLimit: 1 });
  const first = request(w3);
  assert.equal((await w3.gateway.submit(first)).outcome, "executed");
  assert.equal((await w3.gateway.submit(first)).reason, "cap_exceeded");
  const w4 = await makeWorld(h, { rung: 4 });
  const again = request(w4);
  assert.equal((await w4.gateway.submit(again)).outcome, "executed");
  assert.equal((await w4.gateway.submit({ ...again, department: "ads" })).reason, "duplicate_key");
});

// ---- demotion ----

test("a failed read back demotes the action type one rung and tells Salekh", async () => {
  const w = await makeWorld(h, { rung: 3 });
  w.connector.failNextReadBack();
  const res = await w.gateway.submit(request(w));
  assert.equal(res.outcome, "executed");
  assert.equal(res.verified, false);
  assert.equal(res.demotedTo, 2);
  assert.equal(await currentRung(w), 2);
  const [action] = await rows(h, "select status, verified from actions where action_id = $1", [res.actionId]);
  assert.deepEqual(action, { status: "executed", verified: false });
  const config = await control.getCurrentConfig(h.gatewayDb, {
    tenantId: w.tenantId, businessId: w.businessId, kind: "rung", key: "dummy.action",
  });
  assert.equal(config.changedByKind, "system");
  assert.equal(config.changedByMember, null);
  const types = await eventTypes(w, (e) => e.proposalId === res.proposalId);
  assert.deepEqual(types.slice(0, 5), ["proposal", "executing", "executed", "verify_failed", "demoted"]);
  const alerts = await rows(h, "select kind from notifications where tenant_id = $1 and kind = 'alert'", [w.tenantId]);
  assert.ok(alerts.length >= 1);
  // the next one waits for a yes
  assert.equal((await w.gateway.submit(request(w))).outcome, "waiting_approval");
  assert.equal(w.connector.executions.length, 1);
});

test("demotion steps down one rung each time and stops at 1", async () => {
  const w = await makeWorld(h, { rung: 4 });
  w.connector.failNextReadBack();
  assert.equal((await w.gateway.submit(request(w))).demotedTo, 3);
  w.connector.failNextReadBack();
  assert.equal((await w.gateway.submit(request(w))).demotedTo, 2);
  w.connector.failNextReadBack();
  const waiting = await w.gateway.submit(request(w));
  const res = await w.gateway.answerApproval(yes(w, waiting));
  assert.deepEqual([res.outcome, res.verified, res.demotedTo], ["executed", false, 1]);
  assert.equal(await currentRung(w), 1);
  assert.equal((await w.gateway.submit(request(w))).outcome, "recommended");
});

test("a read back that cannot be done at all counts as failed", async () => {
  const w = await makeWorld(h, { rung: 4 });
  w.connector.throwOnNextReadBack();
  const res = await w.gateway.submit(request(w));
  assert.deepEqual([res.outcome, res.verified, res.demotedTo], ["executed", false, 3]);
});

test("demotion touches only that action type on that floor", async () => {
  const w = await makeWorld(h, { rung: 4 });
  await promoteTo(w, 2, "dummy.ceiling_two");
  w.connector.failNextReadBack();
  await w.gateway.submit(request(w));
  assert.equal(await currentRung(w), 3);
  assert.equal(await currentRung(w, "dummy.action", w.otherBusinessId), 4);
  assert.equal(await currentRung(w, "dummy.ceiling_two"), 2);
});

test("an action Salekh marks wrong afterwards demotes its type one rung, once", async () => {
  const w = await makeWorld(h, { rung: 4 });
  const res = await w.gateway.submit(request(w));
  assert.equal(res.verified, true);
  const mark = (memberId = w.ownerId, tenantId = w.tenantId) =>
    w.gateway.markActionWrong({ tenantId, actionId: res.actionId, memberId, note: "test fixture note" });
  await assert.rejects(mark(w.viewerId), (err) => err.code === "not_permitted");
  assert.equal(await currentRung(w), 4);
  const marked = await mark();
  assert.deepEqual([marked.outcome, marked.demotedTo], ["marked_wrong", 3]);
  assert.equal(await currentRung(w), 3);
  const [action] = await rows(h, "select marked_wrong_by, marked_wrong_note from actions where action_id = $1", [res.actionId]);
  assert.deepEqual(action, { marked_wrong_by: w.ownerId, marked_wrong_note: "test fixture note" });
  const types = await eventTypes(w);
  assert.ok(types.includes("marked_wrong") && types.includes("demoted"));
  const again = await mark();
  assert.deepEqual([again.outcome, again.reason], ["refused", "already_marked"]);
  assert.equal(await currentRung(w), 3, "marked twice, demoted once");
  const other = await makeWorld(h);
  const foreign = await other.gateway.markActionWrong({
    tenantId: other.tenantId, actionId: res.actionId, memberId: other.ownerId, note: "x",
  });
  assert.deepEqual([foreign.outcome, foreign.reason], ["refused", "not_found"]);
});

test("a connector with no read back leaves the action unverified and does not demote", async () => {
  const w = await makeWorld(h, { rung: 4 });
  const calls = [];
  const gateway = control.createGateway({
    db: h.gatewayDb,
    actionTypes: w.actionTypes,
    connectors: { dummy: { execute: async (call) => (calls.push(call), { reference: "fixture-ref", output: {} }) } },
    now: w.clock.now,
  });
  const res = await gateway.submit(request(w));
  assert.deepEqual([res.outcome, res.verified, res.demotedTo], ["executed", null, undefined]);
  assert.equal(calls.length, 1);
  assert.equal(await currentRung(w), 4);
  assert.deepEqual(await eventTypes(w, (e) => e.proposalId === res.proposalId), ["proposal", "executing", "executed"]);
});

test("a failed execution is logged, tells Salekh, and does not demote", async () => {
  const w = await makeWorld(h, { rung: 4 });
  w.connector.failNextExecute();
  const res = await w.gateway.submit(request(w));
  assert.equal(res.outcome, "execution_failed");
  assert.equal(await currentRung(w), 4);
  assert.deepEqual(await eventTypes(w, (e) => e.proposalId === res.proposalId), [
    "proposal", "executing", "execution_failed", "notified",
  ]);
});

test("a gateway with an action type whose connector is missing refuses to be built", () => {
  assert.throws(
    () => control.createGateway({ db: h.gatewayDb, actionTypes: control.actionTypes, connectors: {} }),
    /connector/,
  );
});

test("the production action list holds the dummy action and nothing else", () => {
  assert.deepEqual(control.actionTypes.names(), ["dummy.action"]);
  const t = control.actionTypes.get("dummy.action");
  assert.deepEqual([t.maxRung, t.cap.key, t.cap.window, t.undoable, t.connector], [4, "dummy_units_per_day", "day", true, "dummy"]);
});
