// The PostHog connector with a stubbed HTTP layer, and the plain code pull into `metrics`.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openHarness, rows, seedTenant } from "./helpers.js";
import { createPostHogConnector } from "../dist/control/connectors/posthog.js";
import { pullTraffic } from "../dist/jobs/pull-traffic.js";

const h = openHarness();
after(() => h.close());

const FIXTURE_KEY = "phx_fixture_not_a_real_key";
function stub(response, status = 200) {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status, json: async () => response, text: async () => JSON.stringify(response) };
  };
  const connector = createPostHogConnector({ host: "https://eu.posthog.com", projectId: "12345", apiKey: FIXTURE_KEY, fetch: fetchStub });
  return { calls, connector };
}
const query = { hosts: ["fixture.example.test", "www.fixture.example.test"], from: "2026-11-01", to: "2026-11-16", timezone: "Europe/London" };
const good = {
  columns: ["day", "pageviews", "visitors", "sessions"],
  results: [["2026-11-14", 30, 12, 15], ["2026-11-15", 40, 20, 22]],
};

test("the request is the one PostHog documents: POST /api/projects/:id/query/ with a HogQLQuery", async () => {
  const { calls, connector } = stub(good);
  const out = await connector.dailyTraffic(query);
  assert.deepEqual(out, [
    { day: "2026-11-14", pageviews: 30, visitors: 12, sessions: 15 },
    { day: "2026-11-15", pageviews: 40, visitors: 20, sessions: 22 },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://eu.posthog.com/api/projects/12345/query/");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${FIXTURE_KEY}`);
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.query.kind, "HogQLQuery");
  const sql = body.query.query;
  assert.match(sql, /count\(\)/);
  assert.match(sql, /group by day/i);
  assert.ok(sql.includes("'fixture.example.test'") && sql.includes("'2026-11-01'") && sql.includes("'2026-11-16'"));
  // totals only: the query never selects a person, an id or a property value
  const selected = sql.slice(0, sql.toLowerCase().indexOf(" from "));
  assert.ok(!/\*|person|email|\$ip|properties\.\$current_url/.test(selected), selected);
  assert.match(selected, /uniq\(distinct_id\)/, "people are only ever counted");
});

test("a result with person level columns is rejected whole", async () => {
  const bad = [
    { columns: ["day", "pageviews", "visitors", "sessions", "distinct_id"], results: [["2026-11-14", 30, 12, 15, "fixture-person"]] },
    { columns: ["day", "pageviews", "visitors", "person_id"], results: [["2026-11-14", 30, 12, "fixture-person"]] },
    { columns: ["day", "pageviews", "visitors", "sessions"], results: [["2026-11-14", 30, 12, 15, "fixture-person@example.test"]] },
    { results: [["2026-11-14", 30, 12, 15, "extra"]] },
    // the right number of numbers under the wrong names: a person's id is still not a total
    { columns: ["day", "pageviews", "visitors", "person_id"], results: [["2026-11-14", 30, 12, 15]] },
    { columns: ["day", "pageviews", "distinct_id", "sessions"], results: [["2026-11-14", 30, 12, 15]] },
    { columns: ["day", "pageviews", "visitors", "sessions"], results: [["2026-11-14", "fixture-person", 12, 15]] },
    { columns: ["day", "pageviews", "visitors", "sessions"], results: [["not-a-day", 30, 12, 15]] },
    { columns: ["day", "pageviews", "visitors", "sessions"], results: [{ day: "2026-11-14", email: "fixture-person@example.test" }] },
    { columns: ["day", "pageviews", "visitors", "sessions"], results: [["2026-11-14", 30, 12, 15], ["2026-11-15", 30, 12, -1]] },
    { columns: ["day", "pageviews", "visitors", "sessions"] },
    "not an object",
  ];
  for (const response of bad) {
    const { connector } = stub(response);
    await assert.rejects(connector.dailyTraffic(query), (err) => err.code === "unexpected_result", JSON.stringify(response));
  }
  // with no column names at all, four values of the right kinds are accepted
  const { connector } = stub({ results: good.results });
  assert.equal((await connector.dailyTraffic(query)).length, 2);
});

test("an HTTP error is reported without the key, and bad input never reaches PostHog", async () => {
  const { connector, calls } = stub({ detail: "fixture: invalid key" }, 401);
  await assert.rejects(connector.dailyTraffic(query), (err) => err.code === "posthog_http_401" && !String(err.message).includes(FIXTURE_KEY));
  assert.equal(calls.length, 1);
  for (const over of [{ hosts: ["bad'host"] }, { hosts: [] }, { from: "2026-11-01; drop" }, { to: "yesterday" }, { timezone: "Europe/London'" }]) {
    await assert.rejects(connector.dailyTraffic({ ...query, ...over }), (err) => err.code === "invalid_request", JSON.stringify(over));
  }
  assert.equal(calls.length, 1);
  assert.throws(() => createPostHogConnector({ host: "https://eu.posthog.com", projectId: "12345", apiKey: "" }), /key/);
  assert.throws(() => createPostHogConnector({ host: "https://eu.posthog.com", projectId: "1/../2", apiKey: FIXTURE_KEY }), /project/);
});

test("the pull writes daily totals into metrics, and pulling again corrects them without duplicates", async () => {
  const ids = await seedTenant(h);
  const first = stub(good);
  const now = new Date("2026-11-16T10:00:00Z");
  const input = { tenantId: ids.tenantId, businessId: ids.businessId, connector: first.connector, hosts: query.hosts, now, days: 28 };
  assert.equal(await pullTraffic(h.gatewayDb, input), 6);
  const sent = JSON.parse(first.calls[0].init.body).query.query;
  assert.ok(sent.includes("'2026-10-19'") && sent.includes("'2026-11-16'"), "28 whole days, ending before today");
  const second = stub({ ...good, results: [["2026-11-14", 31, 12, 15], ["2026-11-15", 40, 20, 22]] });
  assert.equal(await pullTraffic(h.gatewayDb, { ...input, connector: second.connector }), 6);
  const stored = await rows(h, "select metric, value::int as value, metric_date::text as day from metrics where tenant_id = $1 order by metric_date, metric", [ids.tenantId]);
  assert.equal(stored.length, 6);
  assert.deepEqual(stored[0], { metric: "pageviews", value: 31, day: "2026-11-14" });
  assert.deepEqual(stored.map((r) => r.metric), ["pageviews", "sessions", "visitors", "pageviews", "sessions", "visitors"]);
});
