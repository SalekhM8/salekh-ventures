import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { DEPARTMENTS, type DepartmentDef } from "./agents/departments.js";
import type { AgentDriver, DriverResult } from "./agents/driver.js";
import { prepareSession, type ToolCallLog } from "./agents/session.js";
import type { MetricRow, ToolBackend } from "./agents/tools.js";
import { actionTypes as defaultActionTypes, type ActionTypeRegistry } from "./control/action-types.js";
import { engageKillSwitch, readCurrent, resumeKillSwitch } from "./control/config.js";
import type { Connector } from "./control/connectors/connector.js";
import { createDummyConnector } from "./control/connectors/dummy.js";
import type { ReachConnector } from "./control/connectors/agent-reach.js";
import type { CompaniesHouseConnector } from "./control/connectors/companies-house.js";
import type { TrafficConnector } from "./control/connectors/posthog.js";
import type { ModelCaller } from "./agents/model-caller.js";
import { runOutreach } from "./outreach/pipeline.js";
import { forType, parseOutreachSettings, type OutreachSettings } from "./outreach/settings.js";
import { awaitingCompanyCheck, countWaiting, PROSPECT_COLUMNS, saveCompanyCheck, toProspectRow } from "./outreach/store.js";
import type { Mailbox, MailCheck } from "./control/connectors/mailbox.js";
import type { PlacesConnector } from "./control/connectors/places.js";
import type { DirectReader } from "./control/connectors/direct-read.js";
import { assignMissingSlots, breakerToday, checkFailures, clearStop, listReplies, requeueUnsent, resultsToday, scoreDue, type ReplyRecord, collectReplies, createMailConnector, ENQUIRY_ACTION, listEnquiries, requeueAfterRungChange, syncDecisions, tripBreaker, type ReplyCounts, type SentEnquiry } from "./outreach/enquiries.js";
import { lintEnquiry, nextOpening, openAt, scoreAfter, slotAt, type Slot } from "./outreach/enquiry-rules.js";
import { renderResultsSoFar, replyPrompt } from "./outreach/pipeline.js";
import { decideApproval } from "./control/approvals.js";
import { isUuid, type Db, type Tx } from "./control/db.js";
import { emitEvent, type EventInput } from "./control/events.js";
import { createGateway, type Gateway } from "./control/gateway.js";
import { finishRun, startRun, tenantDay } from "./control/runs.js";
import { pullTraffic } from "./jobs/pull-traffic.js";

/**
 * The runner for one tenant: the house snapshot the UI polls, the things
 * Salekh can do from it, and agent runs. The HTTP layer in server.ts is a
 * thin shell over this.
 *
 * Three database roles are used on purpose. Agent tools read and write with
 * the agent role. The gateway role records runs, events and actions. The UI
 * role does what only the UI may: resume a kill switch.
 */

export interface RuntimeOptions {
  gatewayDb: Db;
  uiDb: Db;
  agentDb: Db;
  tenantId: string;
  /** The white-house folder: CLAUDE.md, agents/, businesses/. */
  whRoot: string;
  /** null: no model driver, so no run can start. */
  driver: AgentDriver | null;
  /** The tenant's model API key, from the runner's own environment. */
  apiKeyFor: (tenantSlug: string) => string | undefined;
  now?: () => Date;
  /** Dollars to pounds for the budget. A single placeholder rate until Salekh settles the rule. */
  usdToGbp: number;
  actionTypes?: ActionTypeRegistry;
  connectors?: Record<string, Connector>;
  /** Traffic totals for the Data room, where a floor has a source. */
  traffic?: { connector: TrafficConnector; hostsByBusiness: Record<string, string[]> };
  /** Single structured model calls, for departments that are a pipeline of code with a model at fixed points. */
  model?: ModelCaller | null;
  /** Web search and page reading by plain code. null: not configured. */
  reach?: ReachConnector | null;
  /** null: no key, so companies are recorded as not checked. */
  companiesHouse?: CompaniesHouseConnector | null;
  /**
   * One mailbox, one owner. "standby": this runner never starts a run, never sends an enquiry and never looks in
   * the mailbox. It still answers the house and shows what is there. Default "primary".
   */
  role?: "primary" | "standby";
  /** Reads a business's own pages directly. null or absent: pages are read through the search tool only. */
  directReader?: DirectReader | null;
  /** Google Places. null or absent: businesses are found by web search. */
  places?: PlacesConnector | null;
  /** How the gap between calls to the search tool, and between enquiries sent, is waited out. Tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** The test mailbox. null: not configured, so no test enquiry is drafted, sent or read. */
  mailbox?: Mailbox | null;
}

export type RoomState = "idle" | "working" | "waiting" | "done" | "failed" | "handoff";

export interface HouseRoom {
  id: string;
  business: string;
  department: string;
  state: RoomState;
  task: string;
  pendingApprovalId: string | null;
  proposal: null | { title: string; reason: string; actionType: string; rung: number; expiresAt: string; undoable: boolean; payloadHash: string };
  log: { id: string; at: string; kind: string; text: string }[];
  outputs: { id: string; at: string; title: string; runId: string | null; score: number | null }[];
  costTodayGbp: number;
  budgetTodayGbp: number | null;
}

export interface House {
  generatedAt: string;
  killSwitch: { global: boolean; floors: string[] };
  rooms: HouseRoom[];
  handoffs: { id: string; from: string; to: string; at: string }[];
}

export type Answer<T> = ({ status: 200 | 202 } & T) | { status: 404 } | { status: 409 | 422; reason: string };

export interface Runtime {
  gateway: Gateway;
  house(): Promise<House>;
  getOutput(id: string): Promise<Answer<{ output: { id: string; roomId: string; runId: string | null; at: string; title: string; body: string } }>>;
  scoreOutput(id: string, body: unknown): Promise<Answer<{ ok: true }>>;
  answerApproval(id: string, body: unknown): Promise<Answer<{ result: { status: string; reason?: string } }>>;
  setKillSwitch(body: unknown): Promise<Answer<{ killSwitch: House["killSwitch"] }>>;
  startRun(roomId: string, body: unknown): Promise<Answer<{ runId: string }>>;
  acknowledge(roomId: string): Promise<Answer<{ ok: true }>>;
  /** The approvals waiting in one room, oldest first, with what each would do. This returns personal data on purpose: it is the approval itself. */
  listApprovals(roomId: string): Promise<Answer<{ approvals: PendingApproval[] }>>;
  /** Decide several approvals at once. Each goes through the same path as a single one. */
  decideBatch(body: unknown): Promise<Answer<{ results: { id: string; status: string; reason?: string }[] }>>;
  /** Search the test mailbox for replies to the enquiries this system sent. Plain code. */
  collectReplies(): Promise<ReplyCounts | null>;
  /** What was sent from one room since a moment (default: the last seven days). This returns personal data on purpose: it is the record of what went out. */
  listSent(roomId: string, since: string | null): Promise<Answer<{ enquiries: SentEnquiry[] }>>;
  /** Start sending whatever is due, if it is not already going. Returns at once. */
  sendDue(): void;
  /** Try a connection to the mail server each way, sending and reading nothing. null: no mailbox, or a standby. */
  checkMail(): Promise<MailCheck | null>;
  /** Put back in the queue the enquiries marked failed since a day that never reached the mail server. Returns how many. */
  requeueUnsent(since: Date): Promise<number>;
  /**
   * At start: close every run left "running" by a process that is no longer there, as failed with the reason
   * interrupted_by_restart. `restart` names the pipeline rooms whose run was cut off and has not already been
   * restarted once today.
   */
  closeInterrupted(): Promise<{ closed: number; restart: string[] }>;
  /** The owner's switch: lift a stop on sending for one day (YYYY-MM-DD). true when it lifted one. */
  clearStop(day: string): Promise<boolean>;
  /** Score whatever is due and bring each room's "Results so far today" up to date. Returns how many were scored. */
  scoreDue(): Promise<number>;
  /** Replies received in one room since a moment (default: the last seven days). Personal data, on purpose. */
  listReplies(roomId: string, since: string | null): Promise<Answer<{ replies: ReplyRecord[] }>>;
  /** Resolves when no run is in progress in this process, and nothing is waiting to be sent. */
  idle(): Promise<void>;
}

export interface PendingApproval {
  id: string;
  payloadHash: string;
  expiresAt: string;
  actionType: string;
  /** For a test enquiry: who it goes to and exactly what it says. */
  enquiry?: { business: string; town: string | null; purpose: string; to: string; subject: string; body: string };
}

const TASK: Record<RoomState, string> = {
  idle: "Nothing assigned",
  working: "Working on a run",
  waiting: "Waiting for your approval",
  done: "Finished a run",
  failed: "The last run failed",
  handoff: "Handing work on",
};

/** Departments that are a pipeline, with the prompt files each needs in agents/. */
const PIPELINES: Record<string, string[]> = { outreach: ["outreach-find.md", "outreach-analyse.md", "outreach-draft.md", "outreach-enquiry.md", "outreach-reply.md"] };

const DONE_FOR_MS = 60_000;
const HANDOFF_FOR_MS = 10_000;
const HANDOFFS_LISTED_FOR_MS = 30_000;
/** A run still marked running after this long is taken to have died with its process. */
const RUN_STALE_AFTER_MS = 30 * 60_000;
const HOUSE_CACHE_MS = 500;

interface Room {
  businessId: string;
  business: string;
  department: string;
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const { gatewayDb, uiDb, agentDb, tenantId } = options;
  const clock = options.now ?? (() => new Date());
  const actionTypes = options.actionTypes ?? defaultActionTypes;
  const standby = options.role === "standby";
  let unreachableInARow = 0;
  let mailState: MailCheck | null = null;
  // On a standby the mailbox is not held at all: nothing in this process can send from it or read it.
  const mailbox = standby ? null : (options.mailbox ?? null);
  const gateway = createGateway({
    db: gatewayDb,
    actionTypes,
    // The dummy action's connector is a Map in memory. The mail connector is the only thing that holds the test mailbox.
    connectors: { ...(options.connectors ?? { dummy: createDummyConnector() }), mail: createMailConnector({ db: gatewayDb, mailbox: mailbox, now: clock, onLoginFailure: (_tenant, businessId) => tripBreaker(gatewayDb, tenantId, businessId, "mailbox_login", clock(), "EAUTH"),
      // Twice running with the mail server out of reach, and it is not tried a third time today. Nothing went, so no business was burnt.
      onUnreachable: async (_tenant, businessId, code) => {
        unreachableInARow += 1;
        if (unreachableInARow >= 2) await tripBreaker(gatewayDb, tenantId, businessId, "mail_unreachable", clock(), code);
      },
      onSent: () => { unreachableInARow = 0; },
    }) },
    now: clock,
  });
  const inFlight = new Map<string, Promise<void>>();
  let cache: { at: number; house: House } | null = null;
  const changed = () => void (cache = null);

  // ---- lookups ------------------------------------------------------------

  async function findRoom(tx: Tx, roomId: string): Promise<(Room & { status: string }) | null> {
    const [business, department, ...rest] = String(roomId).split(":");
    if (!business || !department || rest.length > 0) return null;
    const found = await tx.query(
      "select business_id, slug, status from businesses where slug = $1 and $2 = any (departments)",
      [business, department],
    );
    const row = found.rows[0];
    return row ? { businessId: row.business_id, business: row.slug, department, status: row.status } : null;
  }

  /** The owner the API acts as. The UI's server signs Salekh in; the runner records it as the tenant's owner. */
  async function ownerId(tx: Tx): Promise<string | null> {
    const found = await tx.query("select member_id from members where role = 'owner' and status = 'active' order by created_at limit 1");
    return (found.rows[0]?.member_id as string | undefined) ?? null;
  }

  async function killSwitchState(tx: Tx): Promise<House["killSwitch"]> {
    const rows = await tx.query(
      `select distinct on (c.business_id) c.business_id, c.value, b.slug
         from config_versions c left join businesses b on b.business_id = c.business_id
        where c.kind = 'kill_switch' and c.key = 'state'
        order by c.business_id, c.version desc`,
    );
    const engaged = rows.rows.filter((r) => r.value?.engaged === true);
    return {
      global: engaged.some((r) => r.business_id === null),
      floors: engaged.filter((r) => r.business_id !== null).map((r) => r.slug as string).sort(),
    };
  }

  // ---- GET /v1/house ------------------------------------------------------

  async function house(): Promise<House> {
    const now = clock();
    if (cache && Math.abs(now.getTime() - cache.at) < HOUSE_CACHE_MS) return cache.house;
    const built = await gatewayDb.tx(tenantId, async (tx): Promise<House> => {
      const key = (businessId: string | null, department: string | null) => `${businessId}|${department}`;
      const floors = await tx.query("select business_id, slug, departments from businesses where status = 'active' order by created_at, slug");
      const slugOf = new Map<string, string>(floors.rows.map((f) => [f.business_id, f.slug]));
      const day = await tenantDay(tx, now);

      const lastRuns = await tx.query(
        `select distinct on (business_id, department) business_id, department, status, started_at, ended_at, acknowledged_at
           from runs where business_id is not null
          order by business_id, department, started_at desc, run_id`,
      );
      const running = await tx.query(
        "select distinct business_id, department from runs where status = 'running' and started_at > $1",
        [new Date(now.getTime() - RUN_STALE_AFTER_MS)],
      );
      const pending = await tx.query(
        `select distinct on (business_id, department) approval_id, business_id, department, action_type, reasoning, expires_at, payload_hash
           from approvals where status = 'pending' and expires_at > $1
          order by business_id, department, created_at`,
        [now],
      );
      const pendingCounts = await tx.query(
        "select business_id, department, count(*)::int as n from approvals where status = 'pending' and expires_at > $1 group by business_id, department",
        [now],
      );
      const recent = await tx.query(
        `select seq, business_id, department, type, summary, created_at, payload ->> 'to' as handed_to from (
           select e.*, row_number() over (partition by business_id, department order by seq desc) as rn
             from events e
            where business_id is not null and department is not null
              and seq > (select coalesce(max(seq), 0) - 5000 from events)
         ) ranked where rn <= 14 order by seq`,
      );
      const moves = await tx.query(
        `select seq, business_id, department, type, created_at, payload ->> 'to' as handed_to
           from events
          where type in ('handoff', 'brief') and business_id is not null and department is not null and created_at > $1
          order by seq`,
        [new Date(now.getTime() - HANDOFFS_LISTED_FOR_MS)],
      );
      const outputs = await tx.query(
        `select output_id, business_id, department, run_id, title, created_at,
                (select s.score from scores s where s.output_id = o.output_id order by s.created_at desc, s.score_id limit 1) as score
           from (select o.*, row_number() over (partition by business_id, department order by created_at desc, output_id) as rn
                   from outputs o where business_id is not null) o
          where rn <= 6 order by created_at desc, output_id`,
      );
      const ledger = await tx.query("select business_id, department, cost_gbp from budget_ledger where day = $1::date", [day]);
      const budgets = await tx.query(
        `select distinct on (business_id, key) business_id, key, value from config_versions
          where kind = 'budget' order by business_id, key, version desc`,
      );

      // A pipeline says which stage it is at. The line is a fixed template with numbers only.
      const stages = await tx.query(
        `select distinct on (e.business_id, e.department) e.business_id, e.department, e.summary
           from events e join runs r on r.run_id = e.run_id
          where e.type = 'stage' and r.started_at > $1
          order by e.business_id, e.department, e.seq desc`,
        [new Date(now.getTime() - RUN_STALE_AFTER_MS)],
      );

      const group = <T extends { business_id: string | null; department?: string | null; key?: string }>(rows: T[]) => {
        const map = new Map<string, T[]>();
        for (const row of rows) {
          const k = key(row.business_id, row.department ?? row.key ?? null);
          map.set(k, [...(map.get(k) ?? []), row]);
        }
        return map;
      };
      const lastRun = group(lastRuns.rows);
      const isRunning = group(running.rows);
      const waiting = group(pending.rows);
      const logs = group(recent.rows);
      const works = group(outputs.rows);
      const spent = group(ledger.rows);
      const limits = group(budgets.rows);
      const stageOf = group(stages.rows);
      const pendingOf = group(pendingCounts.rows);

      const rooms: HouseRoom[] = [];
      for (const floor of floors.rows) {
        for (const department of floor.departments as string[]) {
          const k = key(floor.business_id, department);
          const run = lastRun.get(k)?.[0] as any;
          const approval = waiting.get(k)?.[0] as any;
          const log = (logs.get(k) ?? []) as any[];
          const handedOn = log.some((e) => e.type === "handoff" && now.getTime() - e.created_at.getTime() < HANDOFF_FOR_MS);
          let state: RoomState = "idle";
          if (approval) state = "waiting";
          else if (isRunning.has(k) || inFlight.has(`${floor.slug}:${department}`)) state = "working";
          else if (run?.status === "failed" && run.acknowledged_at === null) state = "failed";
          else if (handedOn) state = "handoff";
          else if (run?.status === "done" && run.ended_at && now.getTime() - run.ended_at.getTime() < DONE_FOR_MS) state = "done";
          const limit = Number((limits.get(k)?.[0] as any)?.value?.daily_limit_gbp);
          const type = approval ? actionTypes.get(approval.action_type) : undefined;
          rooms.push({
            id: `${floor.slug}:${department}`,
            business: floor.slug,
            department,
            state,
            task: state === "working" ? (((stageOf.get(k)?.[0] as any)?.summary as string | undefined) ?? TASK[state])
              // A count only: who the enquiries are for is in the approvals list, never here.
              : state === "waiting" && approval.action_type === ENQUIRY_ACTION
                ? `${(pendingOf.get(k)?.[0] as any)?.n ?? 1} ${((pendingOf.get(k)?.[0] as any)?.n ?? 1) === 1 ? "enquiry" : "enquiries"} waiting for your yes`
                : TASK[state],
            pendingApprovalId: approval?.approval_id ?? null,
            proposal: approval
              ? {
                  title: approval.action_type,
                  reason: approval.reasoning,
                  actionType: approval.action_type,
                  rung: 2,
                  expiresAt: approval.expires_at.toISOString(),
                  undoable: type?.undoable ?? false,
                  payloadHash: approval.payload_hash,
                }
              : null,
            log: log.map((e) => ({ id: `evt_${e.seq}`, at: e.created_at.toISOString(), kind: e.type, text: e.summary })),
            outputs: ((works.get(k) ?? []) as any[]).map((o) => ({
              id: o.output_id, at: o.created_at.toISOString(), title: o.title, runId: o.run_id, score: o.score,
            })),
            costTodayGbp: Number((spent.get(k)?.[0] as any)?.cost_gbp ?? 0),
            budgetTodayGbp: Number.isFinite(limit) ? limit : null,
          });
        }
      }

      const handoffs = moves.rows
        .filter((e) => slugOf.has(e.business_id))
        .map((e) => {
          const room = `${slugOf.get(e.business_id)}:${e.department}`;
          return e.type === "brief"
            ? { id: `evt_${e.seq}`, from: "chief", to: room, at: e.created_at.toISOString() }
            : { id: `evt_${e.seq}`, from: room, to: `${slugOf.get(e.business_id)}:${e.handed_to}`, at: e.created_at.toISOString() };
        });

      return { generatedAt: now.toISOString(), killSwitch: await killSwitchState(tx), rooms, handoffs };
    });
    cache = { at: now.getTime(), house: built };
    return built;
  }

  // ---- outputs and scores -------------------------------------------------

  const getOutput: Runtime["getOutput"] = async (id) => {
    if (!isUuid(id)) return { status: 404 };
    return gatewayDb.tx(tenantId, async (tx) => {
      const found = await tx.query(
        `select o.output_id, o.run_id, o.title, o.body, o.created_at, o.department, b.slug
           from outputs o left join businesses b on b.business_id = o.business_id where o.output_id = $1`,
        [id],
      );
      const o = found.rows[0];
      if (!o) return { status: 404 as const };
      return {
        status: 200 as const,
        output: { id: o.output_id, roomId: `${o.slug ?? "house"}:${o.department}`, runId: o.run_id, at: o.created_at.toISOString(), title: o.title, body: o.body },
      };
    });
  };

  const scoreOutput: Runtime["scoreOutput"] = async (id, body) => {
    const { score, note } = (body ?? {}) as { score?: unknown; note?: unknown };
    if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 10) return { status: 422, reason: "score must be a whole number from 1 to 10" };
    if (note !== undefined && typeof note !== "string") return { status: 422, reason: "note must be text" };
    const text = typeof note === "string" ? note.trim() : "";
    if (score < 9 && text.length === 0) return { status: 422, reason: "a score under 9 needs a note saying what was wrong" };
    if (!isUuid(id)) return { status: 404 };
    const now = clock();
    const result = await uiDb.tx(tenantId, async (tx): Promise<Answer<{ ok: true }>> => {
      const o = (await tx.query("select output_id, business_id, department, run_id from outputs where output_id = $1", [id])).rows[0];
      if (!o) return { status: 404 };
      const member = await ownerId(tx);
      if (!member) return { status: 409, reason: "no_owner" };
      await tx.query(
        "insert into scores (tenant_id, business_id, run_id, output_id, member_id, score, note, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)",
        [tenantId, o.business_id, o.run_id, o.output_id, member, score, text || null, now],
      );
      // BRIEF.md section 10: under 9, the note becomes a proposed memory for that department.
      if (score < 9) {
        await tx.query(
          "insert into memory_notes (tenant_id, business_id, department, note, status, source_run, created_at) values ($1, $2, $3, $4, 'proposed', $5, $6)",
          [tenantId, o.business_id, o.department, text, o.run_id, now],
        );
      }
      await emitEvent(tx, {
        tenantId, businessId: o.business_id, department: o.department, runId: o.run_id, now,
        type: "scored", summary: `A piece of work was scored ${score} out of 10`, reasonCode: score < 9 ? "memory_proposed" : "no_note_needed",
        payload: { outputId: o.output_id, score, note: text || null },
      });
      return { status: 200, ok: true };
    });
    changed();
    return result;
  };

  // ---- approvals and the kill switch -------------------------------------

  const answerApproval: Runtime["answerApproval"] = async (id, body) => {
    const { decision, payloadHash } = (body ?? {}) as { decision?: unknown; payloadHash?: unknown };
    if (decision !== "approve" && decision !== "reject") return { status: 422, reason: "decision must be approve or reject" };
    if (payloadHash !== undefined && typeof payloadHash !== "string") return { status: 422, reason: "payloadHash must be text" };
    if (!isUuid(id)) return { status: 404 };
    const known = await gatewayDb.tx(tenantId, async (tx) => ({
      approval: (await tx.query("select payload_hash, status, consumed_at, action_type from approvals where approval_id = $1", [id])).rows[0],
      member: await ownerId(tx),
    }));
    if (!known.approval) return { status: 404 };
    if (!known.member) return { status: 409, reason: "no_owner" };
    changed();
    const say = (status: string, reason?: string) => ({ status: 200 as const, result: reason ? { status, reason } : { status } });

    // A test enquiry is not sent the moment it is approved. The answer is recorded by the same code as any
    // approval, and the sender then sends approved enquiries one at a time with a gap between them.
    if (known.approval.action_type === ENQUIRY_ACTION) {
      // A standby does not own the mailbox: it does not take a yes it could not act on.
      if (standby) return { status: 409, reason: "standby" };
      const decided = await decideApproval(gatewayDb, {
        tenantId, approvalId: id, memberId: known.member, decision, channel: "app",
        payloadHash: typeof payloadHash === "string" ? payloadHash : known.approval.payload_hash,
      }, { now: clock() });
      await syncDecisions(gatewayDb, tenantId, clock());
      changed();
      if (decided.outcome === "approved") { kickSender(); return say("approved"); }
      if (decided.outcome === "rejected") return say("rejected");
      if (decided.outcome === "ignored") return decided.reason === "not_found" ? { status: 404 } : say("refused", decided.reason);
      if (decided.outcome !== "refused") return say("refused");
      if (decided.reason === "expired") return say("expired");
      if (decided.reason === "payload_changed") return say("voided", "payload_changed");
      return say("refused", decided.reason);
    }

    // A yes that was recorded but could not be carried out (the kill switch was on,
    // say) is carried out by asking again, as long as it has not expired.
    if (decision === "approve" && known.approval.status === "approved" && known.approval.consumed_at === null) {
      const done = await gateway.executeApproval({ tenantId, approvalId: id });
      if (done.outcome === "refused") return say(done.reason === "expired" ? "expired" : done.reason === "payload_changed" ? "voided" : "refused", done.reason === "expired" ? undefined : done.reason);
      return say("approved");
    }

    const result = await gateway.answerApproval({
      tenantId, approvalId: id, memberId: known.member, decision, channel: "app",
      // The UI should send back the hash it showed (it is in the house's proposal). When
      // it does not, the hash stored when the approval was made is used.
      payloadHash: typeof payloadHash === "string" ? payloadHash : known.approval.payload_hash,
    });
    switch (result.outcome) {
      case "executed":
      case "execution_failed":
        return say("approved");
      case "rejected":
        return say("rejected");
      case "ignored":
        return result.reason === "not_found" ? { status: 404 } : say("refused", result.reason);
      case "refused":
        if (result.reason === "expired") return say("expired");
        if (result.reason === "payload_changed") return say("voided", "payload_changed");
        return say("refused", result.reason);
    }
    return say("refused");
  };

  // ---- test enquiries: the list to approve, the batch, the sender, the replies ----

  const listApprovals: Runtime["listApprovals"] = async (roomId) => {
    const now = clock();
    return gatewayDb.tx(tenantId, async (tx): Promise<Answer<{ approvals: PendingApproval[] }>> => {
      const room = await findRoom(tx, roomId);
      if (!room) return { status: 404 };
      const rows = await tx.query(
        `select a.approval_id, a.payload_hash, a.expires_at, a.action_type, a.payload, e.purpose, p.name, coalesce(p.search_area, p.area) as town
           from approvals a left join enquiries e on e.approval_id = a.approval_id left join prospects p on p.prospect_id = e.prospect_id
          where a.business_id = $1 and a.department = $2 and a.status = 'pending' and a.expires_at > $3
          order by a.created_at, a.approval_id`,
        [room.businessId, room.department, now],
      );
      return {
        status: 200,
        approvals: rows.rows.map((r) => ({
          id: r.approval_id, payloadHash: r.payload_hash, expiresAt: (r.expires_at as Date).toISOString(), actionType: r.action_type,
          // Exactly the stored payload: what is shown here is what a yes sends.
          ...(r.action_type === ENQUIRY_ACTION && r.payload ? { enquiry: { business: r.name ?? "", town: r.town ?? null, purpose: r.purpose ?? "prospect", to: r.payload.to, subject: r.payload.subject, body: r.payload.body } } : {}),
        })),
      };
    });
  };

  const decideBatch: Runtime["decideBatch"] = async (body) => {
    const decisions = (body as { decisions?: unknown } | null)?.decisions;
    if (!Array.isArray(decisions) || decisions.length === 0 || decisions.length > 200) return { status: 422, reason: "decisions must be a list of 1 to 200 items" };
    const results: { id: string; status: string; reason?: string }[] = [];
    for (const item of decisions as { id?: unknown; decision?: unknown; payloadHash?: unknown }[]) {
      const id = typeof item?.id === "string" ? item.id : "";
      // The same call the single endpoint makes, one item at a time.
      const one = await answerApproval(id, { decision: item?.decision, ...(item?.payloadHash === undefined ? {} : { payloadHash: item.payloadHash }) });
      if (one.status === 200) results.push({ id, ...one.result });
      else results.push({ id, status: one.status === 404 ? "not_found" : "invalid", ...("reason" in one ? { reason: one.reason } : {}) });
    }
    return { status: 200, results };
  };

  const pause = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** Reasons an approved enquiry cannot go just now but may later: it keeps its place. */
  const WAITS = new Set(["kill_switch", "cap_exceeded", "cap_not_configured", "budget_exceeded", "budget_not_configured", "floor_inactive", "rung_too_low"]);

  /** Send approved enquiries one at a time, oldest yes first, with a gap between them. Stops at the kill switch or the day's allowance. */
  const settingsOf = async (businessId: string): Promise<OutreachSettings> => {
    const stored = await gatewayDb.tx(tenantId, (tx) => readCurrent(tx, { businessId, kind: "setting", key: "outreach" }));
    try {
      return parseOutreachSettings(stored?.value ?? {});
    } catch {
      return parseOutreachSettings({}); // settings that do not parse stop a run elsewhere; here the defaults are the cautious choice
    }
  };
  async function recordSend(row: any, slot: Slot, settings: OutreachSettings): Promise<void> {
    const sent = await gatewayDb.tx(tenantId, async (tx) => (await tx.query("select sent_at from enquiries where enquiry_id = $1", [row.enquiry_id])).rows[0]?.sent_at as Date | undefined);
    if (!sent) return;
    const periods = (row.places as { opening_hours?: { periods?: Parameters<typeof openAt>[0] } } | null)?.opening_hours?.periods ?? null;
    const state = periods && periods.length > 0 ? (openAt(periods, sent, row.timezone as string) ? "open" : "closed") : "unknown";
    const shut = state === "closed" || (state === "unknown" && slot !== "in_hours");
    const opens = shut ? nextOpening(sent, row.timezone as string, periods, settings) : null;
    await gatewayDb.tx(tenantId, async (tx) => {
      await tx.query("update enquiries set sent_slot = $2, opening_state = $3 where enquiry_id = $1", [row.enquiry_id, slot, state]);
      await tx.query("update prospects set test_result = coalesce(test_result, '{}'::jsonb) || $2::jsonb where prospect_id = $1", [row.prospect_id, JSON.stringify({
        slot, opening_state: state, ...(opens ? { next_opening: opens.toISOString() } : {}), score_after: scoreAfter(sent, slot, row.timezone as string, settings).toISOString(),
      })]);
    });
  }

  /** Enquiries that were waiting for a yes when their action moved to rung 3: withdrawn, never approved, and queued afresh if they still pass. */
  const requeue = () => requeueAfterRungChange(gatewayDb, tenantId, settingsOf, clock());

  /**
   * Send what is due, one at a time, oldest first, with a gap between them: enquiries a person approved (rung 2),
   * and enquiries queued to go without asking (rung 3). It stops, and leaves the rest for the next round, at the
   * kill switch, the day's allowance, the budget, the end of the sending hours, or a tripped breaker.
   */
  async function sendApproved(): Promise<void> {
    // If the check at start found that mail cannot leave this server, it is looked at again before anything is tried.
    // While it still cannot, no send is attempted at all.
    if (mailState && !mailState.out.reachable && !(await checkMail())?.out.reachable) return;
    for (;;) {
      await syncDecisions(gatewayDb, tenantId, clock());
      await requeue();
      // Enquiries queued before there were slots are given one.
      await assignMissingSlots(gatewayDb, tenantId, clock(), async (businessId) => (await settingsOf(businessId)).enquiry_slots);
      if (await breakerToday(gatewayDb, tenantId, clock())) return;
      // Which part of the week is it? In hours, a weekday evening, the weekend, or none (the small hours, an early
      // morning, a day set aside), when nothing is sent. The slots are the same for every floor of a tenant, so the
      // first floor's settings that say it is some slot decide.
      const floors = await gatewayDb.tx(tenantId, async (tx) =>
        (await tx.query("select distinct e.business_id, t.timezone from enquiries e join tenants t on t.tenant_id = e.tenant_id where e.status in ('approved', 'queued')")).rows);
      let next: any = null;
      let settings = parseOutreachSettings({});
      let slot: Slot | null = null;
      for (const floor of floors) {
        const own = await settingsOf(floor.business_id as string);
        const now = slotAt(clock(), floor.timezone as string, own);
        if (!now) continue;
        // An enquiry a person approved goes in whatever slot is open. One queued to go without asking waits for its own.
        const row = await gatewayDb.tx(tenantId, async (tx) =>
          (await tx.query(
            `select e.enquiry_id, e.approval_id, e.business_id, e.prospect_id, e.status, e.to_address, e.subject, e.body, e.service, p.business_type, p.places, t.timezone
               from enquiries e join prospects p on p.prospect_id = e.prospect_id join tenants t on t.tenant_id = e.tenant_id
              where e.business_id = $1 and ((e.status = 'approved' and e.approval_id is not null) or (e.status = 'queued' and e.sent_slot = $2))
              order by coalesce(e.decided_at, e.proposed_at), e.enquiry_id limit 1`,
            [floor.business_id, now],
          )).rows[0]);
        if (row) { next = row; settings = own; slot = now; break; }
      }
      if (!next || !slot) return;
      const statusNow = () => gatewayDb.tx(tenantId, async (tx) => (await tx.query("select status from enquiries where enquiry_id = $1", [next.enquiry_id])).rows[0]?.status as string | undefined);
      const close = (status: "expired" | "rejected", from: string) =>
        gatewayDb.tx(tenantId, (tx) => tx.query("update enquiries set status = $2 where enquiry_id = $1 and status = $3", [next.enquiry_id, status, from]));

      if (next.status === "approved") {
        const done = await gateway.executeApproval({ tenantId, approvalId: next.approval_id });
        changed();
        if (done.outcome === "refused" && WAITS.has(done.reason)) return;
        if ((await statusNow()) === "approved") {
          // It was not sent and will not be: the approval is void, used or gone. Without the mailbox, nothing can be sent at all.
          if (done.outcome === "execution_failed") return;
          await close(done.outcome === "refused" && done.reason === "expired" ? "expired" : "rejected", "approved");
          continue;
        }
      } else {
        // Nobody is asked, so the checks are the only gate: they are made again here, in the moment before it goes.
        const own = forType(settings, next.business_type as string);
        if (lintEnquiry({ subject: next.subject, body: next.body }, own, next.service as string | null).length > 0) {
          await close("expired", "queued");
          await gatewayDb.tx(tenantId, (tx) => emitEvent(tx, { tenantId, businessId: next.business_id, department: "outreach", type: "stage", reasonCode: "enquiry_failed_checks", summary: "An enquiry queued to send no longer passed the checks and was not sent", now: clock() }));
          continue;
        }
        const done = await gateway.submit({
          tenantId, businessId: next.business_id, department: "outreach", actionType: ENQUIRY_ACTION,
          // One key per attempt. What stops a second send is the enquiry's own row, claimed before sending, and the one-per-business rule in the database.
          actionKey: `enquiry:${next.enquiry_id}:auto:${randomUUID()}`,
          payload: { enquiry_id: next.enquiry_id, prospect_id: next.prospect_id, to: next.to_address, subject: next.subject, body: next.body },
          reason: "Test enquiry by email",
        });
        changed();
        if (done.outcome === "refused" && WAITS.has(done.reason)) return;
        if (done.outcome === "waiting_approval") {
          // The rung has gone back to 2 since it was queued: it now waits for a yes like any other.
          await gatewayDb.tx(tenantId, (tx) => tx.query("update enquiries set status = 'proposed', approval_id = $2 where enquiry_id = $1 and status = 'queued'", [next.enquiry_id, done.approvalId]));
          continue;
        }
        if (done.outcome === "recommended" || done.outcome === "refused") { await close("expired", "queued"); continue; }
        // Still queued after an attempt: the mailbox refused the login, so nothing went and sending has been stopped for the day.
        if ((await statusNow()) === "queued") return;
      }
      // Sent: record which slot it went in, whether they were open by the hours Google shows, when they next open, and
      // the earliest it may be scored. The score, the card and the comparison with rivals all read these.
      if ((await statusNow()) === "sent") await recordSend(next, slot, settings);
      if (await checkFailures(gatewayDb, tenantId, next.business_id, settings.enquiry_max_failures_a_day, clock())) return;
      if (settings.enquiry_send_gap_seconds > 0) await pause(settings.enquiry_send_gap_seconds * 1000);
    }
  }
  function kickSender(): void {
    if (standby || inFlight.has("#sender")) return;
    const work = sendApproved()
      .catch((err) => console.error(`enquiry sender stopped: ${err instanceof Error ? err.name : "error"}`))
      .finally(() => { inFlight.delete("#sender"); changed(); });
    inFlight.set("#sender", work);
  }

  const collect: Runtime["collectReplies"] = async () => {
    if (standby || !mailbox) return null;
    const tenant = await gatewayDb.tx(tenantId, async (tx) => (await tx.query("select slug from tenants where tenant_id = wh_tenant()")).rows[0]);
    const system = await replyPrompt(options.whRoot).catch(() => "");
    const counts = await collectReplies({
      db: gatewayDb, tenantId, mailbox, model: options.model ?? null, apiKey: options.apiKeyFor((tenant?.slug as string | null) ?? "") ?? null,
      system, usdToGbp: options.usdToGbp, now: clock,
    });
    // Whatever has had its wait is scored now, not at the next morning's run, and the room's results so far are brought up to date.
    await scoreDueNow().catch((err) => console.error(`scoring on the round failed: ${err instanceof Error ? err.name : "error"}`));
    // The same round also sends anything due that was held over (the sending hours, yesterday's allowance, a kill switch since lifted).
    kickSender();
    changed();
    return counts;
  };

  async function checkMail(): Promise<MailCheck | null> {
    if (standby || !mailbox?.check) return null;
    mailState = await mailbox.check().catch(() => ({ out: { reachable: false, code: "EFAILED" }, in: { reachable: false, code: "EFAILED" } }));
    return mailState;
  }
  /** For the top of the shortlist: why mail cannot leave this server, or null when it can (or has not been checked). */
  const mailOut = (): string | null => (mailState && !mailState.out.reachable ? (mailState.out.code ?? "unknown") : null);

  const listRepliesOf: Runtime["listReplies"] = async (roomId, since) => {
    const from = since === null ? new Date(clock().getTime() - 7 * 24 * 60 * 60 * 1000) : new Date(since);
    if (Number.isNaN(from.getTime())) return { status: 422, reason: "since must be a date and time, for example 2026-11-17T08:00:00Z" };
    const room = await gatewayDb.tx(tenantId, (tx) => findRoom(tx, roomId));
    if (!room) return { status: 404 };
    return { status: 200, replies: await listReplies(gatewayDb, tenantId, room.businessId, from) };
  };

  /** A fixed id for a room's results on one day, so the same output is found and brought up to date, never duplicated. */
  const resultsId = (businessId: string, day: string): string => {
    const h = createHash("sha256").update(`results-so-far|${tenantId}|${businessId}|${day}`).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };

  async function scoreDueNow(): Promise<number> {
    if (standby) return 0;
    // Every floor with enquiries out and not yet scored.
    const floors = await gatewayDb.tx(tenantId, async (tx) =>
      (await tx.query("select distinct e.business_id from enquiries e join prospects p on p.prospect_id = e.prospect_id where e.status = 'sent' and p.capture_score is null")).rows.map((r) => r.business_id as string));
    let total = 0;
    for (const businessId of floors) {
      // A run in this room scores as it goes: the two are not done at once.
      const slug = await gatewayDb.tx(tenantId, async (tx) => (await tx.query("select slug from businesses where business_id = $1", [businessId])).rows[0]?.slug as string | undefined);
      if (slug && inFlight.has(`${slug}:outreach`)) continue;
      const scope = { tenantId, businessId, runId: null };
      const settings = await settingsOf(businessId);
      const scored = await scoreDue(gatewayDb, scope, settings, clock(), options.companiesHouse ?? null, { toRow: toProspectRow, columns: PROSPECT_COLUMNS, awaitingCompanyCheck, saveCompanyCheck });
      if (scored.scored === 0) continue;
      total += scored.scored;
      const { day, results } = await resultsToday(gatewayDb, scope, clock());
      const title = `Results so far, ${day}`;
      const body = renderResultsSoFar(title, results, settings);
      const data = { date: day, results: results.map((r) => ({ prospect_id: r.prospectId, kind: r.kind, capture_score: r.captureScore, outcome: r.outcome })) };
      const outputId = resultsId(businessId, day);
      const exists = await gatewayDb.tx(tenantId, async (tx) => (await tx.query("select 1 from outputs where output_id = $1", [outputId])).rows.length > 0);
      if (exists) await gatewayDb.tx(tenantId, (tx) => tx.query("update outputs set body = $2, data = $3::jsonb where output_id = $1", [outputId, body, JSON.stringify(data)]));
      else {
        await agentDb.tx(tenantId, (tx) => tx.query(
          "insert into outputs (output_id, tenant_id, business_id, department, run_id, title, body, data, created_at) values ($1, $2, $3, 'outreach', null, $4, $5, $6::jsonb, $7)",
          [outputId, tenantId, businessId, title, body, JSON.stringify(data), clock()]));
        await gatewayDb.tx(tenantId, (tx) => emitEvent(tx, { tenantId, businessId, department: "outreach", type: "output", summary: "A piece of work was finished", payload: { outputId }, now: clock() }));
      }
      changed();
    }
    return total;
  }

  async function closeInterrupted(): Promise<{ closed: number; restart: string[] }> {
    if (standby) return { closed: 0, restart: [] };
    const left = await gatewayDb.tx(tenantId, async (tx) => (await tx.query(
      "select r.run_id, r.business_id, r.department, r.trigger, b.slug from runs r left join businesses b on b.business_id = r.business_id where r.status = 'running' order by r.started_at")).rows);
    const rooms = new Set<string>();
    for (const run of left) {
      // Runs of this very process are not touched (there are none at start, which is when this is called).
      if (run.slug && inFlight.has(`${run.slug}:${run.department}`)) continue;
      const closed = await finishRun(gatewayDb, { tenantId, runId: run.run_id, status: "failed", tokensIn: 0, tokensOut: 0, tokensCached: 0, costGbp: 0, error: "interrupted_by_restart" }, { now: clock() });
      if (!closed.recorded) continue;
      await gatewayDb.tx(tenantId, (tx) => emitEvent(tx, {
        tenantId, businessId: run.business_id, department: run.department, runId: run.run_id, type: "failed", reasonCode: "interrupted_by_restart",
        summary: "The run was cut off by a restart of the server and has been closed", now: clock(),
      }));
      if (run.slug && PIPELINES[run.department as string]) rooms.add(`${run.slug}:${run.department}|${run.business_id}|${run.department}`);
    }
    const restart: string[] = [];
    for (const entry of rooms) {
      const [roomId, businessId, department] = entry.split("|") as [string, string, string];
      // Once: a room already restarted after an interruption today is not started again, so a server that keeps falling over does not loop.
      const before = await gatewayDb.tx(tenantId, async (tx) => (await tx.query(
        `select count(*)::int as n from events e join tenants t on t.tenant_id = e.tenant_id
          where e.type = 'stage' and e.reason_code = 'restarted_after_interruption' and e.business_id = $1 and e.department = $2
            and (e.created_at at time zone t.timezone)::date = (($3::timestamptz) at time zone t.timezone)::date`,
        [businessId, department, clock()])).rows[0].n as number);
      if (before > 0) continue;
      await gatewayDb.tx(tenantId, (tx) => emitEvent(tx, { tenantId, businessId, department, type: "stage", reasonCode: "restarted_after_interruption", summary: "The run that was cut off will be started again, once", now: clock() }));
      restart.push(roomId);
    }
    if (left.length > 0) changed();
    return { closed: left.length, restart };
  }

  const listSent: Runtime["listSent"] = async (roomId, since) => {
    const from = since === null ? new Date(clock().getTime() - 7 * 24 * 60 * 60 * 1000) : new Date(since);
    if (Number.isNaN(from.getTime())) return { status: 422, reason: "since must be a date and time, for example 2026-11-17T08:00:00Z" };
    const room = await gatewayDb.tx(tenantId, (tx) => findRoom(tx, roomId));
    if (!room) return { status: 404 };
    return { status: 200, enquiries: await listEnquiries(gatewayDb, tenantId, room.businessId, from) };
  };

  const setKillSwitch: Runtime["setKillSwitch"] = async (body) => {
    const on = (body as { on?: unknown } | null)?.on;
    if (typeof on !== "boolean") return { status: 422, reason: "on must be true or false" };
    const member = await gatewayDb.tx(tenantId, ownerId);
    if (!member) return { status: 409, reason: "no_owner" };
    const input = { tenantId, businessId: null, memberId: member, reason: on ? "kill switch set from the app" : "resumed from the app", now: clock() };
    const current = await gatewayDb.tx(tenantId, killSwitchState);
    if (on && !current.global) await engageKillSwitch(uiDb, input);
    if (!on && current.global) await resumeKillSwitch(uiDb, input);
    changed();
    return { status: 200, killSwitch: await gatewayDb.tx(tenantId, killSwitchState) };
  };

  const acknowledge: Runtime["acknowledge"] = async (roomId) => {
    const now = clock();
    const result = await gatewayDb.tx(tenantId, async (tx): Promise<Answer<{ ok: true }>> => {
      const room = await findRoom(tx, roomId);
      if (!room) return { status: 404 };
      const cleared = await tx.query(
        "update runs set acknowledged_at = $3 where business_id = $1 and department = $2 and status = 'failed' and acknowledged_at is null",
        [room.businessId, room.department, now],
      );
      if ((cleared.rowCount ?? 0) > 0) {
        await emitEvent(tx, { tenantId, businessId: room.businessId, department: room.department, now, type: "acknowledged", summary: "A failed run was acknowledged" });
      }
      return { status: 200, ok: true };
    });
    changed();
    return result;
  };

  // ---- runs ---------------------------------------------------------------

  /** Database-backed tools for one run. The scope is fixed here, in code, for the life of the run. */
  function backendFor(room: Room, runId: string, base: EventInput, state: { outputs: number; proposals: number }): ToolBackend {
    return {
      async readTargets() {
        const rows = await gatewayDb.tx(tenantId, (tx) =>
          tx.query(
            `select distinct on (key) key, value from config_versions
              where business_id = $1 and kind = 'target' order by key, version desc`,
            [room.businessId],
          ));
        return { targets: rows.rows.map((r) => ({ key: r.key as string, value: r.value as unknown })) };
      },
      async readMetrics({ metric, days }) {
        const now = clock();
        const day = await gatewayDb.tx(tenantId, (tx) => tenantDay(tx, now));
        const rows = await agentDb.tx(tenantId, (tx) =>
          tx.query(
            `select metric, value, metric_date::text as day, source, metric_window from metrics
              where business_id = $1 and metric_date >= $2::date - $3::int and ($4::text is null or metric = $4)
              order by metric_date, metric`,
            [room.businessId, day, days, metric ?? null],
          ));
        return rows.rows.map((r): MetricRow => ({ metric: r.metric, value: Number(r.value), day: r.day, source: r.source, window: r.metric_window }));
      },
      async writeOutput({ title, body }) {
        const outputId = randomUUID();
        const now = clock();
        await agentDb.tx(tenantId, (tx) =>
          tx.query(
            "insert into outputs (output_id, tenant_id, business_id, department, run_id, title, body, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)",
            [outputId, tenantId, room.businessId, room.department, runId, title, body, now],
          ));
        state.outputs += 1;
        await gatewayDb.tx(tenantId, (tx) =>
          emitEvent(tx, { ...base, now, type: "output", summary: "A piece of work was finished", payload: { outputId, title } }));
        changed();
        return { outputId };
      },
      async handOff({ toDepartment, title, note }) {
        if (toDepartment === room.department) return { ok: false, why: "a department cannot hand work to itself" };
        const onFloor = await gatewayDb.tx(tenantId, (tx) =>
          tx.query("select 1 from businesses where business_id = $1 and $2 = any (departments)", [room.businessId, toDepartment]));
        if (onFloor.rows.length === 0) return { ok: false, why: "that department is not on this floor" };
        const now = clock();
        await agentDb.tx(tenantId, (tx) =>
          tx.query(
            `insert into queue_items (item_id, tenant_id, business_id, kind, from_department, to_department, title, body, source_run)
             values ($1, $2, $3, 'handoff', $4, $5, $6, $7::jsonb, $8)`,
            [randomUUID(), tenantId, room.businessId, room.department, toDepartment, title, JSON.stringify({ note }), runId],
          ));
        await gatewayDb.tx(tenantId, (tx) =>
          emitEvent(tx, { ...base, now, type: "handoff", summary: "Work handed to another department", payload: { to: toDepartment, title, note } }));
        changed();
        return { ok: true };
      },
      async proposeAction({ actionType, payload, reason }) {
        state.proposals += 1;
        const result = await gateway.submit({
          tenantId, businessId: room.businessId, department: room.department, runId,
          actionType, payload, reason, actionKey: `${runId}:${state.proposals}`,
        });
        changed();
        return result.outcome === "refused" ? { outcome: "refused", reason: result.reason } : { outcome: result.outcome };
      },
    };
  }

  async function carryOut(room: Room, def: DepartmentDef, runId: string, brief: string, apiKey: string): Promise<void> {
    const base: EventInput = { tenantId, businessId: room.businessId, department: room.department, runId, type: "tool_call", summary: "" };
    const emit = (event: Partial<EventInput> & Pick<EventInput, "type" | "summary">) =>
      gatewayDb.tx(tenantId, (tx) => emitEvent(tx, { ...base, now: clock(), ...event })).then(changed);
    const state = { outputs: 0, proposals: 0 };
    let result: DriverResult | null = null;
    let error: string | null = null;
    let cleanup: (() => Promise<void>) | null = null;
    try {
      // Plain code first: the Data room's figures are pulled before the agent reads them.
      const hosts = options.traffic?.hostsByBusiness[room.business];
      if (def.type === "data" && options.traffic && hosts) {
        try {
          const written = await pullTraffic(gatewayDb, { tenantId, businessId: room.businessId, connector: options.traffic.connector, hosts, now: clock() });
          await emit({ type: "metrics_pulled", summary: `Traffic totals pulled: ${written} values stored`, reasonCode: "pulled" });
        } catch (err) {
          await emit({ type: "metrics_pulled", summary: "Traffic totals could not be pulled", reasonCode: "pull_failed", payload: { error: String(err) } });
        }
      }
      await emit({ type: "brief", summary: "Brief given to the department", payload: { brief } });
      const notes = await agentDb.tx(tenantId, (tx) =>
        tx.query(
          "select note from memory_notes where department = $1 and (business_id = $2 or business_id is null) order by created_at",
          [room.department, room.businessId],
        ));
      const session = await prepareSession({
        whRoot: options.whRoot,
        businessSlug: room.business,
        def,
        backend: backendFor(room, runId, base, state),
        apiKey,
        brief,
        memoryNotes: notes.rows.map((r) => r.note as string),
        onToolCall: (call: ToolCallLog) =>
          call.allowed
            ? emit({ type: "tool_call", summary: `Tool used: ${call.tool}`, reasonCode: String(call.tool).toLowerCase().replace(/[^a-z0-9]+/g, "_"), payload: { input: call.input } })
            : call.blockedAddress
              ? emit({ type: "tool_call", summary: "A web address that is off limits was refused", reasonCode: "url_blocked", payload: { tool: call.rawName, input: call.input } })
              : emit({ type: "tool_call", summary: "A tool that is not on the allow list was refused", reasonCode: "tool_denied", payload: { tool: call.rawName, input: call.input } }),
      });
      cleanup = session.cleanup;
      result = await (options.driver as AgentDriver).run(session.spec);
      if (!result.ok) error = result.error ?? "run_failed";
      else if (state.outputs === 0) error = "no_output";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      await cleanup?.().catch(() => undefined);
    }
    const usage = result?.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const costUsd = Number.isFinite(result?.costUsd) ? Math.max(0, result?.costUsd as number) : 0;
    const whole = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
    await finishRun(
      gatewayDb,
      {
        tenantId, runId,
        status: error === null ? "done" : "failed",
        tokensIn: whole(usage.inputTokens + usage.cacheCreationTokens),
        tokensOut: whole(usage.outputTokens),
        tokensCached: whole(usage.cacheReadTokens),
        costUsd,
        // Pounds for the budget, at one fixed placeholder rate.
        costGbp: Math.round(costUsd * options.usdToGbp * 1e6) / 1e6,
        ...(error === null ? {} : { error: error.slice(0, 500) }),
      },
      { now: clock() },
    );
    changed();
  }

  const startRunFor: Runtime["startRun"] = async (roomId, body) => {
    if (standby) return { status: 409, reason: "standby" };
    const now = clock();
    const looked = await gatewayDb.tx(tenantId, async (tx) => {
      const room = await findRoom(tx, roomId);
      if (!room) return null;
      const schedule = await readCurrent(tx, { businessId: room.businessId, kind: "schedule", key: room.department });
      const tenant = (await tx.query("select slug from tenants where tenant_id = wh_tenant()")).rows[0];
      const running = await tx.query(
        "select 1 from runs where business_id = $1 and department = $2 and status = 'running' and started_at > $3 limit 1",
        [room.businessId, room.department, new Date(now.getTime() - RUN_STALE_AFTER_MS)],
      );
      return { room, live: schedule?.value?.live === true, tenantSlug: (tenant?.slug as string | null) ?? "", running: running.rows.length > 0 };
    });
    if (!looked) return { status: 404 };
    const { room } = looked;
    if (PIPELINES[room.department]) return startPipeline(roomId, room, looked, now);
    const def = DEPARTMENTS[room.department];
    const hasFiles = def
      ? await Promise.all([
          access(path.join(options.whRoot, "agents", `${def.type}.md`)),
          access(path.join(options.whRoot, "businesses", room.business, "departments", def.type, "CLAUDE.md")),
        ]).then(() => true, () => false)
      : false;
    if (!def || !looked.live || !hasFiles || room.status !== "active" || !options.driver) return { status: 409, reason: "no_agent" };
    const apiKey = options.apiKeyFor(looked.tenantSlug);
    if (!apiKey) return { status: 409, reason: "no_api_key" };
    if (looked.running || inFlight.has(roomId)) return { status: 409, reason: "already_running" };
    const given = (body as { brief?: unknown } | null)?.brief;
    if (given !== undefined && (typeof given !== "string" || given.length > 8000)) return { status: 422, reason: "brief must be text of at most 8000 characters" };
    const brief = typeof given === "string" && given.trim() ? given.trim() : def.defaultBrief;
    if (!brief) return { status: 409, reason: "brief_required" };

    // Kill switch and budget are checked here, by the same code as in phase 1.
    const started = await startRun(gatewayDb, { tenantId, businessId: room.businessId, department: room.department, trigger: "api", model: def.model }, { now });
    changed();
    if (!started.started) {
      const reason = started.reason === "budget_exceeded" ? "over_budget" : started.reason === "budget_not_configured" ? "no_budget" : started.reason;
      return { status: 409, reason };
    }
    const work = carryOut(room, def, started.runId, brief, apiKey)
      .catch((err) => console.error(`run ${started.runId} could not be closed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => inFlight.delete(roomId));
    inFlight.set(roomId, work);
    return { status: 202, runId: started.runId };
  };

  /** Outreach: code with a model at three fixed points, not an agent session. */
  async function startPipeline(
    roomId: string, room: Room & { status: string }, looked: { live: boolean; tenantSlug: string; running: boolean }, now: Date,
  ): Promise<Answer<{ runId: string }>> {
    const files = PIPELINES[room.department] as string[];
    const hasFiles = await Promise.all([
      ...files.map((file) => access(path.join(options.whRoot, "agents", file))),
      access(path.join(options.whRoot, "businesses", room.business, "departments", room.department, "CLAUDE.md")),
    ]).then(() => true, () => false);
    if (!looked.live || !hasFiles || room.status !== "active" || !options.model) return { status: 409, reason: "no_agent" };
    const apiKey = options.apiKeyFor(looked.tenantSlug);
    if (!apiKey) return { status: 409, reason: "no_api_key" };
    if (looked.running || inFlight.has(roomId)) return { status: 409, reason: "already_running" };
    let settings: OutreachSettings;
    try {
      const stored = await gatewayDb.tx(tenantId, (tx) => readCurrent(tx, { businessId: room.businessId, kind: "setting", key: room.department }));
      settings = parseOutreachSettings(stored?.value ?? {});
    } catch {
      return { status: 409, reason: "bad_settings" };
    }
    // The first stage's run is started here, so a set kill switch or a spent budget refuses the request itself.
    // Businesses found on earlier runs and never analysed come first, so the first stage may be analysis.
    const firstStage = (await countWaiting(gatewayDb, { tenantId, businessId: room.businessId })) > 0 ? "analyse" : "find";
    const started = await startRun(gatewayDb, { tenantId, businessId: room.businessId, department: room.department, trigger: `outreach:${firstStage}`, model: "claude-haiku-5-5" }, { now });
    changed();
    if (!started.started) {
      const reason = started.reason === "budget_exceeded" ? "over_budget" : started.reason === "budget_not_configured" ? "no_budget" : started.reason;
      return { status: 409, reason };
    }
    const work = runOutreach({
      tenantId, businessId: room.businessId, businessSlug: room.business, gatewayDb, agentDb, clock, apiKey, settings,
      model: options.model, reach: options.reach ?? null, companiesHouse: options.companiesHouse ?? null,
      whRoot: options.whRoot, usdToGbp: options.usdToGbp, firstRunId: started.runId, firstStage, changed,
      mailbox, gateway, afterEnquiries: kickSender, mailOut, places: options.places ?? null, directReader: options.directReader ?? null,
      ...(options.sleep ? { sleep: options.sleep } : {}),
    })
      .catch((err) => console.error(`outreach run ${started.runId} stopped unexpectedly: ${err instanceof Error ? err.name : "error"}`))
      .finally(() => { inFlight.delete(roomId); changed(); });
    inFlight.set(roomId, work);
    return { status: 202, runId: started.runId };
  }

  async function idle(): Promise<void> {
    while (inFlight.size > 0) await Promise.all([...inFlight.values()]);
  }

  return { gateway, house, getOutput, scoreOutput, answerApproval, setKillSwitch, startRun: startRunFor, acknowledge, idle, listApprovals, decideBatch, collectReplies: collect, listSent, listReplies: listRepliesOf, closeInterrupted, scoreDue: scoreDueNow, clearStop: (day) => clearStop(gatewayDb, tenantId, day, clock()), sendDue: kickSender, checkMail, requeueUnsent: (since) => requeueUnsent(gatewayDb, tenantId, since, clock()) };
}
