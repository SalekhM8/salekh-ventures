// Shared test harness. Everything here talks to a real Postgres.
// Every number below is a TEST FIXTURE, not a business figure.
import { randomUUID } from "node:crypto";
import pg from "pg";
import * as control from "../dist/control.js";

// WH_TEST_DB lets two checkouts test side by side on one Postgres without dropping each other's database.
export const TEST_DB = process.env.WH_TEST_DB ?? "wh_test";
export const TEST_ROLE_PASSWORD = "wh-test-only";
export const TEST_CAP_LIMIT_UNITS = 10; // fixture: dummy units allowed per day
export const TEST_DAILY_BUDGET_GBP = 1; // fixture: department budget per day
export const TEST_DEPARTMENT = "data";
export const HOUR = 60 * 60 * 1000;

export function serverUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Start the throwaway Postgres and export it: see runner/README.md.",
    );
  }
  return url;
}

function withParts(parts) {
  const url = new URL(serverUrl());
  if (parts.user) url.username = parts.user;
  if (parts.password) url.password = parts.password;
  url.pathname = `/${parts.database ?? TEST_DB}`;
  return url.toString();
}

export const adminUrl = (database = TEST_DB) => withParts({ database });
export const roleUrl = (role) => withParts({ user: `${TEST_DB}_${role}`, password: TEST_ROLE_PASSWORD });

/** One per test file: a superuser pool for seeding and inspection, and one Db per role. */
export function openHarness() {
  const admin = new pg.Pool({ connectionString: adminUrl(), max: 4 });
  const gatewayDb = control.createDb(roleUrl("gateway"));
  const uiDb = control.createDb(roleUrl("ui"));
  const agentDb = control.createDb(roleUrl("agent"));
  return {
    admin,
    gatewayDb,
    uiDb,
    agentDb,
    async close() {
      await Promise.all([admin.end(), gatewayDb.end(), uiDb.end(), agentDb.end()]);
    },
  };
}

/** A tenant with two floors and one member of each sort. Seeded as superuser. */
export async function seedTenant(h, label = "test tenant") {
  const tenantId = randomUUID();
  const ids = {
    tenantId,
    businessId: randomUUID(),
    otherBusinessId: randomUUID(),
    ownerId: randomUUID(),
    approverId: randomUUID(),
    viewerId: randomUUID(),
    disabledId: randomUUID(),
  };
  await h.admin.query("insert into tenants (tenant_id, name) values ($1, $2)", [tenantId, label]);
  await h.admin.query(
    `insert into businesses (business_id, tenant_id, slug, name, departments) values
       ($1, $3, 'fixture-floor-one', 'Fixture floor one', '{data,ads}'),
       ($2, $3, 'fixture-floor-two', 'Fixture floor two', '{data}')`,
    [ids.businessId, ids.otherBusinessId, tenantId],
  );
  await h.admin.query(
    `insert into members (member_id, tenant_id, display_name, role, may_approve, status) values
       ($1, $5, 'Fixture owner', 'owner', true, 'active'),
       ($2, $5, 'Fixture approver', 'approver', true, 'active'),
       ($3, $5, 'Fixture viewer', 'viewer', false, 'active'),
       ($4, $5, 'Fixture disabled owner', 'owner', true, 'disabled')`,
    [ids.ownerId, ids.approverId, ids.viewerId, ids.disabledId, tenantId],
  );
  return ids;
}

export function makeClock(start = new Date("2026-11-16T10:00:00Z")) {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance(ms) {
      current += ms;
    },
  };
}

/** The dummy action type again, with a lower ceiling, for the hard ceiling tests only. */
export function testActionTypes() {
  return control.createActionTypeRegistry([
    control.dummyAction,
    { ...control.dummyAction, name: "dummy.ceiling_two", maxRung: 2 },
  ]);
}

/**
 * A tenant, a dummy connector, a gateway, and the fixtures a submission needs:
 * a cap, a department budget, and the dummy action promoted to `rung`.
 */
export async function makeWorld(h, opts = {}) {
  const ids = await seedTenant(h, opts.label);
  const clock = opts.clock ?? makeClock();
  const connector = control.createDummyConnector();
  const actionTypes = testActionTypes();
  const gateway = control.createGateway({
    db: h.gatewayDb,
    actionTypes,
    connectors: { dummy: connector },
    now: clock.now,
  });
  const world = { ...ids, clock, connector, gateway, actionTypes, h };
  const capLimit = opts.capLimit === undefined ? TEST_CAP_LIMIT_UNITS : opts.capLimit;
  const budget = opts.budget === undefined ? TEST_DAILY_BUDGET_GBP : opts.budget;
  for (const businessId of [ids.businessId, ids.otherBusinessId]) {
    if (capLimit !== null) await setCap(world, capLimit, businessId);
    if (budget !== null) await setBudget(world, budget, TEST_DEPARTMENT, businessId);
    await promoteTo(world, opts.rung ?? 1, "dummy.action", businessId);
  }
  return world;
}

export function setCap(world, limit, businessId = world.businessId) {
  return control.setConfig(world.h.uiDb, {
    tenantId: world.tenantId,
    businessId,
    kind: "cap",
    key: control.dummyAction.cap.key,
    value: { limit },
    memberId: world.ownerId,
    reason: "test fixture",
  });
}

export function setBudget(world, dailyLimitGbp, department = TEST_DEPARTMENT, businessId = world.businessId) {
  return control.setConfig(world.h.uiDb, {
    tenantId: world.tenantId,
    businessId,
    kind: "budget",
    key: department,
    value: { daily_limit_gbp: dailyLimitGbp },
    memberId: world.ownerId,
    reason: "test fixture",
  });
}

/** Promotion is one rung at a time, so reaching rung n takes n - 1 promotions. */
export async function promoteTo(world, rung, actionType = "dummy.action", businessId = world.businessId) {
  for (let r = 2; r <= rung; r += 1) {
    await control.promoteRung(world.h.uiDb, world.actionTypes, {
      tenantId: world.tenantId,
      businessId,
      actionType,
      memberId: world.ownerId,
      reason: "test fixture",
    });
  }
}

let keyCounter = 0;
export function request(world, overrides = {}) {
  keyCounter += 1;
  return {
    tenantId: world.tenantId,
    businessId: world.businessId,
    department: TEST_DEPARTMENT,
    actionType: "dummy.action",
    payload: { target: "fixture-target", units: 1 },
    reason: "test fixture reason",
    actionKey: `test-key-${process.pid}-${keyCounter}-${randomUUID()}`,
    ...overrides,
  };
}

export function yes(world, waiting, overrides = {}) {
  return {
    tenantId: world.tenantId,
    approvalId: waiting.approvalId,
    memberId: world.ownerId,
    decision: "approve",
    payloadHash: waiting.payloadHash,
    channel: "app",
    ...overrides,
  };
}

export async function eventTypes(world, filter = () => true) {
  const events = await control.listEvents(world.h.gatewayDb, { tenantId: world.tenantId });
  return events.filter(filter).map((e) => e.type);
}

export async function rows(h, sql, params = []) {
  return (await h.admin.query(sql, params)).rows;
}

export async function count(h, table, tenantId) {
  const r = await h.admin.query(`select count(*)::int as n from ${table} where tenant_id = $1`, [tenantId]);
  return r.rows[0].n;
}

export { control };
