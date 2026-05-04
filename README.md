# Voxaris Pitch

**Estimate to deal in five minutes.** The closing tool for roofing teams.

Voxaris Pitch turns an address into a signed proposal. Type the property in, and Pitch auto-measures the roof, assesses the material and condition, prices a tiered quote, and outputs a branded PDF — all in under five seconds.

This is a proprietary internal product owned by Voxaris.

## Features

- **One-shot estimate** — address autocomplete → instant roof size, pitch, material, complexity
- **Tiered proposal generator** — Good / Better / Best with built-in financing math (7.99% APR, 84 months)
- **Live Xactimate-style line items** — for insurance work, full per-code breakdown
- **Storm history radar** — flags insurance-eligible properties automatically
- **Property context** — stories, year built, beds/baths, lot size, current weather
- **Pitch Vision** — material / age / damage / penetrations from satellite
- **Pitch Intelligence** — tactical sales notes per property
- **3D flyover** — cinematic property video on demand
- **Map hero** — satellite + Street View + roof segment overlays + penetration pins
- **Customer share link** — `pitch.voxaris.io/p/<id>` proposal page, white-labeled
- **One-click export** — PDF · Email · Copy summary · Share link
- **Power-user shortcuts** — ⌘S save · ⌘P PDF · ⌘E email · ⌘N new · ⌘K focus address

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 · Vercel

## Run locally

```bash
cp .env.local.example .env.local   # fill in keys
npm install
npm run dev
# open http://localhost:3000
```

## Environment variables

| Var | Purpose |
| --- | --- |
| `NEXT_PUBLIC_GOOGLE_MAPS_KEY` | Browser map tiles, autocomplete, Street View |
| `GOOGLE_SERVER_KEY` | Server-side property data |
| `GCP_SERVICE_ACCOUNT_KEY` | Storm history (base64-encoded JSON) |
| `ANTHROPIC_API_KEY` | Vision panel |
| `GEMINI_API_KEY` | Sales intelligence panel |
| `REPLICATE_API_TOKEN` | Roof outline refinement |
| `ATTOM_API_KEY` | Property records |

The app degrades gracefully when keys are missing — the panels that require them surface a quiet "unavailable" state without breaking the rest of the flow.

## White-label

Edit `lib/branding.ts` or set per-deployment env overrides:

```
PITCH_COMPANY_NAME=Acme Roofing
PITCH_PHONE=(555) 123-4567
PITCH_EMAIL=estimates@acmeroofing.com
PITCH_PRIMARY_COLOR=#0a0d12
PITCH_ACCENT_COLOR=#67dcff
PITCH_SHOW_XACTIMATE=true
```

`materialPriceOverrides` lets you tune $/sq pricing per market without touching code.

## Routes

- `/` — Main estimator
- `/p/[id]` — Customer-facing proposal (read-only, share via link)
- `/history` — Saved estimates
- `/admin` — Pipeline overview · filter by ZIP / staff / date

## Pricing engine

Two engines in `lib/pricing.ts`:

1. **Headline pricing** (`computeBase` / `computeTotal`) — material × pitch × multipliers + add-ons. Powers the big number on the hero card.
2. **Itemized engine** (`buildDetailedEstimate`) — 13+ line items with quantities, waste factors, steep-pitch surcharges, complexity adjustments, O&P. Powers the line-item panel and the insurance-claim PDF. All pricing pulled from `BRAND_CONFIG` so contractors can tune material costs without code changes.

## Phase 2 backlog

- Cross-invocation cache (Vercel KV / Upstash) for property + measurement results
- Persistent storage (Supabase) — replace localStorage in `lib/storage.ts`
- Multi-tenant workspaces + RLS
- Real auth (Clerk / NextAuth) replacing the staff name field
- E-signature on the customer proposal page
- On-site deposit intake (Stripe)
- CRM webhook for outbound estimate push
