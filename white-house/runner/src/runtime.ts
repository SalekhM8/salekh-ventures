import { randomUUID } from "node:crypto";
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
import { parseOutreachSettings, type OutreachSettings } from "./outreach/settings.js";
import { countWaiting } from "./outreach/store.js";
import type { Mailbox } from "./control/connectors/mailbox.js";
import type { PlacesConnector } from "./control/connectors/places.js";
import type { DirectReader } from "./control/connectors/direct-read.js";
import { collectReplies, createMailConnector, ENQUIRY_ACTION, syncDecisions, type ReplyCounts } from "./outreach/enquiries.js";
import { replyPrompt } from "./outreach/pipeline.js";
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
  // On a standby the mailbox is not held at all: nothing in this process can send from it or read it.
  const mailbox = standby ? null : (options.mailbox ?? null);
  const gateway = createGateway({
    db: gatewayDb,
    actionTypes,
    // The dummy action's connector is a Map in memory. The mail connector is the only thing that holds the test mailbox.
    connectors: { ...(options.connectors ?? { dummy: createDummyConnector() }), mail: createMailConnector({ db: gatewayDb, mailbox: mailbox, now: clock }) },
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
  async function sendApproved(): Promise<void> {
    for (;;) {
      await syncDecisions(gatewayDb, tenantId, clock());
      const next = await gatewayDb.tx(tenantId, async (tx) =>
        (await tx.query("select enquiry_id, approval_id, business_id from enquiries where status = 'approved' and approval_id is not null order by decided_at, enquiry_id limit 1")).rows[0]);
      if (!next) return;
      const done = await gateway.executeApproval({ tenantId, approvalId: next.approval_id });
      changed();
      if (done.outcome === "refused" && WAITS.has(done.reason)) return;
      const still = await gatewayDb.tx(tenantId, async (tx) => (await tx.query("select status from enquiries where enquiry_id = $1", [next.enquiry_id])).rows[0]?.status);
      if (still === "approved") {
        // It was not sent and will not be: the approval is void, used or gone. Without the mailbox, nothing can be sent at all.
        if (done.outcome === "execution_failed") return;
        await gatewayDb.tx(tenantId, (tx) => tx.query("update enquiries set status = $2 where enquiry_id = $1 and status = 'approved'", [next.enquiry_id, done.outcome === "refused" && done.reason === "expired" ? "expired" : "rejected"]));
        continue;
      }
      const stored = await gatewayDb.tx(tenantId, (tx) => readCurrent(tx, { businessId: next.business_id, kind: "setting", key: "outreach" }));
      let gap = 90;
      try { gap = parseOutreachSettings(stored?.value ?? {}).enquiry_send_gap_seconds; } catch { /* the default stands */ }
      if (gap > 0) await pause(gap * 1000);
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
    // The same round also sends anything approved that was held over (yesterday's allowance, a kill switch since lifted).
    kickSender();
    changed();
    return counts;
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
      mailbox, gateway, places: options.places ?? null, directReader: options.directReader ?? null,
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

  return { gateway, house, getOutput, scoreOutput, answerApproval, setKillSwitch, startRun: startRunFor, acknowledge, idle, listApprovals, decideBatch, collectReplies: collect };
}
