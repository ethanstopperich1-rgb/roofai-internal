-- =====================================================================
-- 0004_auto_provision_users.sql
--
-- Auto-provision a public.users row when someone signs in via Supabase
-- Auth for the first time.
--
-- Why this is needed:
--   - Supabase Auth handles login → creates auth.users row
--   - RLS policies on every public.* table reference public.users via
--     current_office_id()
--   - If a user has an auth.users row but NO matching public.users row,
--     RLS returns null and every dashboard query fails silently
--
-- Trigger behavior:
--   - Fires AFTER INSERT on auth.users (the magic-link callback path)
--   - Reads office_slug from raw_user_meta_data when supplied (the
--     admin invite flow at /dashboard/admin sets it). Falls back to the
--     "voxaris" seed office so the user can sign in even without an
--     explicit office assignment.
--   - role defaults to 'rep' (least-privilege; admins promoted by SQL)
--   - Idempotent via ON CONFLICT DO NOTHING — re-running this migration
--     against a project that already has the trigger is safe.
--
-- Applied to production 2026-05-11 as part of Phase 4 (Supabase Auth
-- scaffolding). Captured here so a clean staging spin-up via
-- supabase db reset produces a working sign-in flow.
-- =====================================================================

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  default_office_id uuid;
  signup_office_slug text;
  resolved_office_id uuid;
begin
  signup_office_slug := new.raw_user_meta_data->>'office_slug';

  if signup_office_slug is not null then
    select id into resolved_office_id
    from public.offices
    where slug = signup_office_slug and is_active = true
    limit 1;
  end if;

  select id into default_office_id
  from public.offices
  where slug = 'voxaris' and is_active = true
  limit 1;

  insert into public.users (id, office_id, email, role)
  values (
    new.id,
    coalesce(resolved_office_id, default_office_id),
    new.email,
    'rep'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
