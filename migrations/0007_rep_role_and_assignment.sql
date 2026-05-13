-- 0007_rep_role_and_assignment.sql
--
-- Extends the role-based access model:
--   1. Adds 'rep' and 'owner' to the public.users.role check constraint.
--      'owner'  = company CEO who oversees multiple offices (was previously
--                 spelled 'admin' — kept for backward compat).
--      'manager' = office head, full visibility within one office.
--      'staff'  = legacy default, equivalent to a rep without explicit
--                 assignment scope.
--      'rep'    = field/inside sales rep; sees only their assigned leads.
--   2. Adds leads.assigned_to / leads.assigned_at so reps can be the
--      "owner" of a row and queries can filter to "my leads".
--   3. Adds an index to make the assigned-to lookup cheap on the rep
--      dashboard's primary query.
--
-- RLS policies in 0002_rls_policies.sql still gate by office_id and
-- admin status. A follow-up policy migration (0008) tightens read
-- access so reps only see leads where assigned_to = auth.uid().
-- That's a separate migration so this one can land first and the app
-- can start writing the assigned_to column even while RLS still uses
-- the office-wide gate.

-- ─── role check ────────────────────────────────────────────────────────
-- Postgres won't let us alter an existing check constraint in place —
-- drop and recreate. Idempotent via if-exists / if-not-exists.

alter table public.users
  drop constraint if exists users_role_check;

alter table public.users
  add constraint users_role_check
  check (role in ('rep', 'staff', 'manager', 'admin', 'owner'));

-- ─── leads.assigned_to ────────────────────────────────────────────────

alter table public.leads
  add column if not exists assigned_to uuid references public.users (id) on delete set null;

alter table public.leads
  add column if not exists assigned_at timestamptz;

create index if not exists leads_assigned_to_idx
  on public.leads (assigned_to)
  where assigned_to is not null;

-- ─── helper: current_user_id() ─────────────────────────────────────────
-- Convenience wrapper that returns auth.uid() but is safe to call from
-- security-definer policy fragments. Mirrors the pattern of
-- public.current_office_id() and public.is_admin() from 0002.

create or replace function public.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid()
$$;

grant execute on function public.current_user_id() to authenticated, anon, service_role;

-- ─── helper: current_user_role() ──────────────────────────────────────

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role from public.users where id = auth.uid()),
    'staff'
  )
$$;

grant execute on function public.current_user_role() to authenticated, anon, service_role;
