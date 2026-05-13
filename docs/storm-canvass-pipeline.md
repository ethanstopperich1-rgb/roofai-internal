# Storm Canvass Pipeline — runbook

The end-to-end flow that turns NOAA MRMS hail data into a ranked door-knocking
list of real Florida homeowners.

```
MRMS GRIB2 (NOAA AWS S3)
   │  scripts/ingest_mrms.py (GH Actions, 02:30 UTC daily)
   ▼
Vercel Blob: mrms-hail/YYYYMMDD.json
   │  /api/hail-mrms (read path)
   ▼
/api/cron/storm-pulse  (Vercel cron, 06:00 UTC daily)
   ├─ upsert storm_events
   └─ for each NEW event:
        │  parcelsWithinRadius()  ──►  PostGIS ST_DWithin on parcels.geom
        │  rankParcels()          ──►  hail × proximity × age × value
        ▼
      canvass_targets rows  (top 500 ranked per event)
            │
            │  scripts/ingest_parcels.py
            │  (GH Actions, 01:30 UTC daily for Seminole,
            │   03:00 UTC Sunday for FGIO statewide)
            ▼
       public.parcels  (PostGIS table, 9M FL rows once seeded)
```

## Bringing this online — one-time setup

### 1. Apply the migration

```bash
psql "$SUPABASE_DB_URL" -f migrations/0013_parcels.sql
```

This:

- Enables PostGIS + pg_trgm extensions.
- Creates `public.parcels` with GIST index on `geom`.
- Creates the `parcels_within_radius` RPC that `lib/parcel-canvass.ts` calls.
- Wires RLS so all authenticated reps can read, only service-role can write.

### 2. Seed the FGIO statewide baseline

```bash
# Set the FGIO shapefile URL — the FGIO Hub page rotates tokens
# periodically; grab the current one from
# https://geodata.floridagio.gov/datasets/FGIO::florida-statewide-parcels
export FGIO_SHAPEFILE_URL="<direct shapefile download URL>"
export SUPABASE_DB_URL="postgresql://postgres:<pass>@<project>.supabase.co:5432/postgres"

# Optional: smoke-test first with PARCEL_INGEST_LIMIT
PARCEL_INGEST_LIMIT=10000 python scripts/ingest_parcels.py --source fgio

# Full statewide ingest (~9M rows, ~45 min)
python scripts/ingest_parcels.py --source fgio
```

### 3. Add the Seminole daily overlay

```bash
export SEMINOLE_PARCELS_GDB_URL="https://scwebapp2.seminolecountyfl.gov:6443/is/gis/GISData/Parcels.gdb.zip"
python scripts/ingest_parcels.py --source seminole
```

The UPSERT-on-conflict overwrites the matching FGIO rows with the
Seminole fast-feed data. Other counties (Orange, Lake, Osceola, Volusia)
follow the same pattern — see "Adding a county" below.

### 4. Configure GitHub secrets

Required for the workflow at `.github/workflows/ingest-parcels.yml`:

| Secret | Value |
|---|---|
| `SUPABASE_DB_URL` | Supabase Postgres URL with service-role credentials |
| `FGIO_SHAPEFILE_URL` | Current direct download from FGIO Hub |
| `SEMINOLE_PARCELS_GDB_URL` | (Optional — defaults to known URL) |

### 5. Verify the storm pulse cron picks up parcels

```bash
# Trigger storm-pulse manually
curl -X GET "https://pitch.voxaris.io/api/cron/storm-pulse" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Response will show `newCanvassTargets` count. With parcels populated,
the cron logs `[parcel-canvass]` lines and inserts up to 500 ranked
real-address rows per storm event. Without parcels, it falls back to
the OSM building-count placeholder.

## Adding a new county

1. Open `scripts/ingest_parcels.py`.
2. Find the `_stub_county()` placeholder for the slug.
3. Replace with a loader function modeled on `load_seminole()`:
   - Pin the county's GIS portal direct-download URL as an env var.
   - Map the county's PA-specific column names to the `ParcelRow` fields.
4. Register the new loader in `COUNTY_LOADERS`.
5. Add a new cron entry to `.github/workflows/ingest-parcels.yml` if
   you want a separate schedule (otherwise rely on `--source all` weekly).

Field-name conventions across the 5 FL counties we plan to wire:

| Field | FGIO (DOR) | Seminole | Orange | Lake | Osceola | Volusia |
|---|---|---|---|---|---|---|
| Parcel ID | `PARCEL_ID` | `PARCEL_NUM` | `PARCEL_NUM` | `ALT_KEY` | `PIN` | `PARCEL_ID` |
| Owner | `OWN_NAME` | `OWN_NAME1` | `OWNERNAME` | `OWNER_NAME` | `OWNER` | `OWN_NAME` |
| Address | `PHY_ADDR1` | `SITE_ADDR` | `SITUS_ADDR` | `SITUS_ADDR` | `SITUS_ADDRESS` | `PHY_ADDR1` |
| Land use | `DOR_UC` | `DORUC` | `DOR_UC` | `DOR_UC` | `LANDUSECODE` | `DOR_UC` |

These are best-effort from public PA documentation; verify against
the actual schema when adding each loader. The script's `_str_or_none`
helpers tolerate missing columns gracefully.

## Permit enrichment — `scripts/enrich_permits.py`

Wired now. CloakBrowser-driven, runs in `.github/workflows/enrich-permits.yml`
at 06:30 UTC daily (30 min after storm-pulse). Adapters for Seminole
and Orange counties; add more by following the same shape.

### What it does

1. Pulls top-N (default 500) `canvass_targets` rows where
   `permit_checked_at is null`, ordered by score desc, filtered to the
   target county via the parcel join.
2. For each address, launches CloakBrowser (humanize=True for
   human-like timing) and queries the county permit portal:
   - **Seminole**: `citizenservice.seminolecountyfl.gov/Permits/SearchByAddress.aspx`
   - **Orange**: `fasttrack.ocfl.net/OnlineServices/Permits/Search`
3. Parses the result table for any permit whose type matches the roof
   pattern (`re-roof | roof replace | roof repair | new roof | roofing`)
   within the last 24 months.
4. Writes back to the canvass_targets row:
   - `has_recent_roof_permit` (bool, NULL on portal failure)
   - `last_permit_type`, `last_permit_date`, `last_permit_number`
   - `permit_raw_summary` (up to 4 KB for ops debugging)
   - `permit_checked_at = now()`

### Polite-scrape posture (these are baked into the script, not optional)

- **Volume cap**: TOP_N default 500/county/run. Configurable via env or
  workflow input.
- **Rate limit**: 3-5 second randomized interval per address. Single
  concurrent worker — no parallelism within a county.
- **Identifying User-Agent**: Standard Chrome UA + suffix
  `Voxaris-Canvass-Bot (+hello@voxaris.io)` so the county IT team can
  identify and reach us if there's an issue.
- **robots.txt probed once per county at startup**; if our UA is
  disallowed at the search path, we abort that county and log it.
- **Fail open**: any single-address error is logged and the row is
  marked `permit_checked_at = now()` with `has_recent_roof_permit =
  null`, so a flaky portal doesn't block the canvass list.

### One-time setup

```bash
# Apply the migration
psql "$SUPABASE_DB_URL" -f migrations/0014_canvass_targets_permits.sql

# Add a GH secret for the contact email used in the identifying UA
# (defaults to hello@voxaris.io if unset)
gh secret set PERMITS_CONTACT_EMAIL --body "hello@voxaris.io"
```

### Manual test

```bash
export SUPABASE_DB_URL="postgresql://postgres:<pass>@<project>.supabase.co:5432/postgres"
export PERMIT_DRYRUN=1
python scripts/enrich_permits.py --county seminole --top-n 5
```

Dryrun hits the portals but skips the DB write, so you can verify the
parser without polluting the canvass_targets rows.

### Hot-lead scoring rubric

After enrichment finishes, every canvass_targets row gets re-scored
using the Noland's canvass rubric. The score column is canonical and
sortable; higher = canvass first.

**Must-pass filters** (gate, applied BEFORE scoring):
- Land use = single-family residential
- Inside hail corridor (ST_DWithin enforces this)
- Hail size ≥ 0.5" (Noland's reports closing on 0.5"; conventional
  industry floor is 0.75-1.0" but aged FL roofs convert lower —
  configurable via `MIN_HAIL_INCHES` in storm-pulse)

**Additive over the hail × proximity base:**

| Component | Rule | Threshold for "hot" |
|---|---|---|
| Roof Permit Recency | No permit in 15 yr (or never) = **+50** · 10-15 yr = **+30** · 5-10 yr = 0 · <5 yr = **−40** | No permit in 15y = hottest |
| Permit Type Keywords | Matches `roof | reroof | re-roof | roof replacement | roof repair | building – roof` | Only these trigger recency |
| Estimated Roof Age | Year built > 20 yr AND no recent permit = **+25** | >20 yr old |
| Hail × Proximity | `hail_inches × 10 × 1/(1+dist_miles)` | multiplicative base |
| Post-storm activity | Roof permit filed AFTER `storm_event.event_date` = **−100** (returns early) | Flag & deprioritize |

Implemented in:
- `lib/parcel-canvass.ts::scoreHotLead()` — canonical TS reference
- `scripts/enrich_permits.py::score_hot_lead()` — Python port, kept in sync

### The killer query

```sql
select address_line, city, zip, score, last_permit_date, distance_miles
from public.canvass_targets
where office_id = $1
  and status = 'new'
  and has_recent_roof_permit is false   -- no permit OR portal returned nothing roof-related
order by score desc
limit 50;
```

This is the priority queue: storm-hit × residential × in-radius ×
no recent permit. The highest-score row is typically a 20+ year old
single-family home, in the corridor of a 1"+ hail strike, with
nothing roof-related on file at the county portal. That's the
door we want the rep at first.

### Adding a new county

Follow `query_seminole()` in `scripts/enrich_permits.py` as the
reference. Each adapter needs:

- `portal_url` for the robots.txt probe
- A `query_<county>(page, row)` function that fills the search form
  and returns a list of `{number, type, date, status}` dicts
- An entry in `COUNTY_QUERIES` mapping the slug → adapter

The `_summarize_permits()` helper does the rest — match the roof
regex, find the most recent permit within the 24-month window, return
a `PermitFinding`. Same shape across counties.
