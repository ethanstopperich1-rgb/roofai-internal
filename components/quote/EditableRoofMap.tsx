"use client";

import { useEffect, useRef, useState } from "react";
import { loadGoogle } from "@/lib/google";
import { Pencil, RotateCcw } from "lucide-react";

interface Props {
  lat: number;
  lng: number;
  /** Auto-detected polygon to show as the starting outline. Customer
   *  can drag vertices to correct it; "Reset" reverts to this polygon. */
  initialPolygon: Array<{ lat: number; lng: number }> | null;
  /** Fired whenever the customer modifies the polygon (drag, add, or
   *  remove a vertex). Receives the new vertex list. */
  onPolygonChanged?: (poly: Array<{ lat: number; lng: number }>) => void;
}

/**
 * Customer-facing satellite map with an editable roof polygon.
 *
 * Differs from the rep-side `MapView` in deliberate ways:
 *  • No Street View pane (customer doesn't need it for self-service)
 *  • No "Draw fresh" / palette / staggered animation / source labels
 *  • One polygon only (a customer's roof; multi-section buildings still
 *    get a single outline that the customer can shape with vertices)
 *  • Reset button restores the auto-detected polygon if they edit too far
 *
 * Why a separate component instead of reusing MapView:
 * MapView is ~580 lines targeting the internal estimator (Street View,
 * drawing manager, vision penetrations, multi-source palette, animation
 * timers). For the customer wizard the simplest possible interaction
 * — "drag the dots to fit your roof" — beats more features.
 */
export default function EditableRoofMap({
  lat,
  lng,
  initialPolygon,
  onPolygonChanged,
}: Props) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const polyRef = useRef<google.maps.Polygon | null>(null);
  const callbackRef = useRef(onPolygonChanged);
  callbackRef.current = onPolygonChanged;

  // Snapshot of the auto-detected polygon for the Reset button.
  const initialRef = useRef(initialPolygon);
  initialRef.current = initialPolygon;

  const [ready, setReady] = useState(false);

  // Initialise the map once per mount. Cleanup releases the map ref on
  // unmount — required because Next has reactStrictMode: true, so this
  // effect runs mount → cleanup → mount again on every dev render. Without
  // releasing mapRef on cleanup, the second mount finds the orphaned first
  // map (attached to a removed div) and skips creating a fresh one,
  // leaving the new mapEl div empty and no polygon ever drawn.
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY) return;
    if (lat == null || lng == null) return;
    let cancelled = false;
    loadGoogle().then((g) => {
      if (cancelled || !mapEl.current) return;
      const pos = { lat, lng };
      // Always create a fresh map on this mount's div. We can't safely
      // re-attach a Maps instance to a different DOM element, so per-
      // mount creation is the simplest correct behaviour.
      mapRef.current = new g.maps.Map(mapEl.current, {
        center: pos,
        zoom: 20,
        mapTypeId: "satellite",
        tilt: 0,
        disableDefaultUI: true,
        keyboardShortcuts: false,
        clickableIcons: false,
        draggable: true,
        zoomControl: true,
        scrollwheel: true,
        disableDoubleClickZoom: false,
      });
      setReady(true);
    });
    return () => {
      cancelled = true;
      // Release the polygon and the map instance so the next mount can
      // attach a fresh map to its new div.
      if (polyRef.current) {
        polyRef.current.setMap(null);
        polyRef.current = null;
      }
      mapRef.current = null;
      setReady(false);
    };
  }, [lat, lng]);

  // Render / re-render the polygon when initialPolygon changes.
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    if (!map) return;
    if (polyRef.current) {
      polyRef.current.setMap(null);
      polyRef.current = null;
    }
    if (!initialPolygon || initialPolygon.length < 3) return;

    void loadGoogle().then((g) => {
      if (!map) return;
      const poly = new g.maps.Polygon({
        paths: initialPolygon,
        strokeColor: "#67dcff",
        strokeOpacity: 0.95,
        strokeWeight: 3,
        fillColor: "#38c5ee",
        fillOpacity: 0.22,
        editable: true,
        clickable: true,
        zIndex: 5,
        map,
      });
      polyRef.current = poly;
      const path = poly.getPath();
      const broadcast = () => {
        const arr: Array<{ lat: number; lng: number }> = [];
        path.forEach((v) => arr.push({ lat: v.lat(), lng: v.lng() }));
        callbackRef.current?.(arr);
      };
      path.addListener("set_at", broadcast);
      path.addListener("insert_at", broadcast);
      path.addListener("remove_at", broadcast);
    });
  }, [initialPolygon, ready]);

  const handleReset = () => {
    const map = mapRef.current;
    if (!map || !initialRef.current || initialRef.current.length < 3) return;
    if (polyRef.current) {
      polyRef.current.setMap(null);
      polyRef.current = null;
    }
    void loadGoogle().then((g) => {
      const poly = new g.maps.Polygon({
        paths: initialRef.current!,
        strokeColor: "#67dcff",
        strokeOpacity: 0.95,
        strokeWeight: 3,
        fillColor: "#38c5ee",
        fillOpacity: 0.22,
        editable: true,
        clickable: true,
        zIndex: 5,
        map,
      });
      polyRef.current = poly;
      const path = poly.getPath();
      const broadcast = () => {
        const arr: Array<{ lat: number; lng: number }> = [];
        path.forEach((v) => arr.push({ lat: v.lat(), lng: v.lng() }));
        callbackRef.current?.(arr);
      };
      path.addListener("set_at", broadcast);
      path.addListener("insert_at", broadcast);
      path.addListener("remove_at", broadcast);
      callbackRef.current?.(initialRef.current!);
    });
  };

  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY) {
    return (
      <div className="w-full h-full flex items-center justify-center text-slate-500 text-[12px] p-6 text-center">
        Map unavailable — set NEXT_PUBLIC_GOOGLE_MAPS_KEY.
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      <div
        ref={mapEl}
        className="absolute inset-0 rounded-2xl overflow-hidden"
        aria-label="Editable roof map"
      />
      {ready && initialPolygon && initialPolygon.length >= 3 && (
        <>
          <div className="pointer-events-none absolute top-3 left-3 rounded-full border border-white/15 bg-black/65 px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.12em] text-white/90 backdrop-blur-md flex items-center gap-2">
            <Pencil size={11} /> Drag dots to fit your roof
          </div>
          <button
            onClick={handleReset}
            className="absolute top-3 right-3 rounded-full border border-white/15 bg-black/65 hover:bg-black/85 text-white/90 px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.10em] backdrop-blur-md flex items-center gap-1.5"
            title="Restore auto-detected outline"
          >
            <RotateCcw size={11} /> Reset
          </button>
        </>
      )}
    </div>
  );
}
