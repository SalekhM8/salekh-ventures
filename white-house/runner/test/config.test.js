// Versioned config: one row per change, with who and when, and a "current" read.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { control, makeWorld, openHarness, rows } from "./helpers.js";

const h = openHarness();
after(() => h.close());

const set = (w, over = {}) =>
  control.setConfig(h.uiDb, {
    tenantId: w.tenantId, businessId: w.businessId, kind: "target", key: "fixture_metric",
    value: { value: 1 }, memberId: w.ownerId, reason: "test fixture", ...over,
  });
const scope = (w, over = {}) => ({ tenantId: w.tenantId, businessId: w.businessId, kind: "target", key: "fixture_metric", ...over });

test("each change is a new version with who and when, and current is the latest", async () => {
  const w = await makeWorld(h);
  assert.equal(await control.getCurrentConfig(h.uiDb, scope(w)), null);
  assert.equal((await set(w)).version, 1);
  assert.equal((await set(w, { value: { value: 2 }, reason: "second test fixture" })).version, 2);
  const current = await control.getCurrentConfig(h.gatewayDb, scope(w));
  assert.deepEqual(current.value, { value: 2 });
  assert.deepEqual(
    [current.version, current.changedByKind, current.changedByMember, current.reason],
    [2, "member", w.ownerId, "second test fixture"],
  );
  assert.ok(current.createdAt instanceof Date);
  const history = await control.getConfigHistory(h.uiDb, scope(w));
  assert.deepEqual(history.map((v) => [v.version, v.value.value]), [[1, 1], [2, 2]]);
});

test("config is scoped to its floor, with tenant wide rows kept apart", async () => {
  const w = await makeWorld(h);
  await set(w);
  await set(w, { businessId: w.otherBusinessId, value: { value: 7 } });
  await set(w, { businessId: null, value: { value: 9 } });
  assert.equal((await control.getCurrentConfig(h.uiDb, scope(w))).value.value, 1);
  assert.equal((await control.getCurrentConfig(h.uiDb, scope(w, { businessId: w.otherBusinessId }))).value.value, 7);
  assert.equal((await control.getCurrentConfig(h.uiDb, scope(w, { businessId: null }))).value.value, 9);
});

test("only an active owner of that tenant can change config", async () => {
  const w = await makeWorld(h);
  const other = await makeWorld(h);
  for (const memberId of [w.viewerId, w.approverId, w.disabledId, other.ownerId]) {
    await assert.rejects(set(w, { memberId }), (err) => err.code === "not_permitted");
  }
  assert.equal(await control.getCurrentConfig(h.uiDb, scope(w)), null);
});

test("a cap or budget of the wrong shape is refused", async () => {
  const w = await makeWorld(h);
  for (const [kind, value] of [["cap", { limit: -1 }], ["cap", { max: 5 }], ["budget", { daily_limit_gbp: "lots" }], ["budget", {}]]) {
    await assert.rejects(set(w, { kind, key: "fixture", value }), (err) => err.code === "invalid_config");
  }
  await assert.rejects(set(w, { reason: "" }), (err) => err.code === "invalid_config");
});

test("every change is on the event stream, and five changes at once get five versions", async () => {
  const w = await makeWorld(h);
  await Promise.all([1, 2, 3, 4, 5].map((n) => set(w, { value: { value: n } })));
  const history = await control.getConfigHistory(h.uiDb, scope(w));
  assert.deepEqual(history.map((v) => v.version), [1, 2, 3, 4, 5]);
  const events = (await control.listEvents(h.uiDb, { tenantId: w.tenantId })).filter(
    (e) => e.type === "config_changed" && e.reasonCode === "target",
  );
  assert.equal(events.length, 5);
});

test("a config row is never rewritten: no role can update or delete one", async () => {
  const w = await makeWorld(h);
  await set(w);
  for (const db of [h.uiDb, h.gatewayDb, h.agentDb]) {
    await assert.rejects(db.tx(w.tenantId, (tx) => tx.query("update config_versions set value = '{}'")), /permission denied/);
    await assert.rejects(db.tx(w.tenantId, (tx) => tx.query("delete from config_versions")), /permission denied/);
  }
  const [r] = await rows(h, "select count(*)::int as n from config_versions where tenant_id = $1 and kind = 'target'", [w.tenantId]);
  assert.equal(r.n, 1);
});
