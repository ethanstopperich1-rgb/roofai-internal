# Implementation Notes — Roof Measurement & Google API Hardening (2026-05-14)

Scope: Phase 1 (Tier B correctness), Phase 3 (Solar DETECTED_ARRAYS), Phase 4
(Tier A timeout knob), Phase 6 (low-confidence banner), plus Google API
audit wins from context7 + official docs.

Out of scope (deferred — flagged in the original GO): Phase 2 (server-side
refined-RoofData persistence) and Phase 1.2 Option 2a (Tier B for
`polygonSource === "ai"` low-facet roofs). Both are design decisions that
need rep-feedback data before implementing.

---

## New / changed env vars

| Var | Default | Effect |
|---|---|---|
| `SOLAR_DETECTED_ARRAYS` | unset (off) | Sends `additionalInsights=DETECTED_ARRAYS` on Solar buildingInsights:findClosest. Adds `detectedArrays: { status, latestCaptureDate }` to SolarSummary when Google has detected existing PV. No extra Solar API cost. |
| `LIDAR_FETCH_TIMEOUT_MS` | unset (→ 30000 ms) | Overrides Tier A LiDAR fetch timeout. Clamped to [5000, 120000]. Use for Modal cold-starts or alternate hosts. |

Existing env vars (`ENABLE_TIER_B_REFINEMENT`, `LIDAR_SERVICE_URL`,
`MODAL_TOKEN_ID/SECRET`) unchanged.

---

## Behavior changes

### Estimator pipeline

- **Dashboard `/dashboard/estimate`** now passes `address` (+ `?nocache=1`
  when set) to `/api/roof-pipeline`, mirrors `/internal` + `/quote`.
- **Dashboard waste table** uses `roofData.totals.totalRoofAreaSqft` +
  `roofData.totals.complexity` when RoofData is usable; falls back to
  assumptions when degraded. Matches `/internal`.
- **Dashboard pipeline errors** now render as a visible red banner
  instead of being swallowed by `.catch(() => {})`.

### Tier B (multiview)

- Map badge no longer keys on `roofData.source === "tier-b-multiview"`
  (mergeRefinement preserves `prev.source`, so that branch never fired).
  Replaced with `roofData.refinements.includes("multiview-obliques")`.
- New status enum value `"failed"` distinct from `"skipped"`.
- Telemetry: emits `tier_b_attempted` at start, then exactly one of
  `tier_b_succeeded` / `tier_b_skipped` / `tier_b_failed` with reason
  codes. Existing PII surface (formatted address) unchanged.
- Retry path: on failure, `inspectorRanForKeyRef` is preserved so the
  rep doesn't get a paid-loop on transient errors; re-running estimate
  (`runEstimate` already resets the ref on every address change) is the
  documented recovery path.

### Solar API

- Optional `additionalInsights=DETECTED_ARRAYS` when `SOLAR_DETECTED_ARRAYS=1`.
- `SolarSummary.detectedArrays` is an optional field — existing consumers
  ignore it unchanged.

### Low-confidence rep banner

- `/internal` renders an amber "Review measurements" banner when
  `roofData.confidence < 0.5` or `diagnostics.needsReview.length > 0`.
  Suggests Tier B inspector or re-analyze when Tier B is off; suggests
  satellite polygon confirmation when Tier B has already refined.

### Google API audit wins

- **Weather**: now requests `unitsSystem=IMPERIAL&languageCode=en` so
  Google returns °F and mph directly. Eliminates client-side C→F + km/h
  → mph conversion drift. `tempC` field is preserved for downstream
  consumers (converted from the imperial value).
- **Places Autocomplete / Details**: both routes now accept an optional
  `sessionToken` query param. When the caller passes the same token to
  autocomplete (per keystroke) and details (on selection), Google bills
  the whole session as one billing unit instead of per-request — typical
  cost reduction for an active address picker. Backward compatible:
  callers that don't pass `sessionToken` keep the old per-request
  pricing. Caller is responsible for generating a fresh UUID per
  "picker open" — wire this up in the autocomplete component when ready.
- **Solar dataLayers** (existing): already uses `requiredQuality=LOW`,
  matching Google's own sample's `BASE` recommendation. No change.

### Tier A

- Configurable timeout via `LIDAR_FETCH_TIMEOUT_MS`. Useful when moving
  off Modal (Fly/Railway cold-starts vary).

---

## Files touched

- `app/api/solar/route.ts` — DETECTED_ARRAYS flag + response mapping
- `app/api/weather/route.ts` — unitsSystem=IMPERIAL + languageCode
- `app/api/places/autocomplete/route.ts` — sessionToken forward
- `app/api/places/details/route.ts` — sessionToken forward
- `app/api/cron/storm-pulse/route.ts` — doc accuracy + honest telemetry
- `app/(internal)/page.tsx` — Tier B status + telemetry + banner + badge fix
- `app/dashboard/estimate/page.tsx` — pipeline parity (last session)
- `lib/sources/lidar-source.ts` — LIDAR_FETCH_TIMEOUT_MS
- `types/estimate.ts` — `SolarSummary.detectedArrays`
- `.env.example` — new flags documented
- `IMPLEMENTATION_NOTES.md` — this file

---

## How to verify on Oak Park Rd, Orlando FL 32819

1. Tier C baseline (no env vars): `/internal` → run estimate. Expect
   `pipeline_source_picked: tier-c-solar`, ~64 LF total flashing.
2. Tier B on: `ENABLE_TIER_B_REFINEMENT=1`. Expect a `tier_b_attempted`
   log immediately after pipeline lands, then one of
   `tier_b_succeeded|skipped|failed` ~10s later. On success, total
   flashing should rise to ~104 LF (adds wall-step + cricket) and the
   "Multi-view" badge should appear on the map.
3. Low-confidence path: temporarily clip `roofData.confidence` to <0.5
   (or run an address with poor Solar coverage) — the amber banner
   should appear above the map.
4. DETECTED_ARRAYS: set `SOLAR_DETECTED_ARRAYS=1`. The Solar route's
   response should now include `detectedArrays` (or `null` when no
   detection); pipeline + estimate unchanged.
5. Weather: pull `/api/weather?lat=28.5384&lng=-81.3792`. `tempF` /
   `windMph` should match Google's native imperial output (no off-by-one
   from the old conversion math).
6. Places session token: from the address picker, generate a UUID per
   open and forward `&sessionToken=<uuid>` on every autocomplete +
   details call. Compare bills before/after over a week.

---

## Rollback

All changes are env-gated or strictly additive:

- Unset `SOLAR_DETECTED_ARRAYS` → Solar route reverts to original URL.
- Unset `LIDAR_FETCH_TIMEOUT_MS` → 30s default restored.
- Tier B badge fix: harmless even without Tier B running (refinements
  array stays empty).
- Low-confidence banner: gated on RoofData fields; no banner when
  RoofData is missing or already confident.
- Weather imperial: revert the route to drop `unitsSystem=IMPERIAL`
  and restore client-side conversion if Google's imperial output ever
  drifts (it currently matches NWS).
- Places sessionToken: omitting the param falls back to per-request
  billing (no functional regression).

If something breaks in prod, revert the relevant route file — no
database / cache migrations were introduced.

---

## Deferred follow-ups (worth tracking)

1. **Tier B persistence (Phase 2)**: cache refined RoofData server-side
   keyed by `(round5(lat,lng), source)` so `/quote` and reload don't
   re-pay $0.03-0.05 per inspection. Cleanest integration point is
   extending the existing `roof-pipeline` cache in `lib/cache.ts`.
2. **Tier B on vision-only addresses (Phase 1.2 Option 2a)**: relax
   `verifyEligible` in `components/Roof3DViewer.tsx` to allow
   `polygonSource === "ai"` when tiles are present, so wall-step
   detection works on rural roofs that Solar 404s. Risk: paying ~$0.05
   for low-confidence facet geometry. Hold until 10–20 vision-only
   refinement attempts confirm wall-step LF is sane.
3. **Custom YOLO training (Tier A Phase 5)**: COCO-pretrained YOLOv8n
   only detects satellite dishes from the roof-objects taxonomy.
   Custom training on ~500–2000 labeled rooftop ortho images unlocks
   real chimney / skylight / dormer / vent detection from LiDAR.
4. **Places sessionToken wiring**: the route accepts the token now;
   the address picker UI component needs to generate one per "open"
   and forward it on every autocomplete + the final details call.
