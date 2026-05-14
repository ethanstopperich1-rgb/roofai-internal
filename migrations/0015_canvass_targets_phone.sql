-- =====================================================================
-- 0015_canvass_targets_phone.sql
--
-- Skip-traced contact enrichment columns. Populated by
-- scripts/skip_trace.py (called from scripts/enrich_permits.py and
-- scripts/test_oviedo_canvass.py).
--
-- Three free public-records aggregators feed this column set:
--   * truepeoplesearch.com   (primary — best address search UX)
--   * fastpeoplesearch.com   (first fallback)
--   * searchpeoplefree.com   (last-ditch)
--
-- All three publish data from voter rolls, county property records,
-- court records, and other state-published public records under
-- their state Sunshine Law equivalents. Scraping their aggregated
-- presentation is the gray-area part — Noland's elected to use a
-- proprietary scraping path rather than a paid skip-tracing API
-- (Tracerfy / BatchLeads / etc).
--
-- TCPA / DNC compliance is enforced AT CALL TIME, not at enrichment
-- time. Reps are not allowed to dial these numbers without:
--   * National DNC scrub on the number
--   * Florida Mini-TCPA scrub (FL has stricter rules than federal)
--   * TCPA-compliant time-of-day window (8am-9pm local)
--   * Express written consent if dialing via auto-dialer
-- See docs/skip-trace-compliance.md (post-migration follow-up doc).
-- =====================================================================

alter table public.canvass_targets
  -- Best-guess current phone number from skip-trace. NULL when no
  -- match returned, OR when the row hasn't been enriched yet. Use
  -- phone_checked_at to disambiguate the two cases.
  add column if not exists phone_number text,
  -- Which aggregator returned the number. Useful for ops debugging
  -- and for revoking results if one source proves low-quality.
  add column if not exists phone_source text
    check (phone_source is null or phone_source in (
      'truepeoplesearch', 'fastpeoplesearch', 'searchpeoplefree'
    )),
  -- How confident we are the number is actually current + correct
  -- for THIS resident. Heuristic from the source page:
  --   'high'   — name on people-search matches parcels.owner_name AND
  --              address matches situs_address exactly
  --   'medium' — name matches; address is current-or-recent
  --   'low'    — any phone returned by address but no name match
  add column if not exists phone_match_confidence text
    check (phone_match_confidence is null or phone_match_confidence in (
      'high', 'medium', 'low'
    )),
  add column if not exists phone_checked_at timestamptz,
  -- Optional email pulled from the same lookup. Most aggregators
  -- redact emails behind paywalls but some surface them — store
  -- when we get one.
  add column if not exists email text,
  -- Raw markup snippet from the source page (4KB max) for ops
  -- diagnosis when a phone result looks wrong.
  add column if not exists skip_trace_raw text;

-- Index for "rows where we've scored hot AND have a phone" — drives
-- the rep dashboard's "call list" sort.
create index if not exists canvass_targets_callable_hot_idx
  on public.canvass_targets (office_id, score desc)
  where phone_number is not null
    and has_recent_roof_permit is false
    and status = 'new';

-- Index for the skip-trace worker iterating pending rows.
create index if not exists canvass_targets_skip_trace_pending_idx
  on public.canvass_targets (office_id, score desc)
  where phone_checked_at is null
    and address_line is not null;

comment on column public.canvass_targets.phone_number is
  'Skip-traced phone number from a free people-search aggregator. Format normalized to E.164 where possible (+1XXXXXXXXXX), 10-digit US fallback otherwise. NULL = not enriched yet OR no match. Disambiguate via phone_checked_at.';
comment on column public.canvass_targets.phone_match_confidence is
  'How confident we are the number belongs to the current resident. high = name + address both match parcels row; medium = name match only; low = address match, name unknown.';
