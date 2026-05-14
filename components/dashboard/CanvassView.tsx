"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CloudHail,
  Download,
  Flame,
  Home,
  ShieldOff,
  MapPin,
  Calendar,
  X,
  Map as MapIcon,
  List,
  CheckSquare,
  Square,
  PhoneOutgoing,
  CircleCheck,
} from "lucide-react";
import { fmtDateTime } from "@/lib/dashboard";
import CanvassMap from "./CanvassMap";

/**
 * Storm Canvass — primary rep working surface.
 *
 * Layout: left rail = storm events (multi-select to scope the table),
 * main column = filter chips + ranked table + CSV export.
 *
 * Filtering is in-memory because canvass volumes per office cap around
 * 5,000 rows (worst case: an active storm season with no rep working
 * the queue). Above that we'd push filtering server-side via the
 * canvass_filter RPC; below that, client-side stays snappier with no
 * round-trips on chip toggles.
 */

export interface CanvassStormEvent {
  id: string;
  region_name: string;
  center_lat: number;
  center_lng: number;
  radius_miles: number;
  event_date: string;
  peak_inches: number;
  hit_count: number;
}

export interface CanvassRow {
  id: string;
  storm_event_id: string;
  address_line: string | null;
  city: string | null;
  zip: string | null;
  lat: number;
  lng: number;
  score: number;
  distance_miles: number | null;
  status: string;
  contacted_at: string | null;
  has_recent_roof_permit: boolean | null;
  last_permit_date: string | null;
  last_permit_type: string | null;
  permit_checked_at: string | null;
  lead_id: string | null;
  created_at: string;
  // Skip-traced contact data (migration 0015)
  phone_number?: string | null;
  phone_source?: string | null;
  phone_match_confidence?: "high" | "medium" | "low" | null;
  phone_checked_at?: string | null;
  // Outcome capture (migration 0016) — denormalized from canvass_outcomes
  // by the sync trigger, drives the rep dashboard's funnel sort.
  latest_outcome?: string | null;
  latest_outcome_at?: string | null;
  won_revenue_cents?: number | null;
}

type SortKey = "score" | "distance" | "address" | "permit";

interface Filters {
  preset: "hot" | "all" | "contacted" | "needs-check";
  minHail: number; // inches
  maxDistance: number; // miles
  noPermitOnly: boolean;
  eventIds: Set<string>;
}

const DEFAULT_FILTERS: Filters = {
  preset: "hot",
  minHail: 0.5,
  maxDistance: 10,
  noPermitOnly: false,
  eventIds: new Set(),
};

export default function CanvassView({
  events,
  rows,
  isDemo,
  initialEventId,
  initialPreset,
}: {
  events: CanvassStormEvent[];
  rows: CanvassRow[];
  isDemo: boolean;
  initialEventId: string | null;
  initialPreset: string | null;
}) {
  const [filters, setFilters] = useState<Filters>(() => ({
    ...DEFAULT_FILTERS,
    preset:
      initialPreset === "all" ||
      initialPreset === "contacted" ||
      initialPreset === "needs-check"
        ? initialPreset
        : "hot",
    eventIds: initialEventId ? new Set([initialEventId]) : new Set(),
  }));
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "score",
    dir: "desc",
  });
  const [drawerRow, setDrawerRow] = useState<CanvassRow | null>(null);
  const [view, setView] = useState<"table" | "map">("table");
  // Row selection — Set of canvass_target ids. Drives the bulk-action
  // bar that slides up from the bottom when ≥1 row is selected.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleRow = useCallback((id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const eventsById = useMemo(() => {
    const m = new Map<string, CanvassStormEvent>();
    for (const e of events) m.set(e.id, e);
    return m;
  }, [events]);

  // ─── Apply filters + sort ────────────────────────────────────────
  const filtered = useMemo(() => {
    let out = rows.slice();

    // Event scope
    if (filters.eventIds.size > 0) {
      out = out.filter((r) => filters.eventIds.has(r.storm_event_id));
    }

    // Hail floor — looked up via the storm event the row was created from
    out = out.filter((r) => {
      const ev = eventsById.get(r.storm_event_id);
      if (!ev) return true; // demo / orphan rows pass through
      return ev.peak_inches >= filters.minHail;
    });

    // Distance ceiling
    out = out.filter(
      (r) => r.distance_miles == null || r.distance_miles <= filters.maxDistance,
    );

    // Permit filter
    if (filters.noPermitOnly) {
      out = out.filter((r) => r.has_recent_roof_permit === false);
    }

    // Preset overrides — apply on top of explicit filters
    if (filters.preset === "hot") {
      out = out.filter(
        (r) => r.has_recent_roof_permit === false && r.status === "new",
      );
    } else if (filters.preset === "contacted") {
      out = out.filter((r) => r.status === "contacted" || r.contacted_at != null);
    } else if (filters.preset === "needs-check") {
      out = out.filter((r) => r.permit_checked_at == null);
    }

    // Sort
    out.sort((a, b) => {
      const m = sort.dir === "asc" ? 1 : -1;
      switch (sort.key) {
        case "score":
          return m * (a.score - b.score);
        case "distance":
          return m * ((a.distance_miles ?? 99) - (b.distance_miles ?? 99));
        case "address":
          return m * (a.address_line ?? "").localeCompare(b.address_line ?? "");
        case "permit": {
          const av = a.has_recent_roof_permit === false ? 0 : a.has_recent_roof_permit === true ? 1 : 2;
          const bv = b.has_recent_roof_permit === false ? 0 : b.has_recent_roof_permit === true ? 1 : 2;
          return m * (av - bv);
        }
      }
    });

    return out;
  }, [rows, filters, sort, eventsById]);

  const downloadCsv = () => {
    const headers = [
      "rank",
      "address",
      "city",
      "zip",
      "score",
      "distance_miles",
      "hail_inches",
      "event_date",
      "has_recent_roof_permit",
      "last_permit_date",
      "last_permit_type",
      "status",
    ];
    const lines: string[] = [headers.join(",")];
    filtered.forEach((r, i) => {
      const ev = eventsById.get(r.storm_event_id);
      const cells = [
        i + 1,
        csvCell(r.address_line),
        csvCell(r.city),
        csvCell(r.zip),
        r.score.toFixed(2),
        r.distance_miles?.toFixed(2) ?? "",
        ev?.peak_inches?.toFixed(2) ?? "",
        ev?.event_date ?? "",
        r.has_recent_roof_permit == null ? "" : r.has_recent_roof_permit ? "true" : "false",
        r.last_permit_date ?? "",
        csvCell(r.last_permit_type),
        r.status,
      ];
      lines.push(cells.join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `canvass-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="grid lg:grid-cols-[280px_1fr] gap-6">
      {/* ─── Left rail: storm events ────────────────────────────────── */}
      <aside className="flex flex-col gap-3">
        <div className="text-[10.5px] uppercase tracking-[0.16em] text-white/45 font-mono">
          Storm events · 30d
        </div>
        {events.length === 0 ? (
          <div className="glass-panel p-4 text-[12px] text-white/55">
            No detected events. Once storm-pulse fires, events appear here.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {events.map((e) => {
              const active = filters.eventIds.has(e.id);
              const targetCount = rows.filter((r) => r.storm_event_id === e.id).length;
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setFilters((f) => {
                        const next = new Set(f.eventIds);
                        if (next.has(e.id)) next.delete(e.id);
                        else next.add(e.id);
                        return { ...f, eventIds: next };
                      });
                    }}
                    className={[
                      "w-full text-left rounded-xl border p-3 transition-colors",
                      active
                        ? "border-cy-300/40 bg-cy-300/[0.06]"
                        : "border-white/[0.06] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]",
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span
                        className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${active ? "text-cy-300" : "text-white"}`}
                      >
                        <CloudHail size={11} aria-hidden />
                        {e.region_name}
                      </span>
                      <span className="font-mono tabular text-[11px] text-white/55">
                        {e.peak_inches.toFixed(2)}&quot;
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[10.5px] text-white/45 font-mono tabular">
                      <span>{e.event_date}</span>
                      <span>{targetCount} targets</span>
                    </div>
                  </button>
                </li>
              );
            })}
            {filters.eventIds.size > 0 && (
              <li>
                <button
                  type="button"
                  onClick={() =>
                    setFilters((f) => ({ ...f, eventIds: new Set() }))
                  }
                  className="w-full text-[11px] text-white/55 hover:text-white inline-flex items-center justify-center gap-1.5 py-1.5"
                >
                  <X size={11} /> Clear event filter
                </button>
              </li>
            )}
          </ul>
        )}
      </aside>

      {/* ─── Main column ────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4">
        {isDemo && (
          <div className="rounded-xl border border-amber/30 bg-amber/[0.05] px-3 py-2 text-[11.5px] text-amber/90 inline-flex items-center gap-2">
            <span className="font-mono uppercase tracking-wider text-[9.5px]">Demo</span>
            Showing fabricated rows. Real canvass appears once storm-pulse fires
            on a live Supabase office.
          </div>
        )}

        {/* Presets + filter chips */}
        <div className="glass-panel p-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <PresetChip
              active={filters.preset === "hot"}
              onClick={() => setFilters((f) => ({ ...f, preset: "hot" }))}
              icon={<Flame size={12} aria-hidden />}
              label="Hot leads"
              hint="No roof permit + new"
            />
            <PresetChip
              active={filters.preset === "all"}
              onClick={() => setFilters((f) => ({ ...f, preset: "all" }))}
              icon={<Home size={12} aria-hidden />}
              label="All targets"
            />
            <PresetChip
              active={filters.preset === "needs-check"}
              onClick={() => setFilters((f) => ({ ...f, preset: "needs-check" }))}
              icon={<ShieldOff size={12} aria-hidden />}
              label="Permit unchecked"
            />
            <PresetChip
              active={filters.preset === "contacted"}
              onClick={() => setFilters((f) => ({ ...f, preset: "contacted" }))}
              icon={<Calendar size={12} aria-hidden />}
              label="Already contacted"
            />
            <div className="flex-1" />
            <ViewToggle view={view} onChange={setView} />
            <button
              type="button"
              onClick={downloadCsv}
              disabled={filtered.length === 0}
              className="glass-button-secondary inline-flex items-center gap-1.5 !py-1.5 active:translate-y-[1px] transition-transform"
            >
              <Download size={13} /> Export {filtered.length}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[12px]">
            <label className="inline-flex items-center gap-2 text-white/65">
              <span className="text-[10.5px] uppercase tracking-wider text-white/45 font-mono">
                Min hail
              </span>
              <select
                value={filters.minHail}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, minHail: Number(e.target.value) }))
                }
                className="glass-input !py-1 !px-2 !text-[12px]"
              >
                {[0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0].map((v) => (
                  <option key={v} value={v}>
                    {v.toFixed(2)}&quot;
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-flex items-center gap-2 text-white/65">
              <span className="text-[10.5px] uppercase tracking-wider text-white/45 font-mono">
                Within
              </span>
              <select
                value={filters.maxDistance}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, maxDistance: Number(e.target.value) }))
                }
                className="glass-input !py-1 !px-2 !text-[12px]"
              >
                {[1, 2, 3, 5, 10, 20].map((v) => (
                  <option key={v} value={v}>
                    {v} mi
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-flex items-center gap-1.5 text-white/65 cursor-pointer">
              <input
                type="checkbox"
                checked={filters.noPermitOnly}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, noPermitOnly: e.target.checked }))
                }
                className="w-3.5 h-3.5 accent-cy-300"
              />
              No roof permit only
            </label>
          </div>
        </div>

        {view === "map" ? (
          <CanvassMap
            rows={filtered}
            events={events.filter(
              (e) => filters.eventIds.size === 0 || filters.eventIds.has(e.id),
            )}
            onSelectRow={(r) => setDrawerRow(r)}
            selectedRowId={drawerRow?.id ?? null}
          />
        ) : (
          /* Table */
          <div className="glass-panel p-0 overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-white/45 border-b border-white/[0.06]">
                    <th className="px-3 py-2.5 w-10">
                      <BulkSelectHeader
                        rowIds={filtered.slice(0, 500).map((r) => r.id)}
                        selected={selected}
                        setSelected={setSelected}
                      />
                    </th>
                    <th className="text-right font-medium px-3 py-2.5 w-12">#</th>
                    <ThSortable
                      label="Address"
                      sortKey="address"
                      sort={sort}
                      onSort={setSort}
                    />
                    <th className="text-left font-medium px-3 py-2.5 hidden md:table-cell">
                      Hail
                    </th>
                    <ThSortable
                      label="Distance"
                      sortKey="distance"
                      sort={sort}
                      onSort={setSort}
                      align="right"
                    />
                    <ThSortable
                      label="Permit"
                      sortKey="permit"
                      sort={sort}
                      onSort={setSort}
                    />
                    <ThSortable
                      label="Score"
                      sortKey="score"
                      sort={sort}
                      onSort={setSort}
                      align="right"
                    />
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-4 py-10 text-center text-white/55 text-sm"
                      >
                        No targets match these filters. Loosen the hail floor
                        or switch presets.
                      </td>
                    </tr>
                  )}
                  {filtered.slice(0, 500).map((r, i) => {
                    const ev = eventsById.get(r.storm_event_id);
                    const isSelected = selected.has(r.id);
                    return (
                      <tr
                        key={r.id}
                        className={[
                          "border-b border-white/[0.04] last:border-b-0 transition-colors",
                          isSelected
                            ? "bg-cy-300/[0.04]"
                            : "hover:bg-white/[0.03]",
                        ].join(" ")}
                      >
                        <td
                          className="px-3 py-2.5 cursor-pointer"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleRow(r.id);
                          }}
                        >
                          {isSelected ? (
                            <CheckSquare
                              size={14}
                              className="text-cy-300"
                              aria-label="Selected"
                            />
                          ) : (
                            <Square
                              size={14}
                              className="text-white/35 hover:text-white/85 transition-colors"
                              aria-label="Select row"
                            />
                          )}
                        </td>
                        <td
                          className="px-3 py-2.5 text-right font-mono tabular text-[12px] text-white/55 cursor-pointer"
                          onClick={() => setDrawerRow(r)}
                        >
                          {i + 1}
                        </td>
                        <td
                          className="px-3 py-2.5 cursor-pointer"
                          onClick={() => setDrawerRow(r)}
                        >
                          <div className="text-[13px] text-white/95 font-medium">
                            {r.address_line ?? "—"}
                          </div>
                          <div className="text-[10.5px] text-white/45 font-mono tabular">
                            {r.city ?? "—"} · {r.zip ?? "—"}
                          </div>
                        </td>
                        <td
                          className="px-3 py-2.5 hidden md:table-cell font-mono tabular text-[12.5px] cursor-pointer"
                          onClick={() => setDrawerRow(r)}
                        >
                          {ev ? `${ev.peak_inches.toFixed(2)}"` : "—"}
                          {ev && (
                            <div className="text-[10px] text-white/45">
                              {ev.event_date}
                            </div>
                          )}
                        </td>
                        <td
                          className="px-3 py-2.5 text-right font-mono tabular text-[12.5px] text-white/85 cursor-pointer"
                          onClick={() => setDrawerRow(r)}
                        >
                          {r.distance_miles?.toFixed(2) ?? "—"}
                        </td>
                        <td
                          className="px-3 py-2.5 cursor-pointer"
                          onClick={() => setDrawerRow(r)}
                        >
                          <PermitChip row={r} />
                        </td>
                        <td
                          className="px-3 py-2.5 text-right font-mono tabular text-[13px] font-medium cursor-pointer"
                          onClick={() => setDrawerRow(r)}
                        >
                          <ScorePill score={r.score} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filtered.length > 500 && (
              <div className="text-[11px] text-white/45 font-mono tabular text-center py-2">
                Showing top 500 of {filtered.length.toLocaleString()}. Tighten
                filters or export CSV for the full list.
              </div>
            )}
          </div>
        )}
      </div>

      {drawerRow && (
        <RowDrawer
          row={drawerRow}
          event={eventsById.get(drawerRow.storm_event_id) ?? null}
          onClose={() => setDrawerRow(null)}
        />
      )}

      {selected.size > 0 && (
        <BulkActionBar
          count={selected.size}
          onClear={() => setSelected(new Set())}
          onExport={() => {
            // Export only the selected rows
            const selectedRows = filtered.filter((r) => selected.has(r.id));
            exportRowsAsCsv(selectedRows, eventsById);
          }}
        />
      )}
    </div>
  );
}

function exportRowsAsCsv(
  rows: CanvassRow[],
  eventsById: Map<string, CanvassStormEvent>,
) {
  const headers = [
    "rank",
    "address",
    "city",
    "zip",
    "score",
    "distance_miles",
    "hail_inches",
    "event_date",
    "has_recent_roof_permit",
    "last_permit_date",
    "last_permit_type",
    "status",
  ];
  const lines: string[] = [headers.join(",")];
  rows.forEach((r, i) => {
    const ev = eventsById.get(r.storm_event_id);
    lines.push(
      [
        i + 1,
        csvCell(r.address_line),
        csvCell(r.city),
        csvCell(r.zip),
        r.score.toFixed(2),
        r.distance_miles?.toFixed(2) ?? "",
        ev?.peak_inches?.toFixed(2) ?? "",
        ev?.event_date ?? "",
        r.has_recent_roof_permit == null ? "" : r.has_recent_roof_permit ? "true" : "false",
        r.last_permit_date ?? "",
        csvCell(r.last_permit_type),
        r.status,
      ].join(","),
    );
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `canvass-selected-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ─── Subcomponents ───────────────────────────────────────────────── */

function PresetChip({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium border transition-all active:scale-[0.97]",
        active
          ? "bg-cy-300/15 text-cy-300 border-cy-300/40 shadow-[inset_0_1px_0_rgba(103,220,255,0.15)]"
          : "bg-white/[0.04] text-white/70 border-white/[0.08] hover:border-white/20 hover:text-white",
      ].join(" ")}
      title={hint}
    >
      {icon}
      {label}
    </button>
  );
}

function ThSortable({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (s: { key: SortKey; dir: "asc" | "desc" }) => void;
  align?: "left" | "right";
}) {
  const isActive = sort.key === sortKey;
  return (
    <th
      className={`px-3 py-2.5 font-medium ${align === "right" ? "text-right" : "text-left"}`}
    >
      <button
        type="button"
        onClick={() =>
          onSort({
            key: sortKey,
            dir: isActive && sort.dir === "desc" ? "asc" : "desc",
          })
        }
        className={`inline-flex items-center gap-1 ${isActive ? "text-cy-300" : "text-white/45 hover:text-white"}`}
      >
        {label}
        {isActive && <span className="text-[8px]">{sort.dir === "desc" ? "▼" : "▲"}</span>}
      </button>
    </th>
  );
}

function PermitChip({ row }: { row: CanvassRow }) {
  if (row.permit_checked_at == null) {
    return (
      <span className="text-[10.5px] font-mono tabular px-2 py-0.5 rounded-full text-white/50 border border-white/[0.06] bg-white/[0.02]">
        not checked
      </span>
    );
  }
  if (row.has_recent_roof_permit === false) {
    return (
      <span className="text-[10.5px] font-medium px-2 py-0.5 rounded-full text-cy-300 border border-cy-300/30 bg-cy-300/[0.06] inline-flex items-center gap-1">
        <Flame size={9} aria-hidden />
        no permit
      </span>
    );
  }
  if (row.has_recent_roof_permit === true) {
    return (
      <span className="text-[10.5px] font-mono tabular px-2 py-0.5 rounded-full text-white/60 border border-white/[0.08] bg-white/[0.04]">
        {row.last_permit_date ?? "permit on file"}
      </span>
    );
  }
  return (
    <span className="text-[10.5px] font-mono tabular text-white/40">—</span>
  );
}

/* ─── Outcome logger ──────────────────────────────────────────────── */

function OutcomeLogger({ row }: { row: CanvassRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<string | null>(row.latest_outcome ?? null);
  const [revenue, setRevenue] = useState("");
  const [lostReason, setLostReason] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const needsRevenue = picked === "won";
  const needsLostReason = picked === "lost";

  const submit = (outcome: string) => {
    setError(null);
    setPicked(outcome);

    // Multi-step outcomes (won + lost) require additional fields
    // before the rep clicks Save. Single-step outcomes (contacted /
    // no_contact / disqualified) submit immediately.
    if (outcome === "won" || outcome === "lost") return;

    void send({ outcome });
  };

  const submitFinal = () => {
    if (!picked) return;
    setError(null);
    const body: Record<string, unknown> = { outcome: picked, notes: notes || undefined };
    if (picked === "won") {
      const dollars = Number(revenue);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        setError("Enter a revenue amount.");
        return;
      }
      body.revenue_cents = Math.round(dollars * 100);
    }
    if (picked === "lost" && lostReason) {
      body.lost_reason_category = lostReason;
    }
    void send(body);
  };

  const send = async (extra: Record<string, unknown>) => {
    startTransition(async () => {
      try {
        const res = await fetch("/api/canvass/outcome", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            canvass_target_id: row.id,
            ...extra,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || `http_${res.status}`);
          return;
        }
        setSavedAt(new Date().toISOString());
        // Refresh the server component so the new latest_outcome
        // lands on this row across all open views.
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "network_error");
      }
    });
  };

  return (
    <section className="glass-panel p-4">
      <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3 flex items-center justify-between">
        <span>Log outcome</span>
        {row.latest_outcome && (
          <span className="text-cy-300 normal-case font-medium tracking-normal text-[11px]">
            {prettifyOutcome(row.latest_outcome)}
            {row.latest_outcome_at && (
              <span className="text-white/45 ml-2 font-mono tabular">
                {fmtDateTime(row.latest_outcome_at)}
              </span>
            )}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <OutcomeButton
          label="Contacted"
          outcome="contacted"
          picked={picked}
          onClick={submit}
          pending={pending}
        />
        <OutcomeButton
          label="Quoted"
          outcome="quoted"
          picked={picked}
          onClick={submit}
          pending={pending}
        />
        <OutcomeButton
          label="No contact"
          outcome="no_contact"
          picked={picked}
          onClick={submit}
          pending={pending}
          variant="neutral"
        />
        <OutcomeButton
          label="Disqualified"
          outcome="disqualified"
          picked={picked}
          onClick={submit}
          pending={pending}
          variant="neutral"
        />
        <OutcomeButton
          label="Won"
          outcome="won"
          picked={picked}
          onClick={submit}
          pending={pending}
          variant="success"
        />
        <OutcomeButton
          label="Lost"
          outcome="lost"
          picked={picked}
          onClick={submit}
          pending={pending}
          variant="danger"
        />
      </div>

      {(needsRevenue || needsLostReason) && (
        <div className="flex flex-col gap-2 pt-2 border-t border-white/[0.06]">
          {needsRevenue && (
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] uppercase tracking-wider text-white/45">
                Revenue (USD)
              </span>
              <input
                type="number"
                inputMode="decimal"
                placeholder="18500"
                value={revenue}
                onChange={(e) => setRevenue(e.target.value)}
                className="glass-input !text-[13px]"
              />
            </label>
          )}
          {needsLostReason && (
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] uppercase tracking-wider text-white/45">
                Lost reason
              </span>
              <select
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
                className="glass-input !text-[13px]"
              >
                <option value="">— pick one —</option>
                <option value="not_interested">Not interested</option>
                <option value="competitor_won">Competitor won</option>
                <option value="no_damage">No damage on inspection</option>
                <option value="insurance_denied">Insurance denied</option>
                <option value="price_too_high">Price too high</option>
                <option value="unreachable">Unreachable</option>
                <option value="wrong_house">Wrong house / data error</option>
                <option value="duplicate">Duplicate in pipeline</option>
                <option value="other">Other</option>
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] uppercase tracking-wider text-white/45">
              Notes (optional)
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="glass-input !text-[13px] resize-none"
              placeholder="What happened?"
            />
          </label>
          <button
            type="button"
            onClick={submitFinal}
            disabled={pending}
            className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-[12px] font-medium bg-cy-300/10 text-cy-300 border border-cy-300/30 hover:bg-cy-300/15 active:scale-[0.98] transition-all disabled:opacity-50"
          >
            {pending ? "Saving…" : `Save ${picked === "won" ? "win" : "loss"}`}
          </button>
        </div>
      )}

      {error && (
        <div className="text-[11.5px] text-rose-400/90 mt-2">{error}</div>
      )}
      {savedAt && !error && (
        <div className="text-[11px] text-mint mt-2 inline-flex items-center gap-1">
          <CheckSquare size={11} /> Saved
        </div>
      )}
    </section>
  );
}

function OutcomeButton({
  label,
  outcome,
  picked,
  onClick,
  pending,
  variant = "default",
}: {
  label: string;
  outcome: string;
  picked: string | null;
  onClick: (o: string) => void;
  pending: boolean;
  variant?: "default" | "success" | "danger" | "neutral";
}) {
  const isPicked = picked === outcome;
  const palette = {
    default: isPicked
      ? "bg-cy-300/15 border-cy-300/40 text-cy-300"
      : "bg-white/[0.04] border-white/[0.08] text-white/85 hover:border-white/20",
    success: isPicked
      ? "bg-mint/15 border-mint/40 text-mint"
      : "bg-white/[0.04] border-white/[0.08] text-white/85 hover:border-mint/30",
    danger: isPicked
      ? "bg-rose-400/15 border-rose-400/40 text-rose-400"
      : "bg-white/[0.04] border-white/[0.08] text-white/85 hover:border-rose-400/30",
    neutral: isPicked
      ? "bg-white/[0.08] border-white/20 text-white"
      : "bg-white/[0.02] border-white/[0.06] text-white/65 hover:border-white/15",
  }[variant];
  return (
    <button
      type="button"
      onClick={() => onClick(outcome)}
      disabled={pending}
      className={`inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-[12px] font-medium border transition-all active:scale-[0.98] disabled:opacity-50 ${palette}`}
    >
      {label}
    </button>
  );
}

function prettifyOutcome(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

function ConfidenceBadge({ level }: { level: "high" | "medium" | "low" }) {
  const map = {
    high: {
      cls: "text-cy-300 border-cy-300/30 bg-cy-300/[0.06]",
      label: "high confidence",
    },
    medium: {
      cls: "text-amber border-amber/30 bg-amber/[0.06]",
      label: "medium confidence",
    },
    low: {
      cls: "text-white/55 border-white/[0.08] bg-white/[0.02]",
      label: "low confidence",
    },
  } as const;
  const v = map[level];
  return (
    <span
      className={`text-[10px] font-mono tabular px-2 py-0.5 rounded-full border ${v.cls}`}
    >
      {v.label}
    </span>
  );
}

function ScorePill({ score }: { score: number }) {
  const cls =
    score >= 50
      ? "text-cy-300"
      : score >= 30
        ? "text-white"
        : score >= 0
          ? "text-white/65"
          : "text-rose-400/80";
  return <span className={cls}>{score.toFixed(1)}</span>;
}

function RowDrawer({
  row,
  event,
  onClose,
}: {
  row: CanvassRow;
  event: CanvassStormEvent | null;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label="Canvass target detail"
    >
      <div
        className="flex-1 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="w-full max-w-[460px] h-full overflow-y-auto bg-[rgba(8,11,17,0.86)] backdrop-blur-2xl border-l border-white/[0.08] p-5 lg:p-6 flex flex-col gap-5">
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="glass-eyebrow inline-flex">Canvass target</div>
            <h2 className="text-lg font-semibold mt-2 tracking-tight">
              {row.address_line ?? "Unknown address"}
            </h2>
            <p className="text-[12.5px] text-white/55 mt-1">
              {row.city ?? "—"} {row.zip ?? ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            className="glass-button-secondary !px-2.5 !py-1.5"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <section className="grid grid-cols-2 gap-3">
          <Stat label="Score" value={row.score.toFixed(1)} />
          <Stat
            label="Distance"
            value={row.distance_miles != null ? `${row.distance_miles.toFixed(2)} mi` : "—"}
          />
        </section>

        {event && (
          <section className="glass-panel p-4">
            <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-2">
              Storm event
            </div>
            <div className="text-[14px] text-white font-medium">
              {event.region_name}
            </div>
            <div className="text-[12px] text-white/65 mt-1 font-mono tabular">
              {event.peak_inches.toFixed(2)}&quot; hail · {event.event_date} ·{" "}
              {event.hit_count} cells
            </div>
          </section>
        )}

        <section className="glass-panel p-4">
          <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-2">
            Permit status
          </div>
          {row.permit_checked_at == null ? (
            <div className="text-[13px] text-white/65">
              Portal not yet queried for this address.
            </div>
          ) : row.has_recent_roof_permit === false ? (
            <>
              <div className="text-[13px] text-cy-300 font-medium inline-flex items-center gap-1.5">
                <Flame size={12} aria-hidden />
                No roof permit on file
              </div>
              <div className="text-[11px] text-white/45 mt-1 font-mono tabular">
                Last checked {fmtDateTime(row.permit_checked_at)}
              </div>
            </>
          ) : (
            <>
              <div className="text-[13px] text-white">
                {row.last_permit_type ?? "Roof permit"} · {row.last_permit_date ?? "—"}
              </div>
              <div className="text-[11px] text-white/45 mt-1 font-mono tabular">
                Last checked {fmtDateTime(row.permit_checked_at)}
              </div>
            </>
          )}
        </section>

        {row.phone_checked_at && (
          <section className="glass-panel p-4">
            <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-2 flex items-center justify-between">
              <span>Contact · skip-traced</span>
              {row.phone_match_confidence && (
                <ConfidenceBadge level={row.phone_match_confidence} />
              )}
            </div>
            {row.phone_number ? (
              <div className="flex flex-col gap-1">
                <a
                  href={`tel:${row.phone_number}`}
                  className="text-[15px] text-cy-300 font-mono tabular font-medium hover:text-white transition-colors"
                >
                  {row.phone_number}
                </a>
                <div className="text-[10.5px] text-white/45 font-mono tabular">
                  source: {row.phone_source ?? "—"} · checked{" "}
                  {fmtDateTime(row.phone_checked_at)}
                </div>
                <div className="text-[10px] text-white/40 mt-1.5 leading-relaxed">
                  TCPA/DNC scrub before dialing. FL 8am-9pm window. No
                  auto-dialer without express written consent.
                </div>
              </div>
            ) : (
              <div className="text-[13px] text-white/55">
                No phone match returned by any source.
              </div>
            )}
          </section>
        )}

        <OutcomeLogger row={row} />

        <section className="glass-panel p-4">
          <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-2">
            Quick actions
          </div>
          <div className="flex flex-col gap-2">
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                `${row.address_line ?? ""} ${row.city ?? ""} FL ${row.zip ?? ""}`,
              )}`}
              target="_blank"
              rel="noreferrer"
              className="glass-button-secondary inline-flex items-center gap-2 justify-center active:translate-y-[1px] transition-transform"
            >
              <MapPin size={13} /> Open in Google Maps
            </a>
            {row.lat && row.lng && (
              <a
                href={`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${row.lat},${row.lng}`}
                target="_blank"
                rel="noreferrer"
                className="glass-button-secondary inline-flex items-center gap-2 justify-center active:translate-y-[1px] transition-transform"
              >
                <Home size={13} /> Street View
              </a>
            )}
          </div>
        </section>

        <section className="text-[11px] text-white/40 font-mono tabular">
          Status: {row.status} · Added {fmtDateTime(row.created_at)}
        </section>
      </aside>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass-panel p-3">
      <div className="text-[10px] uppercase tracking-wider text-white/45">
        {label}
      </div>
      <div className="text-base font-mono tabular text-white/95 mt-1">
        {value}
      </div>
    </div>
  );
}

function csvCell(v: string | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function ViewToggle({
  view,
  onChange,
}: {
  view: "table" | "map";
  onChange: (v: "table" | "map") => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Canvass view"
      className="inline-flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] border border-white/[0.06]"
    >
      <button
        role="tab"
        aria-selected={view === "table"}
        onClick={() => onChange("table")}
        className={[
          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium transition-all active:scale-[0.97]",
          view === "table"
            ? "bg-white/[0.08] text-white border border-white/15"
            : "text-white/55 hover:text-white border border-transparent",
        ].join(" ")}
      >
        <List size={11} aria-hidden /> Table
      </button>
      <button
        role="tab"
        aria-selected={view === "map"}
        onClick={() => onChange("map")}
        className={[
          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium transition-all active:scale-[0.97]",
          view === "map"
            ? "bg-white/[0.08] text-white border border-white/15"
            : "text-white/55 hover:text-white border border-transparent",
        ].join(" ")}
      >
        <MapIcon size={11} aria-hidden /> Map
      </button>
    </div>
  );
}

function BulkSelectHeader({
  rowIds,
  selected,
  setSelected,
}: {
  rowIds: string[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
}) {
  const allSelected =
    rowIds.length > 0 && rowIds.every((id) => selected.has(id));
  const someSelected = !allSelected && rowIds.some((id) => selected.has(id));
  return (
    <button
      type="button"
      onClick={() => {
        const next = new Set(selected);
        if (allSelected) {
          rowIds.forEach((id) => next.delete(id));
        } else {
          rowIds.forEach((id) => next.add(id));
        }
        setSelected(next);
      }}
      aria-label={allSelected ? "Deselect all" : "Select all visible"}
      className="inline-flex items-center justify-center"
    >
      {allSelected ? (
        <CheckSquare size={14} className="text-cy-300" aria-hidden />
      ) : someSelected ? (
        <Square size={14} className="text-cy-300/60" aria-hidden />
      ) : (
        <Square
          size={14}
          className="text-white/35 hover:text-white/85 transition-colors"
          aria-hidden
        />
      )}
    </button>
  );
}

function BulkActionBar({
  count,
  onClear,
  onExport,
}: {
  count: number;
  onClear: () => void;
  onExport: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-2rem)] max-w-2xl"
      style={{
        animation: "slideUpFade 220ms cubic-bezier(0.16, 1, 0.3, 1) both",
      }}
    >
      <div className="rounded-2xl border border-cy-300/30 bg-[rgba(8,11,17,0.92)] backdrop-blur-2xl shadow-[0_20px_60px_-10px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.08)] p-3 flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-2 text-[12.5px] text-white">
          <span className="font-mono tabular text-cy-300 font-medium">
            {count}
          </span>
          selected
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onExport}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium bg-cy-300/10 text-cy-300 border border-cy-300/30 hover:bg-cy-300/15 active:scale-[0.97] transition-all"
        >
          <Download size={12} /> Export
        </button>
        <button
          type="button"
          disabled
          title="Phase 3 — queue outbound calls"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium bg-white/[0.04] text-white/40 border border-white/[0.06] cursor-not-allowed"
        >
          <PhoneOutgoing size={12} /> Send to Sydney
        </button>
        <button
          type="button"
          disabled
          title="Phase 3 — mark all contacted"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium bg-white/[0.04] text-white/40 border border-white/[0.06] cursor-not-allowed"
        >
          <CircleCheck size={12} /> Mark contacted
        </button>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selection"
          className="inline-flex items-center justify-center w-7 h-7 rounded-full text-white/55 hover:text-white hover:bg-white/[0.06] active:scale-[0.95] transition-all"
        >
          <X size={13} />
        </button>
      </div>
      <style jsx>{`
        @keyframes slideUpFade {
          from {
            opacity: 0;
            transform: translate(-50%, 16px);
          }
          to {
            opacity: 1;
            transform: translate(-50%, 0);
          }
        }
      `}</style>
    </div>
  );
}
