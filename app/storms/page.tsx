import type { Metadata } from "next";
import Link from "next/link";
import { Eye, ListChecks, Send, ArrowRight, CloudHail } from "lucide-react";
import LiveStormCard from "@/components/storms/LiveStormCard";
import CountyDataSourcesCard from "@/components/storms/CountyDataSourcesCard";
import PublicHeader from "@/components/ui/public-header";
import PublicFooter from "@/components/ui/public-footer";

export const metadata: Metadata = {
  title: "Storm Intelligence · Voxaris",
  description:
    "Voxaris turns every hail event in your service area into a ranked canvass list of inspection-eligible addresses — before your competitors arrive.",
  robots: { index: true, follow: true },
};

const GOOGLE_MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";

export default function StormsPage() {
  return (
    <div className="min-h-[100dvh] relative" style={{ background: "#07090d" }}>
      {/* Shared PublicHeader. Previously /storms rolled its own header
          with a TEXT wordmark (just the word "Voxaris" in a span) —
          inconsistent with every other public page which uses the
          logo image. PublicHeader uses the canonical wordmark image
          everywhere. The chip stays storm-themed (cyan, matches the
          page accent), and we keep the page-specific CTA ("Talk to us"
          → mailto) in the rightSlot. */}
      <PublicHeader
        chip="Storm Intelligence"
        chipClassName="hidden md:inline-flex items-center text-[10px] font-mono uppercase tracking-[0.14em] px-2 py-0.5 rounded-full"
        nav={[
          { label: "Homeowner quote", href: "/quote" },
          { label: "How it works", href: "#example" },
          { label: "Data sources", href: "#sources" },
        ]}
        rightSlot={
          <a
            href="mailto:hello@voxaris.io?subject=Storm%20Intelligence%20—%20activate%20my%20territory"
            className="hidden sm:inline-flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-medium transition justify-self-end"
            style={{
              background: "linear-gradient(180deg, #67dcff, #18a6d6)",
              color: "#051019",
            }}
          >
            Talk to us <ArrowRight size={14} />
          </a>
        }
      />

      <main id="main-content" className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 py-12 sm:py-20 space-y-20 sm:space-y-28">
        {/* HERO — outcome first, no glow */}
        <section>
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-mono uppercase tracking-[0.14em] mb-6"
            style={{
              background: "rgba(243,177,75,0.08)",
              border: "1px solid rgba(243,177,75,0.30)",
              color: "#f3b14b",
            }}
          >
            <CloudHail size={12} />
            Storm-triggered lead generation
          </div>
          {/* Wrapping each phrase in a span with `display:block` lets
              the break happen via layout (and inherits responsive
              behavior) instead of a hard <br /> that forces the
              two-line treatment even on huge screens where it'd fit
              on one. On a phone the spans wrap naturally; on a wide
              monitor the punch is preserved by the block display. */}
          <h1
            className="font-display font-semibold tracking-[-0.035em] text-slate-50 leading-[0.95]"
            style={{ fontSize: "clamp(40px, 7.5vw, 76px)" }}
          >
            <span className="block">Hail hits.</span>
            <span className="block">Your phones ring.</span>
          </h1>
          <p className="text-[16px] sm:text-[19px] text-slate-300 leading-relaxed mt-6 sm:mt-8 max-w-[58ch]">
            Voxaris detects every significant hail event in your
            service area, scores the homes inside the impact zone, and
            hands your sales team a ranked canvass list — postcards,
            addresses, and per-event landing pages, all ready to go,
            before the out-of-state storm chasers book their flights.
          </p>
          <div className="flex flex-wrap gap-3 mt-8">
            <a
              href="#example"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[14px] font-medium transition"
              style={{
                background: "linear-gradient(180deg, #67dcff, #18a6d6)",
                color: "#051019",
                boxShadow: "0 6px 16px -6px rgba(24,166,214,0.4)",
              }}
            >
              See a real Orlando example <ArrowRight size={14} />
            </a>
            <a
              href="mailto:hello@voxaris.io?subject=Storm%20Intelligence%20—%20activate%20my%20territory"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[14px] font-medium text-slate-200 transition hover:text-white"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.10)",
              }}
            >
              Talk to us
            </a>
          </div>
        </section>

        {/* HOW IT HELPS — outcome cards, not pipeline */}
        <section>
          <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-cy-300 mb-3">
            How it works for your team
          </div>
          <h2 className="font-display text-[28px] sm:text-[40px] font-semibold tracking-[-0.025em] text-slate-50 leading-tight mb-3">
            We do the detection. You do the closing.
          </h2>
          <p className="text-[14.5px] text-slate-400 max-w-prose leading-relaxed">
            Three things show up in your team&apos;s inbox the morning
            after a qualifying hail event — no work on your end.
          </p>

          <div className="mt-10 grid md:grid-cols-3 gap-4 sm:gap-5">
            <Outcome
              icon={<Eye size={20} />}
              title="We spot the storm"
              body="Continuous coverage across your watched zips. The moment significant hail crosses your territory, we flag the impact zone and lock in the data."
            />
            <Outcome
              icon={<ListChecks size={20} />}
              title="We rank the homes"
              body="Every property inside the impact zone gets scored on hail size, proximity to the center, and replacement likelihood. Your reps work the top of the list, not a random ZIP."
            />
            <Outcome
              icon={<Send size={20} />}
              title="We hand you ready-to-go canvass material"
              body="Address list, pre-built postcard copy, and a per-event landing page — branded as your operation, ready for your direct mail / SMS / door-knock workflow."
            />
          </div>
        </section>

        {/* LIVE EXAMPLE + OUTPUT */}
        <section id="example" className="scroll-mt-24">
          <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-cy-300 mb-3">
            Real example · Orange County, FL
          </div>
          <h2 className="font-display text-[28px] sm:text-[40px] font-semibold tracking-[-0.025em] text-slate-50 leading-tight mb-3">
            The most recent qualifying hail event near Orlando.
          </h2>
          <p className="text-[14.5px] text-slate-400 max-w-prose leading-relaxed mb-10">
            Pulled live. Below it, the exact output your sales team
            would&apos;ve received from this event — addresses, postcard
            design, landing page URL.
          </p>

          <LiveStormCard googleMapsKey={GOOGLE_MAPS_KEY} />
        </section>

        {/* Data spine — county parcel + property-appraiser feeds. Shows the
            prospect that the canvass lists are anchored to real, named
            government data sources, not vibes. Self-documenting from
            lib/county-data-sources.ts so adding a county to the data
            pipeline updates the marketing page automatically. */}
        <section id="sources" className="scroll-mt-24">
          <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-cy-300 mb-3">
            What we cross-reference
          </div>
          <h2 className="font-display text-[28px] sm:text-[40px] font-semibold tracking-[-0.025em] text-slate-50 leading-tight mb-3">
            Five Central Florida counties, wired.
          </h2>
          <p className="text-[14.5px] text-slate-400 max-w-prose leading-relaxed mb-10">
            Every storm hit gets cross-referenced against the county tax
            roll and parcel polygons — owner name, situs address,
            assessed value, year built. Direct from each county's
            official open-data portal.
          </p>

          <CountyDataSourcesCard />
        </section>

        {/* CTA */}
        <section className="text-center">
          <h2 className="font-display text-[26px] sm:text-[36px] font-semibold tracking-[-0.025em] text-slate-50 leading-tight mb-4">
            Want this running for your territory?
          </h2>
          <p className="text-[14.5px] text-slate-400 max-w-prose mx-auto mb-8 leading-relaxed">
            Activation is a 30-minute call. We set up your watched
            zips, wire into your CRM, and you start getting morning
            canvass briefs the next time hail hits.
          </p>
          <a
            href="mailto:hello@voxaris.io?subject=Storm%20Intelligence%20—%20activate%20my%20territory"
            className="inline-flex items-center gap-2 px-6 py-3.5 rounded-xl text-[15px] font-medium transition"
            style={{
              background: "linear-gradient(180deg, #67dcff, #18a6d6)",
              color: "#051019",
              boxShadow: "0 8px 22px -8px rgba(24,166,214,0.5)",
            }}
          >
            hello@voxaris.io <ArrowRight size={15} />
          </a>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}

function Outcome({
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
      className="rounded-2xl p-6"
      style={{
        background: "rgba(13,17,24,0.6)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
        style={{
          background: "rgba(103,220,255,0.10)",
          border: "1px solid rgba(103,220,255,0.22)",
          color: "#67dcff",
        }}
      >
        {icon}
      </div>
      <div className="font-display font-semibold tracking-tight text-[17px] text-slate-50 mb-2">
        {title}
      </div>
      <p className="text-[13.5px] text-slate-400 leading-relaxed">{body}</p>
    </div>
  );
}
