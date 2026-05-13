"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  fmtDateTime,
  fmtDuration,
  outcomeStyle,
  type Call,
  type Event,
} from "@/lib/dashboard-format";

type FilterKey =
  | "all"
  | "booked"
  | "transferred"
  | "no_show"
  | "wrong_number"
  | "cap";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "booked", label: "Booked" },
  { key: "transferred", label: "Transferred" },
  { key: "no_show", label: "No-show" },
  { key: "wrong_number", label: "Wrong number" },
  { key: "cap", label: "Cap fired" },
];

function matchesFilter(outcome: string | null, f: FilterKey): boolean {
  if (f === "all") return true;
  const o = (outcome ?? "").toLowerCase();
  if (f === "cap") return o.startsWith("cap_");
  if (f === "transferred") return o === "transferred" || o === "transferred_to_human";
  if (f === "no_show") return o === "no_show" || o === "no-show";
  return o === f;
}

export default function CallsTable({
  calls,
  eventsByCall,
}: {
  calls: Call[];
  eventsByCall: Record<string, Event[]>;
}) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const filtered = useMemo(
    () => calls.filter((c) => matchesFilter(c.outcome, filter)),
    [calls, filter],
  );

  const openCall = openId ? calls.find((c) => c.id === openId) ?? null : null;
  const openEvents = openId ? eventsByCall[openId] ?? [] : [];

  return (
    <div className="flex flex-col gap-4">
      {/* Filter chips */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={[
                "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                active
                  ? "bg-cy-300/15 border-cy-300/40 text-cy-300"
                  : "bg-white/[0.04] border-white/10 text-white/65 hover:text-white hover:bg-white/[0.07]",
              ].join(" ")}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div className="glass-panel p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-white/45 border-b border-white/[0.06]">
                <th className="text-left font-medium px-4 py-3">Date</th>
                <th className="text-left font-medium px-4 py-3">Caller</th>
                <th className="text-right font-medium px-4 py-3">Duration</th>
                <th className="text-left font-medium px-4 py-3">Outcome</th>
                <th className="text-right font-medium px-4 py-3 hidden lg:table-cell">Turns</th>
                <th className="text-right font-medium px-4 py-3 hidden lg:table-cell">Lead</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-white/55 text-sm">
                    No calls match this filter.
                  </td>
                </tr>
              )}
              {filtered.map((c) => {
                const style = outcomeStyle(c.outcome);
                return (
                  <tr
                    key={c.id}
                    onClick={() => setOpenId(c.id)}
                    className="border-b border-white/[0.04] last:border-b-0 cursor-pointer hover:bg-white/[0.03] transition-colors"
                  >
                    <td className="px-4 py-3 text-white/85 font-mono tabular text-[12.5px] whitespace-nowrap">
                      {fmtDateTime(c.started_at)}
                    </td>
                    <td className="px-4 py-3 text-white/85 font-mono tabular text-[12.5px] whitespace-nowrap">
                      {c.caller_number ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular text-[12.5px]">
                      {fmtDuration(c.duration_sec)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center text-[11px] px-2 py-0.5 rounded-full border ${style.className}`}
                      >
                        {style.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular text-[12.5px] hidden lg:table-cell text-white/65">
                      {c.turn_count ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular text-[12.5px] hidden lg:table-cell text-white/55">
                      {c.lead_id ? c.lead_id.slice(0, 8) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-[11px] text-white/40 font-mono tabular text-center">
        Showing up to 50 most recent calls. Older calls available via Analytics export (coming).
      </div>

      {/* Drawer */}
      {openCall && (
        <CallDrawer call={openCall} events={openEvents} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
}

function CallDrawer({
  call,
  events,
  onClose,
}: {
  call: Call;
  events: Event[];
  onClose: () => void;
}) {
  const style = outcomeStyle(call.outcome);
  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        className="flex-1 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="w-full max-w-[560px] h-full overflow-y-auto bg-[rgba(8,11,17,0.86)] backdrop-blur-2xl border-l border-white/[0.08] p-5 lg:p-6 flex flex-col gap-5">
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="glass-eyebrow inline-flex">Sydney · Call detail</div>
            <h2 className="text-lg font-semibold mt-2 tracking-tight">
              {call.caller_number ?? "Unknown caller"}
            </h2>
            <div className="flex items-center gap-2 mt-1.5">
              <span
                className={`inline-flex items-center text-[11px] px-2 py-0.5 rounded-full border ${style.className}`}
              >
                {style.label}
              </span>
              <span className="text-[11px] text-white/45 font-mono tabular">
                {fmtDateTime(call.started_at)}
              </span>
            </div>
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
          <Stat label="Duration" value={fmtDuration(call.duration_sec)} />
          <Stat label="Turns" value={call.turn_count?.toString() ?? "—"} />
        </section>

        {call.summary && (
          <section className="glass-panel p-4">
            <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-2">Summary</div>
            <p className="text-sm text-white/85 leading-relaxed whitespace-pre-wrap">
              {call.summary}
            </p>
          </section>
        )}

        <section>
          <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-2">
            Event timeline
          </div>
          {events.length === 0 ? (
            <div className="text-xs text-white/50">No events recorded for this call.</div>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {events.map((e) => (
                <li
                  key={e.id}
                  className="flex items-start gap-3 text-xs font-mono tabular border-l border-white/10 pl-3"
                >
                  <span className="text-white/40 whitespace-nowrap">{fmtDateTime(e.at)}</span>
                  <span className="text-cy-300 truncate">{e.type}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section>
          <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-2">Transcript</div>
          {call.transcript ? (
            <pre className="text-[12.5px] leading-relaxed whitespace-pre-wrap font-mono text-white/80 bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 max-h-[420px] overflow-y-auto">
              {call.transcript}
            </pre>
          ) : (
            <div className="text-xs text-white/50">Transcript not available for this call.</div>
          )}
        </section>

      </aside>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass-panel p-3">
      <div className="text-[10px] uppercase tracking-wider text-white/45">{label}</div>
      <div className="text-base font-mono tabular text-white/90 mt-1">{value}</div>
    </div>
  );
}
