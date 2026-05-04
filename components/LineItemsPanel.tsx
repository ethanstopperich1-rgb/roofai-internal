"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Layers, Receipt } from "lucide-react";
import type { DetailedEstimate } from "@/types/estimate";
import { fmt } from "@/lib/pricing";

interface Props {
  detailed: DetailedEstimate;
  /** When true, the detailed Xactimate-code table opens by default */
  defaultOpen?: boolean;
  /** When true, force the "Xactimate" view to be the only option (no toggle) */
  alwaysShowXactimate?: boolean;
}

type View = "summary" | "detailed";

export default function LineItemsPanel({
  detailed,
  defaultOpen = false,
  alwaysShowXactimate = false,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [view, setView] = useState<View>(alwaysShowXactimate ? "detailed" : "summary");

  return (
    <div className="glass rounded-2xl p-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4"
      >
        <div className="flex items-center gap-2 font-bold">
          <Receipt size={16} className="text-sky-400" />
          Line-item breakdown
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-300">
          <span className="font-mono tabular-nums">
            {fmt(detailed.totalLow)} – {fmt(detailed.totalHigh)}
          </span>
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </button>

      {open && (
        <div className="mt-4 space-y-3">
          {!alwaysShowXactimate && (
            <div className="flex items-center gap-1.5 rounded-lg border border-white/5 bg-white/[0.02] p-1">
              <ToggleButton active={view === "summary"} onClick={() => setView("summary")}>
                <Layers size={12} /> Summary
              </ToggleButton>
              <ToggleButton active={view === "detailed"} onClick={() => setView("detailed")}>
                <Receipt size={12} /> Xactimate codes
              </ToggleButton>
            </div>
          )}

          {view === "summary" ? (
            <SummaryTable detailed={detailed} />
          ) : (
            <DetailedTable detailed={detailed} />
          )}

          <p className="px-1 text-[11px] leading-relaxed text-slate-500">
            Estimate is a planning range based on remote measurements and average regional pricing.
            Final pricing requires an on-site inspection.
          </p>
        </div>
      )}
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? "bg-sky-400 text-slate-900" : "text-slate-400 hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

function SummaryTable({ detailed }: { detailed: DetailedEstimate }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/5">
      <table className="w-full text-sm">
        <tbody className="divide-y divide-white/5">
          {detailed.simplifiedItems.map((item) => (
            <tr key={item.group}>
              <td className="px-3 py-2 text-slate-300">{item.group}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-200">
                {fmt(item.totalLow)} – {fmt(item.totalHigh)}
              </td>
            </tr>
          ))}
          <tr className="bg-white/[0.02]">
            <td className="px-3 py-2 font-semibold text-slate-200">Subtotal</td>
            <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold text-slate-100">
              {fmt(detailed.subtotalLow)} – {fmt(detailed.subtotalHigh)}
            </td>
          </tr>
          <tr>
            <td className="px-3 py-2 text-slate-300">Overhead & profit</td>
            <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-200">
              {fmt(detailed.overheadProfit.low)} – {fmt(detailed.overheadProfit.high)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function DetailedTable({ detailed }: { detailed: DetailedEstimate }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/5">
      <table className="w-full text-xs">
        <thead className="bg-white/[0.03] text-left text-[10px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-3 py-2 font-medium">Code</th>
            <th className="px-3 py-2 font-medium">Description</th>
            <th className="px-3 py-2 text-right font-medium">Qty</th>
            <th className="px-3 py-2 text-right font-medium">Unit cost</th>
            <th className="px-3 py-2 text-right font-medium">Extended</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {detailed.lineItems.map((it, i) => (
            <tr key={`${it.code}-${i}`} className="hover:bg-white/[0.02]">
              <td className="px-3 py-1.5 font-mono text-[10px] text-slate-500">{it.code}</td>
              <td className="px-3 py-1.5 text-slate-300">{it.description}</td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-slate-300">
                {it.quantity.toLocaleString()} {it.unit !== "%" ? it.unit : ""}
              </td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-slate-500">
                {it.unit === "%"
                  ? "—"
                  : `${fmt(it.unitCostLow)}–${fmt(it.unitCostHigh)}`}
              </td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-slate-200">
                {fmt(it.extendedLow)}–{fmt(it.extendedHigh)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
