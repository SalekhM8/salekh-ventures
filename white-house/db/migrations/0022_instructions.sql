-- 0022: instructions to the Chief of Staff, and the engineering tickets they become.
--
--   instructions          one row per thing Salekh typed to the Chief of Staff, with what it understood. Never
--                         changed and never deleted: what happened next is a new row in instruction_updates.
--   instruction_updates   one row per step: read, proposed, done, not done, waiting for engineering, a question
--                         asked, answered. The current status is the newest row.
--
-- What the Chief of Staff may do with an instruction is fixed in code (runner/src/chief/instructions.ts):
--   setting      one change from a closed list (follow-ups ask first, pause a floor, a kind of business on or off,
--                a place added or taken off). It is only ever PROPOSED: nothing changes until Salekh says yes, and
--                then it is made through the same owner-only code as the switches in the app. It can never raise a
--                rung or lift a stop: those are refused in code, whatever the model said.
--   engineering  a change to code or behaviour. Stored as a ticket for a Claude Code session to pick up with
--                `npm run tickets`. The app says "Waiting for engineering", never "done", until a session marks it.
--   question     not clear enough to act on: one short question back.
--
-- Personal data: what Salekh typed may name a business or a person. It lives here and in /v1/instructions only,
-- never in an event's summary or payload.
--
-- Agent tools: nothing. The gateway's role writes (the runner does the reading and proposing). The UI's role reads.

create table instructions (
  instruction_id  uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (tenant_id),
  -- Instructions are to the whole house, so no floor: kept for the rule that every table carries one.
  business_id     uuid,
  -- When this answers a question the Chief of Staff asked, the instruction that asked it.
  answers         uuid,
  said            text not null check (length(said) between 1 and 1000),
  created_at      timestamptz not null default now(),
  check (business_id is null),
  unique (tenant_id, instruction_id),
  foreign key (tenant_id, answers) references instructions (tenant_id, instruction_id)
);
create index instructions_tenant_idx on instructions (tenant_id, created_at desc);

create table instruction_updates (
  update_id       uuid primary key default gen_random_uuid(),
  -- The order the steps happened in, even when two share a moment.
  seq             bigint generated always as identity,
  tenant_id       uuid not null references tenants (tenant_id),
  instruction_id  uuid not null,
  -- The floor a setting change is for. null for anything else.
  business_id     uuid,
  status          text not null check (status in (
                    'reading',              -- the Chief of Staff is reading it
                    'proposed',             -- a setting change, waiting for his yes
                    'done',                 -- the change is made, or an engineering session marked the ticket done
                    'not_done',             -- he said no, it is not allowed, or it could not be made
                    'waiting_engineering',  -- an engineering ticket, waiting for a Claude Code session
                    'needs_answer',         -- a question for him
                    'answered')),           -- he answered the question (the answer is its own instruction)
  -- What the Chief of Staff understood, in one line (on the first reading).
  restated        text check (restated is null or length(restated) between 1 and 300),
  department      text check (department is null or department in ('outreach', 'engineering', 'research', 'data', 'marketing')),
  kind            text check (kind is null or kind in ('setting', 'engineering', 'question')),
  -- The setting change, as code checked it: {"what": ..., "floor": ..., "kind_id": ..., "place": ...}.
  change          jsonb,
  question        text check (question is null or length(question) between 1 and 400),
  -- The brief for the engineering session.
  ticket          text check (ticket is null or length(ticket) between 1 and 3000),
  -- A fixed reason, or the note an engineering session left when it marked the ticket done.
  note            text check (note is null or length(note) between 1 and 2000),
  -- Who: the runner (system), the owner (member), or an engineering session (engineering).
  by_kind         text not null check (by_kind in ('system', 'member', 'engineering')),
  member_id       uuid,
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, instruction_id) references instructions (tenant_id, instruction_id),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  check (status <> 'proposed' or change is not null),
  check (status <> 'waiting_engineering' or ticket is not null),
  check (status <> 'needs_answer' or question is not null)
);
create index instruction_updates_idx on instruction_updates (tenant_id, instruction_id, seq desc);
create index instruction_updates_open_tickets_idx on instruction_updates (tenant_id, created_at) where status = 'waiting_engineering';

alter table instructions enable row level security;
alter table instructions force row level security;
alter table instruction_updates enable row level security;
alter table instruction_updates force row level security;
revoke all on table instructions, instruction_updates from public;
create policy tenant_isolation on instructions as restrictive for all to public
  using (tenant_id = (select wh_tenant())) with check (tenant_id = (select wh_tenant()));
create policy role_access on instructions as permissive for all to wh_gateway, wh_ui using (true) with check (true);
create policy tenant_isolation on instruction_updates as restrictive for all to public
  using (tenant_id = (select wh_tenant())) with check (tenant_id = (select wh_tenant()));
create policy role_access on instruction_updates as permissive for all to wh_gateway, wh_ui using (true) with check (true);

-- Append only, for everyone: no update, no delete.
grant select, insert on instructions, instruction_updates to wh_gateway;
grant select on instructions, instruction_updates to wh_ui;
