-- 0012_drop_proposals_public_id_policy.sql
--
-- proposals_select_by_public_id had qual = true and role = public —
-- meaning any authenticated user can SELECT every proposal in the DB,
-- defeating both `proposals_select_office` (role-aware) and the
-- multi-tenant office isolation.
--
-- The policy existed to let anonymous customers open /p/[id] share
-- links, but `app/api/proposals/[publicId]/route.ts` uses the service-
-- role client which bypasses RLS entirely. So the policy is redundant
-- AND leaky.
--
-- Drop it. The anonymous share-link path keeps working because it goes
-- through service-role, and the authenticated dashboard reads now
-- correctly enforce role + office boundaries.

drop policy if exists proposals_select_by_public_id on public.proposals;
