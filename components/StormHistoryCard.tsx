"use client";

import { useEffect, useState } from "react";
import { CloudHail, Loader2, Radar, Tornado, Wind } from "lucide-react";

interface StormEvent {
  type: string;
  date: string | null;
  magnitude: number | null;
  magnitudeType: string | null;
  distanceMiles: number | null;
}

interface StormSummary {
  total: number;
  hailCount: number;
  tornadoCount: number;
  windCount: number;
  maxHailInches: number | null;
  radiusMiles: number;
}

interface ApiResp {
  events: StormEvent[];
  summary: StormSummary;
  error?: string;
}

/** Radar-derived (MRMS) hail event payload from `/api/hail-mrms`. */
interface MrmsEvent {
  date: string; // YYYYMMDD
  maxInches: number;
  maxMm: number;
  hitCount: number;
  distanceMiles: number;
}

interface MrmsResp {
  events: MrmsEvent[];
  source: string;
  coverage: {
    yearsAvailable: number;
    earliestDate: string | null;
    latestDate: string | null;
  };
}

/** Radius options the rep can switch between. 1mi = "this exact roof
 *  / immediate neighbour", 3mi = "one neighbourhood over", 5mi =
 *  "carrier-typical storm exposure radius", 10mi = "wide blast pattern
 *  / canvasser hot-zone". Default is 5mi — matches what most carriers
 *  consider the legitimate severe-weather exposure window. */
const RADIUS_OPTIONS = [1, 3, 5, 10] as const;
type RadiusMi = (typeof RADIUS_OPTIONS)[number];

export default function StormHistoryCard({ lat, lng }: { lat?: number; lng?: number }) {
  const [data, setData] = useState<ApiResp | null>(null);
  const [mrms, setMrms] = useState<MrmsResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [expanded, setExpanded] = useState(false);
  const [radiusMi, setRadiusMi] = useState<RadiusMi>(5);

  useEffect(() => {
    if (lat == null || lng == null) return;
    setLoading(true);
    setError("");
    setData(null);
    setMrms(null);
    // Fire both data sources in parallel — NOAA SPC (human-filed Local
    // Storm Reports via BigQuery) is the legal "documented event"
    // record carriers respect; MRMS is the radar-derived 1km grid that
    // catches sub-1" events SPC misses. Show both, label the source.
    // Both honor the rep-selected `radiusMi` so widening the search
    // updates BOTH lists, not just one.
    Promise.all([
      fetch(`/api/storms?lat=${lat}&lng=${lng}&radiusMiles=${radiusMi}&yearsBack=5`)
        .then(async (r) => {
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || `storms_${r.status}`);
          return d as ApiResp;
        })
        .then(setData),
      // MRMS is best-effort — if the Blob index hasn't been backfilled
      // yet (no GH Actions runs) the route returns an empty events
      // array, and we just don't surface the radar section. Never
      // throws — UX degrades silently to SPC-only.
      // MRMS hard-caps at 5mi server-side (1km cells get noisy past
      // that); when rep picks 10mi, MRMS clamps to 5.
      fetch(
        `/api/hail-mrms?lat=${lat}&lng=${lng}&yearsBack=2&radiusMiles=${Math.min(5, radiusMi)}&minInches=0.75`,
      )
        .then((r) => (r.ok ? (r.json() as Promise<MrmsResp>) : null))
        .then((d) => setMrms(d ?? null))
        .catch(() => undefined),
    ])
      .catch((e) => setError(e instanceof Error ? e.message : "failed"))
      .finally(() => setLoading(false));
  }, [lat, lng, radiusMi]);

  if (lat == null || lng == null) return null;

  const showCard = loading || error || data;
  if (!showCard) return null;

  const s = data?.summary;
  const events = data?.events ?? [];
  const significantHail = (s?.maxHailInches ?? 0) >= 0.75; // 0.75" is the NWS severe hail threshold
  const insuranceWorthy = significantHail || (s?.tornadoCount ?? 0) > 0;

  return (
    <div
      className={`glass rounded-3xl p-5 relative overflow-hidden ${
        insuranceWorthy ? "ring-1 ring-amber/30" : ""
      }`}
    >
      {insuranceWorthy && (
        <div
          className="absolute -top-12 -right-8 w-56 h-56 blur-3xl pointer-events-none opacity-50"
          style={{ background: "radial-gradient(closest-side, rgba(243,177,75,0.18), transparent)" }}
        />
      )}
      <div className="relative flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div
            className={`w-8 h-8 rounded-xl flex items-center justify-center ${
              insuranceWorthy
                ? "bg-amber/10 border border-amber/30 text-amber"
                : "bg-cy-300/10 border border-cy-300/20 text-cy-300"
            }`}
          >
            <CloudHail size={14} />
          </div>
          <div>
            <div className="font-display font-semibold tracking-tight text-[15px]">Storm History</div>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-slate-500 -mt-0.5">
              {radiusMi} mi · 5 yr
            </div>
          </div>
        </div>
        {/* Rep-adjustable radius. Changes refire BOTH SPC and MRMS so
            the lists stay in sync. MRMS clamps to 5mi server-side. */}
        <div className="flex items-center gap-1 rounded-lg p-0.5 border border-white/[0.06] bg-white/[0.02]">
          {RADIUS_OPTIONS.map((mi) => (
            <button
              key={mi}
              onClick={() => setRadiusMi(mi)}
              className={`px-2 py-1 rounded-md text-[10.5px] font-mono uppercase tracking-[0.12em] transition ${
                radiusMi === mi
                  ? "bg-cy-300 text-[#051019] font-semibold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              aria-pressed={radiusMi === mi}
            >
              {mi}mi
            </button>
          ))}
        </div>
        {insuranceWorthy && (
          <span
            className="chip"
            style={{
              background: "rgba(243,177,75,0.12)",
              borderColor: "rgba(243,177,75,0.40)",
              color: "#f3b14b",
            }}
          >
            Insurance candidate
          </span>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-[12px] text-slate-400">
          <Loader2 size={12} className="animate-spin text-cy-300" />
          Loading storm history…
        </div>
      )}

      {error && !loading && (
        <div className="text-[11.5px] text-slate-500 italic leading-relaxed">
          Storm data unavailable.
        </div>
      )}

      {data && !loading && (
        <div className="relative space-y-3">
          <div className="grid grid-cols-3 gap-1.5">
            <Stat
              icon={<CloudHail size={12} />}
              value={s ? String(s.hailCount) : "—"}
              label="hail"
              accent={(s?.hailCount ?? 0) > 0}
            />
            <Stat
              icon={<Wind size={12} />}
              value={s ? String(s.windCount) : "—"}
              label="wind"
              accent={(s?.windCount ?? 0) > 0}
            />
            <Stat
              icon={<Tornado size={12} />}
              value={s ? String(s.tornadoCount) : "—"}
              label="tornado"
              accent={(s?.tornadoCount ?? 0) > 0}
            />
          </div>

          {s?.maxHailInches != null && s.maxHailInches > 0 && (
            <div
              className={`rounded-xl border px-3 py-2 text-[12px] ${
                significantHail
                  ? "border-amber/30 bg-amber/[0.06] text-amber"
                  : "border-white/[0.06] bg-white/[0.02] text-slate-300"
              }`}
            >
              Largest reported hail in 5 yrs:{" "}
              <span className="font-mono tabular font-semibold">{s.maxHailInches}″</span>
              {significantHail && " · qualifies as severe per NWS"}
            </div>
          )}

          {events.length > 0 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="w-full text-[11px] font-mono uppercase tracking-[0.14em] text-slate-500 hover:text-slate-300 transition py-1.5"
            >
              {expanded ? "Hide" : "Show"} {events.length} event{events.length === 1 ? "" : "s"}
            </button>
          )}

          {expanded && events.length > 0 && (
            <div className="space-y-1 max-h-64 overflow-auto">
              {events.map((e, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-3 px-3 py-1.5 rounded-lg border border-white/[0.04] bg-white/[0.012] text-[12px]"
                >
                  <div className="flex items-center gap-2">
                    {e.type === "Hail" && <CloudHail size={11} className="text-amber" />}
                    {e.type === "Tornado" && <Tornado size={11} className="text-rose" />}
                    {e.type !== "Hail" && e.type !== "Tornado" && (
                      <Wind size={11} className="text-slate-400" />
                    )}
                    <span className="text-slate-200 truncate">{e.type}</span>
                    {e.magnitude && (
                      <span className="font-mono tabular text-slate-500 text-[11px]">
                        {e.magnitude}
                        {e.type === "Hail" ? "″" : e.magnitudeType ? ` ${e.magnitudeType}` : ""}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-slate-500 font-mono tabular text-[11px] flex-shrink-0">
                    <span>{e.date ? new Date(e.date).toLocaleDateString() : "—"}</span>
                    {e.distanceMiles != null && <span>· {e.distanceMiles}mi</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {events.length === 0 && (
            <div className="text-[12px] text-slate-500 italic">
              No reported severe weather within {s?.radiusMiles ?? radiusMi} mi over the last 5 years.
              {radiusMi < 10 && " Try a wider radius."}
            </div>
          )}

          {/* Radar-derived hail (NOAA MRMS — 1km radar grid). Surfaces
              when MRMS catches an event SPC missed, OR confirms an SPC
              report with finer resolution. The "+ N more days" copy is
              honest about the difference: SPC = filed reports, MRMS =
              radar-detected (catches sub-1" hail SPC's threshold misses). */}
          {mrms && mrms.events.length > 0 && (
            <div className="pt-3 mt-1 border-t border-white/[0.04] space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-[0.14em] text-cy-300/90">
                  <Radar size={11} />
                  <span>Radar-detected hail</span>
                </div>
                <span className="text-[10px] font-mono text-slate-500">
                  NOAA MRMS · 1km · {Math.min(5, radiusMi)} mi
                </span>
              </div>
              <div className="space-y-1 max-h-48 overflow-auto">
                {mrms.events.slice(0, 6).map((e) => (
                  <div
                    key={e.date}
                    className="flex items-center justify-between gap-3 px-3 py-1.5 rounded-lg border border-cy-300/[0.10] bg-cy-300/[0.025] text-[12px]"
                  >
                    <div className="flex items-center gap-2">
                      <CloudHail size={11} className="text-cy-300" />
                      <span className="font-mono tabular text-slate-100 font-medium">
                        {e.maxInches}″
                      </span>
                      <span className="text-slate-500 text-[11px]">
                        · {e.hitCount} cell{e.hitCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-slate-500 font-mono tabular text-[11px] flex-shrink-0">
                      <span>
                        {e.date.slice(4, 6)}/{e.date.slice(6, 8)}/{e.date.slice(2, 4)}
                      </span>
                      <span>· {e.distanceMiles}mi</span>
                    </div>
                  </div>
                ))}
                {mrms.events.length > 6 && (
                  <div className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-slate-500 text-center pt-1.5">
                    + {mrms.events.length - 6} more days
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({
  icon,
  value,
  label,
  accent,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border px-2.5 py-2 text-center ${
        accent ? "border-amber/25 bg-amber/[0.04]" : "border-white/[0.05] bg-white/[0.015]"
      }`}
    >
      <div className={`flex justify-center mb-0.5 ${accent ? "text-amber" : "text-slate-500"}`}>
        {icon}
      </div>
      <div className={`font-display tabular text-[16px] font-semibold tracking-tight ${accent ? "text-amber" : ""}`}>
        {value}
      </div>
      <div className="text-[9.5px] font-mono uppercase tracking-[0.12em] text-slate-500 truncate mt-0.5">
        {label}
      </div>
    </div>
  );
}
