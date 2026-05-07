# MRMS Hail Ingest — Runbook

Free, daily, radar-derived hail data for every property in the RSS service
footprint. Layered on top of the existing NOAA SPC data already served by
`/api/storms`.

## What it is

NOAA MRMS (Multi-Radar Multi-Sensor) **MESH** = Maximum Estimated Size of
Hail. A 1 km gridded radar product, updated every 30 minutes,
covering all of CONUS. The same dataset commercial products like
HailTrace ($500-2k/mo) and Interactive Hail Maps ($25-35/report) are
built on top of. We pull the daily-aggregated 24-hour-maximum file
(`MESH_Max_1440min`) from the public AWS NOAA bucket, decode it, and
write per-day JSON files to Vercel Blob.

**Hot path** is `/api/hail-mrms?lat=&lng=&yearsBack=2&radiusMiles=2&minInches=0.75`,
which reads those Blob files and returns the days where radar saw hail
within `radiusMiles` of the property.

## Why this beats NOAA SPC alone

We already have NOAA Storm Prediction Center via BigQuery (`/api/storms`).
SPC reports are human-filed Local Storm Reports — the legal "documented
event" record carriers respect. But SPC has gaps:

| Dimension | NOAA SPC (we have) | MRMS (this build) |
|---|---|---|
| Resolution | County-centroid points | 1 km radar grid |
| Coverage | "Someone called it in" | Full radar footprint |
| Threshold | ≥ 1″ hail to be reported | Catches sub-1″ |
| Latency | 30-60 day reporting lag | ~30 min behind real-time |
| Cost | Free | Free |
| Provenance | Adjuster-friendly | Adjuster-friendly (USGS-grade) |

## Architecture

```
   AWS NOAA MRMS-PDS bucket
         │
         │  daily 02:30 UTC
         ▼
   GitHub Actions runner
   (Ubuntu + apt-installed eccodes)
         │
         │  pygrib parses PNG-compressed GRIB2,
         │  filters cells ≥ 12.7mm in FL/MN/TX bbox
         ▼
   Vercel Blob: mrms-hail/YYYYMMDD.json
         │
         ▼
   /api/hail-mrms (Next.js route)
         │
         ▼
   <StormHistoryCard> + Supplement Analyzer
```

**Why GitHub Actions, not Vercel Cron:** MRMS files use GRIB2 template 41
(PNG-compressed data section). Decoding requires the eccodes C library
that pygrib needs. Vercel's Python serverless runtime can't
`apt-get install libeccodes-dev`. GitHub Actions Ubuntu runners can.
The decoded JSON gets pushed to Vercel Blob; the hot path runs entirely
on Vercel without any GRIB2 dependency.

## Files

| Path | Role |
|---|---|
| `scripts/ingest_mrms.py` | Python ingest. Downloads GRIB2 → decodes → uploads JSON to Blob. |
| `.github/workflows/ingest-mrms.yml` | Daily cron at 02:30 UTC. Also triggers backfill via workflow_dispatch. |
| `app/api/hail-mrms/route.ts` | Hot-path API. Reads Blob, filters by lat/lng radius, returns events. |
| `components/StormHistoryCard.tsx` | UI surface. New "Radar-detected hail" section under the existing SPC list. |

## Cost

| Component | Cost |
|---|---|
| AWS S3 anonymous reads | $0 (NOAA Open Data) |
| GitHub Actions (90s/day × ~30/mo = 45 min/mo) | $0 (free tier 2000 min/mo private, unlimited public) |
| Vercel Blob storage (~100 KB × 365 days × 2 yrs ≈ 70 MB) | $0 (Hobby tier 1GB free, Pro tier 10GB free) |
| Vercel Function invocations | already counted |
| **Total marginal monthly cost** | **$0** |

## Coverage caveats

- **Bucket starts Oct 2020.** Pre-Sep-2020 hail history isn't available;
  fall back to `/api/storms` (NOAA SPC) for older events.
- **Hurricane Ian (Sep 2022) and Idalia (Aug 2023) are in coverage.**
- The bucket has rare gaps where a daily file was never published (radar
  outages). The ingest script returns `status: "no_data"` for those days
  and continues; the hot path skips them silently.
- MRMS is a CONUS-only product. Alaska / Hawaii / territories are not in
  scope. Fine for RSS's FL/MN/TX footprint.

## First-time setup

1. **Set the `BLOB_READ_WRITE_TOKEN` secret on the GitHub repo**
   (Settings → Secrets and variables → Actions → New secret). This is
   the same token Vercel auto-injects for the deployed functions —
   easiest to copy from the Vercel project's env vars.

2. **Trigger an initial backfill.** Go to the Actions tab → "Ingest MRMS
   hail" → Run workflow → fill in `backfill = 2024-01-01:2026-05-07` (or
   whatever range you want). Backfilling 24 months takes ~25-30 minutes
   of runner time; the bucket is fast.

3. **Verify on the rep tool.** Pull up an FL address that hit hail in
   summer 2024. The Storm History card should show the SPC report list
   AND a new "Radar-detected hail" section underneath.

## Daily run

The cron fires at 02:30 UTC daily (= 21:30 ET previous day). It only
ingests "yesterday" relative to UTC. After the run, a new
`mrms-hail/YYYYMMDD.json` Blob exists, plus `mrms-hail/latest.json` is
overwritten with a pointer to the most recent ingest.

The hot path's date-range filter walks the full Blob list each request,
but the result is cached in Upstash Redis for 6 hours per
(lat, lng, radius, minInches, yearsBack) tuple. Listing the Blob index
itself is cached for 1 hour.

## Tuning knobs

In `scripts/ingest_mrms.py`:

- `RSS_BBOX` — the geographic envelope to filter cells into. Currently
  covers all of FL/MN/TX with ~50 mile padding. Expand if RSS adds
  states.
- `MIN_HAIL_MM` (12.7 = 0.5″) — sets the inclusion threshold. Lower =
  bigger Blob files, more "soft hail" noise. Higher = misses
  marginal-damage events. 0.5″ is the actuarial sub-actionable floor.
- `MRMS_PRODUCT_PREFIX` — `MESH_Max_1440min` is the 24-hour max.
  Alternatives in the same bucket: `MESH_Max_60min`, `MESH_Max_240min`.
  The 24-hour version is the right one for "did this property see hail
  on date X?" queries.

In `app/api/hail-mrms/route.ts`:

- `radiusMiles` (default 2) — MESH cells are 1km, so anything below
  ~0.6 mi just hits the same cell. >2 mi starts pulling in
  neighborhood-scale events the property may not have actually
  experienced.
- `minInches` (default 0.5) — most insurance carriers require ≥ 0.75″
  for hail-damage claims to be actionable. ≥ 1″ for shingle granule
  loss + bruising. Keep the default at 0.5″ so the rep can see the
  full picture, then filter in the UI for the slide.

## Backfill once

```sh
# Locally — needs eccodes via brew + pygrib via pip
brew install eccodes
python3 -m venv /tmp/mrms-venv
source /tmp/mrms-venv/bin/activate
pip install pygrib numpy
export BLOB_READ_WRITE_TOKEN=...
pnpm ingest:mrms -- --backfill 2024-01-01:2026-05-07
```

Or trigger the GH Actions workflow with the backfill input populated —
no local install needed.

## What this unlocks downstream

- **Supplement Analyzer**: when a carrier scope dates the storm event on
  date X but radar shows ≥1″ hail at that property on date X-3 OR X+1,
  the analyzer flags the date discrepancy + recommends the rep request
  scope adjustment.
- **Lead targeting (canvasser mode)**: query "every property within 5 mi
  of a ≥1″ hail event in the past 60 days" → output as CSV → upload to
  the door-knocking app. Complements the existing storm-correlation
  banner.
- **Insurance claim packets**: PDF includes a citation line — "NOAA MRMS
  radar detected hail of N inches at this property's coordinates on
  YYYY-MM-DD" — adjuster-grade language without HailTrace's per-report
  fee.
