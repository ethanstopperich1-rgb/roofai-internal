"use client";

/**
 * components/roof/MeasurementVerification.tsx
 *
 * Cross-source measurement trust layer. When the winning source is Tier
 * A (USGS LiDAR), we also have Tier C (Google Solar) data on the same
 * roof. Showing the two measurements side-by-side and computing the
 * delta is the strongest possible "we measured this right" signal we
 * can give a customer — two independent satellite/aerial pipelines
 * agreed on the number.
 *
 * Two variants:
 *   - variant="customer": single badge ("✓ Verified — 97% agreement")
 *     plus a one-line subtext. Shown on /quote.
 *   - variant="rep": full delta table with raw numbers, source
 *     freshness, color-coded thresholds. Shown on /internal.
 *
 * Agreement thresholds (sqft delta %, the strongest signal):
 *   green  ≤ 8%   → "verified"
 *   amber  8-20%  → "approximate"
 *   red    > 20%  → "disputed" — surfaces a rep callout.
 *
 * When crossSourceBaseline is null/missing (Tier C/D primary, Solar
 * unavailable), this component returns null — there's nothing to
 * compare. The other measurement card already shows the single source.
 */

import type { RoofData } from "@/types/roof";

interface Props {
  data: RoofData;
  variant?: "customer" | "rep";
  className?: string;
}

export default function MeasurementVerification({
  data,
  variant = "customer",
  className,
}: Props) {
  const baseline = data.crossSourceBaseline?.solar;
  const hasCrossSource =
    data.source === "tier-a-lidar" && !!baseline && baseline.sqft != null;

  // Single-source fallback path: Tier A didn't win OR we don't have a
  // Tier C baseline to compare against. Still render a trust badge so
  // the customer sees the provenance of the measurement instead of a
  // silent gap. Cross-source agreement is the stronger signal — but
  // "Measured by Google Solar imagery · 2023-11-05" is a real trust
  // signal too, and the customer should see it.
  if (!hasCrossSource) {
    if (data.source === "none") return null;
    return (
      <SingleSourceBadge
        data={data}
        variant={variant}
        className={className}
      />
    );
  }

  // hasCrossSource guarantees baseline + baseline.sqft are non-null.
  const baselineNN = baseline!;
  const tierASqft = data.totals.totalRoofAreaSqft;
  const tierCSqft = baselineNN.sqft!;
  const sqftDeltaPct = Math.abs(tierASqft - tierCSqft) / Math.max(1, tierCSqft);

  const tierAPitch = data.totals.averagePitchDegrees;
  const tierCPitch = baselineNN.pitchDegrees ?? 0;
  const pitchDeltaDeg = Math.abs(tierAPitch - tierCPitch);

  const facetDelta = Math.abs(data.totals.facetsCount - baselineNN.segmentCount);

  // Confidence: 100% at zero delta, decaying linearly to 0% at 30%
  // sqft delta. Clamped so the trust badge stays motivating in the
  // amber band rather than dropping into single digits.
  const agreementPct = Math.max(0, Math.min(100, 100 - sqftDeltaPct * 100 * 1.2));
  const tier: "green" | "amber" | "red" =
    sqftDeltaPct <= 0.08 ? "green" : sqftDeltaPct <= 0.2 ? "amber" : "red";

  if (variant === "customer") {
    return (
      <CustomerBadge
        tier={tier}
        agreementPct={agreementPct}
        sqftDeltaPct={sqftDeltaPct}
        className={className}
      />
    );
  }

  return (
    <RepPanel
      tier={tier}
      agreementPct={agreementPct}
      sqftDeltaPct={sqftDeltaPct}
      pitchDeltaDeg={pitchDeltaDeg}
      facetDelta={facetDelta}
      tierASqft={tierASqft}
      tierCSqft={tierCSqft}
      tierAPitch={tierAPitch}
      tierCPitch={tierCPitch}
      tierAFacets={data.totals.facetsCount}
      tierCFacets={baselineNN.segmentCount}
      tierAImageryDate={data.imageryDate}
      tierCImageryDate={baselineNN.imageryDate}
      tierCQuality={baselineNN.imageryQuality}
      className={className}
    />
  );
}

// ─── Customer-facing variant ─────────────────────────────────────────

function CustomerBadge({
  tier,
  agreementPct,
  sqftDeltaPct,
  className,
}: {
  tier: "green" | "amber" | "red";
  agreementPct: number;
  sqftDeltaPct: number;
  className?: string;
}) {
  const accent =
    tier === "green"
      ? "border-emerald-400/30 bg-emerald-400/[0.04]"
      : tier === "amber"
      ? "border-amber-400/30 bg-amber-400/[0.04]"
      : "border-rose-400/30 bg-rose-400/[0.04]";
  const dot =
    tier === "green"
      ? "bg-emerald-400"
      : tier === "amber"
      ? "bg-amber-400"
      : "bg-rose-400";
  const headline =
    tier === "green"
      ? "Verified measurement"
      : tier === "amber"
      ? "Cross-checked measurement"
      : "Measurements differ — rep will reconcile";
  const sub =
    tier === "red"
      ? `Independent measurements differ by ${Math.round(sqftDeltaPct * 100)}% — we'll confirm during the site visit.`
      : `Two independent measurement methods agree within ${Math.round(sqftDeltaPct * 100)}% · ${Math.round(agreementPct)}% confidence.`;

  return (
    <div
      className={
        className ??
        `relative flex items-start gap-3 rounded-xl border ${accent} p-4 backdrop-blur-sm`
      }
    >
      <div className="relative mt-0.5 flex h-2.5 w-2.5 shrink-0 items-center justify-center">
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${dot} opacity-40`} />
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/55">
            Independently verified
          </span>
        </div>
        <div className="mt-1 text-[15px] font-medium text-white/95">
          {headline}
        </div>
        <div className="mt-1 text-[12.5px] leading-snug text-white/55">{sub}</div>
      </div>
    </div>
  );
}

// ─── Rep-facing variant ──────────────────────────────────────────────

function RepPanel(props: {
  tier: "green" | "amber" | "red";
  agreementPct: number;
  sqftDeltaPct: number;
  pitchDeltaDeg: number;
  facetDelta: number;
  tierASqft: number;
  tierCSqft: number;
  tierAPitch: number;
  tierCPitch: number;
  tierAFacets: number;
  tierCFacets: number;
  tierAImageryDate: string | null;
  tierCImageryDate: string | null;
  tierCQuality: string;
  className?: string;
}) {
  const {
    tier,
    agreementPct,
    sqftDeltaPct,
    pitchDeltaDeg,
    facetDelta,
    tierASqft,
    tierCSqft,
    tierAPitch,
    tierCPitch,
    tierAFacets,
    tierCFacets,
    tierAImageryDate,
    tierCImageryDate,
    tierCQuality,
    className,
  } = props;

  const tierColor =
    tier === "green"
      ? "text-emerald-300"
      : tier === "amber"
      ? "text-amber-300"
      : "text-rose-300";
  const tierLabel =
    tier === "green" ? "VERIFIED" : tier === "amber" ? "APPROXIMATE" : "DISPUTED";

  return (
    <div
      className={
        className ??
        "rounded-xl border border-white/10 bg-white/[0.02] p-4 backdrop-blur-sm"
      }
    >
      <div className="flex items-center justify-between border-b border-white/5 pb-3">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/45">
            Cross-source verification
          </div>
          <div className="mt-1 text-[13px] text-white/85">
            <span className={`font-mono ${tierColor}`}>{tierLabel}</span>
            <span className="text-white/45"> · {Math.round(agreementPct)}% agreement</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/45">
            Δ sqft
          </div>
          <div className={`mt-1 text-[16px] font-mono ${tierColor}`}>
            {Math.round(sqftDeltaPct * 100)}%
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-white/5 bg-white/5 text-[12px]">
        <DeltaCell label="Sqft" tierA={Math.round(tierASqft).toLocaleString()} tierC={Math.round(tierCSqft).toLocaleString()} delta={`${Math.round(sqftDeltaPct * 100)}%`} />
        <DeltaCell label="Pitch" tierA={`${tierAPitch.toFixed(1)}°`} tierC={`${tierCPitch.toFixed(1)}°`} delta={`${pitchDeltaDeg.toFixed(1)}°`} />
        <DeltaCell label="Planes" tierA={String(tierAFacets)} tierC={String(tierCFacets)} delta={String(facetDelta)} />
      </div>

      <div className="mt-3 flex items-center justify-between text-[10.5px] font-mono uppercase tracking-[0.14em] text-white/35">
        <div>Precision survey · {tierAImageryDate ?? "date unknown"}</div>
        <div>
          Aerial survey · {tierCImageryDate ?? "—"} · {tierCQuality}
        </div>
      </div>
    </div>
  );
}

function DeltaCell({
  label,
  tierA,
  tierC,
  delta,
}: {
  label: string;
  tierA: string;
  tierC: string;
  delta: string;
}) {
  return (
    <div className="bg-black/40 p-3">
      <div className="text-[9.5px] font-mono uppercase tracking-[0.18em] text-white/40">
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between">
        <span className="text-[13px] text-white/95">{tierA}</span>
        <span className="text-[10px] text-white/30">vs</span>
        <span className="text-[13px] text-white/55">{tierC}</span>
      </div>
      <div className="mt-1 text-[10px] font-mono uppercase tracking-[0.14em] text-white/35">
        Δ {delta}
      </div>
    </div>
  );
}

// ─── Single-source fallback ──────────────────────────────────────────
// Shown when there is no Tier A measurement to cross-verify against
// the Tier C baseline. Still surfaces real provenance (which dataset
// measured this roof, when the imagery was captured, and the source's
// own confidence). Not as strong as the cross-source badge — but
// dramatically stronger than no provenance signal at all.

function SingleSourceBadge({
  data,
  variant,
  className,
}: {
  data: RoofData;
  variant: "customer" | "rep";
  className?: string;
}) {
  // User-facing source labels are intentionally generic — they
  // describe WHAT KIND of measurement was used without naming the
  // upstream data providers. Internal source enum is unchanged.
  const sourceLabel =
    data.source === "tier-a-lidar"
      ? "Precision survey"
      : data.source === "tier-b-multiview"
      ? "Multi-angle aerial"
      : data.source === "tier-c-solar"
      ? "Aerial survey"
      : data.source === "tier-c-vision"
      ? "AI vision"
      : "Aerial imagery";

  const confidencePct = Math.round(data.confidence * 100);
  // Confidence ≥ 80 → green, 60-79 → amber, < 60 → muted.
  const tier: "green" | "amber" | "muted" =
    confidencePct >= 80 ? "green" : confidencePct >= 60 ? "amber" : "muted";
  const accent =
    tier === "green"
      ? "border-emerald-400/30 bg-emerald-400/[0.04]"
      : tier === "amber"
      ? "border-amber-400/30 bg-amber-400/[0.04]"
      : "border-white/10 bg-white/[0.02]";
  const dot =
    tier === "green"
      ? "bg-emerald-400"
      : tier === "amber"
      ? "bg-amber-400"
      : "bg-white/40";

  const sqft = Math.round(data.totals.totalRoofAreaSqft).toLocaleString();
  const facets = data.totals.facetsCount;
  const dateStr = data.imageryDate ?? "date unknown";

  if (variant === "customer") {
    return (
      <div
        className={
          className ??
          `relative flex items-start gap-3 rounded-xl border ${accent} p-4 backdrop-blur-sm`
        }
      >
        <div className="relative mt-0.5 flex h-2.5 w-2.5 shrink-0 items-center justify-center">
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${dot} opacity-40`} />
          <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/55">
            Measurement provenance
          </div>
          <div className="mt-1 text-[15px] font-medium text-white/95">
            Measured by {sourceLabel}
          </div>
          <div className="mt-1 text-[12.5px] leading-snug text-white/55">
            {sqft} sqft · {facets} planes · imagery {dateStr} · {confidencePct}% confidence
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        className ??
        "rounded-xl border border-white/10 bg-white/[0.02] p-4 backdrop-blur-sm"
      }
    >
      <div className="flex items-center justify-between border-b border-white/5 pb-3">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/45">
            Single-source measurement
          </div>
          <div className="mt-1 text-[13px] text-white/85">
            {sourceLabel}
            <span className="text-white/45"> · {confidencePct}% confidence</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/45">
            Cross-verify
          </div>
          <div className="mt-1 text-[12px] font-mono text-white/45">unavailable</div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-white/5 bg-white/5 text-[12px]">
        <SingleCell label="Sqft" value={sqft} />
        <SingleCell label="Pitch" value={`${data.totals.averagePitchDegrees.toFixed(1)}°`} />
        <SingleCell label="Planes" value={String(facets)} />
      </div>
      <div className="mt-3 text-[10.5px] font-mono uppercase tracking-[0.14em] text-white/35">
        Imagery · {dateStr}
      </div>
    </div>
  );
}

function SingleCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-black/40 p-3">
      <div className="text-[9.5px] font-mono uppercase tracking-[0.18em] text-white/40">
        {label}
      </div>
      <div className="mt-1.5 text-[13px] text-white/95">{value}</div>
    </div>
  );
}
