-- 0017: follow-up emails after a call.
--
--   followups  one row per follow-up email drafted for a business after Salekh telephoned it and it was
--              interested, asked to be called back, or booked a meeting. It is sent, if at all, from the
--              OWNER's mailbox (not the test mailbox), through the gateway as `followup.send_email`.
--
-- Personal data: the recipient's name and address, the message, and what the call note said (folded into the
-- message). It lives here and in the approval and audit rows the gateway keeps, and nowhere else: never in an
-- event's summary or payload, never in /v1/house. Read back only by GET /v1/rooms/:roomId/followups.
--
-- The recipient is given by Salekh, never guessed: a draft without one has `to_address` null and cannot be
-- proposed or sent (the action's payload needs an address, and the check below holds it in the database too).
--
-- status
--   draft      written; not waiting for anyone (no recipient yet, a check failed, or it was edited)
--   waiting    put to the gateway at rung 2: waiting for his yes
--   approved   his yes is recorded; not sent yet (no owner mailbox is connected, or the gateway held it back)
--   sending    claimed by the mail connector: from here on it is never sent again, whatever happens
--   sent       accepted by the mail server, with its Message-ID
--   failed     the send failed after the server was reached. Not retried: it may have gone
--   not_sent   he said do not send it, it was replaced by a newer draft, or it can no longer be sent
--
-- Agent tools: nothing. The gateway's role drafts, edits, sends and records. The UI's role reads.

create table followups (
  followup_id     uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (tenant_id),
  business_id     uuid not null,
  prospect_id     uuid not null,
  -- The call that led to it, when there was one (a draft asked for on demand has none).
  call_outcome_id uuid,
  outcome         text check (outcome is null or outcome in ('call_back', 'interested', 'meeting_booked')),
  to_name         text check (to_name is null or length(to_name) between 1 and 120),
  to_address      text check (to_address is null or length(to_address) between 3 and 254),
  subject         text not null check (length(subject) between 1 and 200),
  body            text not null check (length(body) between 1 and 4000),
  -- What the code checks found wrong, in fixed words. Empty: it passes. A draft with problems is never proposed.
  problems        jsonb not null default '[]'::jsonb,
  status          text not null default 'draft'
                    check (status in ('draft', 'waiting', 'approved', 'sending', 'sent', 'failed', 'not_sent')),
  not_sent_reason text,
  approval_id     uuid,
  -- The mailbox it went from, and the Message-ID it went with.
  from_address    text,
  message_id      text,
  failure         text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  decided_at      timestamptz,
  sent_at         timestamptz,
  -- When he copied it to send it himself. A note, not a send.
  copied_at       timestamptz,
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, prospect_id) references prospects (tenant_id, prospect_id),
  foreign key (tenant_id, approval_id) references approvals (tenant_id, approval_id),
  unique (tenant_id, followup_id),
  check ((status = 'sent') = (message_id is not null and sent_at is not null)),
  -- Nothing can wait for a yes, be approved or go without an address.
  check (status not in ('waiting', 'approved', 'sending', 'sent') or to_address is not null)
);

-- At most one follow-up per business that is still open (not sent, failed or set aside).
create unique index followups_one_open_idx on followups (tenant_id, prospect_id)
  where status in ('draft', 'waiting', 'approved', 'sending');
create index followups_business_idx on followups (tenant_id, business_id, created_at);
create index followups_sent_idx on followups (tenant_id, prospect_id, sent_at) where sent_at is not null;

alter table followups enable row level security;
alter table followups force row level security;
revoke all on table followups from public;
create policy tenant_isolation on followups as restrictive for all to public
  using (tenant_id = (select wh_tenant())) with check (tenant_id = (select wh_tenant()));
create policy role_access on followups as permissive for all to wh_agent, wh_gateway, wh_ui using (true) with check (true);

-- No delete for anyone.
grant select, insert on followups to wh_gateway;
grant update (to_name, to_address, subject, body, problems, status, not_sent_reason, approval_id, from_address, message_id,
              failure, updated_at, decided_at, sent_at, copied_at)
  on followups to wh_gateway;
grant select on followups to wh_ui;

-- Not yet covered by the 90 day purge of prospects, like call notes: a business with a follow-up has been called,
-- so it is on the call list. A retention rule is still to be decided.
