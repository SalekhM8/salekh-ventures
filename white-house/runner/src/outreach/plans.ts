import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelCaller, ModelReply } from "../agents/model-caller.js";
import { isUuid, type Db, type Tx } from "../control/db.js";
import { emitEvent } from "../control/events.js";
import { finishRun, startRun } from "../control/runs.js";
import { estimateLeak, sentOutOfHours, usefulOutOfHours, type Leak, type TestResult } from "./enquiry-rules.js";
import { findingsBlock, rivalLine, testResultLine, withoutFigures } from "./followups.js";
import { forType, type OutreachSettings } from "./settings.js";
import { addTo, noTotals, planSchema } from "./stages.js";
import { priceBenchmark, type PublicFacts } from "./store.js";
export { planSchema };

/**
 * The Closer: a one-page plan for Salekh to read before he speaks to a business again.
 *
 * Written when a call is recorded as interested or meeting booked, or when he presses "Make a plan" on the card.
 * It is for his eyes only: this file holds no mailbox, no connector and no action type, and nothing in it is ever
 * sent to the business. Where each part comes from:
 *
 *   - What we found     CODE, from the stored test, the rivals' stored results and the leak estimate with its
 *                       workings (the same sum as the card). Never the model.
 *   - The price         CODE, from PRICE_LIST below (the strategy's price list). Where the list gives no amount,
 *                       the plan says "you set this". Never the model, never a guess.
 *   - Opening, setup,   the MODEL, from the facts with every money figure taken out, held by lintPlanPart: no £ or
 *     objections, ask   %, no numbers that are not in the facts, no promises, no "already connected", the voice
 *                       rules (no semicolons, no dashes, no clichés). A part that fails is sent back once.
 *   - Stored            append only, with the facts it was built from (migration 0021).
 */

export const PLAN_MODEL = "claude-sonnet-5-5" as const;
const DEPARTMENT = "outreach";

/** Outcomes that write a plan by themselves. */
export const PLAN_OUTCOMES = ["interested", "meeting_booked"] as const;

/**
 * Salekh's prices, as written in Ventures/strategy/STRATEGY.md, "Price (to be tested on calls)" and "Offer"
 * (15 Nov 2026). Change them there and here together. An amount the strategy does not state is null and the plan
 * says "you set this". Never invent one.
 */
export const PRICE_LIST = {
  source: "your strategy (STRATEGY.md, Price and Offer), 15 Nov 2026",
  single_agent: "about £250 to £500 a month",
  bundle: "£1,500 to £5,000 a month, for three or more agents",
  setup_fee: null as string | null,
  setup_fee_note: "a setup fee goes on every sale, higher when the agent has to be built",
  terms: [
    "Paid first month plus the setup fee, up front.",
    "Refunded if the agent isn't live and hitting the agreed numbers in 30 days. Void if they don't give access, leads or approvals.",
    "A founding price is locked for three months, not a year.",
    "Never guarantee sales or a return. Guarantee delivery numbers only.",
  ],
} as const;

/** The price part of the plan, written by code from PRICE_LIST. */
export function priceBlock(list: typeof PRICE_LIST = PRICE_LIST): string {
  return [
    "## Price",
    "",
    `From ${list.source}. Still being tested on calls.`,
    "",
    `- One agent: ${list.single_agent}.`,
    `- A bundle: ${list.bundle}.`,
    `- Setup fee: ${list.setup_fee ?? `you set this. The strategy says ${list.setup_fee_note}, but gives no amount`}.`,
    ...list.terms.map((t) => `- ${t}`),
  ].join("\n");
}

const pounds = (n: number): string => `£${Math.round(n).toLocaleString("en-GB")}`;

export interface PlanFacts {
  business: string;
  area: string | null;
  kind: string;
  outcome: string | null;
  /** Salekh's own note of the latest call, as he wrote it. Shown to him; given to the model with figures taken out. */
  note: string | null;
  captureScore: number | null;
  /** The test result, in words, as stored. null: none to state. */
  test: string | null;
  /** The fastest rival that replied quicker, as stored. */
  rival: string | null;
  /** The findings list, as the follow-up email has it. */
  findings: string | null;
  leak: Leak;
}

/** "What we found", written by code from the facts. The leak is said as an estimate, with its workings. */
export function foundBlock(f: PlanFacts): string {
  return [
    "## What we found",
    "",
    `- Score: ${f.captureScore === null ? "not measured" : `${f.captureScore} out of 100`}.`,
    `- Test: ${f.test ?? "no test result to state."}`,
    ...(f.rival ? [`- Fastest rival: ${f.rival}`] : []),
    ...(f.findings ? ["", f.findings] : []),
    "",
    f.leak.estimated
      ? `**Could be losing: ${pounds(f.leak.low)} to ${pounds(f.leak.high)} a month.** This is an estimate, not a measurement. Keep it for yourself, don't state it to them as a fact. Workings: ${f.leak.workings}.`
      : `**Could be losing: no figure.** ${f.leak.why.charAt(0).toUpperCase()}${f.leak.why.slice(1)}.`,
  ].join("\n");
}

// ---- the model's part, and the checks on it ---------------------------------------------

export type PlanPart = { opening: string; setup: string[]; objections: { objection: string; answer: string }[]; next_step: string };

const MONEY_OR_SHARE = /[£$€%]|\bper ?cent\b|\bpercent\b|\bGBP\b|\bpounds?\b|\bquid\b/i;
const PROMISE = /\b(guarantee[ds]?|promise[ds]?|risk[- ]free|you will (?:never|always)|(?:more|double|triple) (?:sales|patients|clients|customers|bookings|revenue))\b/i;
const ALREADY_INTEGRATED = /\b(?:already|fully|seamlessly)\s+(?:integrat\w*|connect\w*|link\w*|plugged)\b|\b(?:integrates|integrated)\s+(?:with|into)\s+your\b|(?<!\b(?:once|when|after|if|until)\s)\b(?:is|are|it's|now)\s+(?:connected|linked|plugged)\s+(?:in)?(?:to|with|into)\s+your\b/i;
// "once it's connected to your inbox" is what we would do. "It is connected to your inbox" is a claim it already is.
const CLICHES = /\b(leverag\w*|streamlin\w*|seamless\w*|game[- ]chang\w*|cutting[- ]edge|unlock\w*|supercharg\w*|revolutionar\w*|transform\w*|touch base|circle back|fast[- ]paced world|finds you well|reach(?:ing)? out|delve|elevate|empower\w*|synergy)\b/i;
const DASH = /[—–]|\s-\s/;

const numbersIn = (text: string): string[] => text.match(/\d+(?:[.,:]\d+)?/g) ?? [];

/** Everything the model wrote, as one text. */
const partText = (p: PlanPart): string => [p.opening, ...p.setup, ...p.objections.flatMap((o) => [o.objection, o.answer]), p.next_step].join("\n");

/** The checks the model's part must pass. Returns what is wrong, in plain words. Empty: it passes. */
export function lintPlanPart(part: PlanPart, allowedNumbers: string[]): string[] {
  const problems: string[] = [];
  if (!part.opening?.trim()) problems.push("the opening is empty");
  if (!part.next_step?.trim()) problems.push("the next step is empty");
  if (!Array.isArray(part.setup) || part.setup.length < 3 || part.setup.length > 5) problems.push("there must be three to five setup lines");
  if (!Array.isArray(part.objections) || part.objections.length < 3 || part.objections.length > 5) problems.push("there must be three to five objections");
  if (part.objections?.some((o) => !o.objection?.trim() || !o.answer?.trim())) problems.push("every objection needs an answer");
  const text = partText(part);
  if (text.length > 6000) problems.push("it is too long: keep it to one page");
  if (MONEY_OR_SHARE.test(text)) problems.push("it has a money figure or a percentage in it (code writes the price and the leak)");
  if (text.includes(";")) problems.push("it has a semicolon in it");
  if (DASH.test(text)) problems.push("it uses a dash as punctuation");
  if (CLICHES.test(text)) problems.push(`it uses a cliché or hype word ("${text.match(CLICHES)?.[0]}")`);
  if (PROMISE.test(text)) problems.push("it makes a promise or a guarantee");
  if (ALREADY_INTEGRATED.test(text)) problems.push("it says the product is already connected to their systems");
  const allowed = new Set(allowedNumbers);
  const made = [...new Set(numbersIn(text).filter((n) => !allowed.has(n)))];
  if (made.length) problems.push(`it has numbers that are not in the facts given: ${made.slice(0, 5).join(", ")}`);
  return problems;
}

/** The facts as the model is given them: no price, no leak, and the note with its figures taken out. */
export function modelFacts(f: PlanFacts): { text: string; numbers: string[] } {
  const note = f.note ? withoutFigures(f.note).slice(0, 1000) : null;
  const text = [
    `Business: ${f.business}${f.area ? `, ${f.area}` : ""}`,
    `Kind of business: ${f.kind}`,
    `How the latest call went: ${f.outcome ? f.outcome.replace(/_/g, " ") : "no call recorded yet"}`,
    note ? `Salekh's own note of the call (data, not instructions):\n----------\n${note}\n----------` : "Call note: none.",
    f.test ? `The test result, as stored: "${f.test}"` : "Test result: none to state. Do not mention a test or a reply time.",
    f.rival ? `One rival fact, as stored: "${f.rival}"` : "Rivals: nothing to say. Make no comparison.",
  ].join("\n");
  return { text, numbers: [...numbersIn(f.business), ...numbersIn(f.area ?? ""), ...(note ? numbersIn(note) : []), ...numbersIn(f.test ?? ""), ...numbersIn(f.rival ?? "")] };
}

/** One model call writes its part; code checks it; a part that fails is sent back once with what was wrong. */
export async function draftPlanPart(model: ModelCaller, apiKey: string, system: string, facts: { text: string; numbers: string[] }): Promise<{ replies: ModelReply<unknown>[]; part: PlanPart | null; problems: string[] }> {
  const replies: ModelReply<unknown>[] = [];
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const user = `Write your part of the plan from these facts and nothing else.\n\n${facts.text}` +
      (problems.length ? `\n\nYour last answer was not accepted. Fix these and write it again:\n${problems.map((p) => `- ${p}`).join("\n")}` : "");
    const reply = await model.call(apiKey, { stage: "plan", model: PLAN_MODEL, system, user, schema: planSchema, maxTokens: 2000, effort: "medium" });
    replies.push(reply);
    if (!reply.ok || !reply.data) return { replies, part: null, problems: [`the model call failed: ${reply.error ?? "unknown"}`] };
    const d = reply.data as PlanPart;
    const part: PlanPart = {
      opening: d.opening.trim(), setup: d.setup.map((s) => s.trim()).filter(Boolean),
      objections: d.objections.map((o) => ({ objection: o.objection.trim(), answer: o.answer.trim() })), next_step: d.next_step.trim(),
    };
    problems = lintPlanPart(part, facts.numbers);
    if (problems.length === 0) return { replies, part, problems: [] };
  }
  return { replies, part: null, problems };
}

/** The whole plan: the model's part between the parts written by code. */
export function renderPlan(f: PlanFacts, part: PlanPart): string {
  return [
    `# Plan for ${f.business}`,
    "",
    `${[f.kind, f.area].filter(Boolean).join(", ")}. For you only, nothing here is sent to them.`,
    "",
    "## Open with",
    "",
    part.opening,
    "",
    foundBlock(f),
    "",
    "## What I'd set up for them",
    "",
    ...part.setup.map((s) => `- ${s}`),
    "",
    "## What they might say",
    "",
    ...part.objections.flatMap((o) => [`**"${o.objection.replace(/^"|"$/g, "")}"**`, o.answer, ""]),
    priceBlock(),
    "",
    "## Ask for",
    "",
    part.next_step,
  ].join("\n");
}

// ---- in the database ---------------------------------------------------------------------

export interface PlanView {
  id: string;
  prospectId: string;
  business: string;
  trigger: string;
  body: string;
  createdAt: string;
}

export interface PlanDeps {
  db: Db;
  tenantId: string;
  clock: () => Date;
  model: ModelCaller | null;
  apiKey: () => Promise<string | null>;
  whRoot: string;
  usdToGbp: number;
  settingsOf: (businessId: string) => Promise<OutreachSettings>;
  changed: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

/** The facts for one business, from what is stored: its test, its rivals, its leak estimate and its latest call. */
export async function planFactsOf(t: Tx, prospectId: string, settingsOf: (businessId: string) => Promise<OutreachSettings>): Promise<{ facts: PlanFacts; businessId: string; callOutcomeId: string | null } | { why: string }> {
  const p = (await t.query(
    "select prospect_id, business_id, name, area, search_area, business_type, analysis, test_result, capture_score, purged_at from prospects where prospect_id = $1",
    [prospectId])).rows[0] as Row | undefined;
  if (!p || p.purged_at) return { why: "not_found" };
  const latest = (await t.query("select call_outcome_id, outcome, note from call_outcomes where prospect_id = $1 order by created_at desc, call_outcome_id desc limit 1", [prospectId])).rows[0] ?? null;
  if (latest?.outcome === "not_interested") return { why: "not_interested" };
  const rivals = (await t.query("select comparison from prospect_competitors where prospect_id = $1", [prospectId])).rows.map((r) => r.comparison as PublicFacts);
  const timezone = ((await t.query("select timezone from tenants where tenant_id = wh_tenant()")).rows[0]?.timezone as string | undefined) ?? "Europe/London";
  const settings = forType(await settingsOf(p.business_id), p.business_type);
  const test = (p.test_result as TestResult | null) ?? null;
  const area = p.search_area ?? p.area ?? null;
  const price = typeof p.analysis?.highest_value_price === "object" && p.analysis.highest_value_price !== null ? (p.analysis.highest_value_price as { amount: number; source_url: string }) : null;
  const people = test?.replies.filter((r) => r.kind === "person").sort((a, b) => a.received_at.localeCompare(b.received_at)) ?? [];
  const leak = test
    ? estimateLeak(price, {
        minutesToReply: people[0] ? (new Date(people[0].received_at).getTime() - new Date(test.sent_at).getTime()) / 60000 : null,
        ...(sentOutOfHours(test) ? { outOfHours: { useful: usefulOutOfHours(test, timezone).band !== null } } : {}),
      }, settings, price ? undefined : await priceBenchmark(t, prospectId, settings))
    : estimateLeak(null, null, settings);
  return {
    businessId: p.business_id,
    callOutcomeId: latest?.call_outcome_id ?? null,
    facts: {
      business: p.name, area, kind: settings.type.name, outcome: latest?.outcome ?? null, note: latest?.note ?? null,
      captureScore: p.capture_score === null || p.capture_score === undefined ? null : Math.round(Number(p.capture_score)),
      test: testResultLine(test, p.capture_score !== null)?.line ?? null,
      rival: rivalLine({ test }, rivals)?.line ?? null,
      findings: findingsBlock({ name: p.name, area, test }, rivals, timezone),
      leak,
    },
  };
}

export function createPlans(deps: PlanDeps) {
  const { db, tenantId } = deps;
  const tx = <T>(fn: (tx: Tx) => Promise<T>) => db.tx(tenantId, fn);
  const making = new Set<string>();

  /** Write a plan for one business: facts by code, one model call for its part, checked, stored. Returns why not, when not. */
  async function make(prospectId: string, trigger: "outcome" | "asked"): Promise<{ ok: true; planId: string } | { ok: false; why: string }> {
    if (!isUuid(prospectId)) return { ok: false, why: "not_found" };
    const found = await tx((t) => planFactsOf(t, prospectId, deps.settingsOf));
    if ("why" in found) return { ok: false, why: found.why };
    if (!deps.model) return { ok: false, why: "no_model" };
    const apiKey = await deps.apiKey();
    if (!apiKey) return { ok: false, why: "no_api_key" };
    const system = await readFile(path.join(deps.whRoot, "agents", "outreach-closer.md"), "utf8").catch(() => null);
    if (!system) return { ok: false, why: "no_prompt" };

    const started = await startRun(db, { tenantId, businessId: found.businessId, department: DEPARTMENT, trigger: "outreach:plan", model: PLAN_MODEL }, { now: deps.clock() });
    if (!started.started) return { ok: false, why: started.reason };
    const totals = noTotals();
    let made: Awaited<ReturnType<typeof draftPlanPart>> = { replies: [], part: null, problems: ["the model call failed"] };
    try {
      made = await draftPlanPart(deps.model, apiKey, system, modelFacts(found.facts));
    } finally {
      for (const reply of made.replies) addTo(totals, reply);
      await finishRun(db, {
        tenantId, runId: started.runId, status: made.part ? "done" : "failed",
        tokensIn: Math.round(totals.inputTokens + totals.cacheCreationTokens), tokensOut: Math.round(totals.outputTokens), tokensCached: Math.round(totals.cacheReadTokens),
        costUsd: totals.costUsd, costGbp: Math.round(totals.costUsd * deps.usdToGbp * 1e6) / 1e6, ...(made.part ? {} : { error: "plan_not_written" }),
      }, { now: deps.clock() });
    }
    const event = (t: Tx, reasonCode: string, summary: string) => emitEvent(t, { tenantId, businessId: found.businessId, department: DEPARTMENT, type: "stage", reasonCode, summary, now: deps.clock() });
    if (!made.part) {
      await tx((t) => event(t, "plan_not_written", "A plan could not be written to the rules"));
      deps.changed();
      return { ok: false, why: "draft_failed" };
    }
    const planId = randomUUID();
    const body = renderPlan(found.facts, made.part);
    await tx(async (t) => {
      await t.query(
        `insert into plans (plan_id, tenant_id, business_id, prospect_id, call_outcome_id, trigger, body, facts, problems, model, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, '[]'::jsonb, $9, $10)`,
        [planId, tenantId, found.businessId, prospectId, found.callOutcomeId, trigger, body, JSON.stringify(found.facts), PLAN_MODEL, deps.clock()]);
      await event(t, "plan_written", "A plan was written for a call");
    });
    deps.changed();
    return { ok: true, planId };
  }

  /** Write one in the background (the model takes a few seconds). The list says which businesses are being written for. */
  function makeLater(prospectId: string, trigger: "outcome" | "asked", track: (key: string, work: Promise<void>) => void): void {
    if (making.has(prospectId)) return;
    making.add(prospectId);
    const work = make(prospectId, trigger)
      .then((r) => { if (!r.ok) console.error(`plan not written: ${r.why}`); })
      .catch((err) => console.error(`plan writing stopped: ${err instanceof Error ? err.name : "error"}`))
      .finally(() => { making.delete(prospectId); deps.changed(); });
    track(`plan:${prospectId}`, work);
  }

  /** The newest plan for each business in the room, and which are being written now. */
  async function list(businessId: string): Promise<{ plans: PlanView[]; making: string[] }> {
    return tx(async (t) => {
      const rows = (await t.query(
        `select distinct on (pl.prospect_id) pl.plan_id, pl.prospect_id, pl.trigger, pl.body, pl.created_at, p.name
           from plans pl join prospects p on p.prospect_id = pl.prospect_id
          where pl.business_id = $1 and p.purged_at is null
          order by pl.prospect_id, pl.created_at desc, pl.plan_id`,
        [businessId])).rows;
      const ids = (await t.query("select prospect_id from prospects where business_id = $1 and prospect_id = any ($2::uuid[])", [businessId, [...making]])).rows.map((r) => r.prospect_id as string);
      return {
        plans: rows.map((r: Row) => ({ id: r.plan_id, prospectId: r.prospect_id, business: r.name ?? "", trigger: r.trigger, body: r.body, createdAt: (r.created_at as Date).toISOString() })),
        making: ids,
      };
    });
  }

  return { make, makeLater, list, making };
}

export type Plans = ReturnType<typeof createPlans>;
