// The things most likely to be silently wrong: database roles and row level security.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { adminUrl, control, makeWorld, openHarness, request, rows, yes } from "./helpers.js";

const h = openHarness();
after(() => h.close());

const ALL_TABLES = [
  "tenants", "businesses", "members", "config_versions", "runs", "events", "proposals", "approvals",
  "actions", "budget_ledger", "metrics", "memory_notes", "scores", "eval_cases", "eval_runs",
  "queue_items", "notifications", "devices", "public_feed", "outputs",
];

/** Two tenants, each with rows in every table. */
let a;
let b;
async function fill(w) {
  const waiting = await w.gateway.submit(request(w, { businessId: w.otherBusinessId }));
  // floor two is at rung 2 here, floor one at rung 4
  await w.gateway.answerApproval(yes(w, waiting));
  const done = await w.gateway.submit(request(w));
  const run = await control.startRun(
    h.gatewayDb,
    { tenantId: w.tenantId, businessId: w.businessId, department: "data", trigger: "test fixture", model: null },
    { now: w.clock.now() },
  );
  await control.finishRun(
    h.gatewayDb,
    { tenantId: w.tenantId, runId: run.runId, status: "done", tokensIn: 1, tokensOut: 1, tokensCached: 0, costGbp: 0.01 },
    { now: w.clock.now() },
  );
  const t = [w.tenantId, w.businessId];
  await h.admin.query(
    `insert into metrics (tenant_id, business_id, metric, value, metric_date, source, metric_window)
     values ($1, $2, 'fixture_metric', 1, '2026-11-16', 'test fixture', '7d')`, t);
  await h.admin.query(
    `insert into memory_notes (tenant_id, business_id, department, note, status, approved_by) values
       ($1, $2, 'data', 'fixture approved note', 'approved', $3),
       ($1, $2, 'data', 'fixture proposed note', 'proposed', null)`, [...t, w.ownerId]);
  await h.admin.query(
    `insert into scores (tenant_id, business_id, action_id, member_id, score) values ($1, $2, $3, $4, 9)`,
    [...t, done.actionId, w.ownerId]);
  await h.admin.query(
    `insert into eval_cases (tenant_id, business_id, department, title, situation, expected)
     values ($1, $2, 'data', 'fixture case', '{}', '{}')`, t);
  await h.admin.query(
    `insert into eval_runs (tenant_id, business_id, department, trigger) values ($1, $2, 'data', 'test fixture')`, t);
  await h.admin.query(
    `insert into queue_items (tenant_id, business_id, kind, from_department, title)
     values ($1, $2, 'handoff', 'data', 'fixture handoff')`, t);
  await h.admin.query(
    `insert into devices (tenant_id, member_id, platform, subscription) values ($1, $2, 'web', '{}')`,
    [w.tenantId, w.ownerId]);
  await h.admin.query(
    `insert into public_feed (tenant_id, business_id, department, state, line, visible_after)
     values ($1, $2, 'data', 'working', 'fixture line', now())`, t);
  await h.admin.query(
    `insert into outputs (tenant_id, business_id, department, title, body) values ($1, $2, 'data', 'fixture output', 'fixture body')`, t);
}

before(async () => {
  a = await makeWorld(h, { rung: 4 });
  b = await makeWorld(h, { rung: 4 });
  for (const w of [a, b]) {
    // Floor two is put at rung 2 directly (test fixture), so the fixture has an approval as well.
    await h.admin.query(
      `insert into config_versions (tenant_id, business_id, kind, key, value, version, changed_by_kind, reason)
       values ($1, $2, 'rung', 'dummy.action', '{"rung": 2}', 99, 'system', 'test fixture')`,
      [w.tenantId, w.otherBusinessId]);
    await fill(w);
  }
});

const denied = (db, tenantId, sql, params = []) =>
  assert.rejects(db.tx(tenantId, (tx) => tx.query(sql, params)), /permission denied/, sql);

test("every table carries tenant_id and business_id, and has row level security forced on", async () => {
  const tables = await rows(
    h,
    `select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
            exists (select from pg_attribute where attrelid = c.oid and attname = 'tenant_id' and not attisdropped) as has_tenant,
            exists (select from pg_attribute where attrelid = c.oid and attname = 'business_id' and not attisdropped) as has_business
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'schema_migrations'
      order by 1`,
  );
  assert.deepEqual(tables.map((t) => t.name), [...ALL_TABLES].sort());
  for (const t of tables) {
    assert.deepEqual([t.name, t.rls, t.forced, t.has_tenant, t.has_business], [t.name, true, true, true, true]);
  }
});

test("the fixture really did put rows for both tenants in every table", async () => {
  for (const table of ALL_TABLES) {
    for (const w of [a, b]) {
      const [r] = await rows(h, `select count(*)::int as n from ${table} where tenant_id = $1`, [w.tenantId]);
      assert.ok(r.n > 0, `${table} has no fixture rows`);
    }
  }
});

// ---- the agent tools role ----

test("the agent role cannot write config_versions, actions or approvals", async () => {
  const t = a.tenantId;
  await denied(h.agentDb, t,
    `insert into config_versions (tenant_id, business_id, kind, key, value, version, changed_by_kind, reason)
     values ($1, $2, 'rung', 'dummy.action', '{"rung": 4}', 1000, 'system', 'agent tries')`, [t, a.businessId]);
  await denied(h.agentDb, t, "update config_versions set value = '{\"rung\": 4}'");
  await denied(h.agentDb, t, "delete from config_versions");
  await denied(h.agentDb, t,
    `insert into actions (tenant_id, business_id, proposal_id, department, action_type, action_key, rung, input, input_hash, cap_key, cap_units, undoable)
     values ($1, $2, $3, 'data', 'dummy.action', 'agent-key', 4, '{}', 'x', 'c', 0, false)`, [t, a.businessId, randomUUID()]);
  await denied(h.agentDb, t, "update actions set verified = true");
  await denied(h.agentDb, t, "delete from actions");
  await denied(h.agentDb, t,
    `insert into approvals (tenant_id, business_id, proposal_id, department, action_type, action_key, reasoning, payload, payload_hash, expires_at)
     values ($1, $2, $3, 'data', 'dummy.action', 'agent-key', 'r', '{}', repeat('0', 64), now())`, [t, a.businessId, randomUUID()]);
  await denied(h.agentDb, t, "update approvals set status = 'approved'");
  await denied(h.agentDb, t, "delete from approvals");
});

test("the agent role cannot read or write anything else it has no business with", async () => {
  const t = a.tenantId;
  for (const table of ALL_TABLES.filter((name) => !["metrics", "memory_notes"].includes(name))) {
    await denied(h.agentDb, t, `select * from ${table}`);
  }
  for (const table of ALL_TABLES) {
    await denied(h.agentDb, t, `delete from ${table}`);
    await denied(h.agentDb, t, `update ${table} set tenant_id = tenant_id`);
  }
  await denied(h.agentDb, t, "insert into events (tenant_id, type, summary) values ($1, 'done', 'agent tries')", [t]);
  await denied(h.agentDb, t, "insert into metrics (tenant_id, business_id, metric, value, metric_date, source, metric_window) values ($1, $2, 'm', 1, now(), 's', 'w')", [t, a.businessId]);
  await denied(h.agentDb, t, "insert into memory_notes (tenant_id, department, note) values ($1, 'data', 'agent writes its own memory')", [t]);
});

test("the agent role can read metrics and approved knowledge, and insert a proposal", async () => {
  const t = a.tenantId;
  const got = await h.agentDb.tx(t, async (tx) => ({
    metrics: (await tx.query("select metric from metrics")).rows,
    notes: (await tx.query("select note, status from memory_notes")).rows,
  }));
  assert.deepEqual(got.metrics, [{ metric: "fixture_metric" }]);
  assert.deepEqual(got.notes, [{ note: "fixture approved note", status: "approved" }]);

  const proposalId = randomUUID();
  await h.agentDb.tx(t, (tx) =>
    tx.query(
      `insert into proposals (proposal_id, tenant_id, business_id, department, action_type, action_key, payload, reason)
       values ($1, $2, $3, 'data', 'dummy.action', $4, '{"target":"fixture-target","units":1}', 'test fixture')`,
      [proposalId, t, a.businessId, `agent-${proposalId}`],
    ),
  );
  const [row] = await rows(h, "select decision, key_claimed from proposals where proposal_id = $1", [proposalId]);
  assert.deepEqual(row, { decision: null, key_claimed: false }, "stored, undecided, nothing executed");
  // but it cannot write the gateway's decision into its own proposal
  await denied(h.agentDb, t,
    `insert into proposals (tenant_id, business_id, department, action_type, action_key, payload, reason, decision, effective_rung)
     values ($1, $2, 'data', 'dummy.action', 'agent-decides', '{}', 'r', 'execute', 4)`, [t, a.businessId]);
});

// ---- row level security ----

test("row level security hides another tenant's rows in every table, for every role", async () => {
  for (const [role, db] of [["gateway", h.gatewayDb], ["ui", h.uiDb]]) {
    for (const table of ALL_TABLES) {
      const seen = await db.tx(a.tenantId, async (tx) => ({
        theirs: (await tx.query(`select count(*)::int as n from ${table} where tenant_id = $1`, [b.tenantId])).rows[0].n,
        notOurs: (await tx.query(`select count(*)::int as n from ${table} where tenant_id <> $1`, [a.tenantId])).rows[0].n,
        ours: (await tx.query(`select count(*)::int as n from ${table}`)).rows[0].n,
      }));
      assert.equal(seen.theirs, 0, `${role} saw tenant B rows in ${table}`);
      assert.equal(seen.notOurs, 0, `${role} saw foreign rows in ${table}`);
      assert.ok(seen.ours > 0, `${role} should see its own rows in ${table}`);
    }
  }
  for (const table of ["metrics", "memory_notes"]) {
    const n = await h.agentDb.tx(a.tenantId, async (tx) =>
      (await tx.query(`select count(*)::int as n from ${table} where tenant_id <> $1`, [a.tenantId])).rows[0].n);
    assert.equal(n, 0);
  }
});

test("with no tenant set, a role sees nothing at all", async () => {
  for (const pool of [h.gatewayDb.pool, h.uiDb.pool]) {
    for (const table of ALL_TABLES) {
      const r = await pool.query(`select count(*)::int as n from ${table}`);
      assert.equal(r.rows[0].n, 0, table);
    }
  }
  const r = await h.agentDb.pool.query("select count(*)::int as n from metrics");
  assert.equal(r.rows[0].n, 0);
});

test("a role cannot write a row for another tenant, or change one", async () => {
  const insert = h.gatewayDb.tx(a.tenantId, (tx) =>
    tx.query("insert into events (tenant_id, type, summary) values ($1, 'done', 'cross tenant write')", [b.tenantId]));
  await assert.rejects(insert, /row-level security/);
  const agentInsert = h.agentDb.tx(a.tenantId, (tx) =>
    tx.query(
      `insert into proposals (tenant_id, business_id, department, action_type, action_key, payload, reason)
       values ($1, $2, 'data', 'dummy.action', 'cross-tenant', '{}', 'r')`, [b.tenantId, b.businessId]));
  await assert.rejects(agentInsert, /row-level security/);
  const updated = await h.gatewayDb.tx(a.tenantId, (tx) =>
    tx.query("update runs set error = 'touched by tenant A' where tenant_id = $1", [b.tenantId]));
  assert.equal(updated.rowCount, 0);
  const [r] = await rows(h, "select count(*)::int as n from runs where error = 'touched by tenant A'");
  assert.equal(r.n, 0);
});

test("no White House role is a superuser or can bypass row level security", async () => {
  const [{ is_super: isSuper }] = await rows(h, "select rolsuper as is_super from pg_roles where rolname = current_user");
  assert.equal(isSuper, true, "the test admin is a superuser, which is the only reason it can seed across tenants");
  const [{ n }] = (await h.gatewayDb.tx(a.tenantId, (tx) =>
    tx.query("select count(*)::int as n from pg_roles where rolname like 'wh_%' and (rolsuper or rolbypassrls)"))).rows;
  assert.equal(n, 0, "no White House role may bypass row level security");
});

// ---- the gateway role is limited too ----

test("the gateway role can only tighten config: no cap, budget or target, no raising a rung, no resume", async () => {
  const t = a.tenantId;
  const insert = (kind, key, value, businessId = a.businessId) =>
    h.gatewayDb.tx(t, (tx) =>
      tx.query(
        `insert into config_versions (tenant_id, business_id, kind, key, value, version, changed_by_kind, reason)
         values ($1, $2, $3, $4, $5, 5000, 'system', 'gateway tries')`,
        [t, businessId, kind, key, JSON.stringify(value)],
      ));
  await assert.rejects(insert("cap", "dummy_units_per_day", { limit: 1000000 }), /row-level security/);
  await assert.rejects(insert("budget", "data", { daily_limit_gbp: 1000000 }), /row-level security/);
  await assert.rejects(insert("target", "fixture_metric", { value: 1 }), /row-level security/);
  await assert.rejects(insert("schedule", "data", { every: "hour" }), /row-level security/);
  await assert.rejects(insert("kill_switch", "state", { engaged: false }, null), /row-level security/);
  // floor two is at rung 2: the gateway cannot put it to 3 or keep it at 2, only lower it
  await assert.rejects(insert("rung", "dummy.action", { rung: 3 }, a.otherBusinessId), /row-level security/);
  await assert.rejects(insert("rung", "dummy.action", { rung: 2 }, a.otherBusinessId), /row-level security/);
  // an action type with no rung row is at rung 1, and there is nothing below that
  await assert.rejects(insert("rung", "dummy.ceiling_two", { rung: 2 }), /row-level security/);
  await denied(h.gatewayDb, t, "update config_versions set value = '{\"rung\": 4}'");
  await denied(h.gatewayDb, t, "delete from config_versions");
});

test("nobody can delete from the log, and the UI role cannot write actions or mark an approval used", async () => {
  const t = a.tenantId;
  for (const db of [h.gatewayDb, h.uiDb]) {
    for (const table of ["events", "actions", "approvals", "proposals", "config_versions", "runs"]) {
      await denied(db, t, `delete from ${table}`);
    }
    await denied(db, t, "update events set summary = 'rewritten'");
    await denied(db, t, "update actions set input = '{}'");
    await denied(db, t, "update proposals set payload = '{}'");
  }
  await denied(h.uiDb, t, "update approvals set consumed_at = now()");
  await denied(h.uiDb, t, "update actions set verified = true");
  await denied(h.uiDb, t,
    `insert into actions (tenant_id, business_id, proposal_id, department, action_type, action_key, rung, input, input_hash, cap_key, cap_units, undoable)
     values ($1, $2, $3, 'data', 'dummy.action', 'ui-key', 4, '{}', 'x', 'c', 0, false)`, [t, a.businessId, randomUUID()]);
});

test("a tenant id that is not a uuid is refused before any query runs", async () => {
  await assert.rejects(h.gatewayDb.tx("not-a-uuid", (tx) => tx.query("select 1")), /tenant/);
});

test("the migration runner applies each file once and notices an edited file", async () => {
  const { migrate } = await import("../dist/migrate.js");
  assert.deepEqual(await migrate({ connectionString: adminUrl() }), []);
  const applied = await rows(h, "select name from schema_migrations order by name");
  assert.equal(applied.length, 6);
  assert.match(applied[0].name, /^0001_/);
  await h.admin.query("update schema_migrations set checksum = 'edited' where name = $1", [applied[5].name]);
  try {
    await assert.rejects(migrate({ connectionString: adminUrl() }), /changed since it was applied/);
  } finally {
    const { checksumOf } = await import("../dist/migrate.js");
    await h.admin.query("update schema_migrations set checksum = $2 where name = $1", [
      applied[5].name, await checksumOf(applied[5].name),
    ]);
  }
});
