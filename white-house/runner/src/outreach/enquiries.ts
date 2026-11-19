import { randomUUID } from "node:crypto";
import type { ModelCaller } from "../agents/model-caller.js";
import { readCurrent, readRung } from "../control/config.js";
import { emitEvent } from "../control/events.js";
import type { Connector, ConnectorCall, ConnectorResult, ReadBackResult } from "../control/connectors/connector.js";
import { MailboxLoginError, MailboxUnreachableError, type InboundMail, type Mailbox } from "../control/connectors/mailbox.js";
import { isUniqueViolation, lock, type Db, type Tx } from "../control/db.js";
import { ControlError } from "../control/errors.js";
import type { Gateway } from "../control/gateway.js";
import { finishRun, startRun, tenantDay } from "../control/runs.js";
import { asksNotToBeContacted, captureFor, estimateLeak, isAutomatic, isBounce, lintEnquiry, ownWords, readsAsComplaint, saysOnlyToCall, saysToCall, sentenceToCall, sentOutOfHours, SLOTS, usefulOutOfHours, type Slot, type Capture, type EnquiryDraft, type Leak, type StoredReply, type TestResult } from "./enquiry-rules.js";
export type { StoredReply, TestResult } from "./enquiry-rules.js";
import { companyNumberKey, domainKey } from "./normalise.js";
import { applyFilters, isGroup, scoreProspect, type Scorable } from "./score.js";
import { forType, type OutreachSettings } from "./settings.js";
import { addTo, noTotals, readReply, type StageTotals } from "./stages.js";
import { priceBenchmark, type ProspectRow, type ProspectScope } from "./store.js";

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
      where (business_id is null or business_id = $1) and not wh_suppression_lifted(suppression_id)
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
  db: Db, gateway: Gateway, scope: ProspectScope, prospect: ProspectRow, draft: EnquiryDraft, now: Date, purpose: "prospect" | "rival" = "prospect", service: string | null = null,
  /** A rival is tested in the same slot as the business it is compared with, or the two results say nothing about each other. */
  slot: Slot | null = null,
  /** The slots in use (the setting). */
  slots: readonly Slot[] = SLOTS,
): Promise<ProposeResult> {
  const to = emailFor(prospect);
  if (!to) return { proposed: false, why: "refused", detail: "no_email_published" };
  const enquiryId = randomUUID();
  let rung = 1;
  try {
    const blocked = await db.tx(scope.tenantId, async (tx) => {
      await lock(tx, "enquiries", scope.tenantId);
      rung = await readRung(tx, scope.businessId, ENQUIRY_ACTION);
      const row = (await tx.query("select domain_key, companies_house_number from prospects where prospect_id = $1 and business_id = $2", [prospect.prospectId, scope.businessId])).rows[0];
      if (!row) return "refused";
      if (await suppressedFor(tx, scope.businessId, { domain: row.domain_key, email: to, company: companyNumberKey(row.companies_house_number) })) return "suppressed";
      await tx.query(
        `insert into enquiries (enquiry_id, tenant_id, business_id, prospect_id, to_address, to_address_key, subject, body, status, proposed_at, purpose, service)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $11, $9, $10, $12)`,
        // At rung 3 nothing waits for a yes: the enquiry is queued, and the sender puts it to the gateway in its turn,
        // inside the sending hours and with the gap. It is never recorded as approved, because nobody approved it.
        [enquiryId, scope.tenantId, scope.businessId, prospect.prospectId, to, to, draft.subject, draft.body, now, purpose, rung >= 3 ? "queued" : "proposed", service],
      );
      // Its slot: the part of the week this kind of business has been tested in least, so each kind is spread across all three.
      if (rung >= 3) await tx.query("update enquiries set sent_slot = $2 where enquiry_id = $1", [enquiryId, slot ?? (await leastUsedSlot(tx, scope.businessId, prospect.typeId, now, slots))]);
      await tx.query("select 1");
      return null;
    });
    if (blocked) return { proposed: false, why: blocked === "suppressed" ? "suppressed" : "refused" };
  } catch (err) {
    if (isUniqueViolation(err)) return { proposed: false, why: "already_enquired" };
    throw err;
  }
  if (rung >= 3) return { proposed: true, enquiryId, approvalId: null };
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
export function createMailConnector(options: {
  db: Db; mailbox: Mailbox | null; now?: () => Date;
  onLoginFailure?: (tenantId: string, businessId: string) => Promise<void> | void;
  /** The mail server was not reached: nothing went. `code` is the network error code. */
  onUnreachable?: (tenantId: string, businessId: string, code: string) => Promise<void> | void;
  /** A message was handed over and is now known to have gone. */
  onSent?: () => void;
  log?: (line: string) => void;
}): Connector {
  const log = options.log ?? ((line: string) => console.error(line));
  const clock = options.now ?? (() => new Date());
  return {
    async execute(call: ConnectorCall): Promise<ConnectorResult> {
      if (!options.mailbox) throw new ControlError("mail_not_configured", "the test mailbox is not configured");
      const payload = call.payload as { enquiry_id: string; prospect_id: string; to: string; subject: string; body: string };
      let before = "proposed";
      const claimed = await options.db.tx(call.tenantId, async (tx) => {
        const row = (await tx.query(
          `select e.status, e.to_address, e.subject, e.body, p.domain_key, p.companies_house_number
             from enquiries e join prospects p on p.prospect_id = e.prospect_id
            where e.enquiry_id = $1 and e.prospect_id = $2 and e.business_id = $3 for update of e`,
          [payload.enquiry_id, payload.prospect_id, call.businessId],
        )).rows[0];
        if (!row) return "no_such_enquiry";
        if (row.status !== "proposed" && row.status !== "approved" && row.status !== "queued") return "already_handled";
        before = row.status as string;
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
      } catch (err) {
        if (err instanceof MailboxLoginError) {
          // The login was refused, so it certainly did not go: the enquiry goes back to where it was, and sending stops for the day.
          await options.db.tx(call.tenantId, (tx) => tx.query("update enquiries set status = $2 where enquiry_id = $1 and status = 'sending'", [payload.enquiry_id, before]));
          await options.onLoginFailure?.(call.tenantId, call.businessId);
          log("enquiry not sent: mailbox_login_failed EAUTH (put back in the queue)");
          throw new ControlError("mailbox_login_failed", "the test mailbox refused the login");
        }
        if (err instanceof MailboxUnreachableError) {
          // The mail server was never reached, so it certainly did not go. This is no failure of the enquiry: it goes back
          // to where it was, the business has not been contacted, and it keeps its one chance.
          await options.db.tx(call.tenantId, async (tx) => {
            await tx.query("update enquiries set status = $2 where enquiry_id = $1 and status = 'sending'", [payload.enquiry_id, before]);
            await emitEvent(tx, { tenantId: call.tenantId, businessId: call.businessId, department: DEPARTMENT, type: "stage", reasonCode: "mail_unreachable", summary: "An enquiry was not sent: the mail server could not be reached. It was put back in the queue", payload: { code: err.networkCode }, now: clock() });
          });
          log(`enquiry not sent: mail_unreachable ${err.networkCode} (put back in the queue)`);
          await options.onUnreachable?.(call.tenantId, call.businessId, err.networkCode);
          throw new ControlError("mail_unreachable", `the mail server could not be reached (${err.networkCode})`);
        }
        // It was claimed and the server was spoken to, so it is never tried again: it may have gone. The reason is kept as a
        // fixed code with the network error code beside it. Never the server's words, the address or the message.
        const code = typeof (err as { networkCode?: unknown } | null)?.networkCode === "string" && /^[A-Z0-9_]{1,40}$/.test((err as { networkCode: string }).networkCode) ? (err as { networkCode: string }).networkCode : "UNKNOWN";
        await options.db.tx(call.tenantId, async (tx) => {
          await tx.query("update enquiries set status = 'failed', failure = $3, decided_at = coalesce(decided_at, $2) where enquiry_id = $1", [payload.enquiry_id, clock(), `send_failed:${code}`]);
          await emitEvent(tx, { tenantId: call.tenantId, businessId: call.businessId, department: DEPARTMENT, type: "stage", reasonCode: "enquiry_send_failed", summary: "An enquiry failed to send after the mail server was reached. It is not tried again: it may have gone", payload: { code }, now: clock() });
        });
        log(`enquiry failed to send: send_failed ${code} (not tried again: it may have gone)`);
        throw new ControlError("mail_send_failed", `the mail server did not accept the message (${code})`);
      }
      options.onSent?.();
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
        where e.business_id = $1 and e.status in ('proposed', 'queued', 'approved', 'sending', 'sent', 'failed')
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
  /** More failed sends and bounces than this in a day stop sending until the next. Default 3. */
  maxFailuresADay?: number;
}

export interface ReplyCounts {
  enquiriesChecked: number;
  person: number;
  automatic: number;
  optedOut: number;
  /** Notices that an enquiry could not be delivered. */
  bounced: number;
  /** Replies that read as a complaint about being contacted. Each suppresses its business; only several in a day stop sending. */
  complaints: number;
}

/**
 * Look in the test mailbox for replies to the enquiries this system sent, and store them on the business they
 * came from. Plain code, except that one cheap model call reads a reply whose headers do not say whether a
 * machine sent it. Nothing is ever sent back.
 */
export async function collectReplies(ctx: ReplyContext): Promise<ReplyCounts> {
  const counts: ReplyCounts = { enquiriesChecked: 0, person: 0, automatic: 0, optedOut: 0, bounced: 0, complaints: 0 };
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
  const complainedFor: string[] = [];

  for (const e of open) {
    counts.enquiriesChecked += 1;
    const addressDomain = (e.to_address_key as string).split("@")[1] ?? "";
    // The sender's domain counts only when it is the business's own. A shared mail provider's domain never does.
    const ownDomain = e.domain_key !== null && addressDomain === e.domain_key ? (e.domain_key as string) : null;
    let found: InboundMail[];
    try {
      found = await ctx.mailbox.findReplies({ messageId: e.message_id, address: e.to_address_key, ownDomain, since: e.sent_at });
    } catch (err) {
      if (err instanceof MailboxLoginError) {
        await tripBreaker(ctx.db, ctx.tenantId, e.business_id as string, "mailbox_login", ctx.now());
        break; // the login is refused for every enquiry alike
      }
      continue; // the mailbox could not be read just now: try again on the next round
    }
    const result: TestResult = (e.test_result as TestResult | null) ?? { enquiry_id: e.enquiry_id, sent_at: (e.sent_at as Date).toISOString(), replies: [] };
    const known = new Set(result.replies.map((r) => r.message_id));
    const fresh = found.filter((m) => !known.has(m.messageId) && m.receivedAt.getTime() >= (e.sent_at as Date).getTime()).sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    if (fresh.length === 0) continue;

    for (const mail of fresh) {
      const stored: StoredReply = { message_id: mail.messageId, received_at: mail.receivedAt.toISOString(), kind: "unclear", matched_by: mail.matchedBy, text: mail.text.slice(0, 6000) };
      const machine = isAutomatic(mail.headers, mail.subject);
      // Only the reply's own words are judged: not what it quotes, not the signature, not the firm's standard footer.
      const own = ownWords(mail.text);
      let optOut = machine !== true && asksNotToBeContacted(own);
      // Could not be delivered: the business never saw it. Not a reply, not a result, and one more towards the day's limit of failures.
      if (isBounce(mail.from, mail.subject)) {
        stored.kind = "bounce";
        stored.text = "";
        counts.bounced += 1;
        result.replies.push(stored);
        continue;
      }
      // A complaint needs BOTH: a phrase in the reply's own words (here), and the reply reader agreeing with a sentence
      // that is really in those words (below). Either alone stops nothing.
      const complaintPhrase = machine !== true && readsAsComplaint(own);
      let complaint: string | null = null;
      if (machine === true) stored.kind = "automatic";
      if (ctx.model && ctx.apiKey) {
        // One cheap call reads the reply: is it from a person (when the headers do not settle it), did it answer the
        // question, did it offer a next step. An automatic reply is read too, because one that gives the price or a way
        // to book is useful to someone writing at night, and a bare "we have received your message" is not.
        const business = e.business_id as string;
        if (!(business in runs)) {
          const started = await startRun(ctx.db, { tenantId: ctx.tenantId, businessId: business, department: DEPARTMENT, trigger: "outreach:replies", model: "claude-haiku-5-5" }, { now: ctx.now() });
          runs[business] = started.started ? started.runId : null;
          totals[business] = noTotals();
        }
        if (runs[business]) {
          const { reply, reading } = await readReply(ctx.model, ctx.apiKey, ctx.system, `${e.subject}\n\n${e.body}`, own || mail.text);
          addTo(totals[business] as StageTotals, reply);
          if (reading) {
            // The headers have the last word on whether a machine sent it.
            if (machine !== true) stored.kind = reading.fromAPerson ? "person" : "automatic";
            stored.answered = reading.answered;
            // "Please call the office" is a refusal to answer by email, not a next step. It is kept, and quoted on the card.
            const callOnly = reading.nextStep?.value === true && saysOnlyToCall(reading.nextStep.quote ?? "");
            stored.next_step = callOnly ? { value: false, quote: null } : reading.nextStep;
            if (machine !== true && reading.answered?.value !== true && saysToCall(own)) stored.told_to_call = sentenceToCall(own);
            if (complaintPhrase && reading.complaint?.value === true && reading.complaint.quote) complaint = reading.complaint.quote;
          }
        }
      }
      if (stored.kind === "person") counts.person += 1;
      if (stored.kind === "automatic") counts.automatic += 1;
      result.replies.push(stored);
      if (optOut || complaint) stored.opt_out = true;
      if (complaint) {
        // Somebody minds being contacted. This business is never written to again, and the sentence is kept so the owner
        // can see it. One complaint does NOT stop sending (owner's decision, 18 Nov 2026): only several in a day do,
        // which would mean something is wrong with the enquiries themselves. Counted after this reply is stored.
        stored.complaint_sentence = complaint.slice(0, 300);
        counts.complaints += 1;
        optOut = true;
        complainedFor.push(e.business_id as string);
      }
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
  // Several complaints in one day stop sending; one never does.
  if (complainedFor[0]) await checkComplaints(ctx.db, ctx.tenantId, complainedFor[0], ctx.now());
  // Bounces count with failed sends towards the day's limit.
  if (counts.bounced > 0 && open[0]) await checkFailures(ctx.db, ctx.tenantId, open[0].business_id as string, ctx.maxFailuresADay ?? 3, ctx.now());
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
  /** The tenant's time zone, for saying when an enquiry was sent in its own time. */
  timezone?: string;
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
  return db.tx(scope.tenantId, async (tx) => {
    await lock(tx, "prospects", scope.tenantId, scope.businessId);
    const timezone = (await tx.query("select timezone from tenants where tenant_id = wh_tenant()")).rows[0].timezone as string;
    const rows = await tx.query(
      // A business tested as somebody's rival is judged in its own right too: it was sent the one enquiry it will ever get.
      // Stage 'tested' with no card: scored on an earlier run and held over, so it is offered again without being scored twice.
      `select ${columns.split(", ").map((c) => `p.${c}`).join(", ")}, p.stage, p.test_result, e.subject as enquiry_subject, e.body as enquiry_body, e.to_address as enquiry_to
         from prospects p join enquiries e on e.prospect_id = p.prospect_id and e.status = 'sent'
        where p.business_id = $1 and coalesce((p.test_result ->> 'score_after')::timestamptz, e.sent_at + ($3 * interval '1 hour')) <= $2 and p.purged_at is null
          and ((p.stage = 'analysed' and p.capture_score is null) or p.stage = 'tested'
               -- Owner's decision, 18 Nov 2026: everyone tested is shown, worst first, and Salekh decides. Businesses set
               -- aside AFTER their test by the old rules (company type, money signal, leak estimate, answered well) come back.
               or (p.stage = 'filtered_out' and p.capture_score is not null and p.card is null
                   and p.filter_reason in ('limited_company_not_confirmed', 'no_money_signal', 'estimated_leak_below_threshold', 'captures_well', 'no_named_contact')))
        order by e.sent_at, p.prospect_id`,
      [scope.businessId, now, settings.reply_wait_hours],
    );
    // A rival that is not itself a candidate (it failed the fit filters earlier) still gets its score recorded, for the comparison.
    const others = await tx.query(
      `select p.prospect_id, p.contact_routes, p.test_result from prospects p join enquiries e on e.prospect_id = p.prospect_id and e.status = 'sent'
        where p.business_id = $1 and coalesce((p.test_result ->> 'score_after')::timestamptz, e.sent_at + ($3 * interval '1 hour')) <= $2 and p.purged_at is null and p.capture_score is null and p.stage not in ('analysed', 'tested') and p.test_result is not null`,
      [scope.businessId, now, settings.reply_wait_hours],
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
      } else {
        // Scored before: the score is worked out again by today's rules, so a fix to the scoring reaches it.
        await tx.query("update prospects set capture_score = $2, capture_breakdown = $3::jsonb where prospect_id = $1", [p.prospectId, capture.score, JSON.stringify(capture)]);
        if (raw.stage === "filtered_out") {
          await tx.query("update prospects set stage = 'tested', filter_reason = null, filtered_out_at = null where prospect_id = $1", [p.prospectId]);
          await event("tested", "restored_owner_shows_everyone");
        }
      }
      const people = test.replies.filter((r) => r.kind === "person").sort((a, b) => a.received_at.localeCompare(b.received_at));
      const minutesToReply = people[0] ? (new Date(people[0].received_at).getTime() - new Date(test.sent_at).getTime()) / 60000 : null;
      const price = typeof p.analysis?.highest_value_price === "object" && p.analysis.highest_value_price !== null ? (p.analysis.highest_value_price as { amount: number; source_url: string }) : null;
      const shut = sentOutOfHours(test);
      // No price of its own: the median of what others of its kind publish for the same service, said as such.
      const benchmark = price ? undefined : await priceBenchmark(tx, p.prospectId, own);
      const leak = estimateLeak(price, { minutesToReply, ...(shut ? { outOfHours: { useful: usefulOutOfHours(test, timezone).band !== null } } : {}) }, own, benchmark);
      const verdict = test.opted_out ? { keep: false as const, reason: "opted_out" }
        // The enquiry never reached them, so their silence says nothing about how they answer.
        : test.replies.some((r) => r.kind === "bounce") ? { keep: false as const, reason: "enquiry_bounced" }
        : { keep: true as const };
      // Owner's decision, 18 Nov 2026: no cut-off and no filter after the test. Everyone tested goes on the list,
      // worst first, with the score and what happened; Salekh decides who to call. Only a business that asked not to be
      // contacted, or that the enquiry never reached, is left off. (The fit score and leak estimate are still shown.)
      void untested; void applyFilters;
      const reason = !verdict.keep ? verdict.reason : null;
      if (reason) {
        // Kept on the list with its result: it is the comparison for its neighbours. Details are purged after 90 days like any other.
        await tx.query("update prospects set stage = 'filtered_out', filter_reason = $2, filtered_out_at = $3, purge_after = $4 where prospect_id = $1",
          [p.prospectId, reason, now, new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)]);
        await event("filtered_out", reason);
        filtered[reason] = (filtered[reason] ?? 0) + 1;
        continue;
      }
      passed.push({ ...p, timezone, score: fit.score, breakdown: { ...fit.breakdown }, test, capture, leak, enquiry: { subject: raw.enquiry_subject, body: raw.enquiry_body, to: raw.enquiry_to } });
    }
    passed.sort((a, b) => (a.capture.score ?? 0) - (b.capture.score ?? 0) || (b.score ?? 0) - (a.score ?? 0));
    return { scored: newlyScored + others.rows.length, filtered, passed };
  });
}

/** Where the day's enquiries have got to, for the shortlist's opening lines. */
export async function enquiryCounts(db: Db, scope: ProspectScope, settings: OutreachSettings, now: Date): Promise<{ waiting_for_approval: number; approved_not_sent: number; queued_to_send: number; sent_awaiting: number; scored: number }> {
  return db.tx(scope.tenantId, async (tx) => {
    const r = (await tx.query(
      `select count(*) filter (where e.status = 'proposed')::int as waiting,
              count(*) filter (where e.status = 'approved')::int as approved,
              count(*) filter (where e.status = 'queued')::int as queued,
              count(*) filter (where e.status = 'sent' and not (coalesce((p.test_result ->> 'score_after')::timestamptz, e.sent_at + ($3 * interval '1 hour')) <= $2))::int as awaiting,
              count(*) filter (where e.status = 'sent' and p.capture_score is not null)::int as scored
         from enquiries e join prospects p on p.prospect_id = e.prospect_id where e.business_id = $1`,
      [scope.businessId, now, settings.reply_wait_hours],
    )).rows[0];
    return { waiting_for_approval: r.waiting, approved_not_sent: r.approved, queued_to_send: r.queued, sent_awaiting: r.awaiting, scored: r.scored };
  });
}

// ---- circuit breakers ------------------------------------------------------------------

export type BreakerReason = "send_failures" | "complaint" | "mailbox_login" | "mail_unreachable";
const BREAKER: Record<BreakerReason, string> = {
  mail_unreachable: "the mail server could not be reached from this server",
  send_failures: "too many enquiries failed to send or bounced today",
  complaint: "several replies today read as complaints about being contacted",
  mailbox_login: "the test mailbox refused the login",
};

/**
 * Stop automatic sending for the rest of the tenant's day, and say why. Kept in the event stream, so it holds
 * across a restart and is on the record. The first reason of the day stands; later ones are not piled on.
 */
export async function tripBreaker(db: Db, tenantId: string, businessId: string, why: BreakerReason, now: Date, code: string | null = null): Promise<void> {
  // Only ever a network error code beside the fixed words.
  const detail = code && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : "";
  await db.tx(tenantId, async (tx) => {
    await lock(tx, "enquiry-breaker", tenantId);
    if (await breakerIn(tx, now)) return;
    await emitEvent(tx, { tenantId, businessId, department: DEPARTMENT, type: "stage", reasonCode: `enquiry_breaker_${why}`, summary: `Sending stopped for today: ${BREAKER[why]}${detail}`, ...(detail ? { payload: { code } } : {}), now });
  });
  console.error(`sending stopped for today: ${why}${detail}`);
}

/** Lift today's stop. Written when an owner has put right what caused it and asked for the unsent to be queued again. */
export async function resetBreaker(db: Db, tenantId: string, businessId: string, now: Date): Promise<void> {
  await db.tx(tenantId, (tx) => emitEvent(tx, { tenantId, businessId, department: DEPARTMENT, type: "stage", reasonCode: "enquiry_breaker_reset", summary: "Sending was allowed again by the owner, after unsent enquiries were put back in the queue", now }));
}

async function breakerIn(tx: Tx, now: Date): Promise<string | null> {
  const row = (await tx.query(
    `select e.reason_code, e.summary from events e join tenants t on t.tenant_id = e.tenant_id
      where e.type = 'stage' and e.reason_code like 'enquiry\\_breaker\\_%'
        and (e.created_at at time zone t.timezone)::date = (($1::timestamptz) at time zone t.timezone)::date
      order by e.seq desc limit 20`,
    [now],
  )).rows;
  // The latest word stands: a stop after a reset is a stop, and a reset after a stop lifts it. The first stop since then gives the reason.
  const isReset = (r: { reason_code: string }) => r.reason_code.startsWith("enquiry_breaker_reset");
  const since = row.findIndex(isReset);
  const stops = (since === -1 ? row : row.slice(0, since)).filter((r) => !isReset(r));
  const first = stops.at(-1);
  return first ? String(first.summary).replace(/^Sending stopped for today: /, "") : null;
}

/** Why sending is stopped today, in plain words, or null when it is not. */
export function breakerToday(db: Db, tenantId: string, now: Date): Promise<string | null> {
  return db.tx(tenantId, (tx) => breakerIn(tx, now));
}

/** Complaints that stop sending for the day: this many confirmed in one day, or more than this share of the day's
 * sent enquiries once at least COMPLAINT_MIN_SENT have gone. One complaint alone never stops sending: it only
 * suppresses that business (owner's decision, 18 Nov 2026). */
export const COMPLAINTS_A_DAY = 3;
export const COMPLAINT_SHARE = 0.1;
export const COMPLAINT_MIN_SENT = 20;

/** Confirmed complaints and sent enquiries today. Past either limit, sending stops. Returns true when it has just been stopped. */
export async function checkComplaints(db: Db, tenantId: string, businessId: string, now: Date): Promise<boolean> {
  const row = await db.tx(tenantId, async (tx) => (await tx.query(
    `select (select count(*) from prospects p join tenants t on t.tenant_id = p.tenant_id, jsonb_array_elements(coalesce(p.test_result -> 'replies', '[]'::jsonb)) r
              where r ? 'complaint_sentence' and ((r ->> 'received_at')::timestamptz at time zone t.timezone)::date = (($1::timestamptz) at time zone t.timezone)::date) as complaints,
            (select count(*) from enquiries e join tenants t on t.tenant_id = e.tenant_id
              where e.sent_at is not null and (e.sent_at at time zone t.timezone)::date = (($1::timestamptz) at time zone t.timezone)::date) as sent`,
    [now],
  )).rows[0]);
  const complaints = Number(row.complaints);
  const sent = Number(row.sent);
  const tooMany = complaints >= COMPLAINTS_A_DAY || (sent >= COMPLAINT_MIN_SENT && complaints / sent > COMPLAINT_SHARE);
  if (!tooMany) return false;
  await tripBreaker(db, tenantId, businessId, "complaint", now);
  return true;
}

/** Failed sends and bounces today. Past the day's limit, sending stops. Returns true when it has just been stopped, or already was. */
export async function checkFailures(db: Db, tenantId: string, businessId: string, limit: number, now: Date): Promise<boolean> {
  const n = await db.tx(tenantId, async (tx) => (await tx.query(
    `select (select count(*) from enquiries e join tenants t on t.tenant_id = e.tenant_id
              where e.status = 'failed' and (coalesce(e.decided_at, e.proposed_at) at time zone t.timezone)::date = (($1::timestamptz) at time zone t.timezone)::date)
          + (select count(*) from prospects p join tenants t on t.tenant_id = p.tenant_id, jsonb_array_elements(coalesce(p.test_result -> 'replies', '[]'::jsonb)) r
              where r ->> 'kind' = 'bounce' and ((r ->> 'received_at')::timestamptz at time zone t.timezone)::date = (($1::timestamptz) at time zone t.timezone)::date) as n`,
    [now],
  )).rows[0].n);
  if (Number(n) <= limit) return false;
  await tripBreaker(db, tenantId, businessId, "send_failures", now);
  return true;
}

// ---- when the rung changes under enquiries already waiting ------------------------------

/**
 * Enquiries waiting for a yes when their action moved to rung 3. NOBODY APPROVES THEM ON ANYONE'S BEHALF. Each
 * waiting approval is withdrawn (voided, reason rung_changed), and its enquiry, if it still passes every check in
 * force today, is queued to be put to the gateway afresh at the rung now in force. One that no longer passes is
 * closed unsent, leaving the business free to be drafted for again. One event each.
 */
export async function requeueAfterRungChange(db: Db, tenantId: string, settingsOf: (businessId: string) => Promise<OutreachSettings>, now: Date): Promise<{ requeued: number; dropped: number }> {
  const waiting = await db.tx(tenantId, async (tx) => (await tx.query(
    `select e.enquiry_id, e.business_id, e.subject, e.body, e.service, a.approval_id, p.business_type
       from enquiries e join approvals a on a.approval_id = e.approval_id join prospects p on p.prospect_id = e.prospect_id
      where e.status = 'proposed' and a.status = 'pending' and a.action_type = $1 order by e.proposed_at`,
    [ENQUIRY_ACTION],
  )).rows);
  const done = { requeued: 0, dropped: 0 };
  for (const row of waiting) {
    const businessId = row.business_id as string;
    const settings = forType(await settingsOf(businessId), row.business_type as string);
    const passes = lintEnquiry({ subject: row.subject, body: row.body }, settings, row.service as string | null).length === 0;
    const moved = await db.tx(tenantId, async (tx) => {
      if ((await readRung(tx, businessId, ENQUIRY_ACTION)) < 3) return false;
      const voided = await tx.query("update approvals set status = 'voided', void_reason = 'rung_changed', decided_at = $2 where approval_id = $1 and status = 'pending'", [row.approval_id, now]);
      if ((voided.rowCount ?? 0) === 0) return false; // answered in the meantime: left as it was answered
      await tx.query("update enquiries set status = $2, approval_id = null where enquiry_id = $1 and status = 'proposed'", [row.enquiry_id, passes ? "queued" : "expired"]);
      await emitEvent(tx, {
        tenantId, businessId, department: DEPARTMENT, type: "voided", reasonCode: "rung_changed", now,
        summary: passes
          ? "An enquiry waiting for a yes was withdrawn because enquiries now send without asking. It was not approved: it is queued to be sent at the rung now in force"
          : "An enquiry waiting for a yes was withdrawn because enquiries now send without asking. It no longer passes the checks, so it will not be sent",
        payload: { approvalId: row.approval_id },
      });
      return true;
    });
    if (moved) done[passes ? "requeued" : "dropped"] += 1;
  }
  return done;
}

// ---- what was sent, to read afterwards ---------------------------------------------------

export interface SentEnquiry {
  id: string;
  business: string;
  town: string | null;
  kind: string;
  purpose: string;
  to: string;
  subject: string;
  body: string;
  status: string;
  proposedAt: string;
  sentAt: string | null;
  /** true: it went at rung 3, with nobody's yes. false: a person approved it. */
  withoutApproval: boolean;
}

/** Enquiries of one room since a moment, newest first. PERSONAL DATA: who was written to and exactly what was said. */
export async function listEnquiries(db: Db, tenantId: string, businessId: string, since: Date, limit = 500): Promise<SentEnquiry[]> {
  return db.tx(tenantId, async (tx) => (await tx.query(
    `select e.enquiry_id, p.name, coalesce(p.search_area, p.area) as town, p.business_type, e.purpose, e.to_address, e.subject, e.body, e.status, e.proposed_at, e.sent_at, e.approval_id
       from enquiries e join prospects p on p.prospect_id = e.prospect_id
      where e.business_id = $1 and coalesce(e.sent_at, e.proposed_at) >= $2
      order by coalesce(e.sent_at, e.proposed_at) desc, e.enquiry_id limit $3`,
    [businessId, since, limit],
  )).rows.map((r) => ({
    id: r.enquiry_id, business: r.name, town: r.town, kind: r.business_type, purpose: r.purpose, to: r.to_address, subject: r.subject, body: r.body, status: r.status,
    proposedAt: (r.proposed_at as Date).toISOString(), sentAt: r.sent_at ? (r.sent_at as Date).toISOString() : null, withoutApproval: r.approval_id === null && r.status !== "proposed",
  })));
}

/**
 * For the shortlist's opening line: what has been sent without asking and not yet told of on an earlier
 * shortlist, kind by kind. No names, no addresses. Which enquiries a shortlist has told of is kept on that
 * shortlist (their ids), so none is told of twice and none is missed, whatever the clock says.
 */
export async function sentWithoutAsking(db: Db, scope: ProspectScope, now: Date): Promise<{ total: number; by_kind: Record<string, number>; ids: string[] }> {
  return db.tx(scope.tenantId, async (tx) => {
    const since = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const rows = (await tx.query(
      `select e.enquiry_id, p.business_type from enquiries e join prospects p on p.prospect_id = e.prospect_id
        where e.business_id = $1 and e.status = 'sent' and e.approval_id is null and e.sent_at > $2
          and not exists (
            select 1 from outputs o, jsonb_array_elements_text(coalesce(o.data -> 'enquiries' -> 'sent_without_asking' -> 'ids', '[]'::jsonb)) told
             where o.business_id = e.business_id and o.department = $3 and o.created_at > $2 and told = e.enquiry_id::text)
        order by e.sent_at, e.enquiry_id`,
      [scope.businessId, since, DEPARTMENT],
    )).rows;
    const by_kind: Record<string, number> = {};
    for (const r of rows) by_kind[r.business_type as string] = (by_kind[r.business_type as string] ?? 0) + 1;
    return { total: rows.length, by_kind, ids: rows.map((r) => r.enquiry_id as string) };
  });
}

// ---- slots -----------------------------------------------------------------------------

/**
 * The slot this kind of business has had fewest enquiries in over the last fortnight (in hours, then evening, then
 * weekend when level). Counting is by kind, so each kind is tested evenly across all three.
 */
export async function leastUsedSlot(tx: Tx, businessId: string, typeId: string, now: Date, slots: readonly Slot[] = SLOTS): Promise<Slot> {
  const rows = (await tx.query(
    `select e.sent_slot, count(*)::int as n from enquiries e join prospects p on p.prospect_id = e.prospect_id
      where e.business_id = $1 and p.business_type = $2 and e.sent_slot is not null and e.status not in ('rejected', 'expired') and e.proposed_at > $3
      group by e.sent_slot`,
    [businessId, typeId, new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)],
  )).rows;
  const used = new Map(rows.map((r) => [r.sent_slot as Slot, r.n as number]));
  const inUse = SLOTS.filter((slot) => slots.includes(slot));
  return [...(inUse.length > 0 ? inUse : SLOTS)].sort((a, b) => (used.get(a) ?? 0) - (used.get(b) ?? 0) || SLOTS.indexOf(a) - SLOTS.indexOf(b))[0] as Slot;
}

/** Give a slot to every queued enquiry that has none (those queued before there were slots). Returns how many. */
export async function assignMissingSlots(db: Db, tenantId: string, now: Date, slotsOf: (businessId: string) => Promise<readonly Slot[]> = async () => SLOTS): Promise<number> {
  const waiting = await db.tx(tenantId, async (tx) => (await tx.query("select distinct business_id from enquiries where status = 'queued' and sent_slot is null")).rows.map((r) => r.business_id as string));
  if (waiting.length === 0) return 0;
  const slots = new Map<string, readonly Slot[]>();
  for (const businessId of waiting) slots.set(businessId, await slotsOf(businessId));
  return db.tx(tenantId, async (tx) => {
    await lock(tx, "enquiries", tenantId);
    const rows = (await tx.query(
      "select e.enquiry_id, e.business_id, p.business_type from enquiries e join prospects p on p.prospect_id = e.prospect_id where e.status = 'queued' and e.sent_slot is null order by e.proposed_at, e.enquiry_id",
    )).rows;
    for (const r of rows) await tx.query("update enquiries set sent_slot = $2 where enquiry_id = $1", [r.enquiry_id, await leastUsedSlot(tx, r.business_id as string, r.business_type as string, now, slots.get(r.business_id as string))]);
    return rows.length;
  });
}

// ---- putting back what never went --------------------------------------------------------

/**
 * Enquiries marked failed since a day, whose failure was that the mail server was never reached (or whose reason
 * was not recorded, from before reasons were kept), go back in the queue. They certainly did not go, so the
 * business has not been contacted. One that failed after the server was reached is left alone: it may have gone.
 * When any is put back, today's stop on sending is lifted. Returns how many.
 */
export async function requeueUnsent(db: Db, tenantId: string, since: Date, now: Date): Promise<number> {
  const rows = await db.tx(tenantId, async (tx) => {
    await lock(tx, "enquiries", tenantId);
    return (await tx.query(
      `update enquiries set status = 'queued', failure = null, approval_id = null
        where status = 'failed' and coalesce(decided_at, proposed_at) >= $1 and (failure is null or failure like 'mail\\_unreachable%') and sent_at is null and message_id is null
        returning enquiry_id, business_id`,
      [since],
    )).rows;
  });
  if (rows.length > 0) {
    const businessId = rows[0].business_id as string;
    await db.tx(tenantId, (tx) => emitEvent(tx, { tenantId, businessId, department: DEPARTMENT, type: "stage", reasonCode: "enquiries_requeued", summary: `Enquiries that never reached the mail server were put back in the queue: ${rows.length}`, now }));
    if (await breakerToday(db, tenantId, now)) await resetBreaker(db, tenantId, businessId, now);
  }
  return rows.length;
}

// ---- what came back, to read afterwards -------------------------------------------------

export interface ReplyRecord {
  business: string;
  kind: string;
  receivedAt: string;
  /** person, automatic, unclear or bounce. */
  from: StoredReply["kind"];
  /** A person, or an automatic reply that answered the question or offered a booking. */
  useful: boolean;
  flags: { answered: boolean | null; offeredNextStep: boolean | null; askedNotToBeContacted: boolean; complaint: boolean; matchedBy: string };
  /** The sentence that was read as a complaint, when one was. */
  complaintSentence: string | null;
  /** The reply's own words: quoted text, signature and footer taken off. */
  text: string;
}

/** Replies received in one room since a moment, newest first. PERSONAL DATA: what people at these businesses wrote. */
export async function listReplies(db: Db, tenantId: string, businessId: string, since: Date, limit = 500): Promise<ReplyRecord[]> {
  const rows = await db.tx(tenantId, async (tx) => (await tx.query(
    "select name, business_type, test_result from prospects where business_id = $1 and purged_at is null and test_result is not null and jsonb_array_length(coalesce(test_result -> 'replies', '[]'::jsonb)) > 0",
    [businessId],
  )).rows);
  const out: ReplyRecord[] = [];
  for (const row of rows) {
    for (const r of (row.test_result as TestResult).replies) {
      if (new Date(r.received_at).getTime() < since.getTime()) continue;
      out.push({
        business: row.name as string, kind: row.business_type as string, receivedAt: r.received_at, from: r.kind,
        useful: r.kind === "person" || (r.kind === "automatic" && (r.answered?.value === true || r.next_step?.value === true)),
        flags: { answered: r.answered?.value ?? null, offeredNextStep: r.next_step?.value ?? null, askedNotToBeContacted: r.opt_out === true, complaint: typeof r.complaint_sentence === "string", matchedBy: r.matched_by },
        complaintSentence: r.complaint_sentence ?? null, text: ownWords(r.text),
      });
    }
  }
  return out.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
}

/** The complaints behind today's stop, for the owner to judge: which business, and the sentence. */
export async function complaintsToday(db: Db, scope: ProspectScope, now: Date): Promise<{ business: string; sentence: string }[]> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return (await listReplies(db, scope.tenantId, scope.businessId, since)).filter((r) => r.complaintSentence).map((r) => ({ business: r.business, sentence: r.complaintSentence as string }));
}

/**
 * The owner's switch: lift a stop on sending for one day. Does nothing unless that day is today (a stop does not
 * outlast its day anyway), sending is stopped, and the owner has not already lifted a stop today: once.
 */
export async function clearStop(db: Db, tenantId: string, day: string, now: Date): Promise<boolean> {
  return db.tx(tenantId, async (tx) => {
    await lock(tx, "enquiry-breaker", tenantId);
    // Lifts the stop in force now, once: a stop that is already lifted is not lifted again. A NEW stop later the same
    // day can be lifted too (owner's decision, 18 Nov 2026: a wrong stop must not cost the rest of the day). A real
    // fault, such as a refused login, simply stops sending again on its next attempt.
    if ((await tenantDay(tx, now)) !== day || !(await breakerIn(tx, now))) return false;
    const floor = (await tx.query("select business_id from events where type = 'stage' and reason_code like 'enquiry\\_breaker\\_%' and business_id is not null order by seq desc limit 1")).rows[0];
    await emitEvent(tx, { tenantId, businessId: floor?.business_id ?? null, department: DEPARTMENT, type: "stage", reasonCode: "enquiry_breaker_reset_owner", summary: "The stop on sending was lifted by the owner, through the server's settings", now });
    return true;
  });
}

// ---- scoring whatever is due, from a run or from the ten minute round ---------------------

/**
 * Score every business whose enquiry's wait has ended. First, for those that scored low and whose company is not
 * confirmed, Companies House is asked (a limited company, and a director's name): only now, after the test.
 * Code only apart from that lookup, so it is safe to do every ten minutes.
 */
export async function scoreDue(
  db: Db, scope: ProspectScope, settings: OutreachSettings, now: Date,
  companiesHouse: { lookup(input: { number: string | null; name: string; postcode: string | null }): Promise<any> } | null,
  store: {
    toRow: (r: any) => ProspectRow; columns: string;
    awaitingCompanyCheck: (db: Db, scope: ProspectScope, now: Date, waitHours: number) => Promise<(ProspectRow & { testResult: unknown; companyNumber: string | null })[]>;
    saveCompanyCheck: (db: Db, scope: ProspectScope, prospectId: string, result: any) => Promise<void>;
  },
): Promise<Awaited<ReturnType<typeof scoreTested>> & { companyCheckFailed: number }> {
  let companyCheckFailed = 0;
  if (companiesHouse) {
    const timezone = (await db.tx(scope.tenantId, async (tx) => (await tx.query("select timezone from tenants where tenant_id = wh_tenant()")).rows[0].timezone)) as string;
    for (const p of await store.awaitingCompanyCheck(db, scope, now, settings.reply_wait_hours)) {
      const capture = captureFor(p.testResult as TestResult, [...new Set(p.routes.map((r) => r.kind))], forType(settings, p.typeId), timezone);
      // Everyone tested is shown now (owner's decision, 18 Nov 2026), so everyone gets the director's name looked up.
      void capture;
      const result = await companiesHouse.lookup({ number: p.companyNumber, name: p.name, postcode: p.postcode }).catch(() => null);
      if (result) await store.saveCompanyCheck(db, scope, p.prospectId, result);
      else companyCheckFailed += 1;
    }
  }
  return { ...(await scoreTested(db, scope, settings, now, store.toRow, store.columns)), companyCheckFailed };
}

export interface ResultSoFar {
  prospectId: string;
  name: string;
  kind: string;
  captureScore: number | null;
  /** "prospect": scored low and passed the filters. Otherwise why it was set aside. */
  outcome: string;
  note: string;
  sentAt: string;
  slot: string | null;
  openingState: string | null;
}

/** Every business scored on the tenant's day so far, for the room's rolling "Results so far". */
export async function resultsToday(db: Db, scope: ProspectScope, now: Date): Promise<{ day: string; results: ResultSoFar[] }> {
  return db.tx(scope.tenantId, async (tx) => {
    const day = await tenantDay(tx, now);
    const rows = (await tx.query(
      `select p.prospect_id, p.name, p.business_type, p.capture_score, p.capture_breakdown, p.stage, p.filter_reason, p.test_result
         from prospects p join tenants t on t.tenant_id = p.tenant_id
        where p.business_id = $1 and p.purged_at is null and p.capture_score is not null
          and exists (select 1 from prospect_events e where e.prospect_id = p.prospect_id and e.stage = 'tested' and (e.created_at at time zone t.timezone)::date = $2::date)
        order by p.capture_score, p.name`,
      [scope.businessId, day],
    )).rows;
    return {
      day,
      results: rows.map((r) => ({
        prospectId: r.prospect_id, name: r.name, kind: r.business_type, captureScore: r.capture_score === null ? null : Number(r.capture_score),
        outcome: r.stage === "filtered_out" ? (r.filter_reason as string) : "prospect",
        note: String((r.capture_breakdown as Capture | null)?.parts?.[0]?.note ?? ""),
        sentAt: (r.test_result as TestResult).sent_at, slot: (r.test_result as TestResult).slot ?? null, openingState: (r.test_result as TestResult).opening_state ?? null,
      })),
    };
  });
}
