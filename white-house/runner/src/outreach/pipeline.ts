import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelCaller } from "../agents/model-caller.js";
import { readKillSwitch } from "../control/config.js";
import type { ReachConnector, ReachItem } from "../control/connectors/agent-reach.js";
import type { CompaniesHouseConnector } from "../control/connectors/companies-house.js";
import type { Db } from "../control/db.js";
import { emitEvent } from "../control/events.js";
import { finishRun, readBudget, startRun, tenantDay } from "../control/runs.js";
import { extractFromPages, linksIn, pickPages, type Page } from "./extract.js";
import { distinctiveWords, domainKey } from "./normalise.js";
import { cachedReach, isOutOfReach, type Channel, type FetchCounts } from "./page-cache.js";
import { notConfiguredReach } from "../control/connectors/agent-reach.js";
import type { DirectReader } from "../control/connectors/direct-read.js";
import type { Mailbox } from "../control/connectors/mailbox.js";
import type { Place, PlacesConnector, PlacesSearch } from "../control/connectors/places.js";
import { PLACES_PRICE_TIERS } from "../control/connectors/places.js";
import type { Gateway } from "../control/gateway.js";
import { allowanceLeft, breakerToday, collectReplies, emailFor, ENQUIRY_ACTION, enquiryCounts, notTestableReason, proposeEnquiry, requeueAfterRungChange, scoreTested, sentWithoutAsking, syncDecisions, type ReplyCounts, type TestedProspect } from "./enquiries.js";
import { readRung } from "../control/config.js";
import { captureFor, estimateLeak, openAt, sayMinutes, sentOutOfHours, serviceFor, SLOT_NAME, usefulOutOfHours, type Slot, type TestResult } from "./enquiry-rules.js";
import { bestRoute, leadAgentFor, namedGroup } from "./score.js";
import { enabledTypes, forType, SIGNAL_MEANING, type OutreachSettings, type Signal } from "./settings.js";
import { addInto, addTo, analyseBusiness, classifyLeads, draftCard, draftEnquiry, factsFor, noTotals, type Lead, type StageTotals } from "./stages.js";
import {
  addSignals, compare, knownDomains, linkCompetitors, listForAnalysis, markAnalysisFailed, matchHiddenAdvert, nextPairs, recordAnalysis, recordProspect, awaitingCompanyCheck, saveCompanyCheck, type SearchPair,
  countWaiting, knownSiteByName, linkNearest, placeOf, prospectsByIds, PROSPECT_COLUMNS, rejectProspect, saveCard, scoreAndFilter, toProspectRow, triageAnalysed, type Comparison, type ProspectRow, type ProspectScope, type PublicFacts,
} from "./store.js";

/**
 * The prospecting pipeline for one floor: find, analyse, score, shortlist.
 * Nothing is sent to anyone.
 *
 * Code does the searching, the fetching, the reading of contact details, the
 * deduplication, the suppression check, the Companies House check, the
 * filtering and the scoring. A model is called only to read (the cheap one)
 * and to draft (the better one, for those that passed), one call at a time.
 *
 * Each stage is one run in `runs`, with the tokens and cost of all its model
 * calls. The kill switch and the department's budget are checked before each
 * stage starts, and again before every model call inside a stage.
 */

export interface OutreachContext {
  tenantId: string;
  businessId: string;
  businessSlug: string;
  gatewayDb: Db;
  /** Agent tools' role: it is what may add an output. */
  agentDb: Db;
  clock: () => Date;
  apiKey: string;
  settings: OutreachSettings;
  model: ModelCaller;
  /** null: the search tool is not configured. */
  reach: ReachConnector | null;
  companiesHouse: CompaniesHouseConnector | null;
  whRoot: string;
  usdToGbp: number;
  /** The first stage's run, already started (so a kill switch or a spent budget refuses the request itself). */
  firstRunId: string;
  /** "analyse" when businesses are waiting from earlier runs, which come first; otherwise "find". */
  firstStage: "analyse" | "find";
  /** For the gap between calls to the search tool. Tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Google Places. null: no key, so businesses are found by web search as before. */
  places?: PlacesConnector | null;
  /** Reads a business's own pages directly. null: pages are read through the search tool only. */
  directReader?: DirectReader | null;
  /** The test mailbox. null: not configured, so no test enquiry is drafted or read. */
  mailbox: Mailbox | null;
  /** The gateway: the only way an enquiry can be sent. */
  gateway: Gateway;
  /** Called when enquiries have been queued or put forward, so the sender can start on those that need no yes. */
  afterEnquiries?: () => void;
  changed: () => void;
}

const DEPARTMENT = "outreach";
const MAX_PAGES = 4;
/** Characters of each page given to the model. Four pages is then about 6,000 tokens: far below the 100,000 where the cheap model's price rises. */
const PAGE_CHARS = 6000;
const LEADS_PER_CALL = 25;

type Stopped = "kill_switch" | "budget";
const WHY: Record<Stopped, string> = { kill_switch: "the kill switch is set", budget: "the daily budget is spent" };

export type Card = ProspectRow & { competitors: PublicFacts[]; comparison: Comparison | null; test: TestedProspect | null; reissue: boolean };

export interface Tally {
  found: number;
  already_known: number;
  suppressed: number;
  analysed: number;
  filtered_out: Record<string, number>;
  shortlisted: number;
  /** Adverts too old to count as a signal. */
  stale_adverts: number;
  /** Recruiters' adverts tied to a business by postcode only. Shown, never counted. */
  unconfirmed_adverts: number;
  /** Failed only for want of a named person, with no Companies House key to look one up. */
  would_pass_with_companies_house: number;
  /** Test enquiries put to the gateway on this run: to possible clients, and to rivals of those that scored low. */
  enquiries_proposed: { prospect: number; rival: number };
  enquiries_dropped: number;
  /** Businesses scored on this run because their enquiry had waited long enough. */
  scored_after_test: number;
  not_testable: number;
  /** Cards issued again because their rivals' results came in. */
  reissued: number;
  /** Found by Google Places with no website: recorded so they are not found again, but they cannot be analysed or tested by email. */
  no_website: number;
}

/** The fixed parts of each stage's prompt: the house rules, this business, this room, and the stage's own role. */
async function loadPrompts(whRoot: string, businessSlug: string): Promise<Record<"find" | "analyse" | "draft" | "enquiry" | "reply", string>> {
  const read = (...parts: string[]) => readFile(path.join(whRoot, ...parts), "utf8").then((text) => text.trim());
  const [root, business, room, find, analyse, draft, enquiry, reply] = await Promise.all([
    read("CLAUDE.md"), read("businesses", businessSlug, "CLAUDE.md"), read("businesses", businessSlug, "departments", DEPARTMENT, "CLAUDE.md"),
    read("agents", "outreach-find.md"), read("agents", "outreach-analyse.md"), read("agents", "outreach-draft.md"),
    read("agents", "outreach-enquiry.md"), read("agents", "outreach-reply.md"),
  ]);
  const common = `${root}\n\n${business}\n\n${room}`;
  return {
    find: `${common}\n\n${find}`, analyse: `${common}\n\n${analyse}`, draft: `${common}\n\n${draft}`,
    // The enquiry and the reply reader are given only their own rules: they need nothing about Salekh Ventures.
    enquiry: `${root}\n\n${enquiry}`, reply: `${root}\n\n${reply}`,
  };
}

/** The prompt for reading a reply, for the poller that runs between pipeline runs. */
export async function replyPrompt(whRoot: string): Promise<string> {
  const read = (...parts: string[]) => readFile(path.join(whRoot, ...parts), "utf8").then((text) => text.trim());
  return `${await read("CLAUDE.md")}\n\n${await read("agents", "outreach-reply.md")}`;
}

const ACTION: Record<Channel, string> = { "direct read": "Direct page reading", "web search": "Web search", "web read": "Page reading", "linkedin jobs": "LinkedIn job adverts", "linkedin read": "LinkedIn job adverts" };

const REQUEST_STAGE: Record<string, string> = { find: "find", analyse: "analysis", enquiry: "enquiry drafting", reply: "reply reading", draft: "drafting" };

export async function runOutreach(ctx: OutreachContext): Promise<void> {
  const { gatewayDb: db, tenantId, businessId, settings, clock } = ctx;
  const scope = (runId: string | null): ProspectScope => ({ tenantId, businessId, runId });
  const tally: Tally = { found: 0, already_known: 0, suppressed: 0, analysed: 0, filtered_out: {}, shortlisted: 0, stale_adverts: 0, unconfirmed_adverts: 0, would_pass_with_companies_house: 0,
    enquiries_proposed: { prospect: 0, rival: 0 }, enquiries_dropped: 0, scored_after_test: 0, not_testable: 0, reissued: 0, no_website: 0 };
  const costs: Record<"find" | "analyse" | "enquiries" | "adverts" | "draft", StageTotals> = { find: noTotals(), analyse: noTotals(), enquiries: noTotals(), adverts: noTotals(), draft: noTotals() };
  const testing = settings.test_enquiries && ctx.mailbox !== null;
  let replyCounts: ReplyCounts | null = null;
  const fetches: FetchCounts = { fetched: 0, fromCache: 0 };
  const notes: string[] = [];
  let companyCheckFailed = 0;
  let lastRunId = ctx.firstRunId;
  let areasCovered: string[] = [];
  /** The (kind, place) pairs this run searches. */
  let pairs: SearchPair[] = [];
  const firstType = (enabledTypes(settings)[0] ?? settings.type).id;

  const stage = (summary: string, reasonCode: string, runId: string | null = lastRunId, numbers?: Record<string, unknown>) =>
    db.tx(tenantId, (tx) => emitEvent(tx, { tenantId, businessId, department: DEPARTMENT, runId, type: "stage", summary, reasonCode, now: clock(), ...(numbers ? { payload: numbers } : {}) })).then(ctx.changed);
  const toGbp = (usd: number) => Math.round(usd * ctx.usdToGbp * 1e6) / 1e6;

  /**
   * Every model call goes through here. When the API refuses the request itself (a schema it will not compile, a
   * bad parameter, a key it does not accept), that is our fault and it is never silent: an event is written with a
   * fixed reason code and the API's own error type and message. Three of the same in a row at one stage trip it:
   * the stage stops there instead of working through its queue.
   */
  const refusals: Record<string, { same: number; type: string; message: string }> = {};
  const model: ModelCaller = {
    async call(apiKey, request) {
      const reply = await ctx.model.call(apiKey, request);
      const refused = reply.requestError;
      if (!refused) {
        delete refusals[request.stage];
        return reply;
      }
      const before = refusals[request.stage];
      refusals[request.stage] = { same: before && before.type === refused.type && before.message === refused.message ? before.same + 1 : 1, type: refused.type, message: refused.message };
      await db.tx(tenantId, (tx) => emitEvent(tx, {
        tenantId, businessId, department: DEPARTMENT, runId: lastRunId, type: "stage", reasonCode: "model_request_error",
        summary: `The model refused a request at the ${REQUEST_STAGE[request.stage] ?? "model"} stage`,
        payload: { stage: request.stage, status: refused.status, error_type: refused.type, error_message: refused.message }, now: clock(),
      })).then(ctx.changed);
      return reply;
    },
  };
  /** The error type that has now been given three times running at this stage, or null. */
  const tripped = (stageName: string): string | null => ((refusals[stageName]?.same ?? 0) >= 3 ? (refusals[stageName] as { type: string }).type : null);

  /** Close a stage's run with everything its model calls used. The error is always a fixed code. */
  const close = async (runId: string, totals: StageTotals, error: string | null) => {
    await finishRun(db, {
      tenantId, runId, status: error === null ? "done" : "failed",
      tokensIn: Math.round(totals.inputTokens + totals.cacheCreationTokens), tokensOut: Math.round(totals.outputTokens), tokensCached: Math.round(totals.cacheReadTokens),
      costUsd: totals.costUsd, costGbp: toGbp(totals.costUsd), ...(error === null ? {} : { error }),
    }, { now: clock() });
    ctx.changed();
  };
  /** Start the next stage's run. The kill switch and the budget are checked here, by the phase 1 code. */
  const open = async (name: "find" | "analyse" | "enquiries" | "adverts" | "draft", model: string): Promise<string | Stopped> => {
    const started = await startRun(db, { tenantId, businessId, department: DEPARTMENT, trigger: `outreach:${name}`, model }, { now: clock() });
    ctx.changed();
    if (!started.started) return started.reason === "kill_switch" ? "kill_switch" : "budget";
    lastRunId = started.runId;
    return started.runId;
  };
  /** Inside a stage, before each model call: has the switch been set, or has this stage's own spend used up the day's budget? */
  const stopNow = async (spentThisStage: StageTotals): Promise<Stopped | null> =>
    db.tx(tenantId, async (tx) => {
      if (await readKillSwitch(tx, businessId)) return "kill_switch";
      const budget = await readBudget(tx, { businessId, department: DEPARTMENT }, clock());
      return budget.limitGbp === null || budget.spentGbp + toGbp(spentThisStage.costUsd) >= budget.limitGbp ? "budget" : null;
    });

  // ---- before anything: the search tool, the prompts ------------------------
  let firstRunOpen = true;
  // No search tool where this runs (the server): that is fine as long as Google Places finds the businesses and
  // their pages are read directly. Without those two, there is nothing to work with and the run stops.
  const noReach = !ctx.reach;
  if (noReach && !(ctx.places && ctx.directReader)) {
    await stage(ctx.firstStage === "find" ? "Finding businesses" : "Analysing businesses left from earlier runs", ctx.firstStage);
    await close(ctx.firstRunId, noTotals(), "search_not_configured");
    await stage("Stopped: the search tool is not configured", "stopped_not_configured");
    return;
  }
  let prompts: Awaited<ReturnType<typeof loadPrompts>>;
  try {
    prompts = await loadPrompts(ctx.whRoot, ctx.businessSlug);
  } catch {
    await close(ctx.firstRunId, noTotals(), "find_failed");
    await stage("Stopped: the find stage failed", "stopped_failed");
    return;
  }
  // First of all: what came back. Decisions are brought up to date and the mailbox is searched for replies.
  if (testing) {
    await syncDecisions(db, tenantId, clock());
    // Enquiries that were waiting for a yes when their action moved to rung 3 are withdrawn and queued afresh. Nobody approves them.
    const moved = await requeueAfterRungChange(db, tenantId, async () => settings, clock());
    if (moved.requeued + moved.dropped > 0) {
      notes.push(`${moved.requeued + moved.dropped} ${moved.requeued + moved.dropped === 1 ? "enquiry that was" : "enquiries that were"} waiting for your yes ${moved.requeued + moved.dropped === 1 ? "was" : "were"} withdrawn, because enquiries now send without asking. ` +
        `${moved.requeued} passed today's checks and ${moved.requeued === 1 ? "is" : "are"} queued to be sent; ${moved.dropped} did not and will not be sent. None was approved.`);
    }
    replyCounts = await collectReplies({
      db, tenantId, mailbox: ctx.mailbox, model, apiKey: ctx.apiKey, system: prompts.reply, usdToGbp: ctx.usdToGbp, now: clock, windowDays: settings.reply_window_days, maxFailuresADay: settings.enquiry_max_failures_a_day,
    }).catch(() => null);
  }
  // Second: score every business whose enquiry is old enough. Code only, so it is done before anything that can be limited or stopped.
  let scoredNow: Awaited<ReturnType<typeof scoreTested>> = { scored: 0, filtered: {}, passed: [] };
  if (testing) {
    // Companies House is asked only now, after the test, and only about businesses that scored low: is this a
    // limited company, and who is a director. Nothing about a company or a name stopped the test itself.
    if (ctx.companiesHouse) {
      const timezone = (await db.tx(tenantId, async (tx) => (await tx.query("select timezone from tenants where tenant_id = wh_tenant()")).rows[0].timezone)) as string;
      const waitingOn = await awaitingCompanyCheck(db, scope(lastRunId), clock(), settings.reply_wait_hours);
      for (const p of waitingOn) {
        const capture = captureFor(p.testResult as TestResult, [...new Set(p.routes.map((r) => r.kind))], forType(settings, p.typeId), timezone);
        if (capture.score !== null && capture.score > settings.capture_threshold) continue;
        const result = await ctx.companiesHouse.lookup({ number: p.companyNumber, name: p.name, postcode: p.postcode }).catch(() => null);
        if (result) await saveCompanyCheck(db, scope(lastRunId), p.prospectId, result);
        else companyCheckFailed += 1;
      }
    }
    scoredNow = await scoreTested(db, scope(lastRunId), settings, clock(), toProspectRow, PROSPECT_COLUMNS);
    for (const [reason, n] of Object.entries(scoredNow.filtered)) tally.filtered_out[reason] = (tally.filtered_out[reason] ?? 0) + n;
    tally.scored_after_test = scoredNow.scored;
  }
  // What the tool has said it cannot do for the rest of this run. One event each, with the wait when it gave one.
  const limited: { why: "rate_limited" | "need_login" | "paused"; channel: Channel; seconds: number | null }[] = [];
  const reach = cachedReach(db, { tenantId, businessId }, ctx.reach ?? notConfiguredReach(), clock, fetches, {
    reachConfigured: !noReach,
    maxFetches: settings.max_fetches_per_run,
    minGapMs: Math.round(settings.min_seconds_between_fetches * 1000),
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    direct: ctx.directReader ?? null,
    onUnavailable: async (channel, why, seconds) => {
      // Not installed here: said once, in the output, and not as an event for every action.
      if (why === "not_configured") return;
      limited.push({ why, channel, seconds });
      if (why === "rate_limited") {
        await stage(
          seconds === null ? `${ACTION[channel]} reported a rate limit and was left alone for the rest of this run` : `${ACTION[channel]} reported a rate limit and was left alone for the rest of this run. Wait given: ${seconds} seconds`,
          "rate_limited", lastRunId, { channel, retry_after_seconds: seconds },
        );
      } else if (why === "paused") {
        await stage(seconds === null ? "A source was paused upstream and was left alone for the rest of this run" : `A source was paused upstream and was left alone for the rest of this run. Wait given: ${seconds} seconds`,
          "source_paused", lastRunId, { channel, retry_after_seconds: seconds });
      } else {
        await stage("A source needs a signed in session and was left out of this run", "source_unavailable", lastRunId, { channel });
      }
    },
  });
  // Google Places: every call is counted against the run's limit, and a failure is noted, never fatal.
  const placesUse: { calls: number; not_made_at_limit: number; failed: number; by_kind: Record<string, number> } = { calls: 0, not_made_at_limit: 0, failed: 0, by_kind: {} };
  const askPlaces = async (search: PlacesSearch, kind: string): Promise<{ places: Place[]; nextPageToken: string | null } | null> => {
    if (!ctx.places) return null;
    if (placesUse.calls >= settings.max_places_calls_per_run) { placesUse.not_made_at_limit += 1; return null; }
    placesUse.calls += 1;
    placesUse.by_kind[kind] = (placesUse.by_kind[kind] ?? 0) + 1;
    try {
      return await ctx.places.searchText(search);
    } catch {
      placesUse.failed += 1;
      return null;
    }
  };
  /** Put one place on the master list. Returns true when it is new. */
  const recordPlace = async (place: Place, area: string, runId: string | null, typeId: string): Promise<boolean> => {
    if (!place.operational) return false;
    const own = forType(settings, typeId);
    const result = await recordProspect(db, scope(runId), {
      name: place.name, ...(place.website ? { website: place.website } : {}), ...(place.postcode ? { postcode: place.postcode } : {}), area,
      signal: "none", source_url: place.sourceUrl,
    }, { now: clock(), searchArea: area, place, typeId });
    if (!result.recorded) {
      if (result.why === "already_known") tally.already_known += 1;
      else if (result.why === "suppressed") tally.suppressed += 1;
      return false;
    }
    tally.found += 1;
    const setAside = async (reason: string) => {
      await rejectProspect(db, scope(runId), result.prospectId, reason, clock());
      tally.filtered_out[reason] = (tally.filtered_out[reason] ?? 0) + 1;
    };
    if (settings.filters.exclude_groups && (namedGroup(place.name, own) || namedGroup(place.website, own))) await setAside("part_of_group");
    // No website: nothing of its own to read, and no published email to test. Kept on the list so it is not found again.
    else if (!place.website) { tally.no_website += 1; await setAside("no_website"); }
    return true;
  };
  const rateLimited = () => limited.some((l) => l.why === "rate_limited");
  let cutShort = false;
  let advertsLater = false;
  /** Only a limit on reading pages cuts a run short: everything else it does can go on without searching. */
  const readsLimited = () => !reach.hasDirect && reach.unavailable.has("web read");
  let leftForLater = 0;

  /**
   * Analyse a queue of prospects inside one run. Returns "stopped" when the kill switch or the budget ended the
   * whole run (already recorded), otherwise "done". A limit on the search tool ends the queue early without
   * counting against the businesses not reached: they stay found and are first in line next time.
   */
  const analyseQueue = async (runId: string, queue: ProspectRow[]): Promise<"done" | "stopped"> => {
    const totals = noTotals();
    const finish = async () => {
      addInto(costs.analyse, totals);
      await close(runId, totals, null);
    };
    for (const [index, prospect] of queue.entries()) {
      const stop = await stopNow(totals);
      if (stop) {
        await finish();
        await stage(`Stopped before analysing ${index + 1} of ${queue.length}: ${WHY[stop]}`, `stopped_${stop}`);
        return "stopped";
      }
      await stage(`Analysing ${index + 1} of ${queue.length}`, "analyse");
      try {
        const pages = await pagesFor(reach, prospect);
        if (pages.length === 0) throw new Error("no page could be read");
        const extracted = extractFromPages(pages);
        const { reply, analysed } = await analyseBusiness(model, ctx.apiKey, prompts.analyse, forType(settings, prospect.typeId), prospect, pages, extracted);
        addTo(totals, reply);
        if (reply.requestError) {
          // Our own request was refused. That is nothing against this business: it stays as found, with no failed attempt.
          const type = tripped("analyse");
          if (type) {
            addInto(costs.analyse, totals);
            await close(runId, totals, "model_request_error");
            await stage(`Analysis stopped: the model refused the request: ${type}`, "stopped_model_request_error");
            return "stopped";
          }
          continue;
        }
        if (!analysed) throw new Error("the model call failed");
        if (!analysed.isMatch) {
          await rejectProspect(db, scope(runId), prospect.prospectId, "not_a_match", clock());
          tally.filtered_out.not_a_match = (tally.filtered_out.not_a_match ?? 0) + 1;
          continue;
        }
        await addSignals(db, scope(runId), prospect.prospectId, analysed.signals);
        const stored = await recordAnalysis(db, scope(runId), prospect.prospectId, analysed.analysis, { now: clock(), companiesHouse: ctx.companiesHouse });
        if (!stored.ok) throw new Error("the analysis was not accepted");
        tally.analysed += 1;
      } catch (err) {
        const code = String((err as { code?: unknown } | null)?.code ?? "");
        if (code === "direct_disallowed" || code === "direct_blocked") {
          // The site said no, by its robots.txt or by a bot check, a login or a refusal. It is not read, and nothing tries again.
          const reason = code === "direct_disallowed" ? "not_read_disallowed" : "not_read_blocked";
          await rejectProspect(db, scope(runId), prospect.prospectId, reason, clock());
          tally.filtered_out[reason] = (tally.filtered_out[reason] ?? 0) + 1;
          continue;
        }
        if (isOutOfReach(err)) {
          // Not this business's fault: its pages could not be fetched. It is left as found, with no failed attempt against it.
          if (reach.hasDirect && code !== "fetch_limit") {
            // Reading directly still works for the others: only this site needed the fallback reader, which is unavailable.
            leftForLater += 1;
            continue;
          }
          cutShort = true;
          break;
        }
        await markAnalysisFailed(db, scope(runId), prospect.prospectId, clock());
      }
    }
    await finish();
    return "done";
  };

  // ---- backlog first --------------------------------------------------------
  // Businesses found on earlier runs and never analysed come before any new finding.
  let looked = 0;
  const backlog = await listForAnalysis(db, scope(null), settings.find_per_run);
  if (backlog.length > 0) {
    let runId: string | Stopped = ctx.firstRunId;
    if (ctx.firstStage === "analyse") firstRunOpen = false;
    else runId = await open("analyse", "claude-haiku-5-5");
    if (runId === "kill_switch" || runId === "budget") {
      await close(ctx.firstRunId, noTotals(), null);
      await stage(`Stopped before analysing: ${WHY[runId]}`, `stopped_${runId}`);
      return;
    }
    await stage(`Analysing businesses left from earlier runs: ${backlog.length}`, "backlog", runId);
    looked = backlog.length;
    if ((await analyseQueue(runId, backlog)) === "stopped") {
      if (firstRunOpen) await close(ctx.firstRunId, noTotals(), null);
      return;
    }
  }

  /**
   * Job adverts (and, without Google Places, the web search for the kind of business): gather leads, let the cheap
   * model say what each is, record the businesses. `cap` is how many businesses may be on this run's tally when it
   * stops recording; `want` is how many leads are enough to choose from. Throws when nothing came of it.
   */
  const searchRoutes = async (findRunId: string, bucket: StageTotals, cap: number, want: number): Promise<void> => {
      const leads: Lead[] = [];
      const seenUrl = new Set<string>();
      const seenDomain = new Set<string>();
      const areaOf = new Map<string, string>();
      const typeOf = new Map<string, string>();
      let searchingFor = firstType;
      let searches = 0;
      let failedSearches = 0;
      const take = (items: ReachItem[], kind: Lead["kind"], area: string): number => {
        let added = 0;
        for (const item of items) {
          const domain = domainKey(item.url);
          // The same address, or a second page of a site already in hand, is one lead.
          if (seenUrl.has(item.url) || (domain && seenDomain.has(domain))) continue;
          seenUrl.add(item.url);
          if (domain) seenDomain.add(domain);
          areaOf.set(item.url, area);
          typeOf.set(item.url, searchingFor);
          leads.push({ kind, title: item.title ?? "", url: item.url, text: item.text });
          added += 1;
        }
        return added;
      };
      // Enough to choose from, without asking the model about more results than a run can use.

      /** One search. Returns how many new leads it gave, or null when it was not made or failed. */
      const search = async (channel: Channel, kind: Lead["kind"], area: string, run: () => Promise<ReachItem[]>): Promise<number | null> => {
        // A channel the tool has limited, or that needs a login, is not asked again.
        if (reach.unavailable.has(channel) || leads.length >= want) return null;
        searches += 1;
        try {
          return take(await run(), kind, area);
        } catch (err) {
          // A source that fails or refuses is skipped. Nothing tries to get round it.
          if (!isOutOfReach(err)) failedSearches += 1;
          return null;
        }
      };
      // England is too big for one search: each run takes the next few places from the list.
      // Route one, the main intake: public job adverts for front desk roles, the most productive role first.
      // A place's advert searches stop early when two in a row bring nothing new.
      // Only for kinds of business that have an advert search set (a word or two that makes the results the right trade).
      if (settings.signals.includes("hiring_front_desk")) {
        for (const pair of pairs) {
          const hint = forType(settings, pair.typeId).type.job_search_hint;
          if (!hint) continue;
          const place = pair.area;
          searchingFor = pair.typeId;
          let barren = 0;
          for (const role of settings.front_desk_roles) {
            if (barren >= 2) break;
            const added = await search("linkedin jobs", "job", place, () => reach.jobs(`${role} ${hint}`.trim(), place, 25));
            barren = added === null ? barren : added === 0 ? barren + 1 : 0;
          }
          await search("web search", "job", place, () => reach.webSearch(`${settings.front_desk_roles.slice(0, 3).join(" or ")} job vacancy ${hint} ${place}`, 15));
        }
      }
      // Route two: the kind of business and the place. These are the competitor pool and later prospects.
      // With Google Places configured this is done there instead, further down, and the web search is kept for adverts and for reading pages.
      for (const pair of ctx.places ? [] : pairs) {
        const place = pair.area;
        searchingFor = pair.typeId;
        for (const phrase of forType(settings, pair.typeId).type.search_phrases) {
          await search("web search", "search", place, () => reach.webSearch(`${phrase} in ${place}`, 25));
          if (settings.signals.includes("poor_reviews")) await search("web search", "search", place, () => reach.webSearch(`${phrase} ${place} reviews`, 15));
        }
      }
      searchingFor = firstType;
      for (const extra of ctx.places ? [] : settings.extra_searches) await search("web search", "search", areasCovered[0] as string, () => reach.webSearch(extra, 25));
      if (failedSearches > 0) {
        notes.push(`${failedSearches} of ${searches} searches were refused or failed and were skipped.`);
        await stage(`Sources refused or failed and were skipped: ${failedSearches} of ${searches}`, "source_refused");
      }
      if (leads.length === 0 && (failedSearches > 0 || limited.length > 0) && !ctx.places) throw new Error("nothing was found");

      // Before any model is asked: drop what is already on the list or suppressed.
      const domains = [...new Set(leads.map((l) => domainKey(l.url)).filter((d): d is string => d !== null))];
      const { known, suppressed } = await knownDomains(db, scope(findRunId), domains);
      const fresh = leads.filter((lead) => {
        const domain = domainKey(lead.url);
        if (domain && suppressed.has(domain)) { tally.suppressed += 1; return false; }
        if (domain && known.has(domain)) { tally.already_known += 1; return false; }
        return true;
      });
      // Adverts first, so the businesses most likely to pass are the ones the batch is spent on.
      fresh.sort((a, b) => Number(b.kind === "job") - Number(a.kind === "job"));
      let hidden = 0;
      let modelFailures = 0;
      let batches = 0;
      for (let at = 0; at < fresh.length && tally.found < cap; at += LEADS_PER_CALL) {
        if (await stopNow(bucket)) break;
        const batch = fresh.slice(at, at + LEADS_PER_CALL);
        batches += 1;
        const { reply, matches, hidden: hiddenLeads, staleAdverts } = await classifyLeads(model, ctx.apiKey, prompts.find, settings, batch);
        addTo(bucket, reply);
        tally.stale_adverts += staleAdverts;
        if (!reply.ok) { modelFailures += 1; continue; }
        for (const advert of hiddenLeads) {
          // One try to tie it to a business already on the list for that place. A match is only ever "unconfirmed".
          const matched = await matchHiddenAdvert(db, scope(findRunId), advert, areaOf.get(advert.url) ?? (areasCovered[0] as string), clock());
          if (matched) tally.unconfirmed_adverts += 1;
          else hidden += 1;
        }
        for (const match of matches) {
          if (tally.found >= cap) break;
          let website: string | null = match.ownSite ? match.lead.url : null;
          // A business already on the list for that place under the same name has its website on record: no search is needed.
          if (!website) website = await knownSiteByName(db, scope(findRunId), match.businessName, areaOf.get(match.lead.url) ?? (areasCovered[0] as string));
          if (!website) {
            // A job board or a directory names the business but is not its site. Code looks the site up. Its own site
            // is taken to be the first result whose address itself carries a word of its name.
            const wanted = distinctiveWords(match.businessName);
            const hits = await reach.webSearch(`"${match.businessName}" ${match.area || areaOf.get(match.lead.url) || ""}`.trim(), 5).catch(() => [] as ReachItem[]);
            const hit = hits.find((h) => {
              const domain = (domainKey(h.url) ?? "").replace(/[^a-z0-9]/g, "");
              return domain !== "" && wanted.some((word) => domain.includes(word));
            });
            website = hit?.url ?? null;
          }
          const result = await recordProspect(db, scope(findRunId), {
            name: match.businessName, ...(website ? { website } : {}), ...(match.area ? { area: match.area } : {}),
            signal: match.signal, evidence: match.evidence, source_url: match.lead.url,
          }, { now: clock(), sourceOpened: true, typeId: typeOf.get(match.lead.url) ?? firstType, searchArea: areaOf.get(match.lead.url) ?? (areasCovered[0] as string), ...(match.advertAgeDays === undefined ? {} : { advertAgeDays: match.advertAgeDays }) });
          if (result.recorded) {
            tally.found += 1;
            // A group on the excluded list is kept on the list (so it is not found again) and set aside at once, without spending an analysis on it.
            const own = forType(settings, typeOf.get(match.lead.url) ?? firstType);
            if (settings.filters.exclude_groups && (namedGroup(match.businessName, own) || namedGroup(website, own))) {
              await rejectProspect(db, scope(findRunId), result.prospectId, "part_of_group", clock());
              tally.filtered_out.part_of_group = (tally.filtered_out.part_of_group ?? 0) + 1;
            }
          }
          else if (result.why === "already_known") tally.already_known += 1;
          else if (result.why === "suppressed") tally.suppressed += 1;
        }
      }
      if (tally.stale_adverts > 0) notes.push(`${tally.stale_adverts} job adverts were older than ${settings.advert_max_age_days} days and were not counted as a signal.`);
      if (tally.unconfirmed_adverts > 0) notes.push(`${tally.unconfirmed_adverts} recruiters' adverts were tied to a business by postcode only. They are shown as unconfirmed and count for nothing.`);
      if (hidden > 0) {
        notes.push(`${hidden} job adverts were skipped because a recruitment agency posted them without naming the employer.`);
        await stage(`Job adverts skipped, employer hidden by a recruiter: ${hidden}`, "employer_hidden");
      }
      if (batches > 0 && modelFailures === batches) throw new Error("every model call failed");
  };
  /** Google Places, for each place in today's rotation. Plain code, no model call, no web search. */
  const placesRoute = async (findRunId: string, cap: number): Promise<void> => {
      const tokens = new Map<string, string | null>();
      // One (kind, place) pair at a time, one search per phrase of that kind. The first page of every phrase comes
      // before the second page of any, so a run's allowance of calls is spread across the kinds, not spent on one.
      for (const page of [0, 1, 2]) {
        for (const pair of pairs) {
          for (const phrase of forType(settings, pair.typeId).type.search_phrases) {
            const key = `${pair.typeId}|${pair.area}|${phrase}`;
            if (tally.found >= cap || (page > 0 && !tokens.get(key))) continue;
            const token = tokens.get(key);
            const got = await askPlaces({ query: `${phrase} in ${pair.area}`, pageSize: 20, ...(token ? { pageToken: token } : {}) }, pair.typeId);
            tokens.set(key, got?.nextPageToken ?? null);
            for (const found of got?.places ?? []) {
              if (tally.found >= cap) break;
              await recordPlace(found, pair.area, findRunId, pair.typeId);
            }
          }
        }
      }
      if (tally.no_website > 0) notes.push(`${tally.no_website} businesses found by Google Places have no website. They are recorded so they are not found again, but they cannot be analysed or tested by email.`);
  };

  // ---- find -----------------------------------------------------------------
  const room = settings.find_per_run - looked;
  if (room <= 0) {
    notes.push(`Businesses left from earlier runs filled this run's batch of ${settings.find_per_run}, so no new ones were looked for.`);
    if (firstRunOpen) { await close(ctx.firstRunId, noTotals(), null); firstRunOpen = false; }
  } else if (cutShort) {
    if (firstRunOpen) { await close(ctx.firstRunId, noTotals(), null); firstRunOpen = false; }
  } else {
    let findRunId: string | Stopped = ctx.firstRunId;
    if (firstRunOpen) firstRunOpen = false;
    else findRunId = await open("find", "claude-haiku-5-5");
    if (findRunId === "kill_switch" || findRunId === "budget") {
      await stage(`Stopped before finding: ${WHY[findRunId]}`, `stopped_${findRunId}`);
      return;
    }
    lastRunId = findRunId;
    await stage("Finding businesses", "find");
    // England is too big for one search, and there is more than one kind of business: each run takes the next few (kind, place) pairs.
    const kinds = enabledTypes(settings).map((t) => t.id);
    pairs = await nextPairs(db, scope(findRunId), kinds, settings.areas.length > 0 ? settings.areas : [settings.area], settings.areas_per_run, clock());
    areasCovered = [...new Set(pairs.map((pair) => pair.area))];
    if (kinds.length === 0) notes.push("**No kind of business is switched on**, so nothing new was looked for. Switch one on with `npm run outreach-settings -- --enable-type <id>`.");
    let fatal: string | null = null;
    if (ctx.places) {
      // Places finds the businesses. The searches for job adverts are a bonus and are left to the end of the run,
      // so that a limit on searching cannot hold up anything that matters.
      if (!(await stopNow(costs.find))) await placesRoute(findRunId, room);
      advertsLater = settings.signals.includes("hiring_front_desk") && !noReach;
    } else {
      try {
        await searchRoutes(findRunId, costs.find, room, room * 6);
      } catch {
        // Nothing came of the finding. Whether that ends the run depends on whether there is anything else to work with.
        fatal = rateLimited() ? "search_rate_limited" : "find_failed";
      }
    }
    if (readsLimited()) cutShort = true;
    if (fatal !== null && tally.analysed === 0 && tally.found === 0) {
      // The reason recorded is a fixed code: an error's own text could hold anything.
      await close(findRunId, costs.find, fatal);
      await stage(fatal === "search_rate_limited" ? "Stopped: the search tool's rate limit left nothing to work with" : "Stopped: the find stage failed", fatal === "search_rate_limited" ? "stopped_rate_limited" : "stopped_failed");
      return;
    }
    await close(findRunId, costs.find, null);

    // ---- analyse what was just found ---------------------------------------
    const queue = readsLimited() ? [] : await listForAnalysis(db, scope(null), room);
    if (queue.length > 0) {
      const runId = await open("analyse", "claude-haiku-5-5");
      if (runId === "kill_switch" || runId === "budget") {
        await stage(`Stopped before analysing: ${WHY[runId]}`, `stopped_${runId}`);
        return;
      }
      if ((await analyseQueue(runId, queue)) === "stopped") return;
    }
  }

  // ---- decide who is worth what (code only) --------------------------------
  const filterInto = (counts: Record<string, number>) => {
    for (const [reason, n] of Object.entries(counts)) tally.filtered_out[reason] = (tally.filtered_out[reason] ?? 0) + n;
  };
  let tested: TestedProspect[] = [];
  let untested: ProspectRow[] = [];
  let toTest: ProspectRow[] = [];
  let considered = 0;
  if (testing) {
    // (Businesses whose enquiry was old enough were scored at the start of the run.) The newly analysed are sorted here.
    tested = scoredNow.passed;
    const triage = await triageAnalysed(db, scope(lastRunId), settings, clock(), (p, s) => notTestableReason(p, s, settings));
    filterInto(triage.filtered);
    toTest = triage.toTest;
    untested = triage.passedUntested;
    tally.not_testable = untested.length + (triage.filtered.no_signal ?? 0);
    tally.would_pass_with_companies_house = triage.wouldPassWithCompaniesHouse;
    considered = scoredNow.scored + triage.considered;
  } else {
    const scored = await scoreAndFilter(db, scope(lastRunId), settings, clock());
    filterInto(scored.filtered);
    untested = scored.passed;
    tally.would_pass_with_companies_house = scored.wouldPassWithCompaniesHouse;
    considered = scored.considered;
  }
  await stage(`Scoring and filtering ${considered}`, "score");
  if (tally.would_pass_with_companies_house > 0) notes.push(`${tally.would_pass_with_companies_house} failed only because no person was named. With a Companies House key a director's name could be looked up for them.`);
  if ((fetches.refusedAtLimit ?? 0) > 0) notes.push(`The run reached its limit of ${settings.max_fetches_per_run} searches and page reads; ${fetches.refusedAtLimit} more were not made.`);

  type Due = { prospect: ProspectRow; test: TestedProspect | null; reissue: boolean; linked: { self: PublicFacts; competitors: PublicFacts[] } | null };
  const due: Due[] = [];
  // A business that scored low: its rivals are the nearest businesses of the same kind, by Google Places, when it is configured.
  // They are put on the master list like any other, so each is analysed, and tested once, in its turn.
  for (const t of ctx.places ? tested : []) {
    const self = await placeOf(db, scope(lastRunId), t.prospectId);
    if (!self?.location || self.hasRivals) continue;
    // The same kind of business, always: a solicitor is compared with solicitors.
    const got = await askPlaces({ query: forType(settings, t.typeId).type.search_phrases[0] as string, pageSize: 10, near: { ...self.location, radiusMetres: settings.rival_search_radius_metres } }, t.typeId);
    if (!got) continue;
    const near = got.places.filter((pl) => pl.id !== self.placeId && pl.operational && pl.website);
    for (const pl of near) await recordPlace(pl, t.area ?? areasCovered[0] ?? settings.area, lastRunId, t.typeId);
    await linkNearest(db, scope(lastRunId), t.prospectId, near.map((pl) => pl.id), clock());
  }
  for (const t of tested) due.push({ prospect: t, test: t, reissue: false, linked: await linkCompetitors(db, scope(lastRunId), t.prospectId, clock(), settings) });
  for (const p of untested) due.push({ prospect: p, test: null, reissue: false, linked: await linkCompetitors(db, scope(lastRunId), p.prospectId, clock(), settings) });
  const held = Math.max(0, due.length - settings.shortlist_size);
  due.length = Math.min(due.length, settings.shortlist_size);

  // ---- rivals: tested only for a business that has itself scored low ----------
  const wanted: { prospect: ProspectRow; purpose: "prospect" | "rival"; slot?: Slot | null }[] = [];
  const seen = new Set<string>();
  /** Which of a prospect's rivals still have a result to come. Those that can be sent an enquiry and have none are queued for one. */
  const rivalsToCome = async (linked: Due["linked"]): Promise<boolean> => {
    // A rival is tested in the same slot as the business it is set beside.
    const slot = linked?.self.slot ?? null;
    const rivals = linked?.competitors ?? [];
    if (rivals.length === 0) return false;
    if (await rivalsPending(db, scope(lastRunId), rivals.map((r) => r.prospect_id), settings, clock())) return true;
    const ids = rivals.filter((c) => c.tested === "no").map((c) => c.prospect_id);
    // One enquiry ever: a rival that already has one (sent, failed or in hand) is not drafted for again.
    const has = new Set(ids.length === 0 ? [] : await db.tx(tenantId, async (tx) =>
      (await tx.query("select prospect_id from enquiries where prospect_id = any ($1) and status not in ('rejected', 'expired')", [ids])).rows.map((r) => r.prospect_id as string)));
    let queued = false;
    for (const rival of await prospectsByIds(db, scope(lastRunId), ids.filter((id) => !has.has(id)))) {
      const own = forType(settings, rival.typeId);
      if (rival.notTestableReason || !own.type.email_test || !emailFor(rival) || namedGroup(rival.name, own) || namedGroup(rival.website, own)) continue;
      queued = true;
      if (seen.has(rival.prospectId)) continue;
      seen.add(rival.prospectId);
      wanted.push({ prospect: rival, purpose: "rival", slot });
    }
    return queued;
  };
  const rivalsStillToCome = new Map<string, boolean>();
  if (testing) {
    // A business that has just scored low: its rivals are queued for an enquiry and its card goes out now, marked.
    for (const d of due.filter((x) => x.test !== null)) rivalsStillToCome.set(d.prospect.prospectId, await rivalsToCome(d.linked));
    // Cards issued earlier as "rivals not tested yet" are issued again once every rival that can be tested has a result.
    for (const waiting of await cardsAwaitingRivals(db, scope(lastRunId))) {
      const linked = await linkCompetitors(db, scope(lastRunId), waiting.prospectId, clock(), settings);
      if (await rivalsToCome(linked)) continue;
      const again = await retested(db, scope(lastRunId), waiting, settings);
      if (again && (linked?.competitors ?? []).some((r) => r.tested === "scored")) due.push({ prospect: again, test: again, reissue: true, linked });
      else await db.tx(tenantId, (tx) => tx.query("update prospects set card = card || '{\"rivals_pending\": false}'::jsonb where prospect_id = $1", [waiting.prospectId]));
    }
  }

  // ---- propose the day's enquiries -----------------------------------------
  if (testing) {
    // Rivals of businesses that scored low come first, to finish a comparison in hand. Then new businesses, best fit first.
    // The day's allowance is shared evenly across the kinds of business: one from each kind in turn, best fit first
    // within a kind. A kind with fewer ready than its share passes the rest on.
    const byKind = new Map<string, ProspectRow[]>();
    for (const p of toTest) if (!seen.has(p.prospectId)) byKind.set(p.typeId, [...(byKind.get(p.typeId) ?? []), p]);
    for (let turn = 0; [...byKind.values()].some((list) => list.length > turn); turn += 1) {
      for (const list of byKind.values()) if (list[turn]) wanted.push({ prospect: list[turn] as ProspectRow, purpose: "prospect" });
    }
    let allowance = await allowanceLeft(db, scope(lastRunId), clock());
    if (wanted.length > 0 && allowance <= 0) notes.push(`${wanted.length} businesses are ready for a test enquiry, but today's allowance is used up (or none is set). They wait for tomorrow.`);
    if (wanted.length > 0 && allowance > 0) {
      const runId = await open("enquiries", "claude-haiku-5-5");
      if (runId === "kill_switch" || runId === "budget") {
        await stage(`Stopped before drafting enquiries: ${WHY[runId]}`, `stopped_${runId}`);
        return;
      }
      const list = wanted.slice(0, allowance);
      for (const [index, want] of list.entries()) {
        const stop = await stopNow(costs.enquiries);
        if (stop) {
          await close(runId, costs.enquiries, null);
          await stage(`Stopped before drafting enquiry ${index + 1} of ${list.length}: ${WHY[stop]}`, `stopped_${stop}`);
          return;
        }
        await stage(`Drafting enquiry ${index + 1} of ${list.length}`, "enquiries");
        const a = want.prospect.analysis;
        const kindSettings = forType(settings, want.prospect.typeId);
        // One named service from the kind's own list. With none, nothing is asked: a vague enquiry is not sent.
        const namedService = serviceFor(a, kindSettings);
        if (namedService === null) continue;
        const said = (f: unknown) => (typeof f === "object" && f !== null ? String((f as { value?: unknown }).value ?? "") : "") || null;
        const { replies, draft } = await draftEnquiry(model, ctx.apiKey, prompts.enquiry, kindSettings, {
          key: want.prospect.prospectId, namedService,
          name: want.prospect.name, area: want.prospect.area, service: said(a?.highest_value_service), sells: said(a?.what_they_sell),
        }).catch(() => ({ replies: [], draft: null }));
        for (const reply of replies) addTo(costs.enquiries, reply);
        if (replies.some((r) => r.requestError)) {
          // Refused by the API, not a draft that broke the rules: nothing is counted against the business.
          const type = tripped("enquiry");
          if (type) { notes.unshift(`**Enquiry drafting stopped: the model refused the request: ${type}.** No more enquiries were drafted this run.`); break; }
          continue;
        }
        if (!draft) { tally.enquiries_dropped += 1; continue; }
        const result = await proposeEnquiry(db, ctx.gateway, scope(runId), want.prospect, draft, clock(), want.purpose, namedService, want.slot ?? null, settings.enquiry_slots);
        if (result.proposed) {
          tally.enquiries_proposed[want.purpose] += 1;
          allowance -= 1;
        } else if (result.why === "refused" && (result.detail === "cap_exceeded" || result.detail === "kill_switch" || result.detail === "budget_exceeded")) {
          notes.push("The gateway refused further enquiries today (the day's allowance, the kill switch or the budget). The rest wait.");
          break;
        }
      }
      await close(runId, costs.enquiries, null);
      ctx.afterEnquiries?.();
      if (wanted.length > list.length) notes.push(`${wanted.length - list.length} more businesses are ready for a test enquiry and wait for tomorrow's allowance.`);
      if (tally.enquiries_dropped > 0) notes.push(`${tally.enquiries_dropped} drafted enquiries broke the written rules twice and were dropped. Those businesses wait for another run.`);
    }
  }

  // ---- last, and optional: job adverts as a bonus signal ----------------------
  // Only reached this late when Places did the finding. Nothing here can fail the run or cut it short.
  if (advertsLater) {
    const runId = await open("adverts", "claude-haiku-5-5");
    if (runId !== "kill_switch" && runId !== "budget") {
      await stage("Looking for job adverts", "adverts");
      // A business an advert names that is already on the list gains the signal. Up to ten new ones are recorded, to be read next run.
      await searchRoutes(runId, costs.adverts, tally.found + 10, 60).catch(() => undefined);
      await close(runId, costs.adverts, null);
    }
  }
  const searched = (action: Channel) => !reach.unavailable.has(action);
  if (noReach) notes.push("Job adverts are not searched on this server: the search tool is not installed here. Businesses are found by Google Places and their pages are read directly.");
  else if (settings.signals.includes("hiring_front_desk") && (!searched("web search") || !searched("linkedin jobs"))) {
    notes.push(!searched("web search") && !searched("linkedin jobs")
      ? "**Job adverts were not searched this run:** both web search and LinkedIn job adverts were unavailable. They are a bonus signal; everything else carried on."
      : `Job adverts were only partly searched this run: ${!searched("web search") ? "web search" : "LinkedIn job adverts"} was unavailable. They are a bonus signal; everything else carried on.`);
  }

  // ---- draft the cards ------------------------------------------------------
  const cards: Card[] = [];
  let setAside = 0;
  if (due.length > 0) {
    const runId = await open("draft", "claude-sonnet-5-5");
    if (runId === "kill_switch" || runId === "budget") {
      await stage(`Stopped before drafting: ${WHY[runId]}`, `stopped_${runId}`);
      return;
    }
    for (const [index, d] of due.entries()) {
      const stop = await stopNow(costs.draft);
      if (stop) {
        await close(runId, costs.draft, null);
        await stage(`Stopped before drafting ${index + 1} of ${due.length}: ${WHY[stop]}`, `stopped_${stop}`);
        return;
      }
      await stage(`Drafting ${index + 1} of ${due.length}`, "draft");
      const prospect = d.prospect;
      const leadAgent = leadAgentFor(prospect.signals.filter((s) => s.unconfirmed !== true).map((s) => s.signal), settings);
      // The comparison with local competitors is made by code from what is already on the master list.
      const comparison = d.linked ? compare(d.linked.self, d.linked.competitors) : null;
      const route = bestRoute(prospect.routes);
      const facts = factsFor(prospect, leadAgent, forType(settings, prospect.typeId), route, comparison?.unfavourable ?? [], d.test ? resultFacts(d.test) : null);
      const { replies, draft } = await draftCard(model, ctx.apiKey, prompts.draft, facts, d.test !== null).catch(() => ({ replies: [], draft: null }));
      for (const reply of replies) addTo(costs.draft, reply);
      const refusedType = replies.some((r) => r.requestError) ? tripped("draft") : null;
      if (refusedType) {
        await close(runId, costs.draft, "model_request_error");
        await stage(`Drafting stopped: the model refused the request: ${refusedType}`, "stopped_model_request_error");
        return;
      }
      if (!draft) { setAside += 1; continue; }
      const competitors = d.linked?.competitors ?? [];
      const card: Record<string, any> = {
        ...draft, lead_agent: leadAgent, tested: d.test !== null,
        ...(d.test ? { capture: d.test.capture, leak: d.test.leak, enquiry_sent_at: d.test.test.sent_at } : {}),
        // Issued as soon as the prospect's own result is in. Issued again when its rivals' results are.
        rivals_pending: d.test !== null && !d.reissue && rivalsStillToCome.get(prospect.prospectId) === true,
        ...(d.reissue ? { reissued: true } : {}),
        ...(d.test === null && prospect.notTestableReason ? { not_testable: prospect.notTestableReason } : {}),
      };
      await saveCard(db, scope(runId), prospect.prospectId, card, clock());
      cards.push({ ...prospect, card: card as Card["card"], competitors, comparison, test: d.test, reissue: d.reissue });
    }
    const failed = cards.length === 0;
    await close(runId, costs.draft, failed ? "draft_failed" : null);
    if (failed) {
      await stage("Stopped: the drafting stage failed", "stopped_failed");
      return;
    }
  }
  tally.shortlisted = cards.filter((c) => !c.reissue).length;
  tally.reissued = cards.filter((c) => c.reissue).length;
  if (setAside > 0) notes.push(`${setAside} passed the filters but their drafts were not accepted, so they are held for the next run.`);
  if (held > 0) notes.push(`${held} more passed the filters and are held for the next run.`);

  // ---- the shortlist -------------------------------------------------------
  const waiting = await countWaiting(db, { tenantId, businessId });
  const readLimit = reach.hasDirect ? undefined : limited.find((l) => l.channel === "web read");
  if (cutShort || (fetches.refusedAtLimit ?? 0) > 0) {
    const why = readLimit
      ? `page reading ${readLimit.why === "rate_limited" ? "reported a rate limit" : "was unavailable"}${readLimit.seconds === null ? "" : ` (wait given: ${readLimit.seconds} seconds)`}`
      : "the run reached its own limit on searches and page reads";
    notes.unshift(`**This run was cut short:** ${why}. ${waiting} ${waiting === 1 ? "business is" : "businesses are"} found and waiting to be analysed. They come first on the next run.`);
  } else if (waiting > 0) {
    notes.push(`${waiting} ${waiting === 1 ? "business is" : "businesses are"} found and waiting to be analysed on the next run.`);
  }
  // A limit on anything but reading pages does not cut the run short. It is said, and the run carries on.
  for (const l of limited.filter((x) => x.why === "rate_limited" && (x.channel !== "web read" || reach.hasDirect))) {
    const what = l.channel === "web read" ? "The fallback page reader" : ACTION[l.channel];
    notes.push(`${what} reported a rate limit${l.seconds === null ? "" : ` (wait given: ${l.seconds} seconds)`} and was left alone for the rest of this run. ${reach.hasDirect ? "Reading pages directly" : "Page reading"}${ctx.places ? ", Google Places" : ""} and everything else carried on.`);
  }
  if (companyCheckFailed > 0) notes.push(`Companies House could not be reached for ${companyCheckFailed} tested ${companyCheckFailed === 1 ? "business" : "businesses"}, so whether ${companyCheckFailed === 1 ? "it is a limited company" : "they are limited companies"} is not confirmed.`);
  if (leftForLater > 0) notes.push(`${leftForLater} ${leftForLater === 1 ? "business's pages" : "businesses' pages"} gave almost no text when read directly (usually a site that needs JavaScript) and the fallback reader was unavailable. ${leftForLater === 1 ? "It waits" : "They wait"} for the next run.`);
  if (tally.filtered_out.not_read_disallowed) notes.push(`${tally.filtered_out.not_read_disallowed} not read: disallowed by the site (its robots.txt). Nothing tries to get round that.`);
  if (tally.filtered_out.not_read_blocked) notes.push(`${tally.filtered_out.not_read_blocked} not read: blocked (the site showed a bot check, a login or a refusal). Nothing tries to get past that.`);
  for (const l of limited.filter((x) => x.why === "paused")) {
    notes.push(`${l.channel.startsWith("linkedin") ? "Job adverts from LinkedIn" : ACTION[l.channel]} were paused by the source part way through this run${l.seconds === null ? "" : ` (it gave a wait of ${l.seconds} seconds)`}. That source was left alone for the rest of the run, not retried.${l.channel.startsWith("linkedin") ? " Adverts are a bonus signal: businesses were still found the main way." : ""}`);
  }
  if (limited.some((l) => l.why === "need_login")) notes.push("Job adverts from LinkedIn were not available on this run: the source asked for a signed in session, which is not used. Other sources were searched.");
  if (settings.test_enquiries && !ctx.mailbox) notes.push("**Test enquiries are switched on but the test mailbox is not configured**, so none was drafted and this shortlist is made from fit and signals alone.");
  const counts = testing ? await enquiryCounts(db, scope(lastRunId), settings, clock()) : null;
  // The digest: what went out without anybody's yes and has not been told of on an earlier shortlist.
  const enquiries = counts === null ? null : {
    ...counts,
    rung: await db.tx(tenantId, (tx) => readRung(tx, businessId, ENQUIRY_ACTION)),
    sent_without_asking: await sentWithoutAsking(db, scope(lastRunId), clock()),
    stopped: await breakerToday(db, tenantId, clock()),
    room: `${ctx.businessSlug}:${DEPARTMENT}`,
  };
  const day = await db.tx(tenantId, (tx) => tenantDay(tx, clock()));
  const money = Object.fromEntries(
    (Object.entries(costs) as [string, StageTotals][]).map(([name, t]) => [name, {
      model_calls: t.calls, ...(t.failedCalls > 0 ? { failed_calls: t.failedCalls } : {}), tokens_in: t.inputTokens + t.cacheCreationTokens + t.cacheReadTokens, tokens_out: t.outputTokens,
      cost_usd: Math.round(t.costUsd * 1e6) / 1e6, cost_gbp: toGbp(t.costUsd),
    }]),
  );
  const totalGbp = toGbp(Object.values(costs).reduce((sum, t) => sum + t.costUsd, 0));
  const per = (n: number) => (n > 0 ? Math.round((totalGbp / n) * 1e4) / 1e4 : null);
  const data = {
    date: day, tally, areas_searched: areasCovered, waiting_for_analysis: waiting,
    cut_short: limited.map((l) => ({ channel: l.channel, why: l.why, retry_after_seconds: l.seconds })),
    enquiries, replies_collected: replyCounts,
    places: ctx.places ? { ...placesUse, limit: settings.max_places_calls_per_run, price_tier: PLACES_PRICE_TIERS.search } : null,
    cards: cards.map((c) => ({
      prospect_id: c.prospectId, score: c.score, capture_score: c.test?.capture.score ?? null, reissue: c.reissue,
      estimated_leak: c.test?.leak.estimated ? { low: c.test.leak.low, high: c.test.leak.high } : null,
      competitor_ids: c.competitors.map((x) => x.prospect_id),
    })),
    costs: { ...money, total_gbp: totalGbp, per_business_looked_at_gbp: per(tally.analysed), per_business_shortlisted_gbp: per(tally.shortlisted) },
    fetches,
  };
  const title = `Shortlist, ${day}`;
  if (ctx.places) {
    notes.push(`Google Places: ${placesUse.calls} calls made this run${placesUse.calls > 0 ? ` (${Object.entries(placesUse.by_kind).map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}, limit ${settings.max_places_calls_per_run}, each billed by Google as "${PLACES_PRICE_TIERS.search}"` +
      `${placesUse.not_made_at_limit > 0 ? `; ${placesUse.not_made_at_limit} more were not made at the limit` : ""}${placesUse.failed > 0 ? `; ${placesUse.failed} failed and were skipped` : ""}. This cost is not in the model cost below.`);
  } else notes.push("Google Places is not configured (no key), so businesses were found by web search.");
  const timezone = (await db.tx(tenantId, async (tx) => (await tx.query("select timezone from tenants where tenant_id = wh_tenant()")).rows[0].timezone)) as string;
  const body = renderShortlist(title, settings, tally, cards, data.costs, fetches, notes, ctx.companiesHouse !== null, areasCovered, enquiries, timezone);
  const now = clock();
  // The agent tools' role is the one allowed to add an output. It cannot read it back, so the id is made here.
  const outputId = randomUUID();
  await ctx.agentDb.tx(tenantId, (tx) =>
    tx.query(
      "insert into outputs (output_id, tenant_id, business_id, department, run_id, title, body, data, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)",
      [outputId, tenantId, businessId, DEPARTMENT, lastRunId, title, body, JSON.stringify(data), now],
    ));
  await db.tx(tenantId, (tx) => emitEvent(tx, { tenantId, businessId, department: DEPARTMENT, runId: lastRunId, type: "output", summary: "A piece of work was finished", payload: { outputId }, now }));
  await stage(`Shortlist ready: ${tally.shortlisted} of ${considered} passed`, "ready");
}

/** The measured result of a test, as plain facts for the drafting model. No estimate is among them. */
function resultFacts(t: TestedProspect): string[] {
  const sent = new Date(t.test.sent_at);
  const people = t.test.replies.filter((r) => r.kind === "person").sort((a, b) => a.received_at.localeCompare(b.received_at));
  const first = people[0];
  return [
    "A TEST ENQUIRY WAS SENT to this business by email, by Salekh, signed with his own first name. It was a test. The first message must say so plainly.",
    `The enquiry said:\n${t.enquiry.subject}\n${t.enquiry.body}`,
    first
      ? `A person replied ${sayMinutes((new Date(first.received_at).getTime() - sent.getTime()) / 60000)} after it was sent.`
      : "Nobody replied in the first 24 hours.",
    ...(t.test.slot ? [`${sentWhen(t.test, t.timezone ?? "Europe/London")}.`] : []),
    ...(t.test.replies.some((r) => r.kind === "automatic") ? ["An automatic acknowledgement came back. It is not a reply from a person."] : []),
    ...(first?.answered ? [`The reply ${first.answered.value ? "answered" : "did not answer"} the question asked.`] : []),
    ...(first?.next_step ? [`The reply ${first.next_step.value ? "offered" : "did not offer"} a next step.`] : []),
  ];
}

/** "Sent Tuesday 19:42, when they were closed", in the tenant's own time. */
function sentWhen(test: TestResult, timezone: string): string {
  const at = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(test.sent_at)).replace(",", "");
  const state = test.opening_state === "closed" ? "when they were closed" : test.opening_state === "open" ? "when they were open" : "their opening hours are not known";
  return `Sent ${at}, ${state} (${SLOT_NAME[test.slot as Slot]})`;
}

/** Shortlisted businesses whose card says their rivals' results were still to come. */
async function cardsAwaitingRivals(db: Db, scope: ProspectScope): Promise<ProspectRow[]> {
  const ids = await db.tx(scope.tenantId, async (tx) =>
    (await tx.query("select prospect_id from prospects where business_id = $1 and stage = 'shortlisted' and card ->> 'rivals_pending' = 'true' and purged_at is null order by shortlisted_at", [scope.businessId]))
      .rows.map((r) => r.prospect_id as string));
  return prospectsByIds(db, scope, ids);
}

/** Is any of these rivals still to be heard about: an enquiry waiting for a yes, waiting to be sent, or inside its waiting time? */
async function rivalsPending(db: Db, scope: ProspectScope, rivalIds: string[], settings: OutreachSettings, now: Date): Promise<boolean> {
  if (rivalIds.length === 0) return false;
  return db.tx(scope.tenantId, async (tx) =>
    (await tx.query(
      `select 1 from enquiries e join prospects p on p.prospect_id = e.prospect_id
        where e.prospect_id = any ($1) and (e.status in ('proposed', 'queued', 'approved', 'sending')
           or (e.status = 'sent' and not (coalesce((p.test_result ->> 'score_after')::timestamptz, e.sent_at + ($3 * interval '1 hour')) <= $2)))
       union all
       -- a rival found by Places that has not been analysed yet: its pages are read on the next run
       select 1 from prospects where prospect_id = any ($1) and stage = 'found' and website is not null and purged_at is null
       limit 1`,
      [rivalIds, now, settings.reply_wait_hours],
    )).rows.length > 0);
}

/** A shortlisted business with its stored test, for issuing its card again. */
async function retested(db: Db, scope: ProspectScope, p: ProspectRow, settings: OutreachSettings): Promise<TestedProspect | null> {
  return db.tx(scope.tenantId, async (tx) => {
    const row = (await tx.query(
      `select p.test_result, t.timezone, e.subject, e.body, e.to_address from prospects p join tenants t on t.tenant_id = p.tenant_id
         join enquiries e on e.prospect_id = p.prospect_id and e.status = 'sent' where p.prospect_id = $1`,
      [p.prospectId],
    )).rows[0];
    if (!row?.test_result) return null;
    const test = row.test_result as TestResult;
    const people = test.replies.filter((r) => r.kind === "person").sort((a, b) => a.received_at.localeCompare(b.received_at));
    const price = typeof p.analysis?.highest_value_price === "object" && p.analysis.highest_value_price !== null ? (p.analysis.highest_value_price as { amount: number; source_url: string }) : null;
    return {
      ...p, test, capture: captureFor(test, [...new Set(p.routes.map((r) => r.kind))], forType(settings, p.typeId), row.timezone),
      leak: estimateLeak(price, {
        minutesToReply: people[0] ? (new Date(people[0].received_at).getTime() - new Date(test.sent_at).getTime()) / 60000 : null,
        ...(sentOutOfHours(test) ? { outOfHours: { useful: usefulOutOfHours(test, row.timezone).band !== null } } : {}),
      }, forType(settings, p.typeId)),
      enquiry: { subject: row.subject, body: row.body, to: row.to_address },
    };
  });
}

/** At most four pages of the business's own site: home, then contact, about or team, treatments or prices. */
async function pagesFor(reach: ReachConnector & { hasDirect?: boolean; siteMap?: (origin: string) => Promise<string[]> }, prospect: ProspectRow): Promise<Page[]> {
  const host = domainKey(prospect.website);
  if (!prospect.website || !host) return [];
  const pages: Page[] = [];
  const home = await reach.webRead(/^https?:\/\//i.test(prospect.website) ? prospect.website : `https://${prospect.website}`);
  if (home?.text) pages.push({ url: home.url, text: home.text.slice(0, PAGE_CHARS) });
  let candidates = home ? linksIn(home.text) : [];
  let textOf = new Map<string, string>();
  if (reach.hasDirect) {
    // Read directly, the home page lists its own links, so no search is needed. A thin list is topped up from the site's sitemap.
    if (home && pickPages(candidates, host, pages.map((p) => p.url)).length < 2 && reach.siteMap) {
      candidates = [...candidates, ...(await reach.siteMap(new URL(home.url).origin).catch(() => [] as string[]))];
    }
  } else {
    // Clean text keeps few links, so the site's other pages are found by one search as well.
    const found = await reach.webSearch(`${prospect.name} ${host} contact about team treatments prices`, 10).catch(() => [] as ReachItem[]);
    textOf = new Map(found.map((item) => [item.url, item.text]));
    candidates = [...candidates, ...found.map((item) => item.url)];
  }
  for (const url of pickPages(candidates, host, pages.map((p) => p.url))) {
    if (pages.length >= MAX_PAGES) break;
    const text = (await reach.webRead(url).catch(() => null))?.text || textOf.get(url) || "";
    if (text) pages.push({ url, text: text.slice(0, PAGE_CHARS) });
  }
  return pages;
}

const shown = (value: unknown): string => {
  if (value === "not found" || value === null || value === undefined) return "not found";
  const v = value as { value?: unknown; count?: unknown; source_url?: string };
  return `${String(v.value ?? v.count)}${v.source_url ? ` (source: ${v.source_url})` : ""}`;
};

/** The shortlist a person reads: where things stand, then one card per business, the weakest at capturing first. */
export function renderShortlist(
  title: string, settings: OutreachSettings, tally: Tally, cards: Card[],
  costs: Record<string, any>, fetches: FetchCounts, notes: string[], companiesHouseChecked: boolean, areas: string[],
  enquiries: { waiting_for_approval: number; approved_not_sent: number; queued_to_send?: number; sent_awaiting: number; scored: number; sent_without_asking?: { total: number; by_kind: Record<string, number>; ids?: string[] }; rung?: number; stopped?: string | null; room?: string } | null,
  timezone = "Europe/London",
): string {
  const filtered = Object.entries(tally.filtered_out).sort(([a], [b]) => a.localeCompare(b));
  const stageCosts = Object.entries(costs).filter(([, v]) => v && typeof v === "object" && "model_calls" in v && (v.model_calls > 0 || v.failed_calls > 0))
    .map(([name, v]) => `${name} £${v.cost_gbp} (${v.model_calls} calls${v.failed_calls ? `, and ${v.failed_calls} that failed and did no work` : ""})`).join(", ");
  const lines: string[] = [
    `# ${title}`, "",
    `Looking for ${settings.business_types.filter((t) => t.enabled).map((t) => t.name).join("; ") || "nothing: no kind of business is switched on"} in ${settings.area}. Searched this run: ${areas.join(", ") || "nowhere new"}.`, "",
    ...(enquiries
      ? [
          ...(enquiries.stopped ? [`**SENDING IS STOPPED FOR TODAY: ${enquiries.stopped}.** Nothing more is sent until tomorrow. Look at this before then.`, ""] : []),
          ...(enquiries.rung !== undefined && enquiries.rung >= 3
            ? [`**Sent without asking since the last shortlist was written: ${enquiries.sent_without_asking?.total ?? 0}**` +
                `${(enquiries.sent_without_asking?.total ?? 0) > 0 ? ` (${Object.entries(enquiries.sent_without_asking?.by_kind ?? {}).map(([kind, n]) => `${kind} ${n}`).join(", ")})` : ""}. ` +
                `Test enquiries send themselves, inside the daily limit, every day between ${settings.enquiry_send_from} and ${settings.enquiry_send_until}, spread across working hours, weekday evenings and weekends. ` +
                `The full text of each, and who it went to, is in the room's list of sent enquiries (GET /v1/rooms/${enquiries.room ?? "<room>"}/enquiries).`, ""]
            : []),
          `**Test enquiries:** ${enquiries.waiting_for_approval} waiting for your approval, ${enquiries.approved_not_sent} approved and waiting to be sent, ` +
            `${(enquiries.queued_to_send ?? 0) > 0 ? `${enquiries.queued_to_send} queued to send without asking, ` : ""}` +
            `${enquiries.sent_awaiting} sent and inside their ${settings.reply_wait_hours} hours, ${enquiries.scored} scored so far.`,
          ...(tally.scored_after_test === 0 ? [`No enquiry was ${settings.reply_wait_hours} hours old on this run, so no business has a new test result today.`] : []),
          "",
        ]
      : []),
    `- Found: ${tally.found}`,
    `- Already known: ${tally.already_known}`,
    `- Refused as suppressed: ${tally.suppressed}`,
    `- Analysed: ${tally.analysed}`,
    ...(enquiries ? [
      `- Enquiries proposed this run: ${tally.enquiries_proposed.prospect} to possible clients, ${tally.enquiries_proposed.rival} to rivals of businesses that scored low`,
      `- Scored after their test this run: ${tally.scored_after_test}`,
      `- Not testable by email: ${tally.not_testable}`,
    ] : []),
    `- Filtered out: ${filtered.reduce((sum, [, n]) => sum + n, 0)}${filtered.length ? ` (${filtered.map(([reason, n]) => `${reason}: ${n}`).join(", ")})` : ""}`,
    `- Shortlisted: ${tally.shortlisted}${tally.reissued > 0 ? `, and ${tally.reissued} issued again with rivals' results` : ""}`,
    `- Searches and page reads: ${fetches.fetched} made, ${fetches.fromCache} from today's cache${(fetches.refusedAtLimit ?? 0) > 0 ? `, ${fetches.refusedAtLimit} not made at the limit` : ""}`,
    "",
    "Read this first:",
    "",
    "- **Nothing has been sent to a business except test enquiries you approved.** Each first message below is a short direct message for Salekh to send by hand or say on a call. None is an email.",
    ...(enquiries
      ? ["- The capture score is out of 100 and says how well a business captures the money coming to it. It always says how many of its parts were measured. A low score is what makes a prospect.",
         "- **An estimated leak is an estimate.** Only the price and the test result are real; the rest are assumptions shown beside it. It is for your eyes, not for the business."]
      : ["- **Not tested yet.** No enquiry has been sent to any business here, so how fast they reply cannot be judged or compared. Reply speed is not part of the score."]),
    "- **The voice for Salekh Ventures has not been supplied.** The messages are short and neutral on purpose. Edit them before sending.",
    "- Whether a business runs adverts, answers its reviews or posts on social accounts cannot be checked yet, so none of that is counted. (Google gives a rating and a count of reviews, but not whether the owner replied to them.)",
    "- Competitors are other businesses of the same kind found by the same searches for the same place. Every difference is a fact with its source.",
    ...(companiesHouseChecked ? [] : ["- **Companies House was not checked** (no key), so no business here is confirmed as a limited company."]),
    ...notes.map((note) => `- ${note}`),
    "",
    `Cost of this run (estimate from list prices): £${costs.total_gbp}${stageCosts ? `: ${stageCosts}` : ""}. ` +
      `Per business looked at: ${costs.per_business_looked_at_gbp === null ? "n/a" : `£${costs.per_business_looked_at_gbp}`}. Per business shortlisted: ${costs.per_business_shortlisted_gbp === null ? "n/a" : `£${costs.per_business_shortlisted_gbp}`}.`,
    "",
  ];
  if (cards.length === 0) lines.push("No business passed the filters in this run.", "");
  cards.forEach((p, i) => {
    const a = p.analysis;
    const kind = forType(settings, p.typeId).type;
    const b = (p.breakdown ?? {}) as Record<string, unknown>;
    const limited =
      p.isLimitedCompany === "yes" && p.companiesHouse
        ? `yes, ${p.companiesHouse.name} (${p.companiesHouse.number}), matched by ${p.companiesHouse.matched_by} (source: ${p.companiesHouse.source_url})`
        : p.isLimitedCompany === "not_checked" ? "not checked" : p.isLimitedCompany;
    const route = bestRoute(p.routes);
    const price = typeof a?.highest_value_price === "object" && a.highest_value_price !== null ? (a.highest_value_price as { amount: number; source_url: string }) : null;
    const afford = [
      typeof a?.highest_value_service === "object" ? `sells ${shown(a.highest_value_service)}${price ? `, priced at £${price.amount.toLocaleString("en-GB")} (source: ${price.source_url})` : ""}` : null,
      typeof a?.staff_count === "object" ? `${a.staff_count.count} staff shown (source: ${a.staff_count.source_url})` : null,
      typeof a?.locations === "object" && a.locations.count >= 2 ? `${a.locations.count} locations (source: ${a.locations.source_url})` : null,
    ].filter((x): x is string => x !== null);
    const t = p.test;
    const people = t ? t.test.replies.filter((r) => r.kind === "person").sort((x, y) => x.received_at.localeCompare(y.received_at)) : [];
    const firstReply = people[0];
    const quote = (text: string) => `"${text.replace(/\s+/g, " ").trim().slice(0, 240)}${text.trim().length > 240 ? "..." : ""}"`;
    const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

    lines.push(
      `## ${i + 1}. ${p.name}${p.reissue ? " (issued again: rivals' results are in)" : ""}`, "",
      "**Profile**", "",
      `- Kind of business: ${kind.name}`,
      `- Where: ${p.area ?? "not found"}${p.postcode ? `, ${p.postcode}` : ""}`,
      `- Website: ${p.website ?? "not found"}`,
      `- What they sell: ${shown(a?.what_they_sell)}`,
      `- Limited company: ${limited}`,
      ...p.signals.map((s) => `- ${s.unconfirmed ? "Possible signal, not counted" : "Signal"}: ${SIGNAL_MEANING[s.signal as Signal] ?? s.signal}. ${s.evidence || "Seen"}${s.seen_on ? `, seen ${s.seen_on}` : ""} (source: ${s.source_url})`),
      `- In a sentence: ${p.card?.why ?? ""}`,
      "",
    );
    if (t) {
      lines.push(
        `**Capture score: ${t.capture.score === null ? "not measured" : `${t.capture.score} out of 100`}, measured on ${t.capture.measured} of ${t.capture.of} parts**`, "",
        ...t.capture.parts.map((part) => `- ${part.name.replace(/_/g, " ")}: ${part.points === null ? part.note : `${part.points} of ${part.max}. ${part.note.charAt(0).toUpperCase()}${part.note.slice(1)}`}`),
        "",
        "Evidence:", "",
        `- Test enquiry sent ${when(t.test.sent_at)}, signed "${settings.enquiry_signoff}", asking: ${quote(t.enquiry.body)}`,
        ...(t.test.slot ? [`- ${sentWhen(t.test, timezone)}`] : []),
        firstReply ? `- A person replied ${when(firstReply.received_at)}: ${quote(firstReply.text)}` : `- No reply from a person within ${settings.reply_wait_hours} hours.`,
        ...(t.test.replies.some((r) => r.kind === "automatic" && (r.answered?.value === true || r.next_step?.value === true))
          ? ["- An automatic reply came back that answered the question or offered a way to book. For an enquiry sent while they were shut, that counts as something useful."] : []),
        ...(t.test.replies.some((r) => r.kind === "automatic" && r.answered?.value !== true && r.next_step?.value !== true) ? ["- An automatic acknowledgement was received. It is noted and not counted as a reply."] : []),
        ...(p.places?.opening_hours && p.places.opening_hours.periods.length > 0
          ? [`- By the opening hours Google shows for them, the enquiry was sent ${openAt(p.places.opening_hours.periods, new Date(t.test.sent_at), timezone) ? "while they were open" : "while they were closed"} (source: ${p.places.source_url}).`]
          : []),
        ...(firstReply?.answered?.quote ? [`- Answered the question, in its words: ${quote(firstReply.answered.quote)}`] : []),
        ...(firstReply?.next_step?.quote ? [`- Offered a next step, in its words: ${quote(firstReply.next_step.quote)}`] : []),
        "",
        t.leak.estimated
          ? `**Estimated leak: £${t.leak.low.toLocaleString("en-GB")} to £${t.leak.high.toLocaleString("en-GB")} a month.** This is an estimate, not a measurement. Workings: ${t.leak.workings}.`
          : `**Estimated leak: no figure.** ${t.leak.why.charAt(0).toUpperCase()}${t.leak.why.slice(1)}.`,
        "",
      );
    } else {
      const why = (p.card?.not_testable as string | undefined) ?? null;
      lines.push(`**Capture score: none.** ${why ? `Not testable by email: ${why.replace(/_/g, " ")}.` : "Not tested yet."} This card rests on fit and signals alone.`, "");
    }
    if (kind.card_note) lines.push(`**Read this result with care.** ${kind.card_note}`, "");
    lines.push(
      `**Against local competitors${t && p.card?.rivals_pending ? " (rivals not tested yet)" : ""}**`, "",
      ...(p.comparison
        ? [p.comparison.table, "", ...(p.comparison.unfavourable.length ? p.comparison.unfavourable : ["Nothing checked here goes against this business."])]
        : ["No other business of this kind in this place is on the list yet, so there is nothing to compare with. Not found."]),
      "",
      "**Why they can afford it**", "",
      `- ${afford.length ? afford.join("; ") : "not found"}`,
      "",
      "**Who to speak to, and how**", "",
      `- Who: ${p.contactName ? `${p.contactName}, ${p.contactRole} (source: ${p.contactNameSource})` : `no named person found: ask for ${kind.ask_for}`}`,
      `- Best route: ${route ? `${route.kind}, ${route.value}. Why: ${route.why}` : "none found for a direct message. Not found"}`,
      "- Every route found:",
      ...(p.routes.length ? p.routes.map((r) => `  - ${r.kind}: ${r.value} (source: ${r.source_url})${r.kind === "email" ? " (listed for completeness: Salekh does not email prospects)" : ""}`) : ["  - none found"]),
      "",
      `**The reply our agent would have sent${t ? " to that same enquiry" : " to a typical enquiry"}**`, "", p.card?.sample_reply ?? "", "",
      `**First message, to send by hand (${route ? route.kind : "or say on a call"})**`, "", p.card?.first_message ?? "", "",
      "**Call opener**", "", p.card?.call_opener ?? "", "",
      `Lead agent: ${p.card?.lead_agent ?? ""}. Fit score: ${p.score} out of 100 (signals ${b.signals}, money ${b.money}, reach ${b.reach}, limited company ${b.limited_company}). Fit says whether they can afford it and can be reached; it says nothing about how they answer.`,
      "",
    );
  });
  return lines.join("\n");
}
