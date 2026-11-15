-- 0006: what the house UI and the first agents need.
--
--   * outputs: the finished pieces of work a department produces.
--   * scores attach to an output.
--   * a failed run can be acknowledged, which clears the room's failed state.
--   * tenants get a slug (used to find the tenant's own API key in the
--     runner's environment, never stored here).
--   * four more event types.

alter table tenants add column slug text check (slug ~ '^[a-z0-9][a-z0-9-]*$');
create unique index tenants_slug_idx on tenants (slug);

-- A finished piece of work: a daily read, a research report. The body is
-- Markdown. It can hold anything the agent wrote, so it is private detail,
-- never copied into an event summary.
create table outputs (
  output_id   uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (tenant_id),
  -- NULL: work for the whole house (the Chief of Staff's digest, later).
  business_id uuid,
  department  text not null,
  run_id      uuid,
  title       text not null check (length(title) between 1 and 200),
  body        text not null check (length(body) between 1 and 200000),
  created_at  timestamptz not null default now(),
  unique (tenant_id, output_id),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, run_id) references runs (tenant_id, run_id)
);

create index outputs_room_idx on outputs (tenant_id, business_id, department, created_at desc);

alter table outputs enable row level security;
alter table outputs force row level security;
revoke all on table outputs from public;
create policy tenant_isolation on outputs as restrictive for all to public
  using (tenant_id = (select wh_tenant()))
  with check (tenant_id = (select wh_tenant()));
create policy role_access on outputs as permissive for all
  to wh_agent, wh_gateway, wh_ui using (true) with check (true);

-- An agent tool may add an output. Nobody may change or delete one.
grant insert (output_id, tenant_id, business_id, department, run_id, title, body, created_at) on outputs to wh_agent;
grant select on outputs to wh_gateway, wh_ui;

alter table scores add column output_id uuid;
alter table scores add foreign key (tenant_id, output_id) references outputs (tenant_id, output_id);
create index scores_output_idx on scores (tenant_id, output_id, created_at desc);

alter table runs add column acknowledged_at timestamptz;

-- Plain code pulls metrics on a schedule and pulls the same day again later,
-- so the gateway may correct a value it has already stored.
grant update (value, pulled_at) on metrics to wh_gateway;

alter table events drop constraint events_type_check;
alter table events add constraint events_type_check check (type in (
  'started', 'brief', 'tool_call', 'done', 'failed', 'handoff', 'run_refused',
  'output', 'metrics_pulled', 'acknowledged', 'scored',
  'proposal', 'refused', 'waiting', 'notified',
  'approved', 'rejected', 'expired', 'voided', 'answer_refused',
  'executing', 'executed', 'execution_failed', 'verified', 'verify_failed',
  'demoted', 'marked_wrong',
  'kill_switch_engaged', 'kill_switch_resumed', 'config_changed'));
