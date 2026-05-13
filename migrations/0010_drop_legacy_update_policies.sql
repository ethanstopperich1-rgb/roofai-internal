-- 0010_drop_legacy_update_policies.sql
--
-- Mirror of 0009 (which dropped legacy office-wide SELECT policies) for
-- the UPDATE policies. The legacy `*_update` policies grant office-wide
-- write to any authenticated user — and Postgres RLS combines multiple
-- UPDATE policies via OR, so a rep could update any lead/call/proposal
-- in their office through the legacy policy, defeating the rep-scoped
-- *_update_office policies added in 0008.
--
-- After this migration the only UPDATE paths are:
--   leads:     leads_update_office (rep-restricted via assigned_to)
--   calls:     leads-policy-transitive — service-role writes only
--              (Sydney's /api/agent/events bypasses RLS), no authenticated
--              update needed for now
--   proposals: same as calls — written by /api/proposals via service-role
--
-- If a future feature needs authenticated calls/proposals UPDATE, add a
-- role-aware policy mirroring leads_update_office.

drop policy if exists leads_update on public.leads;
drop policy if exists calls_update on public.calls;
drop policy if exists proposals_update on public.proposals;
