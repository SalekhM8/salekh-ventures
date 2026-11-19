-- 0021: the Closer's plans.
--
--   plans  one row per one-page plan written for Salekh to read before he speaks to a business again: what the
--          test found (written by code from the stored results), what he would set up for them, the likely
--          objections with plain answers, and the price (written by code from the strategy's price list).
--
-- A plan is for Salekh's eyes only. Nothing in it is ever sent to the business: no action type, no connector and no
-- mailbox goes with this table.
--
-- Append only. A new plan for the same business is a new row; the newest is the one shown. Nothing is updated or
-- deleted, by anyone.
--
-- Personal data: the business's name is on the prospect, not here. The plan text can carry what Salekh's call note
-- said (in the model's words). It lives here and nowhere else: never in an event's summary or payload, never in
-- /v1/house. Read back only by GET /v1/rooms/:roomId/plans.
--
-- Agent tools: nothing. The gateway's role writes. The UI's role reads.

create table plans (
  plan_id         uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (tenant_id),
  business_id     uuid not null,
  prospect_id     uuid not null,
  -- The call that led to it, when there was one.
  call_outcome_id uuid,
  -- 'outcome': written when a call was recorded as interested or meeting booked. 'asked': Salekh pressed "Make a plan".
  trigger         text not null check (trigger in ('outcome', 'asked')),
  body            text not null check (length(body) between 1 and 12000),
  -- The facts the plan was built from, exactly as code wrote them, so a plan can always be checked against them.
  facts           jsonb not null default '{}'::jsonb,
  -- What the code checks found wrong in the model's part, in fixed words. Empty: it passed.
  problems        jsonb not null default '[]'::jsonb,
  model           text,
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, prospect_id) references prospects (tenant_id, prospect_id),
  unique (tenant_id, plan_id)
);

create index plans_prospect_idx on plans (tenant_id, prospect_id, created_at desc);
create index plans_business_idx on plans (tenant_id, business_id, created_at desc);

alter table plans enable row level security;
alter table plans force row level security;
revoke all on table plans from public;
create policy tenant_isolation on plans as restrictive for all to public
  using (tenant_id = (select wh_tenant())) with check (tenant_id = (select wh_tenant()));
create policy role_access on plans as permissive for all to wh_agent, wh_gateway, wh_ui using (true) with check (true);

-- Append only: insert and read for the gateway, read for the UI. No update, no delete, for anyone.
grant select, insert on plans to wh_gateway;
grant select on plans to wh_ui;

-- Not yet covered by the 90 day purge of prospects, like call notes and follow-ups: a business with a plan has
-- been called. A retention rule is still to be decided.
