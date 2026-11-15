// Phase 1 "passes when" 7: a department over budget cannot start a run. Plus run records and cost capture.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { control, eventTypes, makeWorld, openHarness, request, rows, setBudget } from "./helpers.js";

const h = openHarness();
after(() => h.close());

const runInput = (w, over = {}) => ({
  tenantId: w.tenantId, businessId: w.businessId, department: "data", trigger: "schedule", model: "fixture-model", ...over,
});
const start = (w, over) => control.startRun(h.gatewayDb, runInput(w, over), { now: w.clock.now() });
const finish = (w, runId, over = {}) =>
  control.finishRun(
    h.gatewayDb,
    { tenantId: w.tenantId, runId, status: "done", tokensIn: 1000, tokensOut: 200, tokensCached: 300, costGbp: 0.4, ...over },
    { now: w.clock.now() },
  );

test("a run is recorded with its tokens and cost, and the day's ledger adds up", async () => {
  const w = await makeWorld(h, { budget: 1 });
  const a = await start(w);
  assert.equal(a.started, true);
  const [running] = await rows(h, "select * from runs where run_id = $1", [a.runId]);
  assert.deepEqual([running.status, running.trigger, running.model, running.ended_at], ["running", "schedule", "fixture-model", null]);
  w.clock.advance(60_000);
  await finish(w, a.runId, { costUsd: 0.5 });
  const [done] = await rows(h, "select * from runs where run_id = $1", [a.runId]);
  assert.equal(done.status, "done");
  assert.deepEqual([done.tokens_in, done.tokens_out, done.tokens_cached], ["1000", "200", "300"]);
  assert.equal(Number(done.cost_gbp), 0.4);
  assert.equal(Number(done.cost_usd), 0.5);
  assert.equal(done.ended_at.getTime() - done.started_at.getTime(), 60_000);

  const b = await start(w);
  await finish(w, b.runId, { status: "failed", error: "fixture failure", costGbp: 0.25 });
  const [failed] = await rows(h, "select status, error from runs where run_id = $1", [b.runId]);
  assert.deepEqual(failed, { status: "failed", error: "fixture failure" });

  const ledger = await rows(h, "select * from budget_ledger where tenant_id = $1", [w.tenantId]);
  assert.equal(ledger.length, 1);
  assert.deepEqual(
    [ledger[0].department, ledger[0].tokens_in, ledger[0].tokens_out, ledger[0].tokens_cached, ledger[0].run_count],
    ["data", "2000", "400", "600", 2],
  );
  assert.equal(Number(ledger[0].cost_gbp), 0.65);
  assert.equal(Number(ledger[0].limit_gbp), 1);
  const status = await control.budgetStatus(h.gatewayDb, runInput(w), { now: w.clock.now() });
  assert.deepEqual(status, { limitGbp: 1, spentGbp: 0.65, over: false });
  assert.deepEqual(await eventTypes(w, (e) => e.runId !== null), ["started", "done", "started", "failed"]);
});

test("a department over its daily budget cannot start a run", async () => {
  const w = await makeWorld(h, { budget: 1 });
  const a = await start(w);
  await finish(w, a.runId, { costGbp: 0.6 });
  const b = await start(w);
  assert.equal(b.started, true, "0.60 of 1.00 spent: still allowed");
  await finish(w, b.runId, { costGbp: 0.4 });
  const refused = await start(w);
  assert.deepEqual([refused.started, refused.reason], [false, "budget_exceeded"]);
  assert.equal((await rows(h, "select 1 from runs where tenant_id = $1", [w.tenantId])).length, 2, "no run row for the refusal");
  const events = await control.listEvents(h.gatewayDb, { tenantId: w.tenantId });
  const last = events.at(-1);
  assert.deepEqual([last.type, last.reasonCode, last.department], ["run_refused", "budget_exceeded", "data"]);
});

test("the budget is per department, per floor and per day", async () => {
  const w = await makeWorld(h, { budget: 1 });
  await setBudget(w, 1, "ads");
  const a = await start(w);
  await finish(w, a.runId, { costGbp: 1.5 });
  assert.equal((await start(w)).started, false);
  assert.equal((await start(w, { department: "ads" })).started, true);
  assert.equal((await start(w, { businessId: w.otherBusinessId })).started, true);
  w.clock.advance(24 * 60 * 60 * 1000);
  assert.equal((await start(w)).started, true, "a new day starts from nothing");
});

test("a department with no budget configured cannot start a run", async () => {
  const w = await makeWorld(h, { budget: null });
  const res = await start(w);
  assert.deepEqual([res.started, res.reason], [false, "budget_not_configured"]);
});

test("a house wide department (no floor) has its own budget", async () => {
  const w = await makeWorld(h);
  const input = { businessId: null, department: "chief-of-staff" };
  assert.equal((await start(w, input)).reason, "budget_not_configured");
  await setBudget(w, 1, "chief-of-staff", null);
  const a = await start(w, input);
  assert.equal(a.started, true);
  await finish(w, a.runId, { costGbp: 1 });
  assert.equal((await start(w, input)).reason, "budget_exceeded");
});

test("finishing a run twice does not count its cost twice", async () => {
  const w = await makeWorld(h, { budget: 1 });
  const a = await start(w);
  assert.equal((await finish(w, a.runId)).recorded, true);
  assert.equal((await finish(w, a.runId)).recorded, false);
  const [ledger] = await rows(h, "select cost_gbp, run_count from budget_ledger where tenant_id = $1", [w.tenantId]);
  assert.deepEqual([Number(ledger.cost_gbp), ledger.run_count], [0.4, 1]);
});

test("the gateway refuses an action from a department that is over budget", async () => {
  const w = await makeWorld(h, { rung: 4, budget: 1 });
  const a = await start(w);
  await finish(w, a.runId, { costGbp: 1 });
  const res = await w.gateway.submit(request(w, { runId: a.runId }));
  assert.deepEqual([res.outcome, res.reason], ["refused", "budget_exceeded"]);
  assert.equal(w.connector.executions.length, 0);
});

test("the gateway refuses an action from a department with no budget at all", async () => {
  const w = await makeWorld(h, { rung: 4 });
  const res = await w.gateway.submit(request(w, { department: "ads" }));
  assert.deepEqual([res.outcome, res.reason], ["refused", "budget_not_configured"]);
});
