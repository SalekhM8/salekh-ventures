import { readCurrent, readKillSwitch } from "./config.js";
import type { Db, Tx } from "./db.js";
import { ControlError } from "./errors.js";
import { emitEvent } from "./events.js";

/**
 * Run records and the department budget (BRIEF.md sections 9 and 14).
 *
 * A run is one agent run or one plain code job. Starting one is refused when
 * the kill switch is set, or when the department has spent its daily budget
 * or has none. Finishing one records its tokens and cost on the run and adds
 * them to the department's ledger for the day.
 *
 * Money is in pounds, because budgets are set in pounds. The caller supplies
 * the pounds figure; what the provider reported in dollars can be kept
 * beside it. Where the exchange rate comes from is not decided yet.
 */

export interface BudgetScope {
  tenantId: string;
  /** null: a house wide department such as the Chief of Staff. */
  businessId: string | null;
  department: string;
}

export interface BudgetStatus {
  /** null: no budget configured, which counts as over. */
  limitGbp: number | null;
  spentGbp: number;
  over: boolean;
}

/** The tenant's calendar day that `now` falls in, as YYYY-MM-DD. */
export async function tenantDay(tx: Tx, now: Date): Promise<string> {
  const result = await tx.query(
    "select (($1::timestamptz) at time zone timezone)::date::text as day from tenants where tenant_id = wh_tenant()",
    [now],
  );
  const day = result.rows[0]?.day as string | undefined;
  if (!day) throw new ControlError("invalid_request", "unknown tenant");
  return day;
}

export async function readBudget(tx: Tx, scope: Omit<BudgetScope, "tenantId">, now: Date): Promise<BudgetStatus> {
  const config = await readCurrent(tx, { businessId: scope.businessId, kind: "budget", key: scope.department });
  const limit = config ? Number(config.value?.daily_limit_gbp) : null;
  const limitGbp = limit !== null && Number.isFinite(limit) ? limit : null;
  const day = await tenantDay(tx, now);
  const ledger = await tx.query(
    `select cost_gbp from budget_ledger
      where business_id is not distinct from $1 and department = $2 and day = $3::date`,
    [scope.businessId, scope.department, day],
  );
  const spentGbp = ledger.rows[0] ? Number(ledger.rows[0].cost_gbp) : 0;
  // Spent means spent: at the limit is over. No limit configured is over too.
  return { limitGbp, spentGbp, over: limitGbp === null || spentGbp >= limitGbp };
}

export function budgetStatus(db: Db, scope: BudgetScope, opts: { now?: Date } = {}): Promise<BudgetStatus> {
  return db.tx(scope.tenantId, (tx) => readBudget(tx, scope, opts.now ?? new Date()));
}

export interface StartRunInput extends BudgetScope {
  /** What set it off: "schedule", "message", "salekh", a rule name. */
  trigger: string;
  /** The exact model version, or null for a plain code job. */
  model: string | null;
}

export type StartRunResult =
  | { started: true; runId: string }
  | { started: false; reason: "kill_switch" | "budget_exceeded" | "budget_not_configured" };

export async function startRun(db: Db, input: StartRunInput, opts: { now?: Date } = {}): Promise<StartRunResult> {
  const now = opts.now ?? new Date();
  return db.tx(input.tenantId, async (tx) => {
    const base = { tenantId: input.tenantId, businessId: input.businessId, department: input.department, now };
    const refuse = async (reason: "kill_switch" | "budget_exceeded" | "budget_not_configured", summary: string) => {
      await emitEvent(tx, { ...base, type: "run_refused", summary, reasonCode: reason, payload: { trigger: input.trigger } });
      return { started: false as const, reason };
    };
    if ((await readKillSwitch(tx, input.businessId)) !== null) {
      return refuse("kill_switch", "Run not started: the kill switch is set");
    }
    const budget = await readBudget(tx, input, now);
    if (budget.limitGbp === null) {
      return refuse("budget_not_configured", "Run not started: this department has no daily budget");
    }
    if (budget.over) {
      return refuse("budget_exceeded", "Run not started: this department has spent its daily budget");
    }
    const result = await tx.query(
      `insert into runs (tenant_id, business_id, department, trigger, model, status, started_at)
       values ($1, $2, $3, $4, $5, 'running', $6)
       returning run_id`,
      [input.tenantId, input.businessId, input.department, input.trigger, input.model, now],
    );
    const runId = result.rows[0].run_id as string;
    await emitEvent(tx, { ...base, runId, type: "started", summary: "Run started", payload: { trigger: input.trigger, model: input.model } });
    return { started: true as const, runId };
  });
}

export interface FinishRunInput {
  tenantId: string;
  runId: string;
  status: "done" | "failed";
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /** Cost of the run in pounds. */
  costGbp: number;
  /** What the provider reported, if it reported dollars. */
  costUsd?: number;
  error?: string;
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
const isAmount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/**
 * Close a run and add its cost to the department's ledger for the day it
 * finished. A run that is already closed is left alone and counted once:
 * `recorded` is false.
 */
export async function finishRun(db: Db, input: FinishRunInput, opts: { now?: Date } = {}): Promise<{ recorded: boolean }> {
  if (!isCount(input.tokensIn) || !isCount(input.tokensOut) || !isCount(input.tokensCached)) {
    throw new ControlError("invalid_request", "token counts must be whole numbers, zero or more");
  }
  if (!isAmount(input.costGbp) || (input.costUsd !== undefined && !isAmount(input.costUsd))) {
    throw new ControlError("invalid_request", "cost must be a number, zero or more");
  }
  const now = opts.now ?? new Date();
  return db.tx(input.tenantId, async (tx) => {
    const closed = await tx.query(
      `update runs
          set status = $2, tokens_in = $3, tokens_out = $4, tokens_cached = $5,
              cost_gbp = $6, cost_usd = $7, ended_at = $8, error = $9
        where run_id = $1 and status = 'running'
        returning business_id, department`,
      [
        input.runId, input.status, input.tokensIn, input.tokensOut, input.tokensCached,
        input.costGbp, input.costUsd ?? null, now, input.error ?? null,
      ],
    );
    const run = closed.rows[0];
    if (!run) return { recorded: false };
    const config = await readCurrent(tx, { businessId: run.business_id, kind: "budget", key: run.department });
    const limit = config ? Number(config.value?.daily_limit_gbp) : null;
    const day = await tenantDay(tx, now);
    await tx.query(
      `insert into budget_ledger
         (tenant_id, business_id, department, day, tokens_in, tokens_out, tokens_cached, cost_gbp, limit_gbp, run_count, updated_at)
       values ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, 1, $10)
       on conflict (tenant_id, business_id, department, day) do update
         set tokens_in = budget_ledger.tokens_in + excluded.tokens_in,
             tokens_out = budget_ledger.tokens_out + excluded.tokens_out,
             tokens_cached = budget_ledger.tokens_cached + excluded.tokens_cached,
             cost_gbp = budget_ledger.cost_gbp + excluded.cost_gbp,
             limit_gbp = excluded.limit_gbp,
             run_count = budget_ledger.run_count + 1,
             updated_at = excluded.updated_at`,
      [
        input.tenantId, run.business_id, run.department, day, input.tokensIn, input.tokensOut,
        input.tokensCached, input.costGbp, limit !== null && Number.isFinite(limit) ? limit : null, now,
      ],
    );
    await emitEvent(tx, {
      tenantId: input.tenantId,
      businessId: run.business_id,
      department: run.department,
      runId: input.runId,
      type: input.status === "done" ? "done" : "failed",
      summary: input.status === "done" ? "Run finished" : "Run failed",
      payload: {
        tokensIn: input.tokensIn, tokensOut: input.tokensOut, tokensCached: input.tokensCached,
        costGbp: input.costGbp, costUsd: input.costUsd ?? null, error: input.error ?? null,
      },
      now,
    });
    return { recorded: true };
  });
}
