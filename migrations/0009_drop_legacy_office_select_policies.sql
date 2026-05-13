-- 0009_drop_legacy_office_select_policies.sql
--
-- The legacy office-wide SELECT policies (leads_select, calls_select,
-- proposals_staff_select) granted full office visibility to any
-- authenticated user. They were superseded by the role-aware
-- *_select_office policies added in 0008, but Postgres RLS combines
-- multiple SELECT policies with OR — so a rep would still see the
-- whole office via the old policies, defeating the rep restriction.
--
-- Drop them so the new rep-scoped policies actually take effect.
--
-- proposals_select_by_public_id is intentionally kept: it handles the
-- /p/[id] customer share-link surface, scoped by public_id at query
-- time. That's not duplicate visibility.

drop policy if exists leads_select on public.leads;
drop policy if exists calls_select on public.calls;
drop policy if exists proposals_staff_select on public.proposals;
