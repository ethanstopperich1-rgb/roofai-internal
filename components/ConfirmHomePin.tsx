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
