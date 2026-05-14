import { CloudHail } from "lucide-react";
import {
  getDashboardOfficeId,
  getDashboardOfficeSlug,
  getDashboardSupabase,
  type Lead,
} from "@/lib/dashboard";
import { getDemoLeads } from "@/lib/dashboard-demo-rows";
import CanvassView, {
  type CanvassRow,
  type CanvassStormEvent,
} from "@/components/dashboard/CanvassView";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Storm Canvass — the rep's working surface for pulling and filtering
 * the ranked door-knock list that storm-pulse + enrich_permits.py
 * produce.
 *
 * Flow:
 *   1. Server loads storm_events (left rail) + canvass_targets (table)
 *      scoped to the active office.
 *   2. Client CanvassView holds the filter state and renders the table.
 *      URL searchParams keep filters sticky across refresh.
 *
 * Empty-state path: when no storm_events exist yet (parcels migration
 * not applied, or storm-pulse hasn't fired), we surface a clear
 * "Run the cron to populate this" instructional empty state rather
 * than a broken-looking dashboard.
 */
async function load(): Promise<{
  events: CanvassStormEvent[];
  targets: CanvassRow[];
  isDemo: boolean;
}> {
  const [officeId, officeSlug, supabase] = await Promise.all([
    getDashboardOfficeId(),
    getDashboardOfficeSlug(),
    getDashboardSupabase(),
  ]);

  if (!officeId || !supabase) {
    return { events: [], targets: buildDemoTargets(officeSlug), isDemo: true };
  }

  // Real path: pull last 30 days of storm events for this office,
  // then their associated canvass_targets. Limit per-event so a huge
  // sweep doesn't blow the page render budget; the table supports
  // per-event drilldown via the left rail.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [stormRes, targetRes] = await Promise.all([
    supabase
      .from("storm_events")
      .select("*")
      .eq("office_id", officeId)
      .gte("event_date", since.slice(0, 10))
      .order("event_date", { ascending: false })
      .order("peak_inches", { ascending: false })
      .limit(50),
    supabase
      .from("canvass_targets")
      .select(
        "id, storm_event_id, address_line, city, zip, lat, lng, score, " +
          "distance_miles, status, contacted_at, " +
          "has_recent_roof_permit, last_permit_date, last_permit_type, " +
          "permit_checked_at, lead_id, created_at",
      )
      .eq("office_id", officeId)
      .order("score", { ascending: false })
      .limit(1000),
  ]);

  // Cast through unknown — the permit columns (has_recent_roof_permit,
  // last_permit_date, etc.) come from migration 0014 which post-dates
  // the generated supabase types. When types/supabase.ts is regenerated
  // these casts can be tightened.
  const events = (stormRes.data ?? []) as unknown as CanvassStormEvent[];
  const targets = (targetRes.data ?? []) as unknown as CanvassRow[];

  return { events, targets, isDemo: false };
}

/** Demo seed for offices without real Supabase data — uses existing
 *  demo leads to fabricate plausible canvass rows so the page reads
 *  as alive rather than empty on first open. */
function buildDemoTargets(slug: Parameters<typeof getDemoLeads>[0]): CanvassRow[] {
  const leads = getDemoLeads(slug);
  const today = new Date();
  // Demo scoring follows the hot-lead rubric so the demo rows read as
  // plausible canvass output:
  //   base = 1.00" hail × 10 × proximity_decay(0.1 + i*0.05 mi)
  //   + 50 for no-permit rows (3 of every 4)
  //   - 40 for the 4th row (recent permit on file)
  //   + 25 if we tag the row as 20yr+ (every other no-permit row)
  // This produces a believable score curve from ~60 down to ~−30
  // rather than a flat 60-2i ramp that didn't match the real rubric.
  return leads.slice(0, 12).map((l: Lead, i: number) => {
    const distanceMiles = 0.1 + i * 0.05;
    const base = 1.0 * 10 * (1 / (1 + distanceMiles));
    const hasRecentPermit = i % 4 === 0;
    const recencyBonus = hasRecentPermit ? -40 : 50;
    const ageBonus = !hasRecentPermit && i % 2 === 0 ? 25 : 0;
    const score = Math.round((base + recencyBonus + ageBonus) * 100) / 100;
    return {
      id: `demo-${i}`,
      storm_event_id: "demo-storm",
      address_line: l.address ?? "—",
      city: "OVIEDO",
      zip: l.zip ?? "32765",
      lat: l.lat ?? 28.67,
      lng: l.lng ?? -81.21,
      score,
      distance_miles: Math.round(distanceMiles * 1000) / 1000,
      status: "new",
      contacted_at: null,
      has_recent_roof_permit: hasRecentPermit,
      last_permit_date: hasRecentPermit ? "2019-04-12" : null,
      last_permit_type: hasRecentPermit ? "REROOF" : null,
      permit_checked_at: today.toISOString(),
      lead_id: l.id,
      created_at: today.toISOString(),
    };
  });
}

export default async function CanvassPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { events, targets, isDemo } = await load();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <div className="glass-eyebrow mb-2 inline-flex">Storm intelligence · Canvass</div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
            <span className="iridescent-text">Ranked canvass list</span>
          </h1>
          <p className="text-sm text-white/60 mt-1.5 max-w-2xl">
            Every storm-impacted, residential, in-radius address — scored against
            the hot-lead rubric (hail × proximity × roof age × permit recency).
            Filter, sort, export, knock.
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] font-mono tabular text-white/45">
          <div className="flex items-center gap-1.5">
            <CloudHail size={12} className="text-cy-300" aria-hidden />
            {events.length} {events.length === 1 ? "event" : "events"} · 30d
          </div>
          <span className="text-white/20">·</span>
          <div>{targets.length.toLocaleString()} targets</div>
        </div>
      </header>

      {targets.length === 0 && !isDemo ? (
        <EmptyState />
      ) : (
        <CanvassView
          events={events}
          rows={targets}
          isDemo={isDemo}
          initialEventId={typeof params.event === "string" ? params.event : null}
          initialPreset={typeof params.preset === "string" ? params.preset : null}
        />
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="glass-panel p-10 flex flex-col items-center text-center gap-3">
      <CloudHail className="w-8 h-8 text-cy-300" />
      <div className="text-lg font-semibold tracking-tight">No canvass targets yet</div>
      <p className="text-sm text-white/60 max-w-md leading-relaxed">
        Canvass targets are created automatically when{" "}
        <span className="text-cy-300 font-mono">/api/cron/storm-pulse</span>{" "}
        detects a qualifying storm (≥ 0.5&quot; hail) inside one of your watched
        regions. Trigger the cron manually or wait for the 06:00 UTC daily run.
      </p>
      <code className="mt-2 inline-block text-[11px] font-mono text-white/55 bg-white/[0.03] border border-white/[0.06] rounded-md px-3 py-1.5">
        curl -H &quot;Authorization: Bearer $CRON_SECRET&quot;
        https://pitch.voxaris.io/api/cron/storm-pulse
      </code>
    </div>
  );
}
