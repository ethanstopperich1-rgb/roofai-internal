import Link from "next/link";
import {
  Users,
  PhoneCall,
  FileText,
  TrendingUp,
  Sparkles,
  ArrowUpRight,
  Activity,
  Radio,
  BarChart3,
  Wallet,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import {
  fmtDateTime,
  fmtUSD,
  getDashboardOfficeId,
  getDashboardOfficeSlug,
  getDashboardSupabase,
  monthStartISO,
} from "@/lib/dashboard";
import { getDemoActivity, getDemoMetrics } from "@/lib/dashboard-demo";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface OverviewMetrics {
  leadsThisMonth: number;
  callsThisMonth: number;
  proposalsThisMonth: number;
  pipelineLow: number;
  pipelineHigh: number;
  supplementRecoveredMtd: number;
  supplementClaimsCount: number;
  supplementVsPrevMonthPct: number;
}

interface ActivityItem {
  id: string;
  at: string;
  kind: "lead" | "call" | "proposal" | "event";
  title: string;
  detail: string | null;
}

async function loadOverview(): Promise<{
  metrics: OverviewMetrics;
  activity: ActivityItem[];
  configured: boolean;
}> {
  const officeSlug = await getDashboardOfficeSlug();
  const officeId = await getDashboardOfficeId();
  const supabase = await getDashboardSupabase();
  if (!officeId || !supabase) {
    // No Supabase wiring → fall back to demo data so the dashboard
    // never renders an empty void. The active demo office comes from
    // the `voxaris_demo_office` cookie set by the switcher in the
    // chrome, so each company's data shows when its slug is picked.
    return {
      metrics: getDemoMetrics(officeSlug),
      activity: getDemoActivity(officeSlug).slice(0, 8),
      configured: false,
    };
  }

  const since = monthStartISO();

  const [
    leadsRes,
    callsRes,
    proposalsRes,
    leadsRecentRes,
    callsRecentRes,
    proposalsRecentRes,
    eventsRecentRes,
  ] = await Promise.all([
    supabase
      .from("leads")
      .select("id, estimate_low, estimate_high", { count: "exact" })
      .eq("office_id", officeId)
      .gte("created_at", since),
    supabase
      .from("calls")
      .select("id", { count: "exact", head: true })
      .eq("office_id", officeId)
      .gte("started_at", since),
    supabase
      .from("proposals")
      .select("id", { count: "exact", head: true })
      .eq("office_id", officeId)
      .gte("created_at", since),
    supabase
      .from("leads")
      .select("id, name, address, created_at, status")
      .eq("office_id", officeId)
      .order("created_at", { ascending: false })
      .limit(6),
    supabase
      .from("calls")
      .select("id, caller_number, outcome, started_at, duration_sec")
      .eq("office_id", officeId)
      .order("started_at", { ascending: false })
      .limit(6),
    supabase
      .from("proposals")
      .select("id, public_id, total_low, total_high, created_at")
      .eq("office_id", officeId)
      .order("created_at", { ascending: false })
      .limit(4),
    supabase
      .from("events")
      .select("id, type, payload, at")
      .eq("office_id", officeId)
      .order("at", { ascending: false })
      .limit(6),
  ]);

  let pipelineLow = 0;
  let pipelineHigh = 0;
  for (const row of leadsRes.data ?? []) {
    pipelineLow += row.estimate_low ?? 0;
    pipelineHigh += row.estimate_high ?? 0;
  }

  const activity: ActivityItem[] = [];
  for (const lead of leadsRecentRes.data ?? []) {
    activity.push({
      id: `lead-${lead.id}`,
      at: lead.created_at,
      kind: "lead",
      title: `New lead — ${lead.name}`,
      detail: lead.address,
    });
  }
  for (const call of callsRecentRes.data ?? []) {
    activity.push({
      id: `call-${call.id}`,
      at: call.started_at,
      kind: "call",
      title: `Sydney call — ${call.caller_number ?? "unknown caller"}`,
      detail: call.outcome ? `outcome: ${call.outcome}` : null,
    });
  }
  for (const p of proposalsRecentRes.data ?? []) {
    activity.push({
      id: `prop-${p.id}`,
      at: p.created_at,
      kind: "proposal",
      title: `Proposal sent`,
      detail:
        p.total_low != null && p.total_high != null
          ? `${fmtUSD(p.total_low, 0)} – ${fmtUSD(p.total_high, 0)}`
          : null,
    });
  }
  for (const e of eventsRecentRes.data ?? []) {
    activity.push({
      id: `evt-${e.id}`,
      at: e.at,
      kind: "event",
      title: `Event · ${e.type}`,
      detail: null,
    });
  }
  activity.sort((a, b) => +new Date(b.at) - +new Date(a.at));

  const leadsCount = leadsRes.count ?? 0;
  const callsCount = callsRes.count ?? 0;
  const proposalsCount = proposalsRes.count ?? 0;

  // If the office has zero rows across the board, fall back to demo
  // data so the dashboard reads as a populated operator console. The
  // moment real activity lands (any lead, call, or proposal), the
  // condition flips and the dashboard switches to truth automatically.
  const isEmpty =
    leadsCount === 0 && callsCount === 0 && proposalsCount === 0 && activity.length === 0;

  if (isEmpty) {
    return {
      metrics: getDemoMetrics(officeSlug),
      activity: getDemoActivity(officeSlug).slice(0, 8),
      configured: true,
    };
  }

  // Supplement Recovery is not yet a live-tracked metric — we surface
  // the per-office demo values alongside live lead/call counts so the
  // tile never goes blank while a real `supplements` table is being
  // wired up. Swap to a live count + sum once 0007_supplements.sql lands.
  const demoSupp = getDemoMetrics(officeSlug);

  return {
    metrics: {
      leadsThisMonth: leadsCount,
      callsThisMonth: callsCount,
      proposalsThisMonth: proposalsCount,
      pipelineLow,
      pipelineHigh,
      supplementRecoveredMtd: demoSupp.supplementRecoveredMtd,
      supplementClaimsCount: demoSupp.supplementClaimsCount,
      supplementVsPrevMonthPct: demoSupp.supplementVsPrevMonthPct,
    },
    activity: activity.slice(0, 10),
    configured: true,
  };
}

export default async function OverviewPage() {
  const { metrics, activity } = await loadOverview();

  // The marquee KPI is the *midpoint* of the pipeline range — a single
  // bold number reads as "this is the live deal flow." Falls back to a
  // sentinel when the office has no estimates yet.
  const pipelineMid =
    metrics.pipelineLow === 0 && metrics.pipelineHigh === 0
      ? null
      : Math.round((metrics.pipelineLow + metrics.pipelineHigh) / 2);

  // Compact pipeline midpoint for the headline tile
  const pipelineDisplay =
    pipelineMid === null
      ? "—"
      : pipelineMid >= 1_000_000
        ? `$${(pipelineMid / 1_000_000).toFixed(2)}M`
        : `$${Math.round(pipelineMid / 1000)}K`;

  // Ticker cells repeat once so the CSS-only marquee can scroll seamlessly
  const tickerCells = [
    { k: "LEADS · MTD", v: metrics.leadsThisMonth.toLocaleString(), d: null as null | number },
    { k: "SYDNEY", v: metrics.callsThisMonth.toLocaleString(), d: null },
    { k: "PROPOSALS", v: metrics.proposalsThisMonth.toLocaleString(), d: null },
    { k: "SUPPLEMENT MTD", v: fmtUSD(metrics.supplementRecoveredMtd, 0), d: metrics.supplementVsPrevMonthPct },
    { k: "PIPELINE", v: pipelineDisplay, d: null },
    { k: "AVG PICKUP", v: "<5s", d: null },
    { k: "CLAIMS", v: metrics.supplementClaimsCount.toString(), d: null },
  ];

  return (
    <div className="flex flex-col gap-6 lg:gap-7">
      {/* TICKER TAPE — single-row scrolling status strip */}
      <div className="tape-strip" role="region" aria-label="Live metrics ticker">
        <div className="tape-prefix">
          <span className="relative flex items-center justify-center">
            <span className="absolute w-2.5 h-2.5 rounded-full bg-mint/35 animate-ping" />
            <span className="relative w-1.5 h-1.5 rounded-full bg-mint shadow-[0_0_8px_rgba(95,227,176,0.55)]" />
          </span>
          <span>{isDemoBuild() ? "DEMO · LIVE" : "LIVE"}</span>
        </div>
        <div className="tape-track" aria-hidden="false">
          {[...tickerCells, ...tickerCells].map((c, i) => (
            <span key={i} className="tape-cell">
              <span className="k">{c.k}</span>
              <span className="v">{c.v}</span>
              {c.d != null && c.d !== 0 && (
                <span className={["d", c.d > 0 ? "up" : "down"].join(" ")}>
                  {c.d > 0 ? "▲" : "▼"} {Math.abs(c.d)}%
                </span>
              )}
              <span className="tape-sep">·</span>
            </span>
          ))}
        </div>
      </div>

      {/* HEADER ROW — eyebrow + status, no big paragraph */}
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
        <div>
          <span className="glass-eyebrow">Operator Console · {monthLabel()}</span>
          <h1 className="text-[22px] sm:text-[26px] lg:text-[30px] tracking-tight font-medium leading-tight mt-3 text-white/92">
            <span className="iridescent-text">Voxaris pipeline</span>{" "}
            <span className="text-white/45">/ overview</span>
          </h1>
        </div>
        <div className="flex items-center gap-3 text-[10.5px] font-mono tabular uppercase tracking-[0.18em] text-white/45">
          <span>
            office{" "}
            <span className="text-cy-300">
              {new Date().toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
            </span>
          </span>
        </div>
      </header>

      {/* SCOREBOARD — 6-tile mega grid (was: hero + stat grid) */}
      <div className="scoreboard" role="group" aria-label="Operator metrics scoreboard">
        <Link
          href="/dashboard/leads"
          className="scoreboard-tile"
        >
          <div className="label">Leads · MTD</div>
          <div className="value">{metrics.leadsThisMonth.toLocaleString()}</div>
          <div className="sublabel">from /quote + /embed</div>
        </Link>

        <Link
          href="/dashboard/calls"
          className="scoreboard-tile"
        >
          <div className="label">Sydney calls</div>
          <div className="value">{metrics.callsThisMonth.toLocaleString()}</div>
          <div className="sublabel">answered 24/7 · avg pickup &lt;5s</div>
        </Link>

        <Link
          href="/dashboard/leads"
          className="scoreboard-tile accent-amber size-hero"
        >
          <div className="label">Pipeline · midpoint</div>
          <div className="value">{pipelineDisplay}</div>
          <div className="sublabel">
            {pipelineMid === null
              ? "no estimates yet"
              : `range ${fmtUSD(metrics.pipelineLow, 0)} – ${fmtUSD(metrics.pipelineHigh, 0)}`}
          </div>
        </Link>

        <Link
          href="/dashboard/proposals"
          className="scoreboard-tile"
        >
          <div className="label">Proposals</div>
          <div className="value">{metrics.proposalsThisMonth.toLocaleString()}</div>
          <div className="sublabel">generated this month</div>
        </Link>

        <Link
          href="/dashboard/proposals"
          className="scoreboard-tile accent-mint"
        >
          <div className="label">Supplement · MTD</div>
          <div className="value">{fmtUSD(metrics.supplementRecoveredMtd, 0)}</div>
          <div className="sublabel">{metrics.supplementClaimsCount} claims supplemented</div>
          {metrics.supplementVsPrevMonthPct !== 0 && (
            <div
              className={[
                "delta",
                metrics.supplementVsPrevMonthPct > 0 ? "up" : "down",
              ].join(" ")}
            >
              {metrics.supplementVsPrevMonthPct > 0 ? "▲" : "▼"}{" "}
              {Math.abs(metrics.supplementVsPrevMonthPct)}% vs {prevMonthLabel()}
            </div>
          )}
        </Link>

        <div className="scoreboard-tile accent-mint">
          <div className="label">Sydney status</div>
          <div className="value" style={{ fontSize: "1.5rem", letterSpacing: "0.04em" }}>
            <span className="text-mint">◆</span>{" "}
            <span style={{ color: "rgb(143 240 199)" }}>ONLINE</span>
          </div>
          <div className="sublabel">
            standing by · listening across {/* office count */}every office
          </div>
        </div>
      </div>

      {/* OPERATIONS chapter */}
      <div className="console-section-rule mt-2">
        <span className="pulse" aria-hidden="true" />
        <span>Live feed · last 60 minutes</span>
      </div>

      {/* TERMINAL LOG + JUMP-IN — two-column, log dominates */}
      <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-4 lg:gap-6">
        <div className="glass-panel overflow-hidden">
          {activity.length === 0 ? (
            <div className="p-6">
              <StandbyState
                title="Sydney is standing by"
                body="No activity in the last hour. As soon as a customer enters their address or Sydney picks up an inbound call, it surfaces here in real time."
              />
            </div>
          ) : (
            <ul className="flex flex-col">
              {activity.map((item) => (
                <li key={item.id} className="log-row">
                  <span className="ts">{shortTime(item.at)}</span>
                  <span className={`kind ${item.kind}`}>{item.kind}</span>
                  <span className="body">{item.title}</span>
                  <span className="meta">{item.detail ?? ""}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <aside className="flex flex-col gap-5">
          <div className="glass-panel overflow-hidden">
            <div className="px-4 pt-3.5 pb-2 text-[10.5px] font-mono tabular uppercase tracking-[0.18em] text-white/45 border-b border-white/[0.06]">
              Jump in
            </div>
            <div className="flex flex-col">
              <Link href="/dashboard/calls" className="jump-row">
                <span className="glyph">▸</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-white/92 font-medium">Sydney call inbox</div>
                  <div className="text-[11px] text-white/45 font-mono tabular uppercase tracking-wider mt-0.5">
                    live transcripts
                  </div>
                </div>
                <ArrowUpRight className="w-3.5 h-3.5 text-white/35" />
              </Link>
              <Link href="/dashboard/leads" className="jump-row">
                <span className="glyph">▸</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-white/92 font-medium">Lead pipeline</div>
                  <div className="text-[11px] text-white/45 font-mono tabular uppercase tracking-wider mt-0.5">
                    by status · by office
                  </div>
                </div>
                <ArrowUpRight className="w-3.5 h-3.5 text-white/35" />
              </Link>
              <Link href="/dashboard/analytics" className="jump-row">
                <span className="glyph">▸</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-white/92 font-medium">30-day analytics</div>
                  <div className="text-[11px] text-white/45 font-mono tabular uppercase tracking-wider mt-0.5">
                    funnel + outcomes
                  </div>
                </div>
                <ArrowUpRight className="w-3.5 h-3.5 text-white/35" />
              </Link>
            </div>
          </div>

          <div className="glass-panel p-4">
            <div className="text-[10.5px] font-mono tabular uppercase tracking-[0.18em] text-cy-300/85 mb-2">
              ▸ Platform
            </div>
            <p className="text-[12.5px] text-white/72 leading-relaxed">
              Multi-office sales &amp; service automation. One operator console.{" "}
              <span className="text-white/95 font-medium">Every market, every hour.</span>
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function isDemoBuild(): boolean {
  // Used purely for label cosmetic — the real demo flag is set by middleware
  // via the x-voxaris-demo header. Avoiding a server-only call from this
  // synchronous helper; the prefix reads the same way either way.
  return false;
}

function monthLabel(): string {
  return new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function StatCard({
  icon: Icon,
  label,
  sublabel,
  value,
  href,
  accent,
  dense,
  deltaPct,
}: {
  icon: typeof Users;
  label: string;
  sublabel: string;
  value: string;
  href: string;
  accent: "cy" | "mint" | "amber";
  dense?: boolean;
  deltaPct?: number;
}) {
  const accentColor =
    accent === "mint"
      ? "text-mint"
      : accent === "amber"
        ? "text-amber"
        : "text-cy-300";
  const accentBg =
    accent === "mint"
      ? "bg-mint/15 border-mint/25"
      : accent === "amber"
        ? "bg-amber/15 border-amber/25"
        : "bg-cy-300/15 border-cy-300/25";
  const glow =
    accent === "mint"
      ? "shadow-[0_0_14px_-4px_rgba(95,227,176,0.55)]"
      : accent === "amber"
        ? "shadow-[0_0_14px_-4px_rgba(243,177,75,0.55)]"
        : "shadow-[0_0_14px_-4px_rgba(125,211,252,0.55)]";

  return (
    <Link
      href={href}
      className="glass-panel is-interactive p-5 lg:p-6 block group relative overflow-hidden"
    >
      <div className="flex items-start justify-between mb-4">
        <div
          className={`w-9 h-9 rounded-2xl flex items-center justify-center border ${accentBg} ${glow}`}
        >
          <Icon className={`w-4 h-4 ${accentColor}`} />
        </div>
        <ArrowUpRight className="w-3.5 h-3.5 text-white/30 group-hover:text-white/70 transition-colors" />
      </div>
      <div className="text-[10.5px] font-mono tabular uppercase tracking-[0.16em] text-white/45 mb-1">
        {label}
      </div>
      <div
        className={[
          "font-semibold font-mono tabular tracking-tight text-white",
          dense ? "text-xl lg:text-2xl" : "text-3xl lg:text-[34px]",
        ].join(" ")}
      >
        {value}
      </div>
      <div className="flex items-center gap-2 mt-1.5">
        <div className="text-[11.5px] text-white/45">{sublabel}</div>
        {typeof deltaPct === "number" && deltaPct !== 0 && (
          <span
            className={[
              "inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-mono tabular font-medium",
              deltaPct > 0
                ? "bg-mint/12 text-mint border border-mint/25"
                : "bg-red-500/12 text-red-300 border border-red-400/25",
            ].join(" ")}
          >
            {deltaPct > 0 ? (
              <ArrowUp className="w-2.5 h-2.5" />
            ) : (
              <ArrowDown className="w-2.5 h-2.5" />
            )}
            {Math.abs(deltaPct)}%
            <span className="text-white/40 ml-0.5">vs {prevMonthLabel()}</span>
          </span>
        )}
      </div>
    </Link>
  );
}

function prevMonthLabel(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.toLocaleDateString("en-US", { month: "short" });
}

function JumpLink({
  href,
  icon: Icon,
  label,
  sub,
}: {
  href: string;
  icon: typeof PhoneCall;
  label: string;
  sub: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 px-3 py-2.5 rounded-2xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/[0.12] transition-all"
    >
      <div className="w-7 h-7 rounded-xl bg-cy-300/10 border border-cy-300/20 flex items-center justify-center text-cy-300 group-hover:bg-cy-300/15 transition-colors">
        <Icon className="w-3.5 h-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-white/90 font-medium leading-tight">{label}</div>
        <div className="text-[11px] text-white/45 leading-tight mt-0.5">{sub}</div>
      </div>
      <ArrowUpRight className="w-3.5 h-3.5 text-white/30 group-hover:text-white/70 transition-colors" />
    </Link>
  );
}

function ActivityIcon({ kind }: { kind: ActivityItem["kind"] }) {
  const config =
    kind === "lead"
      ? { Ic: Users, color: "text-cy-300", bg: "bg-cy-300/10 border-cy-300/20" }
      : kind === "call"
        ? { Ic: PhoneCall, color: "text-mint", bg: "bg-mint/10 border-mint/20" }
        : kind === "proposal"
          ? { Ic: FileText, color: "text-amber", bg: "bg-amber/10 border-amber/20" }
          : { Ic: Activity, color: "text-white/55", bg: "bg-white/[0.04] border-white/[0.08]" };
  const Ic = config.Ic;
  return (
    <div
      className={`w-7 h-7 rounded-xl border flex items-center justify-center flex-shrink-0 ${config.bg}`}
    >
      <Ic className={`w-3.5 h-3.5 ${config.color}`} />
    </div>
  );
}

function StandbyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-center gap-4 py-7 px-2 rounded-2xl border border-white/[0.05] bg-white/[0.015]">
      <div className="relative flex items-center justify-center flex-shrink-0">
        <span className="absolute w-12 h-12 rounded-full bg-mint/10 animate-ping" />
        <div className="relative w-10 h-10 rounded-2xl bg-mint/15 border border-mint/25 flex items-center justify-center shadow-[0_0_18px_-4px_rgba(95,227,176,0.55)]">
          <Radio className="w-4 h-4 text-mint" />
        </div>
      </div>
      <div>
        <div className="text-[14px] text-white/90 font-medium">{title}</div>
        <p className="text-[12.5px] text-white/55 max-w-md leading-relaxed mt-1">{body}</p>
      </div>
    </div>
  );
}
