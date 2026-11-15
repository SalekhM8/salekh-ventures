-- 0003: the control layer's tables: config, runs, events, proposals,
-- approvals, actions and the budget ledger.

-- Versioned config. One row per change, never updated, never deleted.
-- "Current" is the highest version for (tenant, business, kind, key).
--
--   kind         key                 value
--   target       metric name         free form
--   cap          cap key             {"limit": number}
--   rung         action type         {"rung": 1..4}
--   schedule     department          free form
--   budget       department          {"daily_limit_gbp": number}
--   kill_switch  'state'             {"engaged": true|false}
--
-- business_id NULL means the whole tenant (the global kill switch, or the
-- budget of a house wide department such as the Chief of Staff).
create table config_versions (
  config_id         uuid primary key default gen_random_uuid(),
  seq               bigint generated always as identity unique,
  tenant_id         uuid not null references tenants (tenant_id),
  business_id       uuid,
  kind              text not null check (kind in ('target', 'cap', 'rung', 'schedule', 'budget', 'kill_switch')),
  key               text not null check (length(key) between 1 and 200),
  value             jsonb not null,
  version           integer not null check (version >= 1),
  changed_by_kind   text not null check (changed_by_kind in ('member', 'system')),
  changed_by_member uuid,
  reason            text not null check (length(reason) > 0),
  created_at        timestamptz not null default now(),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, changed_by_member) references members (tenant_id, member_id),
  unique nulls not distinct (tenant_id, business_id, kind, key, version),
  check (changed_by_kind = 'system' or changed_by_member is not null),
  check (kind <> 'rung'
         or (jsonb_typeof(value -> 'rung') = 'number' and (value ->> 'rung') in ('1', '2', '3', '4'))),
  check (kind <> 'kill_switch'
         or (key = 'state' and jsonb_typeof(value -> 'engaged') = 'boolean')),
  check (kind <> 'cap' or jsonb_typeof(value -> 'limit') = 'number'),
  check (kind <> 'budget' or jsonb_typeof(value -> 'daily_limit_gbp') = 'number')
);

-- The rung currently configured for one action type on one floor. No row
-- means rung 1 (BRIEF.md section 6: every action type starts at rung 1).
create function wh_current_rung(p_tenant uuid, p_business uuid, p_action_type text) returns integer
  language sql
  stable
  set search_path = ''
as $$
  select coalesce(
    (select (c.value ->> 'rung')::integer
       from public.config_versions c
      where c.tenant_id = p_tenant
        and c.business_id = p_business
        and c.kind = 'rung'
        and c.key = p_action_type
      order by c.version desc
      limit 1),
    1)
$$;

revoke all on function wh_current_rung(uuid, uuid, text) from public;
grant execute on function wh_current_rung(uuid, uuid, text) to wh_gateway, wh_ui;

create table runs (
  run_id        uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (tenant_id),
  -- NULL: a house wide run (the Chief of Staff).
  business_id   uuid,
  department    text not null,
  trigger       text not null,
  -- NULL for a plain code run that uses no model.
  model         text,
  status        text not null default 'running' check (status in ('running', 'done', 'failed')),
  tokens_in     bigint not null default 0 check (tokens_in >= 0),
  tokens_out    bigint not null default 0 check (tokens_out >= 0),
  tokens_cached bigint not null default 0 check (tokens_cached >= 0),
  cost_gbp      numeric(14, 6) not null default 0 check (cost_gbp >= 0),
  -- What the provider reported, kept beside the pounds figure.
  cost_usd      numeric(14, 6) check (cost_usd >= 0),
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  error         text,
  unique (tenant_id, run_id),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id)
);

create index runs_tenant_started_idx on runs (tenant_id, started_at desc);

-- What a tool asked the gateway to do. One row per submission, including the
-- ones the gateway refused. The gateway decides once and the row then stays
-- as it is; what happened next is in approvals and actions.
create table proposals (
  proposal_id    uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (tenant_id),
  business_id    uuid not null,
  department     text not null,
  run_id         uuid,
  action_type    text not null,
  action_key     text not null check (length(action_key) between 1 and 200),
  payload        jsonb not null,
  reason         text not null check (length(reason) > 0),
  -- NULL until the gateway has decided.
  decision       text check (decision in ('refused', 'recommend', 'await_approval', 'execute')),
  refusal_reason text,
  config_rung    smallint check (config_rung between 1 and 4),
  effective_rung smallint check (effective_rung between 1 and 4),
  -- Set by the gateway at the "key not seen before" check. The unique index
  -- below is what makes the same key impossible to accept twice.
  key_claimed    boolean not null default false,
  created_at     timestamptz not null default now(),
  decided_at     timestamptz,
  unique (tenant_id, proposal_id),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, run_id) references runs (tenant_id, run_id),
  check ((decision = 'refused') = (refusal_reason is not null))
);

create unique index proposals_claimed_key_idx on proposals (tenant_id, action_key) where key_claimed;
create index proposals_tenant_created_idx on proposals (tenant_id, created_at desc);
create index proposals_key_idx on proposals (tenant_id, action_key);

create table approvals (
  approval_id           uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants (tenant_id),
  business_id           uuid not null,
  proposal_id           uuid not null unique,
  department            text not null,
  action_type           text not null,
  action_key            text not null,
  reasoning             text not null,
  -- The exact thing to be executed, and its sha256 over canonical JSON.
  -- No role is granted UPDATE on these two columns.
  payload               jsonb not null,
  payload_hash          text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  -- 'voided' is an addition to the four states in the brief: the stored
  -- payload no longer matches the hash that was approved.
  status                text not null default 'pending'
                          check (status in ('pending', 'approved', 'rejected', 'expired', 'voided')),
  expires_at            timestamptz not null,
  decided_by            uuid,
  decided_at            timestamptz,
  channel               text check (channel in ('app', 'telegram')),
  -- The hash the yes was given for.
  approved_payload_hash text,
  -- Set once when the approval is used to execute. Single use.
  consumed_at           timestamptz,
  void_reason           text,
  created_at            timestamptz not null default now(),
  unique (tenant_id, approval_id),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, proposal_id) references proposals (tenant_id, proposal_id),
  foreign key (tenant_id, decided_by) references members (tenant_id, member_id),
  check (status not in ('approved', 'rejected') or (decided_by is not null and decided_at is not null)),
  check (status <> 'approved' or approved_payload_hash is not null),
  check (consumed_at is null or status = 'approved')
);

create index approvals_tenant_status_idx on approvals (tenant_id, status, created_at);

-- Everything the gateway executed or tried to execute. The row is written
-- before the connector is called, so a crash mid action still leaves a trace.
create table actions (
  action_id         uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (tenant_id),
  business_id       uuid not null,
  proposal_id       uuid not null unique,
  approval_id       uuid unique,
  department        text not null,
  action_type       text not null,
  action_key        text not null,
  rung              smallint not null check (rung between 2 and 4),
  input             jsonb not null,
  input_hash        text not null,
  output            jsonb,
  outside_reference text,
  status            text not null default 'executing' check (status in ('executing', 'executed', 'failed')),
  -- NULL: not checked (no read back available, or not reached yet).
  verified          boolean,
  verified_at       timestamptz,
  verification      jsonb,
  cap_key           text not null,
  cap_units         numeric not null check (cap_units >= 0),
  undoable          boolean not null,
  error             text,
  marked_wrong_at   timestamptz,
  marked_wrong_by   uuid,
  marked_wrong_note text,
  created_at        timestamptz not null default now(),
  executed_at       timestamptz,
  -- The same action key never executes twice.
  unique (tenant_id, action_key),
  unique (tenant_id, action_id),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, proposal_id) references proposals (tenant_id, proposal_id),
  foreign key (tenant_id, approval_id) references approvals (tenant_id, approval_id),
  foreign key (tenant_id, marked_wrong_by) references members (tenant_id, member_id),
  -- Rung 2 always carries its approval. Rungs 3 and 4 never do.
  check ((rung = 2) = (approval_id is not null))
);

create index actions_cap_idx on actions (tenant_id, business_id, cap_key, created_at);

-- The stream the UI is built on.
--
-- `summary` says what happened with no names and no message text.
-- `action_type`, `rung` and `reason_code` are fixed codes, never free text.
-- `payload` holds the full detail and may hold personal data: it has a 90 day
-- life, after which it is set to NULL and the summary stays.
create table events (
  event_id           uuid primary key default gen_random_uuid(),
  seq                bigint generated always as identity unique,
  tenant_id          uuid not null references tenants (tenant_id),
  business_id        uuid,
  department         text,
  run_id             uuid,
  proposal_id        uuid,
  approval_id        uuid,
  action_id          uuid,
  type               text not null check (type in (
                       -- agent runs
                       'started', 'brief', 'tool_call', 'done', 'failed', 'handoff', 'run_refused',
                       -- the gateway
                       'proposal', 'refused', 'waiting', 'notified',
                       'approved', 'rejected', 'expired', 'voided', 'answer_refused',
                       'executing', 'executed', 'execution_failed', 'verified', 'verify_failed',
                       'demoted', 'marked_wrong',
                       -- settings
                       'kill_switch_engaged', 'kill_switch_resumed', 'config_changed')),
  summary            text not null check (length(summary) between 1 and 280),
  action_type        text,
  rung               smallint check (rung between 1 and 4),
  reason_code        text check (reason_code ~ '^[a-z0-9_]+$'),
  payload            jsonb,
  payload_expires_at timestamptz,
  created_at         timestamptz not null default now(),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  check (payload is null or payload_expires_at is not null)
);

create index events_tenant_seq_idx on events (tenant_id, seq);
create index events_payload_expiry_idx on events (payload_expires_at) where payload is not null;

-- Tokens and pounds per department per day against its limit.
create table budget_ledger (
  ledger_id     uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (tenant_id),
  -- NULL: a house wide department (the Chief of Staff).
  business_id   uuid,
  department    text not null,
  day           date not null,
  tokens_in     bigint not null default 0,
  tokens_out    bigint not null default 0,
  tokens_cached bigint not null default 0,
  cost_gbp      numeric(14, 6) not null default 0,
  -- The limit in force when the row was last written. NULL: none configured.
  limit_gbp     numeric(14, 6),
  run_count     integer not null default 0,
  updated_at    timestamptz not null default now(),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  unique nulls not distinct (tenant_id, business_id, department, day)
);
