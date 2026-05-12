"use client";

import { useEffect, useState } from "react";
import {
  CloudHail,
  MapPin,
  Loader2,
  Inbox,
  Send,
  ExternalLink,
} from "lucide-react";

/**
 * Live storm card — renders the most recent qualifying hail event in
 * the watched region AND the actual sample output your team would
 * receive from it.
 *
 * Client-rendered so the page shell loads instantly. Three states:
 *   - loading: skeleton
 *   - ok:      real event + map + sample output cards driven by the
 *              event's date / peak inches
 *   - error:   short message, no crash
 *
 * Voxaris-branded copy throughout — we don't surface the underlying
 * weather-data source names; the product is the product.
 */

interface RecentEvent {
  date: string;
  maxInches: number;
  hitCount: number;
  distanceMiles: number;
  groundReportCount: number;
  source: string;
}

interface RecentResponse {
  event: RecentEvent | null;
}

interface CanvassResponse {
  buildingCount: number;
  isEstimate: boolean;
}

interface Props {
  lat?: number;
  lng?: number;
  regionName?: string;
  radiusMiles?: number;
  googleMapsKey?: string;
}

type State =
  | { kind: "loading" }
  | { kind: "ok"; event: RecentEvent; canvass: CanvassResponse | null }
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

function formatEventDateShort(yyyymmdd: string): string {
  const y = yyyymmdd.slice(0, 4);
  const m = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  return new Date(`${y}-${m}-${d}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
  });
}

function formatEventDateUrl(yyyymmdd: string): string {
  return yyyymmdd.slice(4, 6) + yyyymmdd.slice(6, 8);
}

function daysAgo(yyyymmdd: string): number {
  const y = yyyymmdd.slice(0, 4);
  const m = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  const event = new Date(`${y}-${m}-${d}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor((Date.now() - event) / (24 * 60 * 60 * 1000)));
}

function describeAge(days: number): string {
  if (days === 0) return "Detected today";
  if (days === 1) return "Detected yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${(days / 365).toFixed(1)} years ago`;
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
          setState({
            kind: "error",
            reason: "no qualifying event on record for the watched region",
          });
        }
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [lat, lng, radiusMiles]);

  if (state.kind === "loading") {
    return <LoadingSkeleton regionName={regionName} />;
  }
  if (state.kind === "error") {
    return <ErrorState regionName={regionName} />;
  }

  const { event, canvass } = state;
  const mapUrl = googleMapsKey
    ? buildMapUrl({
        lat,
        lng,
        hailDistanceMiles: event.distanceMiles,
        apiKey: googleMapsKey,
      })
    : null;
  const buildingCount = canvass?.buildingCount ?? null;

  return (
    <div className="space-y-10 sm:space-y-12">
      {/* TOP — event detail + map */}
      <div
        className="rounded-3xl p-6 sm:p-8 grid lg:grid-cols-[1fr_1.1fr] gap-6 sm:gap-10"
        style={{
          background: "rgba(13,17,24,0.6)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div className="space-y-6">
          <div>
            <div className="text-[10.5px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-2 flex items-center gap-2">
              <CloudHail size={11} />
              Event detected
            </div>
            <div className="font-display text-[24px] sm:text-[28px] font-semibold tracking-tight text-slate-50 leading-tight">
              {formatEventDate(event.date)}
            </div>
            <div className="text-[12.5px] text-slate-400 mt-1">
              {describeAge(daysAgo(event.date))} · {regionName}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Peak hail size"
              value={`${event.maxInches.toFixed(2)}"`}
              tone="amber"
            />
            <Stat
              label="Impact cells"
              value={event.hitCount.toLocaleString()}
              hint="≥1 km² each"
            />
            <Stat
              label="Ground reports"
              value={`${event.groundReportCount}`}
              tone={event.groundReportCount > 0 ? "mint" : "slate"}
            />
            <Stat
              label="Distance from center"
              value={`${event.distanceMiles.toFixed(1)} mi`}
            />
          </div>

          <div className="pt-3 border-t border-white/[0.06]">
            <div className="text-[10.5px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-2 flex items-center gap-2">
              <MapPin size={11} />
              Inspection-eligible properties
            </div>
            <div className="flex items-baseline gap-3">
              <div className="font-display tabular text-[48px] sm:text-[60px] font-semibold tracking-[-0.025em] text-cy-300 leading-none">
                {buildingCount != null
                  ? buildingCount.toLocaleString()
                  : "—"}
              </div>
              <div className="text-[12px] text-slate-400 font-mono uppercase tracking-[0.12em]">
                inside the 2-mi impact zone
              </div>
            </div>
          </div>
        </div>

        <div
          className="relative rounded-2xl overflow-hidden min-h-[280px]"
          style={{
            background: "rgba(0,0,0,0.3)",
            border: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          {mapUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={mapUrl}
              alt={`Impact area around ${regionName}`}
              className="w-full h-full object-cover"
              loading="eager"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-slate-500 text-[12px] p-6 text-center">
              Map preview unavailable.
            </div>
          )}
          <div className="absolute top-3 left-3 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/60 text-[10px] font-mono uppercase tracking-[0.12em] text-amber border border-amber/40">
            Impact zone
          </div>
        </div>
      </div>

      {/* MIDDLE — connector text */}
      <div className="text-center max-w-2xl mx-auto px-4">
        <div className="text-[10.5px] font-mono uppercase tracking-[0.18em] text-cy-300 mb-3">
          From this single event
        </div>
        <h3 className="font-display text-[24px] sm:text-[32px] font-semibold tracking-[-0.025em] text-slate-50 leading-tight">
          Your sales team gets three deliverables in their inbox.
        </h3>
      </div>

      {/* OUTPUT — three cards driven by the live event data */}
      <div className="grid lg:grid-cols-3 gap-4 sm:gap-5">
        <OutputCanvassList event={event} />
        <OutputPostcard event={event} />
        <OutputLandingPage event={event} buildingCount={buildingCount} />
      </div>
    </div>
  );
}

/* ─── States ──────────────────────────────────────────────────────────── */

function LoadingSkeleton({ regionName }: { regionName: string }) {
  return (
    <div
      className="rounded-3xl p-6 sm:p-8 grid lg:grid-cols-[1fr_1.1fr] gap-6 sm:gap-10"
      style={{
        background: "rgba(13,17,24,0.6)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div className="space-y-6">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-cy-300/[0.06] border border-cy-300/25 text-cy-300 text-[11px] font-mono uppercase tracking-[0.14em]">
          <Loader2 size={11} className="animate-spin" />
          Scanning {regionName}
        </div>
        <div className="space-y-2.5">
          <div className="h-2.5 w-32 rounded shimmer" />
          <div className="h-9 w-72 rounded shimmer" />
          <div className="h-2.5 w-40 rounded shimmer" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-xl p-4 space-y-2"
              style={{
                background: "rgba(255,255,255,0.02)",
                border: "1px solid rgba(255,255,255,0.05)",
              }}
            >
              <div className="h-2 w-16 rounded shimmer" />
              <div className="h-7 w-20 rounded shimmer" />
            </div>
          ))}
        </div>
      </div>
      <div
        className="relative rounded-2xl overflow-hidden min-h-[280px] flex items-center justify-center"
        style={{
          background: "rgba(0,0,0,0.3)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <Loader2 size={20} className="animate-spin text-cy-300/60" />
      </div>
    </div>
  );
}

function ErrorState({ regionName }: { regionName: string }) {
  return (
    <div
      className="rounded-3xl p-8 text-center"
      style={{
        background: "rgba(13,17,24,0.6)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber/[0.08] border border-amber/30 text-amber text-[11px] font-mono uppercase tracking-[0.14em] mb-4">
        Storm data temporarily unavailable
      </div>
      <div className="font-display text-[20px] sm:text-[24px] font-semibold tracking-tight text-slate-100 leading-tight max-w-prose mx-auto">
        We&apos;re rebuilding the event index for {regionName}.
      </div>
      <p className="text-[13px] text-slate-400 mt-3 leading-relaxed max-w-prose mx-auto">
        The live preview reads from a daily-refreshed cache. Try
        refreshing in a few minutes, or get in touch and we&apos;ll walk
        you through the dashboard with a different territory.
      </p>
    </div>
  );
}

/* ─── Output cards (driven by the live event) ─────────────────────────── */

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
    <div
      className="rounded-xl p-4"
      style={{
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-slate-500">
        {label}
      </div>
      <div
        className={`font-display tabular text-[24px] sm:text-[26px] font-semibold tracking-[-0.02em] mt-1.5 leading-none ${tones[tone]}`}
      >
        {value}
      </div>
      {hint && (
        <div className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-slate-500 mt-2">
          {hint}
        </div>
      )}
    </div>
  );
}

function OutputCanvassList({ event }: { event: RecentEvent }) {
  // Score formula = peak inches × 0.6 + (5 - distance) × 0.5, capped.
  // Generates deterministic-looking but masked addresses tied to the
  // event. Marked as "sample" in the footer.
  const score = Math.min(
    9.9,
    event.maxInches * 4.5 + Math.max(0, 5 - event.distanceMiles) * 0.6,
  );
  const rows = [
    { addr: "•••• Glasstone Ct, Apopka FL", score: score },
    { addr: "•••• Brittany Bay, Apopka FL", score: score - 0.2 },
    { addr: "•••• Citrus Tree Ln, Apopka FL", score: score - 0.4 },
    { addr: "•••• Westmoreland Ave, Orlando FL", score: score - 0.6 },
    { addr: "•••• Honeywood Pl, Apopka FL", score: score - 0.8 },
  ];
  return (
    <div
      className="rounded-2xl p-6 flex flex-col"
      style={{
        background: "rgba(13,17,24,0.6)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div className="flex items-center gap-2 mb-3">
        <Inbox size={13} className="text-cy-300" />
        <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-slate-400">
          Canvass list
        </span>
      </div>
      <div className="font-display text-[17px] font-semibold tracking-tight text-slate-50 mb-1">
        Ranked targets
      </div>
      <div className="text-[11.5px] text-slate-500 mb-4">
        Generated from the {formatEventDateShort(event.date)} event
      </div>
      <div className="space-y-1.5 mb-4 flex-1">
        {rows.map((r, i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg"
            style={{
              background: "rgba(255,255,255,0.025)",
              border: "1px solid rgba(255,255,255,0.05)",
            }}
          >
            <span className="text-[12px] text-slate-300 truncate font-mono">
              {r.addr}
            </span>
            <span
              className="text-[10px] font-mono uppercase tracking-[0.08em] px-2 py-0.5 rounded-full flex-shrink-0"
              style={{
                background: "rgba(243,177,75,0.10)",
                border: "1px solid rgba(243,177,75,0.34)",
                color: "#f3b14b",
              }}
            >
              {r.score.toFixed(1)}
            </span>
          </div>
        ))}
      </div>
      <div className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-slate-500 pt-3 border-t border-white/[0.06]">
        Sample · Real addresses appear at activation
      </div>
    </div>
  );
}

function OutputPostcard({ event }: { event: RecentEvent }) {
  return (
    <div
      className="rounded-2xl p-6 flex flex-col"
      style={{
        background: "rgba(13,17,24,0.6)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div className="flex items-center gap-2 mb-3">
        <Send size={13} className="text-cy-300" />
        <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-slate-400">
          Direct mail
        </span>
      </div>
      <div className="font-display text-[17px] font-semibold tracking-tight text-slate-50 mb-1">
        Ready-to-mail postcard
      </div>
      <div className="text-[11.5px] text-slate-500 mb-4">
        Pre-filled with the {formatEventDateShort(event.date)} event
      </div>
      <div
        className="rounded-xl p-5 flex-1 flex flex-col justify-between"
        style={{
          background:
            "linear-gradient(135deg, rgba(103,220,255,0.10), rgba(95,227,176,0.06))",
          border: "1px solid rgba(103,220,255,0.20)",
        }}
      >
        <div>
          <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-cy-300 mb-2">
            Hail event · {formatEventDateShort(event.date)}
          </div>
          <div className="font-display text-[19px] font-semibold tracking-tight text-slate-50 leading-tight">
            We measured {event.maxInches.toFixed(1)}-inch hail at your
            address.
          </div>
          <p className="text-[12px] text-slate-300 mt-3 leading-relaxed">
            Your neighborhood was inside the storm footprint. A free
            inspection from a local crew confirms whether your roof took
            damage.
          </p>
        </div>
        <div className="mt-4 pt-3 border-t border-white/[0.08] text-[10.5px] font-mono text-cy-300 tabular">
          storm.acme-roofing.com/{formatEventDateUrl(event.date)}-•••••
        </div>
      </div>
      <div className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-slate-500 pt-3 mt-4 border-t border-white/[0.06]">
        $0.85 / postcard at scale
      </div>
    </div>
  );
}

function OutputLandingPage({
  event,
  buildingCount,
}: {
  event: RecentEvent;
  buildingCount: number | null;
}) {
  return (
    <div
      className="rounded-2xl p-6 flex flex-col"
      style={{
        background: "rgba(13,17,24,0.6)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div className="flex items-center gap-2 mb-3">
        <ExternalLink size={13} className="text-cy-300" />
        <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-slate-400">
          Per-event landing
        </span>
      </div>
      <div className="font-display text-[17px] font-semibold tracking-tight text-slate-50 mb-1">
        Pre-filled estimate flow
      </div>
      <div className="text-[11.5px] text-slate-500 mb-4">
        One per event · auto-generated
      </div>
      <div
        className="rounded-xl p-5 flex-1 space-y-3"
        style={{
          background: "rgba(0,0,0,0.3)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-mint pulse-dot" />
          <span className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-mint">
            Address matched
          </span>
        </div>
        <div className="font-display text-[16px] font-semibold tracking-tight text-slate-50 leading-tight">
          Welcome — your home is in the {formatEventDateShort(event.date)}{" "}
          hail footprint.
        </div>
        <div className="text-[12px] text-slate-400 leading-relaxed">
          Peak hail size: {event.maxInches.toFixed(1)}&Prime;
          {buildingCount != null && (
            <>
              {" "}· {buildingCount.toLocaleString()} homes in your
              impact zone
            </>
          )}
        </div>
        <div className="pt-2">
          <div className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-slate-500 mb-1.5">
            One-click intake
          </div>
          <div className="text-[12.5px] text-cy-300 font-medium">
            Schedule a free inspection →
          </div>
        </div>
      </div>
      <div className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-slate-500 pt-3 mt-4 border-t border-white/[0.06]">
        Routes into your existing estimate flow
      </div>
    </div>
  );
}
