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
} from "lucide-react";
import {
  fmtDateTime,
  fmtUSD,
  getDashboardOfficeId,
  getDashboardSupabase,
  monthStartISO,
} from "@/lib/dashboard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface OverviewMetrics {
  leadsThisMonth: number;
  callsThisMonth: number;
  proposalsThisMonth: number;
  pipelineLow: number;
  pipelineHigh: number;
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
  const officeId = await getDashboardOfficeId();
  const supabase = await getDashboardSupabase();
  if (!officeId || !supabase) {
    return {
      metrics: {
        leadsThisMonth: 0,
        callsThisMonth: 0,
        proposalsThisMonth: 0,
        pipelineLow: 0,
        pipelineHigh: 0,
      },
      activity: [],
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

  return {
    metrics: {
      leadsThisMonth: leadsRes.count ?? 0,
      callsThisMonth: callsRes.count ?? 0,
      proposalsThisMonth: proposalsRes.count ?? 0,
      pipelineLow,
      pipelineHigh,
    },
    activity: activity.slice(0, 10),
    configured: true,
  };
}

export default async function OverviewPage() {
  const { metrics, activity } = await loadOverview();

  return (
    <div className="flex flex-col gap-7 lg:gap-8">
      {/* HERO — operator status banner */}
      <header className="glass-panel-hero p-7 lg:p-9 relative overflow-hidden">
        {/* Soft aurora bloom behind the hero copy */}
        <div className="absolute inset-0 pointer-events-none opacity-60">
          <div className="absolute -top-32 -right-20 w-[500px] h-[500px] rounded-full bg-cy-300/10 blur-[80px]" />
          <div className="absolute -bottom-32 -left-10 w-[400px] h-[400px] rounded-full bg-violet-300/10 blur-[80px]" />
        </div>

        <div className="relative flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 mb-4">
              <span className="glass-eyebrow">Operator Console · {monthLabel()}</span>
              <span className="flex items-center gap-1.5 text-[10.5px] font-mono tabular text-mint/85 uppercase tracking-[0.14em]">
                <span className="relative flex items-center justify-center">
                  <span className="absolute w-2.5 h-2.5 rounded-full bg-mint/35 animate-ping" />
                  <span className="relative w-1.5 h-1.5 rounded-full bg-mint shadow-[0_0_8px_rgba(95,227,176,0.55)]" />
                </span>
                Live
              </span>
            </div>
            <h1 className="text-3xl sm:text-4xl lg:text-[44px] tracking-tight font-semibold leading-[1.05]">
              <span className="iridescent-text">Voxaris pipeline.</span>
              <br />
              <span className="text-white/85">Every lead. Every call. Every office.</span>
            </h1>
            <p className="text-[14.5px] text-white/65 mt-4 max-w-2xl leading-relaxed">
              Real-time operator view across leads, Sydney calls, and proposals — multi-office
              architecture with row-level isolation. Updates the instant Sydney books an inspection
              or a customer requests a quote.
            </p>
          </div>

          {/* Hero-right: Sydney status card */}
          <div className="lg:w-80 shrink-0">
            <div className="rounded-2xl border border-white/[0.10] bg-white/[0.04] backdrop-blur-2xl p-5 relative overflow-hidden">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Radio className="w-3.5 h-3.5 text-mint" />
                  <span className="text-[12px] font-medium text-white/90">Sydney</span>
                </div>
                <span className="text-[10px] font-mono tabular text-mint uppercase tracking-[0.14em] flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-mint shadow-[0_0_6px_rgba(95,227,176,0.6)]" />
                  Online
                </span>
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono tabular text-3xl font-semibold text-white tracking-tight">
                  {metrics.callsThisMonth}
                </span>
                <span className="text-[12px] text-white/55">calls this month</span>
              </div>
              <div className="mt-3 pt-3 border-t border-white/[0.05] flex items-center justify-between text-[11px] text-white/50">
                <span>Avg pickup</span>
                <span className="font-mono tabular text-white/80">&lt; 5s</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* STAT GRID */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Users}
          label="Leads"
          sublabel="this month"
          value={metrics.leadsThisMonth.toString()}
          href="/dashboard/leads"
          accent="cy"
        />
        <StatCard
          icon={PhoneCall}
          label="Sydney calls"
          sublabel="answered 24/7"
          value={metrics.callsThisMonth.toString()}
          href="/dashboard/calls"
          accent="cy"
        />
        <StatCard
          icon={FileText}
          label="Proposals"
          sublabel="sent to homeowners"
          value={metrics.proposalsThisMonth.toString()}
          href="/dashboard/proposals"
          accent="amber"
        />
        <StatCard
          icon={TrendingUp}
          label="Pipeline value"
          sublabel="estimated range"
          value={
            metrics.pipelineLow === 0 && metrics.pipelineHigh === 0
              ? "—"
              : `${fmtUSD(metrics.pipelineLow, 0)}–${fmtUSD(metrics.pipelineHigh, 0)}`
          }
          href="/dashboard/leads"
          accent="mint"
          dense
        />
      </div>

      {/* ACTIVITY + JUMP-IN */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 lg:gap-6">
        <div className="glass-panel p-5 lg:p-7 xl:col-span-2">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2.5">
              <Activity className="w-4 h-4 text-cy-300" />
              <h2 className="text-[15px] font-semibold tracking-tight text-white">
                Recent activity
              </h2>
            </div>
            <span className="flex items-center gap-1.5 text-[10.5px] text-mint/85 font-mono tabular uppercase tracking-[0.16em]">
              <span className="w-1.5 h-1.5 rounded-full bg-mint shadow-[0_0_6px_rgba(95,227,176,0.55)] animate-pulse" />
              Live feed
            </span>
          </div>
          {activity.length === 0 ? (
            <StandbyState
              title="Sydney is standing by"
              body="No activity in the last hour. As soon as a customer enters their address or Sydney picks up an inbound call, it surfaces here in real time."
            />
          ) : (
            <ul className="flex flex-col">
              {activity.map((item, i) => (
                <li
                  key={item.id}
                  className={[
                    "flex items-start gap-3.5 py-3.5",
                    i !== activity.length - 1 ? "border-b border-white/[0.04]" : "",
                  ].join(" ")}
                >
                  <ActivityIcon kind={item.kind} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13.5px] text-white/90 truncate">{item.title}</div>
                    {item.detail && (
                      <div className="text-[12px] text-white/50 truncate mt-0.5">{item.detail}</div>
                    )}
                  </div>
                  <div className="text-[10.5px] text-white/40 font-mono tabular whitespace-nowrap">
                    {fmtDateTime(item.at)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <aside className="flex flex-col gap-4">
          <div className="glass-panel p-5 lg:p-6">
            <div className="flex items-center gap-2 mb-4">
              <Sparkles className="w-4 h-4 text-cy-300" />
              <h2 className="text-[15px] font-semibold tracking-tight">Jump in</h2>
            </div>
            <div className="flex flex-col gap-2">
              <JumpLink href="/dashboard/calls" icon={PhoneCall} label="Sydney call inbox" sub="Live transcripts" />
              <JumpLink href="/dashboard/leads" icon={Users} label="Lead pipeline" sub="By status, by office" />
              <JumpLink href="/dashboard/analytics" icon={BarChart3} label="30-day analytics" sub="Funnel + outcomes" />
            </div>
          </div>

          <div className="glass-panel p-5 lg:p-6 relative overflow-hidden">
            <div className="absolute -top-12 -right-8 w-40 h-40 rounded-full bg-cy-300/8 blur-3xl pointer-events-none" />
            <div className="relative">
              <div className="glass-eyebrow mb-3 inline-flex">Platform</div>
              <div className="text-[13px] text-white/75 leading-relaxed">
                <p>
                  Multi-office sales &amp; service automation. One operator console.{" "}
                  <span className="text-white/95 font-medium">Every market, every hour.</span>
                </p>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
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
}: {
  icon: typeof Users;
  label: string;
  sublabel: string;
  value: string;
  href: string;
  accent: "cy" | "mint" | "amber";
  dense?: boolean;
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
      <div className="text-[11.5px] text-white/45 mt-1.5">{sublabel}</div>
    </Link>
  );
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
