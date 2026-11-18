import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelCaller, ModelReply } from "../agents/model-caller.js";
import { followupAction } from "../control/action-types.js";
import { decideApproval } from "../control/approvals.js";
import { readRung, writeVersion } from "../control/config.js";
import type { Connector, ConnectorCall, ConnectorResult, ReadBackResult } from "../control/connectors/connector.js";
import { MailboxLoginError, MailboxUnreachableError, type Mailbox } from "../control/connectors/mailbox.js";
import { isUniqueViolation, isUuid, lock, type Db, type Tx } from "../control/db.js";
import { ControlError } from "../control/errors.js";
import { emitEvent } from "../control/events.js";
import type { Gateway } from "../control/gateway.js";
import { hashPayload } from "../control/hash.js";
import { requireOwner } from "../control/members.js";
import { finishRun, startRun } from "../control/runs.js";
import { sayMinutes, type TestResult } from "./enquiry-rules.js";
import { companyNumberKey } from "./normalise.js";
import { forType, type OutreachSettings } from "./settings.js";
import { addTo, followupSchema, noTotals } from "./stages.js";
export { followupSchema };
import type { PublicFacts } from "./store.js";

/**
 * The follow-up email after a call (the Outreach room's "follow-up agent").
 *
 * When Salekh records that a business was interested, asked to be called back or booked a meeting, WITH a note,
 * one model call drafts a short email in his voice. Code then checks it. It is sent, if at all, from the OWNER's
 * mailbox (not the test mailbox) as `followup.send_email`, through the gateway, which holds the rung, the cap, the
 * kill switch and the read back. Rules and where each is held:
 *
 *   - never a guessed address          the recipient comes only from Salekh; the model is never asked for one and
 *                                      its answer has no field for one; no address, no proposal (payload + database)
 *   - the code checks                  lintFollowup: length, signed, no £ or %, no links, a valid address
 *   - rung 2: each needs his yes       the gateway, with the payload hash; an edit voids a waiting or approved yes
 *   - rung 3: no yes, never no address the gateway; this file never submits a draft without one
 *   - one per business per 24 hours    checked before proposing and again when the connector claims the row
 *   - daily cap                        the gateway's cap `followups_per_day` (seeded 20)
 *   - suppressed, not interested       checked before drafting, before proposing and in the moment before sending
 *   - no personal data in events       fixed summaries, no payload; the action type is private
 *   - no owner mailbox                 drafts are made and approved all the same; nothing is sent; the card offers a copy
 */

export const FOLLOWUP_ACTION = followupAction.name;
export const FOLLOWUP_CAP = followupAction.cap.key;
export const FOLLOWUP_MODEL = "claude-sonnet-5-5" as const;
const DEPARTMENT = "outreach";

/** Only these outcomes, with a note, lead to a follow-up email. */
export const DRAFT_OUTCOMES = ["interested", "call_back", "meeting_booked"] as const;
export type DraftOutcome = (typeof DRAFT_OUTCOMES)[number];
export const SIGNATURE = "Salekh Mahmood, Salekh Ventures";
export const MAX_WORDS = 180;
/** The whole email, once the findings list written by code is in it. */
export const MAX_WORDS_WITH_FINDINGS = 280;
export const MAX_SUBJECT = 120;
const MAX_BODY_CHARS = 4000;
const DAY_MS = 24 * 60 * 60 * 1000;

const EMAIL = /^[a-z0-9][a-z0-9._%+'-]*@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export type Recipient = { name: string | null; email: string };

/** A recipient as Salekh gives it: an email address that looks like one, and a name if he gives one. */
export function checkRecipient(value: unknown): { ok: true; to: Recipient | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, to: null };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "the recipient must be { name, email }" };
  const v = value as { name?: unknown; email?: unknown };
  if (v.name !== undefined && v.name !== null && typeof v.name !== "string") return { ok: false, reason: "the recipient's name must be text" };
  const name = typeof v.name === "string" && v.name.trim() ? v.name.trim().replace(/\s+/g, " ") : null;
  if (name && name.length > 120) return { ok: false, reason: "the recipient's name must be at most 120 characters" };
  if (typeof v.email !== "string" || !v.email.trim()) return { ok: false, reason: "the recipient needs an email address" };
  const email = v.email.trim();
  if (email.length > 254 || !EMAIL.test(email)) return { ok: false, reason: "that email address does not look right" };
  return { ok: true, to: { name, email } };
}

// ---- the code checks ------------------------------------------------------------------

/** The one link a follow-up may carry: Salekh's own site, added by code (owner, 18 Nov 2026). */
export const SITE_LINE = "You can see the agents I run working round the clock here: https://www.salekhventures.com";
const withoutSite = (text: string) => text.split(SITE_LINE).join("");
const LINK = /https?:\/\/|\bwww\.|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|co\.uk|org\.uk|uk|org|net|io|ai|app|dev|info|biz)\b|@/i;
const MONEY_OR_SHARE = /[£$€%]|\bper ?cent\b|\bpercent\b|\bGBP\b/i;

export const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** Signed as Salekh, on its own last line (or the same over two lines). */
export function isSigned(body: string): boolean {
  const lines = body.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  const two = `${lines.at(-2) ?? ""}, ${last}`;
  return last === SIGNATURE || two === SIGNATURE;
}

/**
 * The checks every follow-up must pass before it can be proposed or sent, whoever wrote it (the model, or Salekh
 * editing it): length, signed, no pounds or percentages, no links, and a recipient address that is an address.
 * Returns what is wrong, in plain words. Empty: it passes.
 */
export function lintFollowup(draft: { subject: string; body: string }, to: string | null = null): string[] {
  const problems: string[] = [];
  const subject = draft.subject ?? "";
  const body = (draft.body ?? "").trim();
  if (!subject.trim()) problems.push("the subject is empty");
  if (subject.length > MAX_SUBJECT) problems.push(`the subject is longer than ${MAX_SUBJECT} characters`);
  if (/[\r\n]/.test(subject)) problems.push("the subject has a line break in it");
  if (!body) problems.push("the message is empty");
  if (body.length > MAX_BODY_CHARS) problems.push(`the message is longer than ${MAX_BODY_CHARS} characters`);
  if (wordCount(body) >= MAX_WORDS_WITH_FINDINGS) problems.push(`the message is ${wordCount(body)} words: it must be under ${MAX_WORDS_WITH_FINDINGS}`);
  if (body && !isSigned(body)) problems.push(`it is not signed "${SIGNATURE}" on its last line`);
  if (MONEY_OR_SHARE.test(`${subject}\n${body}`)) problems.push("it has a money figure or a percentage in it (£, $, €, % or per cent)");
  if (LINK.test(withoutSite(`${subject}\n${body}`))) problems.push("it has a link, a web address or an email address in it (other than the line to salekhventures.com)");
  if (to !== null && !EMAIL.test(to)) problems.push("the address it would go to is not a valid email address");
  return problems;
}

/** What the drafting model is held to on top of the checks above. A draft that fails is sent back once. */
export interface DraftRules {
  /** Numbers the message may contain: those in the facts given and in the note. Any other is made up. */
  numbers: string[];
  /** Words that must appear: the stored test result's time, the 20 minute ask. */
  mustInclude: string[];
}

const PROMISE = /\b(guarantee[ds]?|promise[ds]?|we will make sure|risk[- ]free|you will (?:never|always))\b/i;
// "We can automate the search once we connect to your case system" is fine. "It is integrated with your case system" is not.
const ALREADY_INTEGRATED = /\b(?:already|fully|seamlessly)\s+(?:integrat\w*|connect\w*|link\w*|plugged)\b|\b(?:integrates|integrated)\s+(?:with|into)\s+your\b|\b(?:is|are|it's|now)\s+(?:connected|linked|plugged)\s+(?:in)?(?:to|with|into)\s+your\b|\bworks\s+(?:with|inside)\s+your\s+(?:existing\s+)?(?:system|software|case|booking|crm)/i;
const HYPE = /\b(revolutionary|transform\w*|game[- ]chang\w*|cutting[- ]edge|unlock\w*|supercharg\w*)\b/i;

export function lintModelDraft(draft: { subject: string; body: string }, rules: DraftRules): string[] {
  const problems = lintFollowup(draft);
  const text = `${draft.subject}\n${draft.body}`;
  if (PROMISE.test(text)) problems.push("it makes a promise or a guarantee");
  if (ALREADY_INTEGRATED.test(text)) problems.push("it says the product is already connected to or integrated with their systems: say what we could do once connected, not that it is");
  if (HYPE.test(text)) problems.push("it uses hype words");
  if (!/\b20[- ]minute\b/i.test(draft.body) || !/\bthis week\b/i.test(draft.body)) problems.push('it does not end with the ask for "a 20-minute call this week"');
  const allowed = new Set(["20", ...rules.numbers]);
  const made = [...new Set((draft.body.match(/\d+(?:[.,:]\d+)?/g) ?? []).filter((n) => !allowed.has(n)))];
  if (made.length) problems.push(`it has numbers that are not in the facts given: ${made.slice(0, 5).join(", ")}`);
  for (const phrase of rules.mustInclude) if (!draft.body.toLowerCase().includes(phrase.toLowerCase())) problems.push(`it does not state the test result as given ("${phrase}")`);
  return problems;
}

// ---- what the drafting model is given ---------------------------------------------------

/**
 * A money figure or a percentage in text that goes to the model (a call note, what a business sells) is taken
 * out: the model is never given a price, a leak estimate or any other figure in pounds.
 */
export function withoutFigures(text: string): string {
  return text
    .replace(/[£$€]\s?\d[\d,.]*\s?(?:k|m|bn|million|thousand)?\b/gi, "[a figure, left out]")
    .replace(/\b\d[\d,.]*\s?(?:k|m|bn|million|thousand)?\s?(?:pounds?|quid|GBP)\b/gi, "[a figure, left out]")
    .replace(/\b\d[\d,.]*\s?(?:%|per ?cent\b|percent\b)/gi, "[a figure, left out]")
    .replace(/[£$€%]/g, "");
}

const numbersIn = (text: string): string[] => text.match(/\d+(?:[.,:]\d+)?/g) ?? [];

/** The test result as stored, in words, or null when there is none to state (none sent, not judged yet, it bounced). */
export function testResultLine(test: TestResult | null, scored: boolean): { line: string; phrase: string } | null {
  if (!test || test.opted_out || test.replies.some((r) => r.kind === "bounce")) return null;
  const sent = new Date(test.sent_at).getTime();
  const first = test.replies.filter((r) => r.kind === "person").sort((a, b) => a.received_at.localeCompare(b.received_at))[0];
  if (first) {
    const took = sayMinutes((new Date(first.received_at).getTime() - sent) / 60000);
    return { line: `I sent an enquiry as a test and a person replied ${took} after it was sent.`, phrase: took };
  }
  return scored ? { line: "I sent an enquiry as a test and nobody replied in the first 24 hours.", phrase: "24 hours" } : null;
}

/** At most one rival fact, as stored: the fastest rival of the same kind that replied, tested in the same part of the week. */
export function rivalLine(self: { test: TestResult | null }, rivals: PublicFacts[]): { line: string; numbers: string[] } | null {
  const selfFirst = self.test?.replies.filter((r) => r.kind === "person").sort((a, b) => a.received_at.localeCompare(b.received_at))[0];
  const selfMinutes = self.test && selfFirst ? (new Date(selfFirst.received_at).getTime() - new Date(self.test.sent_at).getTime()) / 60000 : null;
  const slot = self.test?.slot ?? null;
  const best = rivals
    .filter((r) => r.tested === "scored" && r.reply_minutes !== null && (!slot || !r.slot || r.slot === slot) && (selfMinutes === null || (r.reply_minutes as number) < selfMinutes))
    .sort((a, b) => (a.reply_minutes as number) - (b.reply_minutes as number))[0];
  if (!best) return null;
  const line = `${best.name} replied to the same kind of enquiry in ${sayMinutes(best.reply_minutes as number)}.`;
  return { line, numbers: numbersIn(line) };
}

/**
 * "What I found": a short list written by code from the stored test results, never by the model, so every line is a
 * fact. The business itself first, then the same-kind businesses nearby that were tested in the same way, fastest
 * first. No money figures (the rules for this email forbid them). Owner, 18 Nov 2026: show the gap, don't describe it.
 */
export function findingsBlock(self: { name: string; area: string | null; test: TestResult | null }, rivals: PublicFacts[], timezone = "Europe/London"): string | null {
  const test = self.test;
  if (!test?.sent_at) return null;
  const first = test.replies.filter((r) => r.kind === "person").sort((a, b) => a.received_at.localeCompare(b.received_at))[0];
  const mins = first ? (new Date(first.received_at).getTime() - new Date(test.sent_at).getTime()) / 60000 : null;
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(test.sent_at)).replace(",", "").replace(/^(\S+) /, "$1 at ");
  const slot = test.slot ?? null;
  const others = rivals
    .filter((r) => r.tested === "scored" && (!slot || !r.slot || r.slot === slot))
    .sort((a, b) => (a.reply_minutes ?? Infinity) - (b.reply_minutes ?? Infinity))
    .slice(0, 3);
  if (others.length === 0) return null;
  const line = (name: string, m: number | null) => `- ${name}: ${m === null ? "no reply within 24 hours" : `replied in ${sayMinutes(m)}`}`;
  return [
    `What I found${self.area ? ` in ${self.area}` : ""}, same question sent on ${when}:`,
    line(`${self.name} (you)`, mins),
    ...others.map((r) => line(r.name.split(" - ")[0] as string, r.reply_minutes)),
  ].join("\n");
}

/** Put the findings list into a drafted email: before the closing question when there is one, else before the sign-off. */
export function withFindings(body: string, block: string | null): string {
  if (!block) return body;
  const parts = body.trim().split(/\n\s*\n/);
  const signAt = parts.findIndex((p) => isSigned(p) || p.includes(SIGNATURE.split(",")[0] as string));
  const at = signAt > 0 && /\?\s*$/.test(parts[signAt - 1] as string) ? signAt - 1 : signAt >= 0 ? signAt : parts.length;
  parts.splice(at, 0, block);
  return parts.join("\n\n");
}

export interface FollowupFactsInput {
  business: string;
  area: string | null;
  kind: string;
  sells: string | null;
  contactName: string | null;
  contactRole: string | null;
  recipientName: string | null;
  outcome: DraftOutcome;
  note: string;
  test: { line: string; phrase: string } | null;
  rival: { line: string; numbers: string[] } | null;
}

const OUTCOME_WORDS: Record<DraftOutcome, string> = {
  interested: "they were interested",
  call_back: "they asked to be called back",
  meeting_booked: "a meeting was booked",
};

/** The facts, as one text, and what the draft is held to. Nothing here carries a price, a leak or a percentage. */
export function followupFacts(input: FollowupFactsInput): { facts: string; rules: DraftRules } {
  const note = withoutFigures(input.note).slice(0, 1000);
  const sells = input.sells ? withoutFigures(input.sells).slice(0, 200) : null;
  const facts = [
    `Business: ${input.business}${input.area ? `, ${input.area}` : ""}`,
    `Kind of business: ${input.kind}`,
    `What they sell (from their website): ${sells ?? "not found"}`,
    `Person named on their website: ${input.contactName ? `${input.contactName}${input.contactRole ? ` (${input.contactRole})` : ""}` : "nobody named"}`,
    `Who the email is to: ${input.recipientName ?? 'not given yet. Open with "Hello," and use no name in the greeting'}`,
    `How the call went: ${OUTCOME_WORDS[input.outcome]}`,
    `Salekh's own note of the call (written by Salekh for himself; use what it says, do not quote it word for word; it may say who referred him):\n----------\n${note}\n----------`,
    input.test
      ? `The test result, as stored. State it exactly, with this time: "${input.test.line}"`
      : "Test result: none to state. Do not mention a test enquiry or any reply time.",
    input.rival ? `One fact about a nearby rival, as stored (you may use it, word for word, or leave it out): "${input.rival.line}"` : "Rivals: nothing to say. Make no comparison.",
  ].join("\n");
  return {
    facts,
    rules: {
      numbers: [...numbersIn(input.business), ...numbersIn(input.area ?? ""), ...numbersIn(note), ...(input.test ? numbersIn(input.test.line) : []), ...(input.rival?.numbers ?? [])],
      mustInclude: input.test ? [input.test.phrase] : [],
    },
  };
}


/** One model call drafts the email; code checks it; a draft that fails is sent back once with what was wrong. */
export async function draftFollowup(model: ModelCaller, apiKey: string, system: string, facts: string, rules: DraftRules): Promise<{ replies: ModelReply<unknown>[]; draft: { subject: string; body: string } | null; problems: string[] }> {
  const replies: ModelReply<unknown>[] = [];
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const user = `Write the follow-up email from these facts and nothing else.\n\n${facts}` +
      (problems.length ? `\n\nYour last draft was not accepted. Fix these and write it again:\n${problems.map((p) => `- ${p}`).join("\n")}` : "");
    const reply = await model.call(apiKey, { stage: "followup", model: FOLLOWUP_MODEL, system, user, schema: followupSchema, maxTokens: 1500, effort: "medium" });
    replies.push(reply);
    if (!reply.ok || !reply.data) return { replies, draft: null, problems: [`the model call failed: ${reply.error ?? "unknown"}`] };
    const draft = { subject: reply.data.subject.trim().replace(/\s+/g, " "), body: reply.data.body.trim() };
    problems = lintModelDraft(draft, rules);
    if (problems.length === 0) return { replies, draft, problems: [] };
  }
  return { replies, draft: null, problems };
}

// ---- in the database ----------------------------------------------------------------------

export type FollowupStatus = "draft" | "waiting" | "approved" | "sending" | "sent" | "failed" | "not_sent";
/** As the API says it. */
const API_STATUS: Record<FollowupStatus, string> = {
  draft: "draft", waiting: "waiting_for_you", approved: "approved", sending: "sending", sent: "sent", failed: "failed", not_sent: "not_sent",
};

export interface FollowupView {
  id: string;
  prospectId: string;
  business: string;
  status: string;
  outcome: string | null;
  to: Recipient | null;
  subject: string;
  body: string;
  /** What the checks found wrong. Empty: it passes. */
  problems: string[];
  /** The hash of exactly what "Send" would send. null without a recipient. Send it back with the decision. */
  payloadHash: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  /** The mailbox it went from. */
  from: string | null;
  copiedAt: string | null;
  /** Why it was not sent, or why it waits (fixed codes). */
  reason: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export const payloadOf = (row: Row): { followup_id: string; prospect_id: string; to: string; subject: string; body: string } | null =>
  row.to_address ? { followup_id: row.followup_id, prospect_id: row.prospect_id, to: row.to_address, subject: row.subject, body: row.body } : null;

function view(row: Row): FollowupView {
  const payload = payloadOf(row);
  return {
    id: row.followup_id, prospectId: row.prospect_id, business: row.name ?? "", status: API_STATUS[row.status as FollowupStatus] ?? row.status,
    outcome: row.outcome ?? null, to: row.to_address ? { name: row.to_name ?? null, email: row.to_address } : null,
    subject: row.subject, body: row.body, problems: (row.problems as string[] | null) ?? [], payloadHash: payload ? hashPayload(payload) : null,
    createdAt: (row.created_at as Date).toISOString(), updatedAt: (row.updated_at as Date).toISOString(),
    sentAt: row.sent_at ? (row.sent_at as Date).toISOString() : null, from: row.from_address ?? null,
    copiedAt: row.copied_at ? (row.copied_at as Date).toISOString() : null, reason: row.not_sent_reason ?? row.failure ?? null,
  };
}

/** Why this business may not be sent a follow-up now, or null. */
async function blockedReason(tx: Tx, prospectId: string, to: string | null, now: Date, except: string | null = null): Promise<string | null> {
  const p = (await tx.query(
    "select business_id, domain_key, companies_house_number, name_postcode_hash, purged_at from prospects where prospect_id = $1",
    [prospectId])).rows[0];
  if (!p || p.purged_at) return "not_found";
  const suppressed = await tx.query(
    `select 1 from suppressions
      where (business_id is null or business_id = $1)
        and ((kind = 'domain' and value_key = $2) or (kind = 'company_number' and value_key = $3)
             or (kind = 'name_postcode' and value_key = $4) or (kind = 'email' and value_key = $5))
      limit 1`,
    [p.business_id, p.domain_key, companyNumberKey(p.companies_house_number), p.name_postcode_hash, to ? to.toLowerCase() : null]);
  const latest = (await tx.query("select outcome from call_outcomes where prospect_id = $1 order by created_at desc, call_outcome_id desc limit 1", [prospectId])).rows[0];
  if (latest?.outcome === "not_interested") return "not_interested";
  if (suppressed.rows.length > 0) return "suppressed";
  const recent = await tx.query("select 1 from followups where prospect_id = $1 and sent_at > $2 and followup_id is distinct from $3 limit 1", [prospectId, new Date(now.getTime() - DAY_MS), except]);
  if (recent.rows.length > 0) return "sent_in_the_last_24_hours";
  return null;
}

/** Withdraw the yes, or the wait for one, behind a follow-up that is no longer what was shown. */
async function voidApproval(tx: Tx, tenantId: string, approvalId: string | null, reason: string, now: Date): Promise<boolean> {
  if (!approvalId) return false;
  const voided = await tx.query(
    "update approvals set status = 'voided', void_reason = $2, decided_at = coalesce(decided_at, $3) where approval_id = $1 and (status = 'pending' or (status = 'approved' and consumed_at is null)) returning business_id, department, proposal_id",
    [approvalId, reason, now]);
  const a = voided.rows[0];
  if (!a) return false;
  await emitEvent(tx, {
    tenantId, businessId: a.business_id, department: a.department, proposalId: a.proposal_id, approvalId,
    actionType: FOLLOWUP_ACTION, type: "voided", reasonCode: reason, now,
    summary: reason === "payload_changed" ? "A follow-up email was changed after it was shown, so its approval is void" : "A follow-up email's approval was withdrawn",
  });
  return true;
}

// ---- the mail connector -----------------------------------------------------------------

/**
 * The connector for `followup.send_email`. It holds the OWNER's mailbox and nothing else holds it. It sends exactly
 * the stored follow-up, once: in the moment before sending it claims the row and checks again that the business is
 * not suppressed, did not say not interested, and was not sent one in the last 24 hours.
 */
export function createFollowupConnector(options: { db: Db; mailbox: Mailbox | null; now?: () => Date; log?: (line: string) => void }): Connector {
  const clock = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.error(line));
  return {
    async execute(call: ConnectorCall): Promise<ConnectorResult> {
      if (!options.mailbox) throw new ControlError("owner_mail_not_configured", "the owner's mailbox is not connected");
      const payload = call.payload as { followup_id: string; prospect_id: string; to: string; subject: string; body: string };
      let before: FollowupStatus = "draft";
      const claimed = await options.db.tx(call.tenantId, async (tx) => {
        const row = (await tx.query("select * from followups where followup_id = $1 and prospect_id = $2 and business_id = $3 for update", [payload.followup_id, payload.prospect_id, call.businessId])).rows[0];
        if (!row) return "no_such_followup";
        if (!["draft", "waiting", "approved"].includes(row.status)) return "already_handled";
        before = row.status;
        // What is sent is what is stored, and what was approved is the same thing.
        if (row.to_address !== payload.to || row.subject !== payload.subject || row.body !== payload.body) return "followup_changed";
        if (lintFollowup(row, row.to_address).length > 0) return "fails_checks";
        const blocked = await blockedReason(tx, payload.prospect_id, payload.to, clock(), payload.followup_id);
        if (blocked) {
          await tx.query("update followups set status = 'not_sent', not_sent_reason = $2, updated_at = $3 where followup_id = $1", [payload.followup_id, blocked, clock()]);
          return blocked;
        }
        await tx.query("update followups set status = 'sending', updated_at = $2 where followup_id = $1", [payload.followup_id, clock()]);
        return null;
      });
      // A fixed code only: an error's own words could carry the address.
      if (claimed) throw new ControlError(claimed, `the follow-up was not sent: ${claimed}`);
      let messageId: string;
      try {
        ({ messageId } = await options.mailbox.send({ to: payload.to, subject: payload.subject, text: payload.body }));
      } catch (err) {
        if (err instanceof MailboxLoginError || err instanceof MailboxUnreachableError) {
          // It certainly did not go: back to where it was.
          await options.db.tx(call.tenantId, (tx) => tx.query("update followups set status = $2, updated_at = $3 where followup_id = $1 and status = 'sending'", [payload.followup_id, before, clock()]));
          log(`follow-up not sent: ${err instanceof MailboxLoginError ? "owner_mailbox_login_failed EAUTH" : `mail_unreachable ${err.networkCode}`} (nothing went)`);
          throw new ControlError(err instanceof MailboxLoginError ? "owner_mailbox_login_failed" : "mail_unreachable", "the follow-up was not sent: nothing went");
        }
        const code = typeof (err as { networkCode?: unknown } | null)?.networkCode === "string" && /^[A-Z0-9_]{1,40}$/.test((err as { networkCode: string }).networkCode) ? (err as { networkCode: string }).networkCode : "UNKNOWN";
        await options.db.tx(call.tenantId, (tx) => tx.query("update followups set status = 'failed', failure = $2, updated_at = $3 where followup_id = $1", [payload.followup_id, `send_failed:${code}`, clock()]));
        log(`follow-up failed to send: send_failed ${code} (not tried again: it may have gone)`);
        throw new ControlError("mail_send_failed", `the mail server did not accept the message (${code})`);
      }
      const sentAt = clock();
      await options.db.tx(call.tenantId, (tx) => tx.query(
        "update followups set status = 'sent', message_id = $2, sent_at = $3, from_address = $4, updated_at = $3 where followup_id = $1",
        [payload.followup_id, messageId, sentAt, options.mailbox?.address ?? null]));
      return { reference: messageId, output: { followup_id: payload.followup_id } };
    },
    async readBack(_call: ConnectorCall, result: ConnectorResult): Promise<ReadBackResult> {
      if (!options.mailbox) return { verified: false };
      return { verified: await options.mailbox.sentContains(result.reference) };
    },
  };
}

// ---- the service the runtime uses --------------------------------------------------------

export interface FollowupDeps {
  db: Db;
  uiDb: Db;
  gateway: Gateway;
  tenantId: string;
  clock: () => Date;
  /** The owner's mailbox. null: not connected, so nothing is sent and the card offers a copy. */
  mailbox: Mailbox | null;
  model: ModelCaller | null;
  apiKey: () => Promise<string | null>;
  whRoot: string;
  usdToGbp: number;
  settingsOf: (businessId: string) => Promise<OutreachSettings>;
  ownerId: () => Promise<string | null>;
  changed: () => void;
}

export type Answer<T> = ({ status: 200 } & T) | { status: 404 } | { status: 409 | 422; reason: string };

export function createFollowups(deps: FollowupDeps) {
  const { db, tenantId } = deps;
  const tx = <T>(fn: (tx: Tx) => Promise<T>) => db.tx(tenantId, fn);
  const event = (t: Tx, businessId: string, reasonCode: string, summary: string) =>
    emitEvent(t, { tenantId, businessId, department: DEPARTMENT, type: "stage", reasonCode, summary, now: deps.clock() });
  const load = (t: Tx, id: string) => t.query("select f.*, p.name from followups f join prospects p on p.prospect_id = f.prospect_id where f.followup_id = $1", [id]).then((r) => r.rows[0] as Row | undefined);

  /** Bring each follow-up into line with the answer its approval was given elsewhere (or its running out). */
  async function sync(): Promise<void> {
    const now = deps.clock();
    await tx(async (t) => {
      await t.query(
        `update followups f
            set status = case when a.status = 'rejected' then 'not_sent'
                              when a.status = 'approved' and a.consumed_at is null and a.expires_at > $1 then 'approved'
                              else 'draft' end,
                not_sent_reason = case when a.status = 'rejected' then 'you_said_do_not_send' else f.not_sent_reason end,
                approval_id = case when a.status = 'rejected' or (a.status = 'approved' and a.consumed_at is null and a.expires_at > $1) then f.approval_id else null end,
                decided_at = coalesce(f.decided_at, a.decided_at), updated_at = $1
           from approvals a
          where a.approval_id = f.approval_id and f.status in ('waiting', 'approved')
            and (a.status in ('rejected', 'expired', 'voided') or a.expires_at <= $1 or (f.status = 'waiting' and a.status = 'approved'))`,
        [now]);
    });
  }

  /**
   * Put a ready draft to the gateway: at rung 2 it then waits for a yes; at rung 3 it is sent there and then (but only
   * when `send` is true: after drafting, or when he presses Send. An edit never sends by itself). Never without a
   * recipient, never with a check failing, never to a business that may not be written to.
   */
  async function propose(id: string, send: boolean): Promise<{ status: FollowupStatus; held: string | null }> {
    const now = deps.clock();
    const ready = await tx(async (t) => {
      const row = await load(t, id);
      if (!row) return { status: "not_sent" as FollowupStatus, held: "not_found" };
      if (row.status !== "draft") return { status: row.status as FollowupStatus, held: null };
      if (!row.to_address) return { status: "draft" as FollowupStatus, held: "no_recipient" };
      const problems = lintFollowup(row, row.to_address);
      if (problems.length > 0) return { status: "draft" as FollowupStatus, held: "fails_checks" };
      const blocked = await blockedReason(t, row.prospect_id, row.to_address, now, id);
      if (blocked) return { status: "draft" as FollowupStatus, held: blocked };
      const rung = Math.min(await readRung(t, row.business_id, FOLLOWUP_ACTION), followupAction.maxRung);
      if (rung >= 3 && !send) return { status: "draft" as FollowupStatus, held: "press_send" };
      if (rung >= 3 && !deps.mailbox) return { status: "draft" as FollowupStatus, held: "no_mailbox" };
      return { row, rung };
    });
    if (!("row" in ready)) return ready;
    const { row } = ready;
    const result = await deps.gateway.submit({
      tenantId, businessId: row.business_id, department: DEPARTMENT, actionType: FOLLOWUP_ACTION,
      actionKey: `followup:${id}:${randomUUID()}`, payload: payloadOf(row),
      // A fixed line: the reasoning is shown in the house, which carries no name or address.
      reason: "Follow-up email after a call",
    });
    deps.changed();
    if (result.outcome === "waiting_approval") {
      await tx((t) => t.query("update followups set status = 'waiting', approval_id = $2, updated_at = $3 where followup_id = $1 and status = 'draft'", [id, result.approvalId, deps.clock()]));
      return { status: "waiting", held: null };
    }
    if (result.outcome === "refused") return { status: "draft", held: result.reason };
    if (result.outcome === "recommended") return { status: "draft", held: "recommend_only" };
    // Executed at rung 3: the connector has marked the row.
    const after = await tx((t) => load(t, id));
    return { status: (after?.status ?? "draft") as FollowupStatus, held: result.outcome === "execution_failed" ? (after?.not_sent_reason ?? after?.failure ?? "not_sent") : null };
  }

  const drafting = new Set<string>();

  /**
   * Draft a follow-up for one business: one model call, checked by code, stored, and put to the gateway if it has a
   * recipient. Replaces any follow-up for the same business that has not gone. Returns why not, when it was not.
   */
  async function draft(prospectId: string, input: { outcome?: DraftOutcome | null; note?: string | null; to?: Recipient | null; callOutcomeId?: string | null }): Promise<{ ok: true; followupId: string; status: FollowupStatus; held: string | null } | { ok: false; why: string }> {
    if (!isUuid(prospectId)) return { ok: false, why: "not_found" };
    const now = deps.clock();
    const found = await tx(async (t) => {
      const p = (await t.query(
        "select prospect_id, business_id, name, area, search_area, business_type, analysis, contact_name, contact_role, test_result, capture_score, purged_at from prospects where prospect_id = $1",
        [prospectId])).rows[0];
      if (!p || p.purged_at) return null;
      const latest = (await t.query("select call_outcome_id, outcome, note from call_outcomes where prospect_id = $1 order by created_at desc, call_outcome_id desc limit 1", [prospectId])).rows[0] ?? null;
      const blocked = await blockedReason(t, prospectId, input.to?.email ?? null, now);
      const rivals = (await t.query("select comparison from prospect_competitors where prospect_id = $1", [prospectId])).rows.map((r) => r.comparison as PublicFacts);
      return { p, latest, blocked: blocked === "sent_in_the_last_24_hours" ? null : blocked, rivals };
    });
    if (!found) return { ok: false, why: "not_found" };
    if (found.blocked) return { ok: false, why: found.blocked };
    const outcome = (input.outcome ?? found.latest?.outcome ?? null) as string | null;
    if (!outcome || !(DRAFT_OUTCOMES as readonly string[]).includes(outcome)) return { ok: false, why: "not_after_this_outcome" };
    const note = (input.note ?? found.latest?.note ?? "").trim();
    if (!note) return { ok: false, why: "no_note" };
    if (!deps.model) return { ok: false, why: "no_model" };
    const apiKey = await deps.apiKey();
    if (!apiKey) return { ok: false, why: "no_api_key" };
    const system = await readFile(path.join(deps.whRoot, "agents", "outreach-followup.md"), "utf8").catch(() => null);
    if (!system) return { ok: false, why: "no_prompt" };

    const p = found.p;
    const settings = forType(await deps.settingsOf(p.business_id), p.business_type);
    const said = (f: unknown) => (typeof f === "object" && f !== null ? String((f as { value?: unknown }).value ?? "") || null : null);
    const test = (p.test_result as TestResult | null) ?? null;
    const { facts, rules } = followupFacts({
      business: p.name, area: p.search_area ?? p.area ?? null, kind: settings.type.name, sells: said(p.analysis?.what_they_sell),
      contactName: p.contact_name ?? null, contactRole: p.contact_role ?? null, recipientName: input.to?.name ?? null,
      outcome: outcome as DraftOutcome, note, test: testResultLine(test, p.capture_score !== null), rival: rivalLine({ test }, found.rivals),
    });

    // The kill switch and the room's budget are checked here, like any run.
    const started = await startRun(db, { tenantId, businessId: p.business_id, department: DEPARTMENT, trigger: "outreach:followup", model: FOLLOWUP_MODEL }, { now });
    if (!started.started) return { ok: false, why: started.reason };
    const totals = noTotals();
    let made: Awaited<ReturnType<typeof draftFollowup>> = { replies: [], draft: null, problems: ["the model call failed"] };
    try {
      made = await draftFollowup(deps.model, apiKey, system, facts, rules);
    } finally {
      for (const reply of made.replies) addTo(totals, reply);
      await finishRun(db, {
        tenantId, runId: started.runId, status: made.draft ? "done" : "failed",
        tokensIn: Math.round(totals.inputTokens + totals.cacheCreationTokens), tokensOut: Math.round(totals.outputTokens), tokensCached: Math.round(totals.cacheReadTokens),
        costUsd: totals.costUsd, costGbp: Math.round(totals.costUsd * deps.usdToGbp * 1e6) / 1e6, ...(made.draft ? {} : { error: "followup_not_drafted" }),
      }, { now: deps.clock() });
    }
    if (!made.draft) {
      await tx((t) => event(t, p.business_id, "followup_not_drafted", "A follow-up email could not be drafted to the written rules"));
      deps.changed();
      return { ok: false, why: "draft_failed" };
    }
    const followupId = randomUUID();
    try {
      await tx(async (t) => {
        await lock(t, "followups", prospectId);
        // One open follow-up per business: an older one that has not gone is set aside, and its yes withdrawn.
        const old = (await t.query("select followup_id, approval_id from followups where prospect_id = $1 and status in ('draft', 'waiting', 'approved')", [prospectId])).rows;
        for (const o of old) {
          await voidApproval(t, tenantId, o.approval_id, "replaced", deps.clock());
          await t.query("update followups set status = 'not_sent', not_sent_reason = 'replaced_by_a_newer_draft', updated_at = $2 where followup_id = $1", [o.followup_id, deps.clock()]);
        }
        const drafted = made.draft as { subject: string; body: string };
        const timezone = (await t.query("select timezone from tenants where tenant_id = wh_tenant()")).rows[0]?.timezone ?? "Europe/London";
        const draftRow = { subject: drafted.subject, body: withFindings(drafted.body, [findingsBlock({ name: p.name, area: p.search_area ?? p.area ?? null, test }, found.rivals, timezone), SITE_LINE].filter(Boolean).join("\n\n")) };
        await t.query(
          `insert into followups (followup_id, tenant_id, business_id, prospect_id, call_outcome_id, outcome, to_name, to_address, subject, body, problems, status, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'draft', $12, $12)`,
          [followupId, tenantId, p.business_id, prospectId, input.callOutcomeId ?? found.latest?.call_outcome_id ?? null, outcome, input.to?.name ?? null, input.to?.email ?? null,
           draftRow.subject, draftRow.body, JSON.stringify(lintFollowup(draftRow, input.to?.email ?? null)), deps.clock()]);
        await event(t, p.business_id, "followup_drafted", "A follow-up email was drafted");
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, why: "already_open" };
      throw err;
    }
    deps.changed();
    const proposed = await propose(followupId, true);
    return { ok: true, followupId, ...proposed };
  }

  /** Draft in the background (the model takes a few seconds). The list says which businesses are being drafted for. */
  function draftLater(prospectId: string, input: Parameters<typeof draft>[1], track: (key: string, work: Promise<void>) => void): void {
    if (drafting.has(prospectId)) return;
    drafting.add(prospectId);
    const work = draft(prospectId, input)
      .then((r) => { if (!r.ok) console.error(`follow-up not drafted: ${r.why}`); })
      .catch((err) => console.error(`follow-up drafting stopped: ${err instanceof Error ? err.name : "error"}`))
      .finally(() => { drafting.delete(prospectId); deps.changed(); });
    track(`followup:${prospectId}`, work);
  }

  async function list(businessId: string): Promise<{ followups: FollowupView[]; rung: number; ownerMailbox: { configured: boolean; address: string | null }; drafting: string[] }> {
    await sync();
    return tx(async (t) => {
      const rows = (await t.query(
        `select f.*, p.name from followups f join prospects p on p.prospect_id = f.prospect_id
          where f.business_id = $1 and (f.status in ('draft', 'waiting', 'approved', 'sending') or f.updated_at > $2)
          order by f.created_at desc, (f.status in ('draft', 'waiting', 'approved', 'sending')) desc, f.followup_id limit 500`,
        [businessId, new Date(deps.clock().getTime() - 30 * DAY_MS)])).rows;
      const rung = Math.min(await readRung(t, businessId, FOLLOWUP_ACTION), followupAction.maxRung);
      const ids = new Set((await t.query("select prospect_id from prospects where business_id = $1 and prospect_id = any ($2::uuid[])", [businessId, [...drafting]])).rows.map((r) => r.prospect_id as string));
      return { followups: rows.map(view), rung, ownerMailbox: { configured: deps.mailbox !== null, address: deps.mailbox?.address ?? null }, drafting: [...ids] };
    });
  }

  /** Salekh changes the subject, the message or the recipient, or notes that he copied it. Any change of what would be sent voids a yes. */
  async function edit(id: string, body: unknown): Promise<Answer<{ followup: FollowupView }>> {
    if (!isUuid(id)) return { status: 404 };
    const b = (body ?? {}) as { subject?: unknown; body?: unknown; to?: unknown; copied?: unknown };
    if (b.subject !== undefined && (typeof b.subject !== "string" || b.subject.length > 200)) return { status: 422, reason: "subject must be text of at most 200 characters" };
    if (b.body !== undefined && (typeof b.body !== "string" || b.body.length > MAX_BODY_CHARS)) return { status: 422, reason: `body must be text of at most ${MAX_BODY_CHARS} characters` };
    if (typeof b.subject === "string" && !b.subject.trim()) return { status: 422, reason: "the subject cannot be empty" };
    if (typeof b.body === "string" && !b.body.trim()) return { status: 422, reason: "the message cannot be empty" };
    if (b.copied !== undefined && b.copied !== true) return { status: 422, reason: "copied can only be true" };
    const recipient = b.to === undefined ? null : checkRecipient(b.to);
    if (recipient && !recipient.ok) return { status: 422, reason: recipient.reason };
    await sync();
    const now = deps.clock();
    const done = await tx(async (t): Promise<Answer<{ changed: boolean }>> => {
      const row = (await t.query("select * from followups where followup_id = $1 for update", [id])).rows[0];
      if (!row) return { status: 404 };
      const next = {
        subject: typeof b.subject === "string" ? b.subject.trim().replace(/\s+/g, " ") : row.subject,
        body: typeof b.body === "string" ? b.body.replace(/\r\n/g, "\n").trim() : row.body,
        to_name: recipient?.ok ? (recipient.to?.name ?? null) : row.to_name,
        to_address: recipient?.ok ? (recipient.to?.email ?? null) : row.to_address,
      };
      const changed = next.subject !== row.subject || next.body !== row.body || next.to_address !== row.to_address || next.to_name !== row.to_name;
      if (changed && !["draft", "waiting", "approved"].includes(row.status)) return { status: 409, reason: row.status === "sent" || row.status === "sending" ? "already_sent" : `cannot_change_${row.status}` };
      if (b.copied === true) {
        await t.query("update followups set copied_at = $2, updated_at = $2 where followup_id = $1", [id, now]);
        await event(t, row.business_id, "followup_copied", "A follow-up email was copied, to be sent by hand");
      }
      if (!changed) return { status: 200, changed: false };
      // What was shown is no longer what would be sent: the yes, or the wait for one, is void, and it is a draft again.
      const payloadChanged = next.subject !== row.subject || next.body !== row.body || next.to_address !== row.to_address;
      if (payloadChanged) await voidApproval(t, tenantId, row.approval_id, "payload_changed", now);
      await t.query(
        `update followups set subject = $2, body = $3, to_name = $4, to_address = $5, problems = $6::jsonb, updated_at = $7,
                status = case when $8 then 'draft' else status end, approval_id = case when $8 then null else approval_id end
          where followup_id = $1`,
        [id, next.subject, next.body, next.to_name, next.to_address, JSON.stringify(lintFollowup(next, next.to_address)), now, payloadChanged]);
      await event(t, row.business_id, "followup_edited", "A follow-up email was edited");
      return { status: 200, changed: payloadChanged };
    });
    if (done.status !== 200) return done;
    // At rung 2 a changed draft that passes is put to the gateway afresh, to wait for a yes on what it now says.
    if (done.changed) await propose(id, false);
    deps.changed();
    const row = await tx((t) => load(t, id));
    return row ? { status: 200, followup: view(row) } : { status: 404 };
  }

  /** "Send" or "Don't send", from the card. A yes carries the hash of what was shown. */
  async function decide(id: string, body: unknown): Promise<Answer<{ result: { status: string; reason?: string } }>> {
    const { decision, payloadHash } = (body ?? {}) as { decision?: unknown; payloadHash?: unknown };
    if (decision !== "send" && decision !== "dont_send") return { status: 422, reason: "decision must be send or dont_send" };
    if (decision === "send" && typeof payloadHash !== "string") return { status: 422, reason: "payloadHash is needed with send: the hash of what you were shown" };
    if (!isUuid(id)) return { status: 404 };
    const member = await deps.ownerId();
    if (!member) return { status: 409, reason: "no_owner" };
    await sync();
    const say = (status: FollowupStatus, reason?: string | null) => ({ status: 200 as const, result: reason ? { status: API_STATUS[status], reason } : { status: API_STATUS[status] } });
    const now = deps.clock();
    let row = await tx((t) => load(t, id));
    if (!row) return { status: 404 };

    if (decision === "dont_send") {
      if (row.status === "sent" || row.status === "sending") return { status: 409, reason: "already_sent" };
      if (row.status === "failed") return { status: 409, reason: "already_tried" };
      if (row.status === "not_sent") return say("not_sent", row.not_sent_reason);
      if (row.status === "waiting" && row.approval_id) {
        await decideApproval(db, { tenantId, approvalId: row.approval_id, memberId: member, decision: "reject", channel: "app" }, { now });
      }
      await tx(async (t) => {
        if (row?.approval_id) await voidApproval(t, tenantId, row.approval_id, "not_sent_by_owner", now);
        await t.query("update followups set status = 'not_sent', not_sent_reason = 'you_said_do_not_send', decided_at = $2, updated_at = $2 where followup_id = $1 and status in ('draft', 'waiting', 'approved')", [id, now]);
        await event(t, row?.business_id, "followup_not_sent", "A follow-up email was marked not to send");
      });
      deps.changed();
      return say("not_sent", "you_said_do_not_send");
    }

    // send
    if (row.status === "sent") return { status: 409, reason: "already_sent" };
    if (row.status === "sending") return { status: 409, reason: "already_sending" };
    if (row.status === "failed") return { status: 409, reason: "already_tried" };
    if (row.status === "not_sent") return { status: 409, reason: row.not_sent_reason ?? "not_sent" };
    const payload = payloadOf(row);
    if (!payload) return { status: 409, reason: "no_recipient" };
    if (hashPayload(payload) !== payloadHash) return { status: 409, reason: "payload_mismatch" };
    if (lintFollowup(row, row.to_address).length > 0) return { status: 409, reason: "fails_checks" };

    if (row.status === "draft") {
      const proposed = await propose(id, true);
      if (proposed.status !== "waiting") return proposed.status === "draft" ? { status: 409, reason: proposed.held ?? "not_sent" } : say(proposed.status, proposed.held);
      row = await tx((t) => load(t, id));
      if (!row) return { status: 404 };
    }
    if (row.status === "waiting") {
      const decided = await decideApproval(db, { tenantId, approvalId: row.approval_id, memberId: member, decision: "approve", payloadHash, channel: "app" }, { now });
      if (decided.outcome !== "approved") {
        await sync();
        return { status: 409, reason: "reason" in decided ? decided.reason : "refused" };
      }
      await tx((t) => t.query("update followups set status = 'approved', decided_at = $2, updated_at = $2 where followup_id = $1 and status = 'waiting'", [id, now]));
      deps.changed();
    }
    // Approved. With no owner mailbox it stops here: nothing is sent, and the card says to copy it and send it yourself.
    if (!deps.mailbox) return say("approved", "no_mailbox");
    const fresh = await tx((t) => load(t, id));
    if (!fresh?.approval_id) return { status: 409, reason: "not_approved" };
    const done = await deps.gateway.executeApproval({ tenantId, approvalId: fresh.approval_id });
    deps.changed();
    if (done.outcome === "refused") {
      // A yes that can no longer be used: it is a draft again. Anything else (kill switch, cap) leaves the yes to try again later.
      if (["expired", "payload_changed", "not_approved", "already_used", "not_found"].includes(done.reason)) await sync();
      return say("approved", done.reason);
    }
    const after = await tx((t) => load(t, id));
    return say((after?.status ?? "approved") as FollowupStatus, done.outcome === "execution_failed" ? (after?.not_sent_reason ?? after?.failure ?? "not_sent") : null);
  }

  /** An answer given to a follow-up's approval through the general approvals route: the same code as the card's buttons. */
  async function decideByApproval(approvalId: string, decision: "approve" | "reject", payloadHash: string | undefined): Promise<Answer<{ result: { status: string; reason?: string } }> | null> {
    const id = await tx(async (t) => (await t.query("select followup_id from followups where approval_id = $1", [approvalId])).rows[0]?.followup_id as string | undefined);
    if (!id) return null;
    const hash = payloadHash ?? (await tx(async (t) => (await t.query("select payload_hash from approvals where approval_id = $1", [approvalId])).rows[0]?.payload_hash as string | undefined));
    return decide(id, decision === "approve" ? { decision: "send", payloadHash: hash } : { decision: "dont_send" });
  }

  /** The owner's switch: 2, each needs his yes; 3, sent without asking (inside the cap and the checks). A new version of the rung, with a reason. */
  async function setRung(businessId: string, body: unknown): Promise<Answer<{ rung: number }>> {
    const { rung, reason } = (body ?? {}) as { rung?: unknown; reason?: unknown };
    if (rung !== 2 && rung !== 3) return { status: 422, reason: "rung must be 2 (ask me first) or 3 (send without asking)" };
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 300)) return { status: 422, reason: "reason must be text of at most 300 characters" };
    if (rung > followupAction.maxRung) return { status: 422, reason: "above the ceiling fixed in code" };
    const member = await deps.ownerId();
    if (!member) return { status: 409, reason: "no_owner" };
    const why = typeof reason === "string" && reason.trim() ? reason.trim()
      : rung === 3 ? "the owner chose, from the call list, not to be asked before each follow-up email is sent" : "the owner chose, from the call list, to be asked before each follow-up email is sent";
    // The UI's role, as the owner: the gateway's role may only ever lower a rung by itself.
    await deps.uiDb.tx(tenantId, async (t) => {
      await requireOwner(t, member);
      const current = Math.min(await readRung(t, businessId, FOLLOWUP_ACTION), followupAction.maxRung);
      if (current === rung) return;
      const scope = { tenantId, businessId, kind: "rung" as const, key: FOLLOWUP_ACTION };
      await writeVersion(t, { ...scope, value: { rung }, changedByKind: "member", memberId: member, reason: why, now: deps.clock() });
      await emitEvent(t, {
        tenantId, businessId, type: "config_changed", actionType: FOLLOWUP_ACTION, rung, reasonCode: "rung", now: deps.clock(),
        summary: rung === 3 ? "Follow-up emails now send without asking (rung 3)" : "Follow-up emails now wait for a yes (rung 2)",
        payload: { from: current, to: rung, reason: why, by: member },
      });
    });
    deps.changed();
    return { status: 200, rung };
  }

  return { draft, draftLater, list, edit, decide, decideByApproval, setRung, sync, propose, drafting };
}

export type Followups = ReturnType<typeof createFollowups>;
