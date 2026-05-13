-- 0008_rep_rls_scope.sql
--
-- Tightens RLS so users with role='rep' see only the leads (and the
-- calls / proposals descending from them) that are assigned to them.
-- Managers and admins/owners keep the existing office-wide visibility.
--
-- This depends on 0007 having shipped:
--   - users.role now includes 'rep'
--   - leads.assigned_to references public.users.id
--   - public.current_user_id() helper exists
--
-- Behavior summary by role:
--   admin/owner  → see everything across every office (is_admin() short-circuit)
--   manager/staff → see everything in their office (office_id match)
--   rep          → see leads where assigned_to = auth.uid()
--                  + calls/proposals linked to those leads
--                  + still office-scoped (defense in depth)

-- ─── leads ─────────────────────────────────────────────────────────────

drop policy if exists leads_select_office on public.leads;
create policy leads_select_office on public.leads
  for select to authenticated
  using (
    -- admin/owner short-circuit
    public.is_admin()
    -- manager/staff: same-office, all rows
    or (
      office_id = public.current_office_id()
      and public.current_user_role() in ('manager', 'staff', 'admin', 'owner', 'viewer')
    )
    -- rep: same-office AND assigned to me
    or (
      office_id = public.current_office_id()
      and public.current_user_role() = 'rep'
      and assigned_to = public.current_user_id()
    )
  );

-- Reps can update only their own assigned leads.
drop policy if exists leads_update_office on public.leads;
create policy leads_update_office on public.leads
  for update to authenticated
  using (
    public.is_admin()
    or (
      office_id = public.current_office_id()
      and public.current_user_role() in ('manager', 'staff', 'viewer')
    )
    or (
      office_id = public.current_office_id()
      and public.current_user_role() = 'rep'
      and assigned_to = public.current_user_id()
    )
  )
  with check (
    public.is_admin()
    or (
      office_id = public.current_office_id()
      and public.current_user_role() in ('manager', 'staff', 'viewer')
    )
    or (
      office_id = public.current_office_id()
      and public.current_user_role() = 'rep'
      and assigned_to = public.current_user_id()
    )
  );

-- ─── calls ─────────────────────────────────────────────────────────────
-- Calls scope through the linked lead. A call without a lead_id (Sydney
-- caller never resolved to a lead) is visible only to manager+.

drop policy if exists calls_select_office on public.calls;
create policy calls_select_office on public.calls
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
        where l.id = calls.lead_id
          and l.assigned_to = public.current_user_id()
      )
    )
  );

-- ─── proposals ─────────────────────────────────────────────────────────

drop policy if exists proposals_select_office on public.proposals;
create policy proposals_select_office on public.proposals
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
        where l.id = proposals.lead_id
          and l.assigned_to = public.current_user_id()
      )
    )
  );

-- Note: anonymous reads of /p/[id] still work because the public API
-- route uses the service-role client which bypasses RLS entirely. This
-- migration only affects authenticated reads.
