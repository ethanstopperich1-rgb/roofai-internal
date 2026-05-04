"use client";

import { useEffect, useRef } from "react";
import { loadGoogle } from "@/lib/google";
import { Satellite, Eye } from "lucide-react";

interface Props {
  lat?: number;
  lng?: number;
  address?: string;
  /** Roof segment polygons from Solar API — drawn as overlays */
  segments?: Array<Array<{ lat: number; lng: number }>>;
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
    if (lat == null || lng == null) return;
    const pos = { lat, lng };
    loadGoogle().then((g) => {
      if (!mapEl.current || !svEl.current) return;
      if (!mapRef.current) {
        mapRef.current = new g.maps.Map(mapEl.current, {
          center: pos,
          zoom: 20,
          mapTypeId: "satellite",
          tilt: 0,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: "greedy",
        });
      } else {
        mapRef.current.setCenter(pos);
        mapRef.current.setZoom(20);
      }
      if (markerRef.current) markerRef.current.setMap(null);
      markerRef.current = new g.maps.Marker({ position: pos, map: mapRef.current });

      if (!svRef.current) {
        svRef.current = new g.maps.StreetViewPanorama(svEl.current, {
          position: pos,
          pov: { heading: 0, pitch: 0 },
          visible: true,
          disableDefaultUI: true,
          addressControl: false,
        });
      } else {
        svRef.current.setPosition(pos);
        svRef.current.setVisible(true);
      }

      // Clear & redraw roof segment polygons
      for (const p of polysRef.current) p.setMap(null);
      polysRef.current = [];
      if (segments && segments.length && mapRef.current) {
        for (const path of segments) {
          if (!path || path.length < 3) continue;
          const poly = new g.maps.Polygon({
            paths: path,
            strokeColor: "#67dcff",
            strokeOpacity: 0.95,
            strokeWeight: 2,
            fillColor: "#38c5ee",
            fillOpacity: 0.2,
            clickable: false,
            map: mapRef.current,
          });
          polysRef.current.push(poly);
        }
      }
    });
  }, [lat, lng, segments]);

  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY) {
    return (
      <div className="glass rounded-3xl h-full min-h-[280px] flex items-center justify-center text-slate-400 text-[13px] p-6 text-center">
        Set <code className="kbd mx-1">NEXT_PUBLIC_GOOGLE_MAPS_KEY</code> to enable map.
      </div>
    );
  }

  const ready = lat != null && lng != null;
  return (
    <div className="grid grid-rows-2 gap-3 h-full">
      <Tile
        ready={ready}
        elRef={mapEl}
        address={address}
        icon={<Satellite size={14} />}
        emptyTitle="Satellite View"
        emptyBody="Pick an address to load high-resolution satellite imagery"
      >
        {ready && metaBadges && metaBadges.length > 0 && (
          <div className="pointer-events-none absolute left-2 bottom-2 flex flex-wrap gap-1 max-w-[calc(100%-1rem)]">
            {metaBadges.map((b, i) => (
              <span
                key={i}
                className="rounded-full border border-white/15 bg-black/65 px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.10em] text-white/85 backdrop-blur"
              >
                {b}
              </span>
            ))}
          </div>
        )}
      </Tile>
      <Tile
        ready={ready}
        elRef={svEl}
        address={address}
        icon={<Eye size={14} />}
        emptyTitle="Street View"
        emptyBody="On-the-ground panorama of the property"
      />
    </div>
  );
}

function Tile({
  ready,
  elRef,
  address,
  icon,
  emptyTitle,
  emptyBody,
  children,
}: {
  ready: boolean;
  elRef: React.RefObject<HTMLDivElement | null>;
  address?: string;
  icon: React.ReactNode;
  emptyTitle: string;
  emptyBody: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative rounded-2xl overflow-hidden border border-white/[0.07] bg-black/30">
      <div ref={elRef} className="absolute inset-0" aria-label={address} />
      {!ready && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6">
          <div className="w-8 h-8 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center text-slate-500 mb-3">
            {icon}
          </div>
          <div className="font-display text-[13px] font-semibold tracking-tight text-slate-300">
            {emptyTitle}
          </div>
          <div className="text-[11.5px] text-slate-500 mt-1 max-w-[220px] leading-relaxed">
            {emptyBody}
          </div>
        </div>
      )}
      {ready && (
        <div className="absolute top-2.5 left-2.5 z-10 chip chip-accent backdrop-blur-md bg-[#07090d]/60">
          {icon}
        </div>
      )}
      {children}
    </div>
  );
}
