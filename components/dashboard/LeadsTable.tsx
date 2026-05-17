"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { X, ExternalLink, Loader2, Search } from "lucide-react";
import Link from "next/link";
import {
  LEAD_STATUSES,
  fmtDate,
  fmtDateTime,
  fmtLeadSource,
  fmtUSD,
  fmtDuration,
  outcomeStyle,
  statusStyle,
  type Call,
  type Lead,
  type LeadStatus,
  type Proposal,
} from "@/lib/dashboard-format";
import { summarizeProposalSnapshot, fmtMaterial } from "@/lib/proposal-snapshot";
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
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [query, setQuery] = useState<string>("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const sources = useMemo(() => {
    const s = new Set<string>();
    for (const l of leads) if (l.source) s.add(l.source);
    return Array.from(s).sort();
  }, [leads]);

  // Search normalizer — strip non-alphanumerics from phone before
  // comparing so "(321) 555-0148" matches "+13215550148" matches "5550148".
  const normalizedQuery = useMemo(() => query.trim().toLowerCase(), [query]);
  const normalizedPhoneQuery = useMemo(
    () => query.replace(/\D/g, ""),
    [query],
  );

  const filtered = useMemo(
    () =>
      leads.filter((l) => {
        if (statusFilter !== "all" && l.status !== statusFilter) return false;
        if (sourceFilter !== "all" && l.source !== sourceFilter) return false;
        if (!normalizedQuery) return true;
        const hay = [
          l.name,
          l.email,
          l.address,
          l.zip ?? "",
          l.county ?? "",
          l.notes ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (hay.includes(normalizedQuery)) return true;
        // Phone match — strip non-digits both sides so "(321)" matches "+1321..."
        if (normalizedPhoneQuery.length >= 3 && l.phone) {
          const leadPhoneDigits = l.phone.replace(/\D/g, "");
          if (leadPhoneDigits.includes(normalizedPhoneQuery)) return true;
        }
        return false;
      }),
    [leads, statusFilter, sourceFilter, normalizedQuery, normalizedPhoneQuery],
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
      {/* Filters + search */}
      <div className="glass-panel p-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/40 pointer-events-none" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email, phone, address"
            aria-label="Search leads"
            className="glass-input !py-1.5 !pl-9 !pr-3 text-xs w-full"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/80 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
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
          label="Source"
          value={sourceFilter}
          onChange={setSourceFilter}
          options={[
            { value: "all", label: "All sources" },
            ...sources.map((s) => ({ value: s, label: fmtLeadSource(s) })),
          ]}
        />
        <div className="text-[10.5px] font-mono tabular text-white/45 uppercase tracking-[0.16em] ml-auto px-2">
          {filtered.length} / {leads.length}
        </div>
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
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return; // ignore bubbled keys from the status <select>
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setOpenId(l.id);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open lead ${l.name}`}
                  className="border-b border-white/[0.04] last:border-b-0 cursor-pointer hover:bg-white/[0.03] focus:bg-white/[0.05] focus:outline-none focus-visible:ring-1 focus-visible:ring-cy-300/40 transition-colors"
                >
                  <td className="px-4 py-3 text-white/85 font-mono tabular text-[12.5px] whitespace-nowrap">
                    {fmtDate(l.created_at)}
                  </td>
                  <td className="px-4 py-3 text-white/90">
                    <span className="inline-flex items-center gap-1.5">
                      {l.name}
                      {l.roof_v3_json ? (
                        <span
                          title="Has Gemini V3 roof analysis (painted overlay + edges + material)"
                          className="text-[9px] uppercase tracking-[0.18em] px-1.5 py-0.5 rounded border border-[#38C5EE]/40 text-[#38C5EE]"
                        >
                          V3
                        </span>
                      ) : null}
                    </span>
                  </td>
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
                    {fmtLeadSource(l.source)}
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
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="Lead detail">
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

        {/* ─── Customer contact ─────────────────────────────────────── */}
        <section className="glass-panel p-4">
          <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-2">
            Customer
          </div>
          <dl className="grid grid-cols-1 gap-y-2 text-[12.5px]">
            <Row label="Name" value={lead.name} />
            <Row label="Email" value={lead.email} mono />
            <Row label="Phone" value={lead.phone ?? "—"} mono />
            <Row label="Source" value={fmtLeadSource(lead.source)} />
          </dl>
        </section>

        {/* ─── Property + directions ───────────────────────────────────
            Google Maps directions link mirrors the /estimate-v2 flow —
            rep can tap once and get turn-by-turn from their location to
            the customer's roof. Falls back to address-text routing when
            lat/lng aren't on the row. */}
        <section className="glass-panel p-4">
          <div className="flex items-baseline justify-between mb-2 gap-2">
            <div className="text-[10.5px] uppercase tracking-wider text-white/45">
              Property
            </div>
            <a
              href={
                lead.lat != null && lead.lng != null
                  ? `https://www.google.com/maps/dir/?api=1&destination=${lead.lat},${lead.lng}`
                  : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(lead.address)}`
              }
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10.5px] uppercase tracking-[0.18em] text-[#38C5EE] hover:text-white transition-colors inline-flex items-center gap-1"
            >
              Directions
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <dl className="grid grid-cols-1 gap-y-2 text-[12.5px]">
            <Row label="Address" value={lead.address} />
            <Row label="ZIP" value={lead.zip ?? "—"} mono />
            <Row label="County" value={lead.county ?? "—"} />
            {lead.lat != null && lead.lng != null ? (
              <Row
                label="Lat / Lng"
                mono
                value={`${lead.lat.toFixed(6)}, ${lead.lng.toFixed(6)}`}
              />
            ) : null}
          </dl>
        </section>

        {/* ─── Estimate range (legacy / rep-provided fields) ────────── */}
        {(lead.estimated_sqft != null ||
          lead.material ||
          lead.estimate_low != null) && (
          <section className="glass-panel p-4">
            <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-2">
              Estimate
            </div>
            <dl className="grid grid-cols-1 gap-y-2 text-[12.5px]">
              <Row label="Material" value={lead.material ?? "—"} />
              <Row
                label="Range"
                mono
                value={
                  lead.estimate_low != null && lead.estimate_high != null
                    ? `${fmtUSD(lead.estimate_low, 0)} – ${fmtUSD(lead.estimate_high, 0)}`
                    : "—"
                }
              />
              <Row
                label="Sqft"
                mono
                value={lead.estimated_sqft?.toLocaleString() ?? "—"}
              />
            </dl>
          </section>
        )}

        {/* ─── V3 ROOF ANALYSIS — mirrors /estimate-v2 panels ──────── */}
        {(() => {
          const v3 = lead.roof_v3_json as Record<string, unknown> | null;
          if (!v3 || typeof v3 !== "object") return null;

          const paintedUrl =
            typeof v3.painted_url === "string" ? v3.painted_url : null;
          const solar = (v3.solar ?? {}) as {
            sqft?: number | null;
            footprintSqft?: number | null;
            pitchDegrees?: number | null;
            segmentCount?: number;
            imageryQuality?: string | null;
            imageryDate?: string | null;
          };
          const correction = (v3.correction ?? null) as {
            applied?: boolean;
            reason?: string;
            solarRawSlopedSqft?: number;
            gisSource?: string | null;
            gisFootprintSqft?: number | null;
            slopeFactor?: number | null;
          } | null;
          const derived = (v3.derived ?? {}) as {
            stories?: number;
            estimatedAtticSqft?: number | null;
            predominantCompass?: string | null;
            complexity?: string;
          };
          const ga = (v3.geminiAnalysis ?? {}) as Record<string, unknown>;
          const mat = (ga.roofMaterial ?? null) as
            | { type?: string; confidence?: number }
            | null;
          const facetCountEstimate = (ga.facetCountEstimate ?? null) as
            | { count?: number; complexity?: string; confidence?: number }
            | null;
          const hints = Array.isArray(ga.conditionHints)
            ? (ga.conditionHints as Array<{ hint: string; confidence?: number }>)
            : [];
          const gemEdges = (v3.geminiEdges ?? null) as
            | {
                ridgesHipsLf?: number;
                valleysLf?: number;
                rakesLf?: number;
                eavesLf?: number;
                linesCount?: number;
              }
            | null;
          const solarEdges = (v3.edges ?? {}) as {
            ridgesHipsLf?: number | null;
            valleysLf?: number | null;
            rakesLf?: number | null;
            eavesLf?: number | null;
          };
          const facets = Array.isArray(v3.facets)
            ? (v3.facets as Array<{
                pitchDegrees: number;
                pitchOnTwelve?: string;
                azimuthDegrees?: number;
                compassDirection?: string;
                slopedSqft?: number;
                footprintSqft?: number;
              }>)
            : [];
          const objects = Array.isArray(v3.objects)
            ? (v3.objects as Array<{ type: string; confidence?: number }>)
            : [];
          const pen = (v3.penetrationTotals ?? null) as {
            count?: number;
            perimeterFt?: number;
            areaSqft?: number;
          } | null;
          const pot = (v3.solarPotential ?? null) as {
            maxPanels?: number | null;
            annualSunshineHours?: number | null;
          } | null;

          // Count rooftop objects by type for the chip row
          const objCounts: Record<string, number> = {};
          for (const o of objects) {
            objCounts[o.type] = (objCounts[o.type] ?? 0) + 1;
          }

          // Pick the most-trusted edges set: Gemini lines beat Solar
          // bbox geometry. Same rule as /estimate-v2.
          const solarVals = [
            solarEdges.ridgesHipsLf,
            solarEdges.valleysLf,
            solarEdges.rakesLf,
            solarEdges.eavesLf,
          ];
          const solarTotal = solarVals.reduce<number>(
            (a, v) => a + (v ?? 0),
            0,
          );
          const solarMax = Math.max(...solarVals.map((v) => v ?? 0));
          const solarLooksSane =
            solarTotal > 0 &&
            solarMax / solarTotal < 0.7 &&
            (solarEdges.eavesLf ?? 0) > 0;

          return (
            <>
              {/* Painted hero */}
              <section className="glass-panel p-4">
                <div className="flex items-baseline justify-between mb-3 gap-2">
                  <div className="text-[10.5px] uppercase tracking-wider text-white/45">
                    Roof V3 · Painted overlay
                  </div>
                  <span className="text-[10px] uppercase tracking-[0.18em] px-1.5 py-0.5 rounded border border-[#38C5EE]/40 text-[#38C5EE]">
                    V3
                  </span>
                </div>
                {paintedUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={paintedUrl}
                    alt={`Painted roof for ${lead.address}`}
                    className="w-full h-auto rounded-lg border border-white/[0.06]"
                  />
                ) : (
                  <div className="text-xs text-white/50">
                    Painted overlay unavailable for this lead.
                  </div>
                )}
              </section>

              {/* Headline measurements */}
              <section className="glass-panel p-4">
                <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
                  Headline measurements
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <DrawerStat
                    label="Sloped sqft"
                    value={solar.sqft?.toLocaleString() ?? "—"}
                    unit="ft²"
                  />
                  <DrawerStat
                    label="Pitch"
                    value={
                      solar.pitchDegrees != null
                        ? solar.pitchDegrees.toFixed(1)
                        : "—"
                    }
                    unit="°"
                  />
                  <DrawerStat
                    label="Segments"
                    value={String(solar.segmentCount ?? "—")}
                  />
                  <DrawerStat
                    label="Imagery"
                    value={solar.imageryQuality ?? "—"}
                  />
                </div>
                {correction?.applied ? (
                  <p className="text-[11px] text-[#38C5EE]/90 mt-3 leading-relaxed">
                    Headline corrected ·{" "}
                    {correction.gisSource?.toUpperCase()} footprint{" "}
                    {correction.gisFootprintSqft?.toLocaleString()} ft² ×
                    slope {correction.slopeFactor?.toFixed(3)} → Solar raw
                    was {correction.solarRawSlopedSqft?.toLocaleString()}{" "}
                    ft².
                  </p>
                ) : null}
              </section>

              {/* Anatomy — stories / attic / complexity / faces */}
              <section className="glass-panel p-4">
                <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
                  Roof anatomy
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <DrawerStat
                    label="Stories"
                    value={String(derived.stories ?? "—")}
                  />
                  <DrawerStat
                    label="Est. attic"
                    value={
                      derived.estimatedAtticSqft != null
                        ? derived.estimatedAtticSqft.toLocaleString()
                        : "—"
                    }
                    unit="ft²"
                  />
                  <DrawerStat
                    label="Complexity"
                    value={derived.complexity ?? "—"}
                  />
                  <DrawerStat
                    label="Faces"
                    value={derived.predominantCompass ?? "—"}
                  />
                </div>
              </section>

              {/* Edges — Gemini preferred, Solar fallback */}
              {(gemEdges || solarLooksSane) && (
                <section className="glass-panel p-4">
                  <div className="flex items-baseline justify-between mb-3 gap-2">
                    <div className="text-[10.5px] uppercase tracking-wider text-white/45">
                      Edge lengths
                    </div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">
                      {gemEdges
                        ? `Gemini · ${gemEdges.linesCount ?? 0} lines`
                        : "Solar geometry"}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <DrawerStat
                      label="Ridges + hips"
                      value={(
                        gemEdges?.ridgesHipsLf ??
                        solarEdges.ridgesHipsLf ??
                        0
                      ).toLocaleString()}
                      unit="ft"
                    />
                    <DrawerStat
                      label="Valleys"
                      value={(
                        gemEdges?.valleysLf ?? solarEdges.valleysLf ?? 0
                      ).toLocaleString()}
                      unit="ft"
                    />
                    <DrawerStat
                      label="Rakes"
                      value={(
                        gemEdges?.rakesLf ?? solarEdges.rakesLf ?? 0
                      ).toLocaleString()}
                      unit="ft"
                    />
                    <DrawerStat
                      label="Eaves"
                      value={(
                        gemEdges?.eavesLf ?? solarEdges.eavesLf ?? 0
                      ).toLocaleString()}
                      unit="ft"
                    />
                  </div>
                </section>
              )}

              {/* Material + condition hints */}
              <section className="glass-panel p-4">
                <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
                  Material &amp; condition
                </div>
                <dl className="grid grid-cols-1 gap-y-2 text-[12.5px]">
                  <Row
                    label="Material"
                    value={
                      mat?.type
                        ? `${mat.type.replace(/_/g, " ")}${
                            mat.confidence != null
                              ? ` (${Math.round(mat.confidence * 100)}%)`
                              : ""
                          }`
                        : "—"
                    }
                  />
                  <Row
                    label="Facets (Gemini est.)"
                    mono
                    value={
                      facetCountEstimate?.count != null
                        ? `${facetCountEstimate.count} · ${facetCountEstimate.complexity ?? ""}`
                        : "—"
                    }
                  />
                  <Row
                    label="Condition"
                    value={
                      hints.length === 0
                        ? "Clean"
                        : hints
                            .map((h) => h.hint?.replace(/_/g, " "))
                            .filter(Boolean)
                            .join(", ")
                    }
                  />
                </dl>
              </section>

              {/* Per-facet breakdown */}
              {facets.length > 0 && (
                <section className="glass-panel p-4">
                  <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
                    Per-facet breakdown · {facets.length} planes
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11.5px]">
                    {facets.map((f, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between gap-3 px-2.5 py-1.5 bg-white/[0.03] rounded border border-white/[0.05]"
                      >
                        <span className="font-mono text-white/65">
                          #{i + 1}
                        </span>
                        <span className="text-white/85">
                          {f.compassDirection ?? "—"}
                        </span>
                        <span className="font-mono text-white/65">
                          {f.pitchOnTwelve ?? `${f.pitchDegrees?.toFixed(1)}°`}
                        </span>
                        <span className="font-mono text-white/85">
                          {f.slopedSqft?.toLocaleString() ?? "—"} ft²
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Rooftop objects */}
              {Object.keys(objCounts).length > 0 && (
                <section className="glass-panel p-4">
                  <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
                    Rooftop objects · {objects.length} detected
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(objCounts).map(([t, n]) => (
                      <span
                        key={t}
                        className="text-[11px] px-2 py-0.5 rounded-full border border-white/[0.08] bg-white/[0.03] text-white/85"
                      >
                        {t.replace(/_/g, " ")} ·{" "}
                        <span className="font-mono">{n}</span>
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {/* Penetration totals */}
              {pen?.count != null && pen.count > 0 && (
                <section className="glass-panel p-4">
                  <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
                    Penetration totals
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <DrawerStat label="Count" value={String(pen.count)} />
                    <DrawerStat
                      label="Perimeter"
                      value={pen.perimeterFt?.toFixed(1) ?? "—"}
                      unit="ft"
                    />
                    <DrawerStat
                      label="Area"
                      value={pen.areaSqft?.toFixed(1) ?? "—"}
                      unit="ft²"
                    />
                  </div>
                </section>
              )}

              {/* Solar potential */}
              {pot && (pot.maxPanels != null || pot.annualSunshineHours != null) && (
                <section className="glass-panel p-4">
                  <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
                    Solar potential
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <DrawerStat
                      label="Max panels"
                      value={String(pot.maxPanels ?? "—")}
                    />
                    <DrawerStat
                      label="Annual sunshine"
                      value={
                        pot.annualSunshineHours != null
                          ? Math.round(pot.annualSunshineHours).toLocaleString()
                          : "—"
                      }
                      unit="hrs"
                    />
                  </div>
                </section>
              )}
            </>
          );
        })()}

        {/* ─── TCPA / consent ──────────────────────────────────────── */}
        <section className="glass-panel p-4">
          <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-2">
            TCPA consent
          </div>
          <dl className="grid grid-cols-1 gap-y-2 text-[12.5px]">
            <Row
              label="Status"
              value={
                lead.tcpa_consent
                  ? `Granted · ${fmtDateTime(lead.tcpa_consent_at)}`
                  : "Not granted"
              }
            />
            {lead.tcpa_consent && lead.tcpa_consent_text ? (
              <div>
                <dt className="text-[10.5px] uppercase tracking-wider text-white/40 mb-1">
                  Disclosure text
                </dt>
                <dd className="text-[11px] text-white/70 leading-relaxed bg-white/[0.02] border border-white/[0.05] rounded p-2.5 font-mono">
                  {lead.tcpa_consent_text}
                </dd>
              </div>
            ) : null}
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
                        {fmtDuration(c.duration_sec)}
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
            Saved estimates
          </div>
          {proposals.length === 0 ? (
            <div className="text-xs text-white/50">
              No estimates generated for this lead yet. Open the rep tool from the topbar
              and save one to pin it here.
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {proposals.map((p) => {
                const s = summarizeProposalSnapshot(p.snapshot);
                const total =
                  s.totalLow != null && s.totalHigh != null
                    ? `${fmtUSD(s.totalLow, 0)} – ${fmtUSD(s.totalHigh, 0)}`
                    : p.total_low != null && p.total_high != null
                      ? `${fmtUSD(p.total_low, 0)} – ${fmtUSD(p.total_high, 0)}`
                      : "—";
                return (
                  <li key={p.id} className="glass-panel p-3.5">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-white/92 truncate">
                          {fmtMaterial(s.material)}
                          {s.sqft && (
                            <span className="text-white/55 font-mono tabular text-[12px]">
                              {" · "}
                              {s.sqft.toLocaleString()} sqft
                            </span>
                          )}
                          {s.pitch && (
                            <span className="text-white/45 font-mono tabular text-[11px]">
                              {" · "}
                              {s.pitch}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-white/50 font-mono tabular mt-0.5">
                          {fmtDateTime(p.created_at)}
                          {s.staff && (
                            <>
                              <span className="text-white/25 mx-1">·</span>
                              by {s.staff}
                            </>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-[13px] font-mono tabular text-white/95 whitespace-nowrap">
                          {total}
                        </div>
                        {s.isInsuranceClaim && (
                          <div className="text-[10px] font-mono tabular text-amber uppercase tracking-wider mt-0.5">
                            Insurance
                          </div>
                        )}
                      </div>
                    </div>

                    {(s.addOnCount > 0 || s.lineItemCount > 0 || s.hasPhotos) && (
                      <div className="flex flex-wrap items-center gap-1.5 mb-2">
                        {s.addOnLabels.map((label) => (
                          <span
                            key={label}
                            className="chip-accent text-[10px] !px-2 !py-0.5"
                          >
                            {label}
                          </span>
                        ))}
                        {s.addOnCount > s.addOnLabels.length && (
                          <span className="text-[11px] text-white/45 font-mono tabular">
                            +{s.addOnCount - s.addOnLabels.length} add-ons
                          </span>
                        )}
                        {s.lineItemCount > 0 && (
                          <span className="text-[11px] text-white/55 font-mono tabular">
                            {s.lineItemCount} line items
                          </span>
                        )}
                        {s.hasPhotos && (
                          <span className="text-[11px] text-white/55 font-mono tabular">
                            {s.photoCount}{" "}
                            {s.photoCount === 1 ? "photo" : "photos"}
                          </span>
                        )}
                      </div>
                    )}

                    <div className="flex items-center justify-between text-[11px] gap-3 flex-wrap">
                      <span className="text-white/40 font-mono tabular">
                        {p.public_id.slice(0, 16)}…
                      </span>
                      <div className="flex items-center gap-3">
                        <Link
                          href={`/dashboard/proposals/${p.public_id}`}
                          className="text-cy-300 hover:text-white inline-flex items-center gap-1"
                        >
                          Rep view
                        </Link>
                        <span className="text-white/20">·</span>
                        <Link
                          href={`/p/${p.public_id}`}
                          target="_blank"
                          className="text-white/55 hover:text-white inline-flex items-center gap-1"
                        >
                          Customer link <ExternalLink className="w-3 h-3" />
                        </Link>
                      </div>
                    </div>
                  </li>
                );
              })}
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

/** Compact stat tile for the lead drawer — mirrors the /estimate-v2
 *  result panels so the dashboard reads like the customer-facing
 *  estimator. Keep visual rhythm tight: tiny eyebrow label, mono value,
 *  inline unit suffix. */
function DrawerStat({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.05] rounded-lg px-2.5 py-2">
      <div className="text-[9.5px] uppercase tracking-[0.14em] text-white/45 mb-1">
        {label}
      </div>
      <div className="font-mono tabular text-white/95 text-[13px] leading-tight">
        {value}
        {unit ? (
          <span className="text-white/45 text-[11px] ml-1">{unit}</span>
        ) : null}
      </div>
    </div>
  );
}
