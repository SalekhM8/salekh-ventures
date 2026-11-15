// Phase 1 "passes when" 3, 4 and 5: expiry, changed payloads, wrong accounts. Plus single use.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { HOUR, control, count, eventTypes, makeWorld, openHarness, request, rows, yes } from "./helpers.js";

const h = openHarness();
after(() => h.close());

const statusOf = async (approvalId) =>
  (await rows(h, "select status from approvals where approval_id = $1", [approvalId]))[0].status;

// ---- 3: a yes after expiry is refused ----

test("a yes after expiry is refused and nothing executes", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  w.clock.advance(24 * HOUR + 1000);
  const res = await w.gateway.answerApproval(yes(w, waiting));
  assert.equal(res.outcome, "refused");
  assert.equal(res.reason, "expired");
  assert.equal(w.connector.executions.length, 0);
  assert.equal(await count(h, "actions", w.tenantId), 0);
  assert.equal(await statusOf(waiting.approvalId), "expired");
  assert.ok((await eventTypes(w)).includes("expired"));
  // and it stays refused
  assert.equal((await w.gateway.answerApproval(yes(w, waiting))).outcome, "refused");
  assert.equal(w.connector.executions.length, 0);
});

test("a yes just before expiry is accepted", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  w.clock.advance(24 * HOUR - 1000);
  assert.equal((await w.gateway.answerApproval(yes(w, waiting))).outcome, "executed");
});

test("a yes recorded in time cannot be executed after expiry", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  const decided = await control.decideApproval(h.uiDb, yes(w, waiting), { now: w.clock.now() });
  assert.equal(decided.outcome, "approved");
  w.clock.advance(24 * HOUR + 1000);
  const res = await w.gateway.executeApproval({ tenantId: w.tenantId, approvalId: waiting.approvalId });
  assert.deepEqual([res.outcome, res.reason], ["refused", "expired"]);
  assert.equal(w.connector.executions.length, 0);
});

test("the expiry sweep marks old pending approvals expired", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  assert.equal(await w.gateway.expireApprovals({ tenantId: w.tenantId }), 0);
  w.clock.advance(25 * HOUR);
  assert.equal(await w.gateway.expireApprovals({ tenantId: w.tenantId }), 1);
  assert.equal(await statusOf(waiting.approvalId), "expired");
});

// ---- 4: a payload changed after approval is refused ----

test("a yes given for a different payload hash is refused", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  const otherHash = control.hashPayload({ target: "fixture-target", units: 999 });
  const res = await w.gateway.answerApproval(yes(w, waiting, { payloadHash: otherHash }));
  assert.deepEqual([res.outcome, res.reason], ["refused", "payload_mismatch"]);
  assert.equal(w.connector.executions.length, 0);
  assert.equal(await statusOf(waiting.approvalId), "pending");
});

test("a payload changed after the yes voids the approval: nothing executes", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  const decided = await control.decideApproval(h.uiDb, yes(w, waiting), { now: w.clock.now() });
  assert.equal(decided.outcome, "approved");
  // Only a superuser can do this: no White House role may update the column.
  await h.admin.query(
    `update approvals set payload = '{"target":"changed-after-approval","units":9}' where approval_id = $1`,
    [waiting.approvalId],
  );
  const res = await w.gateway.executeApproval({ tenantId: w.tenantId, approvalId: waiting.approvalId });
  assert.deepEqual([res.outcome, res.reason], ["refused", "payload_changed"]);
  assert.equal(w.connector.executions.length, 0);
  assert.equal(await count(h, "actions", w.tenantId), 0);
  assert.equal(await statusOf(waiting.approvalId), "voided");
  assert.ok((await eventTypes(w)).includes("voided"));
});

test("a payload and hash both changed after the yes still voids it", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  await control.decideApproval(h.uiDb, yes(w, waiting), { now: w.clock.now() });
  const changed = { target: "changed-after-approval", units: 9 };
  await h.admin.query("update approvals set payload = $2, payload_hash = $3 where approval_id = $1", [
    waiting.approvalId, JSON.stringify(changed), control.hashPayload(changed),
  ]);
  const res = await w.gateway.executeApproval({ tenantId: w.tenantId, approvalId: waiting.approvalId });
  assert.deepEqual([res.outcome, res.reason], ["refused", "payload_changed"]);
  assert.equal(w.connector.executions.length, 0);
});

test("a payload changed before the yes: the yes is refused whichever hash it carries", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  const changed = { target: "changed-before-approval", units: 9 };
  await h.admin.query("update approvals set payload = $2 where approval_id = $1", [
    waiting.approvalId, JSON.stringify(changed),
  ]);
  const withOld = await w.gateway.answerApproval(yes(w, waiting));
  assert.deepEqual([withOld.outcome, withOld.reason], ["refused", "payload_changed"]);
  const withNew = await w.gateway.answerApproval(yes(w, waiting, { payloadHash: control.hashPayload(changed) }));
  assert.equal(withNew.outcome, "refused");
  assert.equal(w.connector.executions.length, 0);
  assert.equal(await statusOf(waiting.approvalId), "voided");
});

test("no White House role can rewrite a stored approval payload", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  for (const db of [h.gatewayDb, h.uiDb, h.agentDb]) {
    await assert.rejects(
      db.tx(w.tenantId, (tx) =>
        tx.query(`update approvals set payload = '{"target":"x","units":1}' where approval_id = $1`, [waiting.approvalId]),
      ),
      /permission denied/,
    );
    await assert.rejects(
      db.tx(w.tenantId, (tx) =>
        tx.query("update approvals set payload_hash = repeat('0', 64) where approval_id = $1", [waiting.approvalId]),
      ),
      /permission denied/,
    );
  }
});

// ---- 5: an answer from the wrong account is ignored ----

test("an answer from an account that may not approve is ignored", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  for (const memberId of [w.viewerId, w.disabledId, randomUUID()]) {
    const res = await w.gateway.answerApproval(yes(w, waiting, { memberId }));
    assert.deepEqual([res.outcome, res.reason], ["ignored", "wrong_account"]);
  }
  assert.equal(w.connector.executions.length, 0);
  assert.equal(await statusOf(waiting.approvalId), "pending");
  assert.equal((await eventTypes(w)).filter((t) => t === "answer_refused").length, 3);
  // a no from the wrong account is ignored as well
  const no = await w.gateway.answerApproval(yes(w, waiting, { memberId: w.viewerId, decision: "reject" }));
  assert.equal(no.outcome, "ignored");
  assert.equal(await statusOf(waiting.approvalId), "pending");
  // the right account can still answer
  assert.equal((await w.gateway.answerApproval(yes(w, waiting, { memberId: w.approverId }))).outcome, "executed");
  assert.equal(w.connector.executions.length, 1);
});

test("an answer from another tenant's approver is ignored, whichever tenant it is sent under", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const other = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  // their own member, our tenant
  const one = await w.gateway.answerApproval(yes(w, waiting, { memberId: other.ownerId }));
  assert.deepEqual([one.outcome, one.reason], ["ignored", "wrong_account"]);
  // their own member, their own tenant: the approval is not visible to them at all
  const two = await other.gateway.answerApproval(yes(w, waiting, { tenantId: other.tenantId, memberId: other.ownerId }));
  assert.deepEqual([two.outcome, two.reason], ["ignored", "not_found"]);
  // our member, sent under their tenant
  const three = await w.gateway.answerApproval(yes(w, waiting, { tenantId: other.tenantId }));
  assert.equal(three.outcome, "ignored");
  assert.equal(w.connector.executions.length + other.connector.executions.length, 0);
  assert.equal(await statusOf(waiting.approvalId), "pending");
});

// ---- single use ----

test("an approval cannot be used twice", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  assert.equal((await w.gateway.answerApproval(yes(w, waiting))).outcome, "executed");
  const again = await w.gateway.answerApproval(yes(w, waiting));
  assert.deepEqual([again.outcome, again.reason], ["refused", "already_decided"]);
  const direct = await w.gateway.executeApproval({ tenantId: w.tenantId, approvalId: waiting.approvalId });
  assert.deepEqual([direct.outcome, direct.reason], ["refused", "already_used"]);
  assert.equal(w.connector.executions.length, 1);
  assert.equal(await count(h, "actions", w.tenantId), 1);
});

test("five yeses at the same moment execute once", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  const results = await Promise.all(Array.from({ length: 5 }, () => w.gateway.answerApproval(yes(w, waiting))));
  assert.equal(results.filter((r) => r.outcome === "executed").length, 1);
  assert.equal(w.connector.executions.length, 1);
});

test("five executions of one approved approval at the same moment execute once", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const waiting = await w.gateway.submit(request(w));
  await control.decideApproval(h.uiDb, yes(w, waiting), { now: w.clock.now() });
  const results = await Promise.all(
    Array.from({ length: 5 }, () => w.gateway.executeApproval({ tenantId: w.tenantId, approvalId: waiting.approvalId })),
  );
  assert.equal(results.filter((r) => r.outcome === "executed").length, 1);
  assert.equal(w.connector.executions.length, 1);
});

test("a yes after a no is refused, and an unanswered approval cannot be executed", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const rejected = await w.gateway.submit(request(w));
  await w.gateway.answerApproval(yes(w, rejected, { decision: "reject" }));
  const res = await w.gateway.answerApproval(yes(w, rejected));
  assert.deepEqual([res.outcome, res.reason], ["refused", "already_decided"]);
  const pending = await w.gateway.submit(request(w));
  const direct = await w.gateway.executeApproval({ tenantId: w.tenantId, approvalId: pending.approvalId });
  assert.deepEqual([direct.outcome, direct.reason], ["refused", "not_approved"]);
  assert.equal(w.connector.executions.length, 0);
});

test("a yes for one approval does nothing for another", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const a = await w.gateway.submit(request(w, { payload: { target: "fixture-a", units: 1 } }));
  const b = await w.gateway.submit(request(w, { payload: { target: "fixture-b", units: 2 } }));
  // b's id with a's hash
  const res = await w.gateway.answerApproval(yes(w, b, { payloadHash: a.payloadHash }));
  assert.equal(res.reason, "payload_mismatch");
  await w.gateway.answerApproval(yes(w, a));
  assert.equal(w.connector.executions.length, 1);
  assert.equal(w.connector.executions[0].payload.target, "fixture-a");
  assert.equal(await statusOf(b.approvalId), "pending");
});
