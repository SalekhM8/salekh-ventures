-- 0008: one more event type, for the runner's daily schedule.
--
-- A room's schedule lives in config (kind "schedule"), which already holds its
-- live flag: {"live": true, "daily_at": "08:00"} starts that room once a day at
-- that time in the tenant's time zone. Each day the scheduler writes one
-- "scheduled" event for the room before it tries to start the run. That event
-- is the record that the day has been dealt with, so a runner that restarts
-- does not start the same day's run again. When the run could not start (the
-- kill switch is set, the budget is spent) a second "scheduled" event says why.

alter table events drop constraint events_type_check;
alter table events add constraint events_type_check check (type in (
  'started', 'brief', 'tool_call', 'done', 'failed', 'handoff', 'run_refused',
  'output', 'metrics_pulled', 'acknowledged', 'scored', 'stage', 'scheduled',
  'proposal', 'refused', 'waiting', 'notified',
  'approved', 'rejected', 'expired', 'voided', 'answer_refused',
  'executing', 'executed', 'execution_failed', 'verified', 'verify_failed',
  'demoted', 'marked_wrong',
  'kill_switch_engaged', 'kill_switch_resumed', 'config_changed'));

create index events_scheduled_idx on events (tenant_id, business_id, department, created_at) where type = 'scheduled';
