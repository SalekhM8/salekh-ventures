// Phase 1 "passes when" 2: submitting it twice executes it once.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { count, makeWorld, openHarness, request, rows, yes } from "./helpers.js";

const h = openHarness();
after(() => h.close());

test("submitting the same action key twice executes once", async () => {
  const w = await makeWorld(h, { rung: 4 });
  const req = request(w);
  const first = await w.gateway.submit(req);
  const second = await w.gateway.submit(req);
  assert.equal(first.outcome, "executed");
  assert.equal(second.outcome, "refused");
  assert.equal(second.reason, "duplicate_key");
  assert.equal(w.connector.executions.length, 1);
  assert.equal(await count(h, "actions", w.tenantId), 1);
});

test("the same key with a different payload is still refused", async () => {
  const w = await makeWorld(h, { rung: 4 });
  const req = request(w);
  await w.gateway.submit(req);
  const second = await w.gateway.submit({ ...req, payload: { target: "another-fixture", units: 2 } });
  assert.equal(second.reason, "duplicate_key");
  assert.equal(w.connector.executions.length, 1);
});

test("ten submissions of one key at the same moment execute once", async () => {
  const w = await makeWorld(h, { rung: 4 });
  const req = request(w);
  const results = await Promise.all(Array.from({ length: 10 }, () => w.gateway.submit(req)));
  assert.equal(results.filter((r) => r.outcome === "executed").length, 1);
  assert.equal(results.filter((r) => r.outcome === "refused" && r.reason === "duplicate_key").length, 9);
  assert.equal(w.connector.executions.length, 1);
  assert.equal(await count(h, "actions", w.tenantId), 1);
});

test("at rung 2 a second submission makes no second approval, and one yes executes once", async () => {
  const w = await makeWorld(h, { rung: 2 });
  const req = request(w);
  const first = await w.gateway.submit(req);
  const second = await w.gateway.submit(req);
  assert.equal(first.outcome, "waiting_approval");
  assert.equal(second.reason, "duplicate_key");
  assert.equal(await count(h, "approvals", w.tenantId), 1);
  await w.gateway.answerApproval(yes(w, first));
  const third = await w.gateway.submit(req);
  assert.equal(third.reason, "duplicate_key");
  assert.equal(w.connector.executions.length, 1);
});

test("a key that was only ever refused has not been used up", async () => {
  const w = await makeWorld(h, { rung: 4 });
  const req = request(w, { payload: { target: "fixture-target", units: 1000 } });
  const first = await w.gateway.submit(req); // over the fixture cap
  assert.equal(first.reason, "cap_exceeded");
  const second = await w.gateway.submit({ ...req, payload: { target: "fixture-target", units: 1 } });
  assert.equal(second.outcome, "executed");
  assert.equal(w.connector.executions.length, 1);
});

test("the same key under another tenant is a different action", async () => {
  const a = await makeWorld(h, { rung: 4 });
  const b = await makeWorld(h, { rung: 4 });
  const key = request(a).actionKey;
  assert.equal((await a.gateway.submit(request(a, { actionKey: key }))).outcome, "executed");
  assert.equal((await b.gateway.submit(request(b, { actionKey: key }))).outcome, "executed");
  const keys = await rows(h, "select tenant_id from actions where action_key = $1", [key]);
  assert.equal(keys.length, 2);
});

test("a failed execution still uses up its key: it is never retried blind", async () => {
  const w = await makeWorld(h, { rung: 4 });
  w.connector.failNextExecute();
  const req = request(w);
  const first = await w.gateway.submit(req);
  assert.equal(first.outcome, "execution_failed");
  const second = await w.gateway.submit(req);
  assert.equal(second.reason, "duplicate_key");
  const [action] = await rows(h, "select status, error from actions where tenant_id = $1", [w.tenantId]);
  assert.equal(action.status, "failed");
  assert.ok(action.error);
});
