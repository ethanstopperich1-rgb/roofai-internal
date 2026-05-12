"use client";

import { useMemo, useState, useTransition } from "react";
import { X, ExternalLink, Loader2 } from "lucide-react";
import Link from "next/link";
import {
  LEAD_STATUSES,
  fmtDate,
  fmtDateTime,
  fmtUSD,
  fmtDuration,
  outcomeStyle,
  statusStyle,
  type Call,
  type Lead,
  type LeadStatus,
  type Proposal,
} from "@/lib/dashboard";
import { updateLeadStatus } from "@/app/dashboard/leads/actions";

type StatusFilter = "all" | LeadStatus;

export default function LeadsTable({
  leads: initial,
  callsByLead,
  proposalsByLead,
}: {
  leads: Lead[];
  callsByLead: Record<string, Call[]>;
  proposalsByLead: Record<string, Proposal[]>;
}) {
  const [leads, setLeads] = useState(initial);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [materialFilter, setMaterialFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const materials = useMemo(() => {
    const s = new Set<string>();
    for (const l of leads) if (l.material) s.add(l.material);
    return Array.from(s).sort();
  }, [leads]);
  const sources = useMemo(() => {
    const s = new Set<string>();
    for (const l of leads) if (l.source) s.add(l.source);
    return Array.from(s).sort();
  }, [leads]);

  const filtered = useMemo(
    () =>
      leads.filter(
        (l) =>
          (statusFilter === "all" || l.status === statusFilter) &&
          (materialFilter === "all" || l.material === materialFilter) &&
          (sourceFilter === "all" || l.source === sourceFilter),
      ),
    [leads, statusFilter, materialFilter, sourceFilter],
  );

  const openLead = openId ? leads.find((l) => l.id === openId) ?? null : null;
  const openCalls = openId ? callsByLead[openId] ?? [] : [];
  const openProposals = openId ? proposalsByLead[openId] ?? [] : [];

  function applyStatus(leadId: string, status: LeadStatus) {
    setLeads((rows) => rows.map((r) => (r.id === leadId ? { ...r, status } : r)));
    startTransition(async () => {
      const res = await updateLeadStatus(leadId, status);
      if (!res.ok) {
        // revert on failure
        setLeads(initial);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="glass-panel p-3 flex flex-wrap items-center gap-2">
        <Select
          label="Status"
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as StatusFilter)}
          options={[
            { value: "all", label: "All statuses" },
            ...LEAD_STATUSES.map((s) => ({ value: s, label: statusStyle(s).label })),
          ]}
        />
        <Select
          label="Material"
          value={materialFilter}
          onChange={setMaterialFilter}
          options={[
            { value: "all", label: "All materials" },
            ...materials.map((m) => ({ value: m, label: m })),
          ]}
        />
        <Select
          label="Source"
          value={sourceFilter}
          onChange={setSourceFilter}
          options={[
            { value: "all", label: "All sources" },
            ...sources.map((s) => ({ value: s, label: s })),
          ]}
        />
      </div>

      {/* Table */}
      <div className="glass-panel p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-white/45 border-b border-white/[0.06]">
                <th className="text-left font-medium px-4 py-3">Date</th>
                <th className="text-left font-medium px-4 py-3">Name</th>
                <th className="text-left font-medium px-4 py-3 hidden md:table-cell">Address</th>
                <th className="text-right font-medium px-4 py-3">Estimate</th>
                <th className="text-left font-medium px-4 py-3 hidden lg:table-cell">Material</th>
                <th className="text-left font-medium px-4 py-3">Status</th>
                <th className="text-left font-medium px-4 py-3 hidden lg:table-cell">Source</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-white/55 text-sm">
                    No leads match these filters.
                  </td>
                </tr>
              )}
              {filtered.map((l) => (
                <tr
                  key={l.id}
                  onClick={() => setOpenId(l.id)}
                  className="border-b border-white/[0.04] last:border-b-0 cursor-pointer hover:bg-white/[0.03] transition-colors"
                >
                  <td className="px-4 py-3 text-white/85 font-mono tabular text-[12.5px] whitespace-nowrap">
                    {fmtDate(l.created_at)}
                  </td>
                  <td className="px-4 py-3 text-white/90">{l.name}</td>
                  <td className="px-4 py-3 text-white/65 text-[12.5px] hidden md:table-cell max-w-xs truncate">
                    {l.address}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular text-[12.5px] whitespace-nowrap">
                    {l.estimate_low != null && l.estimate_high != null
                      ? `${fmtUSD(l.estimate_low, 0)} – ${fmtUSD(l.estimate_high, 0)}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-white/65 text-[12.5px] hidden lg:table-cell">
                    {l.material ?? "—"}
                  </td>
                  <td
                    className="px-4 py-3"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <StatusChanger
                      status={l.status}
                      onChange={(s) => applyStatus(l.id, s)}
                    />
                  </td>
                  <td className="px-4 py-3 text-white/55 text-[12.5px] hidden lg:table-cell">
                    {l.source ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {openLead && (
        <LeadDrawer
          lead={openLead}
          calls={openCalls}
          proposals={openProposals}
          onClose={() => setOpenId(null)}
          onStatusChange={(s) => applyStatus(openLead.id, s)}
        />
      )}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-white/55">
      <span className="uppercase tracking-wider text-[10.5px]">{label}</span>
      <select
        className="glass-input !py-1.5 !px-2.5 text-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-[#0a1018]">
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatusChanger({
  status,
  onChange,
}: {
  status: string;
  onChange: (s: LeadStatus) => void;
}) {
  const style = statusStyle(status);
  const [pending, startTransition] = useTransition();
  return (
    <div className="relative inline-flex items-center">
      <select
        value={status}
        onChange={(e) => {
          const v = e.target.value as LeadStatus;
          startTransition(() => onChange(v));
        }}
        className={[
          "appearance-none cursor-pointer text-[11px] px-2.5 py-1 pr-6 rounded-full border font-medium",
          "focus:outline-none focus:ring-2 focus:ring-cy-300/40",
          style.className,
        ].join(" ")}
      >
        {LEAD_STATUSES.map((s) => (
          <option key={s} value={s} className="bg-[#0a1018] text-white">
            {statusStyle(s).label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-1.5 text-[9px] opacity-70">
        {pending ? <Loader2 className="w-3 h-3 animate-spin" /> : "▾"}
      </span>
    </div>
  );
}

function LeadDrawer({
  lead,
  calls,
  proposals,
  onClose,
  onStatusChange,
}: {
  lead: Lead;
  calls: Call[];
  proposals: Proposal[];
  onClose: () => void;
  onStatusChange: (s: LeadStatus) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <aside className="w-full max-w-[560px] h-full overflow-y-auto bg-[rgba(8,11,17,0.86)] backdrop-blur-2xl border-l border-white/[0.08] p-5 lg:p-6 flex flex-col gap-5">
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="glass-eyebrow inline-flex">Lead detail</div>
            <h2 className="text-lg font-semibold mt-2 tracking-tight">{lead.name}</h2>
            <div className="flex items-center gap-2 mt-1.5">
              <StatusChanger status={lead.status} onChange={onStatusChange} />
              <span className="text-[11px] text-white/45 font-mono tabular">
                {fmtDateTime(lead.created_at)}
              </span>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close drawer"
            onClick={onClose}
            className="glass-button-secondary !px-2.5 !py-1.5"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <section className="glass-panel p-4">
          <dl className="grid grid-cols-1 gap-y-2 text-[12.5px]">
            <Row label="Address" value={lead.address} />
            <Row label="Email" value={lead.email} mono />
            <Row label="Phone" value={lead.phone ?? "—"} mono />
            <Row label="Material" value={lead.material ?? "—"} />
            <Row
              label="Estimate"
              value={
                lead.estimate_low != null && lead.estimate_high != null
                  ? `${fmtUSD(lead.estimate_low, 0)} – ${fmtUSD(lead.estimate_high, 0)}`
                  : "—"
              }
              mono
            />
            <Row label="Sqft" value={lead.estimated_sqft?.toLocaleString() ?? "—"} mono />
            <Row label="Source" value={lead.source ?? "—"} />
            <Row label="ZIP" value={lead.zip ?? "—"} mono />
            <Row label="County" value={lead.county ?? "—"} />
            <Row
              label="TCPA consent"
              value={lead.tcpa_consent ? `Yes · ${fmtDateTime(lead.tcpa_consent_at)}` : "No"}
            />
          </dl>
        </section>

        {lead.notes && (
          <section className="glass-panel p-4">
            <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-2">Notes</div>
            <p className="text-sm text-white/85 leading-relaxed whitespace-pre-wrap">{lead.notes}</p>
          </section>
        )}

        <section>
          <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-2">
            Linked Sydney calls
          </div>
          {calls.length === 0 ? (
            <div className="text-xs text-white/50">No calls linked to this lead.</div>
          ) : (
            <ul className="flex flex-col gap-2">
              {calls.map((c) => {
                const s = outcomeStyle(c.outcome);
                return (
                  <li key={c.id} className="glass-panel p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-mono tabular text-white/85">
                        {fmtDateTime(c.started_at)}
                      </div>
                      <div className="text-[11px] text-white/55 font-mono tabular">
                        {fmtDuration(c.duration_sec)} · {fmtUSD(c.estimated_cost_usd)}
                      </div>
                    </div>
                    <span className={`text-[11px] px-2 py-0.5 rounded-full border ${s.className}`}>
                      {s.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section>
          <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-2">
            Linked proposals
          </div>
          {proposals.length === 0 ? (
            <div className="text-xs text-white/50">No proposals generated for this lead yet.</div>
          ) : (
            <ul className="flex flex-col gap-2">
              {proposals.map((p) => (
                <li key={p.id} className="glass-panel p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-mono tabular text-white/85">
                      {fmtDateTime(p.created_at)}
                    </div>
                    <div className="text-[11px] text-white/55 font-mono tabular">
                      {p.total_low != null && p.total_high != null
                        ? `${fmtUSD(p.total_low, 0)} – ${fmtUSD(p.total_high, 0)}`
                        : "—"}
                    </div>
                  </div>
                  <Link
                    href={`/p/${p.public_id}`}
                    target="_blank"
                    className="text-xs text-cy-300 hover:text-white inline-flex items-center gap-1"
                  >
                    Open <ExternalLink className="w-3 h-3" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3">
      <dt className="text-white/45">{label}</dt>
      <dd className={["text-white/90 break-words", mono ? "font-mono tabular" : ""].join(" ")}>
        {value}
      </dd>
    </div>
  );
}
