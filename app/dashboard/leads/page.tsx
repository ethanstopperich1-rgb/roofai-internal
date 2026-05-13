import { Users } from "lucide-react";
import {
  getDashboardOfficeId,
  getDashboardOfficeSlug,
  getDashboardRole,
  getDashboardSupabase,
  getDashboardUser,
  isRepRole,
  type Lead,
  type Call,
  type Proposal,
} from "@/lib/dashboard";
import {
  getDemoCalls,
  getDemoLeads,
  getDemoProposals,
} from "@/lib/dashboard-demo-rows";
import LeadsTable from "@/components/dashboard/LeadsTable";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function buildDemoBundle(slug: Parameters<typeof getDemoLeads>[0]) {
  const leads = getDemoLeads(slug);
  const callsByLead: Record<string, Call[]> = {};
  const proposalsByLead: Record<string, Proposal[]> = {};
  for (const c of getDemoCalls(slug)) {
    if (!c.lead_id) continue;
    (callsByLead[c.lead_id] ??= []).push(c);
  }
  for (const p of getDemoProposals(slug)) {
    if (!p.lead_id) continue;
    (proposalsByLead[p.lead_id] ??= []).push(p);
  }
  return { leads, callsByLead, proposalsByLead };
}

async function loadLeads(): Promise<{
  leads: Lead[];
  callsByLead: Record<string, Call[]>;
  proposalsByLead: Record<string, Proposal[]>;
}> {
  const [officeSlug, officeId, supabase, role, user] = await Promise.all([
    getDashboardOfficeSlug(),
    getDashboardOfficeId(),
    getDashboardSupabase(),
    getDashboardRole(),
    getDashboardUser(),
  ]);
  if (!officeId || !supabase) {
    const bundle = buildDemoBundle(officeSlug);
    if (isRepRole(role)) {
      const repId = user?.id ?? `demo-rep-${officeSlug}`;
      bundle.leads = bundle.leads.filter((l) => l.assigned_to === repId);
    }
    return bundle;
  }

  let query = supabase
    .from("leads")
    .select("*")
    .eq("office_id", officeId);
  if (isRepRole(role) && user?.id) {
    query = query.eq("assigned_to", user.id);
  }
  const { data: leads } = await query
    .order("created_at", { ascending: false })
    .limit(200);
  const leadRows = leads ?? [];
  const ids = leadRows.map((l) => l.id);

  const callsByLead: Record<string, Call[]> = {};
  const proposalsByLead: Record<string, Proposal[]> = {};
  if (ids.length > 0) {
    const [callsRes, proposalsRes] = await Promise.all([
      supabase.from("calls").select("*").eq("office_id", officeId).in("lead_id", ids),
      supabase.from("proposals").select("*").eq("office_id", officeId).in("lead_id", ids),
    ]);
    for (const c of callsRes.data ?? []) {
      if (!c.lead_id) continue;
      (callsByLead[c.lead_id] ??= []).push(c);
    }
    for (const p of proposalsRes.data ?? []) {
      if (!p.lead_id) continue;
      (proposalsByLead[p.lead_id] ??= []).push(p);
    }
  }
  // No empty-fallback to demo here. The /demo surface gets demo
  // data via the earlier `!supabase` branch. On the real dashboard
  // with zero leads we render the "No leads yet" empty state instead
  // of fake rows that look like real customers.

  return { leads: leadRows, callsByLead, proposalsByLead };
}

export default async function LeadsPage() {
  const { leads, callsByLead, proposalsByLead } = await loadLeads();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <div className="glass-eyebrow mb-2 inline-flex">Pipeline · Leads</div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
            <span className="iridescent-text">Lead inbox</span>
          </h1>
          <p className="text-sm text-white/60 mt-1.5">
            Every submission from /quote and /embed. Status changes save instantly.
          </p>
        </div>
        <div className="text-xs text-white/45 font-mono tabular">
          {leads.length} {leads.length === 1 ? "lead" : "leads"}
        </div>
      </header>

      {leads.length === 0 ? (
        <div className="glass-panel p-10 flex flex-col items-center text-center gap-3">
          <Users className="w-8 h-8 text-cy-300" />
          <div className="text-lg font-semibold tracking-tight">No leads yet</div>
          <p className="text-sm text-white/60 max-w-md">
            Leads from /quote will appear here in real time. The first form submission for the
            voxaris office will land in this table within seconds.
          </p>
        </div>
      ) : (
        <LeadsTable
          leads={leads}
          callsByLead={callsByLead}
          proposalsByLead={proposalsByLead}
        />
      )}
    </div>
  );
}
