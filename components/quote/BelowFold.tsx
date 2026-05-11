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
  { value: "AI", label: "Voxaris in-house roof model", hint: "trained on FL/MN/TX imagery" },
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
    body: "Just your street address. We instantly pull your roof from satellite imagery the moment you submit.",
  },
  {
    icon: <Satellite size={22} />,
    title: "AI measures your roof",
    body: "Voxaris's proprietary segmentation model calculates square footage, pitch, and roof complexity in seconds — trained specifically on residential roofs across FL, MN, and TX.",
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

const FAQS: FaqItem[] = [
  {
    q: "How accurate is the satellite estimate?",
    a: "On most residential properties, Voxaris estimates come within ~10% of an in-person quote. Our in-house model analyzes high-resolution aerial imagery to measure square footage, pitch, and complexity, then applies regional waste factors. On properties with imagery older than 5 years, we show a wider accuracy band and flag it clearly. In those cases, we recommend getting on-site confirmation before moving forward.",
  },
  {
    q: "How is this free? What's the catch?",
    a: "Voxaris is paid by the roofing contractor you choose — not by you. We only get paid if you decide to move forward with one of our vetted partners. There are no hidden fees, no markups on materials, and no obligation to hire anyone. You see your estimate first. What you do after that is entirely up to you.",
  },
  {
    q: "Will I get spam-called by a bunch of contractors?",
    a: "No. Your information is only shared with one contractor — the one you select from your estimate. We never sell or share your contact information with networks or marketing lists. The only person who will follow up is the roofer you chose (if you want them to).",
  },
  {
    q: "What materials and roof types do you cover?",
    a: "We provide instant estimates for the most common residential systems: 3-tab asphalt, architectural shingles, standing-seam metal, and concrete tile. Specialty roofs such as slate, cedar shake, and flat membrane systems typically require an on-site assessment and may not return an instant estimate.",
  },
  {
    q: "What if my roof needs repair, not replacement?",
    a: "Partner contractors can handle both repairs and full replacements. The instant estimate is designed for replacement scenarios. If you're looking for a repair, simply request a follow-up from the contractor — they'll provide a separate repair scope at no charge.",
  },
  {
    q: "Is there financing available?",
    a: "Yes. Most of our partner contractors offer 0% APR financing for 12–18 months on full roof replacements, along with longer-term traditional financing options. Financing is handled directly by the contractor. You'll see estimated monthly payment options on your estimate page when available.",
  },
  {
    q: "How long until I get a precise quote?",
    a: "You'll see an instant estimate range within seconds of submitting your address. If you'd like a more precise, on-site quote, a local contractor will typically respond within 1 business hour during normal business hours. Storm damage claims often qualify for same-day inspections.",
  },
  {
    q: "Does this work with insurance claims?",
    a: "Yes. If your roof was damaged in a storm, our partner contractors can document the loss with photos, drone imagery, or a ladder inspection. They'll prepare an Xactimate-compatible estimate package that you can submit directly to your insurance carrier. Most homeowners only pay their deductible.",
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
