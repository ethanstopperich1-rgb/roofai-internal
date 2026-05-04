"use client";

import { useEffect, useState } from "react";
import { Cloud, Wind, Droplets, Film, Loader2, Play, Building2, Calendar, Home } from "lucide-react";
import type { AddressInfo } from "@/types/estimate";

interface Weather {
  description?: string;
  icon?: string;
  tempF?: number | null;
  humidity?: number;
  windMph?: number | null;
  windDir?: string;
}

interface Aerial {
  state?: "PROCESSING" | "ACTIVE" | "FAILED";
  videoMp4?: string;
  image?: string;
}

interface AttomProperty {
  storyCount: number | null;
  yearBuilt: number | null;
  buildingSqft: number | null;
  lotSqft: number | null;
  beds: number | null;
  baths: number | null;
  propertyType: string | null;
}

type Props = {
  address: AddressInfo | null;
  /** Bubble ATTOM property data up so the rest of the page can use it */
  onProperty?: (p: AttomProperty | null) => void;
};

export default function PropertyContextPanel({ address, onProperty }: Props) {
  const [weather, setWeather] = useState<Weather | null>(null);
  const [aerial, setAerial] = useState<Aerial | null>(null);
  const [aerialLoading, setAerialLoading] = useState(false);
  const [showVideo, setShowVideo] = useState(false);
  const [property, setProperty] = useState<AttomProperty | null>(null);
  const [propertyError, setPropertyError] = useState<string>("");

  useEffect(() => {
    if (!address?.lat || !address?.lng) return;
    fetch(`/api/weather?lat=${address.lat}&lng=${address.lng}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setWeather(d))
      .catch(() => {});
  }, [address?.lat, address?.lng]);

  useEffect(() => {
    if (!address?.formatted || !address?.lat) return;
    setProperty(null);
    setPropertyError("");
    const url = `/api/property?address=${encodeURIComponent(address.formatted)}&lat=${address.lat}&lng=${address.lng}`;
    fetch(url)
      .then(async (r) => {
        if (r.ok) return r.json();
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error ?? `property_${r.status}`);
      })
      .then((d: AttomProperty) => {
        setProperty(d);
        onProperty?.(d);
      })
      .catch((err) => {
        setPropertyError(err instanceof Error ? err.message : "failed");
        onProperty?.(null);
      });
  }, [address?.formatted, address?.lat, address?.lng, onProperty]);

  const requestAerial = async () => {
    if (!address?.formatted) return;
    setAerialLoading(true);
    try {
      let res = await fetch(`/api/aerial?address=${encodeURIComponent(address.formatted)}`);
      let data: Aerial = await res.json();
      if (!data.videoMp4 && data.state !== "ACTIVE") {
        await fetch("/api/aerial", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: address.formatted }),
        });
        await new Promise((r) => setTimeout(r, 2500));
        res = await fetch(`/api/aerial?address=${encodeURIComponent(address.formatted)}`);
        data = await res.json();
      }
      setAerial(data);
      if (data.videoMp4) setShowVideo(true);
    } finally {
      setAerialLoading(false);
    }
  };

  if (!address?.lat) return null;

  return (
    <div className="glass rounded-3xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="font-display font-semibold tracking-tight text-[15px]">Property Context</div>
        <button
          onClick={requestAerial}
          disabled={aerialLoading}
          className="btn btn-ghost py-1.5 px-3 text-[12px]"
        >
          {aerialLoading ? <Loader2 size={12} className="animate-spin" /> : <Film size={12} />}
          {aerial?.videoMp4 ? "Replay" : "3D Flyover"}
        </button>
      </div>

      {/* ATTOM property facts */}
      {property && (
        <div className="grid grid-cols-3 gap-1.5">
          <Stat
            icon={<Building2 size={12} />}
            value={property.storyCount != null ? `${property.storyCount}` : "—"}
            label={(property.storyCount ?? 0) === 1 ? "story" : "stories"}
          />
          <Stat
            icon={<Calendar size={12} />}
            value={property.yearBuilt ? String(property.yearBuilt) : "—"}
            label="built"
          />
          <Stat
            icon={<Home size={12} />}
            value={property.buildingSqft ? property.buildingSqft.toLocaleString() : "—"}
            unit="sf"
            label="house"
          />
        </div>
      )}

      {(property?.beds != null || property?.baths != null || property?.lotSqft) && (
        <div className="rounded-xl border border-white/[0.05] bg-white/[0.015] px-3 py-2 flex items-center justify-between text-[11.5px]">
          <span className="text-slate-400 font-mono">
            {property?.propertyType ?? "Residential"}
          </span>
          <div className="flex items-center gap-3 font-mono tabular text-slate-300">
            {property?.beds != null && <span>{property.beds} bd</span>}
            {property?.baths != null && <span>{property.baths} ba</span>}
            {property?.lotSqft && (
              <span>
                {property.lotSqft >= 43_560
                  ? `${(property.lotSqft / 43_560).toFixed(2)} ac`
                  : `${property.lotSqft.toLocaleString()} sf lot`}
              </span>
            )}
          </div>
        </div>
      )}

      {!property && propertyError && (
        <div className="text-[10.5px] text-slate-500 italic">
          {propertyError === "not_found"
            ? "ATTOM has no record for this address."
            : "Property data unavailable."}
        </div>
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

      {aerial?.state === "PROCESSING" && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber/[0.08] border border-amber/20 text-[12px] text-amber">
          <Loader2 size={12} className="animate-spin" />
          Rendering aerial flyover · ~30s
        </div>
      )}
      {aerial?.state === "FAILED" && (
        <div className="px-3 py-2 rounded-lg bg-rose/[0.08] border border-rose/20 text-[12px] text-rose">
          Aerial flyover unavailable for this property.
        </div>
      )}
      {aerial?.image && !showVideo && (
        <button
          onClick={() => setShowVideo(!!aerial.videoMp4)}
          className="relative block w-full overflow-hidden rounded-2xl border border-white/[0.08] group"
        >
          <img src={aerial.image} alt="Aerial view" className="w-full h-44 object-cover transition group-hover:scale-[1.02]" />
          {aerial.videoMp4 && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition">
              <div className="bg-white/95 text-slate-900 rounded-full p-3.5 shadow-2xl">
                <Play size={18} fill="currentColor" />
              </div>
            </div>
          )}
        </button>
      )}
      {showVideo && aerial?.videoMp4 && (
        <video
          src={aerial.videoMp4}
          autoPlay
          loop
          muted
          playsInline
          controls
          className="w-full rounded-2xl border border-white/[0.08]"
        />
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
