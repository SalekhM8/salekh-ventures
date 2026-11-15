-- 0004: the tables later phases fill: metrics, memory notes, scores, tests,
-- the queue, notifications, devices and the public feed. Created now so the
-- whole data model in BRIEF.md section 9 exists and is covered by row level
-- security from the first day.

create table metrics (
  metric_id     uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (tenant_id),
  business_id   uuid not null,
  metric        text not null,
  value         numeric not null,
  metric_date   date not null,
  source        text not null,
  -- "window" is a reserved word in SQL, hence the longer name.
  metric_window text not null,
  pulled_at     timestamptz not null default now(),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  unique (tenant_id, business_id, metric, metric_date, source, metric_window)
);

create table memory_notes (
  note_id     uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (tenant_id),
  -- NULL: applies to that department on every floor.
  business_id uuid,
  department  text not null,
  note        text not null,
  status      text not null default 'proposed' check (status in ('proposed', 'approved', 'retired')),
  source_run  uuid,
  approved_by uuid,
  approved_at timestamptz,
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, source_run) references runs (tenant_id, run_id),
  foreign key (tenant_id, approved_by) references members (tenant_id, member_id),
  check (status <> 'approved' or approved_by is not null)
);

create index memory_notes_lookup_idx on memory_notes (tenant_id, department, status);

create table scores (
  score_id    uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (tenant_id),
  business_id uuid,
  run_id      uuid,
  proposal_id uuid,
  action_id   uuid,
  member_id   uuid not null,
  score       smallint not null check (score between 1 and 10),
  note        text,
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, run_id) references runs (tenant_id, run_id),
  foreign key (tenant_id, proposal_id) references proposals (tenant_id, proposal_id),
  foreign key (tenant_id, action_id) references actions (tenant_id, action_id),
  foreign key (tenant_id, member_id) references members (tenant_id, member_id),
  -- Under 9 needs a note saying what was wrong (BRIEF.md section 10).
  check (score >= 9 or length(btrim(coalesce(note, ''))) > 0)
);

create index scores_tenant_idx on scores (tenant_id, created_at desc);

create table eval_cases (
  case_id     uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (tenant_id),
  business_id uuid not null,
  department  text not null,
  title       text not null,
  situation   jsonb not null,
  expected    jsonb not null,
  must_never  jsonb not null default '[]'::jsonb,
  is_attack   boolean not null default false,
  source_run  uuid,
  status      text not null default 'active' check (status in ('active', 'retired')),
  created_at  timestamptz not null default now(),
  unique (tenant_id, case_id),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, source_run) references runs (tenant_id, run_id)
);

create index eval_cases_lookup_idx on eval_cases (tenant_id, business_id, department);

create table eval_runs (
  eval_run_id uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (tenant_id),
  business_id uuid not null,
  department  text not null,
  trigger     text not null,
  model       text,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  total       integer not null default 0,
  passed      integer not null default 0,
  failed      integer not null default 0,
  -- Per case results: [{case_id, passed, detail}].
  results     jsonb not null default '[]'::jsonb,
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id)
);

create index eval_runs_lookup_idx on eval_runs (tenant_id, business_id, department, started_at desc);

create table queue_items (
  item_id         uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (tenant_id),
  business_id     uuid,
  kind            text not null check (kind in ('filming_request', 'handoff', 'escalation')),
  from_department text not null,
  to_department   text,
  title           text not null,
  body            jsonb not null default '{}'::jsonb,
  status          text not null default 'open' check (status in ('open', 'in_progress', 'done', 'cancelled')),
  source_run      uuid,
  created_at      timestamptz not null default now(),
  closed_at       timestamptz,
  closed_by       uuid,
  unique (tenant_id, item_id),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, source_run) references runs (tenant_id, run_id),
  foreign key (tenant_id, closed_by) references members (tenant_id, member_id)
);

create index queue_items_open_idx on queue_items (tenant_id, status, created_at);

create table notifications (
  notification_id uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (tenant_id),
  business_id     uuid,
  member_id       uuid not null,
  channel         text not null check (channel in ('in_app', 'push', 'email', 'telegram')),
  kind            text not null check (kind in ('approval', 'action', 'alert', 'digest', 'filming_request')),
  -- A fixed line written by code. No names, no message text.
  title           text not null,
  approval_id     uuid,
  action_id       uuid,
  queue_item_id   uuid,
  sent_at         timestamptz,
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, member_id) references members (tenant_id, member_id),
  foreign key (tenant_id, approval_id) references approvals (tenant_id, approval_id),
  foreign key (tenant_id, action_id) references actions (tenant_id, action_id),
  foreign key (tenant_id, queue_item_id) references queue_items (tenant_id, item_id)
);

create index notifications_member_idx on notifications (tenant_id, member_id, created_at desc);

create table devices (
  device_id    uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (tenant_id),
  -- Always NULL today: a device belongs to a person, not to a floor.
  business_id  uuid,
  member_id    uuid not null,
  platform     text not null check (platform in ('web', 'ios', 'android')),
  -- The push subscription or token for this device.
  subscription jsonb not null,
  label        text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, member_id) references members (tenant_id, member_id)
);

create index devices_member_idx on devices (tenant_id, member_id);

-- The censored, delayed rows the landing page may show. Written by code from
-- an allow list (BRIEF.md section 13). Nothing here is ever real detail.
create table public_feed (
  feed_id       uuid primary key default gen_random_uuid(),
  seq           bigint generated always as identity unique,
  tenant_id     uuid not null references tenants (tenant_id),
  business_id   uuid,
  department    text not null,
  state         text not null check (state in ('idle', 'working', 'waiting', 'done', 'failed', 'handoff')),
  line          text not null check (length(line) between 1 and 120),
  visible_after timestamptz not null,
  created_at    timestamptz not null default now(),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id)
);

create index public_feed_visible_idx on public_feed (tenant_id, visible_after);
