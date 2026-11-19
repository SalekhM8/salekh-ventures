import type { Db, Tx } from "../control/db.js";
import { emitEvent } from "../control/events.js";
import { companyNumberKey } from "./normalise.js";

/**
 * What happened when Salekh telephoned a business from the call list. Append only: each call adds a row and the
 * history is kept. The note is PERSONAL DATA (it may name the person spoken to): it lives in call_outcomes and is
 * read back only through GET /v1/rooms/:roomId/calls. Events carry a fixed line and nothing of it.
 */

export const CALL_OUTCOMES = ["no_answer", "call_back", "interested", "meeting_booked", "not_interested", "wrong_person"] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
/** The outcomes that may carry a date to ring again. */
export const FOLLOW_UP_OUTCOMES: readonly CallOutcome[] = ["call_back", "interested"];
export const MAX_NOTE = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPARTMENT = "outreach";
/** The fixed reason on a suppression added by the owner's own "not interested". Only these can be lifted by putting a business back (0019). */
export const CALL_LIST_REASON = "said not interested when telephoned from the call list";
export const MAX_PUT_BACK_REASON = 300;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CallRecord {
  outcome: CallOutcome;
  note: string | null;
  followUpOn: string | null;
  at: string;
}

export interface CallsOfProspect {
  prospectId: string;
  name: string;
  latest: CallRecord | null;
  /** Newest first. */
  history: CallRecord[];
  /** When the owner put it back after its latest "not interested", or null. It is then to be called again. */
  putBackAt: string | null;
  /** Its latest call was "not interested", it is not put back yet, and it never asked to be left alone: "Put back" may be offered. */
  canPutBack: boolean;
}

type Checked = { ok: true; outcome: CallOutcome; note: string | null; followUpOn: string | null } | { ok: false; reason: string };

/** The body of POST /v1/prospects/:id/outcome, checked. */
export function checkOutcome(body: unknown): Checked {
  const b = (body ?? {}) as { outcome?: unknown; note?: unknown; followUpOn?: unknown };
  if (typeof b.outcome !== "string" || !(CALL_OUTCOMES as readonly string[]).includes(b.outcome)) {
    return { ok: false, reason: `outcome must be one of ${CALL_OUTCOMES.join(", ")}` };
  }
  const outcome = b.outcome as CallOutcome;
  if (b.note !== undefined && b.note !== null && typeof b.note !== "string") return { ok: false, reason: "note must be text" };
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;
  if (note && note.length > MAX_NOTE) return { ok: false, reason: `note must be at most ${MAX_NOTE} characters` };
  let followUpOn: string | null = null;
  if (b.followUpOn !== undefined && b.followUpOn !== null && b.followUpOn !== "") {
    if (typeof b.followUpOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.followUpOn)) return { ok: false, reason: "followUpOn must be a date, YYYY-MM-DD" };
    const d = new Date(`${b.followUpOn}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== b.followUpOn) return { ok: false, reason: "followUpOn must be a real date, YYYY-MM-DD" };
    if (!FOLLOW_UP_OUTCOMES.includes(outcome)) return { ok: false, reason: "a follow up date goes only with call_back or interested" };
    followUpOn = b.followUpOn;
  }
  return { ok: true, outcome, note, followUpOn };
}

/**
 * Record one outcome. "not_interested" also suppresses the business for good, by every key it is known by (its
 * website, its company number, its name and postcode, and the addresses it was written to or publishes), so it is
 * never sent an enquiry again and never found again. Returns false for a prospect that is not known.
 */
export async function recordOutcome(db: Db, tenantId: string, prospectId: string, input: { outcome: CallOutcome; note: string | null; followUpOn: string | null }, now: Date): Promise<boolean> {
  if (!UUID.test(prospectId)) return false;
  return db.tx(tenantId, async (tx) => {
    const p = (await tx.query(
      "select prospect_id, business_id, domain_key, companies_house_number, name_postcode_hash, contact_routes from prospects where prospect_id = $1 and purged_at is null",
      [prospectId])).rows[0];
    if (!p) return false;
    await tx.query(
      "insert into call_outcomes (tenant_id, business_id, prospect_id, outcome, note, follow_up_on, created_at) values ($1, $2, $3, $4, $5, $6, $7)",
      [tenantId, p.business_id, prospectId, input.outcome, input.note, input.followUpOn, now]);
    if (input.outcome === "not_interested") {
      const add = (kind: string, key: string | null) => key
        ? tx.query(
            `insert into suppressions (tenant_id, business_id, kind, value_key, reason, source) values ($1, null, $2, $3, $4, 'manual')
             on conflict (tenant_id, kind, value_key) do nothing`,
            [tenantId, kind, key, CALL_LIST_REASON])
        : Promise.resolve();
      await add("domain", p.domain_key);
      await add("company_number", companyNumberKey(p.companies_house_number));
      await add("name_postcode", p.name_postcode_hash);
      const sent = (await tx.query("select distinct to_address_key from enquiries where prospect_id = $1", [prospectId])).rows.map((r) => r.to_address_key as string);
      const published = ((p.contact_routes ?? []) as { kind?: string; value?: unknown }[])
        .filter((r) => r.kind === "email" && typeof r.value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.value.trim()))
        .map((r) => (r.value as string).trim().toLowerCase());
      for (const email of new Set([...sent, ...published])) await add("email", email);
    }
    // A fixed line: no name, no note, no outcome that could be tied to a business from the house view.
    await emitEvent(tx, { tenantId, businessId: p.business_id, department: DEPARTMENT, type: "stage", reasonCode: "call_outcome_recorded", summary: "A call outcome was recorded", now });
    return true;
  });
}

/** Every business in one room that has a card or any recorded call, with its calls newest first. PERSONAL DATA (the notes). */
export async function listCalls(db: Db, tenantId: string, businessId: string): Promise<CallsOfProspect[]> {
  return db.tx(tenantId, async (tx) => {
    const prospects = (await tx.query(
      `select p.prospect_id, p.name from prospects p
        where p.business_id = $1 and p.purged_at is null
          and (p.card is not null or exists (select 1 from call_outcomes c where c.prospect_id = p.prospect_id))
        order by p.shortlisted_at desc nulls last, p.name, p.prospect_id`,
      [businessId])).rows;
    const calls = (await tx.query(
      "select prospect_id, outcome, note, to_char(follow_up_on, 'YYYY-MM-DD') as follow_up_on, created_at from call_outcomes where business_id = $1 order by created_at desc, call_outcome_id",
      [businessId])).rows;
    const by = new Map<string, CallRecord[]>();
    for (const c of calls) {
      const list = by.get(c.prospect_id as string) ?? [];
      list.push({ outcome: c.outcome, note: c.note ?? null, followUpOn: c.follow_up_on ?? null, at: (c.created_at as Date).toISOString() });
      by.set(c.prospect_id as string, list);
    }
    const backOf = new Map((await tx.query(
      "select prospect_id, max(created_at) as at from owner_put_backs where business_id = $1 group by prospect_id",
      [businessId])).rows.map((b) => [b.prospect_id as string, b.at as Date]));
    // Those whose latest call was "not interested": can they be put back, and does a put-back still hold?
    const held = new Set<string>();
    for (const p of prospects) {
      const id = p.prospect_id as string;
      if (by.get(id)?.[0]?.outcome === "not_interested" && (await heldByThem(tx, id)).held) held.add(id);
    }
    return prospects.map((p) => {
      const id = p.prospect_id as string;
      const history = by.get(id) ?? [];
      const latest = history[0] ?? null;
      const back = backOf.get(id);
      const notInterested = latest?.outcome === "not_interested";
      const putBackAt = latest && notInterested && back && back.getTime() > new Date(latest.at).getTime() && !held.has(id) ? back.toISOString() : null;
      return { prospectId: id, name: p.name as string, latest, history, putBackAt, canPutBack: notInterested && !putBackAt && !held.has(id) };
    });
  });
}

/**
 * Is this business held off by something it did itself, or by anything other than the owner's own call? Its own
 * opt-out, complaint or bounce (on any record of the same business), or a suppression on any of its keys that is not
 * the call list's (an opt-out, a complaint, one added by hand). Also returns the suppressions its keys match.
 */
async function heldByThem(tx: Tx, prospectId: string): Promise<{ held: boolean; matched: { suppression_id: string }[] }> {
  const p = (await tx.query(
    "select business_id, domain_key, companies_house_number, name_postcode_hash, contact_routes, wh_business_asked_off(prospect_id) as off from prospects where prospect_id = $1",
    [prospectId])).rows[0];
  if (!p) return { held: true, matched: [] };
  // Every key it is known by, as recordOutcome suppresses them.
  const sent = (await tx.query("select distinct to_address_key from enquiries where prospect_id = $1", [prospectId])).rows.map((r) => r.to_address_key as string);
  const published = ((p.contact_routes ?? []) as { kind?: string; value?: unknown }[])
    .filter((r) => r.kind === "email" && typeof r.value === "string" && EMAIL.test(r.value.trim()))
    .map((r) => (r.value as string).trim().toLowerCase());
  const keys = ([
    ["domain", p.domain_key], ["company_number", companyNumberKey(p.companies_house_number)], ["name_postcode", p.name_postcode_hash],
    ...[...new Set([...sent, ...published])].map((e) => ["email", e]),
  ] as [string, string | null][]).filter((k): k is [string, string] => Boolean(k[1]));
  const matched = keys.length === 0 ? [] : (await tx.query(
    `select suppression_id, source, reason from suppressions
      where (business_id is null or business_id = $1) and (kind, value_key) in (select * from unnest($2::text[], $3::text[]))`,
    [p.business_id, keys.map((k) => k[0]), keys.map((k) => k[1])])).rows;
  const other = matched.some((m) => m.source !== "manual" || m.reason !== CALL_LIST_REASON);
  return { held: p.off === true || other, matched: matched as { suppression_id: string }[] };
}

export type PutBackResult =
  | { ok: true; lifted: number }
  | { ok: false; status: 404 | 409; reason: "not_found" | "not_after_this_outcome" | "they_asked_not_to_be_contacted" };

/**
 * The owner undoes his own "not interested": the business goes back on the call list and may be contacted again.
 * Only the suppressions his call outcome added are lifted, by an append-only record (0019); the suppressions stay.
 * Refused when the business, or any record of the same business, asked not to be contacted, complained or bounced,
 * or when any of its keys is suppressed for a reason other than his call. Putting back twice changes nothing more.
 * A later "not interested" suppresses it again.
 */
export async function putBack(db: Db, tenantId: string, prospectId: string, reason: string, now: Date): Promise<PutBackResult> {
  if (!UUID.test(prospectId)) return { ok: false, status: 404, reason: "not_found" };
  return db.tx(tenantId, async (tx) => {
    const p = (await tx.query(
      "select prospect_id, business_id, domain_key, companies_house_number, name_postcode_hash, contact_routes from prospects where prospect_id = $1 and purged_at is null",
      [prospectId])).rows[0];
    if (!p) return { ok: false, status: 404, reason: "not_found" };
    const latest = (await tx.query("select outcome, created_at from call_outcomes where prospect_id = $1 order by created_at desc, call_outcome_id desc limit 1", [prospectId])).rows[0];
    if (latest?.outcome !== "not_interested") return { ok: false, status: 409, reason: "not_after_this_outcome" };
    const { held, matched } = await heldByThem(tx, prospectId);
    if (held) return { ok: false, status: 409, reason: "they_asked_not_to_be_contacted" };
    const already = (await tx.query("select 1 from owner_put_backs where prospect_id = $1 and created_at > $2 limit 1", [prospectId, latest.created_at])).rows.length > 0;
    if (already) return { ok: true, lifted: 0 };
    await tx.query(
      "insert into owner_put_backs (tenant_id, business_id, prospect_id, reason, lifted, created_at) values ($1, $2, $3, $4, $5::uuid[], $6)",
      [tenantId, p.business_id, prospectId, reason, matched.map((m) => m.suppression_id), now]);
    // A fixed line: no name.
    await emitEvent(tx, { tenantId, businessId: p.business_id, department: DEPARTMENT, type: "stage", reasonCode: "put_back_by_owner", summary: "The owner put a business back on the call list", now });
    return { ok: true, lifted: matched.length };
  });
}

// ---- how long the words are kept (0020) -------------------------------------

export const DEFAULT_KEEP_NOTES_MONTHS = 12;
export const CLEARED_TEXT = "(removed after the time it is kept)";

/** WH_NOTES_KEEP_MONTHS: a whole number of months from 1 to 120. Anything else is the default, 12. */
export function keepNotesMonths(value: string | undefined): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= 120 ? n : DEFAULT_KEEP_NOTES_MONTHS;
}

/**
 * For each business with no new call and no new follow-up for `months`, blank the words: every call's note, and the
 * subject, body and recipient's name of every finished follow-up. The outcomes, their dates, and that an email was
 * sent (when, and to which address) are kept. Meant to run daily. Returns how many notes and emails were cleared.
 */
export async function clearOldNotes(db: Db, tenantId: string, months: number, now: Date): Promise<{ notes: number; emails: number }> {
  return db.tx(tenantId, async (tx) => {
    const quiet = `
      select prospect_id from (
        select prospect_id, created_at as at from call_outcomes
        union all
        select prospect_id, greatest(created_at, updated_at, sent_at, decided_at) from followups
      ) a group by prospect_id
      having max(at) < ($1::timestamptz - make_interval(months => $2::int))`;
    const notes = (await tx.query(`update call_outcomes set note = null where note is not null and prospect_id in (${quiet}) returning business_id`, [now, months])).rows;
    const emails = (await tx.query(
      `update followups set subject = $3, body = $3, to_name = null, cleared_at = $1
        where cleared_at is null and status in ('sent', 'failed', 'not_sent') and prospect_id in (${quiet}) returning business_id`,
      [now, months, CLEARED_TEXT])).rows;
    const byBusiness = new Map<string, { notes: number; emails: number }>();
    for (const [rows, key] of [[notes, "notes"], [emails, "emails"]] as const) {
      for (const r of rows) {
        const c = byBusiness.get(r.business_id as string) ?? { notes: 0, emails: 0 };
        c[key] += 1;
        byBusiness.set(r.business_id as string, c);
      }
    }
    for (const [businessId, c] of byBusiness) {
      await emitEvent(tx, {
        tenantId, businessId, department: DEPARTMENT, type: "stage", reasonCode: "old_call_notes_cleared",
        summary: `Old words cleared: ${c.notes} call notes and ${c.emails} follow-up emails`, now,
      });
    }
    return { notes: notes.length, emails: emails.length };
  });
}
