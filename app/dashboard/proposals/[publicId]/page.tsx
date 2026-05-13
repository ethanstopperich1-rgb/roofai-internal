import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, MapPin, ShieldCheck, ArrowLeft } from "lucide-react";
import {
  fmtDate,
  fmtDateTime,
  fmtUSD,
  getDashboardOfficeId,
  getDashboardOfficeSlug,
  getDashboardSupabase,
  type Lead,
  type Proposal,
} from "@/lib/dashboard";
import { getDemoProposals, getDemoLeads } from "@/lib/dashboard-demo-rows";
import { fmt, MATERIAL_RATES } from "@/lib/pricing";
import { summarizeProposalSnapshot, fmtMaterial } from "@/lib/proposal-snapshot";
import RecentStormCard from "@/components/RecentStormCard";
import type {
  Estimate,
  LineItem,
  Material,
  RoofLengths,
  WasteTable,
} from "@/types/estimate";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/* ─── Loader ─────────────────────────────────────────────────────────── */

type LoadResult =
  | { kind: "found"; proposal: Proposal; lead: Lead | null; isDemo: boolean }
  | { kind: "not_found" };

async function load(publicId: string): Promise<LoadResult> {
  const [officeSlug, officeId, supabase] = await Promise.all([
    getDashboardOfficeSlug(),
    getDashboardOfficeId(),
    getDashboardSupabase(),
  ]);

  // Demo path — no Supabase, show demo proposal if the publicId matches one.
  if (!officeId || !supabase) {
    const demoProposals = getDemoProposals(officeSlug);
    const demo = demoProposals.find((p) => p.public_id === publicId);
    if (!demo) return { kind: "not_found" };
    const leads = getDemoLeads(officeSlug);
    const lead = demo.lead_id ? leads.find((l) => l.id === demo.lead_id) ?? null : null;
    return { kind: "found", proposal: demo, lead, isDemo: true };
  }

  const { data: proposal } = await supabase
    .from("proposals")
    .select("*")
    .eq("office_id", officeId)
    .eq("public_id", publicId)
    .maybeSingle();
  if (!proposal) return { kind: "not_found" };

  let lead: Lead | null = null;
  if (proposal.lead_id) {
    const { data } = await supabase
      .from("leads")
      .select("*")
      .eq("office_id", officeId)
      .eq("id", proposal.lead_id)
      .maybeSingle();
    lead = data ?? null;
  }
  return { kind: "found", proposal, lead, isDemo: false };
}

/* ─── Snapshot adapters (defensive — snapshot is JSONB) ──────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readEstimate(snapshot: unknown): Estimate | null {
  return isRecord(snapshot) ? (snapshot as unknown as Estimate) : null;
}

/* ─── Page ───────────────────────────────────────────────────────────── */

export default async function RepProposalPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  const result = await load(publicId);
  if (result.kind === "not_found") notFound();

  const { proposal, lead, isDemo } = result;
  const estimate = readEstimate(proposal.snapshot);
  const summary = summarizeProposalSnapshot(proposal.snapshot);

  const totalRange =
    summary.totalLow != null && summary.totalHigh != null
      ? `${fmtUSD(summary.totalLow, 0)} – ${fmtUSD(summary.totalHigh, 0)}`
      : proposal.total_low != null && proposal.total_high != null
        ? `${fmtUSD(proposal.total_low, 0)} – ${fmtUSD(proposal.total_high, 0)}`
        : "—";

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <header className="flex flex-col gap-4">
        <div className="flex items-center gap-2 text-[12px]">
          <Link
            href="/dashboard/proposals"
            className="inline-flex items-center gap-1.5 text-white/55 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> All proposals
          </Link>
          {isDemo && (
            <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider text-amber border border-amber/30 bg-amber/10">
              Demo
            </span>
          )}
        </div>
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <div className="glass-eyebrow mb-2 inline-flex">Rep view · Proposal detail</div>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
              <span className="iridescent-text">
                {lead?.name ?? estimate?.customerName ?? "Customer proposal"}
              </span>
            </h1>
            <p className="text-sm text-white/55 mt-1.5 flex items-center gap-1.5">
              <MapPin size={12} className="text-white/40" />
              {lead?.address ?? estimate?.address?.formatted ?? "—"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/p/${proposal.public_id}`}
              target="_blank"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12px] font-medium text-white/85 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.07] hover:border-white/[0.16] transition-colors"
            >
              Open customer view <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
        </div>
      </header>

      {/* Customer-facing summary card (mirrors /p/[id]) */}
      <section className="glass-strong rounded-3xl p-7 md:p-9 relative overflow-hidden">
        <div
          className="absolute -top-20 -right-20 w-[420px] h-[420px] rounded-full blur-3xl pointer-events-none opacity-50"
          style={{ background: "radial-gradient(closest-side, rgba(103,220,255,0.18), transparent)" }}
        />
        <div className="relative">
          <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
            <span className="chip chip-accent">
              <ShieldCheck size={11} /> Customer-visible
            </span>
            <div className="font-mono tabular text-[10px] uppercase tracking-[0.16em] text-white/45">
              {fmtDate(proposal.created_at)} · #{proposal.public_id.slice(-8)}
            </div>
          </div>
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/45 mb-1.5">
                Project Total
              </div>
              <div className="font-display tabular text-[56px] md:text-[72px] leading-[0.92] font-semibold tracking-[-0.04em] text-white">
                {estimate?.total != null ? fmt(estimate.total) : "—"}
              </div>
              <div className="font-mono text-[11px] text-white/55 tabular mt-1">
                range {totalRange}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-white/45 mb-1.5">
                Material
              </div>
              <div className="font-display text-[16px] font-medium tracking-tight text-white/95">
                {fmtMaterial(summary.material)}
              </div>
              <div className="font-mono text-[11px] text-white/55 mt-1">
                {summary.sqft != null ? `${summary.sqft.toLocaleString()} sqft` : "—"}
                {summary.pitch ? ` · ${summary.pitch}` : ""}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───── Rep workbench (extra data) ───── */}
      <RepWorkbench estimate={estimate} proposal={proposal} />
    </div>
  );
}

/* ─── Rep workbench ──────────────────────────────────────────────────── */

function RepWorkbench({
  estimate,
  proposal,
}: {
  estimate: Estimate | null;
  proposal: Proposal;
}) {
  if (!estimate) {
    return (
      <section className="glass-panel p-6">
        <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-2">
          Rep workbench
        </div>
        <div className="text-sm text-white/55">
          Snapshot is missing or malformed — only the totals from the database
          row are available. This typically happens on very old proposals.
        </div>
      </section>
    );
  }

  const a = estimate.assumptions;
  const matLabel = MATERIAL_RATES[a.material as Material]?.label ?? a.material;
  const detailed = estimate.detailed;
  const lengths = estimate.lengths;
  const waste = estimate.waste;
  const photos = estimate.photos ?? [];
  const enabledAddOns = estimate.addOns.filter((ao) => ao.enabled);
  const addrLat = estimate.address?.lat;
  const addrLng = estimate.address?.lng;
  // Friendly city/region label for the storm card header. Pulls the
  // first meaningful comma-segment from the formatted address ("8450
  // Oak Park Rd, Oviedo, FL 32765" → "Oviedo"). Falls back to the
  // raw formatted string when we can't parse a clean city.
  const cityLabel = (() => {
    const f = estimate.address?.formatted ?? "";
    const parts = f.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : f || undefined;
  })();

  return (
    <div className="flex flex-col gap-4">
      {/* Assumptions strip */}
      <section className="glass-panel p-5">
        <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
          Assumptions <span className="text-white/30 normal-case">· internal</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Sqft" value={a.sqft.toLocaleString()} />
          <Stat label="Pitch" value={a.pitch} />
          <Stat label="Material" value={matLabel} />
          <Stat label="Service" value={(a.serviceType ?? "reroof-tearoff").replace(/-/g, " ")} />
          <Stat label="Complexity" value={a.complexity ?? "moderate"} />
          <Stat label="Age (yrs)" value={String(a.ageYears ?? "—")} />
          <Stat
            label="Labor ×"
            value={(a.laborMultiplier ?? 1).toFixed(2)}
            mono
          />
          <Stat
            label="Material ×"
            value={(a.materialMultiplier ?? 1).toFixed(2)}
            mono
          />
          <Stat
            label="Insurance"
            value={estimate.isInsuranceClaim ? "Yes" : "No"}
            mono
          />
          <Stat
            label="Prepared by"
            value={estimate.staff || "—"}
          />
          <Stat
            label="Saved"
            value={fmtDateTime(proposal.created_at)}
          />
          <Stat
            label="Public ID"
            value={proposal.public_id.slice(0, 12) + "…"}
            mono
          />
        </div>
      </section>

      {/* Recent storm activity — IEM Local Storm Reports, near-real-time.
          Lives high in the workbench so the rep sees "did this property
          get hit in the last week?" before they get into pricing. Time-
          window pills default to 7 days, 10-mi radius. */}
      <RecentStormCard
        lat={addrLat}
        lng={addrLng}
        cityLabel={cityLabel}
        defaultWindow={7}
        defaultRadius={10}
      />

      {/* Line items (Xactimate-style breakdown) */}
      {detailed && detailed.lineItems.length > 0 && (
        <section className="glass-panel p-0 overflow-hidden">
          <div className="px-5 pt-5 pb-3 flex items-center justify-between flex-wrap gap-2">
            <div className="text-[10.5px] uppercase tracking-wider text-white/45">
              Line items <span className="text-white/30 normal-case">· Xactimate-style</span>
            </div>
            <div className="text-[11px] font-mono tabular text-white/55">
              {detailed.lineItems.length} items · {detailed.squares?.toFixed(1)} sq
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-[10.5px] uppercase tracking-wider text-white/45 border-b border-white/[0.06]">
                  <th className="text-left font-medium px-4 py-2.5">Code</th>
                  <th className="text-left font-medium px-4 py-2.5">Description</th>
                  <th className="text-right font-medium px-4 py-2.5">Qty</th>
                  <th className="text-right font-medium px-4 py-2.5 hidden md:table-cell">Unit</th>
                  <th className="text-right font-medium px-4 py-2.5 hidden lg:table-cell">
                    Unit price
                  </th>
                  <th className="text-right font-medium px-4 py-2.5">Range</th>
                </tr>
              </thead>
              <tbody>
                {detailed.lineItems.map((li: LineItem, i: number) => (
                  <tr
                    key={`${li.code}-${i}`}
                    className="border-b border-white/[0.04] last:border-b-0"
                  >
                    <td className="px-4 py-2 font-mono tabular text-white/65 whitespace-nowrap">
                      {li.code}
                    </td>
                    <td className="px-4 py-2 text-white/90">{li.description}</td>
                    <td className="px-4 py-2 text-right font-mono tabular text-white/85">
                      {Number.isFinite(li.quantity) ? li.quantity.toFixed(2) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular text-white/55 hidden md:table-cell">
                      {li.unit}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular text-white/65 hidden lg:table-cell">
                      {fmtUSD((li.unitCostLow + li.unitCostHigh) / 2, 2)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular text-white/95 whitespace-nowrap">
                      {fmtUSD(li.extendedLow, 0)} – {fmtUSD(li.extendedHigh, 0)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-white/[0.08] bg-white/[0.02]">
                  <td colSpan={5} className="px-4 py-2.5 text-right text-[11px] uppercase tracking-wider text-white/55">
                    Subtotal
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular text-white/95">
                    {fmtUSD(detailed.subtotalLow, 0)} – {fmtUSD(detailed.subtotalHigh, 0)}
                  </td>
                </tr>
                <tr>
                  <td colSpan={5} className="px-4 py-2 text-right text-[11px] uppercase tracking-wider text-white/55">
                    O&amp;P
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular text-white/85">
                    {fmtUSD(detailed.overheadProfit.low, 0)} – {fmtUSD(detailed.overheadProfit.high, 0)}
                  </td>
                </tr>
                <tr className="border-t border-white/[0.08]">
                  <td colSpan={5} className="px-4 py-3 text-right text-[12px] uppercase tracking-wider text-white">
                    Total
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular text-white text-[13px]">
                    {fmtUSD(detailed.totalLow, 0)} – {fmtUSD(detailed.totalHigh, 0)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Lengths + waste side-by-side */}
      {(lengths || waste) && (
        <div className="grid lg:grid-cols-2 gap-4">
          {lengths && <LengthsCard lengths={lengths} />}
          {waste && <WasteCard waste={waste} />}
        </div>
      )}

      {/* Add-ons */}
      {enabledAddOns.length > 0 && (
        <section className="glass-panel p-5">
          <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
            Enabled add-ons
          </div>
          <ul className="flex flex-col divide-y divide-white/[0.05]">
            {enabledAddOns.map((ao) => (
              <li key={ao.id} className="flex items-center justify-between py-2 text-[13px]">
                <span className="text-white/90">{ao.label}</span>
                <span className="font-mono tabular text-white/75">
                  {fmtUSD(ao.price, 0)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Insurance claim metadata */}
      {estimate.isInsuranceClaim && estimate.claim && (
        <section className="glass-panel p-5">
          <div className="text-[10.5px] uppercase tracking-wider text-amber mb-3">
            Insurance claim · internal
          </div>
          <pre className="text-[11.5px] font-mono text-white/70 whitespace-pre-wrap break-all max-h-[280px] overflow-y-auto">
            {JSON.stringify(estimate.claim, null, 2)}
          </pre>
        </section>
      )}

      {/* Photos */}
      {photos.length > 0 && (
        <section className="glass-panel p-5">
          <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
            Field photos <span className="text-white/30 normal-case">· {photos.length}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {photos.map((p) => {
              const tagLabel = p.tags?.[0]?.kind ?? null;
              return (
                <a
                  key={p.id}
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-xl overflow-hidden border border-white/[0.06] hover:border-cy-300/40 transition-colors"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.url}
                    alt={tagLabel ?? p.filename ?? "Field photo"}
                    className="w-full aspect-square object-cover"
                  />
                  {tagLabel && (
                    <div className="px-2 py-1.5 text-[10.5px] font-mono tabular text-white/70 truncate">
                      {tagLabel}
                    </div>
                  )}
                </a>
              );
            })}
          </div>
        </section>
      )}

      {/* Vision/notes */}
      {(estimate.vision || estimate.notes) && (
        <section className="glass-panel p-5">
          <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
            Notes &amp; vision
          </div>
          {estimate.notes && (
            <p className="text-[13px] text-white/85 leading-relaxed whitespace-pre-wrap mb-3">
              {estimate.notes}
            </p>
          )}
          {estimate.vision && (
            <pre className="text-[11px] font-mono text-white/60 whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
              {JSON.stringify(estimate.vision, null, 2)}
            </pre>
          )}
        </section>
      )}
    </div>
  );
}

/* ─── Subcomponents ──────────────────────────────────────────────────── */

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/[0.05] bg-white/[0.015] px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-white/45">{label}</div>
      <div
        className={`text-[13px] mt-1 text-white/95 ${
          mono ? "font-mono tabular" : "font-medium"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function LengthsCard({ lengths }: { lengths: RoofLengths }) {
  return (
    <section className="glass-panel p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10.5px] uppercase tracking-wider text-white/45">
          Lengths (EagleView-style)
        </div>
        <div className="text-[10px] font-mono tabular text-white/45">
          source: {lengths.source}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px]">
        <LenRow label="Perimeter" value={`${lengths.perimeterLf.toFixed(0)} LF`} />
        <LenRow label="Eaves" value={`${lengths.eavesLf.toFixed(0)} LF`} />
        <LenRow label="Rakes" value={`${lengths.rakesLf.toFixed(0)} LF`} />
        <LenRow label="Ridges" value={`${lengths.ridgesLf.toFixed(0)} LF`} />
        <LenRow label="Hips" value={`${lengths.hipsLf.toFixed(0)} LF`} />
        <LenRow label="Valleys" value={`${lengths.valleysLf.toFixed(0)} LF`} />
        <LenRow label="Drip edge" value={`${lengths.dripEdgeLf.toFixed(0)} LF`} />
        <LenRow label="Flashing" value={`${lengths.flashingLf.toFixed(0)} LF`} />
        <LenRow label="Step flashing" value={`${lengths.stepFlashingLf.toFixed(0)} LF`} />
        <LenRow label="I&W shield" value={`${lengths.iwsSqft.toFixed(0)} sf`} />
      </dl>
    </section>
  );
}

function LenRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-white/50">{label}</dt>
      <dd className="font-mono tabular text-white/90 text-right">{value}</dd>
    </>
  );
}

function WasteCard({ waste }: { waste: WasteTable }) {
  return (
    <section className="glass-panel p-5">
      <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
        Waste table
      </div>
      <div className="text-[12.5px] mb-3 flex items-center justify-between">
        <span className="text-white/55">Measured</span>
        <span className="font-mono tabular text-white/90">
          {waste.measuredSqft.toFixed(0)} sf · {waste.measuredSquares.toFixed(2)} sq
        </span>
      </div>
      <div className="text-[12.5px] mb-3 flex items-center justify-between">
        <span className="text-white/55">Suggested ({waste.suggestedPct}%)</span>
        <span className="font-mono tabular text-cy-300">
          {waste.suggestedSqft.toFixed(0)} sf · {waste.suggestedSquares.toFixed(2)} sq
        </span>
      </div>
      <div className="border-t border-white/[0.06] pt-3">
        <div className="text-[10px] uppercase tracking-wider text-white/45 mb-1.5">
          Bracket
        </div>
        <div className="flex flex-wrap gap-1.5">
          {waste.rows.map((r) => (
            <span
              key={r.pct}
              className={`text-[10.5px] font-mono tabular px-2 py-0.5 rounded-full border ${
                r.isSuggested
                  ? "text-cy-300 border-cy-300/40 bg-cy-300/[0.06]"
                  : r.isMeasured
                    ? "text-white/85 border-white/15 bg-white/[0.04]"
                    : "text-white/50 border-white/[0.06]"
              }`}
            >
              {r.pct}% · {r.squares.toFixed(1)}sq
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
