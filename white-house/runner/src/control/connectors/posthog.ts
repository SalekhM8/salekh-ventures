import { ControlError } from "../errors.js";

/**
 * A read only PostHog connector for traffic totals. It lives on the gateway
 * side: the key is read by the runner process and never reaches an agent.
 *
 * The request shape follows PostHog's query API documentation (checked
 * 12 Nov 2026): POST <host>/api/projects/:project_id/query/ with a personal
 * API key that has the Query Read permission, and a body of
 * {"query": {"kind": "HogQLQuery", "query": "..."}}.
 *
 * It asks one fixed question and accepts one fixed shape of answer: a day and
 * three counts. Anything else, such as a column naming a person, is refused
 * whole. No query text ever comes from a model.
 */

export interface TrafficQuery {
  /** Host names to count, for example ["example.com", "www.example.com"]. */
  hosts: string[];
  /** First day, inclusive, YYYY-MM-DD. */
  from: string;
  /** Last day, exclusive, YYYY-MM-DD. */
  to: string;
  /** The time zone a "day" is counted in. */
  timezone: string;
}

export interface TrafficDay {
  day: string;
  pageviews: number;
  visitors: number;
  sessions: number;
}

export interface TrafficConnector {
  dailyTraffic(query: TrafficQuery): Promise<TrafficDay[]>;
}

export interface PostHogOptions {
  /** For example https://eu.posthog.com */
  host: string;
  projectId: string;
  apiKey: string;
  fetch?: typeof fetch;
}

const COLUMNS = ["day", "pageviews", "visitors", "sessions"] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const TIMEZONE = /^[A-Za-z]+(\/[A-Za-z_+-]+){0,2}$/;

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

function buildQuery(q: TrafficQuery): string {
  const hosts = q.hosts.map((host) => `'${host}'`).join(", ");
  return (
    `select toString(toDate(toTimeZone(timestamp, '${q.timezone}'))) as day, count() as pageviews, ` +
    `uniq(distinct_id) as visitors, uniq(properties.$session_id) as sessions ` +
    `from events ` +
    `where event = '$pageview' and properties.$host in (${hosts}) ` +
    `and toDate(toTimeZone(timestamp, '${q.timezone}')) >= toDate('${q.from}') ` +
    `and toDate(toTimeZone(timestamp, '${q.timezone}')) < toDate('${q.to}') ` +
    `group by day order by day`
  );
}

function unexpected(what: string): never {
  throw new ControlError("unexpected_result", `PostHog returned something other than daily totals (${what}). Nothing was stored.`);
}

function readResult(body: unknown): TrafficDay[] {
  if (typeof body !== "object" || body === null) unexpected("not an object");
  const { columns, results } = body as { columns?: unknown; results?: unknown };
  if (columns !== undefined) {
    const same = Array.isArray(columns) && columns.length === COLUMNS.length && COLUMNS.every((name, i) => columns[i] === name);
    if (!same) unexpected("unexpected columns");
  }
  if (!Array.isArray(results)) unexpected("no results");
  return (results as unknown[]).map((row) => {
    if (!Array.isArray(row) || row.length !== COLUMNS.length) unexpected("a row of the wrong width");
    const [day, pageviews, visitors, sessions] = row as unknown[];
    if (typeof day !== "string" || !DAY.test(day)) unexpected("a row with no day");
    if (!isCount(pageviews) || !isCount(visitors) || !isCount(sessions)) unexpected("a value that is not a count");
    return { day: day as string, pageviews: pageviews as number, visitors: visitors as number, sessions: sessions as number };
  });
}

export function createPostHogConnector(options: PostHogOptions): TrafficConnector {
  if (!options.apiKey) throw new Error("PostHog connector: no API key");
  if (!/^[A-Za-z0-9_-]+$/.test(options.projectId ?? "")) throw new Error("PostHog connector: the project id is not valid");
  const base = options.host.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;

  return {
    async dailyTraffic(q: TrafficQuery): Promise<TrafficDay[]> {
      const valid =
        Array.isArray(q.hosts) && q.hosts.length > 0 && q.hosts.every((host) => typeof host === "string" && HOST.test(host)) &&
        DAY.test(q.from) && DAY.test(q.to) && TIMEZONE.test(q.timezone);
      if (!valid) throw new ControlError("invalid_request", "traffic query has a host, date or time zone that is not valid");
      const response = await doFetch(`${base}/api/projects/${options.projectId}/query/`, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query: buildQuery(q) }, name: "white-house daily traffic totals" }),
      });
      if (!response.ok) throw new ControlError(`posthog_http_${response.status}`, `PostHog answered ${response.status}`);
      return readResult(await response.json());
    },
  };
}
