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
  /** TCPA consent — server-validated in /api/leads. Always true when the
   *  hero form ships values up (the submit button is disabled until the
   *  customer checks the box), but typed optional for forward-compat
   *  with non-form callers. */
  tcpaConsent?: boolean;
  /** ISO timestamp the customer checked the consent box on the client.
   *  Server overrides this with its own `submittedAt` for the audit log,
   *  but we still pass it through so CRM downstreams can sanity-check. */
  tcpaConsentAt?: string;
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
  /** TCPA consent for automated marketing communications. Required to
   *  submit. Even though "consent is not required to make a purchase"
   *  per the disclosure language, FTC + TCPA case law makes affirmative
   *  written consent the safest legal posture before any auto-call /
   *  auto-text follow-up. Default false → user must affirmatively check. */
  const [tcpaConsent, setTcpaConsent] = useState(false);
  // Tracks whether the user attempted submit while form was invalid.
  // Used to flip on accessible error microcopy only after a first try —
  // showing it before any interaction would visually nag every visitor.
  const [showValidationHint, setShowValidationHint] = useState(false);

  const fieldsValid =
    name.trim().length > 1 &&
    /\S+@\S+\.\S+/.test(email) &&
    phone.replace(/\D/g, "").length >= 7 &&
    address.trim().length > 4;
  const valid = fieldsValid && tcpaConsent;

  // What's blocking submit? Used for the accessible aria-live message.
  // Order matters — surface the most-likely-resolvable issue first
  // (consent checkbox), not the most-recently-failed field.
  const validationHint = !tcpaConsent && fieldsValid
    ? "Check the consent box above to continue."
    : !fieldsValid
      ? "Please complete every field above to continue."
      : null;

  const submit = () => {
    if (!valid) {
      setShowValidationHint(true);
      return;
    }
    if (submitting) return;
    onSubmit({
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      address: address.trim(),
      ...(picked ?? {}),
      tcpaConsent: true,
      tcpaConsentAt: new Date().toISOString(),
    });
  };

  return (
    <div
      className={`relative flex flex-col items-center w-full overflow-hidden ${
        embedMode ? "py-10 sm:py-14" : "min-h-screen"
      }`}
    >
      <RayBackground />
      {/* Decorative rooftop horizon — sits at the bottom of the hero,
          fades into bg. Reads subliminally as "rooftops on a skyline"
          without competing with the central radial ray treatment.
          Hidden in embed mode (the widget lives inside a host site that
          already has its own visual frame). */}
      {!embedMode && (
        <svg
          aria-hidden
          className="absolute left-0 right-0 bottom-0 w-full h-[120px] sm:h-[180px] pointer-events-none z-[1]"
          viewBox="0 0 1600 180"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="rooftop-fade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#67dcff" stopOpacity="0" />
              <stop offset="65%" stopColor="#67dcff" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#67dcff" stopOpacity="0.18" />
            </linearGradient>
          </defs>
          <path
            d="M0 180 L0 130 L80 80 L160 130 L240 95 L320 130 L400 70 L480 130 L560 110 L640 130 L720 60 L800 130 L880 90 L960 130 L1040 50 L1120 130 L1200 100 L1280 130 L1360 75 L1440 130 L1520 95 L1600 130 L1600 180 Z"
            fill="url(#rooftop-fade)"
            stroke="rgba(103,220,255,0.18)"
            strokeWidth="1"
          />
        </svg>
      )}

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
        {/* Announcement chip removed per design — the page identity is
            carried by the top-of-page logo + nav, and the chip was
            redundant noise above the headline in the visionOS treatment. */}

        <div className="relative z-10 w-full max-w-3xl px-4 mx-auto">
        {/* Headline */}
        <div className={`text-center ${embedMode ? "mb-6" : "mb-10"}`}>
          <h1
            className="font-display leading-[0.95] tracking-[-0.035em] font-semibold text-white"
            style={
              embedMode
                ? { fontSize: "clamp(28px, 5.5vw, 44px)" }
                : { fontSize: "clamp(38px, 8.2vw, 84px)" }
            }
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
          <p
            className={`font-medium text-slate-300 leading-relaxed mx-auto ${
              embedMode
                ? "mt-3 text-[14px] sm:text-[16px]"
                : "mt-5 sm:mt-6 text-[16px] sm:text-[19px] max-w-[42ch]"
            }`}
          >
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
                onChange={(v) => setPhone(formatPhoneUS(v))}
                autoComplete="tel"
                inputMode="tel"
                maxLength={14}
              />
            </div>

            {/* TCPA consent — explicit affirmative checkbox required
                before submit. Disclosure language is the standard
                "consent is not required to make a purchase" form that
                FTC/FCC accept as compliant under the 2024 TCPA rules
                (one-to-one consent + clear-and-conspicuous disclosure). */}
            <div className="px-4 py-3 border-t border-white/[0.06]">
              <label className="flex items-start gap-2.5 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={tcpaConsent}
                  onChange={(e) => setTcpaConsent(e.target.checked)}
                  className="mt-0.5 h-4 w-4 flex-shrink-0 cursor-pointer rounded border border-white/20 bg-white/5 accent-cy-300"
                  aria-label="Consent to receive marketing communications"
                />
                <span className="text-[11px] leading-[1.55] text-slate-400 group-hover:text-slate-300 transition-colors">
                  By submitting this form, you consent to receive automated
                  marketing calls, texts, and emails from Voxaris and its
                  partner contractors at the phone number and email provided.
                  Consent is not required to make a purchase. Message
                  frequency varies; message and data rates may apply. Reply
                  STOP to opt out, HELP for help. See our{" "}
                  <a
                    href="/privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-cy-300 hover:underline"
                  >
                    Privacy Policy
                  </a>{" "}
                  and{" "}
                  <a
                    href="/terms"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-cy-300 hover:underline"
                  >
                    Terms of Service
                  </a>
                  .
                </span>
              </label>
            </div>

            {/* Footer — submit button.
                Removed the "~5 seconds" claim — measured submit-to-estimate
                time is 25-35s with cold start. Replaced with what's actually
                true: estimates are non-binding and we don't sell data. */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-white/[0.06]">
              <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-slate-300 hidden sm:flex items-center gap-2">
                <Zap size={11} className="text-cy-300" />
                <span>Non-binding estimate · we never sell your info</span>
              </div>
              {/* Tri-state submit button:
                  - active: form valid + consent checked → solid cyan, fires submit
                  - ghost:  form filled but consent missing → cyan border, no fill,
                    still clickable (click triggers the validation hint). Signals
                    "you're one tick away" instead of looking dead.
                  - disabled: form incomplete → bg-white/10, cursor-not-allowed
                  Per the bolt-style review (#9): users with a filled-out form
                  and an unchecked consent box previously saw the same dead
                  button as a user with empty fields, with no visual link to
                  the checkbox they needed to tick. */}
              <button
                onClick={submit}
                disabled={submitting}
                aria-disabled={!valid || submitting}
                className={`ml-auto flex items-center gap-2 px-5 py-2.5 rounded-xl text-[14px] font-medium transition-all ${
                  valid && !submitting
                    ? accentHex
                      ? "active:scale-[0.98] hover:opacity-90"
                      : "bg-cy-400 hover:bg-cy-300 text-[#051019] shadow-[0_0_24px_rgba(20,136,252,0.45)] active:scale-[0.98]"
                    : fieldsValid && !tcpaConsent && !submitting
                      ? "bg-transparent text-cy-300 border border-cy-300/55 hover:bg-cy-300/[0.08] cursor-pointer"
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
            {/* Accessible validation hint. Shows automatically once the
                fields are filled but consent isn't yet checked (so the
                user doesn't have to click a dead-looking button to learn
                what's missing). Also shows after a failed submit attempt
                for the "fields incomplete" case. aria-live="polite" so
                screen readers announce it without interrupting flow. */}
            {((fieldsValid && !tcpaConsent) || showValidationHint) && validationHint && (
              <div
                role="status"
                aria-live="polite"
                className="px-4 py-2.5 border-t border-amber/30 bg-amber/[0.06] text-[12px] text-amber font-medium"
              >
                {validationHint}
              </div>
            )}
          </div>
        </div>

          {/* Trust pill — embed mode only. On /quote, the bottom
              TrustStrip already carries the reassurance text + the hero
              form footer says "Non-binding estimate · we never sell
              your info" two lines above. Three places saying the same
              thing read as anxious. The trust trio that used to sit
              here was deleted per the style review (#2): pick one
              trust surface, not three. /embed is a different surface
              (no TrustStrip below it, iframed onto a host site) so the
              one-line pill stays for that mode. */}
          {embedMode && (
            <div className="mt-5 flex items-center justify-center gap-2 text-[10.5px] font-mono uppercase tracking-[0.16em] text-slate-400">
              <Sparkles size={11} className="text-cy-300" />
              <span>Voxaris in-house AI · Private · Powered by Voxaris Pitch</span>
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
  inputMode,
  maxLength,
}: {
  type?: string;
  placeholder: string;
  value: string;
  onChange: (s: string) => void;
  autoComplete?: string;
  className?: string;
  inputMode?: "text" | "tel" | "email" | "url" | "numeric" | "decimal" | "search";
  maxLength?: number;
}) {
  return (
    <input
      type={type}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete={autoComplete}
      inputMode={inputMode}
      maxLength={maxLength}
      className={`w-full bg-transparent border-0 outline-none text-[14px] text-white placeholder:text-slate-500 px-4 py-3.5 ${className}`}
    />
  );
}

/**
 * Pretty-print a US phone number as the user types.
 *   "" → ""
 *   "4" → "(4"
 *   "407" → "(407"
 *   "4078" → "(407) 8"
 *   "407819" → "(407) 819"
 *   "4078195" → "(407) 819-5"
 *   "4078195809" → "(407) 819-5809"
 *
 * Strips all non-digits first, drops a leading "1" (country code), caps at
 * 10 digits. Submit path runs the value through lib/twilio toE164() which
 * also strips non-digits, so the visual format is purely cosmetic — no
 * round-trip risk.
 */
function formatPhoneUS(raw: string): string {
  let d = (raw || "").replace(/\D+/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  d = d.slice(0, 10);
  if (d.length === 0) return "";
  if (d.length < 4) return `(${d}`;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
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
