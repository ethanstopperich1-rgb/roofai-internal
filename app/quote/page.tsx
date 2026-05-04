"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  MapPin,
  Search,
  Shield,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { AuroraButton } from "@/components/ui/aurora-button";
import { fmt, MATERIAL_RATES } from "@/lib/pricing";
import type { AddressInfo, Material } from "@/types/estimate";
import { BRAND_CONFIG } from "@/lib/branding";
import Link from "next/link";

const STEPS = ["Address", "Roof", "Material", "Quote"] as const;
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

const MATERIAL_COPY: Record<Material, { title: string; tagline: string; warranty: string }> = {
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
  const [step, setStep] = useState<StepKey>("Address");
  const [addressText, setAddressText] = useState("");
  const [address, setAddress] = useState<AddressInfo | null>(null);
  const [sqft, setSqft] = useState<number | null>(null);
  const [pitch, setPitch] = useState<string | null>(null);
  const [satelliteUrl, setSatelliteUrl] = useState<string | null>(null);
  const [loadingRoof, setLoadingRoof] = useState(false);
  const [material, setMaterial] = useState<Material>("asphalt-architectural");
  const [addOns, setAddOns] = useState<SimpleAddon[]>(QUOTE_ADDONS);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ leadId: string } | null>(null);
  const [submitError, setSubmitError] = useState("");

  const stepIdx = STEPS.indexOf(step);

  // Pricing — uses RoofingCalculator's published industry low/high installed
  // ranges per sqft (already includes labor). Add-ons and tear-off are layered
  // on top so the public quote tracks national averages without surprise.
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

  const fetchRoof = async (a: AddressInfo) => {
    if (a.lat == null || a.lng == null) return;
    setLoadingRoof(true);
    try {
      const res = await fetch(`/api/solar?lat=${a.lat}&lng=${a.lng}`);
      if (res.ok) {
        const data = await res.json();
        if (data.sqft) setSqft(data.sqft);
        if (data.pitch) setPitch(data.pitch);
      }
      const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";
      if (key) {
        setSatelliteUrl(
          `https://maps.googleapis.com/maps/api/staticmap?center=${a.lat},${a.lng}&zoom=20&size=720x420&maptype=satellite&markers=color:0x67dcff%7C${a.lat},${a.lng}&key=${key}`,
        );
      }
    } finally {
      setLoadingRoof(false);
    }
  };

  const goNext = () => {
    if (step === "Address" && address?.lat) {
      setStep("Roof");
      fetchRoof(address);
    } else if (step === "Roof") {
      setStep("Material");
    } else if (step === "Material") {
      setStep("Quote");
    }
  };
  const goBack = () => {
    const i = STEPS.indexOf(step);
    if (i > 0) setStep(STEPS[i - 1]);
  };

  const submit = async () => {
    setSubmitError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          phone,
          address: address?.formatted ?? addressText,
          zip: address?.zip,
          lat: address?.lat,
          lng: address?.lng,
          estimatedSqft: sqft,
          material,
          selectedAddOns: addOns.filter((a) => a.enabled).map((a) => a.id),
          estimateLow: range.low,
          estimateHigh: range.high,
          source: "quote-wizard",
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

  return (
    <div className="min-h-screen flex flex-col">
      <PublicHeader />
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 space-y-8">
        {!submitted && (
          <Stepper current={stepIdx} />
        )}

        {step === "Address" && !submitted && (
          <AddressStep
            value={addressText}
            onChange={setAddressText}
            onSelect={(a) => {
              setAddress(a);
              setStep("Roof");
              fetchRoof(a);
            }}
            onSubmitTyped={() => {
              if (address?.lat) goNext();
            }}
          />
        )}

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
            name={name}
            setName={setName}
            email={email}
            setEmail={setEmail}
            phone={phone}
            setPhone={setPhone}
            onBack={goBack}
            onSubmit={submit}
            submitting={submitting}
            error={submitError}
          />
        )}

        {submitted && (
          <ThankYou leadId={submitted.leadId} range={range} />
        )}
      </main>
      <PublicFooter />
    </div>
  );
}

/* ─── Header / Footer ─────────────────────────────────────────────────── */

function PublicHeader() {
  return (
    <header className="border-b border-white/[0.06] bg-[#07090d]/70 backdrop-blur-xl">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <Link href="/quote" className="flex items-center gap-2">
          <img
            src="/brand/logo-wordmark-alpha.png"
            alt="Voxaris Pitch"
            width={1672}
            height={941}
            className="h-9 sm:h-11 w-auto max-w-[200px] object-contain"
          />
        </Link>
        <div className="hidden sm:flex items-center gap-3 text-[12px] text-slate-300">
          <ShieldCheck size={13} className="text-mint" />
          <span>Free · No-obligation estimate</span>
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
                className={`flex-1 h-px ${
                  i < current ? "bg-mint/40" : "bg-white/[0.06]"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ─── Step 1 — Address ────────────────────────────────────────────────── */

function AddressStep({
  value,
  onChange,
  onSelect,
  onSubmitTyped,
}: {
  value: string;
  onChange: (s: string) => void;
  onSelect: (a: AddressInfo) => void;
  onSubmitTyped: () => void;
}) {
  const [suggestions, setSuggestions] = useState<Array<{ placeId: string; text: string }>>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [loading, setLoading] = useState(false);
  const skipRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (skipRef.current) {
      skipRef.current = false;
      return;
    }
    if (!value || value.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/places/autocomplete?q=${encodeURIComponent(value)}`,
          { signal: ctrl.signal },
        );
        const data = await res.json();
        setSuggestions(data.suggestions ?? []);
        setHi(0);
        setOpen(true);
      } catch {
        /* aborted */
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [value]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const pick = async (s: { placeId: string; text: string }) => {
    skipRef.current = true;
    onChange(s.text);
    setOpen(false);
    setSuggestions([]);
    try {
      const res = await fetch(`/api/places/details?placeId=${s.placeId}`);
      const data = await res.json();
      onSelect({
        formatted: data.formatted ?? s.text,
        zip: data.zip,
        lat: data.lat,
        lng: data.lng,
      });
    } catch {
      onSelect({ formatted: s.text });
    }
  };

  return (
    <div className="space-y-5 float-in">
      <div>
        <h1 className="font-display text-[28px] sm:text-[36px] md:text-[44px] leading-[1.05] tracking-tight font-medium">
          What does a new roof cost{" "}
          <span className="bg-gradient-to-r from-cy-300 via-cy-400 to-mint bg-clip-text text-transparent">
            at your home
          </span>
          ?
        </h1>
        <p className="text-slate-400 text-[14px] mt-3 max-w-xl">
          Enter your address. We'll measure your roof from satellite and give you a price range
          in under a minute. Free, no calls until you ask.
        </p>
      </div>

      <div ref={wrapRef} className="relative">
        <div className="flex items-center gap-2 rounded-2xl border border-white/[0.075] bg-black/30 hover:border-white/[0.13] focus-within:border-cy-300/55 focus-within:shadow-[0_0_0_4px_rgba(56,197,238,0.10)] transition-all pl-4 pr-2 py-2">
          <Search size={18} strokeWidth={2} className="text-slate-500 flex-shrink-0" />
          <input
            className="flex-1 min-w-0 bg-transparent border-0 outline-none py-3 text-[16px] sm:text-[18px] font-medium tracking-tight text-slate-50 placeholder:text-slate-600"
            placeholder="123 Main Street, Austin, TX…"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => suggestions.length > 0 && setOpen(true)}
            onKeyDown={(e) => {
              if (open && suggestions.length) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHi((h) => (h + 1) % suggestions.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHi((h) => (h - 1 + suggestions.length) % suggestions.length);
                  return;
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  pick(suggestions[hi]);
                  return;
                }
              }
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmitTyped();
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />
          {loading && <Loader2 size={15} className="animate-spin text-slate-400 mx-2" />}
          <AuroraButton
            onClick={onSubmitTyped}
            className="flex-shrink-0 px-4 sm:px-5 py-2.5 font-medium text-[14px] tracking-tight inline-flex items-center gap-2"
          >
            See my quote <ArrowRight size={14} />
          </AuroraButton>
        </div>

        {open && suggestions.length > 0 && (
          <div
            className="absolute left-0 right-0 top-full mt-2 z-[100] rounded-2xl overflow-hidden shadow-2xl border border-white/10 float-in"
            style={{
              background: "rgba(11,14,20,0.96)",
              backdropFilter: "blur(28px) saturate(160%)",
              WebkitBackdropFilter: "blur(28px) saturate(160%)",
              boxShadow:
                "0 32px 64px -16px rgba(0,0,0,0.85), inset 0 1px 0 rgba(255,255,255,0.06)",
            }}
          >
            {suggestions.slice(0, 5).map((s, i) => (
              <button
                key={s.placeId}
                onClick={() => pick(s)}
                onMouseEnter={() => setHi(i)}
                className={`relative w-full text-left px-4 py-3 flex items-center gap-3 border-b border-white/[0.04] last:border-b-0 transition group ${
                  i === hi ? "bg-cy-300/[0.08]" : "hover:bg-white/[0.025]"
                }`}
              >
                {i === hi && (
                  <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-r-full bg-cy-300" />
                )}
                <MapPin size={14} className={i === hi ? "text-cy-300" : "text-slate-500"} />
                <span className={`truncate text-[14px] ${i === hi ? "text-cy-100" : "text-slate-200"}`}>
                  {s.text}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid sm:grid-cols-3 gap-3 pt-3">
        <Trust icon={<Sparkles size={13} />} title="Satellite-measured" body="No tape measure visit needed" />
        <Trust icon={<Shield size={13} />} title="Private" body="Your address is never sold" />
        <Trust icon={<ShieldCheck size={13} />} title="No obligation" body="See the price before sharing contact" />
      </div>
    </div>
  );
}

function Trust({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.05] bg-white/[0.015] px-4 py-3">
      <div className="flex items-center gap-1.5 text-cy-300">{icon}<span className="text-[11px] font-mono uppercase tracking-[0.14em]">{title}</span></div>
      <div className="text-[13px] text-slate-300 mt-0.5">{body}</div>
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

/* ─── Step 4 — Quote + lead capture ───────────────────────────────────── */

function QuoteStep({
  range,
  name,
  setName,
  email,
  setEmail,
  phone,
  setPhone,
  onBack,
  onSubmit,
  submitting,
  error,
}: {
  range: { low: number; high: number };
  name: string;
  setName: (s: string) => void;
  email: string;
  setEmail: (s: string) => void;
  phone: string;
  setPhone: (s: string) => void;
  onBack: () => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string;
}) {
  const valid = name.trim().length > 1 && /\S+@\S+\.\S+/.test(email);
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
          style={{ background: "radial-gradient(closest-side, rgba(95,227,176,0.12), transparent)" }}
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

      <div className="glass rounded-3xl p-6 space-y-4">
        <div>
          <div className="font-display font-semibold tracking-tight text-[15px]">
            Where should we send your detailed quote?
          </div>
          <div className="text-[12px] text-slate-400 mt-1">
            One of our partner roofers will reach out within 1 business hour. We never sell your info.
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Full name">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
              autoComplete="name"
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@example.com"
              autoComplete="email"
            />
          </Field>
        </div>
        <Field label="Phone (optional)">
          <input
            type="tel"
            className="input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(555) 123-4567"
            autoComplete="tel"
          />
        </Field>

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
            disabled={!valid || submitting}
            className={`px-5 py-2.5 font-medium text-[14px] tracking-tight inline-flex items-center gap-2 ${
              !valid || submitting ? "opacity-60 cursor-not-allowed" : ""
            }`}
          >
            {submitting ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Sending…
              </>
            ) : (
              <>
                Get my detailed quote <ArrowRight size={14} />
              </>
            )}
          </AuroraButton>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-slate-400 mb-1.5">
        {label}
      </div>
      {children}
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
          You're all set.
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

/* ─── Shared NavButtons ───────────────────────────────────────────────── */

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
