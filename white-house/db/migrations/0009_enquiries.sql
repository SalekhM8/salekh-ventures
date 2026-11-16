-- 0009: the test enquiry (mystery shop) by email, and the capture score.
--
--   enquiries   one row per test enquiry drafted for a business: who it goes
--               to, exactly what it says, where it has got to. The database
--               itself holds the rule that a business, and an email address,
--               is sent at most one enquiry ever.
--   prospects   gain a capture score beside the fit score. The replies to an
--               enquiry are personal data and live in prospects.test_result
--               only, cleared by the same purge as the rest.

create table enquiries (
  enquiry_id     uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (tenant_id),
  business_id    uuid not null,
  prospect_id    uuid not null,
  -- The address the business publishes on its own site, and the same address in lower case.
  to_address     text not null,
  to_address_key text not null check (to_address_key = lower(to_address_key)),
  -- Why this business is being tested: as a possible client, or as the local rival of one that scored low.
  purpose        text not null default 'prospect' check (purpose in ('prospect', 'rival')),
  subject        text not null check (length(subject) between 1 and 200),
  body           text not null check (length(body) between 1 and 2000),
  -- proposed   drafted and waiting for a yes (or about to be put to the gateway)
  -- approved   the yes is recorded; waiting its turn to be sent
  -- sending    claimed by the sender: from here on it is never sent again, whatever happens
  -- sent       accepted by the mail server, with its Message-ID
  -- failed     the send failed after it was claimed. Not retried: it may have gone
  -- rejected, expired   never sent. Only these two leave room for a later enquiry to the same business
  status         text not null default 'proposed'
                   check (status in ('proposed', 'approved', 'sending', 'sent', 'failed', 'rejected', 'expired')),
  approval_id    uuid,
  action_id      uuid,
  -- The Message-ID header of what was sent. Replies are recognised by it.
  message_id     text,
  proposed_at    timestamptz not null default now(),
  decided_at     timestamptz,
  sent_at        timestamptz,
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, prospect_id) references prospects (tenant_id, prospect_id),
  foreign key (tenant_id, approval_id) references approvals (tenant_id, approval_id),
  foreign key (tenant_id, action_id) references actions (tenant_id, action_id),
  unique (tenant_id, enquiry_id),
  check ((status in ('sent')) = (message_id is not null and sent_at is not null) or status = 'failed')
);

-- ONE ENQUIRY PER BUSINESS, EVER, and one per email address, ever. Only an
-- enquiry that was rejected or expired before sending leaves room for another.
create unique index enquiries_one_per_business_idx on enquiries (tenant_id, prospect_id)
  where status not in ('rejected', 'expired');
create unique index enquiries_one_per_address_idx on enquiries (tenant_id, to_address_key)
  where status not in ('rejected', 'expired');
create index enquiries_status_idx on enquiries (tenant_id, business_id, status, sent_at);
create unique index enquiries_message_idx on enquiries (tenant_id, message_id) where message_id is not null;

alter table enquiries enable row level security;
alter table enquiries force row level security;
revoke all on table enquiries from public;
create policy tenant_isolation on enquiries as restrictive for all to public
  using (tenant_id = (select wh_tenant())) with check (tenant_id = (select wh_tenant()));
create policy role_access on enquiries as permissive for all to wh_agent, wh_gateway, wh_ui using (true) with check (true);

-- Agent tools: nothing. The gateway's role drafts, sends and records. The UI's role reads them to show the approval.
grant select, insert on enquiries to wh_gateway;
-- Not the address, the subject or the body: what was approved cannot be rewritten.
grant update (status, approval_id, action_id, message_id, decided_at, sent_at) on enquiries to wh_gateway;
grant select on enquiries to wh_ui;

alter table prospects add column capture_score numeric(6, 2);
alter table prospects add column capture_breakdown jsonb;
-- Why no enquiry can be sent: for example no email address is published. NULL: testable, or not yet looked at.
alter table prospects add column not_testable_reason text;
grant update (capture_score, capture_breakdown, not_testable_reason) on prospects to wh_gateway;
