# RoofAI Internal

Fast internal roofing estimator for sales reps and office staff. Generates a
professional estimate from an address in under 5 seconds, with editable
assumptions, add-ons, PDF/email/copy outputs, and saved history.

## Stack

- Next.js 15 (App Router) + React 19 + TypeScript
- Tailwind CSS v4
- Google Maps JavaScript API (satellite + Street View)
- Google Places (New) + Geocoding (autocomplete)
- Google Gemini (`/api/insights` AI sales notes)
- jsPDF (proposal export)
- localStorage (MVP) — Supabase / Vercel Postgres in Phase 2

## Run locally

```bash
cp .env.local.example .env.local   # if .env.local doesn't already exist
npm install
npm run dev
# open http://localhost:3000
```

## Required environment variables

| Var | Purpose |
| --- | --- |
| `NEXT_PUBLIC_GOOGLE_MAPS_KEY` | Google Maps JS, Places, Geocoding, Street View |
| `GEMINI_API_KEY` | Gemini insights (`/api/insights`) |
| `DATABASE_URL` | (Phase 2) Postgres |

GCP project: `roofai-internal-860847`. APIs already enabled and keys auto-provisioned in `.env.local`.

### Google APIs to enable

In Google Cloud Console for the same key:

- **Places API (New)**
- **Geocoding API**
- **Maps JavaScript API**
- (Phase 2) **Street View Static API**, **Aerial View API**

Restrict the key to your dev/prod domains.

## Routes

- `/` — Quick Estimate (main tool)
- `/history` — Last 200 saved estimates
- `/admin` — Filter by ZIP / staff / date

## Pricing engine

`lib/pricing.ts` — material rate × pitch factor × multipliers + add-ons.
Tweak the rate tables directly to match your real margins.

## Phase 2 backlog

- Wire Supabase (estimates table) — replace `lib/storage.ts` calls in
  `OutputButtons.tsx` with a `POST /api/estimates`.
- Google Street View thumbnail next to map.
- Aerial View 3D embed.
- Gemini AI notes endpoint at `/api/insights`.
- Real auth (Clerk / NextAuth) replacing the staff name field.
