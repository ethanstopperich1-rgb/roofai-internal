"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  MapPin,
} from "lucide-react";
import Link from "next/link";
import { AuroraButton } from "@/components/ui/aurora-button";
import { BoltStyleHero, type QuoteHeroFormValues } from "@/components/ui/bolt-style-chat";
import NavHeader from "@/components/ui/nav-header";
import { fmt, MATERIAL_RATES } from "@/lib/pricing";
import type { AddressInfo, Material } from "@/types/estimate";
import { BRAND_CONFIG } from "@/lib/branding";

const STEPS = ["Lead", "Roof", "Material", "Quote"] as const;
type StepKey = (typeof STEPS)[number];

interface SimpleAddon {
  id: string;
  label: string;
  price: number;
  enabled: boolean;
}

const QUOTE_ADDONS: SimpleAddon[] = [
  { id: "ice-water", label: "Ice & water shield", price: 850, enabled: false },
  { id: "ridge-vent", label: "Upgraded ventilation", price: 425, enabled: false },
  { id: "gutters", label: "Seamless gutters", price: 1850, enabled: false },
  { id: "skylight", label: "Skylight replacement", price: 950, enabled: false },
];

const MATERIAL_COPY: Record<
  Material,
  { title: string; tagline: string; warranty: string }
> = {
  "asphalt-3tab": {
    title: "Asphalt 3-Tab",
    tagline: "Reliable, budget-friendly",
    warranty: "20-year warranty",
  },
  "asphalt-architectural": {
    title: "Architectural Shingle",
    tagline: "Most popular · best value",
    warranty: "30-year warranty",
  },
  "metal-standing-seam": {
    title: "Standing-Seam Metal",
    tagline: "Premium · 50+ year lifespan",
    warranty: "50-year warranty",
  },
  "tile-concrete": {
    title: "Concrete Tile",
    tagline: "Distinctive · Mediterranean look",
    warranty: "Lifetime warranty",
  },
};

export default function QuotePage() {
  const [step, setStep] = useState<StepKey>("Lead");
  const [lead, setLead] = useState<QuoteHeroFormValues | null>(null);
  const [address, setAddress] = useState<AddressInfo | null>(null);
  const [sqft, setSqft] = useState<number | null>(null);
  const [pitch, setPitch] = useState<string | null>(null);
  const [satelliteUrl, setSatelliteUrl] = useState<string | null>(null);
  const [loadingRoof, setLoadingRoof] = useState(false);
  const [material, setMaterial] = useState<Material>("asphalt-architectural");
  const [addOns, setAddOns] = useState<SimpleAddon[]>(QUOTE_ADDONS);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ leadId: string } | null>(null);
  const [submitError, setSubmitError] = useState("");

  const stepIdx = STEPS.indexOf(step);

  // Pricing — uses RoofingCalculator's published low/high installed ranges per
  // sqft (already includes labor). Add-ons + tear-off layered on top.
  const range = useMemo(() => {
    if (!sqft) return { low: 0, high: 0 };
    const m = MATERIAL_RATES[material];
    const baseLow = sqft * m.low;
    const baseHigh = sqft * m.high;
    const tearoffLow = sqft * m.removeLow;
    const tearoffHigh = sqft * m.removeHigh;
    const adds = addOns.filter((a) => a.enabled).reduce((s, a) => s + a.price, 0);
    return {
      low: Math.round(baseLow + tearoffLow + adds),
      high: Math.round(baseHigh + tearoffHigh + adds),
    };
  }, [sqft, material, addOns]);

  /** When the lead form is submitted at the hero step:
   *   - Save contact info
   *   - Persist address + lat/lng
   *   - Fire Solar API for roof size + pitch
   *   - Advance to Roof confirmation
   *   - Submit a lead immediately so the contractor sees them even if they
   *     never finish the wizard
   */
  const onLeadSubmit = async (values: QuoteHeroFormValues) => {
    setSubmitting(true);
    setSubmitError("");
    setLead(values);
    const addr: AddressInfo = {
      formatted: values.address,
      zip: values.zip,
      lat: values.lat,
      lng: values.lng,
    };
    setAddress(addr);

    // Fire-and-forget early lead post (so the contractor gets the lead even
    // if the homeowner abandons the wizard before the final step)
    fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: values.name,
        email: values.email,
        phone: values.phone,
        address: values.address,
        zip: values.zip,
        lat: values.lat,
        lng: values.lng,
        source: "quote-wizard-step-1",
      }),
    }).catch(() => {
      /* silent */
    });

    // Solar API for roof size + pitch
    if (addr.lat != null && addr.lng != null) {
      setLoadingRoof(true);
      try {
        const res = await fetch(`/api/solar?lat=${addr.lat}&lng=${addr.lng}`);
        if (res.ok) {
          const data = await res.json();
          if (data.sqft) setSqft(data.sqft);
          if (data.pitch) setPitch(data.pitch);
        }
        const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";
        if (key) {
          setSatelliteUrl(
            `https://maps.googleapis.com/maps/api/staticmap?center=${addr.lat},${addr.lng}&zoom=20&size=720x420&maptype=satellite&markers=color:0x67dcff%7C${addr.lat},${addr.lng}&key=${key}`,
          );
        }
      } finally {
        setLoadingRoof(false);
      }
    }

    setSubmitting(false);
    setStep("Roof");
  };

  const goNext = () => {
    const i = STEPS.indexOf(step);
    if (i < STEPS.length - 1) setStep(STEPS[i + 1]);
  };
  const goBack = () => {
    const i = STEPS.indexOf(step);
    if (i > 0) setStep(STEPS[i - 1]);
  };

  /** Final submit on the Quote step — re-posts lead with the chosen
   *  material + add-ons + estimate range. This is the "confirmed" lead
   *  the contractor's outreach team prioritizes. */
  const submitFinal = async () => {
    if (!lead) return;
    setSubmitError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: lead.name,
          email: lead.email,
          phone: lead.phone,
          address: address?.formatted ?? lead.address,
          zip: address?.zip,
          lat: address?.lat,
          lng: address?.lng,
          estimatedSqft: sqft,
          material,
          selectedAddOns: addOns.filter((a) => a.enabled).map((a) => a.id),
          estimateLow: range.low,
          estimateHigh: range.high,
          source: "quote-wizard-confirmed",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "submit_failed");
      setSubmitted({ leadId: data.leadId });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  };

  // Step 1 — full-bleed bolt hero. No separate header strip — the logo
  // lives INSIDE the bolt canvas (see BoltStyleHero) so there's no color
  // seam between header and hero background.
  if (step === "Lead" && !submitted) {
    return (
      <BoltStyleHero
        title="What will it cost to"
        subtitle="Free, instant, no calls until you ask."
        onSubmit={onLeadSubmit}
        submitting={submitting}
        nav={
          <NavHeader
            items={[
              { label: "Quote", href: "/quote" },
              { label: "How It Works", href: "/quote#how" },
              { label: "FAQ", href: "/quote#faq" },
            ]}
          />
        }
      />
    );
  }

  // Steps 2–4 — wizard with stepper
  return (
    <div className="min-h-screen flex flex-col relative z-[1]">
      <PublicHeader />
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 sm:px-6 py-10 sm:py-16 space-y-8">
        {!submitted && <Stepper current={stepIdx} />}

        {step === "Roof" && !submitted && (
          <RoofStep
            address={address}
            sqft={sqft}
            pitch={pitch}
            satelliteUrl={satelliteUrl}
            loading={loadingRoof}
            onChangeSqft={setSqft}
            onBack={goBack}
            onNext={goNext}
          />
        )}

        {step === "Material" && !submitted && (
          <MaterialStep
            material={material}
            onMaterialChange={setMaterial}
            addOns={addOns}
            onAddOnsChange={setAddOns}
            onBack={goBack}
            onNext={goNext}
          />
        )}

        {step === "Quote" && !submitted && (
          <QuoteStep
            range={range}
            lead={lead}
            onBack={goBack}
            onSubmit={submitFinal}
            submitting={submitting}
            error={submitError}
          />
        )}

        {submitted && <ThankYou leadId={submitted.leadId} range={range} />}
      </main>
      <PublicFooter />
    </div>
  );
}

/* ─── Header / Footer ─────────────────────────────────────────────────── */

function PublicHeader() {
  return (
    <header className="relative z-30 border-b border-white/[0.06] bg-[#07090d]/70 backdrop-blur-xl">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-10 h-16 sm:h-20 flex items-center justify-between gap-3">
        <Link href="/quote" className="flex items-center gap-2 min-w-0">
          <img
            src="/brand/logo-wordmark-alpha.png"
            alt="Voxaris Pitch"
            width={1672}
            height={941}
            className="h-9 sm:h-14 w-auto max-w-[180px] sm:max-w-none object-contain"
          />
          <span className="hidden md:inline-block ml-1 chip text-[10px]">Quick Quote</span>
        </Link>

        <NavHeader
          items={[
            { label: "Quote", href: "/quote" },
            { label: "How It Works", href: "/quote#how" },
            { label: "FAQ", href: "/quote#faq" },
          ]}
        />

        <div className="hidden sm:flex items-center gap-3 text-[12px] text-slate-300">
          <Check size={13} className="text-mint" />
          <span>Free · No-obligation</span>
        </div>
      </div>
    </header>
  );
}

function PublicFooter() {
  return (
    <footer className="border-t border-white/[0.06] mt-12">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 flex items-center justify-between text-[11px] text-slate-500 font-mono">
        <span>© {new Date().getFullYear()} Voxaris</span>
        <div className="flex items-center gap-4">
          <span>Estimates are non-binding</span>
          <span className="hidden sm:inline">·</span>
          <span>{BRAND_CONFIG.tagline}</span>
        </div>
      </div>
    </footer>
  );
}

/* ─── Stepper ─────────────────────────────────────────────────────────── */

function Stepper({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-2 sm:gap-3">
      {STEPS.map((label, i) => {
        const active = i === current;
        const done = i < current;
        return (
          <div key={label} className="flex items-center gap-2 sm:gap-3 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-mono font-semibold tabular flex-shrink-0 ${
                  active
                    ? "bg-cy-300 text-[#051019]"
                    : done
                      ? "bg-mint/20 text-mint border border-mint/30"
                      : "bg-white/[0.04] text-slate-500 border border-white/[0.06]"
                }`}
              >
                {done ? <Check size={12} strokeWidth={3} /> : i + 1}
              </div>
              <span
                className={`hidden sm:inline text-[12px] font-mono uppercase tracking-[0.14em] ${
                  active ? "text-slate-100" : done ? "text-slate-300" : "text-slate-500"
                }`}
              >
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={`flex-1 h-px ${i < current ? "bg-mint/40" : "bg-white/[0.06]"}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ─── Step 2 — Roof confirm ───────────────────────────────────────────── */

function RoofStep({
  address,
  sqft,
  pitch,
  satelliteUrl,
  loading,
  onChangeSqft,
  onBack,
  onNext,
}: {
  address: AddressInfo | null;
  sqft: number | null;
  pitch: string | null;
  satelliteUrl: string | null;
  loading: boolean;
  onChangeSqft: (n: number) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-5 float-in">
      <div>
        <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-cy-300">
          Step 2 · Confirm your roof
        </div>
        <h2 className="font-display text-[24px] sm:text-[30px] leading-tight tracking-tight font-medium mt-2">
          This is your roof
        </h2>
        <p className="text-slate-400 text-[13.5px] mt-2 flex items-center gap-2">
          <MapPin size={13} className="text-slate-500" />
          {address?.formatted ?? "—"}
        </p>
      </div>

      <div className="rounded-2xl overflow-hidden border border-white/[0.075] bg-black/30 aspect-video">
        {loading ? (
          <div className="w-full h-full flex items-center justify-center text-slate-400 text-[13px]">
            <Loader2 size={16} className="animate-spin mr-2" /> Measuring your roof…
          </div>
        ) : satelliteUrl ? (
          <img
            src={satelliteUrl}
            alt={`Satellite view of ${address?.formatted}`}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-500 text-[12px]">
            Satellite imagery unavailable
          </div>
        )}
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="rounded-2xl border border-white/[0.05] bg-white/[0.015] p-4">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-slate-400">
            Estimated roof size
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <input
              type="number"
              value={sqft ?? ""}
              onChange={(e) => onChangeSqft(Number(e.target.value) || 0)}
              className="w-32 bg-transparent border-0 outline-none font-display tabular text-[28px] font-semibold tracking-tight"
            />
            <span className="font-mono text-[12px] text-slate-500">sq ft</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Edit if it looks off</div>
        </div>
        <div className="rounded-2xl border border-white/[0.05] bg-white/[0.015] p-4">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-slate-400">
            Roof pitch
          </div>
          <div className="font-display tabular text-[28px] font-semibold tracking-tight mt-1">
            {pitch ?? "—"}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Auto-detected from satellite</div>
        </div>
      </div>

      <NavButtons onBack={onBack} onNext={onNext} disabled={!sqft} />
    </div>
  );
}

/* ─── Step 3 — Material + add-ons ─────────────────────────────────────── */

function MaterialStep({
  material,
  onMaterialChange,
  addOns,
  onAddOnsChange,
  onBack,
  onNext,
}: {
  material: Material;
  onMaterialChange: (m: Material) => void;
  addOns: SimpleAddon[];
  onAddOnsChange: (a: SimpleAddon[]) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-5 float-in">
      <div>
        <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-cy-300">
          Step 3 · Pick your roof
        </div>
        <h2 className="font-display text-[24px] sm:text-[30px] leading-tight tracking-tight font-medium mt-2">
          What kind of roof do you want?
        </h2>
        <p className="text-slate-400 text-[13.5px] mt-2 max-w-xl">
          Most homeowners go with architectural shingles. You can change this later — this is
          just for the estimate.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        {(Object.keys(MATERIAL_RATES) as Material[]).map((m) => {
          const active = material === m;
          const copy = MATERIAL_COPY[m];
          return (
            <button
              key={m}
              onClick={() => onMaterialChange(m)}
              className={`relative text-left p-5 rounded-2xl border transition ${
                active
                  ? "border-cy-300/40 bg-cy-300/[0.06]"
                  : "border-white/[0.06] bg-white/[0.015] hover:border-white/[0.13] hover:bg-white/[0.03]"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="font-display font-semibold tracking-tight text-[15px]">
                  {copy.title}
                </div>
                {active && (
                  <div className="w-5 h-5 rounded-full bg-cy-300 text-[#051019] flex items-center justify-center">
                    <Check size={12} strokeWidth={3} />
                  </div>
                )}
              </div>
              <div className="text-[12px] text-slate-400 mt-1">{copy.tagline}</div>
              <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-slate-500 mt-3">
                {copy.warranty}
              </div>
            </button>
          );
        })}
      </div>

      <div>
        <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-slate-400 mb-3">
          Optional upgrades
        </div>
        <div className="space-y-2">
          {addOns.map((a) => (
            <div
              key={a.id}
              onClick={() =>
                onAddOnsChange(
                  addOns.map((x) => (x.id === a.id ? { ...x, enabled: !x.enabled } : x)),
                )
              }
              className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition ${
                a.enabled
                  ? "border-cy-300/40 bg-cy-300/[0.06]"
                  : "border-white/[0.05] bg-white/[0.015] hover:border-white/[0.13]"
              }`}
            >
              <div
                className={`w-[18px] h-[18px] rounded-md flex items-center justify-center border ${
                  a.enabled
                    ? "bg-cy-300 border-cy-300 text-[#051019]"
                    : "border-white/20"
                }`}
              >
                {a.enabled && <Check size={12} strokeWidth={3} />}
              </div>
              <div className="flex-1 text-[14px]">{a.label}</div>
              <div className="font-mono tabular text-[12px] text-slate-400">
                +${a.price.toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      </div>

      <NavButtons onBack={onBack} onNext={onNext} />
    </div>
  );
}

/* ─── Step 4 — Quote display + final confirm ─────────────────────────── */

function QuoteStep({
  range,
  lead,
  onBack,
  onSubmit,
  submitting,
  error,
}: {
  range: { low: number; high: number };
  lead: QuoteHeroFormValues | null;
  onBack: () => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string;
}) {
  return (
    <div className="space-y-6 float-in">
      <div>
        <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-cy-300">
          Step 4 · Your estimate
        </div>
        <h2 className="font-display text-[24px] sm:text-[30px] leading-tight tracking-tight font-medium mt-2">
          Your estimated price range
        </h2>
      </div>

      <div className="glass-strong rounded-3xl p-6 sm:p-8 relative overflow-hidden">
        <div
          className="absolute -top-20 right-0 w-[420px] h-[280px] blur-3xl pointer-events-none opacity-50"
          style={{
            background:
              "radial-gradient(closest-side, rgba(95,227,176,0.12), transparent)",
          }}
        />
        <div className="relative">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-slate-400">
            Estimated total
          </div>
          <div className="font-display tabular text-[44px] sm:text-[64px] leading-[0.95] font-semibold tracking-[-0.04em] mt-1">
            {fmt(range.low)} <span className="text-slate-500">–</span> {fmt(range.high)}
          </div>
          <div className="text-[12px] text-slate-400 mt-2">
            Final pricing requires an on-site inspection. No obligation.
          </div>
        </div>
      </div>

      {lead && (
        <div className="glass rounded-3xl p-6 space-y-3">
          <div className="font-display font-semibold tracking-tight text-[15px]">
            We have your details
          </div>
          <div className="text-[12px] text-slate-400">
            We&apos;ll reach out to <span className="text-slate-200">{lead.name}</span> at{" "}
            <span className="text-slate-200">{lead.email}</span> within 1 business hour. No
            unsolicited follow-up beyond that.
          </div>
        </div>
      )}

      {error && (
        <div className="text-[12px] text-rose px-3 py-2 rounded-lg bg-rose/[0.08] border border-rose/20">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-2">
        <button onClick={onBack} className="btn btn-ghost">
          <ArrowLeft size={14} /> Back
        </button>
        <AuroraButton
          onClick={onSubmit}
          disabled={submitting}
          className={`px-5 py-2.5 font-medium text-[14px] tracking-tight inline-flex items-center gap-2 ${
            submitting ? "opacity-60 cursor-not-allowed" : ""
          }`}
        >
          {submitting ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Sending…
            </>
          ) : (
            <>
              Confirm & request detailed quote <ArrowRight size={14} />
            </>
          )}
        </AuroraButton>
      </div>
    </div>
  );
}

/* ─── Thank-you ───────────────────────────────────────────────────────── */

function ThankYou({
  leadId,
  range,
}: {
  leadId: string;
  range: { low: number; high: number };
}) {
  return (
    <div className="space-y-6 float-in text-center">
      <div className="w-14 h-14 mx-auto rounded-2xl bg-mint/10 border border-mint/30 flex items-center justify-center text-mint">
        <Check size={26} strokeWidth={2.5} />
      </div>
      <div>
        <h2 className="font-display text-[28px] sm:text-[36px] leading-tight tracking-tight font-medium">
          You&apos;re all set.
        </h2>
        <p className="text-slate-300 text-[14px] mt-3 max-w-xl mx-auto">
          A Voxaris partner roofer will reach out within 1 business hour with a precise on-site
          quote. Your reference number:
        </p>
        <div className="font-mono text-[13px] text-cy-300 mt-2">{leadId}</div>
      </div>
      <div className="glass rounded-3xl p-5 max-w-md mx-auto">
        <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-slate-400">
          Your estimate range
        </div>
        <div className="font-display tabular text-[28px] font-semibold tracking-tight mt-1">
          {fmt(range.low)} <span className="text-slate-500">–</span> {fmt(range.high)}
        </div>
      </div>
    </div>
  );
}

/* ─── NavButtons ──────────────────────────────────────────────────────── */

function NavButtons({
  onBack,
  onNext,
  disabled,
}: {
  onBack: () => void;
  onNext: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 pt-3">
      <button onClick={onBack} className="btn btn-ghost">
        <ArrowLeft size={14} /> Back
      </button>
      <AuroraButton
        onClick={onNext}
        disabled={disabled}
        className={`px-5 py-2.5 font-medium text-[14px] tracking-tight inline-flex items-center gap-2 ${
          disabled ? "opacity-60 cursor-not-allowed" : ""
        }`}
      >
        Next <ArrowRight size={14} />
      </AuroraButton>
    </div>
  );
}

// Suppress unused-import warning for useEffect (kept for future use)
void useEffect;
