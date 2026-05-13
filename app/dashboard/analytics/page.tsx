import { BarChart3, Activity, Radio, TrendingUp, Layers } from "lucide-react";
import {
  daysAgoISO,
  fmtUSD,
  getDashboardOfficeId,
  getDashboardOfficeSlug,
  getDashboardSupabase,
  outcomeStyle,
} from "@/lib/dashboard";
import {
  getDemoCallsByDay,
  getDemoFunnel,
  getDemoOutcomes,
  getDemoTopMaterials,
  getDemoTotalCalls,
} from "@/lib/dashboard-demo";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface Funnel {
  leads: number;
  calls: number;
  proposals: number;
  won: number;
}

interface DayBucket {
  day: string;
  count: number;
}

interface MaterialAgg {
  material: string;
  count: number;
  avgLow: number;
  avgHigh: number;
}

interface OutcomeAgg {
  outcome: string;
  count: number;
}

interface AnalyticsData {
  funnel: Funnel;
  callsByDay: DayBucket[];
  topMaterials: MaterialAgg[];
  outcomeBreakdown: OutcomeAgg[];
  totalCalls: number;
  hasData: boolean;
}

async function load(): Promise<AnalyticsData> {
  const officeSlug = await getDashboardOfficeSlug();
  const officeId = await getDashboardOfficeId();
  const supabase = await getDashboardSupabase();
  if (!officeId || !supabase) {
    // No Supabase → demo data, keyed to the active office slug from the
    // switcher cookie so analytics tracks the same office as overview.
    return {
      funnel: getDemoFunnel(officeSlug),
      callsByDay: getDemoCallsByDay(officeSlug),
      topMaterials: getDemoTopMaterials(officeSlug),
      outcomeBreakdown: getDemoOutcomes(officeSlug),
      totalCalls: getDemoTotalCalls(officeSlug),
      hasData: true,
    };
  }
  const since = daysAgoISO(30);

  const [leadsRes, callsRes, proposalsRes] = await Promise.all([
    supabase
      .from("leads")
      .select("id, material, status, estimate_low, estimate_high, created_at")
      .eq("office_id", officeId)
      .gte("created_at", since),
    supabase
      .from("calls")
      .select("id, outcome, started_at")
      .eq("office_id", officeId)
      .gte("started_at", since),
    supabase
      .from("proposals")
      .select("id, created_at", { count: "exact", head: true })
      .eq("office_id", officeId)
      .gte("created_at", since),
  ]);

  const leads = leadsRes.data ?? [];
  const calls = callsRes.data ?? [];

  const won = leads.filter((l) => l.status === "won").length;
  const funnel: Funnel = {
    leads: leads.length,
    calls: calls.length,
    proposals: proposalsRes.count ?? 0,
    won,
  };

  const callsByDayMap = new Map<string, number>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    callsByDayMap.set(d.toISOString().slice(0, 10), 0);
  }
  for (const c of calls) {
    const k = c.started_at.slice(0, 10);
    if (callsByDayMap.has(k)) callsByDayMap.set(k, (callsByDayMap.get(k) ?? 0) + 1);
  }
  const callsByDay: DayBucket[] = Array.from(callsByDayMap.entries()).map(([day, count]) => ({
    day,
    count,
  }));

  const materialMap = new Map<string, { count: number; low: number; high: number }>();
  for (const l of leads) {
    if (!l.material) continue;
    const m = materialMap.get(l.material) ?? { count: 0, low: 0, high: 0 };
    m.count += 1;
    if (l.estimate_low) m.low += l.estimate_low;
    if (l.estimate_high) m.high += l.estimate_high;
    materialMap.set(l.material, m);
  }
  const topMaterials: MaterialAgg[] = Array.from(materialMap.entries())
    .map(([material, m]) => ({
      material,
      count: m.count,
      avgLow: m.count > 0 ? m.low / m.count : 0,
      avgHigh: m.count > 0 ? m.high / m.count : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const outcomeMap = new Map<string, number>();
  for (const c of calls) {
    const o = c.outcome ?? "unknown";
    outcomeMap.set(o, (outcomeMap.get(o) ?? 0) + 1);
  }
  const outcomeBreakdown: OutcomeAgg[] = Array.from(outcomeMap.entries())
    .map(([outcome, count]) => ({ outcome, count }))
    .sort((a, b) => b.count - a.count);

  const realHasData = leads.length + calls.length + (proposalsRes.count ?? 0) > 0;

  // If the office is completely empty, return demo data so analytics
  // shows a populated console. Real rows automatically take precedence
  // the moment they land in Supabase.
  if (!realHasData) {
    return {
      funnel: getDemoFunnel(officeSlug),
      callsByDay: getDemoCallsByDay(officeSlug),
      topMaterials: getDemoTopMaterials(officeSlug),
      outcomeBreakdown: getDemoOutcomes(officeSlug),
      totalCalls: getDemoTotalCalls(officeSlug),
      hasData: true,
    };
  }

  return {
    funnel,
    callsByDay,
    topMaterials,
    outcomeBreakdown,
    totalCalls: calls.length,
    hasData: true,
  };
}

export default async function AnalyticsPage() {
  const data = await load();
  const maxFunnel = Math.max(
    data.funnel.leads,
    data.funnel.calls,
    data.funnel.proposals,
    data.funnel.won,
    1,
  );
  const maxDay = Math.max(...data.callsByDay.map((d) => d.count), 1);
  const maxMat = Math.max(...data.topMaterials.map((m) => m.count), 1);

  return (
    <div className="flex flex-col gap-6 lg:gap-7">
      {/* HERO */}
      <header className="glass-panel-hero p-6 lg:p-8 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none opacity-50">
          <div className="absolute -top-24 right-10 w-[400px] h-[400px] rounded-full bg-cy-300/10 blur-[80px]" />
        </div>
        <div className="relative flex items-end justify-between gap-6 flex-wrap">
          <div>
            <div className="flex items-center gap-2.5 mb-3">
              <span className="glass-eyebrow">Analytics · Rolling 30 days</span>
              <span className="flex items-center gap-1.5 text-[10.5px] font-mono tabular text-mint/85 uppercase tracking-[0.14em]">
                <span className="w-1.5 h-1.5 rounded-full bg-mint shadow-[0_0_6px_rgba(95,227,176,0.55)] animate-pulse" />
                Live
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl lg:text-[34px] tracking-tight font-semibold leading-[1.1]">
              <span className="iridescent-text">Office performance.</span>
            </h1>
            <p className="text-[13.5px] text-white/60 mt-2 max-w-xl leading-relaxed">
              Rolling 30-day view of the Voxaris pipeline. Conversion funnel, Sydney call volume,
              materials mix, and outcome breakdown — auto-refreshes as new events land.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <KpiPill label="Pipeline" value={data.funnel.leads} accent="cy" />
            <KpiPill label="Won" value={data.funnel.won} accent="mint" />
          </div>
        </div>
      </header>

      {!data.hasData && (
        <div className="glass-panel p-7 lg:p-9 flex items-center gap-5">
          <div className="relative flex items-center justify-center flex-shrink-0">
            <span className="absolute w-16 h-16 rounded-full bg-mint/10 animate-ping" />
            <div className="relative w-14 h-14 rounded-2xl bg-mint/15 border border-mint/25 flex items-center justify-center shadow-[0_0_22px_-4px_rgba(95,227,176,0.55)]">
              <Radio className="w-5 h-5 text-mint" />
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] text-white/90 font-medium">Sydney is standing by.</div>
            <p className="text-[13px] text-white/55 max-w-2xl leading-relaxed mt-1">
              No activity in the rolling 30-day window for this office. The instant a customer
              hits <span className="font-mono text-white/75">pitch.voxaris.io/quote</span> or
              dials in, every panel below populates in real time.
            </p>
          </div>
          <span className="hidden lg:flex text-[10.5px] font-mono tabular text-mint/85 uppercase tracking-[0.16em] items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-mint shadow-[0_0_6px_rgba(95,227,176,0.55)] animate-pulse" />
            Listening
          </span>
        </div>
      )}

      {/* Funnel */}
      <section className="glass-panel p-6 lg:p-7">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <TrendingUp className="w-4 h-4 text-cy-300" />
            <h2 className="text-[15px] font-semibold tracking-tight">Conversion funnel</h2>
          </div>
          <span className="text-[10.5px] font-mono tabular text-white/40 uppercase tracking-[0.16em]">
            30-day
          </span>
        </div>
        <div className="flex flex-col gap-3">
          {[
            { label: "Leads", value: data.funnel.leads, tone: "cy" as const },
            { label: "Calls", value: data.funnel.calls, tone: "cy" as const },
            { label: "Proposals", value: data.funnel.proposals, tone: "amber" as const },
            { label: "Won", value: data.funnel.won, tone: "mint" as const },
          ].map((row) => (
            <div
              key={row.label}
              className="grid grid-cols-[110px_1fr_70px] items-center gap-4"
            >
              <div className="text-[12px] text-white/60 font-medium">{row.label}</div>
              <div className="h-8 rounded-xl bg-white/[0.025] border border-white/[0.05] overflow-hidden relative">
                <div
                  className={[
                    "absolute inset-y-0 left-0 rounded-xl transition-all duration-700",
                    row.tone === "cy"
                      ? "bg-gradient-to-r from-cy-300/30 to-cy-300/50 shadow-[0_0_18px_-4px_rgba(125,211,252,0.5)]"
                      : row.tone === "mint"
                        ? "bg-gradient-to-r from-mint/30 to-mint/55 shadow-[0_0_18px_-4px_rgba(95,227,176,0.55)]"
                        : "bg-gradient-to-r from-amber/30 to-amber/50 shadow-[0_0_18px_-4px_rgba(243,177,75,0.5)]",
                  ].join(" ")}
                  style={{ width: `${Math.max(2, (row.value / maxFunnel) * 100)}%` }}
                />
              </div>
              <div className="text-right font-mono tabular text-[15px] font-semibold text-white">
                {row.value}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Calls by day */}
      <section className="glass-panel p-6 lg:p-7">
        <div className="flex items-end justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <BarChart3 className="w-4 h-4 text-cy-300" />
            <h2 className="text-[15px] font-semibold tracking-tight">
              Sydney call volume
            </h2>
          </div>
          <div className="flex items-center gap-4 text-[10.5px] font-mono tabular uppercase tracking-[0.16em]">
            <span className="text-white/40">30-day</span>
            <span className="text-white/40">·</span>
            <span className="text-white/65">
              total{" "}
              <span className="text-white font-semibold tabular">{data.totalCalls}</span>
            </span>
          </div>
        </div>
        <div className="flex items-end gap-[3px] h-36">
          {data.callsByDay.map((d) => {
            const pct = (d.count / maxDay) * 100;
            return (
              <div
                key={d.day}
                title={`${d.day}: ${d.count}`}
                className="flex-1 rounded-t-md bg-gradient-to-t from-cy-300/30 to-cy-300/55 hover:from-cy-300/45 hover:to-cy-300/75 transition-all min-h-[3px] shadow-[0_0_8px_-2px_rgba(125,211,252,0.4)]"
                style={{ height: `${Math.max(3, pct)}%` }}
              />
            );
          })}
        </div>
        <div className="flex justify-between text-[10.5px] text-white/35 font-mono tabular mt-3 uppercase tracking-wider">
          <span>{data.callsByDay[0]?.day ?? ""}</span>
          <span>{data.callsByDay[data.callsByDay.length - 1]?.day ?? ""}</span>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 lg:gap-6">
        {/* Top materials */}
        <section className="glass-panel p-6 lg:p-7">
          <div className="flex items-center gap-2.5 mb-5">
            <Layers className="w-4 h-4 text-cy-300" />
            <h2 className="text-[15px] font-semibold tracking-tight">Top materials</h2>
          </div>
          {data.topMaterials.length === 0 ? (
            <MiniStandby copy="Materials populate as leads come through." />
          ) : (
            <div className="flex flex-col gap-3.5">
              {data.topMaterials.map((m) => (
                <div key={m.material} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[12.5px]">
                    <span className="text-white/85 font-medium">{m.material}</span>
                    <span className="font-mono tabular text-white/55">
                      {m.count} ·{" "}
                      <span className="text-white/75">
                        {fmtUSD(m.avgLow, 0)} – {fmtUSD(m.avgHigh, 0)}
                      </span>{" "}
                      avg
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-white/[0.04] overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-cy-300/40 to-cy-300/60 rounded-full shadow-[0_0_10px_-2px_rgba(125,211,252,0.5)]"
                      style={{ width: `${(m.count / maxMat) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Outcome breakdown */}
        <section className="glass-panel p-6 lg:p-7">
          <div className="flex items-center gap-2.5 mb-5">
            <Activity className="w-4 h-4 text-cy-300" />
            <h2 className="text-[15px] font-semibold tracking-tight">Sydney outcomes</h2>
          </div>
          {data.outcomeBreakdown.length === 0 ? (
            <MiniStandby copy="Outcome mix populates after Sydney's first calls." />
          ) : (
            <>
              <StackedBar items={data.outcomeBreakdown} total={data.totalCalls} />
              <ul className="flex flex-col gap-2 mt-5">
                {data.outcomeBreakdown.map((o) => {
                  const s = outcomeStyle(o.outcome);
                  const pct =
                    data.totalCalls > 0
                      ? ((o.count / data.totalCalls) * 100).toFixed(1)
                      : "0.0";
                  return (
                    <li
                      key={o.outcome}
                      className="flex items-center justify-between gap-2 text-[12px]"
                    >
                      <span className={`px-2.5 py-0.5 rounded-full border ${s.className}`}>
                        {s.label}
                      </span>
                      <span className="font-mono tabular text-white/65">
                        <span className="text-white/85">{o.count}</span> · {pct}%
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function KpiPill({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: "cy" | "mint";
}) {
  const color = accent === "mint" ? "text-mint" : "text-cy-300";
  const border = accent === "mint" ? "border-mint/25" : "border-cy-300/25";
  const bg = accent === "mint" ? "bg-mint/[0.07]" : "bg-cy-300/[0.07]";
  return (
    <div
      className={`flex items-baseline gap-2 px-3.5 py-2 rounded-2xl border ${border} ${bg} backdrop-blur-xl`}
    >
      <span className={`font-mono tabular text-[20px] font-semibold ${color}`}>{value}</span>
      <span className="text-[10.5px] font-mono tabular text-white/55 uppercase tracking-[0.14em]">
        {label}
      </span>
    </div>
  );
}

function MiniStandby({ copy }: { copy: string }) {
  return (
    <div className="flex items-center gap-3 py-4 px-3 rounded-2xl border border-white/[0.04] bg-white/[0.015]">
      <div className="relative flex items-center justify-center flex-shrink-0">
        <span className="absolute w-7 h-7 rounded-full bg-mint/10 animate-ping" />
        <div className="relative w-6 h-6 rounded-xl bg-mint/15 border border-mint/25 flex items-center justify-center">
          <Radio className="w-3 h-3 text-mint" />
        </div>
      </div>
      <span className="text-[12.5px] text-white/55">{copy}</span>
    </div>
  );
}

function StackedBar({ items, total }: { items: OutcomeAgg[]; total: number }) {
  if (total === 0) return null;
  return (
    <div className="h-3 w-full rounded-full overflow-hidden flex bg-white/[0.04] border border-white/[0.05]">
      {items.map((o) => {
        const pct = (o.count / total) * 100;
        const bg = colorForOutcome(o.outcome);
        return (
          <div
            key={o.outcome}
            style={{ width: `${pct}%`, backgroundColor: bg }}
            title={`${o.outcome}: ${o.count}`}
          />
        );
      })}
    </div>
  );
}

function colorForOutcome(outcome: string): string {
  const o = outcome.toLowerCase();
  if (o === "booked") return "rgba(95,227,176,0.6)";
  if (o === "transferred" || o === "transferred_to_human") return "rgba(103,220,255,0.6)";
  if (o.startsWith("cap_")) return "rgba(243,177,75,0.6)";
  if (o === "abandoned") return "rgba(255,122,138,0.6)";
  if (o === "wrong_number" || o === "no_show") return "rgba(255,255,255,0.2)";
  return "rgba(255,255,255,0.3)";
}
