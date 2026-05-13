"use client";

import { useEffect, useState, use } from "react";
import { getEstimate } from "@/lib/storage";
import type { Estimate } from "@/types/estimate";
import { fmt, MATERIAL_RATES } from "@/lib/pricing";
import { Check, MapPin, Mail, Phone, ShieldCheck } from "lucide-react";
import { BRAND_CONFIG } from "@/lib/branding";
import PublicHeader from "@/components/ui/public-header";
import PublicFooter from "@/components/ui/public-footer";

export default function CustomerProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [loaded, setLoaded] = useState(false);

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
          const data = (await r.json()) as { estimate?: Estimate };
          if (data.estimate) {
            setEstimate(data.estimate);
            setLoaded(true);
            return;
          }
        }
        setEstimate(getEstimate(id) ?? null);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setEstimate(getEstimate(id) ?? null);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  /* Wraps every state (loading / not-found / proposal) with the
     shared PublicHeader + PublicFooter so the proposal page reads
     as part of the product — not a stranded one-off. Previously the
     page rendered the Voxaris logo as a centered float at the top of
     the proposal card itself, with no nav, no footer, no consistency
     with /quote or /storms. PublicHeader gets no nav / no rightSlot
     here because /p/[id] is a CUSTOMER DESTINATION (they got the link
     from their rep); marketing nav would be wrong. The proposal-
     specific "Prepared by ..." footer block stays inside the
     content because it's contextual metadata, not chrome. */

  if (!loaded) {
    return (
      <ProposalShell>
        <div className="min-h-[40vh] flex items-center justify-center text-slate-400 text-[13px]">
          Loading proposal…
        </div>
      </ProposalShell>
    );
  }

  if (!estimate) {
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

  const enabledAddOns = estimate.addOns.filter((a) => a.enabled);
  const created = new Date(estimate.createdAt);

  return (
    <ProposalShell>
    <div className="space-y-6 max-w-3xl mx-auto">
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
            {estimate.customerName ? <> for <span className="text-cy-300">{estimate.customerName}</span></> : null}
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
        <div className="font-display font-semibold tracking-tight text-[15px]">What's Included</div>
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

      <div className="flex items-center justify-between pt-4 pb-2 text-[11.5px] text-slate-500">
        <div>
          Prepared by <span className="text-slate-300">{estimate.staff || BRAND_CONFIG.companyName}</span>
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
    </div>
    </ProposalShell>
  );
}

/** Shared chrome wrapper so loading / not-found / proposal states all
 *  share the same PublicHeader + PublicFooter. Avoids the early-return
 *  pattern dropping out of chrome on edge cases. */
function ProposalShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <PublicHeader chip={undefined} rightSlot={null} logoHref="/quote" />
      <main className="flex-1 px-4 sm:px-6 py-8 sm:py-12">{children}</main>
      <PublicFooter />
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
