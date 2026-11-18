// Harness for the HTTP API, the agent run harness and the evals. Real Postgres, fake model driver.
// Every figure and every name here is a TEST FIXTURE.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { control, makeWorld } from "./helpers.js";
import { createRuntime } from "../dist/runtime.js";
import { createRunnerServer } from "../dist/server.js";
import { createScriptedDriver } from "../dist/agents/scripted-driver.js";

import { enquiryAction } from "../dist/control/action-types.js";
export const TEST_TOKEN = "test-token-not-a-secret";
export const TEST_API_KEY = "test-key-not-a-real-key";
export const TEST_USD_TO_GBP = 0.5; // fixture rate, chosen to make the sums obvious

/** A throwaway white-house tree with the fixture floor's department folders. */
export function makeWhRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "wh-test-root-"));
  writeFileSync(path.join(root, "CLAUDE.md"), "# Fixture root rules\n");
  mkdirSync(path.join(root, "agents"));
  for (const type of ["data", "research", "outreach-find", "outreach-analyse", "outreach-draft", "outreach-enquiry", "outreach-reply"]) writeFileSync(path.join(root, "agents", `${type}.md`), `# Fixture ${type} role\n`);
  for (const floor of ["fixture-floor-one", "fixture-floor-two"]) {
    const dir = path.join(root, "businesses", floor);
    mkdirSync(path.join(dir, "departments", "data"), { recursive: true });
    mkdirSync(path.join(dir, "departments", "research"), { recursive: true });
    writeFileSync(path.join(dir, "CLAUDE.md"), `# Fixture business ${floor}\n`);
    writeFileSync(path.join(dir, "departments", "data", "CLAUDE.md"), "# Fixture data room\n");
    writeFileSync(path.join(dir, "departments", "research", "CLAUDE.md"), "# Fixture research room\n");
    mkdirSync(path.join(dir, "departments", "outreach"), { recursive: true });
    writeFileSync(path.join(dir, "departments", "outreach", "CLAUDE.md"), "# Fixture outreach room\n");
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
  const w = await makeWorld(h, { rung: opts.rung ?? 1, budget: opts.budget, clock: opts.clock });
  await h.admin.query("update tenants set slug = $2 where tenant_id = $1", [w.tenantId, `fixture-${w.tenantId.slice(0, 8)}`]);
  await h.admin.query("update businesses set departments = '{data,ads,research}' where business_id = $1", [w.businessId]);
  const live = (department, businessId = w.businessId) =>
    control.setConfig(h.uiDb, {
      tenantId: w.tenantId, businessId, kind: "schedule", key: department,
      value: { live: true }, memberId: w.ownerId, reason: "test fixture",
    });
  await live("data");
  await live("research");
  if (opts.outreach) {
    await h.admin.query("update businesses set departments = '{data,ads,research,outreach}' where business_id = $1", [w.businessId]);
    await live("outreach");
    const set = (kind, value) => control.setConfig(h.uiDb, { tenantId: w.tenantId, businessId: w.businessId, kind, key: "outreach", value, memberId: w.ownerId, reason: "test fixture" });
    await set("budget", { daily_limit_gbp: opts.outreach.budget ?? 5 });
    if (opts.outreach.settings) await set("setting", opts.outreach.settings);
  }
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
    // The test world's own dummy types, and the one real sending action.
    actionTypes: control.createActionTypeRegistry([...w.actionTypes.names().map((n) => w.actionTypes.get(n)), enquiryAction]),
    connectors: { dummy: w.connector },
    traffic: opts.traffic,
    companiesHouse: opts.companiesHouse ?? null,
    model: opts.model ?? null,
    reach: opts.reach ?? null,
    sleep: opts.sleep,
    mailbox: opts.mailbox ?? null,
    ownerMailbox: opts.ownerMailbox ?? null,
    places: opts.places ?? null,
    directReader: opts.directReader ?? null,
    role: opts.role,
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

/**
 * An analysis answer as the model must give it. The analysis schema has no nulls (they made its grammar too
 * large for the API to compile): "not said" is "" or 0, with page 0. Fixtures written with nulls are turned
 * into that form here, so each test still says plainly what the pages did not say.
 */
export function asModelAnswer(answer) {
  const numeric = new Set(["highest_value_price", "staff_count", "locations"]);
  const out = {};
  for (const [key, field] of Object.entries(answer)) {
    if (field === null || typeof field !== "object" || Array.isArray(field)) { out[key] = field; continue; }
    const fixed = { ...field };
    if ("value" in fixed && fixed.value === null) fixed.value = key === "legal_form" ? "not_stated" : numeric.has(key) ? 0 : "";
    for (const k of ["page", "count", "rating"]) if (k in fixed && fixed[k] === null) fixed[k] = 0;
    for (const k of ["name", "role"]) if (k in fixed && fixed[k] === null) fixed[k] = "";
    out[key] = fixed;
  }
  // The target service, where a fixture does not say: the same as its highest value service.
  if (!("target_service" in out) && out.highest_value_service) out.target_service = { ...out.highest_value_service };
  return out;
}
