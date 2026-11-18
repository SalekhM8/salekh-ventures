import type { Db } from "../control/db.js";
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
            `insert into suppressions (tenant_id, business_id, kind, value_key, reason, source) values ($1, null, $2, $3, 'said not interested when telephoned from the call list', 'manual')
             on conflict (tenant_id, kind, value_key) do nothing`,
            [tenantId, kind, key])
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
    return prospects.map((p) => {
      const history = by.get(p.prospect_id as string) ?? [];
      return { prospectId: p.prospect_id as string, name: p.name as string, latest: history[0] ?? null, history };
    });
  });
}
