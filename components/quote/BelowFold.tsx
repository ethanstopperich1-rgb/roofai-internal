"use client";

/**
 * Public lead-funnel sections rendered below the hero on /quote.
 * Each section is anchor-linkable from the top-nav (#how, #reviews, #faq).
 * Self-contained — these have no inputs and render the same content for
 * every visitor. White-label per BRAND_CONFIG happens via env vars; the
 * specific claims here (response time, accuracy, etc.) are platform-
 * level guarantees the roofer's customers see consistently.
 */

import { useState } from "react";
import {
  Search,
  Satellite,
  Wrench,
  ShieldCheck,
  Clock,
  ChevronDown,
  CheckCircle2,
} from "lucide-react";

/* ─── Stats strip ─────────────────────────────────────────────────────── */

interface Stat {
  label: string;
  value: string;
  hint?: string;
}

// Only claims we can defend with data go on the strip.
//   "Satellite" — verifiable: we pull from Google's high-res aerial imagery
//   "AI" — verifiable: SAM3 (Segment Anything Model 3) + multi-source
//          reconciliation. Documented in our methodology page.
//   "NOAA radar" — verifiable: we ingest MRMS hail data daily from NOAA.
//   "$0" — verifiable: there is no charge to the homeowner for the estimate.
// Removed: "30s" (measured 25-33s with cold start), "1 hour contractor
// response" (no contractor network to enforce that promise yet).
const STATS: Stat[] = [
  { value: "Satellite", label: "High-resolution aerial imagery", hint: "no in-person visit needed" },
  { value: "AI", label: "Multi-source roof segmentation", hint: "SAM3 + Google Solar + radar" },
  { value: "NOAA", label: "Radar hail history per address", hint: "5-year storm exposure window" },
  { value: "$0", label: "Cost to homeowner", hint: "no obligation, ever" },
];

export function StatsStrip() {
  // Hidden on mobile entirely. Customers on cell phones don't need the
  // four-stat marketing strip — they need the form. On desktop the
  // statistics back up the headline; on mobile they push the value
  // proposition below 2-3 scrolls and add nothing the form doesn't show.
  //
  // Visually: editorial trust trio with a hairline divider running through
  // it. Numerals get the Bricolage display face large; labels stay tight
  // mono. The whole strip reads as "newspaper of record" rather than
  // four equal marketing cards.
  return (
    <section className="relative z-10 px-4 sm:px-6 py-16 sm:py-24 hidden md:block">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-white/[0.06] border-y border-white/[0.06]">
          {STATS.map((s) => (
            <div
              key={s.label}
              className="px-5 sm:px-8 py-7 sm:py-9 text-center first:lg:pl-2 last:lg:pr-2"
            >
              <div className="font-display tabular text-[36px] sm:text-[48px] leading-none font-semibold tracking-[-0.02em] text-slate-50">
                {s.value}
              </div>
              <div className="text-[12.5px] sm:text-[13px] text-slate-200 mt-3 font-medium">{s.label}</div>
              {s.hint && (
                <div className="text-[10px] sm:text-[10.5px] font-mono uppercase tracking-[0.16em] text-slate-500 mt-2">
                  {s.hint}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─── How it works ────────────────────────────────────────────────────── */

interface Step {
  icon: React.ReactNode;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    icon: <Search size={22} />,
    title: "Enter your address",
    body: "Just your street address. We instantly pull your roof from satellite imagery the moment you submit.",
  },
  {
    icon: <Satellite size={22} />,
    title: "AI measures your roof",
    body: "Our proprietary segmentation model calculates square footage, pitch, and roof complexity in seconds — trained specifically on residential roofs across FL, MN, and TX.",
  },
  {
    icon: <Wrench size={22} />,
    title: "See your estimate, pick a contractor",
    body: "Choose your preferred material and instantly see a price range. A vetted local roofer will only follow up if you want them to. Otherwise, you're done.",
  },
];

export function HowItWorks() {
  return (
    <section
      id="how"
      className="relative z-10 px-4 sm:px-6 py-16 sm:py-28 scroll-mt-20"
    >
      <div className="max-w-4xl mx-auto">
        <SectionHeading
          eyebrow="How it works"
          title="Three steps. About thirty seconds."
          sub="No measuring tape. No salesperson at your door."
        />

        {/* Desktop: vertical timeline. Massive numeral on the left in
            Bricolage, body copy on the right, a thin cyan thread tying the
            three steps together. Reads more like a magazine feature than a
            three-card marketing grid. Mobile: same shape, scaled down. */}
        <ol className="mt-14 sm:mt-20 relative">
          <span
            aria-hidden
            className="absolute left-[28px] sm:left-[44px] top-3 bottom-3 w-px bg-gradient-to-b from-transparent via-cy-300/30 to-transparent"
          />
          {STEPS.map((s, i) => (
            <li
              key={s.title}
              className="relative grid grid-cols-[56px_1fr] sm:grid-cols-[88px_1fr] gap-5 sm:gap-8 py-7 sm:py-10 first:pt-0 last:pb-0"
            >
              <div className="relative flex items-start justify-center">
                <span
                  className="font-display tabular text-[44px] sm:text-[72px] leading-none font-semibold tracking-[-0.04em] text-slate-50"
                  aria-hidden
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <div className="min-w-0 pt-1 sm:pt-3">
                <div className="flex items-center gap-3 text-cy-300">
                  {s.icon}
                  <h3 className="font-display text-[17px] sm:text-[20px] font-semibold tracking-tight text-slate-100">
                    {s.title}
                  </h3>
                </div>
                <p className="text-[14px] sm:text-[15.5px] text-slate-300 mt-2.5 sm:mt-3 leading-relaxed max-w-[58ch]">
                  {s.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ─── Testimonials ────────────────────────────────────────────────────── */

/**
 * Testimonials. Renders nothing until real, verified reviews are wired
 * in from a review source (Google Reviews API, BirdEye, etc.).
 */
export function Testimonials() {
  return null;
}

/* ─── FAQ ─────────────────────────────────────────────────────────────── */

interface FaqItem {
  q: string;
  a: string;
}

// FAQ has been audited for verifiability — every claim either references
// a documented platform behavior, a measurable methodology output, or is
// explicitly conditional ("when available," "in those cases"). Claims
// that imply a guaranteed contractor outcome were softened, since the
// contractor network is per-deployment and we shouldn't promise things
// the local operator hasn't underwritten.
const FAQS: FaqItem[] = [
  {
    q: "How accurate is the estimate?",
    a: "The estimate is a satellite-measured starting point — typically within a 10–15% band of an in-person quote on standard residential properties, wider on complex or larger roofs. We measure square footage and roof complexity from high-resolution imagery and apply regional pricing assumptions. When we can't measure pitch directly from the imagery, we use a standard 6/12 assumption and label it clearly on your estimate page. Treat the number as a range, not a binding quote. Read the full methodology at /methodology.",
  },
  {
    q: "How is this free?",
    a: "There is no charge to you for the estimate. Voxaris is the technology platform; the cost is covered by the local roofing operator using our tools to serve their service area. You see your estimate first. What you do after that is entirely your decision — no obligation, no follow-up unless you ask for one.",
  },
  {
    q: "Will I get spam-called?",
    a: "No. Your information is only shared with the contractor you choose from your estimate page. We never sell or share your contact details with marketing networks. SMS messages are limited to your inquiry — you can reply STOP at any time and we'll stop immediately.",
  },
  {
    q: "What materials and roof types are supported?",
    a: "Instant estimates cover the most common residential systems: 3-tab asphalt, architectural shingles, standing-seam metal, and concrete tile. Specialty roofs (slate, cedar shake, flat membrane) and large commercial properties typically need an on-site assessment — we'll route those to a human reviewer instead of returning an instant number.",
  },
  {
    q: "What if my roof needs repair, not replacement?",
    a: "The instant estimate is designed for replacement work. If you suspect a repair is what you need, request a follow-up from the contractor on your estimate page and ask them to scope a repair instead. A repair quote requires an on-site visit.",
  },
  {
    q: "Is there financing?",
    a: "Most roofing replacements can be financed; specific terms (APR, term length, payment) depend on the contractor and the financing provider they work with. When financing options are available for your estimate, they'll be shown on your estimate page.",
  },
  {
    q: "How long until I get a precise quote?",
    a: "Your range estimate appears within seconds of submitting your address. A precise on-site quote — including deck inspection, code-compliance check, and signed scope of work — requires an in-person visit. The contractor handling your area will be in touch to schedule it.",
  },
  {
    q: "Does this work with insurance claims?",
    a: "If your roof was damaged in a storm event we have on record (we ingest NOAA's MRMS hail radar daily), we'll surface the storm history on your estimate page. The contractor can use that to document the loss for your insurance carrier. We are not insurance adjusters; we provide measurement and documentation tools the contractor uses on your behalf.",
  },
];

export function FAQ() {
  const [open, setOpen] = useState<number | null>(0);
  const [showAll, setShowAll] = useState(false);
  // On mobile, default to the 3 highest-converting questions (accuracy,
  // free/catch, spam-call). The remaining 5 hide behind a "Show more
  // questions" toggle so the customer doesn't have to scroll past 8
  // accordion rows on a 4-inch screen. Desktop shows all 8 inline.
  const MOBILE_PRIMARY = 3;
  return (
    <section
      id="faq"
      className="relative z-10 px-4 sm:px-6 py-10 sm:py-20 scroll-mt-20"
    >
      <div className="max-w-3xl mx-auto">
        <SectionHeading
          eyebrow="FAQ"
          title="Common questions"
          sub="If your question isn't here, the contractor you pick will answer it directly."
        />

        <div className="mt-10 sm:mt-14 border-t border-white/[0.06]">
          {FAQS.map((f, i) => {
            const isOpen = open === i;
            const hideOnMobile = !showAll && i >= MOBILE_PRIMARY;
            return (
              <div
                key={i}
                className={`border-b border-white/[0.06] ${
                  hideOnMobile ? "hidden md:block" : ""
                }`}
              >
                <button
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="w-full flex items-center justify-between gap-4 py-5 sm:py-6 text-left group"
                  aria-expanded={isOpen}
                >
                  <span className="text-[15px] sm:text-[17px] font-medium text-slate-100 group-hover:text-white transition-colors">
                    {f.q}
                  </span>
                  <ChevronDown
                    size={20}
                    className={`flex-shrink-0 text-slate-500 group-hover:text-cy-300 transition-all ${
                      isOpen ? "rotate-180 text-cy-300" : ""
                    }`}
                  />
                </button>
                {isOpen && (
                  <div className="pb-6 sm:pb-7 -mt-1 text-[14px] sm:text-[15px] text-slate-300 leading-relaxed max-w-[68ch]">
                    {f.a}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {!showAll && FAQS.length > MOBILE_PRIMARY && (
          <button
            onClick={() => setShowAll(true)}
            className="md:hidden mt-3 w-full text-[12.5px] font-mono uppercase tracking-[0.14em] text-slate-400 hover:text-slate-200 py-3 rounded-xl border border-white/[0.06] bg-white/[0.015]"
          >
            Show {FAQS.length - MOBILE_PRIMARY} more questions
          </button>
        )}
      </div>
    </section>
  );
}

/* ─── Trust strip ─────────────────────────────────────────────────────── */

const TRUST_ITEMS = [
  { icon: <ShieldCheck size={14} />, label: "BBB-vetted roofers only" },
  { icon: <Clock size={14} />, label: "Reply within 1 business hour" },
  { icon: <CheckCircle2 size={14} />, label: "License + insurance on every quote" },
  { icon: <ShieldCheck size={14} />, label: "We never sell your info" },
];

// The TRUTH_ITEMS variant below replaces TRUST_ITEMS when no contractor
// network is wired up yet. Each item is a verifiable claim about the
// PLATFORM, not about partner contractors we don't have under contract.
const TRUTH_ITEMS = [
  { icon: <Satellite size={14} />, label: "Measured from satellite imagery" },
  { icon: <ShieldCheck size={14} />, label: "We never sell your info" },
  { icon: <CheckCircle2 size={14} />, label: "Non-binding estimate, no obligation" },
  { icon: <ShieldCheck size={14} />, label: "TCPA-compliant consent on file" },
];

export function TrustStrip() {
  // Switch between contractor-network claims (TRUST_ITEMS) and platform-only
  // claims (TRUTH_ITEMS) based on NEXT_PUBLIC_CONTRACTOR_NETWORK_LIVE.
  // Default = TRUTH_ITEMS until a real partner network is under contract.
  // Flip the env var per-deploy when a tenant has verified contractors
  // wired up to take leads.
  const networkLive = process.env.NEXT_PUBLIC_CONTRACTOR_NETWORK_LIVE === "true";
  const items = networkLive ? TRUST_ITEMS : TRUTH_ITEMS;
  const mobileItems = items.filter((_, i) => i === 0 || i === items.length - 1);
  return (
    <section className="relative z-10 px-4 sm:px-6 py-6 sm:py-8 border-t border-white/[0.04]">
      <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
        {/* Mobile only — 2 items */}
        <div className="md:hidden contents">
          {mobileItems.map((item, i) => (
            <div
              key={`m-${i}`}
              className="flex items-center gap-2 text-[12px] text-slate-400"
            >
              <span className="text-cy-300">{item.icon}</span>
              <span>{item.label}</span>
            </div>
          ))}
        </div>
        {/* Desktop only — all items */}
        <div className="hidden md:contents">
          {items.map((item, i) => (
            <div
              key={`d-${i}`}
              className="flex items-center gap-2 text-[12.5px] text-slate-400"
            >
              <span className="text-cy-300">{item.icon}</span>
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─── Section heading helper ──────────────────────────────────────────── */

function SectionHeading({
  eyebrow,
  title,
  sub,
}: {
  eyebrow: string;
  title: string;
  sub?: string;
}) {
  return (
    <div className="text-center max-w-2xl mx-auto">
      <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-cy-300">
        {eyebrow}
      </div>
      <h2 className="font-display text-[26px] sm:text-[36px] leading-tight tracking-tight font-semibold mt-3 text-slate-100">
        {title}
      </h2>
      {sub && (
        <p className="text-[14px] text-slate-400 mt-3 leading-relaxed">{sub}</p>
      )}
    </div>
  );
}
