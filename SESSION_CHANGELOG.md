# What's New on Voxaris Pitch

*A summary of everything shipped in this work session.*

---

## The headline: a new public page at [pitch.voxaris.io/storms](https://pitch.voxaris.io/storms)

A complete new product surface — **Storm Intelligence**. Detects hail events in a service area and shows what a roofing operator would receive: a ranked canvass list, a pre-filled postcard design, and a per-event landing page. Built around a real recent Orlando event (Aug 5, 2025 · 1.31" peak hail).

**Why it matters**: this is the upsell product to lead with in the RSS pitch. See [STORMS_PITCH.md](./STORMS_PITCH.md) for the business case.

---

## The rest of what changed

### Customer-facing site cleanup

| What | Why |
|---|---|
| **Honest copy throughout** — removed unverifiable claims ("BBB-vetted," "47-min reply," "30-second estimate," "~10% accuracy") | We don't have a contractor network under contract yet; those promises weren't ours to make |
| **Replaced with platform-only claims** — "Satellite imagery," "Multi-source AI segmentation," "NOAA radar storm history," "$0 to homeowner" | All independently verifiable. Switches back to the contractor-network claims automatically when `NEXT_PUBLIC_CONTRACTOR_NETWORK_LIVE=true` is set per-deploy |
| **New `/methodology` page** | Step-by-step honest explanation of how an estimate gets made. Linked from the FAQ and footer. The "show your work" page for everything else |
| **Pitch transparency on the estimate page** | When Solar API can't measure pitch, we now show "6/12 — *assumed*" with an amber label instead of pretending we measured it |
| **Commercial-property graceful branch** | Properties measured >15,000 sqft no longer silently fail through every tier — they get routed to a "Talk to a Voxaris specialist" message with the measured footprint |
| **Stats strip + FAQ rewrites** | No more "30s" claims. FAQ softened around conditional contractor outcomes ("when financing is available," not "all our partners offer 0% APR") |

### Visible bug fixes

| Fix | What was broken |
|---|---|
| **Root domain `/` redirect** | `pitch.voxaris.io/` was returning a 503 "Service unavailable" error to anyone visiting without staff login. A buyer pasting the bare URL pre-meeting saw an error page. Now redirects to `/quote` |
| **Legal pages cleaned up** | `/privacy` and `/terms` were showing the internal staff navigation ("BETA · ESTIMATOR · HISTORY · ADMIN") to homeowners. Fixed |
| **Address autocomplete house-number guard** | Customers typing "123 Main St" and submitting without picking from autocomplete could end up at "Main Ln" — system silently used Google's first guess. Now refuses to proceed when no specific house number is found, surfaces a clear "we couldn't find that exact address" message |
| **TCPA consent error microcopy** | Submit button was greying out silently when the consent box was unchecked. Customers got stuck not knowing why. Now surfaces an accessible "Check the consent box above to continue" message |
| **`/storms` infinite spinner** | Page was waiting on slow APIs server-side, never painting. Refactored to render shell instantly with client-side data hydration |
| **`/storms` blank event card** | Live data fetch had an internal HTTP roundtrip that was silently failing in production. Refactored to call the underlying data library directly — no roundtrip |
| **`/storms` misleading 15,097 building count** | OSM counts every building (Walmarts, parking decks, churches). Replaced with a residential-only number (4,847 single-family homes) + a top-tier high-priority count (287) |

### Security + compliance

| What | Why |
|---|---|
| **Cryptographic random IDs on proposals + photos** | Old IDs used `Date.now()` + 5 random characters — anyone who saved two proposals could enumerate the keyspace and read other customers' PII. Switched to UUIDv4 |
| **`/p/<id>` proposal pages now `noindex`** | Even with random IDs, we don't want Google indexing customer proposals into the public web. Added robots metadata + X-Robots-Tag header |
| **SMS opt-out (STOP) persistence to Supabase** | Used to rely on Twilio's account-level STOP handler. Fragile when a follow-up SMS goes through a different code path. Now every STOP is persisted in Supabase; every outbound SMS checks before sending |
| **TCPA-grade consent receipts** | Existing `consents` table now properly populated with IP + user-agent on every form submit |

### Infrastructure

| What | Why |
|---|---|
| **Sentry installed + configured** | Runtime error capture for server + browser. Quiet when DSN unset; production deploys need `NEXT_PUBLIC_SENTRY_DSN` to activate |
| **`/api/healthz` health-check route** | Per-dependency probe (Supabase, Roboflow, Google, Anthropic, Upstash, optional Twilio/Sentry/Replicate/Mapbox). Returns 200 when required deps are configured, 503 with per-component breakdown otherwise |
| **CI on every PR + push to main** | New `.github/workflows/ci.yml` runs typecheck, lint, and `next build` in parallel before merge |
| **SQL migrations checked into the repo** | New `migrations/` directory with the schema, RLS policies, and seed in versioned SQL files. README explains the apply order. Includes 2 new tables (`sms_opt_outs`, `storm_events`/`canvass_targets`) |
| **SAM3 pre-warm cron** | Vercel cron pings the Roboflow workflow every 5 minutes to keep the serverless container warm. Eliminates the 30-60s cold-start risk on the SAM3 estimator |
| **Storm-pulse daily cron** | New `/api/cron/storm-pulse` runs at 06:00 UTC daily. Scans MRMS for the previous 48 hours across watched FL regions (Orlando, Tampa, Lakeland), persists detected events and canvass targets to Supabase |

### Roboflow workflow improvements

| What | Why |
|---|---|
| **SAM3 prompt + confidence aligned with the workflow defaults** | The deployed Roboflow workflow defaults to confidence 0.3; our code was sending 0.2. Now configurable via env (`ROBOFLOW_SAM3_PROMPT`, `ROBOFLOW_SAM3_CONFIDENCE`) |
| **Workflow URL is env-configurable** | `ROBOFLOW_SAM3_WORKFLOW_URL` lets each deploy point at its own workflow without code changes |
| **Surface workflow failures in the 404 response** | Previously a Roboflow workflow failure logged to Vercel console only. Now the route returns the failure reason in the JSON so it's visible in DevTools |

### Pricing & calculation

| What | Why |
|---|---|
| **Eave-overhang factor (1.06×) now applied consistently** | When SAM3's polygon is substituted with a GIS wall footprint (MS Buildings, OSM, or SAM3's reconciler), the page now correctly applies the 1.06 overhang multiplier. Previously the rep page silently ran ~6% low on every TN address and every OSM-only address |
| **Quote page polygon edits preserve the overhang factor** | When a customer nudged a polygon vertex, the sqft would drop ~6% with no explanation. Fixed |
| **MATERIAL_RATES drift documented** | Two pricing tables existed (`MATERIAL_RATES` in pricing.ts, `DEFAULT_MATERIAL_PRICES` in branding.ts). Added cross-referencing comments in both flagging the post-pilot consolidation work |

---

## What you need to do to fully activate everything

| If you want… | Set in Vercel |
|---|---|
| Sentry error tracking | `NEXT_PUBLIC_SENTRY_DSN` |
| Storm Intelligence daily cron writes | Run migration `0005_canvass_targets.sql` on Supabase + ensure `SUPABASE_SERVICE_ROLE_KEY` is set |
| TCPA STOP persistence | Run migration `0004_sms_opt_outs.sql` |
| The "live contractor network" claims on `/quote` | `NEXT_PUBLIC_CONTRACTOR_NETWORK_LIVE=true` (only after you have real contractors signed) |
| Override the Storm Intelligence demo region | `STORMS_DEMO_REGION_LAT`, `STORMS_DEMO_REGION_LNG` (default: Orlando) |
| Override the Roboflow workflow URL | `ROBOFLOW_SAM3_WORKFLOW_URL` |

The site works without any of these — it just degrades gracefully.

---

## How to verify everything is working

| Page | Should show |
|---|---|
| [pitch.voxaris.io](https://pitch.voxaris.io/) | Redirects to `/quote` (no more 503) |
| [pitch.voxaris.io/quote](https://pitch.voxaris.io/quote) | Customer estimate flow, polished copy, TCPA microcopy works |
| [pitch.voxaris.io/storms](https://pitch.voxaris.io/storms) | Storm Intelligence landing — Aug 5 2025 Orlando event + outputs |
| [pitch.voxaris.io/privacy](https://pitch.voxaris.io/privacy) | Clean public legal page (no internal nav) |
| [pitch.voxaris.io/terms](https://pitch.voxaris.io/terms) | Clean public legal page |
| [pitch.voxaris.io/methodology](https://pitch.voxaris.io/methodology) | Honest "how we measure" doc |
| [pitch.voxaris.io/api/healthz](https://pitch.voxaris.io/api/healthz) | JSON with per-dependency status |

---

## Files added or significantly changed

```
app/storms/page.tsx                        NEW — Storm Intelligence landing
components/storms/LiveStormCard.tsx        NEW — the event + output display
app/api/storms/recent-significant/         NEW — most-recent-hail-event API
app/api/storms/canvass-area/               NEW — buildings-in-zone count API
app/api/cron/storm-pulse/                  NEW — daily storm scan + persist
app/api/cron/warm-sam3/                    NEW — SAM3 cold-start prevention
app/api/healthz/                           NEW — per-dep health probe
app/(legal)/privacy/                       NEW — public privacy policy
app/(legal)/terms/                         NEW — public terms + SMS program
app/(legal)/methodology/                   NEW — honest measurement doc
app/p/[id]/layout.tsx                      NEW — noindex on proposals
lib/hail-mrms.ts                           NEW — shared storm-data scanner
migrations/0001_initial_schema.sql         NEW — reconstructed schema
migrations/0002_rls_policies.sql           NEW — tenant isolation policies
migrations/0003_seed.sql                   NEW — default office seed
migrations/0004_sms_opt_outs.sql           NEW — TCPA STOP persistence
migrations/0005_canvass_targets.sql        NEW — storm-pulse output tables
migrations/README.md                       NEW — migration ordering rules
instrumentation.ts                         NEW — Sentry server init
instrumentation-client.ts                  NEW — Sentry browser init
.github/workflows/ci.yml                   NEW — PR check workflow
```

Plus updates to `middleware.ts`, `next.config.ts`, `vercel.json`, `app/quote/page.tsx`, the components in `components/quote/`, `lib/twilio.ts`, `lib/pricing.ts`, `lib/branding.ts`, and the type definitions.

---

That's the work. Most-visible thing is the new `/storms` page — open it once and see if the demo feels pitchable.
