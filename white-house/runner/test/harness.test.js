// The agent run harness, end to end with a scripted driver. No network, no real model.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { control, openHarness, rows } from "./helpers.js";
import { TEST_API_KEY, goodScript, makeHouse } from "./house-helpers.js";
import { buildSdkOptions, makePreToolUseHook } from "../dist/agents/sdk-driver.js";

const h = openHarness();
after(() => h.close());
const house = (opts) => makeHouse(h, { server: false, ...opts });
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
const ok = (over = {}) => ({ ok: true, resultText: "", costUsd: 0, numTurns: 1, usage, ...over });
const start = async (x, room = x.room, body = {}) => {
  const res = await x.runtime.startRun(room, body);
  assert.equal(res.status, 202, JSON.stringify(res));
  await x.runtime.idle();
  return res.runId;
};
const events = (x) => control.listEvents(h.gatewayDb, { tenantId: x.w.tenantId, withPayload: true });

test("a run end to end: events, output, cost and the budget ledger", async () => {
  const x = await house();
  const runId = await start(x);
  const [run] = await rows(h, "select * from runs where run_id = $1", [runId]);
  assert.deepEqual([run.status, run.model, run.department, run.business_id, run.error], ["done", "claude-sonnet-5-5", "data", x.w.businessId, null]);
  // tokens in = fresh input + cache writes; cached = cache reads
  assert.deepEqual([run.tokens_in, run.tokens_out, run.tokens_cached], ["110", "40", "30"]);
  assert.equal(Number(run.cost_usd), 0.2, "dollars stored as the SDK reported them");
  assert.equal(Number(run.cost_gbp), 0.1, "pounds at the fixture rate of 0.5");
  const [ledger] = await rows(h, "select * from budget_ledger where tenant_id = $1", [x.w.tenantId]);
  assert.deepEqual([ledger.department, Number(ledger.cost_gbp), ledger.run_count, ledger.tokens_in], ["data", 0.1, 1, "110"]);

  const outputs = await rows(h, "select * from outputs where tenant_id = $1", [x.w.tenantId]);
  assert.equal(outputs.length, 1);
  assert.deepEqual(
    [outputs[0].title, outputs[0].body, outputs[0].run_id, outputs[0].business_id, outputs[0].department],
    ["Fixture daily read", "Fixture body. No target is set.", runId, x.w.businessId, "data"],
  );

  const mine = (await events(x)).filter((e) => e.runId === runId);
  assert.deepEqual(mine.map((e) => e.type), ["started", "brief", "tool_call", "tool_call", "tool_call", "output", "done"]);
  assert.deepEqual(mine.filter((e) => e.type === "tool_call").map((e) => e.summary), [
    "Tool used: read_targets", "Tool used: read_metrics", "Tool used: write_output",
  ]);
  for (const e of mine) {
    assert.equal(e.businessId, x.w.businessId);
    assert.equal(e.department, "data");
    assert.ok(!e.summary.includes("Fixture"), `summary carries model or brief text: ${e.summary}`);
  }
  assert.equal(mine.at(-1).payload.costUsd, 0.2);
});

test("what the driver is given: department folder, pinned model, turn limit, tools, and a bare environment", async () => {
  const x = await house();
  await start(x);
  const spec = x.specs[0];
  assert.ok(spec.cwd.endsWith(path.join("businesses", "fixture-floor-one", "departments", "data")));
  // the folder is a fresh copy with the root, business and department files as its parents and nothing above them
  const root = path.resolve(spec.cwd, "../../../..");
  assert.equal(spec.whRoot, root);
  assert.equal(spec.model, "claude-sonnet-5-5");
  assert.ok(Number.isInteger(spec.maxTurns) && spec.maxTurns > 0 && spec.maxTurns <= 50);
  assert.deepEqual(spec.builtinTools, []);
  assert.deepEqual(spec.allowedTools, [
    "mcp__wh__read_targets", "mcp__wh__read_metrics", "mcp__wh__write_output", "mcp__wh__hand_off", "mcp__wh__propose_action",
  ]);
  assert.deepEqual(spec.tools.map((t) => t.name), ["read_targets", "read_metrics", "write_output", "hand_off", "propose_action"]);
  assert.deepEqual(Object.keys(spec.env).sort(), ["ANTHROPIC_API_KEY", "CLAUDE_AGENT_SDK_CLIENT_APP", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
  assert.equal(spec.env.ANTHROPIC_API_KEY, TEST_API_KEY);
  assert.equal(spec.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.ok(spec.systemAppend.includes("Fixture data role"));
  assert.ok(spec.prompt.length > 0);
  assert.ok(!existsSync(spec.cwd), "the working copy is removed when the run ends");
});

test("the working copy has the three CLAUDE.md files as parents and no other business in it", async () => {
  let seen;
  const x = await house({
    script: async (spec) => {
      const root = spec.whRoot;
      seen = {
        root: existsSync(path.join(root, "CLAUDE.md")),
        business: existsSync(path.join(root, "businesses", "fixture-floor-one", "CLAUDE.md")),
        department: existsSync(path.join(spec.cwd, "CLAUDE.md")),
        otherBusiness: existsSync(path.join(root, "businesses", "fixture-floor-two")),
        otherDepartment: existsSync(path.join(root, "businesses", "fixture-floor-one", "departments", "research")),
        above: [path.dirname(root), path.dirname(path.dirname(root))].some((dir) => existsSync(path.join(dir, "CLAUDE.md"))),
      };
      return goodScript(spec);
    },
  });
  await start(x);
  assert.deepEqual(seen, { root: true, business: true, department: true, otherBusiness: false, otherDepartment: false, above: false });
});

test("the SDK options built from a spec are the ones the brief asks for", async () => {
  const x = await house();
  await start(x, "fixture-floor-one:research", { brief: "Fixture brief" });
  const spec = x.specs[0];
  const options = buildSdkOptions(spec, { fake: "server" });
  assert.equal(options.cwd, spec.cwd);
  assert.equal(options.model, "claude-sonnet-5-5");
  assert.equal(options.maxTurns, spec.maxTurns);
  assert.deepEqual(options.settingSources, ["project"]);
  assert.equal(options.permissionMode, "dontAsk");
  assert.deepEqual(options.tools, ["WebSearch", "WebFetch"]);
  assert.deepEqual(options.allowedTools, ["mcp__wh__read_targets", "mcp__wh__write_output", "WebSearch", "WebFetch"]);
  assert.deepEqual(options.mcpServers, { wh: { fake: "server" } });
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.persistSession, false);
  assert.equal(options.env, spec.env);
  assert.equal(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code", append: spec.systemAppend });
  assert.equal(options.hooks.PreToolUse.length, 1);
  assert.equal(options.hooks.PreToolUse[0].matcher, undefined, "no matcher: the hook sees every tool call");
  assert.equal(options.hooks.PreToolUse[0].onFailure, "block");
  for (const name of Object.keys(spec.env)) {
    assert.ok(!/DATABASE|POSTHOG|WH_API_TOKEN/.test(name), `${name} must not reach the agent process`);
  }
});

test("research gets web reading and its output, and nothing that acts", async () => {
  const x = await house();
  await start(x, "fixture-floor-one:research", { brief: "Fixture brief" });
  const spec = x.specs[0];
  assert.deepEqual(spec.builtinTools, ["WebSearch", "WebFetch"]);
  assert.deepEqual(spec.tools.map((t) => t.name), ["read_targets", "write_output"]);
  assert.ok(spec.prompt.includes("Fixture brief"));
  const refused = await x.runtime.startRun("fixture-floor-one:research", {});
  assert.deepEqual([refused.status, refused.reason], [409, "brief_required"]);
});

test("the hook denies any tool that is not on the list, and the refusal is logged", async () => {
  const results = {};
  const x = await house({
    script: async (spec) => {
      // the same hook function the SDK is given
      const hook = makePreToolUseHook(spec.guard);
      const input = (tool_name) => ({ hook_event_name: "PreToolUse", tool_name, tool_input: { command: "fixture" }, tool_use_id: "t", session_id: "s", cwd: spec.cwd });
      const signal = { signal: new AbortController().signal };
      results.bash = await hook(input("Bash"), "t", signal);
      results.write = await hook(input("Write"), "t", signal);
      results.webFetch = await hook(input("WebFetch"), "t", signal);
      results.otherServer = await hook(input("mcp__other__read_metrics"), "t", signal);
      results.proposeFromResearch = await hook(input("mcp__wh__propose_action"), "t", signal);
      results.allowed = await hook(input("mcp__wh__read_targets"), "t", signal);
      // and through the scripted driver's own call path
      results.called = await spec.call("Bash", { command: "fixture" });
      results.calledMissing = await spec.call("mcp__wh__hand_off", { to_department: "data", title: "x", note: "x" });
      await spec.call("mcp__wh__write_output", { title: "Fixture", body: "Fixture" });
      return ok();
    },
  });
  await start(x, "fixture-floor-one:research", { brief: "Fixture brief" });
  for (const key of ["bash", "write", "otherServer", "proposeFromResearch"]) {
    assert.deepEqual(
      [results[key].hookSpecificOutput.hookEventName, results[key].hookSpecificOutput.permissionDecision],
      ["PreToolUse", "deny"], key);
    assert.ok(results[key].hookSpecificOutput.permissionDecisionReason.length > 0);
  }
  assert.deepEqual(results.allowed, {}, "an allowed tool passes with no opinion");
  assert.deepEqual(results.webFetch, {}, "research may fetch");
  assert.equal(results.called.isError, true);
  assert.equal(results.calledMissing.isError, true);
  const denied = (await events(x)).filter((e) => e.reasonCode === "tool_denied");
  assert.equal(denied.length, 6);
  assert.ok(denied.every((e) => e.type === "tool_call" && !e.summary.includes("Bash")));
  assert.equal(denied[0].payload.tool, "Bash");
  assert.equal((await rows(h, "select 1 from queue_items where tenant_id = $1", [x.w.tenantId])).length, 0);
  assert.equal((await rows(h, "select 1 from proposals where tenant_id = $1", [x.w.tenantId])).length, 0);
});

test("a data agent's web tools are denied too", async () => {
  let result;
  const x = await house({
    script: async (spec) => {
      result = await makePreToolUseHook(spec.guard)(
        { hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: {}, tool_use_id: "t", session_id: "s", cwd: spec.cwd }, "t", { signal: new AbortController().signal });
      return goodScript(spec);
    },
  });
  await start(x);
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
});

test("a tool cannot be pointed at another tenant or business by its input", async () => {
  const other = await house();
  const metric = (tenantId, businessId, name) =>
    h.admin.query(
      `insert into metrics (tenant_id, business_id, metric, value, metric_date, source, metric_window)
       values ($1, $2, $3, 7, ($4::timestamptz)::date - 1, 'test fixture', '1d')`, [tenantId, businessId, name, new Date("2026-11-16T10:00:00Z")]);
  const got = {};
  const x = await house({
    script: async (spec, w) => {
      const aim = { tenant_id: other.w.tenantId, tenantId: other.w.tenantId, business_id: w.otherBusinessId, businessId: w.otherBusinessId, business: "fixture-floor-two", department: "ads" };
      got.metrics = await spec.call("mcp__wh__read_metrics", { ...aim, days: 28 });
      got.targets = await spec.call("mcp__wh__read_targets", aim);
      got.output = await spec.call("mcp__wh__write_output", { ...aim, run_id: "00000000-0000-4000-8000-000000000000", title: "Fixture aimed elsewhere", body: "Fixture" });
      got.handoff = await spec.call("mcp__wh__hand_off", { ...aim, to_department: "ads", title: "Fixture", note: "Fixture" });
      got.offFloor = await spec.call("mcp__wh__hand_off", { to_department: "engineering", title: "Fixture", note: "Fixture" });
      got.self = await spec.call("mcp__wh__hand_off", { to_department: "data", title: "Fixture", note: "Fixture" });
      got.proposal = await spec.call("mcp__wh__propose_action", { ...aim, action_type: "dummy.action", payload: { target: "fixture-target", units: 1 }, reason: "Fixture reason" });
      return ok();
    },
  });
  await metric(x.w.tenantId, x.w.businessId, "fixture_own");
  await metric(x.w.tenantId, x.w.otherBusinessId, "fixture_other_floor");
  await metric(other.w.tenantId, other.w.businessId, "fixture_other_tenant");
  await control.setConfig(h.uiDb, { tenantId: x.w.tenantId, businessId: x.w.otherBusinessId, kind: "target", key: "fixture_other_floor_target", value: { value: 1 }, memberId: x.w.ownerId, reason: "test fixture" });
  const runId = await start(x);

  assert.ok(got.metrics.text.includes("fixture_own"));
  assert.ok(!got.metrics.text.includes("fixture_other_floor") && !got.metrics.text.includes("fixture_other_tenant"));
  assert.ok(!got.targets.text.includes("fixture_other_floor_target"));
  const outputs = await rows(h, "select tenant_id, business_id, department, run_id from outputs where title = 'Fixture aimed elsewhere' and tenant_id in ($1, $2)", [x.w.tenantId, other.w.tenantId]);
  assert.deepEqual(outputs, [{ tenant_id: x.w.tenantId, business_id: x.w.businessId, department: "data", run_id: runId }]);
  const queue = await rows(h, "select tenant_id, business_id, from_department, to_department, kind, source_run from queue_items where tenant_id in ($1, $2)", [x.w.tenantId, other.w.tenantId]);
  assert.deepEqual(queue, [{ tenant_id: x.w.tenantId, business_id: x.w.businessId, from_department: "data", to_department: "ads", kind: "handoff", source_run: runId }]);
  assert.equal(got.offFloor.isError, true, "a department that is not on this floor");
  assert.equal(got.self.isError, true, "a department cannot hand off to itself");
  const proposals = await rows(h, "select tenant_id, business_id, department, run_id, decision from proposals where tenant_id in ($1, $2)", [x.w.tenantId, other.w.tenantId]);
  assert.deepEqual(proposals, [{ tenant_id: x.w.tenantId, business_id: x.w.businessId, department: "data", run_id: runId, decision: "recommend" }]);
  assert.equal(x.w.connector.executions.length, 0, "rung 1: stored, nothing executed");
  assert.equal((await rows(h, "select 1 from outputs where tenant_id = $1", [other.w.tenantId])).length, 0);
  const handoff = (await events(x)).find((e) => e.type === "handoff");
  assert.deepEqual([handoff.summary, handoff.payload.to], ["Work handed to another department", "ads"]);
});

test("a run that throws, or ends without an output, is recorded as failed with whatever it cost", async () => {
  const thrown = await house({ script: async () => { throw new Error("fixture driver failure"); } });
  const a = await start(thrown);
  const [runA] = await rows(h, "select status, error, cost_gbp from runs where run_id = $1", [a]);
  assert.deepEqual([runA.status, Number(runA.cost_gbp)], ["failed", 0]);
  assert.match(runA.error, /fixture driver failure/);

  const empty = await house({ script: async () => ok({ costUsd: 0.4 }) });
  const b = await start(empty);
  const [runB] = await rows(h, "select status, error, cost_usd from runs where run_id = $1", [b]);
  assert.deepEqual([runB.status, runB.error, Number(runB.cost_usd)], ["failed", "no_output", 0.4]);

  const errored = await house({ script: async (spec) => { await spec.call("mcp__wh__write_output", { title: "Fixture", body: "Fixture" }); return ok({ ok: false, error: "error_max_turns", costUsd: 0.6 }); } });
  const c = await start(errored);
  const [runC] = await rows(h, "select status, error, cost_gbp from runs where run_id = $1", [c]);
  assert.deepEqual([runC.status, runC.error, Number(runC.cost_gbp)], ["failed", "error_max_turns", 0.3]);
  const last = (await events(errored)).filter((e) => e.runId === c).at(-1);
  assert.deepEqual([last.type, last.summary], ["failed", "Run failed"]);
  // a later run is still possible, and the failures did not leave the room stuck as running
  assert.equal((await thrown.runtime.startRun(thrown.room, {})).status, 202);
  await thrown.runtime.idle();
});

test("approved memory notes for the department reach the agent; proposed ones do not", async () => {
  const x = await house();
  await h.admin.query(
    `insert into memory_notes (tenant_id, business_id, department, note, status, approved_by) values
       ($1, $2, 'data', 'Fixture approved note for data', 'approved', $3),
       ($1, null, 'data', 'Fixture approved note for every floor', 'approved', $3),
       ($1, $2, 'data', 'Fixture proposed note', 'proposed', null),
       ($1, $2, 'research', 'Fixture note for another department', 'approved', $3),
       ($1, $4, 'data', 'Fixture note for another floor', 'approved', $3)`,
    [x.w.tenantId, x.w.businessId, x.w.ownerId, x.w.otherBusinessId]);
  await start(x);
  const text = x.specs[0].systemAppend;
  assert.ok(text.includes("Fixture approved note for data") && text.includes("Fixture approved note for every floor"));
  assert.ok(!text.includes("Fixture proposed note") && !text.includes("another department") && !text.includes("another floor"));
});

test("the data room pulls traffic totals with plain code before the agent reads them", async () => {
  const calls = [];
  const connector = {
    dailyTraffic: async (query) => {
      calls.push(query);
      return [{ day: "2026-11-14", pageviews: 30, visitors: 12, sessions: 15 }, { day: "2026-11-15", pageviews: 40, visitors: 20, sessions: 22 }];
    },
  };
  let metrics;
  const x = await house({
    traffic: { connector, hostsByBusiness: { "fixture-floor-one": ["fixture.example.test"] } },
    script: async (spec) => { metrics = await spec.call("mcp__wh__read_metrics", { days: 28 }); return goodScript(spec); },
  });
  const runId = await start(x);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].hosts, ["fixture.example.test"]);
  const stored = await rows(h, "select metric, value::int as value, metric_date::text as day, source, metric_window from metrics where tenant_id = $1 order by metric_date, metric", [x.w.tenantId]);
  assert.equal(stored.length, 6);
  assert.deepEqual(stored[0], { metric: "pageviews", value: 30, day: "2026-11-14", source: "posthog", metric_window: "1d" });
  assert.ok(metrics.text.includes("pageviews") && metrics.text.includes("2026-11-15"));
  const types = (await events(x)).filter((e) => e.runId === runId).map((e) => e.type);
  assert.deepEqual(types.slice(0, 3), ["started", "metrics_pulled", "brief"]);
  // research on the same floor does not pull
  await start(x, "fixture-floor-one:research", { brief: "Fixture brief" });
  assert.equal(calls.length, 1);
});

test("a failed pull does not stop the run: the agent is told there is nothing new", async () => {
  const x = await house({
    traffic: { connector: { dailyTraffic: async () => { throw new Error("fixture outage"); } }, hostsByBusiness: { "fixture-floor-one": ["fixture.example.test"] } },
  });
  const runId = await start(x);
  const pulled = (await events(x)).find((e) => e.runId === runId && e.type === "metrics_pulled");
  assert.equal(pulled.reasonCode, "pull_failed");
  assert.equal((await rows(h, "select status from runs where run_id = $1", [runId]))[0].status, "done");
});
