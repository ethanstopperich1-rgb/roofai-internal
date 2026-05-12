import Link from "next/link";
import { FileText, ExternalLink } from "lucide-react";
import {
  fmtDate,
  fmtUSD,
  getDashboardOfficeId,
  getDashboardSupabase,
  type Lead,
  type Proposal,
} from "@/lib/dashboard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function load(): Promise<{ rows: Array<Proposal & { lead?: Lead | null }> }> {
  const officeId = await getDashboardOfficeId();
  const supabase = getDashboardSupabase();
  if (!officeId || !supabase) return { rows: [] };

  const { data: proposals } = await supabase
    .from("proposals")
    .select("*")
    .eq("office_id", officeId)
    .order("created_at", { ascending: false })
    .limit(200);
  const rows = proposals ?? [];

  const leadIds = Array.from(new Set(rows.map((p) => p.lead_id).filter((v): v is string => !!v)));
  const leadsById: Record<string, Lead> = {};
  if (leadIds.length > 0) {
    const { data: leads } = await supabase
      .from("leads")
      .select("*")
      .eq("office_id", officeId)
      .in("id", leadIds);
    for (const l of leads ?? []) leadsById[l.id] = l;
  }

  return {
    rows: rows.map((p) => ({ ...p, lead: p.lead_id ? leadsById[p.lead_id] ?? null : null })),
  };
}

export default async function ProposalsPage() {
  const { rows } = await load();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <div className="glass-eyebrow mb-2 inline-flex">Output · Proposals</div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
            <span className="iridescent-text">Generated proposals</span>
          </h1>
          <p className="text-sm text-white/60 mt-1.5">
            Public proposal links saved from the rep tool. Click to open the customer view.
          </p>
        </div>
        <div className="text-xs text-white/45 font-mono tabular">
          {rows.length} {rows.length === 1 ? "proposal" : "proposals"}
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="glass-panel p-10 flex flex-col items-center text-center gap-3">
          <FileText className="w-8 h-8 text-cy-300" />
          <div className="text-lg font-semibold tracking-tight">No proposals yet</div>
          <p className="text-sm text-white/60 max-w-md">
            Generated proposals will appear here. Hit{" "}
            <span className="text-cy-300">Output → Save Proposal</span> in the rep tool to publish
            the first one.
          </p>
        </div>
      ) : (
        <div className="glass-panel p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-white/45 border-b border-white/[0.06]">
                  <th className="text-left font-medium px-4 py-3">Date</th>
                  <th className="text-left font-medium px-4 py-3">Lead</th>
                  <th className="text-right font-medium px-4 py-3">Total range</th>
                  <th className="text-left font-medium px-4 py-3 hidden lg:table-cell">PDF</th>
                  <th className="text-right font-medium px-4 py-3">Link</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-b border-white/[0.04] last:border-b-0">
                    <td className="px-4 py-3 text-white/85 font-mono tabular text-[12.5px] whitespace-nowrap">
                      {fmtDate(p.created_at)}
                    </td>
                    <td className="px-4 py-3 text-white/90">
                      {p.lead?.name ?? <span className="text-white/40">—</span>}
                      {p.lead?.address && (
                        <div className="text-[11px] text-white/45 truncate max-w-xs">
                          {p.lead.address}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular text-[12.5px] whitespace-nowrap">
                      {p.total_low != null && p.total_high != null
                        ? `${fmtUSD(p.total_low, 0)} – ${fmtUSD(p.total_high, 0)}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      {p.pdf_url ? (
                        <span className="text-[11px] text-mint">Ready</span>
                      ) : (
                        <span className="text-[11px] text-white/45">Pending</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/p/${p.public_id}`}
                        target="_blank"
                        className="inline-flex items-center gap-1 text-xs text-cy-300 hover:text-white"
                      >
                        Open <ExternalLink className="w-3 h-3" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
