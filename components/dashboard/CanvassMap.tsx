"use client";

import { useEffect, useRef } from "react";
import type { CanvassRow, CanvassStormEvent } from "./CanvassView";

/**
 * Map view for the canvass surface. Renders every row as a colored
 * pin (cyan = hot ≥50, white = mid 30-50, dim = cold <30, rose =
 * post-storm-penalty negative). Storm events render as faint cyan
 * circles showing the radius. Click a pin to focus the corresponding
 * row in the table.
 *
 * Uses the Google Maps JS API loaded by the existing MapView component
 * pattern — `NEXT_PUBLIC_GOOGLE_MAPS_KEY` is wired site-wide. Loader
 * pattern mirrors components/MapView.tsx so we don't double-load the
 * SDK.
 */

const GMAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";

declare global {
  interface Window {
    google: typeof google;
    __voxaris_gmaps_loader?: Promise<void>;
  }
}

function loadGoogleMaps(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("ssr"));
  if (window.google?.maps) return Promise.resolve();
  if (window.__voxaris_gmaps_loader) return window.__voxaris_gmaps_loader;
  window.__voxaris_gmaps_loader = new Promise((resolve, reject) => {
    if (!GMAPS_KEY) {
      reject(new Error("NEXT_PUBLIC_GOOGLE_MAPS_KEY missing"));
      return;
    }
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${GMAPS_KEY}&libraries=marker&v=weekly`;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = (e) => reject(e);
    document.head.appendChild(s);
  });
  return window.__voxaris_gmaps_loader;
}

function colorForScore(score: number): { fill: string; stroke: string } {
  // Taste rule: one accent color, saturation < 80%. Cyan family
  // descends through neutrals into rose for the post-storm penalty.
  if (score >= 50) return { fill: "#67dcff", stroke: "#1d4d63" }; // hot
  if (score >= 30) return { fill: "#d6e9f3", stroke: "#3a4d57" }; // warm
  if (score >= 0)  return { fill: "#7c8b95", stroke: "#2a333a" }; // cool
  return { fill: "#ef6e84", stroke: "#5a1e2a" };                  // post-storm penalty
}

export default function CanvassMap({
  rows,
  events,
  onSelectRow,
  selectedRowId,
}: {
  rows: CanvassRow[];
  events: CanvassStormEvent[];
  onSelectRow: (r: CanvassRow) => void;
  selectedRowId?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const circlesRef = useRef<google.maps.Circle[]>([]);

  // ─── Boot the map once ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps()
      .then(() => {
        if (cancelled || !containerRef.current) return;
        // Center: use first storm event if available, else FL centroid.
        const center =
          events[0] != null
            ? { lat: events[0].center_lat, lng: events[0].center_lng }
            : { lat: 28.6, lng: -81.3 };
        mapRef.current = new window.google.maps.Map(containerRef.current, {
          center,
          zoom: events[0] ? 12 : 9,
          mapTypeId: "hybrid",
          disableDefaultUI: false,
          streetViewControl: false,
          fullscreenControl: true,
          mapTypeControl: false,
          backgroundColor: "#0a0d12",
          // visionOS-leaning styling — desaturate roads, hide POI clutter
          styles: [
            { featureType: "poi", stylers: [{ visibility: "off" }] },
            { featureType: "transit", stylers: [{ visibility: "off" }] },
          ],
        });
      })
      .catch((e) => {
        console.warn("[canvass-map] gmaps load failed:", e);
      });
    return () => {
      cancelled = true;
    };
    // mount-once — events / rows handled in their own effects
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Storm event circles ─────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !window.google?.maps) return;
    circlesRef.current.forEach((c) => c.setMap(null));
    circlesRef.current = [];
    for (const ev of events) {
      const c = new window.google.maps.Circle({
        strokeColor: "#67dcff",
        strokeOpacity: 0.35,
        strokeWeight: 1.5,
        fillColor: "#67dcff",
        fillOpacity: 0.05,
        map: mapRef.current,
        center: { lat: ev.center_lat, lng: ev.center_lng },
        radius: ev.radius_miles * 1609.344,
        clickable: false,
      });
      circlesRef.current.push(c);
    }
  }, [events]);

  // ─── Pins for canvass targets ────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !window.google?.maps) return;
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    if (rows.length === 0) return;

    const bounds = new window.google.maps.LatLngBounds();
    for (const r of rows.slice(0, 500)) {
      const colors = colorForScore(r.score);
      const isSelected = selectedRowId === r.id;
      const m = new window.google.maps.Marker({
        position: { lat: r.lat, lng: r.lng },
        map: mapRef.current,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: isSelected ? 8.5 : r.score >= 50 ? 6.5 : 5,
          fillColor: colors.fill,
          fillOpacity: isSelected ? 1 : 0.92,
          strokeColor: isSelected ? "#ffffff" : colors.stroke,
          strokeWeight: isSelected ? 2.5 : 1,
        },
        title: `${r.address_line ?? "—"} · score ${r.score.toFixed(1)}`,
        zIndex: isSelected ? 1000 : Math.round(r.score),
      });
      m.addListener("click", () => onSelectRow(r));
      markersRef.current.push(m);
      bounds.extend({ lat: r.lat, lng: r.lng });
    }

    // Fit to pins ONLY when there's no selected row (otherwise we
    // disrupt the user's focus). Cap zoom-in so a tight subdivision
    // doesn't push us to a useless street level.
    if (!selectedRowId && rows.length > 0) {
      mapRef.current.fitBounds(bounds, 80);
      const listener = mapRef.current.addListener("idle", () => {
        if (mapRef.current && mapRef.current.getZoom()! > 17) {
          mapRef.current.setZoom(17);
        }
        listener.remove();
      });
    }
  }, [rows, selectedRowId, onSelectRow]);

  // ─── Pan to selected row ─────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !selectedRowId) return;
    const r = rows.find((x) => x.id === selectedRowId);
    if (!r) return;
    mapRef.current.panTo({ lat: r.lat, lng: r.lng });
    if (mapRef.current.getZoom()! < 16) {
      mapRef.current.setZoom(17);
    }
  }, [selectedRowId, rows]);

  if (!GMAPS_KEY) {
    return (
      <div className="glass-panel p-10 text-center text-white/55 text-sm">
        Map unavailable —{" "}
        <code className="font-mono text-cy-300">NEXT_PUBLIC_GOOGLE_MAPS_KEY</code>{" "}
        not configured.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="w-full rounded-2xl overflow-hidden border border-white/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
      style={{ height: "min(70vh, 700px)" }}
      aria-label="Canvass map"
    />
  );
}
