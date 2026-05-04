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
    });
  }, [lat, lng]);

  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY) {
    return (
      <div className="glass rounded-2xl h-full min-h-[280px] flex items-center justify-center text-slate-400 text-sm p-6 text-center">
        Set <code className="kbd mx-1">NEXT_PUBLIC_GOOGLE_MAPS_KEY</code> to enable map.
      </div>
    );
  }

  const ready = lat != null && lng != null;
  return (
    <div className="grid grid-rows-2 gap-3 h-full">
      <div className="relative rounded-2xl overflow-hidden border border-white/10 min-h-[180px] bg-black/30">
        <div ref={mapEl} className="absolute inset-0" aria-label={address} />
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-xs">
            Pick an address from autocomplete to load satellite view
          </div>
        )}
      </div>
      <div className="relative rounded-2xl overflow-hidden border border-white/10 min-h-[180px] bg-black/30">
        <div ref={svEl} className="absolute inset-0" aria-label={address} />
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-xs">
            Street view will load with the address
          </div>
        )}
      </div>
    </div>
  );
}
