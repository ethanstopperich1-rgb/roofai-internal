-- =====================================================================
-- 0014_canvass_targets_permits.sql
--
-- Add permit-enrichment columns to canvass_targets. Populated by
-- scripts/enrich_permits.py which queries county permit portals
-- for each top-ranked canvass target.
--
-- The killer signal in this column set: `has_recent_roof_permit = false`
-- on a high-score (storm-impacted, age 15-25yr) canvass target = a
-- homeowner whose roof was just hit AND who hasn't pulled a permit yet.
-- That's the door we want to knock first.
-- =====================================================================

alter table public.canvass_targets
  add column if not exists has_recent_roof_permit boolean,
  add column if not exists last_permit_type text,
  add column if not exists last_permit_date date,
  add column if not exists last_permit_number text,
  -- When the enrichment worker last checked. Null = not yet checked.
  -- Used to (a) avoid re-querying the same address every cron run
  -- and (b) flag stale data ("permit check >7 days old, re-run").
  add column if not exists permit_checked_at timestamptz,
  -- Stores the raw portal response in case we need to debug the
  -- parser. Capped at ~4 KB by the script before insert.
  add column if not exists permit_raw_summary text;

-- Composite index for the canvass-list ranker. Surfaces "high score AND
-- no recent permit" in a single query — that's the priority queue.
create index if not exists canvass_targets_hot_lead_idx
  on public.canvass_targets (office_id, score desc)
  where has_recent_roof_permit is false and status = 'new';

-- Workers iterating "still need to check" rows.
create index if not exists canvass_targets_pending_permit_idx
  on public.canvass_targets (storm_event_id, score desc)
  where permit_checked_at is null;

comment on column public.canvass_targets.has_recent_roof_permit is
  'True if county permit portal returned a roof/reroof/roof-repair permit pulled within the last 24 months. False = no permit on file (hot lead). Null = not yet checked.';
comment on column public.canvass_targets.permit_checked_at is
  'When scripts/enrich_permits.py last queried the county portal for this address. Null = pending. Older than 7d = stale, re-run on next pass.';
