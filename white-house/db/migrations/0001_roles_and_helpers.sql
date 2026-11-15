-- 0001: database roles and the tenant helper.
--
-- Three group roles, none of which can log in. A deployment creates its own
-- login roles (with passwords held in the host secret store, never here) and
-- makes each a member of exactly one of these.
--
--   wh_agent    what agent tools connect as. Reads metrics and approved
--               knowledge, inserts proposals and queue items. Nothing else.
--   wh_gateway  the runner's control layer. The only role that writes actions.
--   wh_ui       the private UI's server side. The only role that can resume a
--               kill switch, raise a rung or cap, or edit targets.
--
-- Roles are cluster wide, so creation is guarded.

do $$
begin
  if not exists (select from pg_roles where rolname = 'wh_agent') then
    create role wh_agent nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'wh_gateway') then
    create role wh_gateway nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'wh_ui') then
    create role wh_ui nologin;
  end if;
end
$$;

-- Nothing is granted by default. Every privilege below is named.
revoke all on schema public from public;
grant usage on schema public to wh_agent, wh_gateway, wh_ui;

-- The tenant a connection is acting for. Set per transaction with
--   select set_config('app.tenant_id', '<uuid>', true);
-- Unset or empty gives NULL, which matches no row: row level security fails
-- closed. A value that is not a uuid raises an error, which also fails closed.
create function wh_tenant() returns uuid
  language sql
  stable
  set search_path = ''
as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

revoke all on function wh_tenant() from public;
grant execute on function wh_tenant() to wh_agent, wh_gateway, wh_ui;
