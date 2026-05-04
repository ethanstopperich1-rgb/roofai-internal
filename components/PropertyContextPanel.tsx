"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Cloud, Wind, Droplets, Loader2, Box } from "lucide-react";
import type { AddressInfo } from "@/types/estimate";

const Roof3DViewer = dynamic(() => import("./Roof3DViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-44 rounded-2xl border border-white/[0.08] bg-black/30">
      <Loader2 size={16} className="animate-spin text-slate-400" />
    </div>
  ),
});

interface Weather {
  description?: string;
  icon?: string;
  tempF?: number | null;
  humidity?: number;
  windMph?: number | null;
  windDir?: string;
}

type Props = {
  address: AddressInfo | null;
  /** Roof polygon(s) in lat/lng — drawn over the 3D mesh as a glowing outline. */
  polygons?: Array<Array<{ lat: number; lng: number }>>;
};

export default function PropertyContextPanel({ address, polygons }: Props) {
  const [weather, setWeather] = useState<Weather | null>(null);
  const [show3D, setShow3D] = useState(false);

  useEffect(() => {
    if (!address?.lat || !address?.lng) return;
    fetch(`/api/weather?lat=${address.lat}&lng=${address.lng}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setWeather(d))
      .catch(() => {});
  }, [address?.lat, address?.lng]);

  if (!address?.lat) return null;

  return (
    <div className="glass rounded-3xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="font-display font-semibold tracking-tight text-[15px]">Property Context</div>
        <button
          onClick={() => setShow3D((v) => !v)}
          className="btn btn-ghost py-1.5 px-3 text-[12px]"
        >
          <Box size={12} /> {show3D ? "Hide 3D" : "Open 3D"}
        </button>
      </div>

      {show3D && address.lat != null && address.lng != null && (
        <Roof3DViewer
          lat={address.lat}
          lng={address.lng}
          address={address.formatted}
          polygons={polygons}
        />
      )}

      {/* Weather */}
      {weather && (
        <div className="grid grid-cols-3 gap-1.5">
          <Stat
            icon={<Cloud size={12} />}
            value={weather.tempF != null ? `${weather.tempF}°` : "—"}
            label={weather.description ?? "—"}
          />
          <Stat
            icon={<Wind size={12} />}
            value={weather.windMph != null ? `${weather.windMph}` : "—"}
            unit="mph"
            label={weather.windDir ?? "wind"}
          />
          <Stat
            icon={<Droplets size={12} />}
            value={weather.humidity != null ? `${weather.humidity}` : "—"}
            unit="%"
            label="humidity"
          />
        </div>
      )}
    </div>
  );
}

function Stat({
  icon,
  value,
  unit,
  label,
}: {
  icon: React.ReactNode;
  value: string;
  unit?: string;
  label: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.05] bg-white/[0.015] px-2.5 py-2 text-center">
      <div className="text-slate-500 flex justify-center mb-0.5">{icon}</div>
      <div className="font-display tabular text-[16px] font-semibold tracking-tight">
        {value}
        {unit && <span className="text-[10px] text-slate-500 font-mono ml-0.5">{unit}</span>}
      </div>
      <div className="text-[9.5px] font-mono uppercase tracking-[0.12em] text-slate-500 truncate mt-0.5">
        {label}
      </div>
    </div>
  );
}
