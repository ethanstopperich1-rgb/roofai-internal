"use client";

import { useEffect, useMemo, useState } from "react";
import { CloudHail, Tornado, Wind, Loader2, MapPin, Radio } from "lucide-react";

interface StormEvent {
  type: string;
  date: string | null;
  magnitude: number | null;
  magnitudeType: string | null;
  distanceMiles: number | null;
  remark?: string;
}

interface StormSummary {
  total: number;
  hailCount: number;
  tornadoCount: number;
  windCount: number;
  maxHailInches: number | null;
  radiusMiles: number;
  daysBack: number;
  source: string;
}

interface ApiResp {
  events: StormEvent[];
  summary: StormSummary;
  error?: string;
}

const WINDOWS = [
  { key: 1, label: "24h" },
  { key: 7, label: "7 days" },
  { key: 30, label: "30 days" },
] as const;
type WindowKey = (typeof WINDOWS)[number]["key"];

const RADII = [3, 5, 10, 20] as const;
type RadiusMi = (typeof RADII)[number];

/**
 * Recency-focused storm card. Backed by IEM Local Storm Reports (T+1h,
 * NWS-issued), this is the "did Oviedo get hit YESTERDAY?" view —
 * complements the historical /api/storms (5yr NOAA SPC) which lives in
 * the existing StormHistoryCard.
 *
 * Designed for the rep proposal drawer: tight footprint, clear time/
 * distance pills, no map (the proposal already has a satellite view).
 */
export default function RecentStormCard({
  lat,
  lng,
  defaultWindow = 7,
  defaultRadius = 10,
  cityLabel,
}: {
  lat?: number;
  lng?: number;
  defaultWindow?: WindowKey;
  defaultRadius?: RadiusMi;
  cityLabel?: string;
}) {
  const [windowKey, setWindowKey] = useState<WindowKey>(defaultWindow);
  const [radius, setRadius] = useState<RadiusMi>(defaultRadius);
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (lat == null || lng == null) return;
    setLoading(true);
    setError("");
    const ctrl = new AbortController();
    fetch(
      `/api/storms/recent?lat=${lat}&lng=${lng}&radiusMiles=${radius}&daysBack=${windowKey}`,
      { signal: ctrl.signal },
    )
      .then(async (r) => {
        const j = (await r.json()) as ApiResp;
        if (!r.ok) throw new Error(j.error || `http_${r.status}`);
        setData(j);
      })
      .catch((e) => {
        if (e?.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to fetch");
        setData(null);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [lat, lng, radius, windowKey]);

  const hasCoords = lat != null && lng != null;
  const s = data?.summary;
  const events = data?.events ?? [];

  const headline = useMemo(() => {
    if (!s || s.total === 0) return null;
    const parts: string[] = [];
    if (s.hailCount > 0) {
      parts.push(
        s.maxHailInches
          ? `${s.hailCount} hail report${s.hailCount === 1 ? "" : "s"} · max ${s.maxHailInches.toFixed(2)}"`
          : `${s.hailCount} hail report${s.hailCount === 1 ? "" : "s"}`,
      );
    }
    if (s.tornadoCount > 0) parts.push(`${s.tornadoCount} tornado`);
    if (s.windCount > 0)
      parts.push(`${s.windCount} damaging-wind report${s.windCount === 1 ? "" : "s"}`);
    return parts.join(" · ");
  }, [s]);

  return (
    <section className="glass-panel p-5">
      <header className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-start gap-2.5 min-w-0">
          <div className="rounded-lg border border-cy-300/30 bg-cy-300/[0.06] p-1.5 mt-0.5">
            <Radio className="w-4 h-4 text-cy-300" aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.16em] text-white/45 font-mono">
              Recent severe weather · IEM LSR
            </div>
            <div className="text-[14px] font-semibold text-white mt-0.5 truncate">
              {cityLabel ? `Near ${cityLabel}` : "Near this property"}
            </div>
          </div>
        </div>
      </header>

      {/* Time + radius pills */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div
          role="tablist"
          aria-label="Time window"
          className="inline-flex items-center gap-1 p-1 rounded-full bg-white/[0.04] border border-white/[0.06]"
        >
          {WINDOWS.map((w) => {
            const active = w.key === windowKey;
            return (
              <button
                key={w.key}
                role="tab"
                aria-selected={active}
                onClick={() => setWindowKey(w.key)}
                className={[
                  "px-2.5 py-1 rounded-full text-[11.5px] font-medium transition-colors",
                  active
                    ? "bg-cy-300/15 text-cy-300 border border-cy-300/30"
                    : "text-white/65 hover:text-white border border-transparent",
                ].join(" ")}
              >
                {w.label}
              </button>
            );
          })}
        </div>
        <div className="inline-flex items-center gap-1 p-1 rounded-full bg-white/[0.04] border border-white/[0.06]">
          {RADII.map((r) => {
            const active = r === radius;
            return (
              <button
                key={r}
                onClick={() => setRadius(r)}
                aria-pressed={active}
                className={[
                  "px-2.5 py-1 rounded-full text-[11.5px] font-mono tabular transition-colors",
                  active
                    ? "bg-white/[0.08] text-white border border-white/15"
                    : "text-white/55 hover:text-white/85 border border-transparent",
                ].join(" ")}
              >
                {r}mi
              </button>
            );
          })}
        </div>
      </div>

      {/* States */}
      {!hasCoords && (
        <EmptyHint text="No coordinates on this proposal — can't query storms." />
      )}

      {hasCoords && loading && (
        <div className="flex items-center gap-2 text-[12.5px] text-white/55 py-2">
          <Loader2 size={14} className="animate-spin" /> Querying recent storm
          reports…
        </div>
      )}

      {hasCoords && !loading && error && (
        <div className="text-[12.5px] text-rose-400/90 py-2 px-3 rounded-lg bg-rose-400/[0.04] border border-rose-400/15">
          <div>Storm feed is taking a moment — try again in a few seconds.</div>
          <div className="text-[10.5px] text-white/40 mt-1 font-mono tabular">
            ref: {error}
          </div>
        </div>
      )}

      {hasCoords && !loading && !error && s && s.total === 0 && (
        <div className="text-[12.5px] text-white/55 py-2 px-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
          <div>
            No severe-weather reports within {radius} mi over the last{" "}
            {windowKey === 1 ? "24 hours" : `${windowKey} days`}.
          </div>
          {/* Escalation affordance — on quiet weeks the default 7d/10mi
              comes back empty and the card reads like a dead surface.
              Offer one-click expansion to the next-larger window so the
              rep / demo audience sees the system reaching further. */}
          {windowKey < 30 && (
            <button
              type="button"
              onClick={() =>
                setWindowKey(windowKey === 1 ? 7 : 30)
              }
              className="mt-2 inline-flex items-center gap-1.5 text-[11.5px] text-cy-300 hover:text-white transition-colors"
            >
              Look back {windowKey === 1 ? "7 days" : "30 days"} instead →
            </button>
          )}
          {windowKey === 30 && radius < 20 && (
            <button
              type="button"
              onClick={() => setRadius(20)}
              className="mt-2 inline-flex items-center gap-1.5 text-[11.5px] text-cy-300 hover:text-white transition-colors"
            >
              Widen radius to 20 mi →
            </button>
          )}
        </div>
      )}

      {hasCoords && !loading && !error && s && s.total > 0 && (
        <>
          <div className="mb-3 px-3 py-2.5 rounded-lg bg-cy-300/[0.04] border border-cy-300/15">
            <div className="text-[12.5px] text-white/90 font-medium">
              {headline}
            </div>
            <div className="text-[10.5px] text-white/45 font-mono tabular mt-0.5">
              {s.total} total event{s.total === 1 ? "" : "s"} · {radius}-mile
              radius · last {windowKey === 1 ? "24h" : `${windowKey}d`}
            </div>
          </div>

          <ul className="flex flex-col divide-y divide-white/[0.05] max-h-[280px] overflow-y-auto -mx-1">
            {events.slice(0, 20).map((e, i) => (
              <li
                key={`${e.date}-${i}`}
                className="px-1 py-2 flex items-start gap-3"
              >
                <EventIcon type={e.type} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2 flex-wrap">
                    <span className="text-[12.5px] font-medium text-white/95 capitalize">
                      {e.type}
                      {e.magnitude != null && (
                        <span className="text-cy-300 font-mono tabular ml-1.5">
                          {e.type === "hail"
                            ? `${e.magnitude.toFixed(2)}"`
                            : e.magnitude}
                          {e.type !== "hail" && e.magnitudeType
                            ? ` ${e.magnitudeType}`
                            : ""}
                        </span>
                      )}
                    </span>
                    <span className="text-[11px] font-mono tabular text-white/55 whitespace-nowrap">
                      {formatTimeAgo(e.date)}
                      {e.distanceMiles != null && (
                        <>
                          {" · "}
                          {e.distanceMiles.toFixed(1)} mi
                        </>
                      )}
                    </span>
                  </div>
                  {e.remark && (
                    <div className="text-[11px] text-white/55 mt-0.5 line-clamp-2 leading-snug">
                      {e.remark}
                    </div>
                  )}
                </div>
              </li>
            ))}
            {events.length > 20 && (
              <li className="px-1 py-2 text-[11px] text-white/45 font-mono tabular">
                +{events.length - 20} more — narrow the radius to focus
              </li>
            )}
          </ul>
        </>
      )}

      <footer className="mt-4 pt-3 border-t border-white/[0.04] text-[10.5px] text-white/40 flex items-center gap-1.5">
        <MapPin size={10} />
        Source: NWS Local Storm Reports via Iowa Environmental Mesonet · 10-min
        cache · public records
      </footer>
    </section>
  );
}

/* ─── Subcomponents ──────────────────────────────────────────────────── */

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="text-[12.5px] text-white/55 py-2 px-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
      {text}
    </div>
  );
}

function EventIcon({ type }: { type: string }) {
  const cls = "w-3.5 h-3.5 flex-shrink-0 mt-0.5";
  if (type === "hail")
    return <CloudHail className={`${cls} text-cy-300`} aria-hidden />;
  if (type === "tornado")
    return <Tornado className={`${cls} text-rose-400`} aria-hidden />;
  return <Wind className={`${cls} text-amber-300`} aria-hidden />;
}

function formatTimeAgo(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diffMs = Date.now() - t;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
