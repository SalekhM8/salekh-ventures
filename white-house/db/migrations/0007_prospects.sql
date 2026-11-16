-- 0007: the prospecting pipeline's master list.
--
--   prospects        one row per business found, never duplicated.
--   prospect_events  every stage a prospect passes through, with the reason.
--   suppressions     who must never be contacted. Permanent: nothing can
--                    change or delete a row, whatever role it connects as.
--   fetched_pages    a one day cache of public pages fetched by plain code.
--   prospect_competitors  which businesses are a prospect's local competitors.
--   search_coverage  which towns have been searched, so runs move round the country.
--
-- Also: a "setting" kind of config (changed by the UI role only, like every
-- kind but the two the gateway may tighten), a "stage" event type, and a
-- structured `data` column on outputs.
--
-- Personal data. The name of an owner or manager and the routes to reach
-- them live in `prospects` and nowhere else in the database apart from the
-- finished shortlist a person reads. They are never written to `events`.
-- Agent tools have no access to these three tables at all: the tools that
-- record prospects are code in the runner, using the gateway's role.

create table prospects (
  prospect_id             uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants (tenant_id),
  -- The floor doing the prospecting.
  business_id             uuid not null,
  name                    text not null,
  area                    text,
  -- The town or city the search that found it was run for. Set by code. Local competitors share it.
  search_area             text,
  postcode                text,
  website                 text,

  -- Deduplication keys, worked out in code (never taken from the model as given).
  -- domain_key: the site's host, lower case, without www.
  -- name_postcode_hash: sha256 of the normalised name and postcode. Kept after a purge.
  -- name_key and postcode_key: the normalised parts, for near matches. Cleared by a purge.
  domain_key              text,
  companies_house_number  text,
  name_key                text,
  postcode_key            text,
  name_postcode_hash      text,

  stage                   text not null default 'found' check (stage in (
                            'found', 'analysed', 'filtered_out', 'shortlisted',
                            -- later stages, not built yet:
                            'tested', 'messaged', 'replied', 'call_booked', 'paid', 'opted_out')),
  -- [{signal, evidence, source_url, source_opened}]
  signals                 jsonb not null default '[]'::jsonb,
  -- The structured analysis. Every fact carries its source address or says "not found".
  analysis                jsonb,
  analysis_attempts       integer not null default 0,

  -- PERSONAL DATA: these three columns.
  contact_name            text,
  contact_role            text,
  contact_name_source     text,
  -- [{kind, value, source_url}]. A clinic's own published routes, which can still name a person.
  contact_routes          jsonb not null default '[]'::jsonb,

  -- 'yes' and 'no' come from Companies House or from what the business publishes about itself.
  is_limited_company      text not null default 'not_checked'
                            check (is_limited_company in ('yes', 'no', 'not_found', 'not_checked')),
  companies_house         jsonb,

  score                   numeric(6, 2),
  score_breakdown         jsonb,
  filter_reason           text,

  -- Room for the mystery enquiry: time sent, time of first reply, the reply. Not built yet.
  -- A business tested once keeps its result here, whether it is a prospect or someone's competitor.
  test_result             jsonb,

  -- The drafted card: why it made the list, the sample reply, the first message, the call opener.
  card                    jsonb,

  found_run_id            uuid,
  found_at                timestamptz not null default now(),
  analysed_at             timestamptz,
  filtered_out_at         timestamptz,
  shortlisted_at          timestamptz,
  -- Retention: set when a prospect is filtered out. After this, its personal and
  -- descriptive fields are cleared and only the keys that stop it being found again stay.
  purge_after             timestamptz,
  purged_at               timestamptz,

  unique (tenant_id, prospect_id),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, found_run_id) references runs (tenant_id, run_id)
);

-- "Never duplicated" is held by these, whatever the code above them does.
create unique index prospects_domain_idx on prospects (tenant_id, business_id, domain_key) where domain_key is not null;
create unique index prospects_company_idx on prospects (tenant_id, business_id, companies_house_number) where companies_house_number is not null;
create unique index prospects_name_postcode_idx on prospects (tenant_id, business_id, name_postcode_hash) where name_postcode_hash is not null;
create index prospects_stage_idx on prospects (tenant_id, business_id, stage, found_at);
create index prospects_postcode_idx on prospects (tenant_id, business_id, postcode_key) where postcode_key is not null;
create index prospects_purge_idx on prospects (purge_after) where purged_at is null and purge_after is not null;

create table prospect_events (
  prospect_event_id uuid primary key default gen_random_uuid(),
  seq               bigint generated always as identity unique,
  tenant_id         uuid not null references tenants (tenant_id),
  business_id       uuid not null,
  prospect_id       uuid not null,
  stage             text not null check (stage in (
                      'found', 'analysed', 'filtered_out', 'shortlisted',
                      'tested', 'messaged', 'replied', 'call_booked', 'paid', 'opted_out')),
  -- A fixed code: the signal, the filter rule that failed, and so on. Never free text.
  reason            text not null check (reason ~ '^[a-z0-9_]+$'),
  run_id            uuid,
  created_at        timestamptz not null default now(),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, prospect_id) references prospects (tenant_id, prospect_id)
);

create index prospect_events_range_idx on prospect_events (tenant_id, business_id, created_at);
create index prospect_events_prospect_idx on prospect_events (tenant_id, prospect_id, seq);

create table suppressions (
  suppression_id uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (tenant_id),
  -- NULL: applies on every floor of the tenant.
  business_id    uuid,
  kind           text not null check (kind in ('domain', 'company_number', 'email', 'phone', 'name_postcode')),
  -- Normalised by code: a lower case host, a company number, a lower case address, digits, or a hash.
  value_key      text not null check (length(value_key) between 1 and 300),
  reason         text not null check (length(reason) > 0),
  source         text not null default 'manual' check (source in ('manual', 'opt_out', 'complaint')),
  added_by       uuid,
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, added_by) references members (tenant_id, member_id),
  unique (tenant_id, kind, value_key)
);

-- Permanent. Not even the owner of the table or a superuser session can change
-- or remove a suppression short of dropping the trigger on purpose.
create function wh_suppressions_are_permanent() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  raise exception 'suppressions are permanent: a row cannot be changed or deleted';
end
$$;

create trigger suppressions_no_change before update or delete on suppressions
  for each row execute function wh_suppressions_are_permanent();
create trigger suppressions_no_truncate before truncate on suppressions
  for each statement execute function wh_suppressions_are_permanent();

-- Which businesses are the local competitors of which prospect. A competitor is
-- itself a row in `prospects`, found the same way. Keeping the link means a
-- competitor that is tested once can be the comparison for several prospects
-- and is never contacted a second time.
create table prospect_competitors (
  link_id         uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (tenant_id),
  business_id     uuid not null,
  prospect_id     uuid not null,
  competitor_id   uuid not null,
  -- What was public and checkable when the card was made: reviews, routes, a front desk advert, opening hours.
  comparison      jsonb not null,
  -- Later: the prospect's reply time against this competitor's. Not built yet.
  test_comparison jsonb,
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  foreign key (tenant_id, prospect_id) references prospects (tenant_id, prospect_id),
  foreign key (tenant_id, competitor_id) references prospects (tenant_id, prospect_id),
  unique (tenant_id, prospect_id, competitor_id),
  check (prospect_id <> competitor_id)
);

create index prospect_competitors_competitor_idx on prospect_competitors (tenant_id, competitor_id);

-- Which towns and cities have been searched, and when, so that runs move
-- round the country instead of searching the same place every day.
create table search_coverage (
  coverage_id      uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants (tenant_id),
  business_id      uuid not null,
  area             text not null check (length(area) between 1 and 100),
  last_searched_at timestamptz not null,
  times_searched   integer not null default 1,
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  unique (tenant_id, business_id, area)
);

-- What plain code fetched from the public web today, so nothing is fetched
-- twice in a day. A cache, not a record: rows older than a day are deleted,
-- which makes this the one table a role may delete from. The text is whatever
-- the public page said, so it is kept no longer than that.
create table fetched_pages (
  page_id     uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (tenant_id),
  business_id uuid not null,
  -- sha256 of the kind of request and its arguments.
  cache_key   text not null check (cache_key ~ '^[0-9a-f]{64}$'),
  day         date not null,
  kind        text not null check (kind in ('search', 'read', 'jobs')),
  -- [{title, url, text}], with the text already cut to the cap.
  items       jsonb not null,
  fetched_at  timestamptz not null default now(),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id),
  unique (tenant_id, business_id, cache_key, day)
);

do $$
declare
  t text;
begin
  foreach t in array array['prospects', 'prospect_events', 'suppressions', 'fetched_pages', 'prospect_competitors', 'search_coverage']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('revoke all on table %I from public', t);
    execute format(
      'create policy tenant_isolation on %I as restrictive for all to public '
      'using (tenant_id = (select wh_tenant())) with check (tenant_id = (select wh_tenant()))', t);
    execute format(
      'create policy role_access on %I as permissive for all to wh_agent, wh_gateway, wh_ui using (true) with check (true)', t);
  end loop;
end
$$;

-- wh_agent: nothing. The gateway's role records prospects. The UI's role reads them.
grant select, insert on prospects, prospect_events, suppressions to wh_gateway;
grant update (name, area, postcode, website, domain_key, companies_house_number, name_key, postcode_key, name_postcode_hash,
              stage, signals, analysis, analysis_attempts, contact_name, contact_role, contact_name_source, contact_routes,
              is_limited_company, companies_house, score, score_breakdown, filter_reason, test_result, search_area,
              card, analysed_at, filtered_out_at, shortlisted_at, purge_after, purged_at)
  on prospects to wh_gateway;
grant select, insert, delete on fetched_pages to wh_gateway;
grant select, insert on prospect_competitors, search_coverage to wh_gateway;
grant update (comparison, test_comparison) on prospect_competitors to wh_gateway;
grant update (last_searched_at, times_searched) on search_coverage to wh_gateway;
grant select on prospect_competitors, search_coverage to wh_ui;
grant select on prospects, prospect_events, suppressions to wh_ui;
grant select on fetched_pages to wh_ui;
grant insert on suppressions to wh_ui;

-- Settings: one more kind of config. The gateway's insert policy on
-- config_versions already allows it only a kill switch or a lower rung, so a
-- setting can be changed by the UI's role alone.
alter table config_versions drop constraint config_versions_kind_check;
alter table config_versions add constraint config_versions_kind_check
  check (kind in ('target', 'cap', 'rung', 'schedule', 'budget', 'kill_switch', 'setting'));

-- The shortlist is stored as Markdown for a person and as data for the UI.
alter table outputs add column data jsonb;
grant insert (data) on outputs to wh_agent;

alter table events drop constraint events_type_check;
alter table events add constraint events_type_check check (type in (
  'started', 'brief', 'tool_call', 'done', 'failed', 'handoff', 'run_refused',
  'output', 'metrics_pulled', 'acknowledged', 'scored', 'stage',
  'proposal', 'refused', 'waiting', 'notified',
  'approved', 'rejected', 'expired', 'voided', 'answer_refused',
  'executing', 'executed', 'execution_failed', 'verified', 'verify_failed',
  'demoted', 'marked_wrong',
  'kill_switch_engaged', 'kill_switch_resumed', 'config_changed'));
