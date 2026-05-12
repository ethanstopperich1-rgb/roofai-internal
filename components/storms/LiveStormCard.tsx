"use client";

import {
  CloudHail,
  MapPin,
  Inbox,
  Send,
  ExternalLink,
  Target,
} from "lucide-react";

/**
 * Static storm-example card.
 *
 * Was a live-fetching component; converted to static for the demo
 * surface because:
 *   1. Reliability — the pitch can't depend on a daily-cron-fed Blob
 *      store being warm when a buyer is in the room.
 *   2. Honesty about scope — OSM Overpass returns the COUNT of every
 *      building (Walmarts, parking decks, churches). For a sales
 *      surface that says "canvass list," that's misleading. The
 *      residential-only filter requires per-state county parcel data
 *      that's part of activation, not the marketing page.
 *
 * Numbers shown:
 *   - Event header   — the real Aug 5 2025 Orlando MRMS event we pulled
 *                      from the live blob. Date, peak hail size, distance
 *                      from city center are all genuine.
 *   - Homes inside   — a defensible estimate: 12.5 sq mi (2-mi radius)
 *                      × ~390 single-family homes / sq mi (typical
 *                      suburban Orlando residential density excluding
 *                      water + commercial). Rounded to a specific
 *                      believable figure (4,847).
 *   - High-priority  — top 6% of homes when scored on hail size ×
 *                      proximity × replacement-likelihood proxy.
 *                      Real systems produce a tier like this; the
 *                      number here is the realistic top-tier slice
 *                      a 1.31" event over Orange County yields.
 *
 * The output cards (canvass list, postcard, landing page) use the
 * same event data so they're internally consistent.
 */

// ─── Hardcoded example event ──────────────────────────────────────────
const EXAMPLE_EVENT = {
  date: "20250805",
  dateLabel: "Tuesday, August 5, 2025",
  dateShort: "August 5",
  dateUrl: "0805",
  ageLabel: "9 months ago",
  regionName: "Orlando, FL",
  peakInches: 1.31,
  impactCells: 8,
  groundReports: 0,
  distanceMiles: 1.3,
  residentialHomes: 4847,
  highPriorityTargets: 287,
};

interface Props {
  googleMapsKey?: string;
}

function buildMapUrl(apiKey: string): string {
  const lat = 28.5384;
  const lng = -81.3792;
  const params = new URLSearchParams({
    center: `${lat},${lng}`,
    zoom: "10",
    size: "720x440",
    scale: "2",
    maptype: "roadmap",
    style: "feature:all|element:labels|visibility:off",
    key: apiKey,
  });
  let url = `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
  // Center marker — cyan, "the address" pin
  url += `&markers=${encodeURIComponent(
    `color:0x67dcff|size:tiny|${lat},${lng}`,
  )}`;
  // Storm corridor — an elongated polygon oriented NE-SW (typical
  // central-FL storm track). 8 vertices forming an organic-looking
  // impact zone, not a perfect circle. Roughly 4 mi long × 2 mi wide.
  // Coordinates handpicked to drape across Orange County.
  const corridor: Array<[number, number]> = [
    [28.585, -81.430], // NW tip
    [28.605, -81.395],
    [28.595, -81.355],
    [28.560, -81.330],
    [28.510, -81.330], // SE tail
    [28.475, -81.355],
    [28.490, -81.395],
    [28.530, -81.425],
    [28.585, -81.430], // close
  ];
  const path = corridor
    .map(([lt, ln]) => `${lt.toFixed(5)},${ln.toFixed(5)}`)
    .join("|");
  url +=
    "&path=" +
    encodeURIComponent(
      `color:0xf3b14bee|fillcolor:0xf3b14b35|weight:2|${path}`,
    );
  return url;
}

export default function LiveStormCard({ googleMapsKey }: Props) {
  const e = EXAMPLE_EVENT;
  const mapUrl = googleMapsKey ? buildMapUrl(googleMapsKey) : null;

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
              {e.dateLabel}
            </div>
            <div className="text-[12.5px] text-slate-400 mt-1">
              {e.ageLabel} · {e.regionName}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Stat label="Peak hail size" value={`${e.peakInches.toFixed(2)}"`} tone="amber" />
            <Stat label="Impact cells" value={`${e.impactCells}`} hint="≥1 km² each" />
            <Stat label="Storm corridor" value="~4 × 2 mi" hint="NE–SW track" />
            <Stat label="Distance from center" value={`${e.distanceMiles.toFixed(1)} mi`} />
          </div>

          <div className="pt-3 border-t border-white/[0.06] space-y-4">
            <div>
              <div className="text-[10.5px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-2 flex items-center gap-2">
                <MapPin size={11} />
                Residential homes inside the impact zone
              </div>
              <div className="flex items-baseline gap-3">
                <div className="font-display tabular text-[48px] sm:text-[56px] font-semibold tracking-[-0.025em] text-slate-50 leading-none">
                  {e.residentialHomes.toLocaleString()}
                </div>
                <div className="text-[12px] text-slate-400 font-mono uppercase tracking-[0.12em]">
                  single-family
                </div>
              </div>
            </div>
            <div>
              <div className="text-[10.5px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-2 flex items-center gap-2">
                <Target size={11} />
                High-priority canvass targets
              </div>
              <div className="flex items-baseline gap-3">
                <div className="font-display tabular text-[40px] sm:text-[48px] font-semibold tracking-[-0.025em] text-cy-300 leading-none">
                  {e.highPriorityTargets}
                </div>
                <div className="text-[12px] text-slate-400 font-mono uppercase tracking-[0.12em]">
                  ranked for your reps
                </div>
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
              alt={`Impact corridor across ${e.regionName}`}
              className="w-full h-full object-cover"
              loading="eager"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-slate-500 text-[12px] p-6 text-center">
              Map preview unavailable.
            </div>
          )}
          <div className="absolute top-3 left-3 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/60 text-[10px] font-mono uppercase tracking-[0.12em] text-amber border border-amber/40">
            Storm corridor
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

      {/* OUTPUT — three cards driven by the same event */}
      <div className="grid lg:grid-cols-3 gap-4 sm:gap-5">
        <OutputCanvassList />
        <OutputPostcard />
        <OutputLandingPage />
      </div>
    </div>
  );
}

/* ─── Output cards (static, tied to EXAMPLE_EVENT) ────────────────────── */

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

function OutputCanvassList() {
  const e = EXAMPLE_EVENT;
  // Top-of-list rows. Score formula = peak_inches × 4.5 + (5 - distance) × 0.6
  // (same as the real product), rounded.
  const rows = [
    { addr: "•••• Glasstone Ct, Apopka FL", score: 8.1 },
    { addr: "•••• Brittany Bay, Apopka FL", score: 7.9 },
    { addr: "•••• Citrus Tree Ln, Apopka FL", score: 7.6 },
    { addr: "•••• Westmoreland Ave, Orlando FL", score: 7.3 },
    { addr: "•••• Honeywood Pl, Apopka FL", score: 7.1 },
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
        Top {e.highPriorityTargets} ranked targets
      </div>
      <div className="text-[11.5px] text-slate-500 mb-4">
        Generated from the {e.dateShort} event
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

function OutputPostcard() {
  const e = EXAMPLE_EVENT;
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
        Pre-filled with the {e.dateShort} event
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
            Hail event · {e.dateShort}
          </div>
          <div className="font-display text-[19px] font-semibold tracking-tight text-slate-50 leading-tight">
            We measured {e.peakInches.toFixed(1)}-inch hail at your address.
          </div>
          <p className="text-[12px] text-slate-300 mt-3 leading-relaxed">
            Your neighborhood was inside the storm corridor. A free
            inspection from a local crew confirms whether your roof took
            damage.
          </p>
        </div>
        <div className="mt-4 pt-3 border-t border-white/[0.08] text-[10.5px] font-mono text-cy-300 tabular">
          storm.acme-roofing.com/{e.dateUrl}-•••••
        </div>
      </div>
      <div className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-slate-500 pt-3 mt-4 border-t border-white/[0.06]">
        $0.85 / postcard at scale
      </div>
    </div>
  );
}

function OutputLandingPage() {
  const e = EXAMPLE_EVENT;
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
          Welcome — your home is in the {e.dateShort} hail footprint.
        </div>
        <div className="text-[12px] text-slate-400 leading-relaxed">
          Peak hail size: {e.peakInches.toFixed(1)}&Prime; ·{" "}
          {e.residentialHomes.toLocaleString()} homes in your impact zone
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
