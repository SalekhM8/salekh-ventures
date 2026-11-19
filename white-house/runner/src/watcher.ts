import { lock, type Db, type Tx } from "./control/db.js";
import { emitEvent } from "./control/events.js";

/**
 * The Engineering watcher. Plain code, no model.
 *
 * Once an hour it looks at each Outreach room and writes down, in one plain line, whether it is all right:
 * did today's scheduled run start and finish, did a shortlist come out and how many profiles it holds, did
 * enquiries go out, is sending stopped, is the owner's mailbox connected. The line is a "health" event, which
 * /v1/house hands to the Chief of Staff, so the owner is told when something is wrong instead of finding out
 * by asking (owner's wish, 18 Nov 2026).
 *
 * It only reports. It never sends anything, never lifts a stop, never starts or stops a run.
 *
 * One event is written when the answer changes, and at least one each day, so the log is not filled with the
 * same line every hour. Summaries are fixed templates with times and counts only: no names, no addresses, no
 * dates (a date can look like a phone number to the event check).
 */

export const HEALTH_DEPARTMENT = "engineering";
/** How long after the daily time a run must have started before it counts as missed. */
export const START_GRACE_MS = 45 * 60 * 1000;
/** A run still going after this long is said to be stuck. */
export const STUCK_AFTER_MS = 3 * 60 * 60 * 1000;
/** Enquiries waiting to go out this long after the daily time, with none sent today, is a problem. */
export const SEND_GRACE_MS = 4 * 60 * 60 * 1000;

const SKIPPED: Record<string, string> = {
  kill_switch: "you have everything paused",
  over_budget: "today's budget is spent",
  no_budget: "it has no daily budget set",
  already_running: "a run was already going",
  no_api_key: "the model key is missing",
  no_agent: "it has no live agent",
  bad_settings: "its settings are not valid",
  brief_required: "it needs a brief",
};

export interface OutreachHealth {
  businessId: string;
  slug: string;
  ok: boolean;
  /** The plain line for the Chief of Staff. */
  line: string;
  /** Fixed codes, one per problem found. */
  problems: string[];
  counts: { profiles: number | null; sent_today: number; waiting_to_send: number };
}

export interface WatcherOptions {
  /** The gateway's role. */
  db: Db;
  tenantId: string;
  now?: () => Date;
  /** Whether each mailbox was connected when the runner started. */
  mailboxes: { test: boolean; owner: boolean };
  /** Why sending is stopped today, or null. The same check the sender uses. */
  stopToday: (now: Date) => Promise<string | null>;
}

export interface Watcher {
  /** Look once, write an event where the answer changed. Returns what was found. */
  check(): Promise<OutreachHealth[]>;
  start(intervalMs: number): void;
  stop(): void;
}

const hhmm = (d: Date, timezone: string) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone });

async function lookAt(tx: Tx, room: { business_id: string; slug: string; value: any }, now: Date, local: { day: string; time: string; timezone: string }, opts: WatcherOptions, stop: string | null): Promise<OutreachHealth> {
  const problems: string[] = [];
  const says: string[] = [];
  const at = typeof room.value?.daily_at === "string" ? (room.value.daily_at as string) : null;
  const live = room.value?.live === true;
  const today = (col: string) => `(${col} at time zone $2)::date = $3::date`;
  const args = [room.business_id, local.timezone, local.day];

  // The daily time, today, as a moment.
  const dueAt = at ? new Date((await tx.query(`select (($1::date + $2::time) at time zone $3) as t`, [local.day, at, local.timezone])).rows[0].t) : null;
  const pastStart = dueAt !== null && now.getTime() >= dueAt.getTime() + START_GRACE_MS;

  const scheduled = (await tx.query(
    `select reason_code from events where type = 'scheduled' and business_id = $1 and department = 'outreach' and ${today("created_at")} order by seq`, args,
  )).rows.map((r) => String(r.reason_code));
  const runs = (await tx.query(
    `select status, error, started_at, ended_at from runs where business_id = $1 and department = 'outreach' and ${today("started_at")} order by started_at`, args,
  )).rows;
  const shortlist = (await tx.query(
    `select created_at, jsonb_array_length(coalesce(data -> 'cards', '[]'::jsonb)) as n from outputs
      where business_id = $1 and department = 'outreach' and title like 'Shortlist%' and ${today("created_at")} order by created_at desc limit 1`, args,
  )).rows[0];
  const enquiries = (await tx.query(
    `select count(*) filter (where status = 'sent' and ${today("sent_at")})::int as sent,
            count(*) filter (where status in ('queued', 'approved'))::int as waiting,
            count(*) filter (where status = 'failed' and ${today("coalesce(sent_at, proposed_at)")})::int as failed
       from enquiries where business_id = $1`, args,
  )).rows[0];

  if (!live || !at) says.push("Outreach has no daily time set, so it only runs when you press run");
  else if (!pastStart && runs.length === 0) says.push(`Outreach is due at ${at}`);
  else {
    const skipped = scheduled.find((c) => c.startsWith("skipped_") || c.startsWith("retry_skipped_"));
    const started = scheduled.some((c) => c === "started" || c === "retry_started") || runs.length > 0;
    if (scheduled.includes("gave_up")) {
      problems.push("gave_up");
      says.push("Outreach failed twice today and gave up for the day");
    } else if (!started && skipped) {
      problems.push(`not_started_${skipped.replace(/^(retry_)?skipped_/, "")}`);
      says.push(`Outreach didn't run today because ${SKIPPED[skipped.replace(/^(retry_)?skipped_/, "")] ?? "it could not be started"}`);
    } else if (!started) {
      problems.push("not_started");
      says.push(`Outreach didn't start this morning (it was due at ${at})`);
    } else {
      const last = runs.at(-1);
      const stuck = runs.find((r) => r.status === "running" && now.getTime() - (r.started_at as Date).getTime() > STUCK_AFTER_MS);
      if (stuck) {
        problems.push("run_stuck");
        says.push(`Outreach has been running since ${hhmm(stuck.started_at, local.timezone)} and looks stuck`);
      } else if (last?.status === "running") says.push(`Outreach is running (started ${hhmm(last.started_at, local.timezone)})`);
      else if (last?.status === "failed" && !shortlist) {
        problems.push("run_failed");
        says.push(`Outreach stopped with an error at ${hhmm(last.ended_at ?? last.started_at, local.timezone)} and no profiles came out`);
      } else if (!shortlist && last?.status === "done") {
        problems.push("no_shortlist");
        says.push("Outreach finished but no profiles came out");
      }
    }
  }
  if (shortlist) says.push(`${shortlist.n} ${Number(shortlist.n) === 1 ? "profile" : "profiles"} ready since ${hhmm(shortlist.created_at, local.timezone)}`);

  if (stop) {
    problems.push("sending_stopped");
    says.push(`sending is stopped today (${stop.replace(/[.\s]+$/, "")})`);
  } else if (!opts.mailboxes.test) {
    problems.push("test_mailbox_missing");
    says.push("the enquiry mailbox isn't connected, so no enquiries can go out");
  } else if (dueAt && now.getTime() >= dueAt.getTime() + SEND_GRACE_MS && enquiries.sent === 0 && enquiries.waiting > 0) {
    problems.push("enquiries_not_going");
    says.push(`${enquiries.waiting} enquiries are waiting and none went out today`);
  } else if (enquiries.sent > 0) says.push(`${enquiries.sent} ${enquiries.sent === 1 ? "enquiry" : "enquiries"} sent today`);
  if (enquiries.failed >= 3) {
    problems.push("send_failures");
    says.push(`${enquiries.failed} enquiries failed to send today`);
  }
  if (!opts.mailboxes.owner) {
    problems.push("owner_mailbox_missing");
    says.push("your mailbox isn't connected, so follow-up emails can't send");
  }

  const sentence = (parts: string[]) => {
    const s = parts.join(". ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  const line = (problems.length === 0 ? `All fine. ${sentence(says)}.` : `Outreach needs a look. ${sentence(says)}.`).slice(0, 280);
  return {
    businessId: room.business_id, slug: room.slug, ok: problems.length === 0, line, problems,
    counts: { profiles: shortlist ? Number(shortlist.n) : null, sent_today: enquiries.sent, waiting_to_send: enquiries.waiting },
  };
}

export function createWatcher(options: WatcherOptions): Watcher {
  const { db, tenantId } = options;
  const clock = options.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let busy = false;
  let complained = false;

  async function check(): Promise<OutreachHealth[]> {
    const now = clock();
    const stop = await options.stopToday(now);
    return db.tx(tenantId, async (tx) => {
      await lock(tx, "watcher", tenantId);
      const local = (await tx.query(
        `select (($1::timestamptz) at time zone timezone)::date::text as day, to_char(($1::timestamptz) at time zone timezone, 'HH24:MI') as time, timezone
           from tenants where tenant_id = wh_tenant()`, [now],
      )).rows[0];
      if (!local) return [];
      const rooms = (await tx.query(
        `select b.business_id, b.slug,
                (select c.value from config_versions c where c.business_id = b.business_id and c.kind = 'schedule' and c.key = 'outreach' order by c.version desc limit 1) as value
           from businesses b where b.status = 'active' and 'outreach' = any (b.departments) order by b.created_at, b.slug`,
      )).rows;
      const found: OutreachHealth[] = [];
      for (const room of rooms) {
        const health = await lookAt(tx, room, now, local, options, stop);
        found.push(health);
        const last = (await tx.query(
          `select summary, (created_at at time zone $2)::date::text as day from events
            where type = 'health' and business_id = $1 and department = $3 order by seq desc limit 1`,
          [room.business_id, local.timezone, HEALTH_DEPARTMENT],
        )).rows[0];
        if (last && last.summary === health.line && last.day === local.day) continue;
        await emitEvent(tx, {
          tenantId, businessId: room.business_id, department: HEALTH_DEPARTMENT, type: "health", now,
          summary: health.line, reasonCode: health.ok ? "outreach_fine" : "outreach_problem",
          payload: { problems: health.problems, counts: health.counts },
        });
      }
      return found;
    });
  }

  return {
    check,
    start(intervalMs: number) {
      if (timer) return;
      const look = () => {
        if (busy) return;
        busy = true;
        check()
          .then(() => void (complained = false))
          .catch((err) => {
            if (!complained) console.error(`watcher: could not check (${err instanceof Error ? err.message : "error"})`);
            complained = true;
          })
          .finally(() => void (busy = false));
      };
      timer = setInterval(look, intervalMs);
      timer.unref();
      // The first look a few minutes after start, so a restart is not reported as a missed run while things come up.
      setTimeout(look, 5 * 60_000).unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
