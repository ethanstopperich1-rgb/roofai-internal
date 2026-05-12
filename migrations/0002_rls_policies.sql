-- =====================================================================
-- 0002_rls_policies.sql
--
-- Row-level security. Every tenant table is locked down to the calling
-- user's office_id. Service-role key bypasses RLS entirely (Supabase
-- default) — that's what /api/leads, /api/agent/events, and Twilio
-- webhooks use because they have no authenticated user.
--
-- Two helpers do the heavy lifting:
--   current_office_id()   returns the office_id of the auth.uid() user
--   is_admin()            returns true when that user's role = 'admin'
--
-- Both are marked SECURITY DEFINER + STABLE so they're inlinable inside
-- policy expressions without a per-row roundtrip to public.users.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------

create or replace function public.current_office_id()
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select office_id from public.users where id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce(
    (select role = 'admin' from public.users where id = auth.uid()),
    false
  )
$$;

-- The functions need to be callable by every authenticated role so
-- policy expressions can use them. They reveal only the caller's own
-- office_id / admin status — no broader leakage.
grant execute on function public.current_office_id() to authenticated, anon, service_role;
grant execute on function public.is_admin()          to authenticated, anon, service_role;

-- ---------------------------------------------------------------------
-- Enable RLS
-- ---------------------------------------------------------------------
alter table public.offices  enable row level security;
alter table public.users    enable row level security;
alter table public.leads    enable row level security;
alter table public.proposals enable row level security;
alter table public.calls    enable row level security;
alter table public.events   enable row level security;
alter table public.consents enable row level security;

-- ---------------------------------------------------------------------
-- offices
--
-- Every staff user sees only their own office row. Admins see all so
-- the /dashboard/admin onboarding console can list and edit any office.
-- INSERT / UPDATE / DELETE are admin-only — non-admin staff have no
-- reason to touch offices, and limiting it now prevents footguns
-- later when permissions branch out.
-- ---------------------------------------------------------------------
drop policy if exists offices_select_self on public.offices;
create policy offices_select_self on public.offices
  for select to authenticated
  using (id = public.current_office_id() or public.is_admin());

drop policy if exists offices_admin_all on public.offices;
create policy offices_admin_all on public.offices
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------
-- users
--
-- Staff see other staff in the same office (for the team roster).
-- Admins see everyone. Insert + update are admin-only — staff cannot
-- promote themselves or invite outside their office without going
-- through the admin onboarding flow (which uses the service role).
-- ---------------------------------------------------------------------
drop policy if exists users_select_same_office on public.users;
create policy users_select_same_office on public.users
  for select to authenticated
  using (office_id = public.current_office_id() or public.is_admin());

drop policy if exists users_admin_all on public.users;
create policy users_admin_all on public.users
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- A staff user must be able to read THEIR OWN row even before the
-- helper function resolves an office_id (chicken-and-egg on first sign
-- in). This narrow policy handles that bootstrap.
drop policy if exists users_select_self on public.users;
create policy users_select_self on public.users
  for select to authenticated
  using (id = auth.uid());

-- ---------------------------------------------------------------------
-- leads
--
-- The core tenant-scoped table. Staff in office X can SELECT / INSERT
-- / UPDATE any lead in office X. DELETE is admin-only — leads carry
-- TCPA receipts and call history; an accidental delete by a junior
-- staffer is recoverable but ugly.
-- ---------------------------------------------------------------------
drop policy if exists leads_select_office on public.leads;
create policy leads_select_office on public.leads
  for select to authenticated
  using (office_id = public.current_office_id() or public.is_admin());

drop policy if exists leads_insert_office on public.leads;
create policy leads_insert_office on public.leads
  for insert to authenticated
  with check (office_id = public.current_office_id() or public.is_admin());

drop policy if exists leads_update_office on public.leads;
create policy leads_update_office on public.leads
  for update to authenticated
  using (office_id = public.current_office_id() or public.is_admin())
  with check (office_id = public.current_office_id() or public.is_admin());

drop policy if exists leads_delete_admin on public.leads;
create policy leads_delete_admin on public.leads
  for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------
-- proposals
-- Same pattern as leads. DELETE admin-only.
-- ---------------------------------------------------------------------
drop policy if exists proposals_select_office on public.proposals;
create policy proposals_select_office on public.proposals
  for select to authenticated
  using (office_id = public.current_office_id() or public.is_admin());

drop policy if exists proposals_insert_office on public.proposals;
create policy proposals_insert_office on public.proposals
  for insert to authenticated
  with check (office_id = public.current_office_id() or public.is_admin());

drop policy if exists proposals_update_office on public.proposals;
create policy proposals_update_office on public.proposals
  for update to authenticated
  using (office_id = public.current_office_id() or public.is_admin())
  with check (office_id = public.current_office_id() or public.is_admin());

drop policy if exists proposals_delete_admin on public.proposals;
create policy proposals_delete_admin on public.proposals
  for delete to authenticated
  using (public.is_admin());

-- Customer share link (/p/[id]) reads proposals by public_id WITHOUT
-- an authenticated session. The anonymous read happens through a
-- server-side route that uses the service-role client, which bypasses
-- RLS, so no anon-readable policy is added here. (The route applies
-- its own public_id-only filter — the proposal row never reaches the
-- browser unless that filter matches.)

-- ---------------------------------------------------------------------
-- calls
--
-- Reads scoped to office. Writes go through the service role (Sydney
-- event sink at /api/agent/*), which bypasses RLS. The admin-update
-- policy is here for future "mark as junk" / "set outcome" actions
-- from the dashboard.
-- ---------------------------------------------------------------------
drop policy if exists calls_select_office on public.calls;
create policy calls_select_office on public.calls
  for select to authenticated
  using (office_id = public.current_office_id() or public.is_admin());

drop policy if exists calls_update_office on public.calls;
create policy calls_update_office on public.calls
  for update to authenticated
  using (office_id = public.current_office_id() or public.is_admin())
  with check (office_id = public.current_office_id() or public.is_admin());

drop policy if exists calls_delete_admin on public.calls;
create policy calls_delete_admin on public.calls
  for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------
-- events
--
-- Read-only for staff (debugging / audit). Writes go through the
-- service role from the Sydney agent's event sink.
-- ---------------------------------------------------------------------
drop policy if exists events_select_office on public.events;
create policy events_select_office on public.events
  for select to authenticated
  using (office_id = public.current_office_id() or public.is_admin());

drop policy if exists events_delete_admin on public.events;
create policy events_delete_admin on public.events
  for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------
-- consents
--
-- Append-only TCPA + call-recording receipts. Critical for
-- defensibility if a TCPA suit lands. Staff read only — no UPDATE /
-- DELETE policies are declared, so RLS denies those operations by
-- default. INSERT happens through the service role at /api/leads and
-- /api/agent/consent.
-- ---------------------------------------------------------------------
drop policy if exists consents_select_office on public.consents;
create policy consents_select_office on public.consents
  for select to authenticated
  using (office_id = public.current_office_id() or public.is_admin());

-- DEFENSIVE: explicitly forbid UPDATE / DELETE even by admins. A TCPA
-- receipt must be permanent. If a record was created in error, mark
-- it via a side-table or a `voided_at` column added in a future
-- migration — never mutate the original row.
drop policy if exists consents_no_update on public.consents;
create policy consents_no_update on public.consents
  for update to authenticated
  using (false);

drop policy if exists consents_no_delete on public.consents;
create policy consents_no_delete on public.consents
  for delete to authenticated
  using (false);
