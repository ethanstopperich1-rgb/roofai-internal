# RoofAI Internal

Fast internal roofing estimator for sales reps and office staff. Type an address → in 5 seconds you get **AI-measured roof geometry** (Google Solar API), an **AI roof assessment** (Claude vision: material, condition, complexity, damage signals), a live editable estimate, and a **proposal PDF** ready to hand to the customer.

For insurance / restoration jobs, flip the **Insurance Claim** toggle — the PDF gains a full **Xactimate-style line-item breakdown** (RFG SHGLR, RFG ARCH, RFG IWS, etc.) suitable for adjuster review.

## Stack

- Next.js 15 (App Router) + React 19 + TypeScript
- Tailwind CSS v4
- Google Maps JS + Solar API + Static Maps + Street View
- **Claude (Anthropic) vision** — `/api/vision` roof inspector
- **Google Gemini** — `/api/insights` sales tactics
- jsPDF (proposal export)
- localStorage (MVP) — Supabase / Vercel Postgres in Phase 2

## Run locally

```bash
cp .env.local.example .env.local
# fill in keys (see Required environment variables below)
npm install
npm run dev
# open http://localhost:3000
```

## Required environment variables

| Var | Purpose |
| --- | --- |
| `NEXT_PUBLIC_GOOGLE_MAPS_KEY` | Maps JS, Places, Geocoding, Street View on the client |
| `GOOGLE_SERVER_KEY` *(optional)* | Server-only Google key for Solar API + Static Maps. Falls back to the public key. |
| `ANTHROPIC_API_KEY` | Claude vision (`/api/vision`) — material/condition/damage |
| `GEMINI_API_KEY` | Gemini sales notes (`/api/insights`) |

The app degrades gracefully when keys are missing:
- No `ANTHROPIC_API_KEY` → vision returns a low-confidence mock; the UI label says "set ANTHROPIC_API_KEY"
- No Google key → autocomplete and map are disabled, but address-typed text still works for a manual estimate

### Branding overrides (optional)

Set these to white-label per client:

```
ROOFAI_COMPANY_NAME=Acme Roofing
ROOFAI_PHONE=(555) 123-4567
ROOFAI_EMAIL=estimates@acmeroofing.com
ROOFAI_PRIMARY_COLOR=#0a0d12
ROOFAI_ACCENT_COLOR=#38bdf8
ROOFAI_SHOW_XACTIMATE=true   # restoration roofers — show line items by default
```

Or edit `lib/branding.ts` directly (also where you tune `materialPriceOverrides` per market).

### Google APIs to enable

In Google Cloud Console for the same project:

- **Maps JavaScript API**
- **Places API (New)**
- **Geocoding API**
- **Maps Static API** (used by `/api/vision` to feed Claude)
- **Solar API** (used by `/api/solar`)
- (Phase 2) Aerial View API

Restrict the **public** key by HTTP referrer (your domain), and the **server** key by IP / unrestricted.

## Routes

- `/` — Quick Estimate (the main tool)
- `/history` — Last 200 saved estimates
- `/admin` — Filter by ZIP / staff / date

## API routes

- `GET /api/solar?lat&lng` — Solar API summary: sqft, pitch, segment count, segment polygons (lat/lng), imagery quality + date, building footprint. Cached in-memory by lat/lng.
- `GET /api/vision?lat&lng` — Claude reads a satellite tile and returns material, age estimate, complexity, visible features, visible damage, and a one-sentence sales note. Cached in-memory by lat/lng.
- `POST /api/insights` — Gemini three-bullet sales tactics for the current estimate.
- `GET /api/estimates` / `POST /api/estimates` — stub for Phase 2 Supabase wiring.

## Pricing engine

Two engines, both in `lib/pricing.ts`:

1. **Flat headline pricing** — `computeBase()` / `computeTotal()` powers the big number on Results. `material_rate × pitch_factor × sqft + addons`. Tweak `MATERIAL_RATES` for region adjustments.
2. **Xactimate-style line items** — `buildDetailedEstimate()` returns 13+ trade codes (RFG SHGLR, RFG IWS, RFG ARCH, etc.) with quantities, unit costs, waste factors, steep-pitch surcharges, complexity adjustments, O&P. Powers the line-item panel and the insurance-claim PDF. Pricing comes from `lib/branding.ts` so a contractor can tune material costs without code changes.

## What's new in this branch (`feat/vision-and-line-items`)

- 🤖 **Claude vision** roof assessment panel (material, age, complexity, damage, sales note)
- 🧮 **Xactimate-style line-items engine** — full breakdown with codes, quantities, O&P
- 🛠️ **Service-type selector** in Assumptions — new / reroof / layover / repair (priced differently)
- 🎯 **Complexity selector** — simple / moderate / complex (auto-set by vision when confident)
- 🛡️ **Insurance claim toggle** — flips PDF to full Xactimate detail
- 🗺️ **Roof segment polygons** drawn on the satellite map (Solar API bounding boxes)
- 🏷️ **Imagery quality / date / segment count** badges on the map
- 🏢 **`BRAND_CONFIG`** in `lib/branding.ts` for one-file white-labeling per client
- 💾 **In-memory cache** for Solar + Vision results (TODO: swap for Vercel KV in Phase 2)
- 📄 **PDF v2** — header now uses BRAND_CONFIG colors/contact; insurance-claim PDFs include the full line-item table

## Phase 2 backlog

- Replace in-memory `lib/cache.ts` with Vercel KV / Upstash for cross-invocation cache
- Wire Supabase (estimates table) — replace `lib/storage.ts` with `POST /api/estimates`
- Aerial View 3D embed
- Real auth (Clerk / NextAuth) replacing the staff name field
