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

const STATS: Stat[] = [
  { value: "30s", label: "Average estimate time", hint: "from address to price" },
  { value: "Satellite", label: "Same imagery Google uses", hint: "for solar-panel sizing" },
  { value: "1 hour", label: "Contractor response", hint: "during business hours" },
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
    body: "Just your street address — no measurements, no calls, no in-home visit. We pull your roof from satellite the moment you submit.",
  },
  {
    icon: <Satellite size={22} />,
    title: "AI measures your roof",
    body: "Photogrammetric segmentation determines square footage, pitch, and complexity in seconds. Same data Google uses for solar panel sizing.",
  },
  {
    icon: <Wrench size={22} />,
    title: "See your estimate, pick a contractor",
    body: "Pick your preferred material; see the price range. A vetted local roofer follows up only if you ask. Zero obligation otherwise.",
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
          sub="No measuring tape. No salesperson at the door."
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

const FAQS: FaqItem[] = [
  {
    q: "How accurate is the satellite estimate?",
    a: "Within ~10% of an in-person quote on most residential properties. We measure from Google's photogrammetric satellite imagery — the same source Google uses for solar-panel sizing — and apply standard pitch and waste factors. Older imagery (>5 years) carries a wider band; we flag that explicitly when relevant.",
  },
  {
    q: "How is this free? What's the catch?",
    a: "Partner roofing contractors pay us a small fee when a homeowner becomes their customer — never the homeowner. You see the estimate, pick a contractor (or don't), and only the chosen contractor pays. There are no hidden fees, no \"premium\" upsells, and no charge for the estimate itself.",
  },
  {
    q: "Will I get spam-called by a bunch of contractors?",
    a: "No. Your information goes to one contractor — the one you pick from your estimate page — not a network. We never sell your address, email, or phone to third parties or marketing lists. The only follow-up is from the roofer you chose.",
  },
  {
    q: "What materials and roof types do you cover?",
    a: "Standard residential: 3-tab asphalt, architectural asphalt, metal standing-seam, and concrete tile. Specialty roofs (slate, cedar shake, flat membrane) require an in-person quote and may not return an instant estimate.",
  },
  {
    q: "What if my roof needs repair, not replacement?",
    a: "Partner contractors quote both repairs and replacements. The instant estimate covers full replacement; for a repair, request the contractor's follow-up — they'll provide a separate repair scope on-site at no charge.",
  },
  {
    q: "Is there financing available?",
    a: "Most partner contractors offer 0% APR financing for 12-18 months on roof replacements, plus 5-10 year traditional financing options. The contractor handles financing directly; the estimate page shows estimated monthly payments where available.",
  },
  {
    q: "How long until I get a precise quote?",
    a: "Within 1 business hour for an emailed quote, typically 1-3 business days for an in-person inspection if you request one. Storm-damage claims often qualify for same-day inspection.",
  },
  {
    q: "Does this work with insurance claims?",
    a: "Yes. If your roof has storm damage, partner contractors document the loss with photos, drone or ladder inspection, and provide an Xactimate-compatible estimate package directly to your carrier. Most homeowners pay only their deductible.",
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

export function TrustStrip() {
  // Mobile: only the two highest-trust items ("BBB-vetted" + "never sell
  // your info"). The other two (47-min reply, license + insurance on
  // every quote) live in the FAQ already, so we don't need to repeat them
  // in a footer on a 4-inch screen. Desktop shows all four.
  const MOBILE_TRUST = TRUST_ITEMS.filter((_, i) => i === 0 || i === 3);
  return (
    <section className="relative z-10 px-4 sm:px-6 py-6 sm:py-8 border-t border-white/[0.04]">
      <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
        {/* Mobile only — 2 items */}
        <div className="md:hidden contents">
          {MOBILE_TRUST.map((item, i) => (
            <div
              key={`m-${i}`}
              className="flex items-center gap-2 text-[12px] text-slate-400"
            >
              <span className="text-cy-300">{item.icon}</span>
              <span>{item.label}</span>
            </div>
          ))}
        </div>
        {/* Desktop only — all 4 items */}
        <div className="hidden md:contents">
          {TRUST_ITEMS.map((item, i) => (
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
