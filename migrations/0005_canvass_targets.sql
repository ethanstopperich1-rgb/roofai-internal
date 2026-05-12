-- =====================================================================
-- 0005_canvass_targets.sql
--
-- Storm-trigger lead engine — daily output tables.
--
-- The /api/cron/storm-pulse cron runs every 24h:
--   1. Scans MRMS for ≥1" hail events in the previous 48-hour window
--      across every watched region (one per office)
--   2. For each event, creates a `storm_events` row
--   3. For each address inside the impact zone, queues a
--      `canvass_targets` row that the office can pull / dispatch /
--      mark contacted
--
-- This table is separate from `leads` because canvass targets are not
-- yet leads — they're ADDRESS-level prospects the operator will work.
-- A canvass target becomes a lead when the homeowner responds (replies
-- to mail, fills the /quote form, calls in). The conversion link is
-- the `canvass_targets.lead_id` foreign key, populated at conversion
-- time.
-- =====================================================================

-- Storm events we've detected. One row per (region × date × peak event).
create table if not exists public.storm_events (
  id             uuid primary key default gen_random_uuid(),

  -- Where the event was detected
  region_name    text not null,          -- e.g. "Orlando, FL"
  center_lat     double precision not null,
  center_lng     double precision not null,
  radius_miles   numeric(6, 2) not null,

  -- When the event happened (MRMS YYYYMMDD)
  event_date     date not null,

  -- What we know about it
  peak_inches    numeric(4, 2) not null,
  hit_count      integer not null,        -- # of MRMS cells affected
  ground_reports integer not null default 0,  -- # of SPC reports same day
  source         text not null default 'mrms+spc',

  -- Lifecycle
  detected_at    timestamptz not null default now(),
  -- Which office this storm event was raised for. Null when the event
  -- crosses multiple operator territories — the cron then duplicates
  -- the row per office during materialization.
  office_id      uuid references public.offices (id) on delete cascade
);

create index if not exists storm_events_office_date_idx
  on public.storm_events (office_id, event_date desc);
create index if not exists storm_events_date_idx
  on public.storm_events (event_date desc);
-- Deduplication: never create two rows for the same office × date ×
-- region combination. The cron upserts on this constraint.
create unique index if not exists storm_events_office_date_region_uniq
  on public.storm_events (office_id, event_date, region_name);

-- ---------------------------------------------------------------------
-- canvass_targets
--
-- One row per ADDRESS inside a storm event's canvass radius. Populated
-- from OSM buildings (until the operator wires in a county parcel feed,
-- at which point the cron switches to parcel data).
--
-- Status lifecycle:
--   new        — just generated, never contacted
--   queued     — added to a campaign (direct mail / SMS / door knock)
--   contacted  — outbound contact attempted
--   responded  — homeowner engaged (form / call / SMS)
--   won        — became a closed job
--   lost       — explicitly disqualified
--   suppressed — on opt-out list or address-mismatch
-- ---------------------------------------------------------------------
create table if not exists public.canvass_targets (
  id              uuid primary key default gen_random_uuid(),
  office_id       uuid not null references public.offices (id) on delete restrict,
  storm_event_id  uuid not null references public.storm_events (id) on delete cascade,

  -- Address (best-effort from OSM; nullable for "building blob with no
  -- addr:* tag" until parcel data lands)
  address_line    text,
  city            text,
  state           text,
  zip             text,
  lat             double precision not null,
  lng             double precision not null,

  -- Scoring at canvass-target creation time. Higher = more likely to
  -- convert. Heuristic for v1; replaced by ML model once we have
  -- conversion feedback data.
  score           numeric(5, 2) not null default 0,
  distance_miles  numeric(6, 3),

  -- Lifecycle
  status          text not null default 'new'
                  check (status in ('new', 'queued', 'contacted', 'responded',
                                    'won', 'lost', 'suppressed')),
  contacted_at    timestamptz,
  responded_at    timestamptz,

  -- If the canvass target converts, link to the lead row. Many-to-one
  -- because a household might convert via more than one campaign.
  lead_id         uuid references public.leads (id) on delete set null,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists canvass_targets_office_status_idx
  on public.canvass_targets (office_id, status, score desc);
create index if not exists canvass_targets_event_idx
  on public.canvass_targets (storm_event_id);
-- For Bash queries like "what's been canvassed today"
create index if not exists canvass_targets_contacted_idx
  on public.canvass_targets (office_id, contacted_at desc) where contacted_at is not null;

drop trigger if exists canvass_targets_touch_updated_at on public.canvass_targets;
create trigger canvass_targets_touch_updated_at
  before update on public.canvass_targets
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.storm_events enable row level security;
alter table public.canvass_targets enable row level security;

-- storm_events: office-scoped read; writes via service role (cron)
drop policy if exists storm_events_select_office on public.storm_events;
create policy storm_events_select_office on public.storm_events
  for select to authenticated
  using (office_id = public.current_office_id() or public.is_admin() or office_id is null);

-- canvass_targets: office-scoped read + update (status/contacted_at).
-- Inserts happen via service role from the cron; no INSERT policy for
-- authenticated users.
drop policy if exists canvass_targets_select_office on public.canvass_targets;
create policy canvass_targets_select_office on public.canvass_targets
  for select to authenticated
  using (office_id = public.current_office_id() or public.is_admin());

drop policy if exists canvass_targets_update_office on public.canvass_targets;
create policy canvass_targets_update_office on public.canvass_targets
  for update to authenticated
  using (office_id = public.current_office_id() or public.is_admin())
  with check (office_id = public.current_office_id() or public.is_admin());

drop policy if exists canvass_targets_delete_admin on public.canvass_targets;
create policy canvass_targets_delete_admin on public.canvass_targets
  for delete to authenticated
  using (public.is_admin());
