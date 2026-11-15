import { z } from "zod";
import type { ActionTypeRegistry, Rung } from "./action-types.js";
import { lock, type Db, type Tx } from "./db.js";
import { ControlError } from "./errors.js";
import { emitEvent } from "./events.js";
import { requireOwner, requireOwnerOrApprover } from "./members.js";

/**
 * Versioned config (BRIEF.md section 9): targets, caps, rungs, schedule,
 * department budgets and kill switch state. One row per change with who and
 * when. Rows are never updated or deleted. "Current" is the highest version.
 *
 * Agents can never write config: their database role has no privilege on the
 * table. The gateway's role can only engage a kill switch or lower a rung.
 * Everything else needs the UI's role and an owner.
 */

export type ConfigKind = "target" | "cap" | "rung" | "schedule" | "budget" | "kill_switch";

export interface ConfigScope {
  tenantId: string;
  /** null: the whole tenant. */
  businessId: string | null;
  kind: ConfigKind;
  key: string;
}

export interface ConfigVersion {
  configId: string;
  version: number;
  value: any;
  changedByKind: "member" | "system";
  changedByMember: string | null;
  reason: string;
  createdAt: Date;
}

function toVersion(row: any): ConfigVersion {
  return {
    configId: row.config_id,
    version: row.version,
    value: row.value,
    changedByKind: row.changed_by_kind,
    changedByMember: row.changed_by_member,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

/** The current value, read inside a transaction. */
export async function readCurrent(tx: Tx, scope: Omit<ConfigScope, "tenantId">): Promise<ConfigVersion | null> {
  const result = await tx.query(
    `select * from config_versions
      where business_id is not distinct from $1 and kind = $2 and key = $3
      order by version desc
      limit 1`,
    [scope.businessId, scope.kind, scope.key],
  );
  return result.rows[0] ? toVersion(result.rows[0]) : null;
}

export function getCurrentConfig(db: Db, scope: ConfigScope): Promise<ConfigVersion | null> {
  return db.tx(scope.tenantId, (tx) => readCurrent(tx, scope));
}

/** Every version, oldest first. */
export function getConfigHistory(db: Db, scope: ConfigScope): Promise<ConfigVersion[]> {
  return db.tx(scope.tenantId, async (tx) => {
    const result = await tx.query(
      `select * from config_versions
        where business_id is not distinct from $1 and kind = $2 and key = $3
        order by version`,
      [scope.businessId, scope.kind, scope.key],
    );
    return result.rows.map(toVersion);
  });
}

export function lockScope(tx: Tx, scope: ConfigScope): Promise<void> {
  return lock(tx, "config", scope.tenantId, scope.businessId, scope.kind, scope.key);
}

interface WriteInput extends ConfigScope {
  value: unknown;
  changedByKind: "member" | "system";
  memberId: string | null;
  reason: string;
  now?: Date;
}

/** Append the next version. The caller has already decided this change is allowed. */
export async function writeVersion(tx: Tx, input: WriteInput): Promise<ConfigVersion> {
  await lockScope(tx, input);
  const result = await tx.query(
    `insert into config_versions
       (tenant_id, business_id, kind, key, value, version, changed_by_kind, changed_by_member, reason, created_at)
     select $1, $2, $3, $4, $5::jsonb,
            coalesce((select max(version) from config_versions
                       where business_id is not distinct from $2 and kind = $3 and key = $4), 0) + 1,
            $6, $7, $8, $9
     returning *`,
    [
      input.tenantId,
      input.businessId,
      input.kind,
      input.key,
      JSON.stringify(input.value),
      input.changedByKind,
      input.memberId,
      input.reason,
      input.now ?? new Date(),
    ],
  );
  return toVersion(result.rows[0]);
}

// ---------------------------------------------------------------------------
// Targets, caps, budgets, schedule
// ---------------------------------------------------------------------------

const jsonObject = z.record(z.string(), z.unknown());
const valueShapes = {
  target: jsonObject,
  schedule: jsonObject,
  cap: z.strictObject({ limit: z.number().finite().nonnegative() }),
  budget: z.strictObject({ daily_limit_gbp: z.number().finite().nonnegative() }),
} as const;

export interface SetConfigInput {
  tenantId: string;
  businessId: string | null;
  kind: "target" | "cap" | "schedule" | "budget";
  key: string;
  value: unknown;
  /** The signed in owner making the change. */
  memberId: string;
  reason: string;
  now?: Date;
}

/**
 * Change a target, cap, budget or schedule. Owner only, UI role only.
 * Rungs and the kill switch have their own calls below, because each has
 * rules of its own.
 */
export async function setConfig(db: Db, input: SetConfigInput): Promise<ConfigVersion> {
  const shape = Object.hasOwn(valueShapes, input.kind) ? (valueShapes as Record<string, z.ZodType>)[input.kind] : undefined;
  if (!shape) {
    throw new ControlError("invalid_config", `config kind "${String(input.kind)}" cannot be set through setConfig`);
  }
  const value = shape.safeParse(input.value);
  if (!value.success) throw new ControlError("invalid_config", `value has the wrong shape for a ${input.kind}`);
  if (typeof input.key !== "string" || input.key.length < 1 || input.key.length > 200) {
    throw new ControlError("invalid_config", "key must be 1 to 200 characters");
  }
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
    throw new ControlError("invalid_config", "a reason is needed for every change");
  }
  return db.tx(input.tenantId, async (tx) => {
    await requireOwner(tx, input.memberId);
    await lockScope(tx, input);
    const before = await readCurrent(tx, input);
    const written = await writeVersion(tx, {
      ...input,
      value: value.data,
      changedByKind: "member",
      memberId: input.memberId,
    });
    await emitEvent(tx, {
      tenantId: input.tenantId,
      businessId: input.businessId,
      type: "config_changed",
      summary: `A ${input.kind} was changed (version ${written.version})`,
      reasonCode: input.kind,
      payload: { key: input.key, before: before?.value ?? null, after: value.data, reason: input.reason, by: input.memberId },
      now: input.now,
    });
    return written;
  });
}

// ---------------------------------------------------------------------------
// Rungs
// ---------------------------------------------------------------------------

/** The rung configured for an action type on a floor. No row means rung 1. */
export async function readRung(tx: Tx, businessId: string, actionType: string): Promise<Rung> {
  const current = await readCurrent(tx, { businessId, kind: "rung", key: actionType });
  const rung = Number(current?.value?.rung);
  // When unsure which rung applies, treat it as rung 1 (BRIEF.md section 6).
  return rung === 2 || rung === 3 || rung === 4 ? rung : 1;
}

export interface PromoteInput {
  tenantId: string;
  businessId: string;
  actionType: string;
  memberId: string;
  reason: string;
  now?: Date;
}

/**
 * Promote an action type one rung on one floor. Owner only, UI role only,
 * never past the action type's hard ceiling. (Showing the evidence first is
 * the UI's job in phase 3.)
 */
export async function promoteRung(db: Db, actionTypes: ActionTypeRegistry, input: PromoteInput): Promise<{ rung: Rung }> {
  const type = actionTypes.get(input.actionType);
  if (!type) throw new ControlError("unknown_action_type", "that action type is not on the list");
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
    throw new ControlError("invalid_config", "a reason is needed for every change");
  }
  return db.tx(input.tenantId, async (tx) => {
    await requireOwner(tx, input.memberId);
    const scope: ConfigScope = { tenantId: input.tenantId, businessId: input.businessId, kind: "rung", key: type.name };
    await lockScope(tx, scope);
    const from = await readRung(tx, input.businessId, type.name);
    if (from >= type.maxRung) {
      throw new ControlError("hard_ceiling", `${type.name} can never go above rung ${type.maxRung}`);
    }
    const to = (from + 1) as Rung;
    await writeVersion(tx, { ...scope, value: { rung: to }, changedByKind: "member", memberId: input.memberId, reason: input.reason, now: input.now });
    await emitEvent(tx, {
      tenantId: input.tenantId,
      businessId: input.businessId,
      type: "config_changed",
      summary: `${type.name} was promoted from rung ${from} to rung ${to}`,
      actionType: type.name,
      rung: to,
      reasonCode: "rung",
      payload: { from, to, reason: input.reason, by: input.memberId },
      now: input.now,
    });
    return { rung: to };
  });
}

export interface DemoteInput {
  tenantId: string;
  businessId: string;
  actionType: string;
  /** The action type's hard ceiling, if it is still on the list. */
  maxRung: Rung;
  reason: string;
  now?: Date;
}

/**
 * Drop an action type one rung on one floor, inside the caller's
 * transaction. Returns the new rung, or null when it was already at rung 1.
 * The gateway's database role is allowed this and only this change of rung.
 */
export async function demoteRung(tx: Tx, input: DemoteInput): Promise<Rung | null> {
  const scope: ConfigScope = { tenantId: input.tenantId, businessId: input.businessId, kind: "rung", key: input.actionType };
  await lockScope(tx, scope);
  const configured = await readRung(tx, input.businessId, input.actionType);
  const effective = Math.min(configured, input.maxRung);
  if (effective <= 1) return null;
  const to = (effective - 1) as Rung;
  await writeVersion(tx, { ...scope, value: { rung: to }, changedByKind: "system", memberId: null, reason: input.reason, now: input.now });
  return to;
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

const KILL_KEY = "state";

/** Which kill switch, if any, stops this floor. Pass null to ask about the global one only. */
export async function readKillSwitch(tx: Tx, businessId: string | null): Promise<"global" | "floor" | null> {
  const global = await readCurrent(tx, { businessId: null, kind: "kill_switch", key: KILL_KEY });
  if (global?.value?.engaged === true) return "global";
  if (businessId !== null) {
    const floor = await readCurrent(tx, { businessId, kind: "kill_switch", key: KILL_KEY });
    if (floor?.value?.engaged === true) return "floor";
  }
  return null;
}

export function killSwitchState(db: Db, input: { tenantId: string; businessId: string | null }): Promise<"global" | "floor" | null> {
  return db.tx(input.tenantId, (tx) => readKillSwitch(tx, input.businessId));
}

export interface KillSwitchInput {
  tenantId: string;
  /** null: the whole house. Otherwise one floor. */
  businessId: string | null;
  /** The person pressing the button. null only for an automatic stop by the system. */
  memberId: string | null;
  reason: string;
  now?: Date;
}

/**
 * Stop everything, globally or for one floor. Works with the gateway's role
 * (so /stop on Telegram needs no UI) as well as the UI's.
 */
export async function engageKillSwitch(db: Db, input: KillSwitchInput): Promise<void> {
  await db.tx(input.tenantId, async (tx) => {
    if (input.memberId !== null) await requireOwnerOrApprover(tx, input.memberId);
    await writeVersion(tx, {
      tenantId: input.tenantId,
      businessId: input.businessId,
      kind: "kill_switch",
      key: KILL_KEY,
      value: { engaged: true },
      changedByKind: input.memberId === null ? "system" : "member",
      memberId: input.memberId,
      reason: input.reason || "kill switch",
      now: input.now,
    });
    await emitEvent(tx, {
      tenantId: input.tenantId,
      businessId: input.businessId,
      type: "kill_switch_engaged",
      summary: input.businessId === null ? "Kill switch set for the whole house" : "Kill switch set for this floor",
      reasonCode: input.businessId === null ? "global" : "floor",
      payload: { reason: input.reason, by: input.memberId },
      now: input.now,
    });
  });
}

/**
 * Resume after a kill switch. Owner only, and it needs the UI: the database
 * refuses this row from the gateway's role.
 */
export async function resumeKillSwitch(db: Db, input: KillSwitchInput & { memberId: string }): Promise<void> {
  await db.tx(input.tenantId, async (tx) => {
    await requireOwner(tx, input.memberId);
    await writeVersion(tx, {
      tenantId: input.tenantId,
      businessId: input.businessId,
      kind: "kill_switch",
      key: KILL_KEY,
      value: { engaged: false },
      changedByKind: "member",
      memberId: input.memberId,
      reason: input.reason || "resume",
      now: input.now,
    });
    await emitEvent(tx, {
      tenantId: input.tenantId,
      businessId: input.businessId,
      type: "kill_switch_resumed",
      summary: input.businessId === null ? "Kill switch lifted for the whole house" : "Kill switch lifted for this floor",
      reasonCode: input.businessId === null ? "global" : "floor",
      payload: { reason: input.reason, by: input.memberId },
      now: input.now,
    });
  });
}
