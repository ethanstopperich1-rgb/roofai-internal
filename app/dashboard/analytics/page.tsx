import { BarChart3 } from "lucide-react";
import {
  daysAgoISO,
  fmtUSD,
  getDashboardOfficeId,
  getDashboardSupabase,
  outcomeStyle,
} from "@/lib/dashboard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface Funnel {
  leads: number;
  calls: number;
  proposals: number;
  won: number;
}

interface DayBucket {
  day: string; // YYYY-MM-DD
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
  const officeId = await getDashboardOfficeId();
  const supabase = await getDashboardSupabase();
  if (!officeId || !supabase) {
    return {
      funnel: { leads: 0, calls: 0, proposals: 0, won: 0 },
      callsByDay: [],
      topMaterials: [],
      outcomeBreakdown: [],
      totalCalls: 0,
      hasData: false,
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

  // Funnel
  const won = leads.filter((l) => l.status === "won").length;
  const funnel: Funnel = {
    leads: leads.length,
    calls: calls.length,
    proposals: proposalsRes.count ?? 0,
    won,
  };

  // Calls by day (last 30 days, dense)
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

  // Top materials
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

  // Outcome breakdown
  const outcomeMap = new Map<string, number>();
  for (const c of calls) {
    const o = c.outcome ?? "unknown";
    outcomeMap.set(o, (outcomeMap.get(o) ?? 0) + 1);
  }
  const outcomeBreakdown: OutcomeAgg[] = Array.from(outcomeMap.entries())
    .map(([outcome, count]) => ({ outcome, count }))
    .sort((a, b) => b.count - a.count);

  return {
    funnel,
    callsByDay,
    topMaterials,
    outcomeBreakdown,
    totalCalls: calls.length,
    hasData: leads.length + calls.length + (proposalsRes.count ?? 0) > 0,
  };
}

export default async function AnalyticsPage() {
  const data = await load();
  const maxFunnel = Math.max(data.funnel.leads, data.funnel.calls, data.funnel.proposals, data.funnel.won, 1);
  const maxDay = Math.max(...data.callsByDay.map((d) => d.count), 1);
  const maxMat = Math.max(...data.topMaterials.map((m) => m.count), 1);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <div className="glass-eyebrow mb-2 inline-flex">Analytics · 30 days</div>
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
          <span className="iridescent-text">Office performance</span>
        </h1>
        <p className="text-sm text-white/60 mt-1.5">
          Rolling 30-day view of the voxaris pipeline. Updates live.
        </p>
      </header>

      {!data.hasData ? (
        <div className="glass-panel p-10 flex flex-col items-center text-center gap-3">
          <BarChart3 className="w-8 h-8 text-cy-300" />
          <div className="text-lg font-semibold tracking-tight">No data in the last 30 days</div>
          <p className="text-sm text-white/60 max-w-md">
            Analytics populate automatically as leads come in and Sydney takes calls.
          </p>
        </div>
      ) : null}

      {/* Funnel */}
      <section className="glass-panel p-5 lg:p-6">
        <h2 className="text-base font-semibold tracking-tight mb-4">Conversion funnel</h2>
        <div className="flex flex-col gap-3">
          {[
            { label: "Leads", value: data.funnel.leads, tone: "cy" as const },
            { label: "Calls", value: data.funnel.calls, tone: "cy" as const },
            { label: "Proposals", value: data.funnel.proposals, tone: "amber" as const },
            { label: "Won", value: data.funnel.won, tone: "mint" as const },
          ].map((row) => (
            <div key={row.label} className="grid grid-cols-[100px_1fr_50px] items-center gap-3">
              <div className="text-xs text-white/65">{row.label}</div>
              <div className="h-7 rounded-md bg-white/[0.04] border border-white/[0.06] overflow-hidden relative">
                <div
                  className={[
                    "absolute inset-y-0 left-0 rounded-md transition-all",
                    row.tone === "cy" ? "bg-cy-300/30" : row.tone === "mint" ? "bg-mint/35" : "bg-amber/30",
                  ].join(" ")}
                  style={{ width: `${(row.value / maxFunnel) * 100}%` }}
                />
              </div>
              <div className="text-right font-mono tabular text-sm">{row.value}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Calls by day */}
      <section className="glass-panel p-5 lg:p-6">
        <div className="flex items-end justify-between mb-4">
          <h2 className="text-base font-semibold tracking-tight">Sydney call volume · 30 days</h2>
          <span className="text-[11px] font-mono tabular text-white/45">
            total {data.totalCalls}
          </span>
        </div>
        <div className="flex items-end gap-1 h-32">
          {data.callsByDay.map((d) => {
            const pct = (d.count / maxDay) * 100;
            return (
              <div
                key={d.day}
                title={`${d.day}: ${d.count}`}
                className="flex-1 rounded-t bg-cy-300/40 hover:bg-cy-300/60 transition-colors min-h-[2px]"
                style={{ height: `${Math.max(2, pct)}%` }}
              />
            );
          })}
        </div>
        <div className="flex justify-between text-[10px] text-white/40 font-mono tabular mt-2">
          <span>{data.callsByDay[0]?.day ?? ""}</span>
          <span>{data.callsByDay[data.callsByDay.length - 1]?.day ?? ""}</span>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top materials */}
        <section className="glass-panel p-5 lg:p-6">
          <h2 className="text-base font-semibold tracking-tight mb-4">Top materials</h2>
          {data.topMaterials.length === 0 ? (
            <div className="text-xs text-white/55">No materials selected yet.</div>
          ) : (
            <div className="flex flex-col gap-3">
              {data.topMaterials.map((m) => (
                <div key={m.material} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-white/85">{m.material}</span>
                    <span className="font-mono tabular text-white/55">
                      {m.count} · {fmtUSD(m.avgLow, 0)} – {fmtUSD(m.avgHigh, 0)} avg
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-white/[0.05] overflow-hidden">
                    <div
                      className="h-full bg-cy-300/50"
                      style={{ width: `${(m.count / maxMat) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Outcome breakdown */}
        <section className="glass-panel p-5 lg:p-6">
          <h2 className="text-base font-semibold tracking-tight mb-4">Sydney outcomes</h2>
          {data.outcomeBreakdown.length === 0 ? (
            <div className="text-xs text-white/55">No call outcomes recorded.</div>
          ) : (
            <>
              <StackedBar items={data.outcomeBreakdown} total={data.totalCalls} />
              <ul className="flex flex-col gap-2 mt-4">
                {data.outcomeBreakdown.map((o) => {
                  const s = outcomeStyle(o.outcome);
                  const pct = data.totalCalls > 0 ? ((o.count / data.totalCalls) * 100).toFixed(1) : "0.0";
                  return (
                    <li key={o.outcome} className="flex items-center justify-between gap-2 text-xs">
                      <span className={`px-2 py-0.5 rounded-full border ${s.className}`}>
                        {s.label}
                      </span>
                      <span className="font-mono tabular text-white/65">
                        {o.count} · {pct}%
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

function StackedBar({ items, total }: { items: OutcomeAgg[]; total: number }) {
  if (total === 0) return null;
  // Map outcome → tailwind bg via outcomeStyle's class string parser
  return (
    <div className="h-3 w-full rounded-full overflow-hidden flex bg-white/[0.05]">
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
  if (o === "booked") return "rgba(95,227,176,0.55)";
  if (o === "transferred" || o === "transferred_to_human") return "rgba(103,220,255,0.55)";
  if (o.startsWith("cap_")) return "rgba(243,177,75,0.55)";
  if (o === "abandoned") return "rgba(255,122,138,0.55)";
  if (o === "wrong_number" || o === "no_show") return "rgba(255,255,255,0.18)";
  return "rgba(255,255,255,0.25)";
}
