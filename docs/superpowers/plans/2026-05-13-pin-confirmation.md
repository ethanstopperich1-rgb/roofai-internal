# Pin Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert a "confirm your roof" step between address autocomplete and the estimate pipeline so reps catch wrong-building geocodes before the estimator wastes compute on the wrong house.

**Architecture:** A new `ConfirmHomePin` React component renders a Google Maps satellite tile with a single draggable marker. While the user orients, a background call to `findPrimaryResidence` (Claude vision) attempts to auto-correct the pin. Once the user confirms, the final lat/lng feeds into the existing `runEstimate` pipeline unchanged. The post-estimate "wrong building" button stays as a fallback.

**Tech Stack:** Next.js 16 / React 19 / TypeScript / Tailwind v4 / Google Maps JS API (already loaded via `lib/google.ts`) / Claude vision via existing `lib/anthropic.ts:findPrimaryResidence`.

**Spec:** [docs/superpowers/specs/2026-05-13-pin-confirmation-design.md](../specs/2026-05-13-pin-confirmation-design.md)

**No test framework in repo:** This project doesn't have vitest/jest/playwright wired up. Verification per task uses `npm run typecheck`, `npm run lint`, and the harness's `preview_*` browser tools for manual QA.

---

## Task 1: API endpoint for primary-residence detection

The `findPrimaryResidence` function exists in `lib/anthropic.ts` but is only callable server-side. The new `ConfirmHomePin` component runs client-side, so we need a thin API route to expose it.

**Files:**
- Create: `app/api/find-residence/route.ts`

- [ ] **Step 1: Create the API route**

```ts
// app/api/find-residence/route.ts
import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { findPrimaryResidence } from "@/lib/anthropic";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/find-residence
 *
 * Wraps `findPrimaryResidence` (Claude vision wide-tile pass) for client-side
 * use by the pin-confirmation step. Given a geocoded address point, returns
 * Claude's best guess of where the actual residence sits on that lot, so the
 * UI can move the pin off a barn / outbuilding / wrong neighbour before the
 * user confirms.
 *
 * Returns null fields when Claude can't identify a residence, when
 * ANTHROPIC_API_KEY is unset, or when the upstream call errors. Callers
 * fall through to the geocoded point.
 */

interface RequestBody {
  lat?: number;
  lng?: number;
  address?: string;
}

export async function POST(req: Request) {
  const __rl = await rateLimit(req, "expensive");
  if (__rl) return __rl;

  const googleKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!googleKey) {
    return NextResponse.json(
      { lat: null, lng: null, confidence: 0, reasoning: "no_google_key" },
      { status: 200 },
    );
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }

  try {
    const result = await findPrimaryResidence({
      lat,
      lng,
      address: typeof body.address === "string" ? body.address : undefined,
      googleApiKey: googleKey,
    });
    if (!result) {
      return NextResponse.json({
        lat: null,
        lng: null,
        confidence: 0,
        reasoning: "no_residence_found",
      });
    }
    return NextResponse.json({
      lat: result.lat,
      lng: result.lng,
      confidence: result.confidence,
      reasoning: result.reasoning,
    });
  } catch (err) {
    console.error("[find-residence] error:", err);
    return NextResponse.json(
      { lat: null, lng: null, confidence: 0, reasoning: "error" },
      { status: 200 },
    );
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no new errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS, no new warnings.

- [ ] **Step 4: Smoke test the route**

Start the dev server (`npm run dev` in another terminal) and test against a known address with a barn/outbuilding nearby. Use a rural address from the team's test set if available; otherwise pick any residential address.

```bash
curl -X POST http://localhost:3000/api/find-residence \
  -H "Content-Type: application/json" \
  -d '{"lat":36.1627,"lng":-86.7816,"address":"Nashville TN"}'
```

Expected: JSON response with `lat`, `lng`, `confidence`, `reasoning` fields. The exact values depend on Claude — what matters is the shape is right and there are no 500 errors. May take 2-5s.

- [ ] **Step 5: Commit**

```bash
git add app/api/find-residence/route.ts
git commit -m "feat(api): expose findPrimaryResidence via /api/find-residence

Thin client-callable wrapper around lib/anthropic.ts:findPrimaryResidence.
Needed by the upcoming pin-confirmation step so the UI can auto-correct
the marker off outbuildings before the user confirms.

Returns 200 with null lat/lng when Claude can't identify a residence,
when the API key is missing, or when upstream errors — callers fall
through to the geocoded point."
```

---

## Task 2: ConfirmHomePin component (presentation + interactivity, no smart-pin yet)

The component renders the satellite map + draggable marker + copy + actions. This task gets it to the "you can drag the pin and confirm" state. Smart auto-correction (Task 4) and mobile polish (Task 5) come after.

**Files:**
- Create: `components/ConfirmHomePin.tsx`

- [ ] **Step 1: Create the component**

```tsx
// components/ConfirmHomePin.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadGoogle } from "@/lib/google";
import { AuroraButton } from "@/components/ui/aurora-button";

export interface ConfirmHomePinProps {
  /** Human-readable address shown above the map. */
  address: string;
  /** Geocoded lat/lng from Places. Initial marker position. */
  geocodedLatLng: { lat: number; lng: number };
  /** Fired when the user accepts the current marker position. */
  onConfirm: (confirmedLatLng: { lat: number; lng: number }) => void;
  /** Fired when the user wants to go back to address entry. */
  onCancel: () => void;
}

export default function ConfirmHomePin({
  address,
  geocodedLatLng,
  onConfirm,
  onCancel,
}: ConfirmHomePinProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const [pinLatLng, setPinLatLng] = useState(geocodedLatLng);
  const [mapReady, setMapReady] = useState(false);

  // Build the map + draggable marker on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const google = await loadGoogle();
      if (cancelled || !mapRef.current) return;

      const map = new google.maps.Map(mapRef.current, {
        center: geocodedLatLng,
        zoom: 20,
        mapTypeId: "satellite",
        disableDefaultUI: true,
        zoomControl: true,
        gestureHandling: "greedy", // allow single-finger pan on mobile
        clickableIcons: false,
        tilt: 0,
      });
      mapInstanceRef.current = map;

      const marker = new google.maps.Marker({
        position: geocodedLatLng,
        map,
        draggable: true,
        // 56×56 SVG with the visible pin centred and a transparent halo
        // for fat-finger touch targets. The transparent border captures
        // touch + click events the same as the visible pin.
        icon: {
          url:
            "data:image/svg+xml;utf8," +
            encodeURIComponent(
              `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">` +
                `<circle cx="28" cy="28" r="28" fill="rgba(56,197,238,0.001)"/>` +
                `<path d="M28 12 C22 12 17 17 17 23 C17 31 28 44 28 44 C28 44 39 31 39 23 C39 17 34 12 28 12 Z" fill="#ff3b30" stroke="#ffffff" stroke-width="2.5"/>` +
                `<circle cx="28" cy="23" r="4.5" fill="#ffffff"/>` +
                `</svg>`,
            ),
          // Anchor at the tip of the pin (pixel y=44 in a 56-tall svg).
          anchor: new google.maps.Point(28, 44),
          scaledSize: new google.maps.Size(56, 56),
        },
        crossOnDrag: false,
      });
      markerRef.current = marker;

      marker.addListener("dragend", () => {
        const pos = marker.getPosition();
        if (!pos) return;
        setPinLatLng({ lat: pos.lat(), lng: pos.lng() });
      });

      setMapReady(true);
    })();
    return () => {
      cancelled = true;
      if (markerRef.current) markerRef.current.setMap(null);
      markerRef.current = null;
      mapInstanceRef.current = null;
    };
    // geocodedLatLng deliberately omitted — we only want to initialise once;
    // subsequent changes go through programmatic marker moves (Task 4).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConfirm = useCallback(() => {
    onConfirm(pinLatLng);
  }, [onConfirm, pinLatLng]);

  return (
    <div className="flex flex-col h-full w-full bg-black/40 backdrop-blur-md">
      {/* Map fills the available space; bottom bar holds the controls */}
      <div className="flex-1 relative min-h-[320px]">
        <div ref={mapRef} className="absolute inset-0" />
        {!mapReady && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-300 text-sm">
            Loading satellite view…
          </div>
        )}
      </div>

      {/* Bottom action bar */}
      <div
        className="border-t border-white/10 bg-black/70 px-4 py-4 sm:px-6 sm:py-5"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)" }}
      >
        <div className="max-w-2xl mx-auto">
          <div className="mb-2">
            <h2 className="text-lg sm:text-xl font-medium tracking-tight text-slate-50">
              Is this your roof?
            </h2>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              {address}
            </p>
          </div>
          <p className="text-xs sm:text-sm text-slate-400 mb-4">
            Drag the pin if we're on the wrong building.
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={onCancel}
              className="text-sm text-slate-400 hover:text-slate-200 transition px-2 py-2"
            >
              ← Back
            </button>
            <div className="flex-1" />
            <AuroraButton
              onClick={handleConfirm}
              className="px-5 sm:px-6 py-2.5 font-medium text-[14px] tracking-tight"
            >
              Yep, that's it
            </AuroraButton>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/ConfirmHomePin.tsx
git commit -m "feat(components): add ConfirmHomePin scaffold

Draggable-pin confirmation surface that renders a Google satellite tile
at zoom 20 with one draggable marker. No estimator integration yet —
that comes in the next task. No smart auto-correction yet — Task 4.

Marker uses a 56-pixel SVG with a transparent halo around the visible
pin so mobile touch targets meet the standard 44pt minimum."
```

---

## Task 3: Wire ConfirmHomePin into the estimator page

Intercept the auto-submit from `AddressInput.pick()` so that instead of running the estimate immediately, the page shows `ConfirmHomePin` first. On confirm, `runEstimate` is called with the *confirmed* address. On cancel, return to address entry.

**Files:**
- Modify: `app/(internal)/page.tsx` (imports, state, `runEstimate` wrapper, render branch)

- [ ] **Step 1: Add import for ConfirmHomePin**

Locate the existing `MapView` import block in `app/(internal)/page.tsx` (around line 30) and add the new import alphabetically/adjacent:

```tsx
import ConfirmHomePin from "@/components/ConfirmHomePin";
```

- [ ] **Step 2: Add pin-confirmation state**

Find the state block in `HomePageInner` (the existing `useState` calls starting around line 135 with `addressText`/`address`). Right after the existing `address` state, add:

```tsx
  // Pin-confirmation flow. When set, the page renders <ConfirmHomePin>
  // instead of kicking off the estimate. The pending address is the
  // geocoded result from Places autocomplete; on confirm we replace its
  // lat/lng with the (possibly user-dragged or smart-corrected) point
  // and feed it into runEstimate.
  const [pendingAddress, setPendingAddress] = useState<AddressInfo | null>(null);
```

- [ ] **Step 3: Add the gate function that decides whether to confirm first**

Locate the `runEstimate` function declaration (around line 1181). Just BEFORE `const runEstimate = async (explicitAddr?: AddressInfo) => {`, insert this new function:

```tsx
  /**
   * Gate between address selection and the estimate pipeline. When the
   * incoming address has a lat/lng (= user picked from autocomplete or we
   * geocoded successfully), we route it through the pin-confirmation step
   * first. Addresses without coords (manual typing, autocomplete offline)
   * skip the confirmation — the pipeline already handles those via its
   * fallback paths.
   */
  const requestEstimate = (explicitAddr?: AddressInfo) => {
    const addr: AddressInfo =
      explicitAddr ?? address ?? { formatted: addressText.trim() };
    if (!addr.formatted?.trim()) return;
    if (addr.lat == null || addr.lng == null) {
      // No coords → no map to confirm against. Run estimate directly.
      void runEstimate(addr);
      return;
    }
    setPendingAddress(addr);
  };
```

- [ ] **Step 4: Wire AddressInput to the gate instead of runEstimate**

Locate the `<AddressInput>` usage in the JSX (around line 1628). The current binding looks like:

```tsx
        <AddressInput
          value={addressText}
          onChange={setAddressText}
          onSelect={setAddress}
          onSubmit={runEstimate}
        />
```

Change `onSubmit={runEstimate}` to `onSubmit={requestEstimate}`:

```tsx
        <AddressInput
          value={addressText}
          onChange={setAddressText}
          onSelect={setAddress}
          onSubmit={requestEstimate}
        />
```

- [ ] **Step 5: Render ConfirmHomePin when pendingAddress is set**

Render the confirmation UI as a fullscreen overlay (above everything else, including the existing UI). Find the main return statement of `HomePageInner` — at the top of the returned JSX (just inside the outer wrapper), add this conditional block before any other content:

```tsx
      {pendingAddress && pendingAddress.lat != null && pendingAddress.lng != null && (
        <div className="fixed inset-0 z-[200] bg-black/95">
          <ConfirmHomePin
            address={pendingAddress.formatted}
            geocodedLatLng={{
              lat: pendingAddress.lat,
              lng: pendingAddress.lng,
            }}
            onConfirm={(confirmed) => {
              const finalAddr: AddressInfo = {
                ...pendingAddress,
                lat: confirmed.lat,
                lng: confirmed.lng,
              };
              setPendingAddress(null);
              void runEstimate(finalAddr);
            }}
            onCancel={() => {
              setPendingAddress(null);
            }}
          />
        </div>
      )}
```

(Insert this at the top of the JSX inside `HomePageInner`'s outer wrapper. If the outer wrapper is a fragment or div, place this as the first child.)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 8: Manual smoke test via preview tools**

Start the dev server with the harness preview tool.

Run via the agent harness: `mcp__Claude_Preview__preview_start` (dev URL e.g. `http://localhost:3000/?office=nolands`).

Walk through:
1. Open the estimator URL.
2. Type a partial address into the search field.
3. Select a suggestion from the autocomplete dropdown.

Expected: The ConfirmHomePin overlay appears with a satellite tile centred on the geocoded point and a draggable red pin in the middle.

4. Click "Yep, that's it".

Expected: The overlay closes and the estimate pipeline runs (you'll see the existing loaders / panels populate).

5. Repeat steps 1-3, then click "← Back".

Expected: The overlay closes; you're returned to the address input, ready to try a different address.

Capture `mcp__Claude_Preview__preview_screenshot` of the confirmation step for the PR description.

- [ ] **Step 9: Commit**

```bash
git add app/\(internal\)/page.tsx
git commit -m "feat(estimator): route address selections through pin confirmation

Address autocomplete used to auto-submit straight into runEstimate. Now
selecting an address from the dropdown opens a fullscreen confirmation
step (ConfirmHomePin) with a draggable pin on the satellite tile. The
estimate pipeline only kicks off after the rep clicks 'Yep, that's it'.

This is the upstream fix for wrong-building geocodes — instead of
running every downstream call (Solar, SAM3, Roboflow, vision) on the
wrong building and recovering via the post-estimate 'wrong building'
button, we catch the bad pin before any expensive call.

The 'wrong building' fallback button stays as a belt-and-suspenders
recovery path for cases that slip through pre-confirmation (stale
imagery, user confirmed a wrong-but-plausible building, etc.)."
```

---

## Task 4: Smart pin auto-correction

When the confirm screen mounts, fire `/api/find-residence` in the background. If Claude returns confidence > 0.85 *before* the user confirms, animate the marker to the detected residence centre and show a one-time toast.

**Files:**
- Modify: `components/ConfirmHomePin.tsx`

- [ ] **Step 1: Add state and effect for smart auto-correction**

Open `components/ConfirmHomePin.tsx`. Just inside the component, add these state hooks below the existing `pinLatLng` / `mapReady` state:

```tsx
  // Smart auto-correction. While the user orients on the screen, ask
  // Claude vision to identify the primary residence on this parcel.
  // If confidence > 0.85 we move the pin; lower confidence is logged
  // but ignored (avoid jiggling on ambiguous detections). If the user
  // confirms before this returns, we discard the result silently.
  const [smartMoved, setSmartMoved] = useState(false);
  const userActedRef = useRef(false);
```

- [ ] **Step 2: Track user interaction so smart-pin doesn't fight the user**

Inside the existing `useEffect` that builds the map (Task 2 Step 1), after the `marker.addListener("dragend", ...)` block, add a `dragstart` listener that marks the user as having acted:

```tsx
      marker.addListener("dragstart", () => {
        userActedRef.current = true;
      });
```

Also, in `handleConfirm`, set the ref before invoking `onConfirm`:

```tsx
  const handleConfirm = useCallback(() => {
    userActedRef.current = true;
    onConfirm(pinLatLng);
  }, [onConfirm, pinLatLng]);
```

- [ ] **Step 3: Add the background smart-correction effect**

Below the map-building `useEffect`, add a new effect that runs once after `mapReady` flips true:

```tsx
  // Background residence-detection. Runs once, after the map is ready
  // (so we have a marker to move). Aborts silently if the user has
  // already dragged or confirmed by the time the response lands.
  useEffect(() => {
    if (!mapReady) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/find-residence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lat: geocodedLatLng.lat,
            lng: geocodedLatLng.lng,
            address,
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          lat: number | null;
          lng: number | null;
          confidence: number;
          reasoning?: string;
        };
        if (userActedRef.current) return;
        if (data.lat == null || data.lng == null) return;
        if (data.confidence <= 0.85) {
          console.log(
            `[pin-confirm] smart-pin low confidence (${data.confidence.toFixed(2)}); leaving pin at geocode`,
          );
          return;
        }

        // Animate marker to the detected residence centre.
        const detected = new google.maps.LatLng(data.lat, data.lng);
        const marker = markerRef.current;
        const map = mapInstanceRef.current;
        if (!marker || !map) return;
        animateMarker(marker, detected, 600);
        // Don't recenter the map — preserve spatial context. User can
        // pan if needed.
        setPinLatLng({ lat: data.lat, lng: data.lng });
        setSmartMoved(true);
      } catch {
        /* aborted or network error — silently fall through */
      }
    })();
    return () => ctrl.abort();
  }, [mapReady, geocodedLatLng.lat, geocodedLatLng.lng, address]);
```

- [ ] **Step 4: Add the animate helper at module scope**

Below the import block at the top of `components/ConfirmHomePin.tsx`, add:

```tsx
/**
 * Tween a marker's position from current → target over `durationMs`
 * using an ease-out curve. Cheaper than re-running setPosition every
 * frame at high FPS because we cap to 24fps.
 */
function animateMarker(
  marker: google.maps.Marker,
  target: google.maps.LatLng,
  durationMs: number,
): void {
  const start = marker.getPosition();
  if (!start) {
    marker.setPosition(target);
    return;
  }
  const startLat = start.lat();
  const startLng = start.lng();
  const dLat = target.lat() - startLat;
  const dLng = target.lng() - startLng;
  const t0 = performance.now();
  const tick = () => {
    const t = Math.min(1, (performance.now() - t0) / durationMs);
    // ease-out cubic
    const eased = 1 - Math.pow(1 - t, 3);
    marker.setPosition(
      new google.maps.LatLng(
        startLat + dLat * eased,
        startLng + dLng * eased,
      ),
    );
    if (t < 1) {
      setTimeout(tick, 1000 / 24);
    }
  };
  tick();
}
```

- [ ] **Step 5: Render the one-time toast**

Inside the JSX, after the map `<div ref={mapRef}>` but before the bottom action bar, add the toast:

```tsx
        {smartMoved && (
          <SmartPinToast />
        )}
```

And add the `SmartPinToast` component below the main `ConfirmHomePin` function (still in the same file):

```tsx
function SmartPinToast() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 4000);
    return () => clearTimeout(t);
  }, []);
  if (!visible) return null;
  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 max-w-[90vw]">
      <div className="rounded-full bg-cy-300/15 border border-cy-300/40 backdrop-blur-md px-4 py-2 text-sm text-cy-100 shadow-lg">
        We think this is the right one — drag the pin if we missed.
      </div>
    </div>
  );
}
```

(Note: `cy-300` etc. are the project's existing Tailwind colour tokens — verify they exist in `app/globals.css`. If they don't, substitute `cyan-300` / `cyan-100`.)

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Manual QA — happy path**

Restart the preview server if needed. Walk through with an address from your team's test set (Nashville or Orlando area) — pick one where the geocoded pin historically lands off-building.

Steps:
1. Type the address, pick it from autocomplete.
2. Wait on the confirmation screen for 3-5s.

Expected:
- If Claude returns high-confidence detection: the marker smoothly moves to the detected residence centre AND the toast appears for ~4s.
- If Claude returns low confidence or null: the marker stays at the geocoded point and no toast appears.

3. Drag the pin yourself, then wait. If Claude's response arrives after your drag, the pin should NOT jump back — your action wins.

Expected: marker stays where you dragged it; no animation runs.

Capture a `preview_screenshot` of the toast moment for the PR description.

- [ ] **Step 8: Manual QA — edge cases**

- Confirm the toast doesn't reappear after 4s.
- Click "Back" before the smart-pin response arrives — confirmation closes cleanly; check Network tab that the `/api/find-residence` request is aborted (cancelled).

- [ ] **Step 9: Commit**

```bash
git add components/ConfirmHomePin.tsx
git commit -m "feat(confirm-pin): smart auto-correction via findPrimaryResidence

When the confirmation screen mounts, fire /api/find-residence in the
background. On confidence > 0.85 returned before the user has acted,
animate the marker to Claude's detected residence centre and show a
one-time toast: 'We think this is the right one — drag the pin if we
missed.'

User actions win over smart-pin: a drag or confirm before the response
lands disables the auto-move. Low-confidence responses (<= 0.85) are
logged but ignored to avoid jiggling on ambiguous detections.

When Claude can't identify a residence at all (rural, ocean, missing
API key), the response comes back with null lat/lng and the pin stays
at the geocoded point silently."
```

---

## Task 5: Mobile polish

The marker SVG already has a 56×56 hit area (Task 2). This task adds the remaining mobile concerns: no page-scroll-during-drag, safe-area inset, and gestureHandling tuning.

**Files:**
- Modify: `components/ConfirmHomePin.tsx`

- [ ] **Step 1: Prevent body scroll while the overlay is open**

Inside `ConfirmHomePin`, add an effect that locks body scroll on mount and restores on unmount:

```tsx
  // Lock body scroll while the overlay is open. On mobile, accidental
  // page scroll during a pin drag is jarring — we'd lose drag focus
  // and the user has to re-grab the pin.
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, []);
```

Place this effect right after the existing state hooks, before the map-building useEffect.

- [ ] **Step 2: Disable double-tap-to-zoom during drag (visual feedback)**

The Google Maps `gestureHandling: "greedy"` already allows single-finger drag and pinch-zoom. Double-tap-to-zoom is a default that can fight with marker drag-release. Add `disableDoubleClickZoom: true` to the map options in the `new google.maps.Map(...)` call (Task 2 Step 1):

```tsx
      const map = new google.maps.Map(mapRef.current, {
        center: geocodedLatLng,
        zoom: 20,
        mapTypeId: "satellite",
        disableDefaultUI: true,
        zoomControl: true,
        gestureHandling: "greedy",
        clickableIcons: false,
        tilt: 0,
        disableDoubleClickZoom: true,  // ← add this line
      });
```

- [ ] **Step 3: Verify safe-area inset is already in place**

The bottom action bar already has `paddingBottom: calc(env(safe-area-inset-bottom, 0px) + 16px)` from Task 2 Step 1. Confirm this line exists. If absent, add it back.

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Manual QA on mobile viewport**

Using the preview tools, resize the viewport to mobile:

Run: `mcp__Claude_Preview__preview_resize` with width=390, height=844 (iPhone 14 dimensions).

Trigger the confirmation overlay (type an address, pick a suggestion).

Verify:
- The map fills most of the viewport.
- The bottom action bar stays visible with the button thumb-reachable.
- Tap-and-drag the pin (use `preview_eval` if needed to simulate touch drag).
- The page doesn't scroll under the map during drag.
- Tap "Yep, that's it" — overlay closes, estimate runs.

Capture `preview_screenshot` for the PR.

- [ ] **Step 6: Commit**

```bash
git add components/ConfirmHomePin.tsx
git commit -m "feat(confirm-pin): mobile polish

- Lock body scroll while the overlay is open so a pin drag never
  bleeds into a page scroll.
- Disable double-click-zoom on the map (was fighting with marker
  drag-release on touch devices)."
```

---

## Task 6: Telemetry

Console-log structured events for the funnel. The repo doesn't have an analytics SDK wired up; `console.log` keeps everything captureable by the existing Sentry breadcrumb collector and ready to swap to a real analytics call later.

**Files:**
- Modify: `components/ConfirmHomePin.tsx`
- Modify: `app/(internal)/page.tsx`

- [ ] **Step 1: Add a tiny telemetry helper inside ConfirmHomePin**

At module scope in `components/ConfirmHomePin.tsx` (below the `animateMarker` helper from Task 4), add:

```tsx
type PinEvent =
  | { type: "pin_confirm_shown"; address: string; geocodedLatLng: { lat: number; lng: number } }
  | { type: "pin_smart_corrected"; geocodedLatLng: { lat: number; lng: number }; detectedLatLng: { lat: number; lng: number }; confidence: number; distanceM: number }
  | { type: "pin_user_dragged"; from: { lat: number; lng: number }; to: { lat: number; lng: number }; distanceM: number }
  | { type: "pin_confirmed"; finalLatLng: { lat: number; lng: number }; wasSmartCorrected: boolean; wasUserDragged: boolean; timeOnScreenMs: number }
  | { type: "pin_back" };

function logPinEvent(ev: PinEvent): void {
  // Keeping this a console.log for now — the project doesn't have a
  // dedicated analytics SDK yet. Sentry's breadcrumb collector picks
  // up console output, so the event ends up in the same place as the
  // existing roof-pipeline diagnostics.
  console.log("[pin]", ev.type, ev);
}

function haversineM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
```

- [ ] **Step 2: Fire `pin_confirm_shown` on mount**

Inside `ConfirmHomePin`, add an effect that fires once when the component mounts:

```tsx
  // Mount-time event + screen-time stopwatch
  const mountedAtRef = useRef<number>(performance.now());
  useEffect(() => {
    logPinEvent({
      type: "pin_confirm_shown",
      address,
      geocodedLatLng,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

Place this near the other top-level effects.

- [ ] **Step 3: Fire `pin_smart_corrected` when smart-pin moves the marker**

Inside the smart-correction effect from Task 4 Step 3, after `setSmartMoved(true);`, add:

```tsx
        logPinEvent({
          type: "pin_smart_corrected",
          geocodedLatLng,
          detectedLatLng: { lat: data.lat, lng: data.lng },
          confidence: data.confidence,
          distanceM: haversineM(geocodedLatLng, { lat: data.lat, lng: data.lng }),
        });
```

- [ ] **Step 4: Fire `pin_user_dragged` on marker dragend**

Modify the `dragend` listener in the map-building useEffect (Task 2 Step 1):

```tsx
      marker.addListener("dragend", () => {
        const pos = marker.getPosition();
        if (!pos) return;
        const to = { lat: pos.lat(), lng: pos.lng() };
        const from = pinLatLngRef.current;
        logPinEvent({
          type: "pin_user_dragged",
          from,
          to,
          distanceM: haversineM(from, to),
        });
        setPinLatLng(to);
      });
```

Since this references `pinLatLngRef`, add a ref alongside the `pinLatLng` state:

```tsx
  const [pinLatLng, setPinLatLng] = useState(geocodedLatLng);
  const pinLatLngRef = useRef(pinLatLng);
  pinLatLngRef.current = pinLatLng;
```

- [ ] **Step 5: Fire `pin_confirmed` in `handleConfirm`**

Update `handleConfirm`:

```tsx
  const userDraggedRef = useRef(false);
  // (place this ref alongside userActedRef)

  // Update the dragstart listener from Task 4 Step 2 to also set userDraggedRef:
  // marker.addListener("dragstart", () => {
  //   userActedRef.current = true;
  //   userDraggedRef.current = true;
  // });

  const handleConfirm = useCallback(() => {
    userActedRef.current = true;
    logPinEvent({
      type: "pin_confirmed",
      finalLatLng: pinLatLng,
      wasSmartCorrected: smartMoved,
      wasUserDragged: userDraggedRef.current,
      timeOnScreenMs: Math.round(performance.now() - mountedAtRef.current),
    });
    onConfirm(pinLatLng);
  }, [onConfirm, pinLatLng, smartMoved]);
```

- [ ] **Step 6: Fire `pin_back` when the user cancels**

Replace the inline `onCancel={() => setPendingAddress(null)}` in `app/(internal)/page.tsx` with a wrapper that logs first. Find the `<ConfirmHomePin>` JSX from Task 3 Step 5, and update:

```tsx
            onCancel={() => {
              console.log("[pin]", "pin_back", {});
              setPendingAddress(null);
            }}
```

- [ ] **Step 7: Fire `pin_fallback_button_used` on the existing wrong-building toggle**

This is in `app/(internal)/page.tsx`. Find the existing wrong-building toggle button (the one tied to `setPickingBuilding((p) => !p)` around line 1824). Wrap the onClick to log before toggling:

```tsx
              onClick={() => {
                console.log("[pin]", "pin_fallback_button_used", {});
                setPickingBuilding((p) => !p);
              }}
```

- [ ] **Step 8: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 9: Manual QA — verify events fire**

Open the browser devtools console. Walk through the flow:
1. Type address, select suggestion → expect `[pin] pin_confirm_shown {...}` log.
2. Wait for smart-pin → if it fires, expect `[pin] pin_smart_corrected {...}` log.
3. Drag the pin → expect `[pin] pin_user_dragged {...}` log.
4. Click confirm → expect `[pin] pin_confirmed {...}` log with all fields populated.
5. Repeat, but click "Back" instead → expect `[pin] pin_back {}` log.
6. Run an estimate to completion, then click the existing "wrong building" toggle → expect `[pin] pin_fallback_button_used {}` log.

- [ ] **Step 10: Commit**

```bash
git add components/ConfirmHomePin.tsx app/\(internal\)/page.tsx
git commit -m "feat(confirm-pin): emit telemetry events for the funnel

Console-logged events: pin_confirm_shown, pin_smart_corrected,
pin_user_dragged, pin_confirmed, pin_back, pin_fallback_button_used.

console.log keeps them captureable by the existing Sentry breadcrumb
collector — easy to swap for a real analytics call when we wire one
up. The key success metric is pin_fallback_button_used / pin_confirmed
ratio after rollout (target <2%)."
```

---

## Task 7: Edge case — no satellite tile / no map

If Google Maps fails to load (key missing, network), the confirmation screen would be stuck on "Loading satellite view…" forever. Add a graceful fallback: after 6s with no map ready, show an error and a "Skip confirmation" button that proceeds with the geocoded lat/lng.

**Files:**
- Modify: `components/ConfirmHomePin.tsx`

- [ ] **Step 1: Add timeout + error state**

Inside `ConfirmHomePin`, add:

```tsx
  const [loadError, setLoadError] = useState(false);
```

After the map-building useEffect, add a timeout watchdog:

```tsx
  useEffect(() => {
    if (mapReady) return;
    const t = setTimeout(() => {
      if (!mapReady) setLoadError(true);
    }, 6000);
    return () => clearTimeout(t);
  }, [mapReady]);
```

- [ ] **Step 2: Render the error state**

Replace the existing `{!mapReady && (...)}` loader block with:

```tsx
        {!mapReady && !loadError && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-300 text-sm">
            Loading satellite view…
          </div>
        )}
        {loadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-300 text-sm gap-3 px-6 text-center">
            <p>We couldn't load the satellite view.</p>
            <button
              onClick={() => onConfirm(geocodedLatLng)}
              className="text-cy-300 underline hover:text-cy-100"
            >
              Continue with this address →
            </button>
          </div>
        )}
```

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 4: Manual QA — simulate failure**

In devtools, block all requests to `maps.googleapis.com` (Network → block request domain). Trigger the confirmation flow.

Expected: After 6s the error state renders with a "Continue with this address →" link. Clicking it bypasses confirmation and runs the estimate.

- [ ] **Step 5: Commit**

```bash
git add components/ConfirmHomePin.tsx
git commit -m "feat(confirm-pin): graceful fallback when satellite tile won't load

If Google Maps doesn't initialise within 6s (missing key, network
issue, blocked domain), show 'We couldn't load the satellite view'
with a 'Continue with this address →' action. Clicking it bypasses
confirmation and runs the estimate using the geocoded lat/lng — the
same point we'd have used if confirmation didn't exist at all.

Prevents the confirmation step from being a hard blocker on degraded
networks or misconfigured environments."
```

---

## Task 8: Full-flow regression QA

End-to-end verification across the surfaces this touched.

**Files:** none

- [ ] **Step 1: Desktop happy path**

Run: `mcp__Claude_Preview__preview_resize` with width=1440, height=900.

Walk through:
1. Open `/?office=nolands`.
2. Type an address from your normal demo set.
3. Pick a suggestion.

Expected: Confirmation overlay appears.

4. Wait for smart-pin (or move it yourself).
5. Click "Yep, that's it".

Expected: Overlay closes, full estimate pipeline runs (map populates, panels load).

6. Once the estimate completes, click the existing "wrong building" toggle.

Expected: Same behaviour as before — entering pick-mode, etc. (Confirms the fallback still works.)

Capture `preview_screenshot` at each major step.

- [ ] **Step 2: Mobile happy path**

Run: `mcp__Claude_Preview__preview_resize` with width=390, height=844.

Same walkthrough as Step 1. Capture screenshots.

- [ ] **Step 3: Address with no lat/lng (manual typing path)**

In the address input, type a full address but DON'T select from autocomplete (close the dropdown by pressing Escape, then hit the Estimate button).

Expected: Estimate runs directly without showing the confirmation overlay (per the `requestEstimate` gate — addresses without coords skip confirmation).

- [ ] **Step 4: Back-button flow**

Trigger confirmation, click Back, immediately try a different address.

Expected: No stuck state; second address shows fresh confirmation overlay.

- [ ] **Step 5: Full typecheck + lint sweep**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Final commit (if any QA fixes needed)**

If the QA pass turned up issues, fix them and commit. Otherwise nothing to commit.

---

## Acceptance Criteria (mirrored from spec)

- [x] Address entry → confirmation screen → estimate runs only after confirm. *(Task 3)*
- [x] Smart auto-correct moves pin within ~3s on high-confidence addresses; pin stays put otherwise. *(Task 4)*
- [x] Confirm button hit target ≥ 44pt on mobile, ≥ 36px on desktop. *(Task 2 + 5)*
- [x] Pin drag works on iOS Safari, Android Chrome, desktop Chrome, desktop Firefox. *(Task 2 + 5)*
- [x] "Wrong building" fallback button still exists and functions. *(Task 6 — wraps existing button, doesn't replace)*
- [x] Telemetry events fire and are queryable. *(Task 6)*
- [x] Estimate generation receives the confirmed lat/lng on every downstream call. *(Task 3 Step 5 — wraps `pendingAddress` with confirmed coords before calling runEstimate)*

## Out of scope (per spec, do not implement here)

- Three-tier accuracy rebuild (mesh / multiview / Solar) — separate plan.
- Address-entry redesign.
- Street View confirmation.
- Saving past confirmed pins.

## After completion

The next user-approved work is the **three-tier accuracy rebuild** (Tier C → B → A) described in the conversation context. That will be its own brainstorm → spec → plan cycle.
