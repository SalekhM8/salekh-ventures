-- 0002: tenants, businesses (the floor registry) and members.
--
-- Convention used in every migration (BRIEF.md section 9):
--   * every table carries tenant_id and business_id;
--   * business_id is NULL when the row belongs to the whole tenant or the
--     whole house (a member, a device, the global kill switch, a Chief of
--     Staff run) rather than to one floor;
--   * on `tenants` the tenant_id is the primary key and business_id is always
--     NULL; on `businesses` the business_id is the primary key;
--   * a row's business must belong to the row's tenant, enforced by a
--     composite foreign key onto businesses (tenant_id, business_id).

create table tenants (
  tenant_id   uuid primary key default gen_random_uuid(),
  business_id uuid check (business_id is null),
  name        text not null,
  timezone    text not null default 'Europe/London',
  status      text not null default 'active' check (status in ('active', 'suspended', 'leaving')),
  created_at  timestamptz not null default now()
);

create table businesses (
  business_id uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (tenant_id),
  slug        text not null check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name        text not null,
  -- Department types this floor runs, by slug, for example {data,ads}.
  departments text[] not null default '{}',
  -- Connector names only. A credential never goes in the database.
  connectors  text[] not null default '{}',
  status      text not null default 'active' check (status in ('active', 'paused', 'archived')),
  created_at  timestamptz not null default now(),
  unique (tenant_id, slug),
  unique (tenant_id, business_id)
);

create table members (
  member_id          uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (tenant_id),
  -- NULL: the member belongs to the whole tenant.
  business_id        uuid,
  -- The id the login provider gives this person. Filled in phase 3.
  auth_subject       text,
  display_name       text not null,
  email              text,
  role               text not null default 'viewer' check (role in ('owner', 'approver', 'viewer')),
  may_approve        boolean not null default false,
  notification_prefs jsonb not null default '{}'::jsonb,
  quiet_hours        jsonb,
  status             text not null default 'active' check (status in ('active', 'disabled')),
  created_at         timestamptz not null default now(),
  unique (tenant_id, member_id),
  unique (tenant_id, auth_subject),
  foreign key (tenant_id, business_id) references businesses (tenant_id, business_id)
);

create index members_tenant_idx on members (tenant_id);
