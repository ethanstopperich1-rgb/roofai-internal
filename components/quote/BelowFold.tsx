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
  Star,
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
  { value: "±10%", label: "Accuracy vs final quote", hint: "vs in-person inspection" },
  { value: "<1hr", label: "Contractor response", hint: "during business hours" },
  { value: "$0", label: "Cost to homeowner", hint: "no obligation, ever" },
];

export function StatsStrip() {
  return (
    <section className="relative z-10 px-4 sm:px-6 py-14 sm:py-20">
      <div className="max-w-5xl mx-auto">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {STATS.map((s) => (
            <div
              key={s.label}
              className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5 text-center"
            >
              <div className="font-display tabular text-[28px] sm:text-[36px] leading-none font-semibold tracking-tight text-cy-300">
                {s.value}
              </div>
              <div className="text-[12px] sm:text-[13px] text-slate-200 mt-2">{s.label}</div>
              {s.hint && (
                <div className="text-[10.5px] sm:text-[11px] font-mono uppercase tracking-[0.12em] text-slate-500 mt-1.5">
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
      className="relative z-10 px-4 sm:px-6 py-14 sm:py-20 scroll-mt-20"
    >
      <div className="max-w-5xl mx-auto">
        <SectionHeading
          eyebrow="How it works"
          title="Three steps. About thirty seconds."
          sub="No measuring tape. No salesperson at the door. The roof you see in your driveway is the same roof we measure from above."
        />

        <div className="grid md:grid-cols-3 gap-4 sm:gap-6 mt-10">
          {STEPS.map((s, i) => (
            <div
              key={s.title}
              className="relative rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6"
            >
              <div className="absolute -top-3 left-6 px-2.5 py-1 rounded-full bg-cy-300 text-[#051019] text-[11px] font-mono font-semibold tracking-wider">
                {String(i + 1).padStart(2, "0")}
              </div>
              <div className="flex items-center gap-3 text-cy-300 mt-1.5">
                {s.icon}
                <h3 className="font-display text-[16px] sm:text-[17px] font-semibold tracking-tight text-slate-100">
                  {s.title}
                </h3>
              </div>
              <p className="text-[13.5px] text-slate-300 mt-3 leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─── Testimonials ────────────────────────────────────────────────────── */

interface Testimonial {
  quote: string;
  author: string;
  role: string;
  rating: 5;
}

// Sample placeholder testimonials. NOT real customer quotes — kept here
// as visual scaffolding until verified reviews land. The Testimonials
// component below renders nothing unless `NEXT_PUBLIC_REVIEWS_VERIFIED=true`
// is set on the deploy. Asserting "Recent quotes through the platform"
// next to fabricated names + cities + initials is FTC deceptive-
// testimonial territory; gate kept off by default so any /quote
// deployment that hasn't curated real reviews simply omits the section.
const TESTIMONIALS: Testimonial[] = [
  {
    quote:
      "Got my range in 30 seconds and a contractor at my door the next day. Saved me four 'let me come out and measure' appointments.",
    author: "M. Reyes",
    role: "Winter Park, FL",
    rating: 5,
  },
  {
    quote:
      "I was getting bombarded by storm chasers after Hurricane Idalia. This was the only one that gave me a price before I gave them my phone.",
    author: "D. Chen",
    role: "Tampa, FL",
    rating: 5,
  },
  {
    quote:
      "Estimate came in $400 under what the in-person guy quoted. We went with the in-person roofer but used the number to negotiate. Worth it.",
    author: "K. Patel",
    role: "Orlando, FL",
    rating: 5,
  },
];

export function Testimonials() {
  // Render nothing until real, verified reviews are wired in. The
  // placeholder copy above is for design preview only.
  if (process.env.NEXT_PUBLIC_REVIEWS_VERIFIED !== "true") return null;

  return (
    <section
      id="reviews"
      className="relative z-10 px-4 sm:px-6 py-14 sm:py-20 scroll-mt-20"
    >
      <div className="max-w-5xl mx-auto">
        <SectionHeading
          eyebrow="Reviews"
          title="What homeowners say"
          sub="Verified homeowners who used the platform to compare quotes."
        />

        <div className="grid md:grid-cols-3 gap-4 sm:gap-6 mt-10">
          {TESTIMONIALS.map((t, i) => (
            <figure
              key={i}
              className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6 flex flex-col"
            >
              <div className="flex gap-0.5 text-cy-300">
                {Array.from({ length: t.rating }).map((_, idx) => (
                  <Star key={idx} size={14} fill="currentColor" strokeWidth={0} />
                ))}
              </div>
              <blockquote className="text-[14px] text-slate-200 leading-relaxed mt-3 flex-1">
                &ldquo;{t.quote}&rdquo;
              </blockquote>
              <figcaption className="mt-5 pt-4 border-t border-white/[0.05]">
                <div className="text-[13px] font-medium text-slate-100">{t.author}</div>
                <div className="text-[11.5px] text-slate-500 font-mono uppercase tracking-[0.1em] mt-0.5">
                  {t.role}
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
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
  return (
    <section
      id="faq"
      className="relative z-10 px-4 sm:px-6 py-14 sm:py-20 scroll-mt-20"
    >
      <div className="max-w-3xl mx-auto">
        <SectionHeading
          eyebrow="FAQ"
          title="Common questions"
          sub="If your question isn't here, the contractor you pick will answer it directly."
        />

        <div className="mt-10 space-y-2">
          {FAQS.map((f, i) => {
            const isOpen = open === i;
            return (
              <div
                key={i}
                className="rounded-2xl border border-white/[0.06] bg-white/[0.015] overflow-hidden"
              >
                <button
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-white/[0.02] transition-colors"
                  aria-expanded={isOpen}
                >
                  <span className="text-[14px] sm:text-[15px] font-medium text-slate-100">
                    {f.q}
                  </span>
                  <ChevronDown
                    size={18}
                    className={`flex-shrink-0 text-slate-500 transition-transform ${
                      isOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>
                {isOpen && (
                  <div className="px-5 pb-5 text-[13.5px] text-slate-300 leading-relaxed border-t border-white/[0.04]">
                    <div className="pt-4">{f.a}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ─── Trust strip ─────────────────────────────────────────────────────── */

const TRUST_ITEMS = [
  { icon: <ShieldCheck size={14} />, label: "BBB-vetted roofers only" },
  { icon: <Clock size={14} />, label: "Average 47 min reply" },
  { icon: <CheckCircle2 size={14} />, label: "License + insurance on every quote" },
  { icon: <ShieldCheck size={14} />, label: "We never sell your info" },
];

export function TrustStrip() {
  return (
    <section className="relative z-10 px-4 sm:px-6 py-8 border-t border-white/[0.04]">
      <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
        {TRUST_ITEMS.map((item, i) => (
          <div
            key={i}
            className="flex items-center gap-2 text-[12px] sm:text-[12.5px] text-slate-400"
          >
            <span className="text-cy-300">{item.icon}</span>
            <span>{item.label}</span>
          </div>
        ))}
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
