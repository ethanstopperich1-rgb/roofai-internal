"use client";

import { useEffect, useState } from "react";
import { Cloud, Wind, Film, Loader2, Play } from "lucide-react";
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

export default function PropertyContextPanel({ address }: { address: AddressInfo | null }) {
  const [weather, setWeather] = useState<Weather | null>(null);
  const [aerial, setAerial] = useState<Aerial | null>(null);
  const [aerialLoading, setAerialLoading] = useState(false);
  const [showVideo, setShowVideo] = useState(false);

  useEffect(() => {
    if (!address?.lat || !address?.lng) return;
    fetch(`/api/weather?lat=${address.lat}&lng=${address.lng}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setWeather(d))
      .catch(() => {});
  }, [address?.lat, address?.lng]);

  const requestAerial = async () => {
    if (!address?.formatted) return;
    setAerialLoading(true);
    try {
      // Try lookup first
      let res = await fetch(`/api/aerial?address=${encodeURIComponent(address.formatted)}`);
      let data: Aerial = await res.json();
      // If not yet rendered, kick off a render
      if (!data.videoMp4 && data.state !== "ACTIVE") {
        await fetch("/api/aerial", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: address.formatted }),
        });
        // Re-poll once after a short wait
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
    <div className="glass rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="font-bold">Property Context</div>
        <button
          className="btn btn-ghost py-1.5 px-3 text-sm"
          onClick={requestAerial}
          disabled={aerialLoading}
        >
          {aerialLoading ? <Loader2 size={14} className="animate-spin" /> : <Film size={14} />}
          {aerial?.videoMp4 ? "Replay Flyover" : "3D Flyover"}
        </button>
      </div>

      {weather && (
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat
            icon={<Cloud size={14} className="text-sky-400" />}
            label={weather.description ?? "—"}
            value={weather.tempF != null ? `${weather.tempF}°F` : "—"}
          />
          <Stat
            icon={<Wind size={14} className="text-sky-400" />}
            label="Wind"
            value={weather.windMph != null ? `${weather.windMph} mph ${weather.windDir ?? ""}` : "—"}
          />
          <Stat label="Humidity" value={weather.humidity != null ? `${weather.humidity}%` : "—"} />
        </div>
      )}

      {aerial?.state === "PROCESSING" && (
        <div className="text-xs text-amber-300">
          Aerial flyover is rendering for this address. Try again in ~30 seconds.
        </div>
      )}
      {aerial?.state === "FAILED" && (
        <div className="text-xs text-rose-300">Aerial flyover unavailable for this property.</div>
      )}
      {aerial?.image && !showVideo && (
        <button
          onClick={() => setShowVideo(!!aerial.videoMp4)}
          className="relative block w-full overflow-hidden rounded-xl border border-white/10"
        >
          <img src={aerial.image} alt="Aerial view" className="w-full h-44 object-cover" />
          {aerial.videoMp4 && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30">
              <div className="bg-white/90 text-slate-900 rounded-full p-3">
                <Play size={20} fill="currentColor" />
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
          className="w-full rounded-xl border border-white/10"
        />
      )}
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-400 flex items-center justify-center gap-1">
        {icon} {label}
      </div>
      <div className="font-semibold mt-0.5 truncate text-sm">{value}</div>
    </div>
  );
}
