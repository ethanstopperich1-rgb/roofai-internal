"use client";

import { useEffect, useState } from "react";
import { Cloud, Wind, Droplets } from "lucide-react";
import type { AddressInfo } from "@/types/estimate";

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
};

export default function PropertyContextPanel({ address }: Props) {
  const [weather, setWeather] = useState<Weather | null>(null);

  useEffect(() => {
    if (!address?.lat || !address?.lng) return;
    fetch(`/api/weather?lat=${address.lat}&lng=${address.lng}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setWeather(d))
      .catch(() => {});
  }, [address?.lat, address?.lng]);

  if (!address?.lat) return null;
  if (!weather) return null;

  return (
    <div className="glass rounded-3xl p-5 space-y-4">
      <div className="font-display font-semibold tracking-tight text-[15px]">
        Property Context
      </div>
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
