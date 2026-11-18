-- 0016: what happened when Salekh telephoned a business from the call list.
--
--   call_outcomes  one row each time an outcome is recorded. Append only: a later call adds a row, nothing is
--                  changed or deleted, so the history of every business stays.
--
-- Personal data. `note` is written by the owner and may hold the name of the person spoken to. It lives here and
-- nowhere else: never in events (their summary is a fixed line), never in /v1/house. It is read back only by
-- GET /v1/rooms/:roomId/calls, like the other lists that carry personal data on purpose.
--
-- Agent tools: nothing. The gateway's role records and reads them (the runner's API runs as it). The UI's role reads.

create table call_outcomes (
  call_outcome_id uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (tenant_id),
  business_id     uuid not null,
  prospect_id     uuid not null,
  outcome         text not null check (outcome in ('no_answer', 'call_back', 'interested', 'meeting_booked', 'not_interested', 'wrong_person')),
  note            text check (note is null or length(note) between 1 and 1000),
  -- When to ring again. Only for a call back or an interested business.
  follow_up_on    date check (follow_up_on is null or outcome in ('call_back', 'interested')),
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, prospect_id) references prospects (tenant_id, prospect_id)
);

create index call_outcomes_prospect_idx on call_outcomes (tenant_id, prospect_id, created_at);
create index call_outcomes_business_idx on call_outcomes (tenant_id, business_id, created_at);

alter table call_outcomes enable row level security;
alter table call_outcomes force row level security;
revoke all on table call_outcomes from public;
create policy tenant_isolation on call_outcomes as restrictive for all to public
  using (tenant_id = (select wh_tenant())) with check (tenant_id = (select wh_tenant()));
create policy role_access on call_outcomes as permissive for all to wh_agent, wh_gateway, wh_ui using (true) with check (true);

-- No update and no delete for anyone: the history is kept.
grant select, insert on call_outcomes to wh_gateway;
grant select on call_outcomes to wh_ui;

-- Not yet covered by the 90 day purge of prospects (which clears only businesses that were filtered out, and a
-- business that has been called is on the call list). A retention rule for call notes is still to be decided.
