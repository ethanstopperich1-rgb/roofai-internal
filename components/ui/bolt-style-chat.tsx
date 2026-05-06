"use client";

import React, { useEffect, useRef, useState } from "react";
import { ArrowRight, Loader2, MapPin, Search, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { AuroraButton } from "@/components/ui/aurora-button";

interface Suggestion {
  placeId: string;
  text: string;
}

export interface QuoteHeroFormValues {
  name: string;
  email: string;
  phone: string;
  address: string;
  /** Address detail when picked from autocomplete */
  zip?: string;
  lat?: number;
  lng?: number;
}

interface Props {
  title?: string;
  subtitle?: string;
  announcementText?: string;
  onSubmit: (values: QuoteHeroFormValues) => void;
  submitting?: boolean;
  /** Optional nav rendered inside the hero (right-side of the top bar) */
  nav?: React.ReactNode;
  /** Iframe-friendly variant for /embed:
   *   - drops min-h-screen → content-sized (host site picks the height)
   *   - hides the Voxaris logo / nav / free-chip top bar (third-party site)
   *   - shrinks vertical rhythm so the form is visible without scrolling
   *   - replaces the trust-pill row with a single "powered by Voxaris" line
   *
   * The radial blue rays, announcement chip, italicized accent headline,
   * and card form treatment all stay so the embed reads as the same
   * product, not a generic shrunk-down form. */
  embedMode?: boolean;
  /** Override the italicized accent in the headline. Defaults to "roof
   *  your house" — set this when the embed is on a brand's site so the
   *  headline can match local language ("re-roof your home in Tampa"). */
  titleAccent?: string;
  /** Hex color (with #) overriding the cyan accent. Used by /embed to
   *  match the host roofer's brand color on the CTA + ring + outline.
   *  Defaults to undefined (uses the global cy-300 / cy-400 tokens). */
  accentHex?: string;
}

/**
 * Bolt-style hero adapted for the Voxaris Pitch public lead-gen wizard.
 * Radial blue ray background + announcement badge + 4-field form (name,
 * email, phone, address with Google Places autocomplete) + CTA.
 *
 * Source inspiration: 21st.dev/r/hurerag24/bolt-style-chat. Reworked to
 * collect roofing-quote lead info up-front instead of an open chat box.
 */
export function BoltStyleHero({
  title = "What will it cost to",
  subtitle = "Free, instant, no calls until you ask.",
  announcementText = "Voxaris Pitch · Quick Quote",
  onSubmit,
  submitting = false,
  nav,
  embedMode = false,
  titleAccent = "roof your house",
  accentHex,
}: Props) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [picked, setPicked] = useState<Pick<QuoteHeroFormValues, "zip" | "lat" | "lng"> | null>(null);

  const valid =
    name.trim().length > 1 &&
    /\S+@\S+\.\S+/.test(email) &&
    phone.replace(/\D/g, "").length >= 7 &&
    address.trim().length > 4;

  const submit = () => {
    if (!valid || submitting) return;
    onSubmit({
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      address: address.trim(),
      ...(picked ?? {}),
    });
  };

  return (
    <div
      className={`relative flex flex-col items-center w-full overflow-hidden ${
        embedMode ? "py-10 sm:py-14" : "min-h-screen"
      }`}
    >
      <RayBackground />

      {/* Top bar — logo big on the left, nav center, free-no-obligation right.
          Hidden in embed mode (the widget lives inside a third-party site
          where the host's own header is already on screen). */}
      {!embedMode && (
        <header className="relative z-20 w-full">
          <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-10 h-20 sm:h-24 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <img
                src="/brand/logo-wordmark-alpha.png"
                alt="Voxaris Pitch"
                width={1672}
                height={941}
                className="h-12 sm:h-16 w-auto max-w-[260px] object-contain drop-shadow-[0_4px_24px_rgba(103,220,255,0.30)]"
              />
            </div>
            {nav && <div className="hidden md:block">{nav}</div>}
            <div className="hidden sm:flex items-center gap-2 text-[12px] font-mono uppercase tracking-[0.14em] text-slate-300">
              <ShieldCheck size={13} className="text-mint" />
              <span>Free · No-obligation</span>
            </div>
          </div>
        </header>
      )}

      {/* Spacer pushes the rest into the rays */}
      <div
        className={`flex flex-col items-center justify-center w-full ${
          embedMode ? "" : "flex-1 pb-12"
        }`}
      >
        {/* Announcement chip */}
        <div className={`relative z-10 ${embedMode ? "mb-5" : "mb-8"}`}>
          <AnnouncementBadge text={announcementText} />
        </div>

        <div className="relative z-10 w-full max-w-3xl px-4 mx-auto">
        {/* Headline */}
        <div className={`text-center ${embedMode ? "mb-6" : "mb-8"}`}>
          <h1
            className={`font-display leading-[1.05] tracking-[-0.025em] font-semibold text-white ${
              embedMode
                ? "text-[28px] sm:text-[36px] md:text-[42px]"
                : "text-[34px] sm:text-[48px] md:text-[56px]"
            }`}
          >
            {title}{" "}
            <span
              className="bg-gradient-to-b from-cy-300 via-cy-300 to-white bg-clip-text text-transparent italic"
              style={
                accentHex
                  ? {
                      backgroundImage: `linear-gradient(to bottom, ${accentHex}, ${accentHex}, #ffffff)`,
                    }
                  : undefined
              }
            >
              {titleAccent}
            </span>
            ?
          </h1>
          <p className="mt-3 text-[14px] sm:text-[16px] font-medium text-slate-300">
            {subtitle}
          </p>
        </div>

        {/* Form */}
        <div className="relative">
          <div className="absolute -inset-[1px] rounded-2xl bg-gradient-to-b from-white/[0.10] to-transparent pointer-events-none" />
          <div
            className="relative rounded-2xl ring-1 ring-white/[0.08]"
            style={{
              background: "rgba(15,17,22,0.85)",
              backdropFilter: "blur(20px) saturate(140%)",
              WebkitBackdropFilter: "blur(20px) saturate(140%)",
              boxShadow:
                "0 0 0 1px rgba(255,255,255,0.05), 0 28px 60px -20px rgba(0,0,0,0.55)",
            }}
          >
            {/* Address — full-width with autocomplete */}
            <AddressField
              value={address}
              onChange={(v) => {
                setAddress(v);
                setPicked(null);
              }}
              onPick={(s, detail) => {
                setAddress(s.text);
                setPicked(detail);
              }}
            />

            <div className="grid sm:grid-cols-3 border-t border-white/[0.06]">
              <Field
                placeholder="Full name"
                value={name}
                onChange={setName}
                autoComplete="name"
                className="sm:border-r border-white/[0.06]"
              />
              <Field
                type="email"
                placeholder="Email address"
                value={email}
                onChange={setEmail}
                autoComplete="email"
                className="sm:border-r border-white/[0.06]"
              />
              <Field
                type="tel"
                placeholder="Phone number"
                value={phone}
                onChange={setPhone}
                autoComplete="tel"
              />
            </div>

            {/* Footer — submit button */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-white/[0.06]">
              <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-slate-300 hidden sm:flex items-center gap-2">
                <Zap size={11} className="text-cy-300" />
                <span>~5 seconds · we never sell your info</span>
              </div>
              <button
                onClick={submit}
                disabled={!valid || submitting}
                className={`ml-auto flex items-center gap-2 px-5 py-2.5 rounded-xl text-[14px] font-medium transition-all ${
                  valid && !submitting
                    ? accentHex
                      ? "active:scale-[0.98] hover:opacity-90"
                      : "bg-cy-400 hover:bg-cy-300 text-[#051019] shadow-[0_0_24px_rgba(20,136,252,0.45)] active:scale-[0.98]"
                    : "bg-white/10 text-slate-500 cursor-not-allowed"
                }`}
                style={
                  valid && !submitting && accentHex
                    ? {
                        background: accentHex,
                        color: "#051019",
                        boxShadow: `0 0 24px ${accentHex}73`,
                      }
                    : undefined
                }
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Sending…
                  </>
                ) : (
                  <>
                    See my quote <ArrowRight size={14} />
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

          {/* Trust — full grid on /quote, compact single-line on /embed
                so we don't tip the iframe over a fold the host expects. */}
          {embedMode ? (
            <div className="mt-5 flex items-center justify-center gap-2 text-[10.5px] font-mono uppercase tracking-[0.16em] text-slate-400">
              <Sparkles size={11} className="text-cy-300" />
              <span>Satellite-measured · No spam · Powered by Voxaris Pitch</span>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 mt-7">
              <Trust icon={<Sparkles size={13} />} title="Satellite-measured" body="No tape measure visit needed" />
              <Trust icon={<ShieldCheck size={13} />} title="Private" body="Your address is never sold" />
              <Trust
                icon={<ShieldCheck size={13} />}
                title="No obligation"
                body="See the price before sharing more"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Field ───────────────────────────────────────────────────────────── */

function Field({
  type = "text",
  placeholder,
  value,
  onChange,
  autoComplete,
  className = "",
}: {
  type?: string;
  placeholder: string;
  value: string;
  onChange: (s: string) => void;
  autoComplete?: string;
  className?: string;
}) {
  return (
    <input
      type={type}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete={autoComplete}
      className={`w-full bg-transparent border-0 outline-none text-[14px] text-white placeholder:text-slate-500 px-4 py-3.5 ${className}`}
    />
  );
}

/* ─── Address with Places autocomplete ───────────────────────────────── */

function AddressField({
  value,
  onChange,
  onPick,
}: {
  value: string;
  onChange: (s: string) => void;
  onPick: (
    s: Suggestion,
    detail: { zip?: string; lat?: number; lng?: number },
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [hi, setHi] = useState(0);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const skip = useRef(false);

  useEffect(() => {
    if (skip.current) {
      skip.current = false;
      return;
    }
    if (!value || value.trim().length < 3) {
      setItems([]);
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
        setItems(data.suggestions ?? []);
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

  const pick = async (s: Suggestion) => {
    skip.current = true;
    setOpen(false);
    setItems([]);
    try {
      const res = await fetch(`/api/places/details?placeId=${s.placeId}`);
      const data = await res.json();
      onPick(
        { ...s, text: data.formatted ?? s.text },
        { zip: data.zip, lat: data.lat, lng: data.lng },
      );
    } catch {
      onPick(s, {});
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <Search size={16} className="text-slate-500 flex-shrink-0" />
        <input
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[15px] sm:text-[16px] text-white placeholder:text-slate-500"
          placeholder="123 Main St, your city, state"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => items.length > 0 && setOpen(true)}
          onKeyDown={(e) => {
            if (open && items.length) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHi((h) => (h + 1) % items.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setHi((h) => (h - 1 + items.length) % items.length);
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                pick(items[hi]);
                return;
              }
            }
          }}
          autoComplete="off"
          spellCheck={false}
        />
        {loading && <Loader2 size={14} className="text-slate-400 animate-spin" />}
      </div>
      {open && items.length > 0 && (
        <div
          className="absolute left-0 right-0 top-full mt-1 z-[100] rounded-xl overflow-hidden shadow-2xl border border-white/10"
          style={{
            background: "rgba(11,14,20,0.96)",
            backdropFilter: "blur(28px) saturate(160%)",
            WebkitBackdropFilter: "blur(28px) saturate(160%)",
          }}
        >
          {items.slice(0, 5).map((s, i) => (
            <button
              key={s.placeId}
              onClick={() => pick(s)}
              onMouseEnter={() => setHi(i)}
              className={`relative w-full text-left px-4 py-3 flex items-center gap-3 border-b border-white/[0.04] last:border-b-0 transition ${
                i === hi ? "bg-cy-300/[0.08]" : "hover:bg-white/[0.025]"
              }`}
            >
              <MapPin size={13} className={i === hi ? "text-cy-300" : "text-slate-500"} />
              <span className={`truncate text-[13.5px] ${i === hi ? "text-cy-100" : "text-slate-200"}`}>
                {s.text}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Trust pills ─────────────────────────────────────────────────────── */

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
    <div
      className="rounded-2xl px-4 py-3 border"
      style={{
        background: "rgba(15,17,22,0.55)",
        borderColor: "rgba(255,255,255,0.06)",
      }}
    >
      <div className="flex items-center gap-1.5 text-cy-300">
        {icon}
        <span className="text-[10px] font-mono uppercase tracking-[0.14em]">{title}</span>
      </div>
      <div className="text-[12.5px] text-slate-300 mt-1">{body}</div>
    </div>
  );
}

/* ─── Announcement chip ───────────────────────────────────────────────── */

function AnnouncementBadge({ text }: { text: string }) {
  return (
    <div
      className="relative inline-flex items-center gap-2 px-5 py-2 min-h-[40px] rounded-full text-sm overflow-hidden transition-all duration-300 hover:scale-[1.02]"
      style={{
        background:
          "linear-gradient(135deg, rgba(255,255,255,0.10), rgba(255,255,255,0.05))",
        backdropFilter: "blur(20px) saturate(140%)",
        boxShadow:
          "inset 0 1px rgba(255,255,255,0.20), inset 0 -1px rgba(0,0,0,0.10), 0 8px 32px -8px rgba(0,0,0,0.10), 0 0 0 1px rgba(255,255,255,0.08)",
      }}
    >
      <span
        className="absolute top-0 left-0 right-0 h-1/2 pointer-events-none opacity-70 mix-blend-overlay"
        style={{
          background:
            "radial-gradient(ellipse at center top, rgba(255,255,255,0.15) 0%, transparent 70%)",
        }}
      />
      <span
        className="absolute -top-px left-1/2 -translate-x-1/2 h-[2px] w-[100px] opacity-60"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, rgba(103,220,255,0.85) 50%, transparent 100%)",
          filter: "blur(0.5px)",
        }}
      />
      <Zap size={14} className="relative z-10 text-cy-300" />
      <span className="relative z-10 text-white font-medium">{text}</span>
    </div>
  );
}

/* ─── Ray Background ──────────────────────────────────────────────────── */

function RayBackground() {
  return (
    <div className="absolute inset-0 w-full h-full overflow-hidden pointer-events-none select-none">
      <div className="absolute inset-0" style={{ background: "#0a0e16" }} />
      <div
        className="absolute left-1/2 -translate-x-1/2 w-[2400px] h-[1200px] sm:w-[3600px]"
        style={{
          top: "-200px",
          background:
            "radial-gradient(circle at center 600px, rgba(20,136,252,0.55) 0%, rgba(20,136,252,0.25) 14%, rgba(20,136,252,0.12) 22%, rgba(11,14,20,0.0) 36%)",
        }}
      />
      <div
        className="absolute top-[280px] left-1/2 w-[1100px] h-[1100px] sm:top-[330px] sm:w-[1700px] sm:h-[1700px]"
        style={{ transform: "translate(-50%) rotate(180deg)" }}
      >
        <div
          className="absolute w-full h-full rounded-full -mt-[10px]"
          style={{
            background:
              "radial-gradient(43.89% 25.74% at 50.02% 97.24%, #0e1320 0%, #0a0e16 100%)",
            border: "12px solid #ffffff14",
            transform: "rotate(180deg)",
            zIndex: 5,
          }}
        />
        <div
          className="absolute w-full h-full rounded-full -mt-[7px]"
          style={{
            background: "#0a0e16",
            border: "16px solid #b3edff66",
            transform: "rotate(180deg)",
            zIndex: 4,
          }}
        />
        <div
          className="absolute w-full h-full rounded-full -mt-[4px]"
          style={{
            background: "#0a0e16",
            border: "16px solid #67dcff77",
            transform: "rotate(180deg)",
            zIndex: 3,
          }}
        />
        <div
          className="absolute w-full h-full rounded-full -mt-[2px]"
          style={{
            background: "#0a0e16",
            border: "16px solid #38c5ee99",
            transform: "rotate(180deg)",
            zIndex: 2,
          }}
        />
        <div
          className="absolute w-full h-full rounded-full"
          style={{
            background: "#0a0e16",
            border: "14px solid #18a6d6cc",
            boxShadow: "0 -15px 28px rgba(24,166,214,0.55)",
            transform: "rotate(180deg)",
            zIndex: 1,
          }}
        />
      </div>
    </div>
  );
}
