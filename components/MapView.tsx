"use client";

import { useEffect, useRef } from "react";
import { loadGoogle } from "@/lib/google";
import { Satellite, Eye } from "lucide-react";

export interface PenetrationMarker {
  kind: string;
  /** Pixel coords on the 640×640 zoom-20 satellite tile that vision analyzed */
  x: number;
  y: number;
  approxSizeFt?: number;
}

interface Props {
  lat?: number;
  lng?: number;
  address?: string;
  /** Roof segment polygons from Solar API — drawn as overlays */
  segments?: Array<Array<{ lat: number; lng: number }>>;
  /** Penetrations from Claude vision (rendered as numbered circles) */
  penetrations?: PenetrationMarker[];
  /** Optional badges shown over the satellite map */
  metaBadges?: string[];
}

/**
 * Pixel coords on the 640×640 zoom-20 tile → lat/lng we can drop a marker at.
 */
function pixelToLatLng(opts: {
  x: number;
  y: number;
  centerLat: number;
  centerLng: number;
  imgSize?: number;
  zoom?: number;
}): { lat: number; lng: number } {
  const { x, y, centerLat, centerLng, imgSize = 640, zoom = 20 } = opts;
  const mPerPx =
    (156_543.03392 * Math.cos((centerLat * Math.PI) / 180)) / Math.pow(2, zoom);
  const dx = x - imgSize / 2;
  const dy = y - imgSize / 2;
  const dLatDeg = (-dy * mPerPx) / 111_320;
  const dLngDeg =
    (dx * mPerPx) / (111_320 * Math.cos((centerLat * Math.PI) / 180));
  return { lat: centerLat + dLatDeg, lng: centerLng + dLngDeg };
}

export default function MapView({
  lat,
  lng,
  address,
  segments,
  penetrations,
  metaBadges,
}: Props) {
  const mapEl = useRef<HTMLDivElement>(null);
  const svEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const svRef = useRef<google.maps.StreetViewPanorama | null>(null);
  const polysRef = useRef<google.maps.Polygon[]>([]);
  const penMarkersRef = useRef<google.maps.Marker[]>([]);

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

      // Clear & redraw penetration markers (numbered amber circles)
      for (const m of penMarkersRef.current) m.setMap(null);
      penMarkersRef.current = [];
      if (penetrations && penetrations.length && mapRef.current) {
        penetrations.forEach((p, idx) => {
          const ll = pixelToLatLng({
            x: p.x,
            y: p.y,
            centerLat: lat,
            centerLng: lng,
          });
          const marker = new g.maps.Marker({
            position: ll,
            map: mapRef.current!,
            label: {
              text: String(idx + 1),
              color: "#0a0d12",
              fontSize: "11px",
              fontWeight: "700",
            },
            title: `${p.kind}${p.approxSizeFt ? ` (~${p.approxSizeFt}ft)` : ""}`,
            icon: {
              path: g.maps.SymbolPath.CIRCLE,
              scale: 9,
              fillColor: "#f3b14b",
              fillOpacity: 0.92,
              strokeColor: "#0a0d12",
              strokeWeight: 2,
            },
          });
          penMarkersRef.current.push(marker);
        });
      }
    });
  }, [lat, lng, segments, penetrations]);

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
