"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CloudHail,
  Crosshair,
  Loader2,
  Radar,
  Tornado,
  Wind,
  Home,
  CalendarClock,
  TrendingUp,
} from "lucide-react";

/**
 * components/StormHistoryCard.tsx
 *
 * Multi-source storm history surface for the rep tool. Pulls four
 * independent datasets in parallel and stitches them into one card:
 *
 *   1. NOAA SPC (BigQuery)       → human-filed Local Storm Reports
 *                                   (legal "documented event" record).
 *      `/api/storms`
 *
 *   2. NOAA MRMS (radar grid)    → 1km radar-derived hail estimates,
 *                                   catches sub-1" events SPC misses.
 *      `/api/hail-mrms`
 *
 *   3. Recent significant event  → most-recent ≥0.75" hail, joined
 *                                   with same-day ground-report count
 *                                   for cross-source validation.
 *      `/api/storms/recent-significant`
 *
 *   4. Canvass-area density      → OSM building count within the
 *                                   selected radius — answers the
 *                                   "how many neighbours got hit too"
 *                                   question reps need for door-knock
 *                                   prioritization.
 *      `/api/storms/canvass-area`
 *
 * Visual layout (top → bottom):
 *   • Header with radius selector
 *   • "Closest event to this address" hero (when significant)
 *   • 3-stat strip: hail / wind / tornado counts
 *   • Verified-incident card (recent-significant + ground-report cross-ref)
 *   • Canvass-density chip
 *   • Expandable event list (SPC + MRMS, sortable by proximity)
 *
 * The card auto-hides until lat/lng are provided. Errors degrade
 * silently per sub-feed — never blocks the whole card. Tighter type
 * hierarchy and more generous whitespace than the prior version.
 */

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

interface SpcResp {
  events: StormEvent[];
  summary: StormSummary;
  error?: string;
}

interface MrmsEvent {
  date: string;
  maxInches: number;
  maxMm: number;
  hitCount: number;
  distanceMiles: number;
}

interface MrmsResp {
  events: MrmsEvent[];
  source: string;
  coverage: { yearsAvailable: number; earliestDate: string | null; latestDate: string | null };
}

interface RecentSignificantResp {
  event: {
    date: string;
    maxInches: number;
    hitCount: number;
    distanceMiles: number;
    groundReportCount: number;
    source: "mrms+spc";
  } | null;
  coverage: { lat: number; lng: number; radiusMiles: number; minInches: number };
  queriedAt: string;
}

interface CanvassAreaResp {
  buildingCount: number;
  countedAt: string;
  source: "osm-overpass";
  isEstimate: boolean;
  query: { lat: number; lng: number; radiusMiles: number };
}

const RADIUS_OPTIONS = [1, 3, 5, 10] as const;
type RadiusMi = (typeof RADIUS_OPTIONS)[number];

export default function StormHistoryCard({ lat, lng }: { lat?: number; lng?: number }) {
  const [spc, setSpc] = useState<SpcResp | null>(null);
  const [mrms, setMrms] = useState<MrmsResp | null>(null);
  const [recent, setRecent] = useState<RecentSignificantResp | null>(null);
  const [canvass, setCanvass] = useState<CanvassAreaResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [expanded, setExpanded] = useState(false);
  const [radiusMi, setRadiusMi] = useState<RadiusMi>(5);

  useEffect(() => {
    if (lat == null || lng == null) return;
    setLoading(true);
    setError("");
    setSpc(null);
    setMrms(null);
    setRecent(null);
    setCanvass(null);

    // Four parallel feeds — each fails silently to keep the card up.
    // SPC is the only "must succeed" feed; if it fails we show the
    // error chip. MRMS/recent/canvass degrade quietly.
    Promise.all([
      fetch(`/api/storms?lat=${lat}&lng=${lng}&radiusMiles=${radiusMi}&yearsBack=5`)
        .then(async (r) => {
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || `storms_${r.status}`);
          return d as SpcResp;
        })
        .then(setSpc),
      fetch(
        `/api/hail-mrms?lat=${lat}&lng=${lng}&yearsBack=2` +
          `&radiusMiles=${Math.min(5, radiusMi)}&minInches=0.75`,
      )
        .then((r) => (r.ok ? (r.json() as Promise<MrmsResp>) : null))
        .then((d) => setMrms(d ?? null))
        .catch(() => undefined),
      fetch(
        `/api/storms/recent-significant?lat=${lat}&lng=${lng}` +
          `&radiusMiles=${Math.min(5, radiusMi)}&minInches=0.75`,
      )
        .then((r) => (r.ok ? (r.json() as Promise<RecentSignificantResp>) : null))
        .then((d) => setRecent(d ?? null))
        .catch(() => undefined),
      fetch(`/api/storms/canvass-area?lat=${lat}&lng=${lng}&radiusMiles=${radiusMi}`)
        .then((r) => (r.ok ? (r.json() as Promise<CanvassAreaResp>) : null))
        .then((d) => setCanvass(d ?? null))
        .catch(() => undefined),
    ])
      .catch((e) => setError(e instanceof Error ? e.message : "failed"))
      .finally(() => setLoading(false));
  }, [lat, lng, radiusMi]);

  const sortedEvents = useMemo(() => {
    if (!spc?.events) return [];
    return [...spc.events].sort((a, b) => {
      const da = a.distanceMiles ?? Infinity;
      const db = b.distanceMiles ?? Infinity;
      if (Math.abs(da - db) > 0.05) return da - db;
      const ta = a.date ? new Date(a.date).getTime() : 0;
      const tb = b.date ? new Date(b.date).getTime() : 0;
      return tb - ta;
    });
  }, [spc?.events]);

  const closestSignificant = useMemo(() => {
    if (!spc?.events?.length) return null;
    const scored = spc.events
      .filter((e) => e.distanceMiles != null)
      .map((e) => {
        let priority = 0;
        if (/tornado/i.test(e.type)) priority = 4;
        else if (/hail/i.test(e.type)) priority = 3;
        else if (/wind/i.test(e.type)) priority = 1;
        return { e, priority };
      });
    if (!scored.length) return null;
    scored.sort((x, y) => {
      if (x.priority !== y.priority) return y.priority - x.priority;
      const dx = x.e.distanceMiles ?? Infinity;
      const dy = y.e.distanceMiles ?? Infinity;
      if (Math.abs(dx - dy) > 0.05) return dx - dy;
      return (y.e.magnitude ?? 0) - (x.e.magnitude ?? 0);
    });
    return scored[0]?.e ?? null;
  }, [spc?.events]);

  if (lat == null || lng == null) return null;
  if (!loading && !error && !spc) return null;

  const s = spc?.summary;
  const events = sortedEvents;
  const significantHail = (s?.maxHailInches ?? 0) >= 0.75;
  const tornadoCount = s?.tornadoCount ?? 0;
  const insuranceWorthy = significantHail || tornadoCount > 0;

  return (
    <section
      className={`glass-panel relative overflow-hidden ${
        insuranceWorthy ? "ring-1 ring-amber/30" : ""
      }`}
      aria-label="Storm history for this address"
    >
      {/* Tinted ambient wash when the address has insurance-worthy events.
          Pulled into the corner so the hero stat reads first. */}
      {insuranceWorthy && (
        <div
          aria-hidden
          className="absolute -top-16 -right-10 w-64 h-64 blur-3xl pointer-events-none opacity-60"
          style={{
            background:
              "radial-gradient(closest-side, rgba(243,177,75,0.20), transparent)",
          }}
        />
      )}

      {/* ─── Header strip ────────────────────────────────────────────── */}
      <header className="relative flex items-start justify-between gap-4 px-5 pt-5 pb-4">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className={`w-9 h-9 rounded-xl flex-shrink-0 flex items-center justify-center mt-0.5 ${
              insuranceWorthy
                ? "bg-amber/12 border border-amber/35 text-amber"
                : "bg-cy-300/10 border border-cy-300/20 text-cy-300"
            }`}
          >
            <CloudHail size={15} />
          </div>
          <div className="min-w-0">
            <h2 className="font-display font-semibold tracking-tight text-[15.5px] leading-tight">
              Storm history
            </h2>
            <div className="mt-0.5 text-[10.5px] font-mono uppercase tracking-[0.16em] text-slate-500">
              Ground reports · Radar · last 5 yr · {radiusMi} mi
            </div>
          </div>
        </div>
        <div
          role="radiogroup"
          aria-label="Search radius"
          className="flex-shrink-0 flex items-center gap-0.5 rounded-lg p-0.5 border border-white/[0.06] bg-white/[0.02]"
        >
          {RADIUS_OPTIONS.map((mi) => (
            <button
              key={mi}
              type="button"
              onClick={() => setRadiusMi(mi)}
              className={`px-2 py-1 rounded-md text-[10.5px] font-mono uppercase tracking-[0.1em] transition-colors ${
                radiusMi === mi
                  ? "bg-cy-300 text-[#051019] font-semibold shadow-[0_0_0_1px_rgba(56,197,238,0.4)]"
                  : "text-slate-400 hover:text-slate-100"
              }`}
              role="radio"
              aria-checked={radiusMi === mi}
            >
              {mi}mi
            </button>
          ))}
        </div>
      </header>

      {/* ─── Body ────────────────────────────────────────────────────── */}
      <div className="relative px-5 pb-5">
        {insuranceWorthy && (
          <div className="-mt-1 mb-4">
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-mono text-[10.5px] uppercase tracking-[0.12em]"
              style={{
                background: "rgba(243,177,75,0.12)",
                border: "1px solid rgba(243,177,75,0.40)",
                color: "#f3b14b",
              }}
            >
              <Crosshair size={11} /> Insurance candidate
            </span>
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-[12.5px] text-slate-400 py-2">
            <Loader2 size={13} className="animate-spin text-cy-300" />
            Cross-checking ground reports, radar, and parcel data…
          </div>
        )}

        {error && !loading && (
          <div className="text-[12px] text-slate-500 italic leading-relaxed">
            Storm data unavailable.
          </div>
        )}

        {!loading && !error && spc && (
          <div className="space-y-4">
            {/* ─── Closest-to-property hero ─────────────────────────── */}
            {closestSignificant && closestSignificant.distanceMiles != null && (
              <ClosestEventHero event={closestSignificant} />
            )}

            {/* ─── 3-stat strip — hail / wind / tornado ─────────────── */}
            <div className="grid grid-cols-3 gap-2">
              <Stat
                icon={<CloudHail size={13} />}
                value={s ? String(s.hailCount) : "—"}
                label="Hail"
                accent={(s?.hailCount ?? 0) > 0}
              />
              <Stat
                icon={<Wind size={13} />}
                value={s ? String(s.windCount) : "—"}
                label="Wind"
                accent={(s?.windCount ?? 0) > 0}
              />
              <Stat
                icon={<Tornado size={13} />}
                value={s ? String(tornadoCount) : "—"}
                label="Tornado"
                accent={tornadoCount > 0}
                tone={tornadoCount > 0 ? "rose" : "amber"}
              />
            </div>

            {/* ─── Verified-incident card (recent-significant) ──────── */}
            {recent?.event && (
              <VerifiedIncidentCard event={recent.event} />
            )}

            {/* ─── Largest hail callout (when significant) ──────────── */}
            {s?.maxHailInches != null && s.maxHailInches > 0 && (
              <div
                className={`rounded-xl border px-3.5 py-2.5 text-[12.5px] flex items-center gap-2 ${
                  significantHail
                    ? "border-amber/30 bg-amber/[0.06] text-amber"
                    : "border-white/[0.06] bg-white/[0.02] text-slate-300"
                }`}
              >
                <TrendingUp size={13} className="flex-shrink-0" />
                <span className="flex-1">
                  Largest reported hail (5 yr):{" "}
                  <span className="font-mono tabular font-semibold">
                    {s.maxHailInches}″
                  </span>
                  {significantHail && (
                    <span className="text-slate-300/80"> · qualifies as severe (NWS)</span>
                  )}
                </span>
              </div>
            )}

            {/* ─── Canvass density chip ─────────────────────────────── */}
            {canvass && (
              <CanvassDensityChip
                count={canvass.buildingCount}
                radiusMi={radiusMi}
                isEstimate={canvass.isEstimate}
              />
            )}

            {/* ─── Expandable SPC + MRMS event lists ────────────────── */}
            {events.length > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="w-full text-[11px] font-mono uppercase tracking-[0.14em] text-slate-500 hover:text-slate-200 transition-colors py-2 border-t border-white/[0.04]"
              >
                {expanded ? "Hide" : "Show"} {events.length} event
                {events.length === 1 ? "" : "s"} · sorted by proximity
              </button>
            )}

            {expanded && events.length > 0 && (
              <ul className="space-y-1 max-h-64 overflow-auto pr-1 -mr-1">
                {events.map((e, i) => (
                  <EventRow key={i} event={e} />
                ))}
              </ul>
            )}

            {events.length === 0 && !loading && (
              <div className="text-[12.5px] text-slate-500 italic leading-relaxed">
                No reported severe weather within {s?.radiusMiles ?? radiusMi} mi
                over the last 5 years.
                {radiusMi < 10 && " Try a wider radius."}
              </div>
            )}

            {/* ─── MRMS radar block ─────────────────────────────────── */}
            {mrms && mrms.events.length > 0 && (
              <MrmsBlock mrms={mrms} radiusMi={Math.min(5, radiusMi)} />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────

function ClosestEventHero({ event }: { event: StormEvent }) {
  const dist = event.distanceMiles ?? 0;
  const onProperty = dist <= 0.5;
  const adjacent = dist > 0.5 && dist <= 1.5;
  const accent = onProperty
    ? "border-amber/45 bg-amber/[0.10]"
    : adjacent
    ? "border-amber/25 bg-amber/[0.04]"
    : "border-white/[0.06] bg-white/[0.02]";
  return (
    <div className={`rounded-xl border ${accent} px-4 py-3`}>
      <div className="flex items-center gap-2 text-[10.5px] font-mono uppercase tracking-[0.14em] text-slate-400 mb-1.5">
        <Crosshair size={11} className="text-cy-300" />
        <span>Closest event to this address</span>
      </div>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-display tabular text-[26px] font-semibold leading-none tracking-tight text-slate-50">
          {dist.toFixed(1)}
          <span className="text-[16px] text-slate-400 font-medium ml-1">mi</span>
        </span>
        <span className="text-[12.5px] text-slate-300">
          away ·{" "}
          <span className="text-slate-50 font-medium">{event.type}</span>
          {event.magnitude != null && (
            <span className="font-mono tabular text-amber ml-1.5">
              {event.magnitude}
              {/hail/i.test(event.type)
                ? "″"
                : event.magnitudeType
                ? ` ${event.magnitudeType}`
                : ""}
            </span>
          )}
        </span>
      </div>
      <div className="text-[11.5px] text-slate-400 mt-1.5 flex items-center gap-1.5">
        <CalendarClock size={11} className="text-slate-500" />
        {event.date
          ? new Date(event.date).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })
          : "—"}
        {onProperty && (
          <span className="ml-1.5 text-amber font-medium">
            · likely hit this property
          </span>
        )}
      </div>
    </div>
  );
}

function VerifiedIncidentCard({
  event,
}: {
  event: NonNullable<RecentSignificantResp["event"]>;
}) {
  const dateStr = `${event.date.slice(4, 6)}/${event.date.slice(6, 8)}/${event.date.slice(2, 4)}`;
  const grounded = event.groundReportCount > 0;
  return (
    <div
      className={`rounded-xl border px-3.5 py-2.5 ${
        grounded
          ? "border-mint/25 bg-mint/[0.04]"
          : "border-cy-300/15 bg-cy-300/[0.03]"
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 text-[10.5px] font-mono uppercase tracking-[0.14em] text-slate-400">
          <Radar size={11} className={grounded ? "text-mint" : "text-cy-300"} />
          <span>Verified incident</span>
        </div>
        {grounded && (
          <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-mint">
            ✓ {event.groundReportCount} ground report
            {event.groundReportCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-display tabular text-[19px] font-semibold tracking-tight text-slate-50">
          {event.maxInches.toFixed(2)}″
        </span>
        <span className="text-[12px] text-slate-300">
          hail · {event.distanceMiles.toFixed(1)} mi away · {dateStr}
        </span>
      </div>
      <div className="text-[11px] text-slate-500 mt-1 font-mono tracking-wide">
        Radar detected ({event.hitCount} cell{event.hitCount === 1 ? "" : "s"})
        {grounded ? " · confirmed by ground reports" : " · no ground report filed"}
      </div>
    </div>
  );
}

function CanvassDensityChip({
  count,
  radiusMi,
  isEstimate,
}: {
  count: number;
  radiusMi: number;
  isEstimate: boolean;
}) {
  if (count === 0) return null;
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5">
      <div className="w-7 h-7 rounded-lg bg-cy-300/10 border border-cy-300/20 text-cy-300 flex items-center justify-center flex-shrink-0">
        <Home size={13} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] text-slate-100">
          <span className="font-mono tabular font-semibold text-slate-50">
            {count.toLocaleString()}
          </span>{" "}
          structures in {radiusMi}-mile radius
        </div>
        <div className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-slate-500 mt-0.5">
          {isEstimate ? "Regional density estimate" : "OSM building count"} · canvass-eligible
        </div>
      </div>
    </div>
  );
}

function EventRow({ event }: { event: StormEvent }) {
  const onProperty = (event.distanceMiles ?? Infinity) <= 0.5;
  const isHail = event.type === "Hail";
  const isTornado = event.type === "Tornado";
  return (
    <li
      className={`flex items-center justify-between gap-3 px-3 py-1.5 rounded-lg border text-[12px] ${
        onProperty
          ? "border-amber/25 bg-amber/[0.04]"
          : "border-white/[0.04] bg-white/[0.015]"
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        {isHail && <CloudHail size={11} className="text-amber flex-shrink-0" />}
        {isTornado && <Tornado size={11} className="text-rose flex-shrink-0" />}
        {!isHail && !isTornado && (
          <Wind size={11} className="text-slate-400 flex-shrink-0" />
        )}
        <span className="text-slate-200 truncate">{event.type}</span>
        {event.magnitude != null && (
          <span className="font-mono tabular text-slate-500 text-[11px]">
            {event.magnitude}
            {isHail ? "″" : event.magnitudeType ? ` ${event.magnitudeType}` : ""}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 font-mono tabular text-[11px] flex-shrink-0">
        {event.distanceMiles != null && (
          <span className={onProperty ? "text-amber font-semibold" : "text-slate-300"}>
            {event.distanceMiles.toFixed(1)}mi
          </span>
        )}
        <span className="text-slate-500">
          · {event.date ? new Date(event.date).toLocaleDateString() : "—"}
        </span>
      </div>
    </li>
  );
}

function MrmsBlock({ mrms, radiusMi }: { mrms: MrmsResp; radiusMi: number }) {
  return (
    <div className="pt-3 border-t border-white/[0.04] space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-[0.14em] text-cy-300/90">
          <Radar size={11} />
          <span>Radar-detected hail</span>
        </div>
        <span className="text-[10px] font-mono text-slate-500 uppercase tracking-[0.1em]">
          Radar grid · 1km · {radiusMi}mi
        </span>
      </div>
      <ul className="space-y-1 max-h-48 overflow-auto pr-1 -mr-1">
        {mrms.events.slice(0, 6).map((e) => (
          <li
            key={e.date}
            className="flex items-center justify-between gap-3 px-3 py-1.5 rounded-lg border border-cy-300/[0.10] bg-cy-300/[0.025] text-[12px]"
          >
            <div className="flex items-center gap-2">
              <CloudHail size={11} className="text-cy-300" />
              <span className="font-mono tabular text-slate-50 font-medium">
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
          </li>
        ))}
        {mrms.events.length > 6 && (
          <li className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-slate-500 text-center pt-1.5">
            + {mrms.events.length - 6} more days
          </li>
        )}
      </ul>
    </div>
  );
}

function Stat({
  icon,
  value,
  label,
  accent,
  tone = "amber",
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
  accent?: boolean;
  tone?: "amber" | "rose";
}) {
  const accentBorder =
    tone === "rose" ? "border-rose/30 bg-rose/[0.05]" : "border-amber/25 bg-amber/[0.04]";
  const accentText = tone === "rose" ? "text-rose" : "text-amber";
  return (
    <div
      className={`rounded-xl border px-3 py-2.5 text-center ${
        accent ? accentBorder : "border-white/[0.05] bg-white/[0.015]"
      }`}
    >
      <div
        className={`flex justify-center mb-1 ${accent ? accentText : "text-slate-500"}`}
      >
        {icon}
      </div>
      <div
        className={`font-display tabular text-[18px] font-semibold tracking-tight leading-none ${
          accent ? accentText : "text-slate-100"
        }`}
      >
        {value}
      </div>
      <div className="text-[9.5px] font-mono uppercase tracking-[0.14em] text-slate-500 truncate mt-1">
        {label}
      </div>
    </div>
  );
}
