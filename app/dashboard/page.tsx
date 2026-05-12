import Link from "next/link";
import {
  Users,
  PhoneCall,
  FileText,
  TrendingUp,
  Sparkles,
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

  const [leadsRes, callsRes, proposalsRes, leadsRecentRes, callsRecentRes, proposalsRecentRes, eventsRecentRes] =
    await Promise.all([
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
  const { metrics, activity, configured } = await loadOverview();

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <header className="glass-panel-hero p-6 lg:p-8">
        <div className="flex items-center gap-2 mb-3">
          <span className="glass-eyebrow">Overview · This Month</span>
        </div>
        <h1 className="text-2xl sm:text-3xl lg:text-4xl tracking-tight font-semibold">
          <span className="iridescent-text">Voxaris pipeline</span>
        </h1>
        <p className="text-sm text-white/65 mt-2 max-w-xl">
          Live across leads, Sydney calls, and proposals for the voxaris office.{" "}
          {configured ? null : "Supabase not configured for this environment — showing zeros."}
        </p>
      </header>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<Users className="w-4 h-4 text-cy-300" />}
          label="Leads this month"
          value={metrics.leadsThisMonth.toString()}
          href="/dashboard/leads"
        />
        <StatCard
          icon={<PhoneCall className="w-4 h-4 text-cy-300" />}
          label="Sydney calls"
          value={metrics.callsThisMonth.toString()}
          href="/dashboard/calls"
        />
        <StatCard
          icon={<FileText className="w-4 h-4 text-cy-300" />}
          label="Proposals sent"
          value={metrics.proposalsThisMonth.toString()}
          href="/dashboard/proposals"
        />
        <StatCard
          icon={<TrendingUp className="w-4 h-4 text-mint" />}
          label="Pipeline value"
          value={
            metrics.pipelineLow === 0 && metrics.pipelineHigh === 0
              ? "$0"
              : `${fmtUSD(metrics.pipelineLow, 0)} – ${fmtUSD(metrics.pipelineHigh, 0)}`
          }
          href="/dashboard/leads"
          dense
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 lg:gap-6">
        {/* Activity feed */}
        <div className="glass-panel p-5 lg:p-6 xl:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold tracking-tight">Recent activity</h2>
            <span className="text-[11px] text-white/45 font-mono tabular uppercase tracking-wider">
              live
            </span>
          </div>
          {activity.length === 0 ? (
            <EmptyState
              icon={<Sparkles className="w-5 h-5 text-cy-300" />}
              title="No activity yet"
              body="Your first lead, call, or proposal will show up here in real time."
            />
          ) : (
            <ul className="flex flex-col">
              {activity.map((item, i) => (
                <li
                  key={item.id}
                  className={[
                    "flex items-start gap-3 py-3",
                    i !== activity.length - 1 ? "border-b border-white/[0.05]" : "",
                  ].join(" ")}
                >
                  <ActivityDot kind={item.kind} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white/90 truncate">{item.title}</div>
                    {item.detail && (
                      <div className="text-xs text-white/55 truncate">{item.detail}</div>
                    )}
                  </div>
                  <div className="text-[11px] text-white/40 font-mono tabular whitespace-nowrap">
                    {fmtDateTime(item.at)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Quick links / blurb */}
        <aside className="glass-panel p-5 lg:p-6 flex flex-col gap-4">
          <h2 className="text-base font-semibold tracking-tight">Jump in</h2>
          <div className="flex flex-col gap-2">
            <Link href="/dashboard/calls" className="glass-button-secondary justify-start">
              <PhoneCall className="w-4 h-4" />
              <span>Open Sydney call inbox</span>
            </Link>
            <Link href="/dashboard/leads" className="glass-button-secondary justify-start">
              <Users className="w-4 h-4" />
              <span>Review lead pipeline</span>
            </Link>
            <Link href="/dashboard/analytics" className="glass-button-secondary justify-start">
              <BarChart3Icon />
              <span>30-day analytics</span>
            </Link>
          </div>
          <div className="glass-divider" />
          <p className="text-[12px] leading-relaxed text-white/55">
            Sydney auto-handles inbound calls, captures TCPA consent, and books appointments
            for the voxaris office. Every call shows up here within seconds of hang-up.
          </p>
        </aside>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  href,
  dense,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  href: string;
  dense?: boolean;
}) {
  return (
    <Link href={href} className="glass-panel p-5 hover:bg-white/[0.04] transition-colors block">
      <div className="flex items-center gap-2 text-xs text-white/55 uppercase tracking-wider mb-3">
        {icon}
        <span>{label}</span>
      </div>
      <div
        className={[
          "font-semibold font-mono tabular tracking-tight",
          dense ? "text-xl lg:text-2xl" : "text-3xl lg:text-4xl",
        ].join(" ")}
      >
        {value}
      </div>
    </Link>
  );
}

function ActivityDot({ kind }: { kind: ActivityItem["kind"] }) {
  const color =
    kind === "lead"
      ? "bg-cy-300"
      : kind === "call"
        ? "bg-mint"
        : kind === "proposal"
          ? "bg-amber"
          : "bg-white/40";
  return (
    <div className="pt-2">
      <div className={`w-1.5 h-1.5 rounded-full ${color}`} />
    </div>
  );
}

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-start gap-2 py-6">
      <div className="flex items-center gap-2 text-sm text-white/85">
        {icon}
        <span>{title}</span>
      </div>
      <p className="text-xs text-white/55 max-w-md">{body}</p>
    </div>
  );
}

// Re-import as named function to keep the bundle small — avoids pulling
// the whole lucide-react module into a server component twice.
function BarChart3Icon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 3v18h18" />
      <path d="M8 17V9" />
      <path d="M13 17v-5" />
      <path d="M18 17v-2" />
    </svg>
  );
}
