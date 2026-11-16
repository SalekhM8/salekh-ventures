import { createHash } from "node:crypto";
import { ReachError, type ReachConnector, type ReachItem } from "../control/connectors/agent-reach.js";
import { DirectReadError, type DirectReader } from "../control/connectors/direct-read.js";
import type { Db } from "../control/db.js";
import { ControlError } from "../control/errors.js";
import { tenantDay } from "../control/runs.js";

/**
 * A one day cache in front of the search tool, kept in the database so it
 * survives a restart: the same search or page is fetched at most once a day
 * per floor. Rows older than yesterday are deleted by `purgeFetchedPages`.
 */

export interface FetchCounts {
  fetched: number;
  fromCache: number;
  /** Calls not made because the run had reached its limit. */
  refusedAtLimit?: number;
  /** Pages the direct reader could not give (a failure, or almost no text) that were then asked of the outside reader. */
  fallbackReads?: number;
}

export interface ReachLimits {
  /** The most outside calls this run may make. */
  maxFetches?: number;
  /** The least time between two outside calls, in milliseconds. */
  minGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** false: the search tool is not installed where this runs. Every one of its actions is then "not configured". */
  reachConfigured?: boolean;
  /** Reads a business's own pages directly. When given, it is the first choice and the outside reader is only the fallback. */
  direct?: DirectReader | null;
  /** A direct read with fewer characters of text than this is taken to be a page that needs JavaScript. Default 200. */
  thinBelow?: number;
  /** A rate limit with a stated wait this short is waited out and the call tried once more, before the action is given up on. Default 30. */
  retryWaitUpToSeconds?: number;
  /** Called once when an action stops being usable for the rest of the run. */
  onUnavailable?: (channel: Channel, why: "rate_limited" | "need_login" | "paused" | "not_configured", retryAfterSeconds: number | null) => Promise<void> | void;
}

/**
 * Each action of the tool is limited, or not, by itself: a limit on searching says nothing about reading pages.
 * So what is unavailable is tracked per action, and one going down never stops the others.
 */
export type Channel = "direct read" | "web search" | "web read" | "linkedin jobs" | "linkedin read";

/** True when a call was not made, or was refused, for a reason that is not the business's fault: a limit or an unavailable source. */
export function isOutOfReach(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "reach_rate_limited" || code === "reach_need_login" || code === "reach_paused" || code === "reach_not_configured" || code === "fetch_limit";
}

export function cachedReach(
  db: Db, scope: { tenantId: string; businessId: string }, reach: ReachConnector, clock: () => Date, counts: FetchCounts, limits: ReachLimits = {},
): ReachConnector & { unavailable: Map<Channel, ReachError>; hasDirect: boolean; siteMap(origin: string): Promise<string[]> } {
  const maxFetches = limits.maxFetches ?? Infinity;
  const minGapMs = limits.minGapMs ?? 0;
  const sleep = limits.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const unavailable = new Map<Channel, ReachError>();
  const retryWaitUpTo = limits.retryWaitUpToSeconds ?? 30;
  const thinBelow = limits.thinBelow ?? 200;
  let lastCall = 0;

  type Kind = "search" | "read" | "jobs";
  const keyOf = (kind: Kind, args: unknown[]) => createHash("sha256").update(JSON.stringify([kind, ...args])).digest("hex");

  /** Today's cached answer for this key, if there is one. */
  async function cached(key: string): Promise<{ day: string; items: ReachItem[] | undefined }> {
    const now = clock();
    return db.tx(scope.tenantId, async (tx) => {
      const day = await tenantDay(tx, now);
      const found = await tx.query("select items from fetched_pages where business_id = $1 and cache_key = $2 and day = $3::date", [scope.businessId, key, day]);
      return { day, items: found.rows[0]?.items as ReachItem[] | undefined };
    });
  }
  async function keep(key: string, day: string, kind: Kind, items: ReachItem[]): Promise<void> {
    await db.tx(scope.tenantId, (tx) =>
      tx.query(
        `insert into fetched_pages (tenant_id, business_id, cache_key, day, kind, items, fetched_at)
         values ($1, $2, $3, $4::date, $5, $6::jsonb, $7) on conflict (tenant_id, business_id, cache_key, day) do nothing`,
        [scope.tenantId, scope.businessId, key, day, kind, JSON.stringify(items), clock()],
      ));
  }

  /** One outside call for one action: refused if that action is already known to be unavailable or the run is at its limit; spaced out; a short stated wait retried once. */
  async function outside<T>(channel: Channel, fetch: () => Promise<T>): Promise<T> {
    // Once the tool has said an action is limited or needs a login, it is not asked again this run.
    const known = unavailable.get(channel);
    if (known) throw known;
    if (limits.reachConfigured === false && channel !== "direct read") {
      // The tool is not installed here. Nothing is run and nothing is counted.
      const err = new ReachError("reach_not_configured", "the search tool is not installed here");
      unavailable.set(channel, err);
      throw err;
    }
    // A run may make only so many outside calls. Past that, a call fails like any refused source and the run goes on.
    if (counts.fetched >= maxFetches) {
      counts.refusedAtLimit = (counts.refusedAtLimit ?? 0) + 1;
      throw new ControlError("fetch_limit", "this run has made as many searches and page reads as it may");
    }
    // Calls are spaced out, so the tool's own limits are not run into by haste.
    const wait = minGapMs - (Date.now() - lastCall);
    if (lastCall > 0 && wait > 0) await sleep(wait);
    lastCall = Date.now();
    counts.fetched += 1;
    try {
      // The outside call is made with no transaction open.
      try {
        return await fetch();
      } catch (first) {
        // "Wait 8 seconds": a short stated wait is honoured and the call made once more. Anything longer, or no wait given, is not retried.
        const wait = first instanceof ReachError && first.code === "reach_rate_limited" ? first.retryAfterSeconds : null;
        if (wait === null || wait > retryWaitUpTo || counts.fetched >= maxFetches) throw first;
        await sleep(Math.ceil(wait * 1000));
        lastCall = Date.now();
        counts.fetched += 1;
        return await fetch();
      }
    } catch (err) {
      if (err instanceof ReachError && (err.code === "reach_rate_limited" || err.code === "reach_need_login" || err.code === "reach_paused" || err.code === "reach_not_configured") && !unavailable.has(channel)) {
        unavailable.set(channel, err);
        await limits.onUnavailable?.(channel, err.code === "reach_rate_limited" ? "rate_limited" : err.code === "reach_paused" ? "paused" : err.code === "reach_not_configured" ? "not_configured" : "need_login", err.retryAfterSeconds);
      }
      throw err;
    }
  }

  async function through(kind: Kind, channel: Channel, args: unknown[], fetch: () => Promise<ReachItem[]>): Promise<ReachItem[]> {
    const key = keyOf(kind, args);
    const hit = await cached(key);
    if (hit.items) {
      counts.fromCache += 1;
      return hit.items;
    }
    const items = await outside(channel, fetch);
    await keep(key, hit.day, kind, items);
    return items;
  }

  const direct = limits.direct ?? null;
  /** A site's robots.txt, fetched once a day per host and kept in the same cache. "" stands for "it has none". */
  async function robotsFor(origin: string): Promise<string | null> {
    const text = (await through("read", "direct read", ["robots", origin], async () => [{ title: null, url: `${origin}/robots.txt`, text: (await (direct as DirectReader).robots(origin)) ?? "" }]))[0]?.text ?? "";
    return text === "" ? null : text;
  }
  /** These reasons are the site's own answer. The fallback reader is never used to get round them. */
  const FINAL = new Set(["direct_disallowed", "direct_blocked", "direct_refused_address", "direct_not_text", "fetch_limit"]);

  /**
   * One page of a business's own site. Read directly first. The outside reader is the fallback only when the
   * direct read fails for an ordinary reason or comes back with almost no text (a site built in JavaScript).
   */
  async function readPage(url: string): Promise<ReachItem | null> {
    if (!direct) return (await through("read", "web read", [url], async () => { const page = await reach.webRead(url); return page ? [page] : []; }))[0] ?? null;
    const key = keyOf("read", [url]);
    const hit = await cached(key);
    if (hit.items) {
      counts.fromCache += 1;
      return hit.items[0] ?? null;
    }
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      throw new DirectReadError("direct_refused_address", "not a web address");
    }
    // robots.txt is asked first and obeyed for both readers.
    let robots: string | null = null;
    try {
      robots = await robotsFor(origin);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      // Refused, or a robots.txt that answers with a server error (which is not a yes): the site is not read.
      if (code === "direct_blocked" || code === "direct_disallowed" || code === "direct_refused_address" || code === "fetch_limit") throw err;
      // Unreachable altogether: the page read below will say so.
    }
    if (!direct.allowedByRobots(url, robots)) throw new DirectReadError("direct_disallowed", "the site's robots.txt does not allow this page to be read");
    try {
      const page = await outside("direct read", () => direct.read(url));
      if (page.text.replace(/\s+/g, " ").trim().length >= thinBelow) {
        const item = { title: page.title, url: page.url, text: page.text };
        await keep(key, hit.day, "read", [item]);
        return item;
      }
    } catch (err) {
      if (FINAL.has(String((err as { code?: unknown } | null)?.code))) throw err;
    }
    counts.fallbackReads = (counts.fallbackReads ?? 0) + 1;
    const page = await outside("web read", () => reach.webRead(url));
    await keep(key, hit.day, "read", page ? [page] : []);
    return page;
  }

  return {
    unavailable,
    hasDirect: direct !== null,
    webSearch: (query, limit) => through("search", "web search", [query, limit], () => reach.webSearch(query, limit)),
    webRead: readPage,
    jobs: (query, location, limit) => through("jobs", "linkedin jobs", [query, location, limit], () => reach.jobs(query, location, limit)),
    jobRead: async (url) => (await through("read", "linkedin read", ["job", url], async () => { const page = await reach.jobRead(url); return page ? [page] : []; }))[0] ?? null,
    /** Addresses from the site's own sitemap, for finding its contact, prices and team pages without a search. Empty without the direct reader. */
    siteMap: async (origin) => {
      if (!direct) return [];
      return (await through("read", "direct read", ["sitemap", origin], async () => (await direct.sitemap(origin)).slice(0, 500).map((url) => ({ title: null, url, text: "" })))).map((item) => item.url);
    },
  };
}

/** Delete cached pages from before yesterday. Returns how many. Meant to run daily. */
export async function purgeFetchedPages(db: Db, input: { tenantId: string }, now = new Date()): Promise<number> {
  return db.tx(input.tenantId, async (tx) => {
    const day = await tenantDay(tx, now);
    return (await tx.query("delete from fetched_pages where day < $1::date - 1", [day])).rowCount ?? 0;
  });
}
