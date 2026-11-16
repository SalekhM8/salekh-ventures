import { lock, type Db } from "./control/db.js";
import { emitEvent } from "./control/events.js";

/**
 * A small daily scheduler inside the runner. Plain code (rule 2).
 *
 * A room's schedule is versioned config, kind "schedule": the same row that
 * holds its live flag may carry a time, {"live": true, "daily_at": "08:00"},
 * read in the tenant's time zone (Europe/London unless the tenant says
 * otherwise). Once that time has passed, the room's run is started, at most
 * once a day.
 *
 * "At most once" is kept in the database, not in memory: before trying to
 * start a run the scheduler writes one "scheduled" event for that room and
 * day, under a lock. A runner that restarts, or two that overlap, find the
 * event and leave the day alone. If the run could not start (kill switch,
 * budget), a second event says why, in fixed words, and the day is still
 * done: it is not tried again later.
 *
 * One exception, once: a scheduled run that failed only because the search
 * tool reported a rate limit is tried one more time the same day, after the
 * wait the tool gave (60 minutes if it gave none). If that fails too the
 * scheduler gives up for the day and says so. There is no loop.
 */

export interface SchedulerOptions {
  /** The gateway's role. */
  db: Db;
  tenantId: string;
  now?: () => Date;
  /** What starts a room: the same call the API makes, so every check is the same. */
  startRun: (roomId: string) => Promise<{ status: number; reason?: string; runId?: string }>;
}

export interface Scheduler {
  /** Look once. Returns what was done, for tests and logs. */
  tick(): Promise<{ roomId: string; outcome: "started" | "skipped" | "retried" | "gave_up"; reason?: string }[]>;
  start(intervalMs: number): void;
  stop(): void;
}

const SKIPPED: Record<string, string> = {
  kill_switch: "the kill switch is set",
  over_budget: "the daily budget is spent",
  no_budget: "the room has no daily budget",
  already_running: "a run was already in progress",
  no_api_key: "no model key is set",
  no_agent: "the room has no live agent",
  bad_settings: "the room's settings are not valid",
  brief_required: "the room needs a brief",
};

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { db, tenantId } = options;
  const clock = options.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let busy = false;
  let complained = false;

  async function tick() {
    const now = clock();
    // Which rooms are due and not yet dealt with today. The mark is written here, before anything is started.
    const due = await db.tx(tenantId, async (tx) => {
      await lock(tx, "scheduler", tenantId);
      const local = (await tx.query(
        `select to_char(($1::timestamptz) at time zone timezone, 'HH24:MI') as time, (($1::timestamptz) at time zone timezone)::date::text as day, timezone
           from tenants where tenant_id = wh_tenant()`,
        [now],
      )).rows[0];
      if (!local) return [];
      const rooms = await tx.query(
        `select distinct on (c.business_id, c.key) c.business_id, c.key as department, c.value, b.slug
           from config_versions c join businesses b on b.business_id = c.business_id
          where c.kind = 'schedule' and b.status = 'active' and c.key = any (b.departments)
          order by c.business_id, c.key, c.version desc`,
      );
      const picked: { roomId: string; businessId: string; department: string }[] = [];
      for (const room of rooms.rows) {
        const at = room.value?.daily_at;
        if (room.value?.live !== true || typeof at !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(at) || local.time < at) continue;
        const done = await tx.query(
          `select 1 from events
            where type = 'scheduled' and business_id = $1 and department = $2
              and (created_at at time zone $3)::date = $4::date limit 1`,
          [room.business_id, room.department, local.timezone, local.day],
        );
        if (done.rows.length > 0) continue;
        await emitEvent(tx, { tenantId, businessId: room.business_id, department: room.department, type: "scheduled", summary: "Scheduled run due", reasonCode: "due", now });
        picked.push({ roomId: `${room.slug}:${room.department}`, businessId: room.business_id, department: room.department });
      }
      return picked;
    });

    const results: { roomId: string; outcome: "started" | "skipped" | "retried" | "gave_up"; reason?: string }[] = [];
    const begin = async (room: { roomId: string; businessId: string; department: string }, retry: boolean) => {
      let reason: string | undefined;
      let runId: string | null = null;
      try {
        const answer = await options.startRun(room.roomId);
        if (answer.status !== 202) reason = answer.reason ?? "refused";
        else runId = answer.runId ?? null;
      } catch {
        reason = "error";
      }
      const prefix = retry ? "retry_" : "";
      await db.tx(tenantId, (tx) =>
        emitEvent(tx, {
          tenantId, businessId: room.businessId, department: room.department, runId, type: "scheduled", now: clock(),
          summary: reason === undefined
            ? (retry ? "Scheduled run tried again after the search tool's wait" : "Scheduled run started")
            : `Scheduled run ${retry ? "not tried again" : "skipped"}: ${SKIPPED[reason] ?? "it could not be started"}`,
          reasonCode: reason === undefined ? `${prefix}started` : `${prefix}skipped_${reason.replace(/[^a-z0-9_]/g, "_")}`,
        }));
      results.push(reason === undefined ? { roomId: room.roomId, outcome: retry ? "retried" : "started" } : { roomId: room.roomId, outcome: "skipped", reason });
    };
    for (const room of due) await begin(room, false);

    // Today's scheduled runs that failed only on the search tool's rate limit: one more try, after the wait, then give up.
    const again = await db.tx(tenantId, async (tx) => {
      await lock(tx, "scheduler", tenantId);
      const local = (await tx.query("select (($1::timestamptz) at time zone timezone)::date::text as day, timezone from tenants where tenant_id = wh_tenant()", [now])).rows[0];
      if (!local) return [];
      const today = await tx.query(
        `select e.business_id, e.department, e.reason_code, e.run_id, b.slug, r.status, r.error, r.ended_at
           from events e join businesses b on b.business_id = e.business_id left join runs r on r.run_id = e.run_id
          where e.type = 'scheduled' and (e.created_at at time zone $1)::date = $2::date
          order by e.seq`,
        [local.timezone, local.day],
      );
      const rooms = new Map<string, any[]>();
      for (const row of today.rows) rooms.set(`${row.business_id}|${row.department}`, [...(rooms.get(`${row.business_id}|${row.department}`) ?? []), row]);
      const picked: { roomId: string; businessId: string; department: string; action: "retry" | "give_up" }[] = [];
      for (const rows of rooms.values()) {
        const has = (code: string) => rows.some((r) => String(r.reason_code).startsWith(code));
        const first = rows.find((r) => r.reason_code === "started");
        const second = rows.find((r) => r.reason_code === "retry_started");
        const room = { roomId: `${rows[0].slug}:${rows[0].department}`, businessId: rows[0].business_id as string, department: rows[0].department as string };
        if (second && second.status === "failed" && !has("gave_up")) {
          await emitEvent(tx, { tenantId, businessId: room.businessId, department: room.department, type: "scheduled", summary: "Scheduled run gave up for the day: the second try failed too", reasonCode: "gave_up", now });
          picked.push({ ...room, action: "give_up" });
        } else if (first && first.status === "failed" && first.error === "search_rate_limited" && !has("retry_")) {
          const told = await tx.query(
            "select payload ->> 'retry_after_seconds' as seconds from events where run_id = $1 and type = 'stage' and reason_code = 'rate_limited' order by seq desc limit 1",
            [first.run_id],
          );
          const seconds = Number(told.rows[0]?.seconds);
          const wait = Number.isFinite(seconds) && seconds > 0 ? seconds : 60 * 60;
          if (first.ended_at && now.getTime() >= (first.ended_at as Date).getTime() + wait * 1000) {
            // The mark that the one retry has been used is written before anything is started.
            await emitEvent(tx, { tenantId, businessId: room.businessId, department: room.department, type: "scheduled", summary: "Scheduled run due again after the search tool's wait", reasonCode: "retry_due", now });
            picked.push({ ...room, action: "retry" });
          }
        }
      }
      return picked;
    });
    for (const room of again) {
      if (room.action === "retry") await begin(room, true);
      else results.push({ roomId: room.roomId, outcome: "gave_up" });
    }
    return results;
  }

  return {
    tick,
    start(intervalMs: number) {
      if (timer) return;
      const look = () => {
        if (busy) return;
        busy = true;
        tick()
          .then(() => void (complained = false))
          .catch((err) => {
            // If the mark cannot be written, nothing is started. Said once, not every minute.
            if (!complained) console.error(`scheduler: not running anything (${err instanceof Error ? err.message : "error"})`);
            complained = true;
          })
          .finally(() => void (busy = false));
      };
      timer = setInterval(look, intervalMs);
      timer.unref();
      look();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
