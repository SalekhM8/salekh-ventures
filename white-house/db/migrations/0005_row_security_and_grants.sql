-- 0005: row level security on every table, then the privileges of each role.
--
-- Row level security, the same two policies on every table:
--   tenant_isolation  restrictive, for everyone: a row is visible and
--                     writable only when its tenant_id is the tenant the
--                     transaction was opened for (wh_tenant()).
--   role_access       permissive, for the three White House roles only.
-- Any other role, including the owner of the tables (row security is
-- forced), has no permissive policy and therefore sees nothing. Superusers
-- and roles with BYPASSRLS are outside row security, as always in Postgres:
-- the runner, the agent tools and the UI must never connect as one.
--
-- What a role may do to a table is then set with ordinary grants, by column
-- where it matters. Nobody is granted DELETE or TRUNCATE on anything.

do $$
declare
  t text;
begin
  foreach t in array array[
    'tenants', 'businesses', 'members', 'config_versions', 'runs', 'events',
    'proposals', 'approvals', 'actions', 'budget_ledger', 'metrics',
    'memory_notes', 'scores', 'eval_cases', 'eval_runs', 'queue_items',
    'notifications', 'devices', 'public_feed'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('revoke all on table %I from public', t);
    execute format(
      'create policy tenant_isolation on %I as restrictive for all to public '
      'using (tenant_id = (select wh_tenant())) '
      'with check (tenant_id = (select wh_tenant()))', t);
    execute format(
      'create policy role_access on %I as permissive for all '
      'to wh_agent, wh_gateway, wh_ui using (true) with check (true)', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Extra row rules
-- ---------------------------------------------------------------------------

-- Agent tools see approved memory only.
create policy agent_reads_approved_only on memory_notes as restrictive for select to wh_agent
  using (status = 'approved');

-- The gateway may add exactly two kinds of config row, both of which only
-- ever make the system more cautious:
--   * engaging a kill switch (so /stop on Telegram works without the UI);
--   * lowering a rung (automatic demotion).
-- Resuming, raising a rung, caps, budgets, targets and schedules need wh_ui.
create policy gateway_config_only_tightens on config_versions as restrictive for insert to wh_gateway
  with check (
    (kind = 'kill_switch' and value = '{"engaged": true}'::jsonb)
    or
    (kind = 'rung'
     and changed_by_kind = 'system'
     and business_id is not null
     and (value ->> 'rung')::integer < wh_current_rung(tenant_id, business_id, key))
  );

-- ---------------------------------------------------------------------------
-- wh_agent: read metrics and approved knowledge, insert proposals.
-- ---------------------------------------------------------------------------
grant select on metrics, memory_notes to wh_agent;
-- By column, so an agent tool cannot fill in the gateway's decision.
grant insert (proposal_id, tenant_id, business_id, department, run_id, action_type, action_key, payload, reason)
  on proposals to wh_agent;
grant insert (item_id, tenant_id, business_id, kind, from_department, to_department, title, body, source_run)
  on queue_items to wh_agent;

-- ---------------------------------------------------------------------------
-- wh_gateway: the control layer inside the runner.
-- ---------------------------------------------------------------------------
grant select on all tables in schema public to wh_gateway;
grant insert on config_versions, runs, events, proposals, approvals, actions, budget_ledger,
                metrics, queue_items, notifications, public_feed, eval_runs
  to wh_gateway;
grant update on runs, budget_ledger to wh_gateway;
grant update (decision, refusal_reason, config_rung, effective_rung, key_claimed, decided_at)
  on proposals to wh_gateway;
-- Not payload, not payload_hash: a stored approval cannot be rewritten.
grant update (status, decided_by, decided_at, channel, approved_payload_hash, consumed_at, void_reason)
  on approvals to wh_gateway;
grant update (output, outside_reference, status, verified, verified_at, verification, error, executed_at,
              marked_wrong_at, marked_wrong_by, marked_wrong_note)
  on actions to wh_gateway;
-- Only to clear a payload at the end of its 90 day life.
grant update (payload, payload_expires_at) on events to wh_gateway;
grant update (status, closed_at, closed_by) on queue_items to wh_gateway;
grant update (sent_at) on notifications to wh_gateway;
grant update (ended_at, total, passed, failed, results) on eval_runs to wh_gateway;

-- ---------------------------------------------------------------------------
-- wh_ui: the private UI's server side.
-- ---------------------------------------------------------------------------
grant select on all tables in schema public to wh_ui;
grant insert on config_versions, events, businesses, members, scores, memory_notes, eval_cases,
                devices, queue_items, notifications
  to wh_ui;
grant update (name, departments, connectors, status) on businesses to wh_ui;
grant update (business_id, auth_subject, display_name, email, role, may_approve, notification_prefs,
              quiet_hours, status)
  on members to wh_ui;
-- The UI records an answer. It cannot mark an approval used: only the
-- gateway executes.
grant update (status, decided_by, decided_at, channel, approved_payload_hash, void_reason)
  on approvals to wh_ui;
grant update (status, approved_by, approved_at) on memory_notes to wh_ui;
grant update (status, closed_at, closed_by) on queue_items to wh_ui;
grant update (read_at) on notifications to wh_ui;
grant update (label, last_seen_at, revoked_at) on devices to wh_ui;
grant update (status) on eval_cases to wh_ui;
