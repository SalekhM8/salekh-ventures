import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isBlockedAddress } from "../../outreach/normalise.js";
import { ControlError } from "../errors.js";

/**
 * Web search and page reading by plain code, through the Agent Reach command
 * line tool installed on the host (binary path from AGENT_REACH_BIN). It
 * lives on the gateway side: no agent is given it, and no agent has open web
 * access through it.
 *
 * Only four of its actions are ever run:
 *   web search <query> --limit N
 *   web read <url>
 *   linkedin jobs <query> --limit N                        public job adverts only. No --location: the source
 *                                                          answers that with an error and then pauses the channel.
 *                                                          The search is national and the place is matched in code.
 *   linkedin read <job url>                                public job adverts only
 * Its instagram, facebook, twitter, reddit and other channels are not
 * reachable from this code at all. A LinkedIn profile address is refused
 * before the tool is run.
 *
 * Every call has a timeout and returns text cut to a cap. Everything
 * returned is untrusted data.
 */

export interface ReachItem {
  title: string | null;
  url: string;
  text: string;
  /** Job adverts only: where the job is, as the advert gives it. */
  location?: string;
}

/** What a job advert's own record says, as one plain line: the employer, the place, the date listed. Nothing is added. */
function advertText(raw: any): string {
  const said = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
  const [company, location, listed] = [said(raw?.company), said(raw?.location), said(raw?.listed)];
  return [company ? `Employer: ${company}.` : null, location ? `Location: ${location}.` : null, listed ? `Listed: ${listed}.` : null].filter(Boolean).join(" ");
}

export interface ReachConnector {
  webSearch(query: string, limit: number): Promise<ReachItem[]>;
  webRead(url: string): Promise<ReachItem | null>;
  jobs(query: string, location: string, limit: number): Promise<ReachItem[]>;
  jobRead(url: string): Promise<ReachItem | null>;
}

export type Exec = (bin: string, args: string[], timeoutMs: number) => Promise<string>;

/**
 * Why a call to the search tool did not give results, read from the tool's own answer:
 *   reach_rate_limited  it reported a rate limit. `retryAfterSeconds` is the wait it gave, when it gave one.
 *   reach_need_login    the source wants a signed in session. Nobody's account is used for this, so the
 *                       source is simply unavailable. It is not an error to fix.
 *   reach_paused        the source broke upstream and the tool has paused the channel for a stated time.
 *                       The channel is left alone for the rest of the run. Nothing retries it.
 *   reach_failed        anything else: a crash, a timeout, an answer that is not JSON, another error code.
 */
export class ReachError extends ControlError {
  readonly retryAfterSeconds: number | null;

  constructor(code: "reach_rate_limited" | "reach_need_login" | "reach_paused" | "reach_not_configured" | "reach_failed", message: string, retryAfterSeconds: number | null = null) {
    super(code, message);
    this.name = "ReachError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const defaultExec: Exec = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    // An argument list, never a shell string: nothing in a query can become a command.
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } }, (err, stdout) => {
      // The tool says what went wrong in its JSON, so whatever it printed is read even when it exits with an error.
      if (err && !String(stdout ?? "").trim()) reject(new ReachError("reach_failed", err.killed ? "the search tool timed out" : "the search tool failed"));
      else resolve(String(stdout));
    });
  });

export interface AgentReachOptions {
  bin: string;
  timeoutMs?: number;
  /** Characters kept per page read. */
  pageChars?: number;
  /** Characters kept per search result. */
  resultChars?: number;
  exec?: Exec;
}

const JOB_ADVERT = /^https?:\/\/([a-z0-9-]+\.)*linkedin\.com\/jobs\/view\//i;
const LINKEDIN = /^https?:\/\/([a-z0-9-]+\.)*linkedin\.com(\/|$)/i;
const isWebAddress = (value: unknown): value is string => typeof value === "string" && /^https?:\/\/[^\s]+$/i.test(value);

/** A query is words. It never starts with a dash (which the tool would read as an option) and has no control characters. */
function cleanQuery(query: string): string {
  const text = String(query).replace(/[\u0000-\u001f]+/g, " ").replace(/^[\s-]+/, "").trim().slice(0, 300);
  if (!text) throw new ControlError("invalid_request", "an empty search");
  return text;
}

export function createAgentReachConnector(options: AgentReachOptions): ReachConnector {
  if (!options.bin) throw new Error("Agent Reach connector: no binary path");
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pageChars = options.pageChars ?? 6000;
  const resultChars = options.resultChars ?? 1500;
  const seconds = String(Math.max(5, Math.round(timeoutMs / 1000) - 2));

  async function run(args: string[], cap: number): Promise<ReachItem[]> {
    let parsed: any;
    try {
      // The process timeout is the hard stop. The tool's own --timeout lets it give up a little sooner and say why.
      parsed = JSON.parse(await exec(options.bin, [...args, "--timeout", seconds], timeoutMs));
    } catch (err) {
      if (err instanceof ControlError) throw err;
      throw new ReachError("reach_failed", "the search tool did not return JSON");
    }
    if (parsed?.ok !== true) {
      const code = typeof parsed?.error?.code === "string" ? parsed.error.code : "";
      if (code === "RATE_LIMITED") {
        // The wait is in the hint: "Wait 2501 seconds before retrying this channel."
        const wait = /(\d{1,6})\s*seconds?/i.exec(String(parsed.error.hint ?? "")) ?? /(\d{1,6})\s*seconds?/i.exec(String(parsed.error.message ?? ""));
        throw new ReachError("reach_rate_limited", "the search tool reported a rate limit", wait ? Number(wait[1]) : null);
      }
      if (code === "NEED_LOGIN") throw new ReachError("reach_need_login", "the source needs a signed in session");
      if (code === "UPSTREAM_BROKEN") {
        // The tool says how long it has paused the channel for, in its record of the attempts it made.
        const waits = (Array.isArray(parsed?.meta?.attempts) ? parsed.meta.attempts : []).map((a: any) => Number(a?.retry_after_seconds)).filter((n: number) => Number.isFinite(n) && n > 0);
        if (waits.length > 0) throw new ReachError("reach_paused", "the source is broken upstream and the channel is paused", Math.ceil(Math.max(...waits)));
      }
      throw new ReachError("reach_failed", "the search tool reported a failure");
    }
    if (!Array.isArray(parsed.items)) throw new ReachError("reach_failed", "the search tool reported a failure");
    return (parsed.items as any[])
      .filter((item) => isWebAddress(item?.url) && !isBlockedAddress(item.url))
      .map((item) => ({
        title: typeof item.title === "string" ? item.title.slice(0, 200) : null,
        url: item.url as string,
        // A job advert comes with no text of its own: who is hiring, where and when are in its `raw` record.
        text: typeof item.text === "string" && item.text ? item.text.slice(0, cap) : advertText(item.raw).slice(0, cap),
        ...(typeof item.raw?.location === "string" ? { location: item.raw.location.slice(0, 200) } : {}),
      }));
  }
  const count = (n: number) => String(Math.max(1, Math.min(25, Math.round(n))));
  const national = new Map<string, { at: number; items: ReachItem[] }>();

  return {
    webSearch: async (query, limit) => run(["web", "search", cleanQuery(query), "--limit", count(limit)], resultChars),
    async webRead(url) {
      if (!isWebAddress(url)) throw new ControlError("invalid_request", "not a web address");
      // Hard rule: no LinkedIn profile is ever read. Nothing on LinkedIn is read through the plain web channel.
      if (isBlockedAddress(url) || LINKEDIN.test(url)) throw new ControlError("url_blocked", "that address is off limits");
      return (await run(["web", "read", url], pageChars))[0] ?? null;
    },
    // Job adverts only: anything that comes back and is not an advert's own page (a profile, a company's people page) is dropped.
    // The search is national (see the top of this file). One answer per query is kept for ten minutes, so asking about several
    // places costs one call. Only adverts whose own location names the place are returned for it.
    async jobs(query, location, limit) {
      const key = `${cleanQuery(query)}|${count(limit)}`;
      let held = national.get(key);
      if (!held || held.at < Date.now() - 10 * 60_000) {
        held = { at: Date.now(), items: (await run(["linkedin", "jobs", cleanQuery(query), "--limit", count(limit)], resultChars)).filter((item) => JOB_ADVERT.test(item.url)) };
        national.set(key, held);
      }
      const place = String(location ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
      return place ? held.items.filter((item) => (item.location ?? "").toLowerCase().includes(place)) : held.items;
    },
    async jobRead(url) {
      if (!isWebAddress(url) || !JOB_ADVERT.test(url) || isBlockedAddress(url)) throw new ControlError("url_blocked", "only a public job advert can be read from LinkedIn");
      return (await run(["linkedin", "read", url], pageChars))[0] ?? null;
    },
  };
}

/** No binary path, or a path with nothing there: no connector. A server without the tool installed is the ordinary case. */
export function agentReachFromEnv(bin: string | undefined): ReachConnector | null {
  return bin && existsSync(bin) ? createAgentReachConnector({ bin }) : null;
}

/** Stands in where the tool is not installed: every action answers "not configured", and nothing is run. */
export function notConfiguredReach(): ReachConnector {
  const no = async (): Promise<never> => { throw new ReachError("reach_not_configured", "the search tool is not installed here"); };
  return { webSearch: no, webRead: no, jobs: no, jobRead: no };
}
