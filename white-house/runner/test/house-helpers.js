// Harness for the HTTP API, the agent run harness and the evals. Real Postgres, fake model driver.
// Every figure and every name here is a TEST FIXTURE.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { control, makeWorld } from "./helpers.js";
import { createRuntime } from "../dist/runtime.js";
import { createRunnerServer } from "../dist/server.js";
import { createScriptedDriver } from "../dist/agents/scripted-driver.js";

export const TEST_TOKEN = "test-token-not-a-secret";
export const TEST_API_KEY = "test-key-not-a-real-key";
export const TEST_USD_TO_GBP = 0.5; // fixture rate, chosen to make the sums obvious

/** A throwaway white-house tree with the fixture floor's department folders. */
export function makeWhRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "wh-test-root-"));
  writeFileSync(path.join(root, "CLAUDE.md"), "# Fixture root rules\n");
  mkdirSync(path.join(root, "agents"));
  for (const type of ["data", "research"]) writeFileSync(path.join(root, "agents", `${type}.md`), `# Fixture ${type} role\n`);
  for (const floor of ["fixture-floor-one", "fixture-floor-two"]) {
    const dir = path.join(root, "businesses", floor);
    mkdirSync(path.join(dir, "departments", "data"), { recursive: true });
    mkdirSync(path.join(dir, "departments", "research"), { recursive: true });
    writeFileSync(path.join(dir, "CLAUDE.md"), `# Fixture business ${floor}\n`);
    writeFileSync(path.join(dir, "departments", "data", "CLAUDE.md"), "# Fixture data room\n");
    writeFileSync(path.join(dir, "departments", "research", "CLAUDE.md"), "# Fixture research room\n");
  }
  return root;
}

/** A good run: reads, writes one output, reports a cost. */
export const goodScript = async (spec) => {
  await spec.call("mcp__wh__read_targets", {});
  await spec.call("mcp__wh__read_metrics", { days: 28 });
  await spec.call("mcp__wh__write_output", { title: "Fixture daily read", body: "Fixture body. No target is set." });
  return { ok: true, resultText: "done", costUsd: 0.2, numTurns: 4, usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 30, cacheCreationTokens: 10 } };
};

/**
 * A world (tenant, gateway fixtures) plus a runtime and, on request, a server.
 * Floor one has data (live), ads (no agent) and research (live).
 */
export async function makeHouse(h, opts = {}) {
  const w = await makeWorld(h, { rung: opts.rung ?? 1, budget: opts.budget });
  await h.admin.query("update tenants set slug = $2 where tenant_id = $1", [w.tenantId, `fixture-${w.tenantId.slice(0, 8)}`]);
  await h.admin.query("update businesses set departments = '{data,ads,research}' where business_id = $1", [w.businessId]);
  const live = (department, businessId = w.businessId) =>
    control.setConfig(h.uiDb, {
      tenantId: w.tenantId, businessId, kind: "schedule", key: department,
      value: { live: true }, memberId: w.ownerId, reason: "test fixture",
    });
  await live("data");
  await live("research");
  if (opts.budget !== null) {
    await control.setConfig(h.uiDb, {
      tenantId: w.tenantId, businessId: w.businessId, kind: "budget", key: "research",
      value: { daily_limit_gbp: 1 }, memberId: w.ownerId, reason: "test fixture",
    });
  }
  const specs = [];
  const script = opts.script ?? goodScript;
  const driver = createScriptedDriver(async (spec) => {
    specs.push(spec);
    return script(spec, w);
  });
  const runtime = createRuntime({
    gatewayDb: h.gatewayDb, uiDb: h.uiDb, agentDb: h.agentDb,
    tenantId: w.tenantId,
    whRoot: opts.whRoot ?? makeWhRoot(),
    driver,
    apiKeyFor: () => ("apiKey" in opts ? opts.apiKey : TEST_API_KEY),
    now: w.clock.now,
    usdToGbp: TEST_USD_TO_GBP,
    actionTypes: w.actionTypes,
    connectors: { dummy: w.connector },
    traffic: opts.traffic,
  });
  const house = { w, runtime, specs, room: "fixture-floor-one:data" };
  if (opts.server !== false) {
    const server = createRunnerServer({ runtime, token: TEST_TOKEN });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    house.base = `http://127.0.0.1:${server.address().port}`;
    house.close = () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    house.call = async (method, route, body, token = TEST_TOKEN) => {
      const res = await fetch(`${house.base}${route}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    house.roomOf = async (id = house.room) => (await house.call("GET", "/v1/house")).body.rooms.find((r) => r.id === id);
  }
  return house;
}
