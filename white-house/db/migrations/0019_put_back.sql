-- 0019: "put them back". The owner can undo his own "not interested" from the call list.
--
-- Suppressions stay permanent (0007's trigger is untouched): nothing here changes or deletes one. Instead the owner
-- adds a record that he put a business back, naming the suppressions it lifts. A suppression is LIFTED, read as not
-- there, only while all of these hold:
--   * it came from his own call outcome (source 'manual', the call list's fixed reason), never from the business
--     itself: an opt-out, a complaint, or anything added by hand for another reason;
--   * the put-back is newer than the latest "not interested" recorded for that business (or any record of the same
--     business), so saying "not interested" again suppresses it again;
--   * the business has never asked not to be contacted, complained, or bounced, by any record that shares its
--     website, company number, or name and postcode. Checked when it is read, so a later opt-out wins at once (an
--     opt-out written over an existing suppression adds no row of its own, but it does mark the test result).
--
--   owner_put_backs  one row each time he puts a business back, with the suppressions it lifts. Append only.
--
-- Agent tools: nothing. The gateway's role records and reads them; the UI's role reads.

create table owner_put_backs (
  put_back_id  uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (tenant_id),
  business_id  uuid not null,
  prospect_id  uuid not null,
  reason       text not null check (length(reason) between 1 and 300),
  -- The suppressions this put-back lifts (ids in `suppressions`; no foreign key, as suppressions are never removed).
  lifted       uuid[] not null default '{}',
  created_at   timestamptz not null default now(),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, prospect_id) references prospects (tenant_id, prospect_id)
);
create index owner_put_backs_prospect_idx on owner_put_backs (tenant_id, prospect_id, created_at);
create index owner_put_backs_lifted_idx on owner_put_backs using gin (lifted);

alter table owner_put_backs enable row level security;
alter table owner_put_backs force row level security;
revoke all on table owner_put_backs from public;
create policy tenant_isolation on owner_put_backs as restrictive for all to public
  using (tenant_id = (select wh_tenant())) with check (tenant_id = (select wh_tenant()));
create policy role_access on owner_put_backs as permissive for all to wh_agent, wh_gateway, wh_ui using (true) with check (true);
-- No update and no delete for anyone: the history is kept.
grant select, insert on owner_put_backs to wh_gateway;
grant select on owner_put_backs to wh_ui;

-- Has this business, or any record of the same business (same website, company number, or name and postcode),
-- asked not to be contacted, complained, or bounced? Then nothing the owner does can put it back.
create function wh_business_asked_off(p_prospect uuid) returns boolean
  language sql stable
  set search_path = ''
as $$
  select exists (
    select 1 from public.prospects p
      join public.prospects q on q.tenant_id = p.tenant_id
       and (q.prospect_id = p.prospect_id
            or (p.domain_key is not null and q.domain_key = p.domain_key)
            or (p.companies_house_number is not null and q.companies_house_number = p.companies_house_number)
            or (p.name_postcode_hash is not null and q.name_postcode_hash = p.name_postcode_hash))
     where p.prospect_id = p_prospect
       and (q.stage = 'opted_out'
            or coalesce(q.test_result ->> 'opted_out', '') = 'true'
            or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(q.test_result -> 'replies') = 'array' then q.test_result -> 'replies' else '[]'::jsonb end) r
                        where r ->> 'kind' = 'bounce' or r ? 'complaint_sentence' or coalesce(r ->> 'opt_out', '') = 'true'))
  )
$$;

-- When "not interested" was last recorded for this business or any record of the same business.
create function wh_last_not_interested(p_prospect uuid) returns timestamptz
  language sql stable
  set search_path = ''
as $$
  select max(c.created_at) from public.prospects p
    join public.prospects q on q.tenant_id = p.tenant_id
     and (q.prospect_id = p.prospect_id
          or (p.domain_key is not null and q.domain_key = p.domain_key)
          or (p.companies_house_number is not null and q.companies_house_number = p.companies_house_number)
          or (p.name_postcode_hash is not null and q.name_postcode_hash = p.name_postcode_hash))
    join public.call_outcomes c on c.prospect_id = q.prospect_id and c.outcome = 'not_interested'
   where p.prospect_id = p_prospect
$$;

-- Is this suppression lifted by the owner putting the business back? See the rules at the top.
create function wh_suppression_lifted(p_suppression uuid) returns boolean
  language sql stable
  set search_path = ''
as $$
  select exists (
    select 1 from public.owner_put_backs b
      join public.suppressions s on s.suppression_id = p_suppression
     where p_suppression = any (b.lifted)
       and s.source = 'manual' and s.reason = 'said not interested when telephoned from the call list'
       and b.created_at > coalesce(public.wh_last_not_interested(b.prospect_id), '-infinity'::timestamptz)
       and not public.wh_business_asked_off(b.prospect_id)
  )
$$;

revoke all on function wh_business_asked_off(uuid), wh_last_not_interested(uuid), wh_suppression_lifted(uuid) from public;
grant execute on function wh_business_asked_off(uuid), wh_last_not_interested(uuid), wh_suppression_lifted(uuid) to wh_gateway, wh_ui;
