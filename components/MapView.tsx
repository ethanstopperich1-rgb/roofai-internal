"use client";

import { useEffect, useRef } from "react";
import { loadGoogle } from "@/lib/google";

interface Props {
  lat?: number;
  lng?: number;
  address?: string;
}

export default function MapView({ lat, lng, address }: Props) {
  const mapEl = useRef<HTMLDivElement>(null);
  const svEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const svRef = useRef<google.maps.StreetViewPanorama | null>(null);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY) return;
    loadGoogle().then((g) => {
      if (!mapEl.current || !svEl.current) return;
      const center = { lat: lat ?? 39.8, lng: lng ?? -98.5 };
      if (!mapRef.current) {
        mapRef.current = new g.maps.Map(mapEl.current, {
          center, zoom: lat && lng ? 20 : 4,
          mapTypeId: "satellite", tilt: 45, disableDefaultUI: true,
          zoomControl: true,
        });
      }
      if (!svRef.current) {
        svRef.current = new g.maps.StreetViewPanorama(svEl.current, {
          position: center, pov: { heading: 0, pitch: 0 }, visible: !!(lat && lng),
          disableDefaultUI: true, addressControl: false,
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
    });
  }, [lat, lng]);

  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY) {
    return (
      <div className="glass rounded-2xl h-full min-h-[280px] flex items-center justify-center text-slate-400 text-sm p-6 text-center">
        Set <code className="kbd mx-1">NEXT_PUBLIC_GOOGLE_MAPS_KEY</code> to enable map.
      </div>
    );
  }

  return (
    <div className="grid grid-rows-2 gap-3 h-full">
      <div ref={mapEl} className="rounded-2xl overflow-hidden border border-white/10 min-h-[180px]" aria-label={address} />
      <div ref={svEl} className="rounded-2xl overflow-hidden border border-white/10 min-h-[180px]" aria-label={address} />
    </div>
  );
}
