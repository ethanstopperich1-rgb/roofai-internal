# Storm Canvass — Ingest Runbook

One-time operations playbook to flip the canvass pipeline from
demo-only (slow, per-address portal scraping) to production-ready
(pre-ingested parcels, sub-second canvass queries).

**Total wall time:** ~60-75 min, mostly waiting on the FGIO download.

**Outcome:**
- Every parcel in Seminole County in Supabase (daily-refreshed).
- Every parcel in Florida in Supabase (annually-refreshed baseline).
- Storm-pulse cron creates ranked canvass_targets in seconds.
- `/dashboard/canvass` shows real homes, real owners, real scoring.

---

## Step 1 — Find your Supabase DB connection string

Open the Supabase dashboard → your project → **Project Settings → Database
→ Connection string → URI tab**. Substitute `[YOUR-PASSWORD]` with the
DB password (visible in 1Password / Supabase secrets vault).

It looks like:
```
postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
```

Test it works:
```bash
psql "<paste-the-url>" -c "select count(*) from public.leads;"
```

If that returns a count, you're good. Save the URL as an env var for
the rest of the steps:
```bash
export SUPABASE_DB_URL="<paste-the-url>"
```

---

## Step 2 — Apply the two migrations

```bash
cd "/Users/voxaris/Roofing AI Estimator"
psql "$SUPABASE_DB_URL" -f migrations/0013_parcels.sql
psql "$SUPABASE_DB_URL" -f migrations/0014_canvass_targets_permits.sql
```

**Success check:** these should print `CREATE TABLE`, `CREATE INDEX`,
etc. No errors. Verify with:
```bash
psql "$SUPABASE_DB_URL" -c "\d public.parcels" | head -30
```

You should see the `parcels` table with `geom`, `centroid_lat`,
`owner_name`, `year_built`, `is_residential`, etc.

---

## Step 3 — Grab the FGIO statewide shapefile URL

The FGIO Hub publishes a fresh signed URL per session (~30 min
validity), so we can't hardcode it in the workflow. One-time manual
step:

1. Open https://geodata.floridagio.gov/datasets/FGIO::florida-statewide-parcels
2. Click **"I want to use this"** → **"Download"** → **"Shapefile"**
3. **Copy the URL** the browser starts downloading from (right-click
   the download in your downloads bar → "Copy link"). It looks like:
   ```
   https://opendata.arcgis.com/api/v3/datasets/<long-id>/downloads/data?format=shp&spatialRefId=4326
   ```
4. Cancel the download — we're just stealing the URL.

Save it for Step 5:
```bash
export FGIO_SHAPEFILE_URL="<paste-from-browser>"
```

---

## Step 4 — Configure GitHub Actions secrets

The ingest runs on GH Actions (Ubuntu runners can `apt install
libgdal`; macOS can too but it's easier to keep this off your laptop).

```bash
# From the repo root
gh secret set SUPABASE_DB_URL          --body "$SUPABASE_DB_URL"
gh secret set SEMINOLE_PARCELS_GDB_URL --body "https://scwebapp2.seminolecountyfl.gov:6443/is/gis/GISData/Parcels.gdb.zip"
gh secret set FGIO_SHAPEFILE_URL       --body "$FGIO_SHAPEFILE_URL"
gh secret set PERMITS_CONTACT_EMAIL    --body "admin@voxaris.io"
```

**Verify:**
```bash
gh secret list | grep -E "SUPABASE_DB_URL|FGIO_|SEMINOLE_|PERMITS_"
```

You should see all 4 listed with recent timestamps.

---

## Step 5 — Seed Seminole first (fast, validates the pipeline)

Smaller, faster ingest. Use this to prove the whole loop works
before paying for the big FGIO download.

```bash
gh workflow run ingest-parcels.yml -f source=seminole
```

Then watch:
```bash
gh run watch
```

Expected: ~8 min. The job log streams to stdout. Look for:
```
[ingest_parcels] starting ingest source=seminole
[ingest_parcels] downloading https://scwebapp2... → ...
[ingest_parcels] download complete: ... (XX MB)
[ingest_parcels] opening dataset: ...
[ingest_parcels] written: 2000
[ingest_parcels] written: 4000
...
[ingest_parcels] done source=seminole rows=~165000
```

**Success check:**
```bash
psql "$SUPABASE_DB_URL" -c "
  select count(*) as total,
         count(*) filter (where is_residential) as residential,
         min(year_built) as oldest,
         max(year_built) as newest
    from public.parcels where county_fips = '12117';
"
```

Should show ~165k total parcels, ~130k residential, year_built range
roughly 1900-2025.

Validate the 700 Fox Edge Ct lookup that the test script does live:
```bash
psql "$SUPABASE_DB_URL" -c "
  select parcel_id, owner_name, situs_address, year_built, just_value
    from public.parcels
    where situs_address ilike '700 FOX EDGE%'
      and situs_zip = '32765';
"
```

You should see the real year_built (and owner name). That confirms
the data layer is correct.

---

## Step 6 — Seed FGIO statewide (slow, big payoff)

This is the ~40-minute one. All ~9M FL parcels, normalized DOR
schema.

```bash
gh workflow run ingest-parcels.yml -f source=fgio
gh run watch
```

Expected log progression:
```
[ingest_parcels] starting ingest source=fgio
[ingest_parcels] downloading https://opendata.arcgis.com/... (large file, may take 5-10 min)
[ingest_parcels] download complete: ~2.4 GB
[ingest_parcels] unzipping ...
[ingest_parcels] opening dataset: .../Florida_Statewide_Parcels.shp
[ingest_parcels] dataset has 9,180,xxx features in EPSG:4326
[ingest_parcels] written: 2000
... (will print every 2000 rows, ~4500 progress lines total)
[ingest_parcels] done source=fgio rows=~9180000
```

**Success check:**
```bash
psql "$SUPABASE_DB_URL" -c "
  select source, count(*)
    from public.parcels
   group by source
   order by source;
"
```

Expected:
- `fgio` — ~9,000,000+ rows (baseline for non-priority counties)
- `seminole` — ~165,000 (overrode FGIO for Seminole)

The on-conflict logic in `UPSERT_SQL` means Seminole rows kept their
daily-feed source even though FGIO ran second.

---

## Step 7 — Trigger storm-pulse to populate canvass_targets

Now that parcels are loaded, storm-pulse can run the real spatial
join + scoring.

```bash
# CRON_SECRET is already set in Vercel; grab it once for the curl
# (Vercel dashboard → project → settings → environment variables)
export CRON_SECRET="<from-vercel-dashboard>"
curl -X GET "https://pitch.voxaris.io/api/cron/storm-pulse" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Expected response (~5-15 sec depending on how many regions × events):
```json
{
  "status": "ok",
  "runAt": "...",
  "regions": [
    { "region": "Orlando, FL", "eventsDetected": 1, "newStormEvents": 1, "newCanvassTargets": 500 },
    { "region": "Tampa, FL",   "eventsDetected": 0, "newStormEvents": 0, "newCanvassTargets": 0 },
    { "region": "Lakeland, FL","eventsDetected": 0, "newStormEvents": 0, "newCanvassTargets": 0 }
  ]
}
```

If a storm fired in the last 48 hours, `newCanvassTargets` will be
populated with real ranked rows.

**Success check:**
```bash
psql "$SUPABASE_DB_URL" -c "
  select ct.address_line, p.year_built, ct.score, ct.distance_miles
    from public.canvass_targets ct
    left join public.parcels p
      on p.situs_address = ct.address_line and p.situs_zip = ct.zip
   order by ct.score desc
   limit 10;
"
```

Top rows should show old-construction homes (year_built < 2010) with
high scores. New construction should NOT be near the top (the
<10yr short-circuit we just shipped does its job).

---

## Step 8 — Open the canvass UI

```
https://pitch.voxaris.io/dashboard/canvass
```

You should see:
- Storm events in the left rail
- The ranked table populated with real homeowner addresses
- "Hot leads" preset selected by default
- Map view toggle works
- CSV export pulls the ranked list

**Demo-ready.**

---

## What's now automated

Once the secrets are set and migrations applied, the cron schedule
handles everything going forward:

| Job | Schedule | What it does |
|---|---|---|
| `.github/workflows/ingest-mrms.yml` | Daily 02:30 UTC | MRMS hail → Vercel Blob |
| `.github/workflows/ingest-parcels.yml` | Daily 01:30 UTC (Seminole) | Refresh Seminole parcels |
| `.github/workflows/ingest-parcels.yml` | Weekly Sunday 03:00 UTC (FGIO) | Refresh statewide parcels |
| Vercel cron `/api/cron/storm-pulse` | Daily 06:00 UTC | Detect new storms, build canvass list |
| `.github/workflows/enrich-permits.yml` | Daily 06:30 UTC | Pull permit data for top-500 targets |

No manual intervention required after this runbook completes.

---

## Troubleshooting

### "FGIO_SHAPEFILE_URL expired" mid-ingest
ArcGIS Hub URLs expire ~30 min after generation. If the GH Action
fails on a 401/403 during download, re-grab the URL from Step 3 and
re-run Step 6.

### Seminole ingest succeeds but rows have no `year_built`
The DOR schema field name varies between Seminole's annual snapshot
and their daily feed. The script tries both `YR_BLT` and
`ACT_YR_BLT` — if one is in the latest export, the other might
populate as null. Run a sample query to see which field name landed:
```bash
psql "$SUPABASE_DB_URL" -c "
  select year_built, count(*) from public.parcels
   where county_fips = '12117'
   group by year_built order by year_built desc nulls last limit 20;
"
```

If everything is null, the field-name map needs an update in
`scripts/ingest_parcels.py::load_seminole()`.

### Storm-pulse returns 0 newCanvassTargets even with parcels loaded
Two likely causes:
1. **No storm hit in last 48h.** Check `/api/storms/recent?lat=28.5&lng=-81.4`
   for activity. May 13, 2026 Oviedo cluster is still in the 48h
   window today, so this should work.
2. **CRON_SECRET mismatch.** Storm-pulse returns 401 silently if the
   bearer token doesn't match. Verify with `echo $CRON_SECRET`.

### "Connection timeout" hitting Seminole portal
Seminole's gdb URL serves over HTTPS port 6443. Some networks block
non-standard ports. The GH Actions Ubuntu runners can reach it; your
laptop may not. Run via `gh workflow run`, not locally.

---

## Tomorrow morning's flow (after this is set up)

```
05:30 UTC — IEM LSRs publish overnight storm reports
06:00 UTC — storm-pulse cron fires, scans last 48h
            ├── Reads IEM + MRMS via existing routes
            ├── Detects events ≥ 0.5" hail
            ├── Spatial-joins parcels.geom within 2mi radius
            ├── Scores each parcel against the hot-lead rubric
            └── Writes top 500 ranked rows to canvass_targets
06:30 UTC — enrich-permits cron fires
            ├── Pulls top 500 pending rows for Seminole + Orange
            ├── CloakBrowser → permit portals → write permit data back
            └── Re-scores rows with permit context
07:00 ET  — Reps log in, /dashboard/canvass shows the morning's list
            ├── Hot leads preset by default (storm-hit + no permit)
            ├── Top scores up top, ready to knock
            └── CSV export for paper / tablet workflow
```

No human intervention required after initial setup.
