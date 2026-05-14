"use client";

import { useEffect, useState, use } from "react";
import { getEstimateTagged, tagEstimate } from "@/lib/storage";
import type { Estimate } from "@/types/estimate";
import type { EstimateV2, LoadedEstimate } from "@/types/roof";
import { fmt, MATERIAL_RATES } from "@/lib/pricing";
import { RoofTotalsCard } from "@/components/roof/RoofTotalsCard";
import { DetectedFeaturesPanel } from "@/components/roof/DetectedFeaturesPanel";
import { Check, MapPin, Mail, Phone, ShieldCheck, Link2, Printer } from "lucide-react";
import { BRAND_CONFIG } from "@/lib/branding";
import PublicHeader from "@/components/ui/public-header";
import PublicFooter from "@/components/ui/public-footer";

export default function CustomerProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // Tagged load result — `kind` is "v1" or "v2" so we can render two
  // parallel views without typing the union through every component.
  // tagEstimate is browser-safe; the console.log inside it is guarded.
  const [loaded, setLoaded] = useState<LoadedEstimate | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    // Try Supabase first — works cross-device (the original Cursor
    // finding was that localStorage-only proposals never loaded on the
    // customer's phone because they were saved on the rep's laptop).
    // Falls back to localStorage on 404/503 so the rep's own preview
    // still works AND so the page works without Supabase env wired up.
    let cancelled = false;
    fetch(`/api/proposals/${encodeURIComponent(id)}`)
      .then(async (r) => {
        if (cancelled) return;
        if (r.ok) {
          const data = (await r.json()) as { estimate?: unknown };
          if (data.estimate) {
            setLoaded(tagEstimate(data.estimate));
            setIsLoaded(true);
            return;
          }
        }
        // getEstimateTagged returns either v1 or v2 — getEstimate (the
        // pre-Tier-C helper) silently filtered to v1 and dropped v2
        // estimates saved only to localStorage on the way to /p/.
        setLoaded(getEstimateTagged(id));
        setIsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLoaded(getEstimateTagged(id));
        setIsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  /* Wraps every state (loading / not-found / proposal) with the
     shared PublicHeader + PublicFooter so the proposal page reads
     as part of the product — not a stranded one-off. */

  if (!isLoaded) {
    return (
      <ProposalShell>
        <div className="min-h-[40vh] flex items-center justify-center text-slate-400 text-[13px]">
          Loading proposal…
        </div>
      </ProposalShell>
    );
  }

  if (!loaded) {
    return (
      <ProposalShell>
        <div className="min-h-[40vh] flex items-center justify-center text-center px-6">
          <div>
            <div className="font-display text-2xl mb-2">Proposal not found</div>
            <div className="text-[13px] text-slate-400">
              This proposal link may have expired. Please contact your representative.
            </div>
          </div>
        </div>
      </ProposalShell>
    );
  }

  // Branch on the tagged kind. v2 is the Tier C canonical shape (RoofData
  // + priced + pricingInputs); v1 is the legacy Estimate. Renderers are
  // intentionally parallel — same outer shell, different data sources —
  // so swapping render logic in one doesn't drag the other along.
  return (
    <ProposalShell>
      {loaded.kind === "v2" ? (
        <V2ProposalView estimate={loaded.estimate} />
      ) : (
        <LegacyProposalView estimate={loaded.estimate} />
      )}
    </ProposalShell>
  );
}

/* ─── V2 renderer ───────────────────────────────────────────────────── */

function V2ProposalView({ estimate }: { estimate: EstimateV2 }) {
  const created = new Date(estimate.createdAt);
  const { priced, roofData, pricingInputs } = estimate;
  const enabledAddOns = pricingInputs.addOns.filter((a) => a.enabled);
  // Headline mid-point — keeps a single dominant number on the page
  // while preserving the canonical low/high range immediately under it.
  const totalMid = Math.round((priced.totalLow + priced.totalHigh) / 2);
  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <ProposalActions />
      <div className="glass-strong rounded-3xl p-7 md:p-9 relative overflow-hidden">
        <div
          className="absolute -top-20 -right-20 w-[420px] h-[420px] rounded-full blur-3xl pointer-events-none opacity-50"
          style={{ background: "radial-gradient(closest-side, rgba(103,220,255,0.18), transparent)" }}
        />
        <div className="relative">
          <div className="flex items-center justify-between mb-6">
            <div className="chip chip-accent">
              <ShieldCheck size={11} /> Proposal
            </div>
            <div className="font-mono tabular text-[10px] uppercase tracking-[0.16em] text-slate-500">
              {created.toLocaleDateString()} · #{estimate.id.slice(-6)}
            </div>
          </div>

          <h1 className="font-display text-[28px] md:text-[34px] leading-[1.1] tracking-tight font-medium mb-1">
            Roofing Proposal
            {estimate.customerName ? (
              <>
                {" "}
                for{" "}
                <span className="font-semibold text-slate-50 tracking-[-0.01em]">
                  {estimate.customerName}
                </span>
              </>
            ) : null}
          </h1>
          <div className="text-[13px] text-slate-400 flex items-center gap-1.5 mt-2">
            <MapPin size={12} /> {estimate.address.formatted}
          </div>

          <div className="my-7 divider" />

          <div className="flex items-end justify-between gap-6 flex-wrap">
            <div>
              <div className="label mb-1.5">Project Total</div>
              <div className="font-display tabular text-[64px] md:text-[88px] leading-[0.92] font-semibold tracking-[-0.04em] text-slate-50">
                {fmt(totalMid)}
              </div>
              <div className="font-mono text-[11px] text-slate-400 tabular mt-1">
                range {fmt(priced.totalLow)} <span className="text-slate-600">→</span> {fmt(priced.totalHigh)}
              </div>
            </div>
            <div className="text-right">
              <div className="label mb-1.5">Service</div>
              <div className="font-display text-[18px] font-medium tracking-tight">
                {pricingInputs.serviceType?.replace("-", " ") ?? "Replacement"}
              </div>
              <div className="font-mono text-[11px] text-slate-400 mt-1">
                {/* Use the customer-pickable label set when present; otherwise
                    fall back to the raw material id (covers wood-shake /
                    flat-membrane vision detections that aren't in MATERIAL_RATES). */}
                {pricingInputs.material in MATERIAL_RATES
                  ? MATERIAL_RATES[pricingInputs.material as keyof typeof MATERIAL_RATES].label
                  : pricingInputs.material}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tier C canonical roof panels — exactly the same components the
          /quote wizard mounts on its Quote step, so the customer sees a
          consistent view from estimate → proposal share link. */}
      {roofData.source !== "none" && (
        <>
          <RoofTotalsCard data={roofData} />
          <DetectedFeaturesPanel data={roofData} variant="customer" />
        </>
      )}

      {/* Simplified line items — collapsed by category, no per-facet
          attribution surfaces on the customer-facing share link. */}
      {priced.simplifiedItems.length > 0 && (
        <div className="glass rounded-3xl p-6 space-y-3">
          <div className="font-display font-semibold tracking-tight text-[15px]">What&apos;s Included</div>
          <ul className="divide-y divide-white/[0.06]">
            {priced.simplifiedItems.map((row, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-3 py-3 text-[13px]"
              >
                <span className="text-slate-200">{row.group}</span>
                <span className="font-mono tabular text-slate-300 text-[12.5px]">
                  {row.totalLow === row.totalHigh
                    ? fmt(row.totalLow)
                    : `${fmt(row.totalLow)} – ${fmt(row.totalHigh)}`}
                </span>
              </li>
            ))}
          </ul>
          {enabledAddOns.length > 0 && (
            <>
              <div className="divider" />
              <div className="space-y-2">
                <div className="label">Upgrades & Add-ons</div>
                {enabledAddOns.map((a) => (
                  <div key={a.id} className="flex items-center gap-2.5 text-[13px]">
                    <Check size={13} className="text-mint flex-shrink-0" />
                    {a.label}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div className="glass rounded-3xl p-6 space-y-3 text-[12.5px] text-slate-400 leading-relaxed">
        <div className="font-display font-semibold text-slate-200 text-[15px] tracking-tight">Notes</div>
        <p>
          This estimate is valid for 30 days. Final pricing is contingent on an on-site
          inspection. All work performed to manufacturer specification and local code.
        </p>
        {estimate.isInsuranceClaim && (
          <p className="text-amber">
            This proposal is structured for insurance-claim review and includes Xactimate-style line items in the supplemental documents.
          </p>
        )}
      </div>

      <ProposalFooter staff={estimate.staff} />
    </div>
  );
}

/* ─── Legacy v1 renderer ────────────────────────────────────────────── */

function LegacyProposalView({ estimate }: { estimate: Estimate }) {
  const enabledAddOns = estimate.addOns.filter((a) => a.enabled);
  const created = new Date(estimate.createdAt);

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Share + Print actions. .no-print hides them when the customer
          prints the page. */}
      <ProposalActions />
      <div className="glass-strong rounded-3xl p-7 md:p-9 relative overflow-hidden">
        <div
          className="absolute -top-20 -right-20 w-[420px] h-[420px] rounded-full blur-3xl pointer-events-none opacity-50"
          style={{ background: "radial-gradient(closest-side, rgba(103,220,255,0.18), transparent)" }}
        />
        <div className="relative">
          <div className="flex items-center justify-between mb-6">
            <div className="chip chip-accent">
              <ShieldCheck size={11} /> Proposal
            </div>
            <div className="font-mono tabular text-[10px] uppercase tracking-[0.16em] text-slate-500">
              {created.toLocaleDateString()} · #{estimate.id.slice(-6)}
            </div>
          </div>

          {/* Customer name uses display-weight 600 + slate-50 (not cyan)
              because cyan looked like a clickable link in the H1. */}
          <h1 className="font-display text-[28px] md:text-[34px] leading-[1.1] tracking-tight font-medium mb-1">
            Roofing Proposal
            {estimate.customerName ? (
              <>
                {" "}
                for{" "}
                <span className="font-semibold text-slate-50 tracking-[-0.01em]">
                  {estimate.customerName}
                </span>
              </>
            ) : null}
          </h1>
          <div className="text-[13px] text-slate-400 flex items-center gap-1.5 mt-2">
            <MapPin size={12} /> {estimate.address.formatted}
          </div>

          <div className="my-7 divider" />

          <div className="flex items-end justify-between gap-6 flex-wrap">
            <div>
              <div className="label mb-1.5">Project Total</div>
              <div className="font-display tabular text-[64px] md:text-[88px] leading-[0.92] font-semibold tracking-[-0.04em] text-slate-50">
                {fmt(estimate.total)}
              </div>
              <div className="font-mono text-[11px] text-slate-400 tabular mt-1">
                range {fmt(estimate.baseLow)} <span className="text-slate-600">→</span> {fmt(estimate.baseHigh)}
              </div>
            </div>
            <div className="text-right">
              <div className="label mb-1.5">Service</div>
              <div className="font-display text-[18px] font-medium tracking-tight">
                {estimate.assumptions.serviceType?.replace("-", " ") ?? "Replacement"}
              </div>
              <div className="font-mono text-[11px] text-slate-400 mt-1">
                {MATERIAL_RATES[estimate.assumptions.material].label}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="glass rounded-3xl p-6 space-y-4">
        <div className="font-display font-semibold tracking-tight text-[15px]">What&apos;s Included</div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Spec label="Roof size" value={`${estimate.assumptions.sqft.toLocaleString()} sq ft`} />
          <Spec label="Pitch" value={estimate.assumptions.pitch} />
          <Spec label="Material" value={MATERIAL_RATES[estimate.assumptions.material].label} />
          <Spec label="Estimated age" value={`${estimate.assumptions.ageYears} yrs`} />
        </div>
        {enabledAddOns.length > 0 && (
          <>
            <div className="divider" />
            <div className="space-y-2">
              <div className="label">Upgrades & Add-ons</div>
              {enabledAddOns.map((a) => (
                <div key={a.id} className="flex items-center gap-2.5 text-[13px]">
                  <Check size={13} className="text-mint flex-shrink-0" />
                  {a.label}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="glass rounded-3xl p-6 space-y-3 text-[12.5px] text-slate-400 leading-relaxed">
        <div className="font-display font-semibold text-slate-200 text-[15px] tracking-tight">Notes</div>
        <p>
          This estimate is valid for 30 days. Final pricing is contingent on an on-site
          inspection. All work performed to manufacturer specification and local code.
        </p>
        {estimate.isInsuranceClaim && (
          <p className="text-amber">
            This proposal is structured for insurance-claim review and includes Xactimate-style line items in the supplemental documents.
          </p>
        )}
      </div>

      <ProposalFooter staff={estimate.staff} />
    </div>
  );
}

/* ─── Shared chrome / helpers ────────────────────────────────────────── */

function ProposalFooter({ staff }: { staff: string }) {
  return (
    <div className="flex items-center justify-between pt-4 pb-2 text-[11.5px] text-slate-500">
      <div>
        Prepared by <span className="text-slate-300">{staff || BRAND_CONFIG.companyName}</span>
      </div>
      <div className="flex items-center gap-3">
        {BRAND_CONFIG.email && (
          <a href={`mailto:${BRAND_CONFIG.email}`} className="hover:text-cy-300 inline-flex items-center gap-1">
            <Mail size={11} /> {BRAND_CONFIG.email}
          </a>
        )}
        {BRAND_CONFIG.phone && (
          <a href={`tel:${BRAND_CONFIG.phone}`} className="hover:text-cy-300 inline-flex items-center gap-1">
            <Phone size={11} /> {BRAND_CONFIG.phone}
          </a>
        )}
      </div>
    </div>
  );
}

/** Shared chrome wrapper so loading / not-found / proposal states all
 *  share the same PublicHeader + PublicFooter. Avoids the early-return
 *  pattern dropping out of chrome on edge cases. */
function ProposalShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex flex-col">
      {/* `.no-print` on header + footer so when the customer prints
          the proposal they get the proposal CONTENT only — not nav
          chrome that would look like fax-machine garbage on paper.
          The page-level @media print rules in globals.css also flip
          the background to white and disable aurora animations. */}
      <div className="no-print contents">
        <PublicHeader chip={undefined} rightSlot={null} logoHref="/quote" />
      </div>
      <main id="main-content" className="flex-1 px-4 sm:px-6 py-8 sm:py-12 proposal-print-root">{children}</main>
      <div className="no-print contents">
        <PublicFooter />
      </div>
    </div>
  );
}

/** Share-link copy + Print buttons. Renders above the proposal card so
 *  it's discoverable. Both actions hidden in print output via .no-print. */
function ProposalActions() {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      // Fall back to a textarea + execCommand on browsers that block
      // navigator.clipboard on insecure contexts (we're https in prod
      // so the modern path should work in 99% of cases; the fallback
      // is for older iOS Safari + dev preview HTTPS contexts).
      const href = window.location.href;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(href);
      } else {
        const ta = document.createElement("textarea");
        ta.value = href;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Last-ditch: open a prompt with the URL so the customer can
      // still copy it manually. Better than failing silently.
      window.prompt("Copy this link to share", window.location.href);
    }
  };
  const onPrint = () => window.print();

  return (
    <div className="no-print flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? "Link copied to clipboard" : "Copy a sharable link to this proposal"}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-slate-200 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.07] hover:border-white/[0.14] transition-colors"
      >
        {copied ? (
          <>
            <Check size={12} className="text-mint" /> Link copied
          </>
        ) : (
          <>
            <Link2 size={12} /> Share link
          </>
        )}
      </button>
      <button
        type="button"
        onClick={onPrint}
        aria-label="Print this proposal"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-slate-200 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.07] hover:border-white/[0.14] transition-colors"
      >
        <Printer size={12} /> Print
      </button>
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.05] bg-white/[0.015] px-4 py-3">
      <div className="label">{label}</div>
      <div className="font-display tabular text-[16px] font-medium tracking-tight mt-1">{value}</div>
    </div>
  );
}
