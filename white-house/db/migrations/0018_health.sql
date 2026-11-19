-- 0018: one more event type, for the Engineering watcher.
--
-- Once an hour the runner looks at each Outreach room (did today's run start and finish, did profiles come out,
-- did enquiries go, is sending stopped, are the mailboxes connected) and writes one "health" event when the
-- answer changes, and at least one a day. Its summary is a plain line for the Chief of Staff, built by code from
-- fixed words, times and counts. The watcher only reports: it sends nothing and lifts nothing.

alter table events drop constraint events_type_check;
alter table events add constraint events_type_check check (type in (
  'started', 'brief', 'tool_call', 'done', 'failed', 'handoff', 'run_refused',
  'output', 'metrics_pulled', 'acknowledged', 'scored', 'stage', 'scheduled',
  'proposal', 'refused', 'waiting', 'notified',
  'approved', 'rejected', 'expired', 'voided', 'answer_refused',
  'executing', 'executed', 'execution_failed', 'verified', 'verify_failed',
  'demoted', 'marked_wrong',
  'kill_switch_engaged', 'kill_switch_resumed', 'config_changed',
  'health'));

create index events_health_idx on events (tenant_id, business_id, seq desc) where type = 'health';
