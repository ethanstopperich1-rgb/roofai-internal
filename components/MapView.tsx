"use client";

import { useEffect, useRef } from "react";
import { loadGoogle } from "@/lib/google";

interface PolygonPath {
  /** Array of {lat,lng} vertices in either CW or CCW order */
  path: Array<{ lat: number; lng: number }>;
}

interface Props {
  lat?: number;
  lng?: number;
  address?: string;
  /** Roof segment polygons from Solar API — drawn as overlays */
  segments?: PolygonPath["path"][];
  /** Optional badges shown over the satellite map */
  metaBadges?: string[];
}

export default function MapView({ lat, lng, address, segments, metaBadges }: Props) {
  const mapEl = useRef<HTMLDivElement>(null);
  const svEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const svRef = useRef<google.maps.StreetViewPanorama | null>(null);
  const polysRef = useRef<google.maps.Polygon[]>([]);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY) return;
    loadGoogle().then((g) => {
      if (!mapEl.current || !svEl.current) return;
      const center = { lat: lat ?? 39.8, lng: lng ?? -98.5 };
      if (!mapRef.current) {
        mapRef.current = new g.maps.Map(mapEl.current, {
          center,
          zoom: lat && lng ? 20 : 4,
          mapTypeId: "satellite",
          tilt: 45,
          disableDefaultUI: true,
          zoomControl: true,
        });
      }
      if (!svRef.current) {
        svRef.current = new g.maps.StreetViewPanorama(svEl.current, {
          position: center,
          pov: { heading: 0, pitch: 0 },
          visible: !!(lat && lng),
          disableDefaultUI: true,
          addressControl: false,
        });
      }
      if (lat != null && lng != null) {
        const pos = { lat, lng };
        mapRef.current.panTo(pos);
        mapRef.current.setZoom(20);
        if (markerRef.current) markerRef.current.setMap(null);
        markerRef.current = new g.maps.Marker({ position: pos, map: mapRef.current });
        svRef.current.setPosition(pos);
        svRef.current.setVisible(true);
      }

      // Clear & redraw polygons
      for (const p of polysRef.current) p.setMap(null);
      polysRef.current = [];
      if (segments && segments.length && mapRef.current) {
        for (const path of segments) {
          if (!path || path.length < 3) continue;
          const poly = new g.maps.Polygon({
            paths: path,
            strokeColor: "#38bdf8",
            strokeOpacity: 0.9,
            strokeWeight: 2,
            fillColor: "#38bdf8",
            fillOpacity: 0.22,
            clickable: false,
            map: mapRef.current,
          });
          polysRef.current.push(poly);
        }
      }
    });
    // We intentionally re-run whenever segments reference changes
  }, [lat, lng, segments]);

  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY) {
    return (
      <div className="glass rounded-2xl h-full min-h-[280px] flex items-center justify-center text-slate-400 text-sm p-6 text-center">
        Set <code className="kbd mx-1">NEXT_PUBLIC_GOOGLE_MAPS_KEY</code> to enable map.
      </div>
    );
  }

  return (
    <div className="grid grid-rows-2 gap-3 h-full">
      <div className="relative rounded-2xl overflow-hidden border border-white/10 min-h-[180px]">
        <div ref={mapEl} className="w-full h-full" aria-label={address} />
        {metaBadges && metaBadges.length > 0 && (
          <div className="pointer-events-none absolute left-2 top-2 flex flex-wrap gap-1.5">
            {metaBadges.map((b, i) => (
              <span
                key={i}
                className="rounded-full border border-white/15 bg-black/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/85 backdrop-blur"
              >
                {b}
              </span>
            ))}
          </div>
        )}
      </div>
      <div ref={svEl} className="rounded-2xl overflow-hidden border border-white/10 min-h-[180px]" aria-label={address} />
    </div>
  );
}
