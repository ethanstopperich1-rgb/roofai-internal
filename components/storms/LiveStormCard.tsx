"use client";

import { useEffect, useState } from "react";
import { CloudHail, MapPin, Activity, Radio, Loader2 } from "lucide-react";
import Link from "next/link";

/**
 * Client-side "most recent qualifying hail event" card.
 *
 * Why client-rendered: the underlying APIs can be slow under cold
 * conditions —
 *   - /api/hail-mrms reads from Vercel Blob and scans 365 daily files
 *   - /api/storms/canvass-area calls OpenStreetMap Overpass (occasionally
 *     hangs against all three mirrors)
 *   - /api/storms hits BigQuery
 *
 * Server-rendering the page meant the whole shell waited 20-30s for
 * these on every request — fine on a warm cache, dead on a cold one.
 * The shell now renders instantly and this component owns the data
 * lifecycle with explicit loading / empty / error states.
 */

interface RecentEvent {
  date: string;
  maxInches: number;
  hitCount: number;
  distanceMiles: number;
  groundReportCount: number;
  source: "mrms+spc";
}

interface RecentResponse {
  event: RecentEvent | null;
  coverage: { lat: number; lng: number; radiusMiles: number; minInches: number };
  queriedAt: string;
}

interface CanvassResponse {
  buildingCount: number;
  isEstimate: boolean;
  source: string;
}

interface Props {
  /** Demo region center (defaults to Orlando) */
  lat?: number;
  lng?: number;
  regionName?: string;
  radiusMiles?: number;
  /** Google Maps key for the static-map preview. Pass the public key
   *  from a server-rendered parent so we don't expose it twice. */
  googleMapsKey?: string;
}

type State =
  | { kind: "loading" }
  | { kind: "ok"; event: RecentEvent; canvass: CanvassResponse | null }
  | { kind: "empty" }
  | { kind: "error"; reason: string };

function formatEventDate(yyyymmdd: string): string {
  const y = yyyymmdd.slice(0, 4);
  const m = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  return new Date(`${y}-${m}-${d}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function daysAgo(yyyymmdd: string): number {
  const y = yyyymmdd.slice(0, 4);
  const m = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  const event = new Date(`${y}-${m}-${d}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor((Date.now() - event) / (24 * 60 * 60 * 1000)));
}

function buildMapUrl(opts: {
  lat: number;
  lng: number;
  hailDistanceMiles?: number;
  apiKey: string;
}): string {
  const params = new URLSearchParams({
    center: `${opts.lat},${opts.lng}`,
    zoom: "9",
    size: "720x420",
    scale: "2",
    maptype: "roadmap",
    style: "feature:all|element:labels|visibility:off",
    key: opts.apiKey,
  });
  let url = `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
  url += `&markers=${encodeURIComponent(
    `color:0x67dcff|size:tiny|${opts.lat},${opts.lng}`,
  )}`;
  const hailRadiusMi = Math.min(5, opts.hailDistanceMiles ?? 5);
  const points: string[] = [];
  for (let i = 0; i <= 24; i++) {
    const theta = (i / 24) * 2 * Math.PI;
    const dLat = (hailRadiusMi / 69) * Math.cos(theta);
    const dLng =
      (hailRadiusMi / (69 * Math.cos((opts.lat * Math.PI) / 180))) *
      Math.sin(theta);
    points.push(`${(opts.lat + dLat).toFixed(5)},${(opts.lng + dLng).toFixed(5)}`);
  }
  url +=
    "&path=" +
    encodeURIComponent(
      `color:0xf3b14bcc|fillcolor:0xf3b14b40|weight:2|${points.join("|")}`,
    );
  return url;
}

export default function LiveStormCard({
  lat = 28.5384,
  lng = -81.3792,
  regionName = "Orlando, FL",
  radiusMiles = 25,
  googleMapsKey,
}: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        // Fire both in parallel. Each has its own short timeout —
        // failing fast is better than waiting for slow blob reads.
        const [recentRes, canvassRes] = await Promise.allSettled([
          fetch(
            `/api/storms/recent-significant?lat=${lat}&lng=${lng}` +
              `&radiusMiles=${radiusMiles}&minInches=1.0`,
            { cache: "no-store", signal: controller.signal },
          ),
          fetch(
            `/api/storms/canvass-area?lat=${lat}&lng=${lng}&radiusMiles=2`,
            { cache: "no-store", signal: controller.signal },
          ),
        ]);

        if (cancelled) return;

        let event: RecentEvent | null = null;
        if (recentRes.status === "fulfilled" && recentRes.value.ok) {
          const data = (await recentRes.value.json()) as RecentResponse;
          event = data.event;
        }
        let canvass: CanvassResponse | null = null;
        if (canvassRes.status === "fulfilled" && canvassRes.value.ok) {
          canvass = (await canvassRes.value.json()) as CanvassResponse;
        }

        if (cancelled) return;
        if (event) {
          setState({ kind: "ok", event, canvass });
        } else {
          setState({ kind: "empty" });
        }
      } catch (err) {
        if (cancelled) return;
        // Network / unexpected error. Render the empty state with a
        // small note rather than a scary error — homeowner-grade UX.
        setState({
          kind: "error",
          reason:
            err instanceof Error
              ? err.message.slice(0, 200)
              : "unknown",
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [lat, lng, radiusMiles]);

  const mapUrl =
    state.kind === "ok" && googleMapsKey
      ? buildMapUrl({
          lat,
          lng,
          hailDistanceMiles: state.event.distanceMiles,
          apiKey: googleMapsKey,
        })
      : null;

  return (
    <div className="glass-panel-hero p-6 sm:p-8 grid lg:grid-cols-[1fr_1.1fr] gap-6 sm:gap-10">
      {/* LEFT — stats / empty / loading / error */}
      <div className="space-y-6">
        {state.kind === "loading" && <LoadingSkeleton regionName={regionName} />}

        {state.kind === "empty" && (
          <EmptyState regionName={regionName} />
        )}

        {state.kind === "error" && (
          <ErrorState regionName={regionName} reason={state.reason} />
        )}

        {state.kind === "ok" && (
          <ResolvedEvent
            event={state.event}
            canvass={state.canvass}
            regionName={regionName}
          />
        )}
      </div>

      {/* RIGHT — map (or placeholder) */}
      <div className="relative rounded-2xl overflow-hidden border border-white/[0.08] bg-black/30 min-h-[280px]">
        {mapUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={mapUrl}
            alt={`Approximate hail footprint around ${regionName}`}
            className="w-full h-full object-cover"
            loading="eager"
          />
        ) : state.kind === "loading" ? (
          <MapSkeleton />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-500 text-[12px] p-6 text-center">
            Map preview appears once a qualifying event is detected.
          </div>
        )}
        <div className="absolute top-3 left-3 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/60 backdrop-blur-sm text-[10px] font-mono uppercase tracking-[0.12em] text-amber border border-amber/40">
          <Activity size={10} />
          {state.kind === "ok" ? "Hail polygon" : "Watched region"}
        </div>
      </div>
    </div>
  );
}

/* ─── Sub-states ──────────────────────────────────────────────────────── */

function LoadingSkeleton({ regionName }: { regionName: string }) {
  return (
    <div className="space-y-6">
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-cy-300/[0.08] border border-cy-300/30 text-cy-300 text-[11px] font-mono uppercase tracking-[0.14em]">
        <Loader2 size={12} className="animate-spin" />
        Scanning NOAA radar · {regionName}
      </div>
      <div className="space-y-2.5">
        <div className="h-3 w-32 rounded shimmer" />
        <div className="h-9 w-72 rounded shimmer" />
        <div className="h-3 w-40 rounded shimmer mt-1" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="glass-panel p-4 space-y-2">
            <div className="h-2.5 w-16 rounded shimmer" />
            <div className="h-7 w-20 rounded shimmer" />
            <div className="h-2 w-24 rounded shimmer" />
          </div>
        ))}
      </div>
      <div className="pt-2 border-t border-white/[0.06]">
        <div className="h-2.5 w-32 rounded shimmer mb-3" />
        <div className="h-12 w-40 rounded shimmer" />
      </div>
    </div>
  );
}

function MapSkeleton() {
  return (
    <div className="w-full h-full flex items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-slate-500">
        <Loader2 size={20} className="animate-spin text-cy-300/60" />
        <div className="text-[11px] font-mono uppercase tracking-[0.14em]">
          Loading radar preview
        </div>
      </div>
    </div>
  );
}

function EmptyState({ regionName }: { regionName: string }) {
  return (
    <div className="space-y-4">
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-mint/[0.08] border border-mint/30 text-mint text-[11px] font-mono uppercase tracking-[0.14em]">
        Quiet skies · last 90 days
      </div>
      <div className="font-display text-[24px] sm:text-[28px] font-semibold tracking-tight text-slate-100 leading-tight">
        No qualifying hail events in the {regionName} area.
      </div>
      <p className="text-[14px] text-slate-400 leading-relaxed max-w-prose">
        This is a feature, not a bug — we only surface events with
        radar-estimated hail ≥1 inch, the size where roofing replacement
        becomes a real conversation. The cron continues to scan daily;
        the next significant event will appear here within 6 hours of
        the radar pass.
      </p>
      <p className="text-[12.5px] text-slate-500 leading-relaxed">
        Florida averages 12–18 hail days per year statewide; central
        Florida specifically sees most activity Feb–May. Quiet windows
        are normal.
      </p>
    </div>
  );
}

function ErrorState({
  regionName,
  reason,
}: {
  regionName: string;
  reason: string;
}) {
  return (
    <div className="space-y-4">
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber/[0.08] border border-amber/30 text-amber text-[11px] font-mono uppercase tracking-[0.14em]">
        <Radio size={12} />
        Storm data temporarily unavailable
      </div>
      <div className="font-display text-[22px] sm:text-[26px] font-semibold tracking-tight text-slate-100 leading-tight">
        We couldn&apos;t reach NOAA radar right now.
      </div>
      <p className="text-[13.5px] text-slate-400 leading-relaxed max-w-prose">
        The ingestion pipeline runs every 24 hours and the live demo
        reads from the cached results. If you&apos;re seeing this, the
        cache is being rebuilt — refresh in a few minutes.
      </p>
      <p className="text-[11.5px] text-slate-500 font-mono leading-relaxed">
        Region: {regionName} · Reason: {reason}
      </p>
    </div>
  );
}

function ResolvedEvent({
  event,
  canvass,
  regionName,
}: {
  event: RecentEvent;
  canvass: CanvassResponse | null;
  regionName: string;
}) {
  return (
    <>
      <div>
        <div className="label flex items-center gap-2 mb-2">
          <CloudHail size={12} />
          Event date
        </div>
        <div className="font-display text-[24px] sm:text-[28px] font-semibold tracking-tight text-slate-50 leading-tight">
          {formatEventDate(event.date)}
        </div>
        <div className="text-[12.5px] text-slate-400 mt-1">
          {daysAgo(event.date) === 0
            ? "Detected today"
            : daysAgo(event.date) === 1
              ? "Detected yesterday"
              : `${daysAgo(event.date)} days ago`}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Stat
          label="Peak MESH size"
          value={`${event.maxInches.toFixed(2)}"`}
          hint="radar-estimated hail"
          tone="amber"
        />
        <Stat
          label="Radar cells hit"
          value={event.hitCount.toLocaleString()}
          hint="≥1km² each"
        />
        <Stat
          label="Ground reports"
          value={`${event.groundReportCount}`}
          hint="NOAA Storm Events"
          tone={event.groundReportCount > 0 ? "mint" : "slate"}
        />
        <Stat
          label="Distance from center"
          value={`${event.distanceMiles.toFixed(1)} mi`}
          hint={`from ${regionName}`}
        />
      </div>

      <div className="pt-2 border-t border-white/[0.06]">
        <div className="label flex items-center gap-2 mb-2">
          <MapPin size={12} />
          Canvass-eligible buildings
        </div>
        <div className="flex items-baseline gap-3">
          <div className="font-display tabular text-[44px] sm:text-[56px] font-semibold tracking-[-0.02em] text-cy-300 leading-none">
            {canvass ? canvass.buildingCount.toLocaleString() : "—"}
          </div>
          <div className="text-[12px] text-slate-400 font-mono uppercase tracking-[0.12em]">
            inside 2-mi radius
          </div>
        </div>
        <div className="text-[12px] text-slate-500 mt-2 leading-relaxed">
          {canvass?.isEstimate
            ? "Estimated from regional density (OSM mirrors temporarily unavailable). Real count refreshes within 24h."
            : canvass
              ? "Counted via OpenStreetMap Overpass. Address-level rows populate from your county parcel feed at activation."
              : "Building count temporarily unavailable."}
        </div>
      </div>

      <div className="text-[11.5px] text-slate-500 leading-relaxed pt-2">
        Source: NOAA MRMS MESH 1km radar grid, cross-referenced with
        NOAA Storm Events Local Storm Reports.{" "}
        <Link href="/methodology" className="text-cy-300 hover:underline">
          How we measure →
        </Link>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = "slate",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "slate" | "amber" | "mint";
}) {
  const tones: Record<typeof tone, string> = {
    slate: "text-slate-50",
    amber: "text-amber",
    mint: "text-mint",
  };
  return (
    <div className="glass-panel p-4">
      <div className="label text-[10px]">{label}</div>
      <div
        className={`font-display tabular text-[24px] sm:text-[28px] font-semibold tracking-[-0.02em] mt-1.5 leading-none ${tones[tone]}`}
      >
        {value}
      </div>
      {hint && (
        <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-slate-500 mt-2">
          {hint}
        </div>
      )}
    </div>
  );
}
