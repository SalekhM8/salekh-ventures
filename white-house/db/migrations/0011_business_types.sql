-- 0011: more than one kind of business.
--
--   prospects.business_type   which kind of business this is (an id from the outreach settings). Every
--                             business found before now was a clinic.
--   search_coverage.type_id   the rotation is over (kind, place) pairs, so each kind gets its share of
--                             each place.

alter table prospects add column business_type text not null default 'clinics' check (business_type ~ '^[a-z][a-z0-9-]{1,30}$');
create index prospects_type_idx on prospects (tenant_id, business_id, business_type, stage);

alter table search_coverage add column type_id text not null default 'clinics' check (type_id ~ '^[a-z][a-z0-9-]{1,30}$');
alter table search_coverage drop constraint search_coverage_tenant_id_business_id_area_key;
alter table search_coverage add constraint search_coverage_pair_key unique (tenant_id, business_id, type_id, area);
