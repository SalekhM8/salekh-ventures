import type { Db, Tx } from "./db.js";
import { ControlError } from "./errors.js";

/**
 * The event stream (BRIEF.md section 9). Everything the UI shows is built
 * from these rows, so every step of every run and every action writes one.
 *
 * The list matches the check constraint on events.type. The first group is
 * the brief's own list for agent runs. The rest are the gateway's and the
 * settings screen's steps.
 */
export const EVENT_TYPES = [
  "started", "brief", "tool_call", "done", "failed", "handoff", "run_refused",
  "output", "metrics_pulled", "acknowledged", "scored", "stage", "scheduled",
  "proposal", "refused", "waiting", "notified",
  "approved", "rejected", "expired", "voided", "answer_refused",
  "executing", "executed", "execution_failed", "verified", "verify_failed",
  "demoted", "marked_wrong",
  "kill_switch_engaged", "kill_switch_resumed", "config_changed", "health",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Full payloads are kept for 90 days, then cleared. Summaries stay. */
export const PAYLOAD_LIFE_MS = 90 * 24 * 60 * 60 * 1000;

export interface EventInput {
  tenantId: string;
  businessId?: string | null;
  department?: string | null;
  runId?: string | null;
  proposalId?: string | null;
  approvalId?: string | null;
  actionId?: string | null;
  type: EventType;
  /** What happened, with no names and no message text. */
  summary: string;
  /** A fixed code from the action list. Never text supplied from outside. */
  actionType?: string | null;
  rung?: number | null;
  /** A fixed lower case code, for example cap_exceeded. */
  reasonCode?: string | null;
  /** The full detail. May hold personal data, so it has a 90 day life. */
  payload?: unknown;
  now?: Date;
}

// A backstop only. The real control is that summaries are fixed lines written
// by code, never text passed through from a customer or an agent.
const LOOKS_LIKE_EMAIL = /\S+@\S+\.\S+/;
const LOOKS_LIKE_PHONE = /\d(?:[\s-]?\d){6,}/;

function assertSummaryIsClean(summary: string): void {
  if (LOOKS_LIKE_EMAIL.test(summary) || LOOKS_LIKE_PHONE.test(summary)) {
    throw new ControlError(
      "invalid_event",
      "event summary looks like it holds personal data (an email address or a phone number). Put detail in the payload.",
    );
  }
}

/** Write one event inside the caller's transaction. Returns its sequence number. */
export async function emitEvent(tx: Tx, event: EventInput): Promise<number> {
  assertSummaryIsClean(event.summary);
  const now = event.now ?? new Date();
  const hasPayload = event.payload !== undefined && event.payload !== null;
  const result = await tx.query(
    `insert into events
       (tenant_id, business_id, department, run_id, proposal_id, approval_id, action_id,
        type, summary, action_type, rung, reason_code, payload, payload_expires_at, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
     returning seq`,
    [
      event.tenantId,
      event.businessId ?? null,
      event.department ?? null,
      event.runId ?? null,
      event.proposalId ?? null,
      event.approvalId ?? null,
      event.actionId ?? null,
      event.type,
      event.summary,
      event.actionType ?? null,
      event.rung ?? null,
      event.reasonCode ?? null,
      hasPayload ? JSON.stringify(event.payload) : null,
      hasPayload ? new Date(now.getTime() + PAYLOAD_LIFE_MS) : null,
      now,
    ],
  );
  return Number(result.rows[0].seq);
}

export interface EventRow {
  seq: number;
  eventId: string;
  tenantId: string;
  businessId: string | null;
  department: string | null;
  runId: string | null;
  proposalId: string | null;
  approvalId: string | null;
  actionId: string | null;
  type: EventType;
  summary: string;
  actionType: string | null;
  rung: number | null;
  reasonCode: string | null;
  createdAt: Date;
  /** Only filled when asked for with `withPayload`. */
  payload: unknown;
  payloadExpiresAt: Date | null;
}

export interface ListEventsInput {
  tenantId: string;
  /** Only events after this sequence number: how a live view catches up. */
  afterSeq?: number;
  limit?: number;
  withPayload?: boolean;
}

/** Events for one tenant in order. A snapshot on load, then `afterSeq` for what is new. */
export async function listEvents(db: Db, input: ListEventsInput): Promise<EventRow[]> {
  return db.tx(input.tenantId, async (tx) => {
    const result = await tx.query(
      `select seq, event_id, tenant_id, business_id, department, run_id, proposal_id, approval_id,
              action_id, type, summary, action_type, rung, reason_code, created_at,
              case when $3 then payload end as payload, payload_expires_at
         from events
        where seq > $1
        order by seq
        limit $2`,
      [input.afterSeq ?? 0, input.limit ?? 10_000, input.withPayload === true],
    );
    return result.rows.map((r) => ({
      seq: Number(r.seq),
      eventId: r.event_id,
      tenantId: r.tenant_id,
      businessId: r.business_id,
      department: r.department,
      runId: r.run_id,
      proposalId: r.proposal_id,
      approvalId: r.approval_id,
      actionId: r.action_id,
      type: r.type,
      summary: r.summary,
      actionType: r.action_type,
      rung: r.rung,
      reasonCode: r.reason_code,
      createdAt: r.created_at,
      payload: r.payload ?? null,
      payloadExpiresAt: r.payload_expires_at,
    }));
  });
}

/**
 * Clear every payload whose 90 days are up. The row and its summary stay.
 * Returns how many were cleared. Meant to be run daily by the scheduler.
 */
export async function purgeExpiredPayloads(db: Db, input: { tenantId: string }, now = new Date()): Promise<number> {
  return db.tx(input.tenantId, async (tx) => {
    const result = await tx.query(
      `update events set payload = null, payload_expires_at = null
        where payload is not null and payload_expires_at <= $1`,
      [now],
    );
    return result.rowCount ?? 0;
  });
}
