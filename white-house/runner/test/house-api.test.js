// The HTTP API in runner/API.md, route by route, against a real Postgres.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { control, openHarness, request, rows } from "./helpers.js";
import { TEST_TOKEN, makeHouse } from "./house-helpers.js";
import { createRunnerServer } from "../dist/server.js";

const h = openHarness();
const open = [];
after(async () => {
  await Promise.all(open.filter((x) => x.close).map((x) => x.close()));
  await h.close();
});
const house = async (opts) => {
  const x = await makeHouse(h, opts);
  open.push(x);
  return x;
};
const submit = (x, over = {}) => x.runtime.gateway.submit(request(x.w, over));

// ---- auth ----

test("every /v1 route needs the bearer token; /health does not", async () => {
  const x = await house();
  const routes = [
    ["GET", "/v1/house"], ["GET", `/v1/outputs/${randomUUID()}`], ["POST", `/v1/outputs/${randomUUID()}/score`],
    ["POST", `/v1/approvals/${randomUUID()}`], ["POST", "/v1/kill-switch"], ["POST", `/v1/rooms/${x.room}/run`],
    ["POST", `/v1/rooms/${x.room}/acknowledge`], ["POST", "/v1/ask"],
  ];
  for (const [method, route] of routes) {
    assert.equal((await x.call(method, route, method === "POST" ? {} : undefined, null)).status, 401, `${method} ${route} with no token`);
  }
  // (Ten failures from one address is the limit before it is told to wait, so the wrong token is tried on two routes here.
  // The check is made before any route is looked at, and deploy.test.js tries every shape of wrong token.)
  for (const [method, route] of routes.slice(0, 2)) {
    assert.equal((await x.call(method, route, method === "POST" ? {} : undefined, "wrong-token")).status, 401, `${method} ${route} with a wrong token`);
  }
  assert.equal((await x.call("GET", "/health", undefined, null)).status, 200);
  const types = (await rows(h, "select count(*)::int as n from events where tenant_id = $1 and type = 'kill_switch_engaged'", [x.w.tenantId]))[0].n;
  assert.equal(types, 0, "nothing happened on a refused request");
});

test("the API routes do not start without a token", async () => {
  const x = await house({ server: false });
  assert.throws(() => createRunnerServer({ runtime: x.runtime, token: "" }), /WH_API_TOKEN/);
  assert.throws(() => createRunnerServer({ runtime: x.runtime }), /WH_API_TOKEN/);
  // and with no runtime at all there is only the health check
  const bare = createRunnerServer();
  await new Promise((resolve) => bare.listen(0, "127.0.0.1", resolve));
  const res = await fetch(`http://127.0.0.1:${bare.address().port}/v1/house`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
  assert.equal(res.status, 404);
  await new Promise((resolve) => bare.close(resolve));
});

// ---- GET /v1/house ----

test("house: a room for every department on every active floor, idle and empty to start", async () => {
  const x = await house();
  const res = await x.call("GET", "/v1/house");
  assert.equal(res.status, 200);
  assert.ok(!Number.isNaN(Date.parse(res.body.generatedAt)));
  assert.deepEqual(res.body.killSwitch, { global: false, floors: [] });
  assert.deepEqual(res.body.handoffs, []);
  assert.deepEqual(
    res.body.rooms.map((r) => r.id).sort(),
    ["fixture-floor-one:ads", "fixture-floor-one:data", "fixture-floor-one:research", "fixture-floor-two:data"],
  );
  const room = res.body.rooms.find((r) => r.id === x.room);
  assert.deepEqual(room, {
    id: "fixture-floor-one:data", business: "fixture-floor-one", department: "data",
    state: "idle", task: "Nothing assigned", pendingApprovalId: null, proposal: null,
    log: [], outputs: [], costTodayGbp: 0, budgetTodayGbp: 1,
  });
  assert.equal(res.body.rooms.find((r) => r.id === "fixture-floor-one:ads").budgetTodayGbp, null);
  // a floor that is not active has no rooms
  await h.admin.query("update businesses set status = 'paused' where business_id = $1", [x.w.otherBusinessId]);
  x.w.clock.advance(2000);
  const after = await x.call("GET", "/v1/house");
  assert.ok(!after.body.rooms.some((r) => r.business === "fixture-floor-two"));
});

const runInput = (x) => ({ tenantId: x.w.tenantId, businessId: x.w.businessId, department: "data", trigger: "test fixture", model: null });
const finish = (x, runId, status) =>
  control.finishRun(h.gatewayDb, { tenantId: x.w.tenantId, runId, status, tokensIn: 1, tokensOut: 1, tokensCached: 0, costGbp: 0.25 }, { now: x.w.clock.now() });

test("house state: working while a run is in progress, done for 60 seconds after, then idle", async () => {
  const x = await house();
  const run = await control.startRun(h.gatewayDb, runInput(x), { now: x.w.clock.now() });
  x.w.clock.advance(1000);
  assert.equal((await x.roomOf()).state, "working");
  assert.equal((await x.roomOf("fixture-floor-one:ads")).state, "idle", "other rooms are unaffected");
  await finish(x, run.runId, "done");
  x.w.clock.advance(59_000);
  const done = await x.roomOf();
  assert.equal(done.state, "done");
  assert.equal(done.costTodayGbp, 0.25);
  x.w.clock.advance(2000);
  assert.equal((await x.roomOf()).state, "idle");
});

test("house state: failed until acknowledged", async () => {
  const x = await house();
  const run = await control.startRun(h.gatewayDb, runInput(x), { now: x.w.clock.now() });
  await finish(x, run.runId, "failed");
  x.w.clock.advance(10 * 60_000);
  assert.equal((await x.roomOf()).state, "failed", "it stays failed however long it is left");
  const ack = await x.call("POST", `/v1/rooms/${x.room}/acknowledge`, {});
  assert.deepEqual([ack.status, ack.body], [200, { ok: true }]);
  x.w.clock.advance(1000);
  const room = await x.roomOf();
  assert.equal(room.state, "idle");
  assert.equal(room.log.at(-1).kind, "acknowledged");
  assert.equal((await x.call("POST", "/v1/rooms/no-such-floor:data/acknowledge", {})).status, 404);
});

test("house state: waiting while an approval is pending, with the proposal", async () => {
  const x = await house({ rung: 2 });
  const waiting = await submit(x, { reason: "fixture reason for the proposal" });
  x.w.clock.advance(1000);
  const room = await x.roomOf();
  assert.equal(room.state, "waiting");
  assert.equal(room.pendingApprovalId, waiting.approvalId);
  assert.deepEqual(room.proposal, {
    title: "dummy.action", reason: "fixture reason for the proposal", actionType: "dummy.action", rung: 2,
    expiresAt: waiting.expiresAt.toISOString(), undoable: true, payloadHash: waiting.payloadHash,
  });
  // once it has expired the room is no longer waiting
  x.w.clock.advance(25 * 60 * 60 * 1000);
  const later = await x.roomOf();
  assert.deepEqual([later.state, later.pendingApprovalId, later.proposal], ["idle", null, null]);
});

test("house state: handoff for 10 seconds, and handoffs are listed for 30", async () => {
  const x = await house({
    script: async (spec) => {
      await spec.call("mcp__wh__hand_off", { to_department: "ads", title: "Fixture handoff", note: "Fixture note" });
      await spec.call("mcp__wh__write_output", { title: "Fixture", body: "Fixture" });
      return { ok: true, resultText: "", costUsd: 0, numTurns: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } };
    },
  });
  assert.equal((await x.call("POST", `/v1/rooms/${x.room}/run`, {})).status, 202);
  await x.runtime.idle();
  x.w.clock.advance(5000);
  const res = await x.call("GET", "/v1/house");
  assert.equal(res.body.rooms.find((r) => r.id === x.room).state, "handoff");
  const kinds = res.body.handoffs.map((e) => [e.from, e.to]);
  assert.deepEqual(kinds, [["chief", "fixture-floor-one:data"], ["fixture-floor-one:data", "fixture-floor-one:ads"]]);
  for (const e of res.body.handoffs) assert.ok(typeof e.id === "string" && !Number.isNaN(Date.parse(e.at)));
  x.w.clock.advance(6000);
  assert.equal((await x.roomOf()).state, "done", "after 10 seconds the handoff state gives way");
  x.w.clock.advance(30_000);
  assert.deepEqual((await x.call("GET", "/v1/house")).body.handoffs, []);
});

test("house: the log is the last 14 events oldest first, outputs the last 6 newest first", async () => {
  const x = await house();
  for (let i = 0; i < 20; i += 1) {
    await h.gatewayDb.tx(x.w.tenantId, (tx) =>
      control.emitEvent(tx, { tenantId: x.w.tenantId, businessId: x.w.businessId, department: "data", type: "tool_call", summary: `Fixture event ${i}`, now: x.w.clock.now() }));
  }
  for (let i = 0; i < 8; i += 1) {
    await h.admin.query(
      "insert into outputs (tenant_id, business_id, department, title, body, created_at) values ($1, $2, 'data', $3, 'fixture body', $4)",
      [x.w.tenantId, x.w.businessId, `Fixture output ${i}`, new Date(x.w.clock.now().getTime() + i * 1000)]);
  }
  x.w.clock.advance(10_000);
  const room = await x.roomOf();
  assert.deepEqual(room.log.map((e) => e.text), Array.from({ length: 14 }, (_, i) => `Fixture event ${i + 6}`));
  assert.deepEqual(Object.keys(room.log[0]).sort(), ["at", "id", "kind", "text"]);
  assert.equal(room.log[0].kind, "tool_call");
  assert.deepEqual(room.outputs.map((o) => o.title), [7, 6, 5, 4, 3, 2].map((i) => `Fixture output ${i}`));
  assert.deepEqual(Object.keys(room.outputs[0]).sort(), ["at", "id", "runId", "score", "title"]);
  assert.equal(room.outputs[0].score, null);
});

test("house: nothing from another tenant appears", async () => {
  const x = await house();
  const other = await house({ rung: 2 });
  await submit(other);
  x.w.clock.advance(1000);
  const res = await x.call("GET", "/v1/house");
  assert.ok(res.body.rooms.every((r) => r.state === "idle" && r.log.length === 0));
});

// ---- outputs and scores ----

async function withOutput(x) {
  const id = randomUUID();
  const run = await control.startRun(h.gatewayDb, runInput(x), { now: x.w.clock.now() });
  await finish(x, run.runId, "done");
  await h.admin.query(
    "insert into outputs (output_id, tenant_id, business_id, department, run_id, title, body, created_at) values ($1, $2, $3, 'data', $4, 'Fixture daily read', '# Fixture\n\nBody text.', $5)",
    [id, x.w.tenantId, x.w.businessId, run.runId, x.w.clock.now()]);
  return { id, runId: run.runId };
}

test("GET /v1/outputs/:id returns the work, and 404 for an unknown or foreign one", async () => {
  const x = await house();
  const other = await house();
  const out = await withOutput(x);
  const res = await x.call("GET", `/v1/outputs/${out.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    id: out.id, roomId: x.room, runId: out.runId, at: x.w.clock.now().toISOString(),
    title: "Fixture daily read", body: "# Fixture\n\nBody text.",
  });
  assert.equal((await x.call("GET", `/v1/outputs/${randomUUID()}`)).status, 404);
  assert.equal((await x.call("GET", "/v1/outputs/not-an-id")).status, 404);
  assert.equal((await other.call("GET", `/v1/outputs/${out.id}`)).status, 404, "another tenant's runner cannot read it");
});

test("score: under 9 without a note is refused with 422", async () => {
  const x = await house();
  const out = await withOutput(x);
  for (const body of [{ score: 8 }, { score: 1, note: "" }, { score: 5, note: "   " }]) {
    assert.equal((await x.call("POST", `/v1/outputs/${out.id}/score`, body)).status, 422, JSON.stringify(body));
  }
  for (const body of [{ score: 0 }, { score: 11 }, { score: 7.5, note: "x" }, { score: "9" }, {}]) {
    assert.equal((await x.call("POST", `/v1/outputs/${out.id}/score`, body)).status, 422, JSON.stringify(body));
  }
  assert.equal((await rows(h, "select 1 from scores where tenant_id = $1", [x.w.tenantId])).length, 0);
  assert.equal((await rows(h, "select 1 from memory_notes where tenant_id = $1", [x.w.tenantId])).length, 0);
  assert.equal((await x.call("POST", `/v1/outputs/${randomUUID()}/score`, { score: 9 })).status, 404);
});

test("score: under 9 with a note stores the score and proposes a memory note for that department", async () => {
  const x = await house();
  const out = await withOutput(x);
  const res = await x.call("POST", `/v1/outputs/${out.id}/score`, { score: 6, note: "Fixture note: too long" });
  assert.deepEqual([res.status, res.body], [200, { ok: true }]);
  const [score] = await rows(h, "select * from scores where output_id = $1", [out.id]);
  assert.deepEqual([score.score, score.note, score.member_id, score.run_id, score.business_id], [6, "Fixture note: too long", x.w.ownerId, out.runId, x.w.businessId]);
  const notes = await rows(h, "select * from memory_notes where tenant_id = $1", [x.w.tenantId]);
  assert.equal(notes.length, 1);
  assert.deepEqual(
    [notes[0].status, notes[0].department, notes[0].business_id, notes[0].note, notes[0].source_run, notes[0].approved_by],
    ["proposed", "data", x.w.businessId, "Fixture note: too long", out.runId, null],
  );
  x.w.clock.advance(1000);
  const room = await x.roomOf();
  assert.equal(room.outputs[0].score, 6);
  assert.equal(room.log.at(-1).kind, "scored");
  assert.ok(!room.log.at(-1).text.includes("too long"), "the note is not in the event summary");
});

test("score: 9 or 10 needs no note and proposes no memory", async () => {
  const x = await house();
  const out = await withOutput(x);
  assert.equal((await x.call("POST", `/v1/outputs/${out.id}/score`, { score: 9 })).status, 200);
  x.w.clock.advance(1000);
  assert.equal((await x.call("POST", `/v1/outputs/${out.id}/score`, { score: 10, note: "Fixture praise" })).status, 200);
  assert.equal((await rows(h, "select 1 from scores where output_id = $1", [out.id])).length, 2);
  assert.equal((await rows(h, "select 1 from memory_notes where tenant_id = $1", [x.w.tenantId])).length, 0);
  x.w.clock.advance(1000);
  assert.equal((await x.roomOf()).outputs[0].score, 10, "the latest score is shown");
});

// ---- approvals ----

test("approve: recorded as the owner, and the gateway carries out exactly the stored payload", async () => {
  const x = await house({ rung: 2 });
  const payload = { target: "fixture-target", units: 3 };
  const waiting = await submit(x, { payload });
  const res = await x.call("POST", `/v1/approvals/${waiting.approvalId}`, { decision: "approve" });
  assert.deepEqual([res.status, res.body], [200, { status: "approved" }]);
  assert.equal(x.w.connector.executions.length, 1);
  assert.deepEqual(x.w.connector.executions[0].payload, payload);
  const [approval] = await rows(h, "select status, decided_by, channel from approvals where approval_id = $1", [waiting.approvalId]);
  assert.deepEqual(approval, { status: "approved", decided_by: x.w.ownerId, channel: "app" });
  const again = await x.call("POST", `/v1/approvals/${waiting.approvalId}`, { decision: "approve" });
  assert.deepEqual([again.status, again.body.status, again.body.reason], [200, "refused", "already_decided"]);
  assert.equal(x.w.connector.executions.length, 1);
});

test("approve: reject, expired, wrong hash, kill switch, unknown id and a bad body", async () => {
  const x = await house({ rung: 2 });
  const a = await submit(x);
  assert.deepEqual((await x.call("POST", `/v1/approvals/${a.approvalId}`, { decision: "reject" })).body, { status: "rejected" });

  const b = await submit(x);
  const wrong = await x.call("POST", `/v1/approvals/${b.approvalId}`, { decision: "approve", payloadHash: "0".repeat(64) });
  assert.deepEqual(wrong.body, { status: "refused", reason: "payload_mismatch" });
  await control.engageKillSwitch(h.gatewayDb, { tenantId: x.w.tenantId, businessId: null, memberId: x.w.ownerId, reason: "test fixture" });
  const stopped = await x.call("POST", `/v1/approvals/${b.approvalId}`, { decision: "approve", payloadHash: b.payloadHash });
  assert.deepEqual(stopped.body, { status: "refused", reason: "kill_switch" });
  await control.resumeKillSwitch(h.uiDb, { tenantId: x.w.tenantId, businessId: null, memberId: x.w.ownerId, reason: "test fixture" });

  const c = await submit(x);
  await h.admin.query(`update approvals set payload = '{"target":"changed","units":9}' where approval_id = $1`, [c.approvalId]);
  assert.deepEqual((await x.call("POST", `/v1/approvals/${c.approvalId}`, { decision: "approve" })).body, { status: "voided", reason: "payload_changed" });

  const d = await submit(x);
  x.w.clock.advance(25 * 60 * 60 * 1000);
  assert.deepEqual((await x.call("POST", `/v1/approvals/${d.approvalId}`, { decision: "approve" })).body, { status: "expired" });

  assert.equal((await x.call("POST", `/v1/approvals/${randomUUID()}`, { decision: "approve" })).status, 404);
  assert.equal((await x.call("POST", `/v1/approvals/${a.approvalId}`, { decision: "maybe" })).status, 422);
  assert.equal(x.w.connector.executions.length, 0);
});

// ---- kill switch ----

test("kill switch: on stops runs and shows in the house, off lifts it", async () => {
  const x = await house();
  const on = await x.call("POST", "/v1/kill-switch", { on: true });
  assert.deepEqual([on.status, on.body], [200, { killSwitch: { global: true, floors: [] } }]);
  x.w.clock.advance(1000);
  assert.deepEqual((await x.call("GET", "/v1/house")).body.killSwitch, { global: true, floors: [] });
  const run = await x.call("POST", `/v1/rooms/${x.room}/run`, {});
  assert.deepEqual([run.status, run.body], [409, { reason: "kill_switch" }]);
  const off = await x.call("POST", "/v1/kill-switch", { on: false });
  assert.deepEqual(off.body, { killSwitch: { global: false, floors: [] } });
  assert.equal((await x.call("POST", `/v1/rooms/${x.room}/run`, {})).status, 202);
  await x.runtime.idle();
  assert.equal((await x.call("POST", "/v1/kill-switch", { on: "yes" })).status, 422);
  // a floor's own switch is reported by its business id
  await control.engageKillSwitch(h.gatewayDb, { tenantId: x.w.tenantId, businessId: x.w.businessId, memberId: x.w.ownerId, reason: "test fixture" });
  x.w.clock.advance(1000);
  assert.deepEqual((await x.call("GET", "/v1/house")).body.killSwitch, { global: false, floors: ["fixture-floor-one"] });
});

// ---- run ----

test("run: 202 with a run id, and the run finishes with an output", async () => {
  const x = await house();
  const res = await x.call("POST", `/v1/rooms/${x.room}/run`, {});
  assert.equal(res.status, 202);
  assert.deepEqual(Object.keys(res.body), ["runId"]);
  await x.runtime.idle();
  const [run] = await rows(h, "select status, trigger, model from runs where run_id = $1", [res.body.runId]);
  assert.deepEqual(run, { status: "done", trigger: "api", model: "claude-sonnet-5-5" });
  x.w.clock.advance(1000);
  const room = await x.roomOf();
  assert.equal(room.state, "done");
  assert.deepEqual(room.outputs.map((o) => [o.title, o.runId]), [["Fixture daily read", res.body.runId]]);
  assert.equal(room.costTodayGbp, 0.1);
});

test("run: 409 with a reason when it cannot start, and 404 for a room that does not exist", async () => {
  const x = await house();
  const noAgent = await x.call("POST", "/v1/rooms/fixture-floor-one:ads/run", {});
  assert.deepEqual([noAgent.status, noAgent.body], [409, { reason: "no_agent" }]);
  const notLive = await x.call("POST", "/v1/rooms/fixture-floor-two:data/run", {});
  assert.deepEqual([notLive.status, notLive.body], [409, { reason: "no_agent" }], "a department with no live agent on that floor");
  assert.equal((await x.call("POST", "/v1/rooms/fixture-floor-one:creative/run", {})).status, 404);
  assert.equal((await x.call("POST", "/v1/rooms/nonsense/run", {})).status, 404);

  const noKey = await house({ apiKey: undefined });
  const res = await noKey.call("POST", `/v1/rooms/${noKey.room}/run`, {});
  assert.deepEqual([res.status, res.body], [409, { reason: "no_api_key" }]);
  assert.equal((await noKey.call("GET", "/v1/house")).status, 200, "nothing else breaks without a key");

  const noBudget = await house({ budget: null });
  assert.deepEqual((await noBudget.call("POST", `/v1/rooms/${noBudget.room}/run`, {})).body, { reason: "no_budget" });

  const spent = await house();
  const run = await control.startRun(h.gatewayDb, runInput(spent), { now: spent.w.clock.now() });
  await control.finishRun(h.gatewayDb, { tenantId: spent.w.tenantId, runId: run.runId, status: "done", tokensIn: 1, tokensOut: 1, tokensCached: 0, costGbp: 1 }, { now: spent.w.clock.now() });
  const over = await spent.call("POST", `/v1/rooms/${spent.room}/run`, {});
  assert.deepEqual([over.status, over.body], [409, { reason: "over_budget" }]);
  assert.equal(spent.specs.length + noBudget.specs.length + noKey.specs.length + x.specs.length, 0, "the model was never called");
});

test("run: 409 already_running while that room has a run in progress", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const x = await house({
    script: async (spec) => {
      await gate;
      await spec.call("mcp__wh__write_output", { title: "Fixture", body: "Fixture" });
      return { ok: true, resultText: "", costUsd: 0, numTurns: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } };
    },
  });
  assert.equal((await x.call("POST", `/v1/rooms/${x.room}/run`, {})).status, 202);
  const second = await x.call("POST", `/v1/rooms/${x.room}/run`, {});
  assert.deepEqual([second.status, second.body], [409, { reason: "already_running" }]);
  assert.equal((await x.call("POST", "/v1/rooms/fixture-floor-one:research/run", { brief: "Fixture brief" })).status, 202, "another room can run at the same time");
  release();
  await x.runtime.idle();
  assert.equal((await x.call("POST", `/v1/rooms/${x.room}/run`, {})).status, 202);
  await x.runtime.idle();
});

// ---- ask, and anything else ----

test("ask is not built: 501. Unknown routes: 404", async () => {
  const x = await house();
  const res = await x.call("POST", "/v1/ask", { question: "Fixture question" });
  assert.deepEqual([res.status, res.body], [501, { reason: "not_built" }]);
  assert.equal((await x.call("GET", "/v1/nothing")).status, 404);
  assert.equal((await x.call("DELETE", "/v1/house")).status, 404);
  const bad = await fetch(`${x.base}/v1/kill-switch`, { method: "POST", headers: { authorization: `Bearer ${TEST_TOKEN}` }, body: "{not json" });
  assert.equal(bad.status, 400);
});
