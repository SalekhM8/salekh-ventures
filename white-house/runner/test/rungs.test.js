// Phase 1 "passes when" 1 and 8: the four rungs, and every step on the event stream.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { control, count, eventTypes, makeWorld, openHarness, request, rows, yes } from "./helpers.js";

const h = openHarness();
after(() => h.close());

test("rung 1 (recommend): the proposal is stored and nothing executes", async () => {
  const w = await makeWorld(h, { rung: 1 });
  const res = await w.gateway.submit(request(w));
  assert.equal(res.outcome, "recommended");
  assert.equal(res.rung, 1);
  assert.equal(w.connector.executions.length, 0);
  const [proposal] = await rows(h, "select * from proposals where proposal_id = $1", [res.proposalId]);
  assert.equal(proposal.decision, "recommend");
  assert.equal(proposal.reason, "test fixture reason");
  assert.equal(await count(h, "approvals", w.tenantId), 0);
  assert.equal(await count(h, "actions", w.tenantId), 0);
});

test("an action type with no rung configured is treated as rung 1", async () => {
  const w = await makeWorld(h, { rung: 1 });
  const res = await w.gateway.submit(request(w, { actionType: "dummy.ceiling_two" }));
  assert.equal(res.outcome, "recommended");
  assert.equal(w.connector.executions.length, 0);
});

test("rung 2 (act with approval): waits, then a yes executes exactly the stored payload", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const payload = { target: "fixture-target", units: 3 };
  const waiting = await w.gateway.submit(request(w, { payload }));
  assert.equal(waiting.outcome, "waiting_approval");
  assert.equal(waiting.rung, 2);
  assert.equal(waiting.payloadHash, control.hashPayload(payload));
  assert.equal(w.connector.executions.length, 0, "nothing executes before the yes");
  assert.equal(await count(h, "actions", w.tenantId), 0);

  const [approval] = await rows(h, "select * from approvals where approval_id = $1", [waiting.approvalId]);
  assert.equal(approval.status, "pending");
  assert.deepEqual(approval.payload, payload);
  assert.equal(approval.payload_hash, waiting.payloadHash);
  assert.equal(approval.reasoning, "test fixture reason");
  // 24 hours by default
  assert.equal(approval.expires_at.getTime() - w.clock.now().getTime(), 24 * 60 * 60 * 1000);

  // Salekh is told: one in-app notification per member who may approve.
  const notes = await rows(h, "select member_id from notifications where approval_id = $1", [waiting.approvalId]);
  assert.deepEqual(notes.map((n) => n.member_id).sort(), [w.ownerId, w.approverId].sort());

  const done = await w.gateway.answerApproval(yes(w, waiting));
  assert.equal(done.outcome, "executed");
  assert.equal(done.verified, true);
  assert.equal(w.connector.executions.length, 1);
  assert.deepEqual(w.connector.executions[0].payload, payload);

  const [action] = await rows(h, "select * from actions where action_id = $1", [done.actionId]);
  assert.equal(action.rung, 2);
  assert.equal(action.approval_id, waiting.approvalId);
  assert.equal(action.status, "executed");
  assert.equal(action.verified, true);
  assert.deepEqual(action.input, payload);
  assert.equal(action.input_hash, waiting.payloadHash);
  assert.ok(action.outside_reference);
  const [after] = await rows(h, "select * from approvals where approval_id = $1", [waiting.approvalId]);
  assert.equal(after.status, "approved");
  assert.equal(after.decided_by, w.ownerId);
  assert.equal(after.channel, "app");
  assert.ok(after.consumed_at);
});

test("rung 2: a no executes nothing", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  const res = await w.gateway.answerApproval(yes(w, waiting, { decision: "reject" }));
  assert.equal(res.outcome, "rejected");
  assert.equal(w.connector.executions.length, 0);
  assert.equal(await count(h, "actions", w.tenantId), 0);
  const [approval] = await rows(h, "select status from approvals where approval_id = $1", [waiting.approvalId]);
  assert.equal(approval.status, "rejected");
});

test("rung 3 (act and notify): executes at once, checks the result, and tells Salekh", async () => {
  const w = await makeWorld(h, { rung: 3 });
  const res = await w.gateway.submit(request(w));
  assert.equal(res.outcome, "executed");
  assert.equal(res.rung, 3);
  assert.equal(res.verified, true);
  assert.equal(w.connector.executions.length, 1);
  assert.equal(await count(h, "approvals", w.tenantId), 0);
  const [action] = await rows(h, "select * from actions where action_id = $1", [res.actionId]);
  assert.equal(action.rung, 3);
  assert.equal(action.approval_id, null);
  assert.equal(action.verified, true);
  const notes = await rows(h, "select kind from notifications where action_id = $1", [res.actionId]);
  assert.ok(notes.length >= 1, "rung 3 notifies");
  assert.ok(notes.every((n) => n.kind === "action"));
});

test("rung 4 (act silently): executes and notifies nobody", async () => {
  const w = await makeWorld(h, { rung: 4 });
  const res = await w.gateway.submit(request(w));
  assert.equal(res.outcome, "executed");
  assert.equal(res.rung, 4);
  assert.equal(res.verified, true);
  assert.equal(w.connector.executions.length, 1);
  assert.equal(await count(h, "notifications", w.tenantId), 0);
  const [action] = await rows(h, "select rung, status from actions where action_id = $1", [res.actionId]);
  assert.deepEqual(action, { rung: 4, status: "executed" });
});

// ---- "passes when" 8: every step shows on the event stream ----

const gatewaySteps = (e) => e.proposalId !== null;

test("event stream, rung 1: proposal", async () => {
  const w = await makeWorld(h, { rung: 1 });
  await w.gateway.submit(request(w));
  assert.deepEqual(await eventTypes(w, gatewaySteps), ["proposal"]);
});

test("event stream, rung 2: proposal, waiting, notified, approved, executing, executed, verified", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  assert.deepEqual(await eventTypes(w, gatewaySteps), ["proposal", "waiting", "notified"]);
  await w.gateway.answerApproval(yes(w, waiting));
  assert.deepEqual(await eventTypes(w, gatewaySteps), [
    "proposal", "waiting", "notified", "approved", "executing", "executed", "verified",
  ]);
});

test("event stream, rung 2 rejected: proposal, waiting, notified, rejected", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  await w.gateway.answerApproval(yes(w, waiting, { decision: "reject" }));
  assert.deepEqual(await eventTypes(w, gatewaySteps), ["proposal", "waiting", "notified", "rejected"]);
});

test("event stream, rung 3: proposal, executing, executed, verified, notified", async () => {
  const w = await makeWorld(h, { rung: 3 });
  await w.gateway.submit(request(w));
  assert.deepEqual(await eventTypes(w, gatewaySteps), ["proposal", "executing", "executed", "verified", "notified"]);
});

test("event stream, rung 4: proposal, executing, executed, verified", async () => {
  const w = await makeWorld(h, { rung: 4 });
  await w.gateway.submit(request(w));
  assert.deepEqual(await eventTypes(w, gatewaySteps), ["proposal", "executing", "executed", "verified"]);
});

test("event stream: a refusal is an event too, with its reason code", async () => {
  const w = await makeWorld(h, { rung: 4 });
  const res = await w.gateway.submit(request(w, { actionType: "not.on.the.list" }));
  assert.equal(res.outcome, "refused");
  const events = await control.listEvents(h.gatewayDb, { tenantId: w.tenantId });
  const refused = events.filter((e) => e.type === "refused");
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reasonCode, "unknown_action_type");
  assert.equal(refused[0].proposalId, res.proposalId);
});

test("event stream: events carry ids, rung and action type, in one ordered sequence", async () => {
  const w = await makeWorld(h, { rung: 3 });
  const res = await w.gateway.submit(request(w));
  const events = (await control.listEvents(h.gatewayDb, { tenantId: w.tenantId })).filter(gatewaySteps);
  const seqs = events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
  for (const e of events) {
    assert.equal(e.proposalId, res.proposalId);
    assert.equal(e.businessId, w.businessId);
    assert.equal(e.department, "data");
    assert.equal(e.actionType, "dummy.action");
  }
  assert.equal(events.find((e) => e.type === "executed").actionId, res.actionId);
  assert.equal(events.find((e) => e.type === "proposal").rung, 3);
});

test("event summaries hold no payload text; the full payload sits apart with a 90 day life", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const secret = "fixture-person@example.test";
  const waiting = await w.gateway.submit(request(w, { payload: { target: secret, units: 1 }, reason: `about ${secret}` }));
  await w.gateway.answerApproval(yes(w, waiting));
  const events = await control.listEvents(h.gatewayDb, { tenantId: w.tenantId, withPayload: true });
  assert.ok(events.length >= 7);
  for (const e of events) assert.ok(!e.summary.includes(secret), `summary leaked payload text: ${e.summary}`);
  const proposal = events.find((e) => e.type === "proposal");
  assert.equal(proposal.payload.payload.target, secret);
  const ninetyDays = 90 * 24 * 60 * 60 * 1000;
  assert.equal(proposal.payloadExpiresAt.getTime() - w.clock.now().getTime(), ninetyDays);

  // Before the 90 days are up these payloads are untouched; after, they go and the summaries stay.
  // (The fixture's own config events were written on the real clock, so only this flow's are checked here.)
  const early = new Date(w.clock.now().getTime() + ninetyDays - 1000);
  await control.purgeExpiredPayloads(h.gatewayDb, { tenantId: w.tenantId }, early);
  const kept = await control.listEvents(h.gatewayDb, { tenantId: w.tenantId, withPayload: true });
  assert.equal(kept.find((e) => e.type === "proposal").payload.payload.target, secret);
  const late = new Date(w.clock.now().getTime() + ninetyDays + 1000);
  assert.ok((await control.purgeExpiredPayloads(h.gatewayDb, { tenantId: w.tenantId }, late)) >= 1);
  const afterPurge = await control.listEvents(h.gatewayDb, { tenantId: w.tenantId, withPayload: true });
  assert.equal(afterPurge.length, events.length);
  assert.ok(afterPurge.every((e) => e.payload === null && e.summary.length > 0));
});

test("the event emitter refuses a summary that looks like it holds an email address or a phone number", async () => {
  const w = await makeWorld(h);
  const emit = (summary) =>
    h.gatewayDb.tx(w.tenantId, (tx) =>
      control.emitEvent(tx, { tenantId: w.tenantId, businessId: w.businessId, type: "tool_call", summary }),
    );
  await assert.rejects(emit("replied to someone@example.test"), /personal data/);
  await assert.rejects(emit("called 07700 900123 back"), /personal data/);
  await emit("looked up the knowledge base");
});
