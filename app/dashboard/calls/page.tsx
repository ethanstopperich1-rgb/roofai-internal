import { PhoneCall } from "lucide-react";
import {
  getDashboardOfficeId,
  getDashboardOfficeSlug,
  getDashboardSupabase,
  type Call,
  type Event,
} from "@/lib/dashboard";
import { getDemoCalls, getDemoEventsByCall } from "@/lib/dashboard-demo-rows";
import CallsTable from "@/components/dashboard/CallsTable";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PAGE_SIZE = 50;

async function loadCalls(): Promise<{
  calls: Call[];
  eventsByCall: Record<string, Event[]>;
  configured: boolean;
}> {
  const officeSlug = await getDashboardOfficeSlug();
  const officeId = await getDashboardOfficeId();
  const supabase = await getDashboardSupabase();
  if (!officeId || !supabase) {
    // No Supabase wiring → per-office demo data so the inbox never
    // renders empty during a sales pitch. Real rows take over the
    // moment the office has a Sydney call land.
    return {
      calls: getDemoCalls(officeSlug),
      eventsByCall: getDemoEventsByCall(officeSlug),
      configured: false,
    };
  }

  const { data: calls } = await supabase
    .from("calls")
    .select("*")
    .eq("office_id", officeId)
    .order("started_at", { ascending: false })
    .limit(PAGE_SIZE);

  const callRows = calls ?? [];
  const callIds = callRows.map((c) => c.id);
  const eventsByCall: Record<string, Event[]> = {};

  if (callIds.length > 0) {
    const { data: events } = await supabase
      .from("events")
      .select("*")
      .eq("office_id", officeId)
      .in("call_id", callIds)
      .order("at", { ascending: true });
    for (const e of events ?? []) {
      if (!e.call_id) continue;
      (eventsByCall[e.call_id] ??= []).push(e);
    }
  }

  // If this office has zero live rows, return demo data so the pitch
  // shows a populated inbox. Real rows take over the moment a Sydney
  // call lands for this office.
  if (callRows.length === 0) {
    return {
      calls: getDemoCalls(officeSlug),
      eventsByCall: getDemoEventsByCall(officeSlug),
      configured: true,
    };
  }

  return { calls: callRows, eventsByCall, configured: true };
}

export default async function CallsPage() {
  const { calls, eventsByCall } = await loadCalls();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <div className="glass-eyebrow mb-2 inline-flex">Sydney · Call Inbox</div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
            <span className="iridescent-text">Inbound calls</span>
          </h1>
          <p className="text-sm text-white/60 mt-1.5">
            Every Sydney call, with transcript and event timeline. Newest first.
          </p>
        </div>
        <div className="flex items-center gap-2.5 text-[11px] font-mono tabular text-white/55">
          <span className="relative flex items-center justify-center">
            <span className="absolute w-2 h-2 rounded-full bg-mint/40 animate-ping" />
            <span className="relative w-1 h-1 rounded-full bg-mint shadow-[0_0_6px_rgba(95,227,176,0.55)]" />
          </span>
          <span className="uppercase tracking-[0.16em]">
            {calls.length} {calls.length === 1 ? "call" : "calls"} loaded
          </span>
        </div>
      </header>

      {calls.length === 0 ? (
        <div className="glass-panel p-10 flex flex-col items-center text-center gap-3">
          <PhoneCall className="w-8 h-8 text-cy-300" />
          <div className="text-lg font-semibold tracking-tight">Awaiting first call</div>
          <p className="text-sm text-white/60 max-w-md">
            Sydney calls will show up here once she takes her first one. Each row opens a drawer
            with the full transcript, event timeline, and cost breakdown.
          </p>
        </div>
      ) : (
        <CallsTable calls={calls} eventsByCall={eventsByCall} />
      )}
    </div>
  );
}
