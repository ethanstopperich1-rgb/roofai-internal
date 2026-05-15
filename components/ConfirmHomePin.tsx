"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadGoogle } from "@/lib/google";
import { AuroraButton } from "@/components/ui/aurora-button";

/**
 * Tween a marker's position from current → target over `durationMs`
 * using an ease-out curve. Cheaper than re-running setPosition every
 * frame at high FPS because we cap to 24fps.
 */
function animateMarker(
  marker: google.maps.Marker,
  target: google.maps.LatLng,
  durationMs: number,
  cancelled: () => boolean,
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
    if (cancelled()) return;
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
  const pinLatLngRef = useRef(pinLatLng);
  useEffect(() => {
    pinLatLngRef.current = pinLatLng;
  });
  const [mapReady, setMapReady] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // Smart auto-correction. While the user orients on the screen, ask
  // Claude vision to identify the primary residence on this parcel.
  // If confidence > 0.85 we move the pin; lower confidence is logged
  // but ignored (avoid jiggling on ambiguous detections). If the user
  // confirms before this returns, we discard the result silently.
  const [smartMoved, setSmartMoved] = useState(false);
  const userActedRef = useRef(false);
  const userDraggedRef = useRef(false);
  const mountedAtRef = useRef<number>(0);
  useEffect(() => {
    mountedAtRef.current = performance.now();
  }, []);

  const hasApiKey = !!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;

  // Fire pin_confirm_shown once on mount
  useEffect(() => {
    logPinEvent({
      type: "pin_confirm_shown",
      address,
      geocodedLatLng,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Build the map + draggable marker on mount. Skips when no API key.
  useEffect(() => {
    if (!hasApiKey) return;
    let cancelled = false;
    (async () => {
      try {
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
          disableDoubleClickZoom: true,
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

        marker.addListener("dragstart", () => {
          userActedRef.current = true;
          userDraggedRef.current = true;
        });

        setMapReady(true);
      } catch (err) {
        if (cancelled) return;
        console.warn("[confirm-pin] loadGoogle() failed:", err);
        setLoadError(true);
      }
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

  // 6s watchdog — if the map doesn't initialise (loader hangs, slow
  // network, etc.) within 6 seconds, surface the error state so the
  // user has an escape rather than being stuck on the loading spinner.
  useEffect(() => {
    if (mapReady || loadError) return;
    if (!hasApiKey) return;
    const t = setTimeout(() => {
      if (!mapReady) setLoadError(true);
    }, 6000);
    return () => clearTimeout(t);
  }, [mapReady, loadError, hasApiKey]);

  // Background residence-detection. Runs once, after the map is ready
  // (so we have a marker to move). Aborts silently if the user has
  // already dragged or confirmed by the time the response lands.
  useEffect(() => {
    if (!mapReady || !hasApiKey) return;
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
          console.warn(
            `[pin-confirm] smart-pin low confidence (${data.confidence.toFixed(2)}); leaving pin at geocode`,
          );
          return;
        }

        // Animate marker to the detected residence centre.
        const detected = new google.maps.LatLng(data.lat, data.lng);
        const marker = markerRef.current;
        const map = mapInstanceRef.current;
        if (!marker || !map) return;
        animateMarker(marker, detected, 600, () => userActedRef.current);
        // Don't recenter the map — preserve spatial context. User can
        // pan if needed.
        setPinLatLng({ lat: data.lat, lng: data.lng });
        setSmartMoved(true);
        logPinEvent({
          type: "pin_smart_corrected",
          geocodedLatLng,
          detectedLatLng: { lat: data.lat, lng: data.lng },
          confidence: data.confidence,
          distanceM: haversineM(geocodedLatLng, { lat: data.lat, lng: data.lng }),
        });
      } catch {
        /* aborted or network error — silently fall through */
      }
    })();
    return () => ctrl.abort();
    // We deliberately depend on geocodedLatLng.lat/.lng (primitives) rather
    // than the geocodedLatLng object itself — the parent passes a fresh
    // object literal on every render, so depending on the object would
    // make this effect re-fire and re-hit /api/find-residence on every
    // parent rerender. The primitive lat/lng are the stable signals.
    // hasApiKey is a compile-time constant (Next.js env inline) — safe to include
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, geocodedLatLng.lat, geocodedLatLng.lng, address, hasApiKey]);

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

  // No-key fallback rendered after all hooks so Rules of Hooks is satisfied.
  if (!hasApiKey) {
    return (
      <div className="flex flex-col h-full w-full bg-black/40 backdrop-blur-md items-center justify-center text-slate-400 text-sm gap-4 px-6 text-center">
        <p>Map unavailable — no API key configured.</p>
        <button
          onClick={() => onConfirm(geocodedLatLng)}
          className="text-cy-300 underline hover:text-cy-200"
        >
          Continue with this address →
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-full w-full bg-[#07090d]/95 backdrop-blur-xl p-3 sm:p-5 lg:p-7 gap-4"
      style={{
        // Subtle vignette so the focus snaps to the framed map + confirm
        // card. The previous full-bleed black-on-black layout had no
        // visual hierarchy — viewport was just "satellite image, then
        // bar of text."
        background:
          "radial-gradient(1200px 700px at 50% 20%, rgba(56,197,238,0.04), transparent 60%), #07090d",
      }}
    >
      {/* Eyebrow strip — anchors the user in the workflow before the
          satellite imagery hits. Was missing entirely, which made the
          screen feel like a popup that appeared from nowhere. */}
      <header className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cy-300 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-cy-300" />
          </span>
          <span className="text-[10.5px] font-mono uppercase tracking-[0.18em] text-cy-300/85">
            Confirm property
          </span>
        </div>
        <span className="text-[10.5px] font-mono uppercase tracking-[0.16em] text-slate-500 hidden sm:inline">
          Step 1 of 2 · pin → measure
        </span>
      </header>

      {/* Framed satellite map — rounded glass container with inner
          border, replaces the edge-to-edge bleed. The pin sits inside
          this surface so the eye reads "you're inspecting a frame"
          rather than "you're trapped inside a map." */}
      <div className="flex-1 relative min-h-[280px] sm:min-h-[360px] rounded-2xl overflow-hidden border border-white/[0.10] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.8)]">
        <div ref={mapRef} className="absolute inset-0" />
        {!mapReady && !loadError && (
          <div className="absolute inset-0 flex items-center justify-center gap-2.5 text-slate-300 text-[13px]">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cy-300 opacity-70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cy-300" />
            </span>
            Loading satellite view…
          </div>
        )}
        {loadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-300 text-sm gap-3 px-6 text-center">
            <p>We couldn&apos;t load the satellite view.</p>
            <button
              onClick={() => onConfirm(geocodedLatLng)}
              className="text-cy-300 underline hover:text-cy-200"
            >
              Continue with this address →
            </button>
          </div>
        )}
        {smartMoved && !loadError && (
          <SmartPinToast />
        )}
      </div>

      {/* Bottom confirm card — proper glass surface, not a footer bar.
          Address rides in a pinned chip, the prompt sits on its own
          line, actions get visible breathing room. */}
      <div
        className="rounded-2xl border border-white/[0.10] bg-white/[0.025] backdrop-blur-md px-4 py-4 sm:px-6 sm:py-5"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 18px)" }}
      >
        <div className="max-w-3xl mx-auto flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-display text-[19px] sm:text-[22px] font-semibold tracking-[-0.018em] text-slate-50">
              Is this your roof?
            </h2>
            <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-white/[0.10] bg-white/[0.03] px-3 py-1 text-[12px] text-slate-200 max-w-full">
              <span className="text-cy-300 shrink-0" aria-hidden>📍</span>
              <span className="truncate">{address}</span>
            </div>
            <p className="text-[12px] text-slate-500 mt-2.5 leading-relaxed">
              Drag the pin if we&apos;re on the wrong building.
            </p>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
            <button
              onClick={() => {
                logPinEvent({ type: "pin_back" });
                onCancel();
              }}
              className="text-[13px] font-medium text-slate-400 hover:text-slate-100 transition-colors px-3 py-2 rounded-lg hover:bg-white/[0.04]"
            >
              ← Back
            </button>
            <AuroraButton
              onClick={handleConfirm}
              className="px-5 sm:px-7 py-2.5 font-semibold text-[14px] tracking-tight"
            >
              Yep, that&apos;s it
            </AuroraButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function SmartPinToast() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 4000);
    return () => clearTimeout(t);
  }, []);
  if (!visible) return null;
  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 max-w-[90vw]">
      <div className="rounded-full bg-cy-300/15 border border-cy-300/40 backdrop-blur-md px-4 py-2 text-sm text-cy-200 shadow-lg">
        We think this is the right one — drag the pin if we missed.
      </div>
    </div>
  );
}
