import type { Metadata } from "next";
import Link from "next/link";
import {
  Radio,
  MapPin,
  Activity,
  Inbox,
  Send,
  ChartLine,
  ShieldCheck,
  Clock,
  ArrowRight,
} from "lucide-react";
import ActivationForm from "@/components/storms/ActivationForm";
import LiveStormCard from "@/components/storms/LiveStormCard";

export const metadata: Metadata = {
  title: "Storm Intelligence · Voxaris Pitch",
  description:
    "Turn every hail event into a same-day canvass list. Voxaris ingests NOAA MRMS radar daily, scores damaged-property addresses, and routes them to your reps before the out-of-state storm chasers arrive.",
  robots: { index: true, follow: true },
};

// Default watched region for the demo card. Orange County, FL — the
// heart of the central-Florida roofing market. Operator-specific
// regions are set up post-pilot.
const DEMO_REGION = {
  name: "Orlando, FL",
  lat: 28.5384,
  lng: -81.3792,
  radiusMiles: 25,
};

// The Maps key is read here on the server and passed to the
// client-side LiveStormCard. Static-map URLs include the key, so
// surfacing it is fine — same surface as the existing /quote map.
const GOOGLE_MAPS_KEY =
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";

export default function StormsPage() {
  return (
    <div className="min-h-screen lg-env relative">
      {/* Header */}
      <header
        className="relative z-30"
        style={{
          background:
            "linear-gradient(180deg, rgba(8,11,17,0.55) 0%, rgba(8,11,17,0.25) 100%)",
          backdropFilter: "blur(40px) saturate(1.5)",
          WebkitBackdropFilter: "blur(40px) saturate(1.5)",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 sm:h-20 flex items-center justify-between">
          <Link href="/quote" className="flex items-center gap-3 min-w-0">
            <span className="font-display text-[20px] sm:text-[24px] font-semibold tracking-tight text-slate-50">
              Voxaris
            </span>
            <span className="chip chip-accent text-[10px]">Storm Intelligence</span>
          </Link>
          <nav className="hidden md:flex items-center gap-6 text-[13px] text-slate-300">
            <Link href="/quote" className="hover:text-white transition-colors">
              Homeowner quote
            </Link>
            <Link href="/methodology" className="hover:text-white transition-colors">
              Methodology
            </Link>
            <a
              href="#activate"
              className="glass-button-primary inline-flex items-center gap-2 px-4 py-2 text-[13px]"
            >
              Activate <ArrowRight size={14} />
            </a>
          </nav>
        </div>
      </header>

      <main className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 py-12 sm:py-20 space-y-16 sm:space-y-24">
        {/* HERO */}
        <section className="relative">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber/[0.10] border border-amber/30 text-amber text-[11px] font-mono uppercase tracking-[0.14em] mb-6">
            <Radio size={12} />
            Live · NOAA radar daily ingest
          </div>
          <h1
            className="font-display font-semibold tracking-[-0.035em] text-slate-50 leading-[0.95]"
            style={{ fontSize: "clamp(40px, 7.5vw, 80px)" }}
          >
            When hail hits,{" "}
            <span className="bg-gradient-to-b from-cy-300 via-cy-300 to-white bg-clip-text text-transparent italic">
              your reps know first.
            </span>
          </h1>
          <p className="text-[16px] sm:text-[19px] text-slate-300 leading-relaxed mt-6 sm:mt-8 max-w-[58ch]">
            Every morning at 6 AM, Voxaris scans the previous 48 hours of
            NOAA MRMS radar for hail events in your service area, scores
            every property inside the impact footprint, and queues a
            ranked canvass list before the out-of-state storm chasers
            book their flights.
          </p>
          <div className="flex flex-wrap gap-3 mt-8">
            <a
              href="#live"
              className="glass-button-primary inline-flex items-center gap-2 px-5 py-3 text-[14px]"
            >
              See it live in Orlando <ArrowRight size={14} />
            </a>
            <a
              href="#activate"
              className="glass-button-secondary inline-flex items-center gap-2 px-5 py-3 text-[14px]"
            >
              Activate for your territory
            </a>
          </div>
        </section>

        {/* LIVE STORM CARD */}
        <section id="live" className="scroll-mt-24">
          <SectionEyebrow>Live demo · Orange County, FL</SectionEyebrow>
          <h2 className="font-display text-[32px] sm:text-[44px] font-semibold tracking-[-0.025em] text-slate-50 mt-3 mb-2 leading-tight">
            Most recent qualifying event
          </h2>
          <p className="text-[14px] text-slate-400 max-w-prose">
            Pulled from NOAA MRMS radar within the last 90 days, filtered
            to events with MESH ≥1 inch. We cross-reference with NOAA
            Storm Events for ground-truth validation.
          </p>

          <div className="mt-8">
            <LiveStormCard
              lat={DEMO_REGION.lat}
              lng={DEMO_REGION.lng}
              regionName={DEMO_REGION.name}
              radiusMiles={DEMO_REGION.radiusMiles}
              googleMapsKey={GOOGLE_MAPS_KEY}
            />
          </div>

          <p className="text-[11.5px] text-slate-500 mt-4 leading-relaxed max-w-prose">
            Map is a visual approximation of the radar-detected impact area.
            The polygon ring shown is the analysis radius; the operator
            dashboard surfaces the actual cell-level hit map. Source:
            NOAA MRMS Maximum Estimated Size of Hail (MESH), 1km radar
            grid, cross-referenced with NOAA Storm Events Local Storm
            Reports.{" "}
            <Link href="/methodology" className="text-cy-300 hover:underline">
              How we measure →
            </Link>
          </p>
        </section>

        {/* PIPELINE */}
        <section>
          <SectionEyebrow>How the pipeline works</SectionEyebrow>
          <h2 className="font-display text-[32px] sm:text-[44px] font-semibold tracking-[-0.025em] text-slate-50 mt-3 mb-2 leading-tight">
            Radar to rep in under 6 hours.
          </h2>
          <p className="text-[14px] text-slate-400 max-w-prose">
            The cron runs daily at 06:00 UTC — 2 AM Eastern. By the time
            your reps open the dashboard, the previous day&apos;s storm
            events are scored, mapped, and queued.
          </p>

          <div className="mt-10 grid md:grid-cols-5 gap-3 sm:gap-4">
            {PIPELINE_STEPS.map((step, i) => (
              <PipelineStep key={step.title} index={i + 1} {...step} />
            ))}
          </div>
        </section>

        {/* SAMPLE OUTPUTS */}
        <section>
          <SectionEyebrow>What lands in the operator dashboard</SectionEyebrow>
          <h2 className="font-display text-[32px] sm:text-[44px] font-semibold tracking-[-0.025em] text-slate-50 mt-3 mb-2 leading-tight">
            Three deliverables per event.
          </h2>
          <p className="text-[14px] text-slate-400 max-w-prose">
            Every detected event produces an actionable canvass list, a
            ready-to-mail postcard design, and a per-event landing page
            so every contact attempt drops the homeowner into the
            estimate flow.
          </p>

          <div className="mt-10 grid lg:grid-cols-3 gap-4 sm:gap-6">
            <DeliverableCanvassList />
            <DeliverablePostcard />
            <DeliverableLandingPage />
          </div>
        </section>

        {/* HONEST DISCLOSURE */}
        <section>
          <SectionEyebrow>What we can and can&apos;t claim</SectionEyebrow>
          <div className="glass-panel p-6 sm:p-8 mt-6">
            <div className="grid sm:grid-cols-2 gap-6 sm:gap-8">
              <div>
                <h3 className="font-display text-[18px] font-semibold tracking-tight text-mint mb-3">
                  ✓ What we say with confidence
                </h3>
                <ul className="space-y-2.5 text-[13.5px] text-slate-300 leading-relaxed">
                  <li>&ldquo;Significant hail passed within X miles of this address on [date].&rdquo;</li>
                  <li>&ldquo;MRMS-estimated peak size: 1.0–2.5 inches.&rdquo;</li>
                  <li>&ldquo;N ground reports filed within Y miles that day.&rdquo;</li>
                  <li>&ldquo;Properties in this hail footprint are inspection-eligible.&rdquo;</li>
                </ul>
              </div>
              <div>
                <h3 className="font-display text-[18px] font-semibold tracking-tight text-rose mb-3">
                  ✗ What we won&apos;t claim
                </h3>
                <ul className="space-y-2.5 text-[13.5px] text-slate-300 leading-relaxed">
                  <li>&ldquo;Your specific roof has hail damage.&rdquo; (Only on-site inspection proves that.)</li>
                  <li>&ldquo;Your house got exactly 1.75-inch hail.&rdquo; (MESH is a range estimate.)</li>
                  <li>&ldquo;100% confirmed damage at this address.&rdquo;</li>
                  <li>Per-house damage probabilities without ground confirmation.</li>
                </ul>
              </div>
            </div>
            <p className="text-[12.5px] text-slate-400 mt-6 pt-6 border-t border-white/[0.06] leading-relaxed">
              <strong className="text-slate-200">Bottom line:</strong>{" "}
              This is a <em>canvass-routing</em> tool, not a <em>damage-confirmation</em>
              {" "}tool. Same architecture every legitimate hail-response operation
              uses. The on-site inspection is the closer — Voxaris just
              gets your reps there first.
            </p>
          </div>
        </section>

        {/* TRUST + COVERAGE */}
        <section className="grid md:grid-cols-3 gap-3 sm:gap-4">
          <TrustItem
            icon={<ShieldCheck size={16} />}
            title="TCPA-clean by default"
            body="SMS outbound is gated by Voxaris's persistent opt-out table. Direct-mail canvassing requires no consent."
          />
          <TrustItem
            icon={<Clock size={16} />}
            title="Daily refresh"
            body="MRMS ingest runs every 02:30 UTC. Storm-pulse cron runs every 06:00 UTC. Your reps see overnight events before opening shop."
          />
          <TrustItem
            icon={<ChartLine size={16} />}
            title="Conversion-tracked"
            body="Every canvass target carries a status lifecycle (new → contacted → responded → won/lost). Your dashboard shows the funnel by storm event."
          />
        </section>

        {/* ACTIVATION */}
        <section id="activate" className="scroll-mt-24">
          <SectionEyebrow>Activate for your territory</SectionEyebrow>
          <h2 className="font-display text-[32px] sm:text-[44px] font-semibold tracking-[-0.025em] text-slate-50 mt-3 mb-2 leading-tight">
            Get the next storm before your competitors.
          </h2>
          <p className="text-[14px] text-slate-400 max-w-prose mb-10">
            Activation takes about 90 minutes per region: confirm your
            zips, wire your county parcel feed (or pick a partner data
            source), connect your CRM, then go live.
          </p>
          <ActivationForm />
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/[0.08] mt-12">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-wrap items-center justify-between gap-y-3 gap-x-6 text-[11.5px] text-slate-500 font-mono">
          <span>© {new Date().getFullYear()} Voxaris · Storm Intelligence</span>
          <div className="flex items-center gap-x-4 gap-y-2 flex-wrap">
            <Link href="/methodology" className="hover:text-slate-300">How we measure</Link>
            <span className="text-slate-700">·</span>
            <Link href="/privacy" className="hover:text-slate-300">Privacy</Link>
            <span className="text-slate-700">·</span>
            <Link href="/terms" className="hover:text-slate-300">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ─── Subcomponents ───────────────────────────────────────────────────── */

function SectionEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-cy-300">
      {children}
    </div>
  );
}

const PIPELINE_STEPS = [
  {
    icon: <Radio size={20} />,
    title: "NOAA radar",
    body: "MRMS MESH ingested daily from NOAA at 02:30 UTC. 1km national radar grid.",
  },
  {
    icon: <Activity size={20} />,
    title: "Detect",
    body: "Scan trailing 48 hours per watched region for events ≥1 inch peak hail.",
  },
  {
    icon: <MapPin size={20} />,
    title: "Map addresses",
    body: "Count buildings inside the canvass radius via OSM. Address rows populate from county parcel feed.",
  },
  {
    icon: <Inbox size={20} />,
    title: "Score & queue",
    body: "Rank by peak size × distance × roof-age proxy. Insert canvass_targets rows for the operator dashboard.",
  },
  {
    icon: <Send size={20} />,
    title: "Activate",
    body: "Operator pulls the list. Direct mail (Lob), TCPA-clean SMS, door-knock route — your call.",
  },
];

function PipelineStep({
  index,
  icon,
  title,
  body,
}: {
  index: number;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="glass-panel p-5 relative">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-cy-300/90 px-2 py-0.5 rounded-full border border-cy-300/30 bg-cy-300/5">
          {String(index).padStart(2, "0")}
        </span>
        <div className="w-9 h-9 rounded-xl bg-cy-300/10 border border-cy-300/20 flex items-center justify-center text-cy-300">
          {icon}
        </div>
      </div>
      <div className="font-display font-semibold tracking-tight text-[15px] text-slate-100">
        {title}
      </div>
      <p className="text-[12.5px] text-slate-400 mt-2 leading-relaxed">{body}</p>
    </div>
  );
}

function DeliverableCanvassList() {
  const rows = [
    { addr: "•••• Glasstone Ct, Apopka FL", score: 8.2 },
    { addr: "•••• Brittany Bay, Apopka FL", score: 8.0 },
    { addr: "•••• Citrus Tree Ln, Apopka FL", score: 7.8 },
    { addr: "•••• Westmoreland Ave, Orlando FL", score: 7.5 },
    { addr: "•••• Honeywood Pl, Apopka FL", score: 7.3 },
  ];
  return (
    <div className="glass-panel-strong p-6 flex flex-col">
      <div className="flex items-center gap-2 mb-4">
        <Inbox size={14} className="text-cy-300" />
        <span className="label">Canvass list</span>
      </div>
      <div className="font-display text-[18px] font-semibold tracking-tight text-slate-50 mb-4">
        Today&apos;s ranked targets
      </div>
      <div className="space-y-1.5 mb-4 flex-1">
        {rows.map((r, i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-white/[0.025] border border-white/[0.05]"
          >
            <span className="text-[12.5px] text-slate-300 truncate font-mono">
              {r.addr}
            </span>
            <span className="chip chip-amber text-[10px] flex-shrink-0">
              {r.score.toFixed(1)}
            </span>
          </div>
        ))}
      </div>
      <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-slate-500 pt-3 border-t border-white/[0.06]">
        Sample illustration · Real addresses appear at activation
      </div>
    </div>
  );
}

function DeliverablePostcard() {
  return (
    <div className="glass-panel-strong p-6 flex flex-col">
      <div className="flex items-center gap-2 mb-4">
        <Send size={14} className="text-cy-300" />
        <span className="label">Direct mail</span>
      </div>
      <div className="font-display text-[18px] font-semibold tracking-tight text-slate-50 mb-4">
        Pre-built postcard
      </div>
      <div className="rounded-xl bg-gradient-to-br from-cy-300/15 to-mint/10 border border-cy-300/25 p-5 flex-1 flex flex-col justify-between">
        <div>
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-cy-300 mb-2">
            Hail event · April 22
          </div>
          <div className="font-display text-[20px] font-semibold tracking-tight text-slate-50 leading-tight">
            We measured 1.4-inch hail at your address.
          </div>
          <p className="text-[12.5px] text-slate-300 mt-3 leading-relaxed">
            Your neighborhood was inside the storm footprint. A free
            inspection from a local crew confirms whether your roof
            took damage.
          </p>
        </div>
        <div className="mt-4 pt-3 border-t border-white/[0.08] text-[11px] font-mono text-cy-300 tabular">
          storm.acme-roofing.com/0422-•••••
        </div>
      </div>
      <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-slate-500 pt-3 mt-4 border-t border-white/[0.06]">
        Lob.com integration · $0.85/postcard at scale
      </div>
    </div>
  );
}

function DeliverableLandingPage() {
  return (
    <div className="glass-panel-strong p-6 flex flex-col">
      <div className="flex items-center gap-2 mb-4">
        <ChartLine size={14} className="text-cy-300" />
        <span className="label">Per-event landing</span>
      </div>
      <div className="font-display text-[18px] font-semibold tracking-tight text-slate-50 mb-4">
        Pre-filled estimate flow
      </div>
      <div className="rounded-xl bg-black/30 border border-white/[0.06] p-5 flex-1 space-y-3">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-mint pulse-dot" />
          <span className="text-[11px] font-mono uppercase tracking-[0.14em] text-mint">
            Address matched
          </span>
        </div>
        <div className="font-display text-[17px] font-semibold tracking-tight text-slate-50 leading-tight">
          Welcome — your home is in the April 22 hail footprint.
        </div>
        <div className="text-[12px] text-slate-400 leading-relaxed">
          Peak MESH: 1.4&Prime; · 12 ground reports same day · Roof age
          estimate: 14 yrs (county records)
        </div>
        <div className="pt-2">
          <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-slate-500 mb-1.5">
            One-click intake
          </div>
          <div className="text-[12.5px] text-cy-300 font-medium">
            Schedule a free inspection →
          </div>
        </div>
      </div>
      <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-slate-500 pt-3 mt-4 border-t border-white/[0.06]">
        Routes into your existing /quote flow
      </div>
    </div>
  );
}

function TrustItem({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="glass-panel p-5">
      <div className="flex items-center gap-2.5 mb-2.5 text-cy-300">
        {icon}
        <div className="font-display font-semibold tracking-tight text-[14px] text-slate-100">
          {title}
        </div>
      </div>
      <p className="text-[12.5px] text-slate-400 leading-relaxed">{body}</p>
    </div>
  );
}
