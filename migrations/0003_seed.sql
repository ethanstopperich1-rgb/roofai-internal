-- =====================================================================
-- 0003_seed.sql
--
-- Bootstrap rows that the application code assumes exist. Specifically
-- the "voxaris" office — /api/leads writes a lead to a default office
-- when no white-label embed targeted a specific tenant, and without
-- this row the very first lead in a fresh project would FK-fail.
--
-- ON CONFLICT keeps this safe to re-run against an already-seeded
-- project. The real onboarding of the 18 RSS offices happens through
-- /dashboard/admin, not this file.
-- =====================================================================

insert into public.offices (slug, name, state, is_active)
values ('voxaris', 'Voxaris (default)', 'FL', true)
on conflict (slug) do nothing;
