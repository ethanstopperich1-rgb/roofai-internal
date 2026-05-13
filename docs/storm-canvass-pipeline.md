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

## Permit enrichment — deferred to post-demo

The original spec called for a `scripts/enrich_permits.py` using
CloakBrowser to scrape county permit portals for the top-ranked
canvass targets, flagging "no recent roof permit" as a hot-lead
signal.

This is **intentionally deferred** for two reasons:

1. **Legal posture.** Per the audit thread, scraping county permit
   portals via stealth-browser anti-bot evasion is a CFAA gray zone
   that a brief legal review should cover before we ship. The data
   itself is public records, but actively bypassing Cloudflare /
   reCAPTCHA on `.gov` sites is exactly the fact pattern that gets
   sued. Cost of legal review: ~$500-1000 with a tech-friendly
   attorney. Worth doing pre-launch, not pre-demo.

2. **Commercial alternative exists.** Shovels.ai publishes a
   permit-data API covering most of FL for ~$200-800/mo per tier.
   JSON in, JSON out. Zero legal exposure, faster to integrate, and
   their data quality is better than scraping anyway (they normalize
   permit types across county schemas, which a scraper would need to
   replicate).

The recommended path post-demo: sign up for Shovels.ai's smallest
FL tier, build `scripts/enrich_permits.py` against their API, add a
`permits` table to the schema and a JOIN in `parcels_within_radius`
to surface "has_recent_roof_permit" as a column on each canvass
target. ~2 days of work.

If you absolutely want the CloakBrowser path despite the above,
the architecture lives in the audit thread — search for
"county-portal worker" in the project history.
