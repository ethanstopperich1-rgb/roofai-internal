-- 0011_rep_scope_events_consents.sql
--
-- Closes two RLS leaks that the 0008/0009 pass missed:
--
--   1. `events` table — currently office-wide SELECT (events_select).
--      Sydney's tool_fired / call_started payloads include redacted
--      summaries but still leak which leads belong to other reps.
--      Tighten so reps see only events tied to their assigned leads
--      (transitively via call_id → calls.lead_id → leads.assigned_to).
--
--   2. `consents` table — currently office-wide SELECT (consents_select).
--      TCPA receipts include the customer's email, phone, IP. A rep
--      should NOT see consents for leads belonging to other reps.
--      Same transitive scope as events.
--
-- Both tables keep manager/staff/admin/owner office-wide visibility
-- (the audit/QA path needs it). Only the `rep` role tightens.

-- ─── events ────────────────────────────────────────────────────────────

drop policy if exists events_select on public.events;
drop policy if exists events_select_office on public.events;
create policy events_select_office on public.events
  for select to authenticated
  using (
    public.is_admin()
    or (
      office_id = public.current_office_id()
      and public.current_user_role() in ('manager', 'staff', 'admin', 'owner', 'viewer')
    )
    or (
      office_id = public.current_office_id()
      and public.current_user_role() = 'rep'
      and call_id is not null
      and exists (
        select 1
        from public.calls c
        join public.leads l on l.id = c.lead_id
        where c.id = events.call_id
          and l.assigned_to = public.current_user_id()
      )
    )
  );

-- ─── consents ──────────────────────────────────────────────────────────

drop policy if exists consents_select on public.consents;
drop policy if exists consents_select_office on public.consents;
create policy consents_select_office on public.consents
  for select to authenticated
  using (
    public.is_admin()
    or (
      office_id = public.current_office_id()
      and public.current_user_role() in ('manager', 'staff', 'admin', 'owner', 'viewer')
    )
    or (
      office_id = public.current_office_id()
      and public.current_user_role() = 'rep'
      and lead_id is not null
      and exists (
        select 1 from public.leads l
        where l.id = consents.lead_id
          and l.assigned_to = public.current_user_id()
      )
    )
  );
