import type { TrafficConnector } from "../control/connectors/posthog.js";
import type { Db } from "../control/db.js";
import { tenantDay } from "../control/runs.js";

/**
 * Plain code, no model (rule 2): pull daily traffic totals into `metrics`.
 * Whole days only, ending yesterday. Pulling the same day again replaces the
 * stored value, so a late correction at the source is picked up.
 */

export interface PullTrafficInput {
  tenantId: string;
  businessId: string;
  connector: TrafficConnector;
  hosts: string[];
  now: Date;
  /** How many whole days back to pull. */
  days?: number;
}

const shiftDay = (day: string, by: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + by);
  return date.toISOString().slice(0, 10);
};

/** Returns the number of metric rows written. */
export async function pullTraffic(db: Db, input: PullTrafficInput): Promise<number> {
  const { today, timezone } = await db.tx(input.tenantId, async (tx) => ({
    today: await tenantDay(tx, input.now),
    timezone: (await tx.query("select timezone from tenants where tenant_id = wh_tenant()")).rows[0].timezone as string,
  }));
  // The outside call happens with no transaction open.
  const days = await input.connector.dailyTraffic({
    hosts: input.hosts,
    from: shiftDay(today, -(input.days ?? 28)),
    to: today,
    timezone,
  });
  if (days.length === 0) return 0;
  return db.tx(input.tenantId, async (tx) => {
    let written = 0;
    for (const day of days) {
      for (const metric of ["pageviews", "visitors", "sessions"] as const) {
        await tx.query(
          `insert into metrics (tenant_id, business_id, metric, value, metric_date, source, metric_window, pulled_at)
           values ($1, $2, $3, $4, $5::date, 'posthog', '1d', $6)
           on conflict (tenant_id, business_id, metric, metric_date, source, metric_window)
           do update set value = excluded.value, pulled_at = excluded.pulled_at`,
          [input.tenantId, input.businessId, metric, day[metric], day.day, input.now],
        );
        written += 1;
      }
    }
    return written;
  });
}
