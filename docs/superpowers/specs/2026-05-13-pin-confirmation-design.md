# Pin Confirmation Step — Design Spec

**Date:** 2026-05-13
**Status:** Approved (design), awaiting implementation
**Repo:** roofai-internal (Voxaris Pitch)

## Context

The estimator flow currently runs the full pipeline (Solar API → SAM3 → Roboflow → Claude vision → reconciliation → multiview verify) the moment an address is selected from Places autocomplete. When the geocoded pin lands on the wrong building — a common failure on rural setback parcels, dense subdivisions, or addresses where Google's pin snaps to the driveway/road rather than the rooftop — every downstream call wastes compute on the wrong house. The estimator already has a post-hoc "wrong building" button as a recovery path, but by then the bad estimate has already been generated and the rep has to redo the run.

Moving wrong-building correction *upstream* (before any expensive call) eliminates the failure mode at its source and improves data quality across the entire pipeline.

## Goals

1. Catch wrong-building geocodes **before** the estimate pipeline runs.
2. Let the user (rep or customer) confirm the correct building with one tap, or correct it by dragging the pin.
3. Auto-correct the pin when Claude vision can identify the primary residence with high confidence — most users won't have to do anything.
4. Keep the existing "wrong building" button as a recovery path for cases that slip through.
5. Work on mobile touch interaction as a first-class concern (the public estimator's primary entry point).

## Non-Goals

- Reworking the estimator pipeline itself (that's the separate three-tier rebuild starting after this).
- Manual polygon drawing (already exists elsewhere; this is just pin placement).
- Street View confirmation (out of scope — the satellite tile is the source of truth for everything downstream).
- Geocoding alternatives — we stay on Google Places.

## User Flow

```
User types address
  → Google Places autocomplete returns lat/lng
  → NEW: Confirm Home screen renders
      • Satellite tile centered on lat/lng @ zoom 20
      • Draggable pin overlaid at center
      • Smart auto-correction running in background
      • User confirms (or drags + confirms)
  → confirmedLatLng flows into existing estimate pipeline (unchanged downstream)
```

## UI / Copy

**Title:** "Is this your roof?"

**Body / hint:**
- Default state: *"Drag the pin if we're on the wrong building."*
- After smart auto-correct fires: *"We think this is the right one — drag the pin if we missed."* (one-time toast that fades after 4s; underlying hint stays as default)

**Primary button:** "Yep, that's it"

**Secondary action:** "← Back" (returns to address entry, no state persisted)

**Tone rules:**
- Casual, conversational. No surveillance language ("we're tracking your home," "we've located your residence").
- Singular focus on the user's house. The pin and the question are about confirming, not locating.
- No model/vendor mentions in user-facing copy (no "Claude found your home" or "Google says…").

## Architecture

### New component

`components/ConfirmHomePin.tsx`

Renders a full-width interactive Google Maps JS instance, a single draggable `google.maps.Marker`, the title/hint copy, and the confirm/back actions. Props:

```ts
interface ConfirmHomePinProps {
  address: string;
  geocodedLatLng: { lat: number; lng: number };
  onConfirm: (confirmedLatLng: { lat: number; lng: number }) => void;
  onCancel: () => void;
}
```

### State integration

In `app/(internal)/page.tsx` (the estimator) add a new flow phase between address-selected and estimate-running:

```
phase: "idle" | "confirming-pin" | "estimating" | "done" | "error"
```

When Places autocomplete fires `onPlaceChanged`, set `phase = "confirming-pin"` and stash the geocoded lat/lng. The `ConfirmHomePin` component renders. On confirm, set `phase = "estimating"` with the *confirmed* lat/lng as the canonical input to every downstream call.

### Smart pin (background auto-correction)

When the confirm screen mounts, fire `findPrimaryResidence` from `lib/anthropic.ts:361` in parallel. Behaviour:

- If it returns **before user confirms** with `confidence > 0.85`: smoothly animate the marker from geocoded → detected residence center (~600ms ease-out), then show the one-time toast: *"We think this is the right one — drag the pin if we missed."*
- If it returns with `0.5 < confidence ≤ 0.85`: log to telemetry only; don't move the pin (avoid jiggling on uncertain detections).
- If it returns **after user confirms**: ignore the result (user's pick wins).
- If it errors or `ANTHROPIC_API_KEY` is missing: silent — flow proceeds with geocoded lat/lng as the pin position. No degradation visible to user.

Latency note: `findPrimaryResidence` typically returns in 2–5s. Most users will spend at least 1–2s orienting on the screen before tapping confirm; the smart-correct should usually win that race.

Cost: ~$0.01–0.02 per estimate (one Claude vision call). Already being paid for in some pipelines post-hoc — this moves *when* it runs, not *whether*.

### Confirmed lat/lng = canonical

Once confirmed, the geocoded original is discarded. Every downstream call (`/api/solar`, `/api/sam3-roof`, `/api/roboflow`, `/api/vision`, `/api/verify-polygon-multiview`, reconciler proximity checks, telemetry events) receives the *confirmed* lat/lng. The `referenceLat`/`referenceLng` plumbing in `lib/reconcile-roof-polygon.ts` already supports decoupled reference points — we use the confirmed point for both.

## Mobile

The public estimator's primary entry point is mobile. Mobile work is a first-class requirement, not a follow-up.

### Touch interaction

- `google.maps.Marker` supports touch drag natively, but the default ~32×32 hit target is too small for fat fingers. Add a transparent 56×56 hit overlay around the marker that proxies pointer events to the marker.
- Disable map double-tap-to-zoom while the marker is being dragged (otherwise users accidentally zoom mid-drag).
- Pin drag must not trigger page scroll. Use `touch-action: none` on the marker's hit overlay (not the whole map — the map container keeps default touch-action so users can still pinch-zoom and pan).
- Map pan/zoom remains enabled so a user can zoom out if their house is off-screen after a bad geocode. Marker drag-end does NOT recenter the map.
- Marker stays visible at all zoom levels (no clustering, no fade).

### Layout

- On mobile, the map fills the viewport minus a fixed bottom bar (~88px) holding the title, hint, and primary button. This keeps the confirm action thumb-reachable.
- On desktop, the map sits in a centered modal at ~640×640 with the controls below.
- Use `safe-area-inset-bottom` for the bottom bar on iOS notch devices.

### Performance

- Lazy-load the Google Maps JS API only when the user reaches `confirming-pin` (it's likely already loaded for Places autocomplete, but defensively check).
- Lock map type to `satellite` (the only mode that matters for confirmation).
- Disable street view, fullscreen, and rotate controls (UI noise on mobile, distracts from the one task).

## Edge Cases

| Scenario | Behaviour |
|---|---|
| User drags pin into a road or empty lot | Allow confirm; downstream cascade handles via existing wrong-building checks (Solar 404, SAM3 IoU floor, reconciler proximity guard) |
| Stale satellite imagery (new construction, demolition) | Show the same tile the estimator will use (route through `lib/satellite-tile.ts` policy). What user sees = what AI sees. |
| `findPrimaryResidence` returns null (no API key, or no residence found) | Pin stays at geocoded position; toast does not appear |
| User hits Back | Return to address entry. No state persisted; no `findPrimaryResidence` cancellation needed (cheap, in-flight call completes silently) |
| Smart auto-correct moves pin >50m from geocode | Still show toast; user can drag back if mistaken. We trust Claude's high-confidence pick at any distance. |
| Address has no satellite tile (extreme rural, ocean, etc.) | Show "We couldn't load satellite imagery for this address" + skip confirmation (proceed with geocoded lat/lng). Don't block the estimate. |
| Mobile rotation mid-confirm | Map re-fits to new container size; pin position preserved in lat/lng space |

## Fallback: Keep "wrong building" Button

The existing post-estimate "wrong building" button stays. Pre-confirmation catches 95%+ of bad pins; the button handles:
- User confirmed but realised mid-estimate the imagery is stale
- Smart auto-correct moved the pin to a wrong-but-plausible building (low probability, but possible)
- Pin was correct but Solar/SAM3 still landed on a neighbour (the reconciler's existing wrong-building checks fire)

## Telemetry

Add events to whatever logging is already used by the estimator:

| Event | Payload |
|---|---|
| `pin_confirm_shown` | `address`, `geocodedLatLng` |
| `pin_smart_corrected` | `geocodedLatLng`, `detectedLatLng`, `confidence`, `distanceM` |
| `pin_user_dragged` | `from`, `to`, `distanceM` |
| `pin_confirmed` | `finalLatLng`, `wasSmartCorrected`, `wasUserDragged`, `timeOnScreenMs` |
| `pin_back` | (no payload) |
| `pin_fallback_button_used` | how often the post-estimate button still fires after pre-confirmation; this is the key signal for whether the upstream fix is working |

The `pin_fallback_button_used` rate is the success metric. Target: <2% of estimates after rollout.

## Out of Scope (Explicitly)

- Address-entry redesign (autocomplete behaviour stays the same)
- Bypassing the confirmation step for "trusted" addresses (no whitelist logic)
- Saving past confirmed pins for returning users (no auth context here)
- Multi-building confirmation (commercial / multi-unit) — public estimator is residential-only

## Open Questions / Decisions Pending

None blocking. Implementation can begin after spec approval.

## Implementation Order

1. `ConfirmHomePin.tsx` component — pure presentation + interactivity
2. State machine update in `app/(internal)/page.tsx`
3. `findPrimaryResidence` background call wiring
4. Telemetry events
5. Mobile polish pass (touch target overlay, safe-area, no-scroll lock)
6. Manual QA on iOS Safari + Android Chrome + desktop Chrome/Firefox
7. (Stretch) E2E playwright test for the happy path

## Acceptance Criteria

- Address entry → confirmation screen → estimate runs only after confirm.
- Smart auto-correct moves pin within 3s on addresses where Claude can identify the residence with high confidence; pin stays put otherwise.
- Confirm button hit target ≥ 44pt on mobile, ≥ 36px on desktop.
- Pin drag works on iOS Safari, Android Chrome, desktop Chrome, desktop Firefox.
- "Wrong building" fallback button still exists and functions after estimate completes.
- Telemetry events fire and are queryable.
- Estimate generation receives the confirmed lat/lng (not the original geocode) on every downstream call.
