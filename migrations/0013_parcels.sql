-- =====================================================================
-- 0013_parcels.sql
--
-- Florida residential parcel data — the backbone of the canvass-list
-- engine. One row per property; one geometry column carrying the
-- parcel polygon (or centroid where polygons aren't available); one
-- composite source flag so we know whether a row came from the FGIO
-- statewide baseline or a county fast feed.
--
-- Architecture:
--   * STATEWIDE BASELINE — `scripts/ingest_parcels.py --source fgio`
--     pulls the FL Department of Revenue statewide compilation
--     (annual) and seeds every FL parcel here with source='fgio'.
--   * COUNTY FAST FEEDS — same script with `--source seminole`,
--     `--source orange`, etc. overwrites the same row keyed by
--     parcel_id with source='seminole' (daily/nightly). The
--     UPSERT-on-conflict semantic means a county feed always wins
--     over the older FGIO record for the parcels it covers.
--   * STORM PULSE CROSS-REFERENCE — when a hail polygon lands,
--     /api/cron/storm-pulse does a PostGIS spatial join (ST_DWithin
--     on the geom column) and inserts canvass_targets rows pinned
--     to real owner/address data instead of OSM blobs.
--
-- Why one table for all of FL: ~9M rows is well inside Postgres'
-- comfort zone with a GIST index on geom. Partition by county only if
-- ingest contention becomes a problem.
-- =====================================================================

-- PostGIS is the engine. Idempotent — Supabase Postgres ships with
-- the extension available; this just turns it on for this project.
create extension if not exists postgis;

create table if not exists public.parcels (
  -- Composite key. (county_fips, parcel_id) is canonical — parcel IDs
  -- are only unique inside a county. parcel_id alone (the county PA's
  -- string) collides across counties.
  county_fips     text not null,        -- "12117" = Seminole, "12095" = Orange, etc.
  parcel_id       text not null,        -- the county Property Appraiser's string id

  -- Identity / canvass-relevant fields. Owner_name and situs_address
  -- come straight from the certified tax roll. Source of truth.
  owner_name      text,                 -- may be a trust / LLC for non-owner-occupied
  situs_address   text,                 -- "8450 OAK PARK RD"
  situs_city      text,                 -- "OVIEDO"
  situs_state     text default 'FL',
  situs_zip       text,                 -- "32765"

  -- Classification fields used by the canvass-filter.
  -- DOR land-use code (FL standard): single-family detached = "0100".
  -- We store both the raw code and a normalized boolean so callers
  -- don't have to memorize the code system.
  land_use_code   text,
  is_residential  boolean not null default false,
  year_built      integer,
  living_sqft     integer,              -- heated/cooled area, when available
  just_value      numeric(12, 2),       -- DOR "just value" — full market value
  assessed_value  numeric(12, 2),       -- post-cap value (Save Our Homes etc.)

  -- Geometry. Either the parcel polygon (preferred) or a centroid
  -- point fallback. PostGIS handles ST_DWithin / ST_Intersects on
  -- both. Storing in WGS84 (SRID 4326) so we don't have to project
  -- on every spatial query.
  geom            geometry(Geometry, 4326),
  centroid_lat    double precision,
  centroid_lng    double precision,

  -- Provenance. Tells the canvass-list ranker which source was
  -- responsible for this row's last refresh. County feeds outrank
  -- FGIO; FGIO outranks "this row is stale and we should re-fetch."
  source          text not null,        -- 'fgio' | 'seminole' | 'orange' | 'lake' | 'osceola' | 'volusia'
  source_fetched_at timestamptz not null default now(),

  -- House-keeping
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  primary key (county_fips, parcel_id)
);

-- ────── Indexes ──────
-- Spatial index — the make-or-break for ST_DWithin queries against
-- hail polygons. Without this, a 9M-row table scan is 10+ seconds.
-- With it, "every parcel inside this hail corridor" runs in <100ms.
create index if not exists parcels_geom_gist
  on public.parcels using gist (geom);

-- Centroid covering index for callers that only need lat/lng
-- (the storm-pulse fallback path when geom is null).
create index if not exists parcels_centroid_idx
  on public.parcels (centroid_lat, centroid_lng)
  where centroid_lat is not null and centroid_lng is not null;

-- ZIP-bounded lookup — drives the "show me parcels in 32765" UX in
-- the dashboard storms view without firing a full spatial query.
create index if not exists parcels_zip_idx
  on public.parcels (situs_zip)
  where situs_zip is not null;

-- Residential-only filter — most canvass queries gate on this. Partial
-- index keeps the working set small.
create index if not exists parcels_residential_idx
  on public.parcels (county_fips, is_residential)
  where is_residential = true;

-- Owner-name search (case-insensitive prefix lookup for the future
-- "find every property owned by X" rep tool).
create index if not exists parcels_owner_trgm
  on public.parcels using gin (lower(owner_name) gin_trgm_ops)
  where owner_name is not null;
create extension if not exists pg_trgm;

-- ────── updated_at trigger ──────
drop trigger if exists parcels_touch_updated_at on public.parcels;
create trigger parcels_touch_updated_at
  before update on public.parcels
  for each row execute procedure public.touch_updated_at();

-- ────── RLS ──────
-- Parcel data is public records — every authenticated rep across every
-- office can read it. Writes are service-role only (the nightly
-- ingest worker uses the service-role key). This is the "shared
-- reference data" RLS pattern, mirroring how /lib/dashboard accesses
-- offices and storm_events.
alter table public.parcels enable row level security;

drop policy if exists parcels_select_authenticated on public.parcels;
create policy parcels_select_authenticated on public.parcels
  for select
  using (auth.role() = 'authenticated' or auth.role() = 'service_role');

-- No insert/update/delete policies for authenticated users — writes
-- only happen through the service-role client used by the ingest
-- worker, which bypasses RLS by design.

comment on table public.parcels is
  'FL residential parcel data, layered: FGIO statewide baseline + per-county fast feeds. Source of truth for canvass-list addresses + owner names. Refreshed nightly via scripts/ingest_parcels.py.';
comment on column public.parcels.source is
  'Which feed last wrote this row. ''fgio'' = annual statewide baseline; county slugs = daily/nightly feeds that override FGIO for their territory.';
comment on column public.parcels.geom is
  'WGS84 (SRID 4326) parcel polygon. Falls back to centroid POINT when polygon unavailable. Use ST_DWithin (m, casted to geography) or ST_Intersects for canvass radius queries.';

-- ─── parcels_within_radius RPC ────────────────────────────────────────
--
-- Used by /api/cron/storm-pulse via lib/parcel-canvass.ts. PostGIS
-- spatial query that returns every residential parcel within
-- `radiusMiles` of (lat, lng), with the haversine distance computed
-- on the geography sphere (accurate to ~meters for FL latitudes).
--
-- Why an RPC and not direct supabase-js: the JS client can't express
-- PostGIS functions (ST_DWithin, ST_Distance) and supabase-js falls
-- back to "select * with rls" which always table-scans. An RPC lets
-- us inline the spatial WHERE and lean on the GIST index.
--
-- Returns at most `p_limit` rows ordered by distance ascending —
-- the caller (rankParcels in lib/parcel-canvass.ts) re-sorts by
-- composite score.
create or replace function public.parcels_within_radius(
  p_lat double precision,
  p_lng double precision,
  p_radius_miles double precision,
  p_residential_only boolean default true,
  p_limit integer default 5000
)
returns table (
  county_fips    text,
  parcel_id      text,
  owner_name     text,
  situs_address  text,
  situs_city     text,
  situs_zip      text,
  centroid_lat   double precision,
  centroid_lng   double precision,
  distance_miles double precision,
  year_built     integer,
  just_value     numeric
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with origin as (
    select st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography as g
  )
  select
    p.county_fips,
    p.parcel_id,
    p.owner_name,
    p.situs_address,
    p.situs_city,
    p.situs_zip,
    p.centroid_lat,
    p.centroid_lng,
    st_distance(
      coalesce(p.geom::geography, st_setsrid(st_makepoint(p.centroid_lng, p.centroid_lat), 4326)::geography),
      o.g
    ) / 1609.344 as distance_miles,
    p.year_built,
    p.just_value
  from public.parcels p, origin o
  where
    -- ST_DWithin on geography takes meters
    st_dwithin(
      coalesce(p.geom::geography, st_setsrid(st_makepoint(p.centroid_lng, p.centroid_lat), 4326)::geography),
      o.g,
      p_radius_miles * 1609.344
    )
    and (p_residential_only is false or p.is_residential = true)
    -- Don't return rows missing both polygon and centroid — they're
    -- unusable for canvass.
    and (p.geom is not null or (p.centroid_lat is not null and p.centroid_lng is not null))
  order by distance_miles asc
  limit p_limit;
$$;

-- Authenticated users can call the RPC; the function's `security
-- definer` runs with the table owner's privileges so RLS doesn't
-- block the spatial query.
grant execute on function public.parcels_within_radius(
  double precision, double precision, double precision, boolean, integer
) to authenticated, service_role;
