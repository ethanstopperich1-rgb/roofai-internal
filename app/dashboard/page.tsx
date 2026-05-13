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
  getDashboardRole,
  getDashboardSupabase,
  getDashboardUser,
  isRepRole,
  monthStartISO,
  type Lead,
} from "@/lib/dashboard";
import { getDemoActivity, getDemoMetrics } from "@/lib/dashboard-demo";
import { getDemoLeads as getDemoLeadRows } from "@/lib/dashboard-demo-rows";
import RepOverview from "./rep-overview";

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

/** Build a rep-scoped data bundle from the demo leads — keeps the rep
 *  view usable on /demo without a real Supabase session. Once RLS is
 *  tight we'll swap in a live query that filters by `assigned_to = me`. */
async function loadRepView(repUserId: string | null) {
  const officeSlug = await getDashboardOfficeSlug();
  const allLeads = getDemoLeadRows(officeSlug);
  // On /demo the rep's "id" is the synthetic `demo-rep-${slug}` we wrote
  // in dashboard-demo-rows.ts. In real life it's auth.uid().
  const me = repUserId ?? `demo-rep-${officeSlug}`;
  const myLeads: Lead[] = allLeads.filter((l) => l.assigned_to === me);

  let pipelineLow = 0;
  let pipelineHigh = 0;
  let openLeads = 0;
  let wonThisMonth = 0;
  const monthStart = new Date(monthStartISO()).getTime();
  for (const l of myLeads) {
    if (l.status === "won") {
      if (new Date(l.created_at).getTime() >= monthStart) wonThisMonth += 1;
      continue;
    }
    if (l.status === "lost") continue;
    openLeads += 1;
    pipelineLow += l.estimate_low ?? 0;
    pipelineHigh += l.estimate_high ?? 0;
  }

  // Build a small "needs attention" feed using simple heuristics that
  // map to real rep behavior: pending proposal, no recent contact,
  // booked-but-not-followed. The demo bundle doesn't carry follow-up
  // history so we synthesize from status + age.
  const now = Date.now();
  const attention: Array<{
    leadId: string;
    publicId: string;
    name: string;
    address: string;
    reason: string;
    reasonTone: "amber" | "rose" | "cy";
    at: string;
  }> = [];
  for (const l of myLeads) {
    const age = now - new Date(l.created_at).getTime();
    const days = age / (1000 * 60 * 60 * 24);
    if (l.status === "quoted" && days > 1) {
      attention.push({
        leadId: l.id,
        publicId: l.public_id,
        name: l.name,
        address: l.address,
        reason: "Proposal pending · follow up",
        reasonTone: "amber",
        at: l.created_at,
      });
    } else if (l.status === "new" && days > 0.25) {
      attention.push({
        leadId: l.id,
        publicId: l.public_id,
        name: l.name,
        address: l.address,
        reason: "New lead · no contact yet",
        reasonTone: "rose",
        at: l.created_at,
      });
    } else if (l.status === "scheduled") {
      attention.push({
        leadId: l.id,
        publicId: l.public_id,
        name: l.name,
        address: l.address,
        reason: "Inspection scheduled · confirm",
        reasonTone: "cy",
        at: l.created_at,
      });
    }
    if (attention.length >= 6) break;
  }

  return {
    myLeads,
    metrics: {
      openLeads,
      pipelineLow,
      pipelineHigh,
      callsThisWeek: Math.max(3, Math.round(myLeads.length * 0.6)),
      wonThisMonth,
    },
    attention,
  };
}

export default async function OverviewPage() {
  const role = await getDashboardRole();
  if (isRepRole(role)) {
    const user = await getDashboardUser();
    const { myLeads, metrics: repMetrics, attention } = await loadRepView(user?.id ?? null);
    return (
      <RepOverview
        fullName={user?.full_name ?? user?.email ?? "Rep"}
        metrics={repMetrics}
        myLeads={myLeads}
        attention={attention}
      />
    );
  }

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

  return (
    <div className="flex flex-col gap-6 lg:gap-7">
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

      {/* SCOREBOARD — 4-tile single-row banner. Dropped Proposals
       * (surfaces in the activity feed below) and Sydney-status
       * (already shown in the topbar + footer). */}
      <div className="scoreboard" role="group" aria-label="Operator metrics scoreboard">
        <Link href="/dashboard/leads" className="scoreboard-tile">
          <div className="label">Leads · MTD</div>
          <div className="value">{metrics.leadsThisMonth.toLocaleString()}</div>
          <div className="sublabel">from /quote + /embed</div>
        </Link>

        <Link href="/dashboard/calls" className="scoreboard-tile">
          <div className="label">Sydney calls</div>
          <div className="value">{metrics.callsThisMonth.toLocaleString()}</div>
          <div className="sublabel">answered 24/7</div>
        </Link>

        <Link href="/dashboard/leads" className="scoreboard-tile accent-amber">
          <div className="label">Pipeline · midpoint</div>
          <div className="value">{pipelineDisplay}</div>
          <div className="sublabel">
            {pipelineMid === null
              ? "no estimates yet"
              : `range ${fmtUSD(metrics.pipelineLow, 0)} – ${fmtUSD(metrics.pipelineHigh, 0)}`}
          </div>
        </Link>

        <Link href="/dashboard/proposals" className="scoreboard-tile accent-mint">
          <div className="label">Supplement · MTD</div>
          <div className="value">{fmtUSD(metrics.supplementRecoveredMtd, 0)}</div>
          <div className="sublabel">
            {metrics.supplementClaimsCount} claims supplemented
          </div>
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
              {activity.slice(0, 6).map((item) => (
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

        <aside className="flex flex-col">
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
