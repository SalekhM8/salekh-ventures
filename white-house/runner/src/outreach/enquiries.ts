import { randomUUID } from "node:crypto";
import type { ModelCaller } from "../agents/model-caller.js";
import { readCurrent } from "../control/config.js";
import type { Connector, ConnectorCall, ConnectorResult, ReadBackResult } from "../control/connectors/connector.js";
import type { InboundMail, Mailbox } from "../control/connectors/mailbox.js";
import { isUniqueViolation, lock, type Db, type Tx } from "../control/db.js";
import { ControlError } from "../control/errors.js";
import type { Gateway } from "../control/gateway.js";
import { finishRun, startRun, tenantDay } from "../control/runs.js";
import { asksNotToBeContacted, captureFor, estimateLeak, isAutomatic, type Capture, type EnquiryDraft, type Leak, type StoredReply, type TestResult } from "./enquiry-rules.js";
export type { StoredReply, TestResult } from "./enquiry-rules.js";
import { companyNumberKey, domainKey } from "./normalise.js";
import { applyFilters, isGroup, scoreProspect, type Scorable } from "./score.js";
import { forType, type OutreachSettings } from "./settings.js";
import { addTo, noTotals, readReply, type StageTotals } from "./stages.js";
import type { ProspectRow, ProspectScope } from "./store.js";

/**
 * The test enquiry (mystery shop) in the database and on the wire.
 *
 * Salekh's rules and where each is held:
 *   - email only                          the one sending action type sends email and nothing else exists
 *   - one enquiry per business, ever      unique indexes on `enquiries`; the sender claims a row before it sends
 *   - nothing sent without his yes        the gateway, at rung 2: payload hash, expiry, single use
 *   - suppressed businesses are refused   checked when proposed and again in the moment before sending
 *   - no follow up from the test mailbox  there is no code that replies, and no second enquiry can exist
 *   - replies are read narrowly           see connectors/mailbox.ts
 */

export const ENQUIRY_ACTION = "enquiry.send_email";
export const ENQUIRY_CAP = "enquiries_per_day";
const DEPARTMENT = "outreach";

const EMAIL = /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** The address a business publishes on its own site for enquiries, or null. One on its own domain is preferred. */
export function emailFor(p: Pick<ProspectRow, "routes" | "website">): string | null {
  const emails = p.routes.filter((r) => r.kind === "email" && EMAIL.test(r.value)).map((r) => r.value.toLowerCase());
  const own = domainKey(p.website);
  return emails.find((e) => own !== null && e.endsWith(`@${own}`)) ?? emails[0] ?? null;
}

/** Why a business cannot be sent a test enquiry, or null when it can. */
export function notTestableReason(p: ProspectRow, scorable: Scorable, settings: OutreachSettings): string | null {
  const own = forType(settings, p.typeId);
  if (isGroup(scorable, own)) return "part_of_group";
  if (!own.type.email_test) return "email_is_not_a_fair_test_of_this_kind_of_business";
  if (!emailFor(p)) return "no_email_published";
  return null;
}

async function suppressedFor(tx: Tx, businessId: string, keys: { domain: string | null; email: string | null; company: string | null }): Promise<boolean> {
  const found = await tx.query(
    `select 1 from suppressions
      where (business_id is null or business_id = $1)
        and ((kind = 'domain' and value_key = $2) or (kind = 'email' and value_key = $3) or (kind = 'company_number' and value_key = $4))
      limit 1`,
    [businessId, keys.domain, keys.email, keys.company],
  );
  return found.rows.length > 0;
}

export type ProposeResult =
  | { proposed: true; enquiryId: string; approvalId: string | null }
  | { proposed: false; why: "already_enquired" | "suppressed" | "refused" | "not_sending"; detail?: string };

/**
 * Record one drafted enquiry and put it to the gateway. The row in `enquiries` goes in first: if the business
 * or the address already has one, the database refuses it and nothing reaches the gateway.
 */
export async function proposeEnquiry(
  db: Db, gateway: Gateway, scope: ProspectScope, prospect: ProspectRow, draft: EnquiryDraft, now: Date, purpose: "prospect" | "rival" = "prospect",
): Promise<ProposeResult> {
  const to = emailFor(prospect);
  if (!to) return { proposed: false, why: "refused", detail: "no_email_published" };
  const enquiryId = randomUUID();
  try {
    const blocked = await db.tx(scope.tenantId, async (tx) => {
      await lock(tx, "enquiries", scope.tenantId);
      const row = (await tx.query("select domain_key, companies_house_number from prospects where prospect_id = $1 and business_id = $2", [prospect.prospectId, scope.businessId])).rows[0];
      if (!row) return "refused";
      if (await suppressedFor(tx, scope.businessId, { domain: row.domain_key, email: to, company: companyNumberKey(row.companies_house_number) })) return "suppressed";
      await tx.query(
        `insert into enquiries (enquiry_id, tenant_id, business_id, prospect_id, to_address, to_address_key, subject, body, status, proposed_at, purpose)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'proposed', $9, $10)`,
        [enquiryId, scope.tenantId, scope.businessId, prospect.prospectId, to, to, draft.subject, draft.body, now, purpose],
      );
      return null;
    });
    if (blocked) return { proposed: false, why: blocked === "suppressed" ? "suppressed" : "refused" };
  } catch (err) {
    if (isUniqueViolation(err)) return { proposed: false, why: "already_enquired" };
    throw err;
  }
  const result = await gateway.submit({
    tenantId: scope.tenantId, businessId: scope.businessId, department: DEPARTMENT, ...(scope.runId ? { runId: scope.runId } : {}),
    actionType: ENQUIRY_ACTION, actionKey: `enquiry:${enquiryId}`,
    payload: { enquiry_id: enquiryId, prospect_id: prospect.prospectId, to, subject: draft.subject, body: draft.body },
    // A fixed line: the reasoning is shown in the house, which must carry no name or address.
    reason: "Test enquiry by email",
  });
  const setStatus = (status: string, approvalId: string | null = null) =>
    db.tx(scope.tenantId, (tx) => tx.query("update enquiries set status = $2, approval_id = coalesce($3, approval_id) where enquiry_id = $1 and status = 'proposed'", [enquiryId, status, approvalId]));
  if (result.outcome === "waiting_approval") {
    await setStatus("proposed", result.approvalId);
    return { proposed: true, enquiryId, approvalId: result.approvalId };
  }
  // At rung 3 the gateway has already sent it, and the connector has marked the row.
  if (result.outcome === "executed" || result.outcome === "execution_failed") return { proposed: true, enquiryId, approvalId: null };
  // Refused (the day's allowance, the kill switch) or only recommended (rung 1): it will not be sent. The row
  // is closed as expired, which leaves room to propose to this business again another day.
  await setStatus("expired");
  return { proposed: false, why: result.outcome === "refused" ? "refused" : "not_sending", detail: result.outcome === "refused" ? result.reason : "rung_1" };
}

/**
 * The mail connector the gateway holds. It sends exactly the stored enquiry, once. In the moment before sending
 * it claims the row (so a second attempt finds nothing to send) and checks the suppression list again.
 */
export function createMailConnector(options: { db: Db; mailbox: Mailbox | null; now?: () => Date }): Connector {
  const clock = options.now ?? (() => new Date());
  return {
    async execute(call: ConnectorCall): Promise<ConnectorResult> {
      if (!options.mailbox) throw new ControlError("mail_not_configured", "the test mailbox is not configured");
      const payload = call.payload as { enquiry_id: string; prospect_id: string; to: string; subject: string; body: string };
      const claimed = await options.db.tx(call.tenantId, async (tx) => {
        const row = (await tx.query(
          `select e.status, e.to_address, e.subject, e.body, p.domain_key, p.companies_house_number
             from enquiries e join prospects p on p.prospect_id = e.prospect_id
            where e.enquiry_id = $1 and e.prospect_id = $2 and e.business_id = $3 for update of e`,
          [payload.enquiry_id, payload.prospect_id, call.businessId],
        )).rows[0];
        if (!row) return "no_such_enquiry";
        if (row.status !== "proposed" && row.status !== "approved") return "already_handled";
        // What is sent is what is stored, and what was approved is the same thing.
        if (row.to_address !== payload.to || row.subject !== payload.subject || row.body !== payload.body) return "enquiry_changed";
        if (await suppressedFor(tx, call.businessId, { domain: row.domain_key, email: payload.to.toLowerCase(), company: companyNumberKey(row.companies_house_number) })) {
          await tx.query("update enquiries set status = 'rejected', decided_at = $2 where enquiry_id = $1", [payload.enquiry_id, clock()]);
          return "suppressed";
        }
        await tx.query("update enquiries set status = 'sending' where enquiry_id = $1", [payload.enquiry_id]);
        return null;
      });
      // A fixed code only: an error's own words could carry the address.
      if (claimed) throw new ControlError(claimed, `the enquiry was not sent: ${claimed}`);
      let messageId: string;
      try {
        ({ messageId } = await options.mailbox.send({ to: payload.to, subject: payload.subject, text: payload.body }));
      } catch {
        // It was claimed, so it is never tried again: it may have gone.
        await options.db.tx(call.tenantId, (tx) => tx.query("update enquiries set status = 'failed' where enquiry_id = $1", [payload.enquiry_id]));
        throw new ControlError("mail_send_failed", "the mail server did not accept the message");
      }
      const sentAt = clock();
      await options.db.tx(call.tenantId, async (tx) => {
        await tx.query("update enquiries set status = 'sent', message_id = $2, sent_at = $3 where enquiry_id = $1", [payload.enquiry_id, messageId, sentAt]);
        await tx.query(
          "update prospects set test_result = $2::jsonb where prospect_id = $1",
          [payload.prospect_id, JSON.stringify({ enquiry_id: payload.enquiry_id, sent_at: sentAt.toISOString(), replies: [] })],
        );
      });
      return { reference: messageId, output: { enquiry_id: payload.enquiry_id } };
    },
    async readBack(_call: ConnectorCall, result: ConnectorResult): Promise<ReadBackResult> {
      if (!options.mailbox) return { verified: false };
      return { verified: await options.mailbox.sentContains(result.reference) };
    },
  };
}

/** Bring each enquiry's status into line with the answer its approval was given. */
export async function syncDecisions(db: Db, tenantId: string, now: Date): Promise<void> {
  await db.tx(tenantId, async (tx) => {
    await tx.query(
      `update enquiries e
          set status = case a.status when 'approved' then 'approved' when 'rejected' then 'rejected' when 'voided' then 'rejected' else 'expired' end,
              decided_at = coalesce(a.decided_at, $1)
         from approvals a
        where a.approval_id = e.approval_id and e.status = 'proposed'
          and (a.status in ('approved', 'rejected', 'voided', 'expired') or a.expires_at <= $1)`,
      [now],
    );
    // An approved enquiry whose yes ran out before it could be sent will not be sent.
    await tx.query(
      `update enquiries e set status = 'expired'
         from approvals a where a.approval_id = e.approval_id and e.status = 'approved' and a.consumed_at is null and a.expires_at <= $1`,
      [now],
    );
    // A business whose enquiry Salekh turned down is not asked about again: it is judged without a test.
    await tx.query(
      `update prospects p set not_testable_reason = 'enquiry_rejected'
         from enquiries e where e.prospect_id = p.prospect_id and e.status = 'rejected' and p.not_testable_reason is null
          and not exists (select 1 from enquiries x where x.prospect_id = p.prospect_id and x.status not in ('rejected', 'expired'))`,
    );
  });
}

/** How many more enquiries may be proposed today: the day's allowance less those already proposed, approved or sent today. */
export async function allowanceLeft(db: Db, scope: ProspectScope, now: Date): Promise<number> {
  return db.tx(scope.tenantId, async (tx) => {
    const cap = await readCurrent(tx, { businessId: scope.businessId, kind: "cap", key: ENQUIRY_CAP });
    const limit = Number(cap?.value?.limit);
    if (!Number.isFinite(limit)) return 0; // no allowance set: none may be sent
    const day = await tenantDay(tx, now);
    const used = await tx.query(
      `select count(*)::int as n from enquiries e join tenants t on t.tenant_id = e.tenant_id
        where e.business_id = $1 and e.status in ('proposed', 'approved', 'sending', 'sent', 'failed')
          and (coalesce(e.sent_at, e.proposed_at) at time zone t.timezone)::date = $2::date`,
      [scope.businessId, day],
    );
    return Math.max(0, Math.floor(limit) - (used.rows[0].n as number));
  });
}

// ---- replies ---------------------------------------------------------------

export interface ReplyContext {
  db: Db;
  tenantId: string;
  mailbox: Mailbox | null;
  model: ModelCaller | null;
  apiKey: string | null;
  /** The prompt for reading a reply. */
  system: string;
  usdToGbp: number;
  now: () => Date;
  /** Days after sending during which a business's replies are still looked for. */
  windowDays?: number;
}

export interface ReplyCounts {
  enquiriesChecked: number;
  person: number;
  automatic: number;
  optedOut: number;
}

/**
 * Look in the test mailbox for replies to the enquiries this system sent, and store them on the business they
 * came from. Plain code, except that one cheap model call reads a reply whose headers do not say whether a
 * machine sent it. Nothing is ever sent back.
 */
export async function collectReplies(ctx: ReplyContext): Promise<ReplyCounts> {
  const counts: ReplyCounts = { enquiriesChecked: 0, person: 0, automatic: 0, optedOut: 0 };
  if (!ctx.mailbox) return counts;
  const now = ctx.now();
  const since = new Date(now.getTime() - (ctx.windowDays ?? 3) * 24 * 60 * 60 * 1000);
  const open = await ctx.db.tx(ctx.tenantId, async (tx) =>
    (await tx.query(
      `select e.enquiry_id, e.business_id, e.prospect_id, e.to_address_key, e.message_id, e.sent_at, e.subject, e.body, p.domain_key, p.test_result
         from enquiries e join prospects p on p.prospect_id = e.prospect_id
        where e.status = 'sent' and e.sent_at > $1 and p.purged_at is null
        order by e.sent_at`,
      [since],
    )).rows);
  const totals: Record<string, StageTotals> = {};
  const runs: Record<string, string | null> = {};

  for (const e of open) {
    counts.enquiriesChecked += 1;
    const addressDomain = (e.to_address_key as string).split("@")[1] ?? "";
    // The sender's domain counts only when it is the business's own. A shared mail provider's domain never does.
    const ownDomain = e.domain_key !== null && addressDomain === e.domain_key ? (e.domain_key as string) : null;
    let found: InboundMail[];
    try {
      found = await ctx.mailbox.findReplies({ messageId: e.message_id, address: e.to_address_key, ownDomain, since: e.sent_at });
    } catch {
      continue; // the mailbox could not be read just now: try again on the next round
    }
    const result: TestResult = (e.test_result as TestResult | null) ?? { enquiry_id: e.enquiry_id, sent_at: (e.sent_at as Date).toISOString(), replies: [] };
    const known = new Set(result.replies.map((r) => r.message_id));
    const fresh = found.filter((m) => !known.has(m.messageId) && m.receivedAt.getTime() >= (e.sent_at as Date).getTime()).sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    if (fresh.length === 0) continue;

    for (const mail of fresh) {
      const stored: StoredReply = { message_id: mail.messageId, received_at: mail.receivedAt.toISOString(), kind: "unclear", matched_by: mail.matchedBy, text: mail.text.slice(0, 6000) };
      const machine = isAutomatic(mail.headers, mail.subject);
      let optOut = asksNotToBeContacted(mail.text);
      if (machine === true) stored.kind = "automatic";
      else if (ctx.model && ctx.apiKey) {
        // The headers do not settle it: one cheap call reads the reply. Its cost goes on a run for this room.
        const business = e.business_id as string;
        if (!(business in runs)) {
          const started = await startRun(ctx.db, { tenantId: ctx.tenantId, businessId: business, department: DEPARTMENT, trigger: "outreach:replies", model: "claude-haiku-5-5" }, { now: ctx.now() });
          runs[business] = started.started ? started.runId : null;
          totals[business] = noTotals();
        }
        if (runs[business]) {
          const { reply, reading } = await readReply(ctx.model, ctx.apiKey, ctx.system, `${e.subject}\n\n${e.body}`, mail.text);
          addTo(totals[business] as StageTotals, reply);
          if (reading) {
            stored.kind = reading.fromAPerson ? "person" : "automatic";
            stored.answered = reading.answered;
            stored.next_step = reading.nextStep;
            optOut = optOut || reading.asksNotToBeContacted;
          }
        }
      }
      if (stored.kind === "person") counts.person += 1;
      if (stored.kind === "automatic") counts.automatic += 1;
      result.replies.push(stored);
      if (optOut && !result.opted_out) {
        result.opted_out = true;
        counts.optedOut += 1;
        // Honoured at once and for good: the address, and the domain when it is the business's own.
        await ctx.db.tx(ctx.tenantId, async (tx) => {
          const add = (kind: string, key: string) =>
            tx.query(
              `insert into suppressions (tenant_id, business_id, kind, value_key, reason, source) values ($1, null, $2, $3, 'asked not to be contacted, in a reply to a test enquiry', 'opt_out')
               on conflict (tenant_id, kind, value_key) do nothing`,
              [ctx.tenantId, kind, key],
            );
          await add("email", e.to_address_key);
          if (mail.from && mail.from !== e.to_address_key) await add("email", mail.from);
          if (ownDomain) await add("domain", ownDomain);
        });
      }
    }
    await ctx.db.tx(ctx.tenantId, (tx) => tx.query("update prospects set test_result = $2::jsonb where prospect_id = $1", [e.prospect_id, JSON.stringify(result)]));
  }
  for (const [business, runId] of Object.entries(runs)) {
    if (!runId) continue;
    const t = totals[business] as StageTotals;
    await finishRun(ctx.db, {
      tenantId: ctx.tenantId, runId, status: "done", tokensIn: Math.round(t.inputTokens + t.cacheCreationTokens), tokensOut: Math.round(t.outputTokens),
      tokensCached: Math.round(t.cacheReadTokens), costUsd: t.costUsd, costGbp: Math.round(t.costUsd * ctx.usdToGbp * 1e6) / 1e6,
    }, { now: ctx.now() });
  }
  return counts;
}

// ---- the capture score -----------------------------------------------------

export interface TestedProspect extends ProspectRow {
  test: TestResult;
  capture: Capture;
  leak: Leak;
  enquiry: { subject: string; body: string; to: string };
}

/**
 * Score every business whose enquiry was sent at least the waiting time ago and that has not been scored yet.
 * A business is a prospect when its capture score is at or below the threshold AND it passes the fit filters
 * (a signal is not asked for: the test is the signal). One that replied fast and well is not a prospect; it is
 * kept, with its result, as the comparison for others in its place.
 */
export async function scoreTested(
  db: Db, scope: ProspectScope, settings: OutreachSettings, now: Date, toRow: (r: any) => ProspectRow, columns: string,
): Promise<{ scored: number; filtered: Record<string, number>; passed: TestedProspect[] }> {
  const due = new Date(now.getTime() - settings.reply_wait_hours * 60 * 60 * 1000);
  return db.tx(scope.tenantId, async (tx) => {
    await lock(tx, "prospects", scope.tenantId, scope.businessId);
    const timezone = (await tx.query("select timezone from tenants where tenant_id = wh_tenant()")).rows[0].timezone as string;
    const rows = await tx.query(
      // A business tested as somebody's rival is judged in its own right too: it was sent the one enquiry it will ever get.
      // Stage 'tested' with no card: scored on an earlier run and held over, so it is offered again without being scored twice.
      `select ${columns.split(", ").map((c) => `p.${c}`).join(", ")}, p.stage, p.test_result, e.subject as enquiry_subject, e.body as enquiry_body, e.to_address as enquiry_to
         from prospects p join enquiries e on e.prospect_id = p.prospect_id and e.status = 'sent'
        where p.business_id = $1 and e.sent_at <= $2 and p.purged_at is null
          and ((p.stage = 'analysed' and p.capture_score is null) or p.stage = 'tested')
        order by e.sent_at, p.prospect_id`,
      [scope.businessId, due],
    );
    // A rival that is not itself a candidate (it failed the fit filters earlier) still gets its score recorded, for the comparison.
    const others = await tx.query(
      `select p.prospect_id, p.contact_routes, p.test_result from prospects p join enquiries e on e.prospect_id = p.prospect_id and e.status = 'sent'
        where p.business_id = $1 and e.sent_at <= $2 and p.purged_at is null and p.capture_score is null and p.stage not in ('analysed', 'tested') and p.test_result is not null`,
      [scope.businessId, due],
    );
    for (const r of others.rows) {
      const capture = captureFor(r.test_result as TestResult, [...new Set((r.contact_routes as { kind: string }[]).map((x) => x.kind))], settings, timezone);
      await tx.query("update prospects set capture_score = $2, capture_breakdown = $3::jsonb where prospect_id = $1", [r.prospect_id, capture.score, JSON.stringify(capture)]);
    }
    let newlyScored = 0;
    const filtered: Record<string, number> = {};
    const passed: TestedProspect[] = [];
    for (const raw of rows.rows) {
      const p = toRow(raw);
      const own = forType(settings, p.typeId);
      // After the test: a limited company is required, a named person is not, and no other signal is asked for.
      const untested = { ...own, filters: { ...own.filters, require_signal: false, require_named_contact: false } };
      const test = raw.test_result as TestResult;
      const capture = captureFor(test, [...new Set(p.routes.map((r) => r.kind))], own, timezone);
      const scorable: Scorable = {
        name: p.name, website: p.website, companyName: p.companiesHouse?.name ?? null,
        signals: p.signals.filter((s) => s.unconfirmed !== true).map((s) => s.signal),
        analysis: p.analysis, contactName: p.contactName, routes: p.routes, isLimitedCompany: p.isLimitedCompany,
      };
      const fit = scoreProspect(scorable, own);
      const event = (stage: string, reason: string) =>
        tx.query("insert into prospect_events (tenant_id, business_id, prospect_id, stage, reason, run_id, created_at) values ($1, $2, $3, $4, $5, $6, $7)",
          [scope.tenantId, scope.businessId, p.prospectId, stage, reason, scope.runId, now]);
      if (raw.stage === "analysed") {
        newlyScored += 1;
        await tx.query(
          "update prospects set capture_score = $2, capture_breakdown = $3::jsonb, score = $4, score_breakdown = $5::jsonb, stage = 'tested' where prospect_id = $1",
          [p.prospectId, capture.score, JSON.stringify(capture), fit.score, JSON.stringify(fit.breakdown)],
        );
        await event("tested", "scored");
      }
      const people = test.replies.filter((r) => r.kind === "person").sort((a, b) => a.received_at.localeCompare(b.received_at));
      const minutesToReply = people[0] ? (new Date(people[0].received_at).getTime() - new Date(test.sent_at).getTime()) / 60000 : null;
      const price = typeof p.analysis?.highest_value_price === "object" && p.analysis.highest_value_price !== null ? (p.analysis.highest_value_price as { amount: number; source_url: string }) : null;
      const leak = estimateLeak(price, { minutesToReply }, own);
      const verdict = test.opted_out ? { keep: false as const, reason: "opted_out" } : applyFilters(scorable, untested);
      const reason = !verdict.keep ? verdict.reason
        : capture.score !== null && capture.score > settings.capture_threshold ? "captures_well"
        // Only when an estimate exists. With none, the business is judged on capture and fit alone.
        : leak.estimated && leak.high < settings.min_estimated_leak ? "estimated_leak_below_threshold"
        : null;
      if (reason) {
        // Kept on the list with its result: it is the comparison for its neighbours. Details are purged after 90 days like any other.
        await tx.query("update prospects set stage = 'filtered_out', filter_reason = $2, filtered_out_at = $3, purge_after = $4 where prospect_id = $1",
          [p.prospectId, reason, now, new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)]);
        await event("filtered_out", reason);
        filtered[reason] = (filtered[reason] ?? 0) + 1;
        continue;
      }
      passed.push({ ...p, score: fit.score, breakdown: { ...fit.breakdown }, test, capture, leak, enquiry: { subject: raw.enquiry_subject, body: raw.enquiry_body, to: raw.enquiry_to } });
    }
    passed.sort((a, b) => (a.capture.score ?? 0) - (b.capture.score ?? 0) || (b.score ?? 0) - (a.score ?? 0));
    return { scored: newlyScored + others.rows.length, filtered, passed };
  });
}

/** Where the day's enquiries have got to, for the shortlist's opening lines. */
export async function enquiryCounts(db: Db, scope: ProspectScope, settings: OutreachSettings, now: Date): Promise<{ waiting_for_approval: number; approved_not_sent: number; sent_awaiting: number; scored: number }> {
  const due = new Date(now.getTime() - settings.reply_wait_hours * 60 * 60 * 1000);
  return db.tx(scope.tenantId, async (tx) => {
    const r = (await tx.query(
      `select count(*) filter (where e.status = 'proposed')::int as waiting,
              count(*) filter (where e.status = 'approved')::int as approved,
              count(*) filter (where e.status = 'sent' and e.sent_at > $2)::int as awaiting,
              count(*) filter (where e.status = 'sent' and p.capture_score is not null)::int as scored
         from enquiries e join prospects p on p.prospect_id = e.prospect_id where e.business_id = $1`,
      [scope.businessId, due],
    )).rows[0];
    return { waiting_for_approval: r.waiting, approved_not_sent: r.approved, sent_awaiting: r.awaiting, scored: r.scored };
  });
}
