// The Engineering watcher: a plain line on whether Outreach is all right. Every figure and name is a TEST FIXTURE.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { control, makeClock, openHarness, rows } from "./helpers.js";
import { makeHouse } from "./house-helpers.js";
import { changeOutreachSettings } from "../dist/outreach/admin.js";
import { createWatcher } from "../dist/watcher.js";

const h = openHarness();
const open = [];
after(async () => {
  await Promise.all(open.filter((x) => x.close).map((x) => x.close()));
  await h.close();
});
const ROOM = "fixture-floor-one:outreach";

async function watched(start, opts = {}) {
  const clock = makeClock(new Date(start));
  const x = await makeHouse(h, { clock, outreach: { budget: 5 }, server: false });
  open.push(x);
  await changeOutreachSettings(h.uiDb, x.w.tenantId, ROOM, { dailyAt: "08:00" });
  let stop = opts.stop ?? null;
  const watcher = (over = {}) => createWatcher({
    db: h.gatewayDb, tenantId: x.w.tenantId, now: clock.now,
    mailboxes: { test: true, owner: true, ...over }, stopToday: async () => stop,
  });
  const healthEvents = async () => (await rows(h, "select summary, reason_code, department from events where tenant_id = $1 and type = 'health' order by seq", [x.w.tenantId]));
  const addRun = (status, startedAt, endedAt) => h.admin.query(
    "insert into runs (tenant_id, business_id, department, trigger, status, started_at, ended_at) values ($1, $2, 'outreach', 'outreach:find', $3, $4, $5)",
    [x.w.tenantId, x.w.businessId, status, startedAt, endedAt]);
  const addShortlist = (cards, at) => h.admin.query(
    "insert into outputs (output_id, tenant_id, business_id, department, run_id, title, body, data, created_at) values ($1, $2, $3, 'outreach', null, 'Shortlist, fixture day', 'Fixture body', $4::jsonb, $5)",
    [randomUUID(), x.w.tenantId, x.w.businessId, JSON.stringify({ cards: Array.from({ length: cards }, () => ({ score: 40 })) }), at]);
  const schedule = (code) => h.admin.query(
    "insert into events (tenant_id, business_id, department, type, summary, reason_code, created_at) values ($1, $2, 'outreach', 'scheduled', 'Fixture', $3, $4)",
    [x.w.tenantId, x.w.businessId, code, clock.now()]);
  return { x, clock, watcher, healthEvents, addRun, addShortlist, schedule, setStop: (s) => void (stop = s) };
}

test("before the daily time the watcher says when Outreach is due, and writes the line once, not every hour", async () => {
  const s = await watched("2026-11-19T07:00:00Z");
  const [first] = await s.watcher().check();
  assert.equal(first.ok, true);
  assert.equal(first.line, "All fine. Outreach is due at 08:00.");
  s.clock.advance(20 * 60 * 1000);
  await s.watcher().check();
  assert.deepEqual(await s.healthEvents(), [{ summary: "All fine. Outreach is due at 08:00.", reason_code: "outreach_fine", department: "engineering" }]);
});

test("a run that never started is reported plainly, once", async () => {
  const s = await watched("2026-11-19T09:00:00Z");
  const [found] = await s.watcher().check();
  assert.equal(found.ok, false);
  assert.deepEqual(found.problems, ["not_started"]);
  assert.equal(found.line, "Outreach needs a look. Outreach didn't start this morning (it was due at 08:00).");
  s.clock.advance(60 * 60 * 1000);
  await s.watcher().check();
  assert.equal((await s.healthEvents()).length, 1, "the same answer is not written again");
});

test("a skipped run says why, in plain words", async () => {
  const s = await watched("2026-11-19T09:00:00Z");
  await s.schedule("due");
  await s.schedule("skipped_over_budget");
  const [found] = await s.watcher().check();
  assert.deepEqual(found.problems, ["not_started_over_budget"]);
  assert.match(found.line, /didn't run today because today's budget is spent/);
});

test("a finished run with profiles and nothing wrong is all fine, with the count", async () => {
  const s = await watched("2026-11-19T12:00:00Z");
  await s.schedule("started");
  await s.addRun("done", new Date("2026-11-19T08:00:00Z"), new Date("2026-11-19T08:40:00Z"));
  await s.addShortlist(16, new Date("2026-11-19T08:40:00Z"));
  const [found] = await s.watcher().check();
  assert.equal(found.ok, true, found.line);
  assert.equal(found.line, "All fine. 16 profiles ready since 08:40.");
  assert.equal(found.counts.profiles, 16);
  // the house hands the line to the Chief of Staff
  const house = await s.x.runtime.house();
  assert.deepEqual(house.health.map((e) => [e.business, e.ok, e.line]), [["fixture-floor-one", true, "All fine. 16 profiles ready since 08:40."]]);
});

test("a failed run with no profiles, a stuck run, a stop and a missing mailbox are each a problem", async () => {
  const s = await watched("2026-11-19T12:00:00Z");
  await s.schedule("started");
  await s.addRun("failed", new Date("2026-11-19T08:00:00Z"), new Date("2026-11-19T08:10:00Z"));
  let [found] = await s.watcher().check();
  assert.deepEqual(found.problems, ["run_failed"]);
  assert.match(found.line, /stopped with an error at 08:10 and no profiles came out/);

  await s.addRun("running", new Date("2026-11-19T08:15:00Z"), null);
  [found] = await s.watcher().check();
  assert.deepEqual(found.problems, ["run_stuck"]);

  s.setStop("a complaint came in.");
  [found] = await s.watcher({ owner: false }).check();
  assert.deepEqual(found.problems, ["run_stuck", "sending_stopped", "owner_mailbox_missing"]);
  assert.match(found.line, /sending is stopped today \(a complaint came in\)/);
  assert.match(found.line, /your mailbox isn't connected/);
  assert.ok(found.line.length <= 280);
  assert.equal((await s.healthEvents()).length, 3, "a new line each time the answer changed");
});

test("the watcher only reports: it starts no run and sends nothing", async () => {
  const s = await watched("2026-11-19T09:00:00Z");
  await s.watcher().check();
  assert.equal((await rows(h, "select 1 from runs where tenant_id = $1", [s.x.w.tenantId])).length, 0);
  assert.equal((await rows(h, "select 1 from enquiries where tenant_id = $1 and status in ('sending', 'sent')", [s.x.w.tenantId])).length, 0);
  void control;
});
