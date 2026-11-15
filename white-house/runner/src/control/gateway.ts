import { z } from "zod";
import type { ActionType, ActionTypeRegistry, Rung } from "./action-types.js";
import { DEFAULT_APPROVAL_TTL_MS, decideApproval, type ApprovalAnswer, type DecideResult } from "./approvals.js";
import { demoteRung, readCurrent, readKillSwitch, readRung } from "./config.js";
import type { Connector, ConnectorCall, ConnectorResult } from "./connectors/connector.js";
import { isUuid, lock, type Db, type Tx } from "./db.js";
import { ControlError } from "./errors.js";
import { emitEvent, type EventInput } from "./events.js";
import { hashPayload } from "./hash.js";
import { requireOwnerOrApprover } from "./members.js";
import { readBudget, tenantDay } from "./runs.js";

/**
 * The gateway (BRIEF.md section 8): the only part of the system that can act
 * on anything outside it. An agent's tool hands it a request. It checks, in
 * this order:
 *
 *   1. kill switch            5. hard ceiling
 *   2. floor active           6. cap
 *   3. action type on list    7. key not seen before
 *   4. rung                   8. department budget
 *
 * and then does what the rung says:
 *
 *   1  recommend            store the proposal, execute nothing
 *   2  act with approval    store payload and hash, tell Salekh, wait
 *   3  act and notify       execute, read back, tell Salekh
 *   4  act silently         execute, read back, log only
 *
 * Every step writes an event. Everything executed, or tried, has a row in
 * `actions`. A read back that fails demotes the action type one rung.
 */

const uuid = z.string().refine(isUuid, "not a uuid");

const requestShape = z.object({
  tenantId: uuid,
  businessId: uuid,
  department: z.string().regex(/^[a-z][a-z0-9-]{0,59}$/),
  actionType: z.string().min(1).max(100),
  payload: z.unknown(),
  /** Why the agent wants this done. Required: no reason, no action. */
  reason: z.string().trim().min(1).max(4000),
  /** Unique to this action. The same key never executes twice. */
  actionKey: z.string().min(1).max(200),
  runId: uuid.optional(),
});

export type ActionRequest = z.infer<typeof requestShape>;

export type RefusalReason =
  | "kill_switch"
  | "unknown_business"
  | "floor_inactive"
  | "unknown_action_type"
  | "invalid_payload"
  | "cap_not_configured"
  | "cap_unreadable"
  | "cap_exceeded"
  | "duplicate_key"
  | "budget_not_configured"
  | "budget_exceeded"
  // only when carrying out an approval:
  | "not_found"
  | "not_approved"
  | "already_used"
  | "expired"
  | "payload_changed"
  | "rung_too_low";

export interface Refused {
  outcome: "refused";
  reason: RefusalReason;
  proposalId: string | null;
}

export interface Executed {
  outcome: "executed";
  proposalId: string;
  actionId: string;
  rung: Rung;
  /** true: read back and confirmed. false: read back failed. null: no read back possible. */
  verified: boolean | null;
  /** Present when a failed read back demoted the action type: the new rung. */
  demotedTo?: Rung;
}

export interface ExecutionFailed {
  outcome: "execution_failed";
  proposalId: string;
  actionId: string;
  rung: Rung;
  error: string;
}

export type SubmitResult =
  | Refused
  | { outcome: "recommended"; proposalId: string; rung: 1 }
  | { outcome: "waiting_approval"; proposalId: string; approvalId: string; payloadHash: string; expiresAt: Date; rung: 2 }
  | Executed
  | ExecutionFailed;

export type AnswerResult = Exclude<DecideResult, { outcome: "approved" }> | Refused | Executed | ExecutionFailed;

export type MarkWrongResult =
  | { outcome: "marked_wrong"; demotedTo: Rung | null }
  | { outcome: "refused"; reason: "not_found" | "already_marked" };

export interface GatewayOptions {
  /** A pool connected as the gateway's database role. */
  db: Db;
  actionTypes: ActionTypeRegistry;
  /** By name. Each action type names the connector it uses. */
  connectors: Record<string, Connector>;
  now?: () => Date;
  approvalTtlMs?: number;
}

export interface Gateway {
  /** What an agent's tool calls. */
  submit(request: ActionRequest): Promise<SubmitResult>;
  /** Record an answer and, on a yes, carry the action out. */
  answerApproval(answer: ApprovalAnswer): Promise<AnswerResult>;
  /** Carry out an approval that already has its yes recorded (for example by the UI). */
  executeApproval(input: { tenantId: string; approvalId: string }): Promise<Refused | Executed | ExecutionFailed>;
  /** Salekh marks an executed action wrong afterwards: its type drops one rung. */
  markActionWrong(input: { tenantId: string; actionId: string; memberId: string; note: string }): Promise<MarkWrongResult>;
  /** Mark pending approvals past their expiry as expired. Returns how many. */
  expireApprovals(input: { tenantId: string }): Promise<number>;
}

/** What the execution step needs once the checks have passed and the action row exists. */
interface Prepared {
  tenantId: string;
  businessId: string;
  department: string;
  runId: string | null;
  proposalId: string;
  approvalId: string | null;
  actionId: string;
  actionKey: string;
  type: ActionType;
  payload: unknown;
  rung: Rung;
}

type CapCheck = { ok: true; units: number } | { ok: false; reason: "cap_not_configured" | "cap_unreadable" | "cap_exceeded"; detail: unknown };

export function createGateway(options: GatewayOptions): Gateway {
  const { db, actionTypes, connectors } = options;
  const clock = options.now ?? (() => new Date());
  const approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;

  for (const name of actionTypes.names()) {
    const type = actionTypes.get(name) as ActionType;
    if (!connectors[type.connector]) {
      throw new Error(`action type ${name} needs the connector "${type.connector}", which this gateway was not given`);
    }
  }

  // ---- shared pieces -------------------------------------------------------

  /** Tell people. One in-app notification per member, and one event. */
  async function notify(
    tx: Tx,
    base: EventInput,
    input: { audience: "approvers" | "owners"; kind: "approval" | "action" | "alert"; title: string },
  ): Promise<void> {
    const who = input.audience === "approvers" ? "may_approve" : "role = 'owner'";
    const result = await tx.query(
      `insert into notifications (tenant_id, business_id, member_id, channel, kind, title, approval_id, action_id, created_at)
       select $1, $2, member_id, 'in_app', $3, $4, $5, $6, $7
         from members
        where status = 'active' and ${who}`,
      [base.tenantId, base.businessId ?? null, input.kind, input.title, base.approvalId ?? null, base.actionId ?? null, base.now],
    );
    await emitEvent(tx, {
      ...base,
      type: "notified",
      summary: `Notification sent: ${input.title}`,
      reasonCode: input.kind,
      payload: { recipients: result.rowCount ?? 0 },
    });
  }

  /**
   * Check 6. Takes a lock so two actions cannot both fit under the cap at the
   * same moment. The caller must insert its action row in this transaction.
   */
  async function checkCap(tx: Tx, tenantId: string, businessId: string, type: ActionType, payload: unknown, now: Date): Promise<CapCheck> {
    const units = type.cap.units(payload);
    if (!Number.isFinite(units) || units < 0) throw new Error(`action type ${type.name} gave a cap figure that is not a number`);
    const config = await readCurrent(tx, { businessId, kind: "cap", key: type.cap.key });
    const limit = Number(config?.value?.limit);
    if (!config || !Number.isFinite(limit)) return { ok: false, reason: "cap_not_configured", detail: { cap: type.cap.key } };

    // The outside system's own figure, where it has one. Read before the cap lock is taken,
    // so a slow outside system does not hold other actions up.
    let live: number | null = null;
    const connector = connectors[type.connector];
    if (connector?.liveCapUsage) {
      try {
        live = await connector.liveCapUsage({ tenantId, businessId, capKey: type.cap.key, window: type.cap.window, now });
      } catch (err) {
        // Cannot tell what has been used, so do not act.
        return { ok: false, reason: "cap_unreadable", detail: { cap: type.cap.key, error: String(err) } };
      }
    }

    await lock(tx, "cap", businessId, type.cap.key);
    const since =
      type.cap.window === "hour"
        ? await tx.query(
            "select coalesce(sum(cap_units), 0) as used from actions where business_id = $1 and cap_key = $2 and created_at > $3",
            [businessId, type.cap.key, new Date(now.getTime() - 60 * 60 * 1000)],
          )
        : await tx.query(
            `select coalesce(sum(a.cap_units), 0) as used
               from actions a join tenants t on t.tenant_id = a.tenant_id
              where a.business_id = $1 and a.cap_key = $2
                and (a.created_at at time zone t.timezone)::date = $3::date`,
            [businessId, type.cap.key, await tenantDay(tx, now)],
          );
    // Every action row counts, including ones that failed: something may have happened.
    const logged = Number(since.rows[0].used);
    const used = Math.max(logged, live ?? 0);
    if (used + units > limit) {
      return { ok: false, reason: "cap_exceeded", detail: { cap: type.cap.key, limit, logged, live, asked: units } };
    }
    return { ok: true, units };
  }

  async function insertAction(tx: Tx, p: Omit<Prepared, "actionId">, capUnits: number, now: Date): Promise<string> {
    const result = await tx.query(
      `insert into actions
         (tenant_id, business_id, proposal_id, approval_id, department, action_type, action_key, rung,
          input, input_hash, status, cap_key, cap_units, undoable, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 'executing', $11, $12, $13, $14)
       returning action_id`,
      [
        p.tenantId, p.businessId, p.proposalId, p.approvalId, p.department, p.type.name, p.actionKey, p.rung,
        JSON.stringify(p.payload), hashPayload(p.payload), p.type.cap.key, capUnits, p.type.undoable, now,
      ],
    );
    return result.rows[0].action_id as string;
  }

  /**
   * Steps 4 to 6 of the path: execute through the connector, read the result
   * back, and write the audit row and events. The action row already exists
   * and the key is already used up, so whatever happens here, this action is
   * never run a second time.
   */
  async function execute(p: Prepared): Promise<Executed | ExecutionFailed> {
    const connector = connectors[p.type.connector] as Connector;
    const call: ConnectorCall = {
      tenantId: p.tenantId,
      businessId: p.businessId,
      actionType: p.type.name,
      actionKey: p.actionKey,
      payload: p.payload,
    };
    const base: EventInput = {
      tenantId: p.tenantId,
      businessId: p.businessId,
      department: p.department,
      runId: p.runId,
      proposalId: p.proposalId,
      approvalId: p.approvalId,
      actionId: p.actionId,
      actionType: p.type.name,
      rung: p.rung,
      type: "executed",
      summary: "",
    };

    let result: ConnectorResult;
    try {
      result = await connector.execute(call);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const now = clock();
      await db.tx(p.tenantId, async (tx) => {
        await tx.query("update actions set status = 'failed', error = $2, executed_at = $3 where action_id = $1", [p.actionId, error, now]);
        await emitEvent(tx, { ...base, now, type: "execution_failed", summary: `${p.type.name} failed to execute`, reasonCode: "connector_error", payload: { error } });
        // A failure is told to Salekh at every rung, silent or not.
        await notify(tx, { ...base, now }, { audience: "owners", kind: "alert", title: "An action failed to execute" });
      });
      return { outcome: "execution_failed", proposalId: p.proposalId, actionId: p.actionId, rung: p.rung, error };
    }

    // Read back. A read back that cannot be done counts as failed: the change is not confirmed.
    let verified: boolean | null = null;
    let verification: unknown = null;
    if (connector.readBack) {
      try {
        const check = await connector.readBack(call, result);
        verified = check.verified === true;
        verification = check.observed ?? null;
      } catch (err) {
        verified = false;
        verification = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    const now = clock();
    const demotedTo = await db.tx(p.tenantId, async (tx): Promise<Rung | null> => {
      await tx.query(
        `update actions
            set status = 'executed', output = $2::jsonb, outside_reference = $3, executed_at = $4,
                verified = $5, verified_at = $6, verification = $7::jsonb
          where action_id = $1`,
        [
          p.actionId, JSON.stringify(result.output ?? null), result.reference, now,
          verified, verified === null ? null : now, JSON.stringify(verification),
        ],
      );
      await emitEvent(tx, { ...base, now, type: "executed", summary: `${p.type.name} executed`, payload: { reference: result.reference, output: result.output ?? null } });
      if (verified === true) {
        await emitEvent(tx, { ...base, now, type: "verified", summary: `${p.type.name} was read back and confirmed`, payload: { observed: verification } });
      }
      if (verified === false) {
        await emitEvent(tx, {
          ...base, now, type: "verify_failed",
          summary: `${p.type.name} could not be confirmed by reading it back`,
          reasonCode: "read_back_failed",
          payload: { observed: verification },
        });
        return demote(tx, { ...base, now }, p.type.name, "read_back_failed");
      }
      if (p.rung === 3) {
        await notify(tx, { ...base, now }, { audience: "owners", kind: "action", title: "An action was carried out" });
      }
      return null;
    });

    const executed: Executed = { outcome: "executed", proposalId: p.proposalId, actionId: p.actionId, rung: p.rung, verified };
    if (demotedTo !== null) executed.demotedTo = demotedTo;
    return executed;
  }

  /** Drop the action type one rung on this floor, log it, and tell Salekh. */
  async function demote(tx: Tx, base: EventInput, actionType: string, why: "read_back_failed" | "marked_wrong"): Promise<Rung | null> {
    const to = await demoteRung(tx, {
      tenantId: base.tenantId,
      businessId: base.businessId as string,
      actionType,
      maxRung: actionTypes.get(actionType)?.maxRung ?? 4,
      reason: why === "read_back_failed" ? "automatic demotion: read back failed" : "automatic demotion: marked wrong",
      now: base.now,
    });
    if (to === null) {
      // Already at rung 1. Nothing lower to go to, but he is still told.
      await notify(tx, base, { audience: "owners", kind: "alert", title: "An action went wrong at the lowest rung" });
      return null;
    }
    await emitEvent(tx, { ...base, rung: to, type: "demoted", summary: `${actionType} was demoted to rung ${to}`, reasonCode: why });
    await notify(tx, base, { audience: "owners", kind: "alert", title: "An action type was demoted one rung" });
    return to;
  }

  // ---- submit --------------------------------------------------------------

  async function submit(input: ActionRequest): Promise<SubmitResult> {
    const parsed = requestShape.safeParse(input);
    if (!parsed.success) {
      throw new ControlError("invalid_request", `the gateway was handed a malformed request: ${parsed.error.issues[0]?.path.join(".") ?? "?"}`);
    }
    const req = parsed.data;
    const now = clock();
    const type = actionTypes.get(req.actionType);

    const decided = await db.tx(req.tenantId, async (tx): Promise<SubmitResult | Prepared> => {
      const base: EventInput = {
        tenantId: req.tenantId,
        businessId: req.businessId,
        department: req.department,
        runId: req.runId ?? null,
        // Only a name from the list goes in this column. An unknown one is outside text.
        actionType: type?.name ?? null,
        now,
        type: "refused",
        summary: "",
      };

      const killed = await readKillSwitch(tx, null);
      const floor = (await tx.query("select status from businesses where business_id = $1", [req.businessId])).rows[0];
      if (!floor) {
        // Not this tenant's floor (or no such floor). There is nothing to hang a proposal on.
        const reason = killed ? "kill_switch" : "unknown_business";
        await emitEvent(tx, {
          ...base, businessId: null, type: "refused", reasonCode: reason,
          summary: killed ? "Refused: the kill switch is set" : "Refused: the floor is not one of this tenant's",
          payload: { request: req },
        });
        return { outcome: "refused", reason, proposalId: null };
      }

      if (req.runId !== undefined) {
        const run = await tx.query("select 1 from runs where run_id = $1", [req.runId]);
        if (run.rows.length === 0) throw new ControlError("invalid_request", "the run named in the request does not exist");
      }
      const inserted = await tx.query(
        `insert into proposals (tenant_id, business_id, department, run_id, action_type, action_key, payload, reason, created_at)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         returning proposal_id`,
        [req.tenantId, req.businessId, req.department, req.runId ?? null, req.actionType, req.actionKey,
         JSON.stringify(req.payload ?? null), req.reason, now],
      );
      const proposalId = inserted.rows[0].proposal_id as string;
      base.proposalId = proposalId;

      let configRung: Rung | null = null;
      let rung: Rung | null = null;
      const refuse = async (reason: RefusalReason, summary: string, detail?: unknown): Promise<Refused> => {
        await tx.query(
          `update proposals
              set decision = 'refused', refusal_reason = $2, config_rung = $3, effective_rung = $4,
                  key_claimed = false, decided_at = $5
            where proposal_id = $1`,
          [proposalId, reason, configRung, rung, now],
        );
        await emitEvent(tx, {
          ...base, type: "refused", reasonCode: reason, rung, summary: `Refused: ${summary}`,
          payload: { payload: req.payload ?? null, reason: req.reason, actionType: req.actionType, detail: detail ?? null },
        });
        return { outcome: "refused", reason, proposalId };
      };

      // 1. Kill switch.
      if (killed || (await readKillSwitch(tx, req.businessId))) return refuse("kill_switch", "the kill switch is set");
      // 2. Floor active.
      if (floor.status !== "active") return refuse("floor_inactive", "the floor is not active");
      // 3. Action type on the list, with a payload of the right shape.
      if (!type) return refuse("unknown_action_type", "the action type is not on the list");
      const shaped = type.payload.safeParse(req.payload);
      if (!shaped.success) return refuse("invalid_payload", "the payload has the wrong shape", { issues: shaped.error.issues });
      const payload: unknown = shaped.data;
      // 4. Rung for this floor and action type. 5. Hard ceiling.
      configRung = await readRung(tx, req.businessId, type.name);
      rung = Math.min(configRung, type.maxRung) as Rung;
      // 6. Cap.
      const cap = await checkCap(tx, req.tenantId, req.businessId, type, payload, now);
      if (!cap.ok) {
        const text = cap.reason === "cap_exceeded" ? "it would go over the cap" : cap.reason === "cap_not_configured" ? "no cap is set for it" : "the cap could not be read";
        return refuse(cap.reason, text, cap.detail);
      }
      // 7. Key not seen before.
      await lock(tx, "key", req.tenantId, req.actionKey);
      const seen = await tx.query("select 1 from proposals where action_key = $1 and key_claimed limit 1", [req.actionKey]);
      if (seen.rows.length > 0) return refuse("duplicate_key", "this action key has been used before");
      await tx.query("update proposals set key_claimed = true where proposal_id = $1", [proposalId]);
      // 8. Department budget.
      const budget = await readBudget(tx, { businessId: req.businessId, department: req.department }, now);
      if (budget.limitGbp === null) return refuse("budget_not_configured", "the department has no daily budget");
      if (budget.over) return refuse("budget_exceeded", "the department has spent its daily budget");

      // All eight passed. Do what the rung says.
      const decision = rung === 1 ? "recommend" : rung === 2 ? "await_approval" : "execute";
      await tx.query(
        "update proposals set decision = $2, config_rung = $3, effective_rung = $4, decided_at = $5 where proposal_id = $1",
        [proposalId, decision, configRung, rung, now],
      );
      await emitEvent(tx, {
        ...base, type: "proposal", rung,
        summary: `${type.name} proposed at rung ${rung}${rung < configRung ? " (held there by its ceiling)" : ""}`,
        payload: { payload, reason: req.reason, actionKey: req.actionKey },
      });

      if (rung === 1) return { outcome: "recommended", proposalId, rung: 1 };

      if (rung === 2) {
        const payloadHash = hashPayload(payload);
        const expiresAt = new Date(now.getTime() + approvalTtlMs);
        const approval = await tx.query(
          `insert into approvals
             (tenant_id, business_id, proposal_id, department, action_type, action_key, reasoning, payload, payload_hash, expires_at, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
           returning approval_id`,
          [req.tenantId, req.businessId, proposalId, req.department, type.name, req.actionKey, req.reason,
           JSON.stringify(payload), payloadHash, expiresAt, now],
        );
        const approvalId = approval.rows[0].approval_id as string;
        base.approvalId = approvalId;
        await emitEvent(tx, { ...base, type: "waiting", rung, summary: `${type.name} is waiting for a yes`, payload: { payloadHash, expiresAt } });
        await notify(tx, { ...base, rung }, { audience: "approvers", kind: "approval", title: "An action is waiting for your approval" });
        return { outcome: "waiting_approval", proposalId, approvalId, payloadHash, expiresAt, rung: 2 };
      }

      // Rungs 3 and 4: the action row goes in now, in the same transaction as the cap check.
      const prepared = {
        tenantId: req.tenantId, businessId: req.businessId, department: req.department, runId: req.runId ?? null,
        proposalId, approvalId: null, actionKey: req.actionKey, type, payload, rung,
      };
      const actionId = await insertAction(tx, prepared, cap.units, now);
      await emitEvent(tx, { ...base, actionId, type: "executing", rung, summary: `${type.name} is being executed` });
      return { ...prepared, actionId };
    });

    return "outcome" in decided ? decided : execute(decided);
  }

  // ---- approvals -----------------------------------------------------------

  async function executeApproval(input: { tenantId: string; approvalId: string }): Promise<Refused | Executed | ExecutionFailed> {
    if (!isUuid(input.tenantId) || !isUuid(input.approvalId)) return { outcome: "refused", reason: "not_found", proposalId: null };
    const now = clock();

    const decided = await db.tx(input.tenantId, async (tx): Promise<Refused | Prepared> => {
      // Row lock: an approval is used by one caller at a time, and so only once.
      const found = await tx.query("select * from approvals where approval_id = $1 for update", [input.approvalId]);
      const approval = found.rows[0];
      if (!approval) return { outcome: "refused", reason: "not_found", proposalId: null };
      const proposalId = approval.proposal_id as string;
      const businessId = approval.business_id as string;
      const type = actionTypes.get(approval.action_type);
      const proposal = (await tx.query("select run_id from proposals where proposal_id = $1", [proposalId])).rows[0];
      const base: EventInput = {
        tenantId: input.tenantId, businessId, department: approval.department, runId: proposal?.run_id ?? null,
        proposalId, approvalId: approval.approval_id, actionType: type?.name ?? null, rung: 2, now,
        type: "refused", summary: "",
      };
      const refuse = async (reason: RefusalReason, summary: string, detail?: unknown): Promise<Refused> => {
        await emitEvent(tx, { ...base, type: "refused", reasonCode: reason, summary: `Approved action not executed: ${summary}`, payload: detail ?? null });
        return { outcome: "refused", reason, proposalId };
      };

      if (approval.status !== "approved") return { outcome: "refused", reason: "not_approved", proposalId };
      if (approval.consumed_at !== null) return { outcome: "refused", reason: "already_used", proposalId };

      if (now.getTime() >= (approval.expires_at as Date).getTime()) {
        await tx.query("update approvals set status = 'expired' where approval_id = $1", [approval.approval_id]);
        await emitEvent(tx, { ...base, type: "expired", summary: "The approval expired before it could be carried out", reasonCode: "expired" });
        return { outcome: "refused", reason: "expired", proposalId };
      }

      // The yes was for one payload hash. What is stored now must still be that payload.
      const storedHash = hashPayload(approval.payload);
      if (storedHash !== approval.approved_payload_hash || storedHash !== approval.payload_hash) {
        await tx.query("update approvals set status = 'voided', void_reason = 'payload_changed' where approval_id = $1", [approval.approval_id]);
        await emitEvent(tx, {
          ...base, type: "voided", reasonCode: "payload_changed",
          summary: "The payload changed after it was approved, so the approval is void",
        });
        return { outcome: "refused", reason: "payload_changed", proposalId };
      }

      // The world may have changed while this waited, so the checks run again.
      // A refusal here leaves the yes standing: it can be carried out later, before it expires.
      if (await readKillSwitch(tx, businessId)) return refuse("kill_switch", "the kill switch is set");
      const floor = (await tx.query("select status from businesses where business_id = $1", [businessId])).rows[0];
      if (!floor || floor.status !== "active") return refuse("floor_inactive", "the floor is not active");
      if (!type) return refuse("unknown_action_type", "the action type is no longer on the list");
      const shaped = type.payload.safeParse(approval.payload);
      if (!shaped.success) return refuse("invalid_payload", "the payload has the wrong shape");
      const rungNow = Math.min(await readRung(tx, businessId, type.name), type.maxRung);
      if (rungNow < 2) return refuse("rung_too_low", "the action type has since been demoted to recommend only");
      const cap = await checkCap(tx, input.tenantId, businessId, type, shaped.data, now);
      if (!cap.ok) return refuse(cap.reason, cap.reason === "cap_exceeded" ? "it would go over the cap" : "the cap could not be checked", cap.detail);
      const budget = await readBudget(tx, { businessId, department: approval.department }, now);
      if (budget.limitGbp === null) return refuse("budget_not_configured", "the department has no daily budget");
      if (budget.over) return refuse("budget_exceeded", "the department has spent its daily budget");

      // Exactly the stored payload. Its hash was checked a few lines up, under the row lock.
      const prepared = {
        tenantId: input.tenantId, businessId, department: approval.department as string, runId: (proposal?.run_id ?? null) as string | null,
        proposalId, approvalId: approval.approval_id as string, actionKey: approval.action_key as string,
        type, payload: approval.payload as unknown, rung: 2 as Rung,
      };
      const actionId = await insertAction(tx, prepared, cap.units, now);
      await tx.query("update approvals set consumed_at = $2 where approval_id = $1", [approval.approval_id, now]);
      await emitEvent(tx, { ...base, actionId, type: "executing", summary: `${type.name} is being executed` });
      return { ...prepared, actionId };
    });

    return "outcome" in decided ? decided : execute(decided);
  }

  async function answerApproval(answer: ApprovalAnswer): Promise<AnswerResult> {
    const decided = await decideApproval(db, answer, { now: clock() });
    if (decided.outcome !== "approved") return decided;
    return executeApproval({ tenantId: answer.tenantId, approvalId: decided.approvalId });
  }

  async function expireApprovals(input: { tenantId: string }): Promise<number> {
    const now = clock();
    return db.tx(input.tenantId, async (tx) => {
      const expired = await tx.query(
        `update approvals set status = 'expired'
          where status = 'pending' and expires_at <= $1
          returning approval_id, business_id, department, proposal_id, action_type`,
        [now],
      );
      for (const row of expired.rows) {
        await emitEvent(tx, {
          tenantId: input.tenantId, businessId: row.business_id, department: row.department, proposalId: row.proposal_id,
          approvalId: row.approval_id, actionType: row.action_type, now,
          type: "expired", reasonCode: "expired", summary: "The approval expired before it was answered",
        });
      }
      return expired.rows.length;
    });
  }

  // ---- marked wrong --------------------------------------------------------

  async function markActionWrong(input: { tenantId: string; actionId: string; memberId: string; note: string }): Promise<MarkWrongResult> {
    const now = clock();
    return db.tx(input.tenantId, async (tx): Promise<MarkWrongResult> => {
      const member = await requireOwnerOrApprover(tx, input.memberId);
      if (!isUuid(input.actionId)) return { outcome: "refused", reason: "not_found" };
      const found = await tx.query("select * from actions where action_id = $1 for update", [input.actionId]);
      const action = found.rows[0];
      if (!action) return { outcome: "refused", reason: "not_found" };
      if (action.marked_wrong_at !== null) return { outcome: "refused", reason: "already_marked" };
      await tx.query(
        "update actions set marked_wrong_at = $2, marked_wrong_by = $3, marked_wrong_note = $4 where action_id = $1",
        [action.action_id, now, member.memberId, input.note],
      );
      const base: EventInput = {
        tenantId: input.tenantId, businessId: action.business_id, department: action.department,
        proposalId: action.proposal_id, approvalId: action.approval_id, actionId: action.action_id,
        actionType: actionTypes.get(action.action_type)?.name ?? null, rung: action.rung, now,
        type: "marked_wrong", summary: "",
      };
      await emitEvent(tx, {
        ...base, type: "marked_wrong", reasonCode: "marked_wrong", summary: "An executed action was marked wrong",
        payload: { by: member.memberId, note: input.note },
      });
      const demotedTo = await demote(tx, base, action.action_type, "marked_wrong");
      return { outcome: "marked_wrong", demotedTo };
    });
  }

  return { submit, answerApproval, executeApproval, markActionWrong, expireApprovals };
}
