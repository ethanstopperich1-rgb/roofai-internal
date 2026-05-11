"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Layers, Receipt } from "lucide-react";
import type { DetailedEstimate } from "@/types/estimate";
import { fmt } from "@/lib/pricing";

interface Props {
  detailed: DetailedEstimate;
  defaultOpen?: boolean;
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
  // Auto-open / auto-switch-to-detailed when the relevant prop flips
  // from false → true (e.g. rep enables insurance claim mode). Without
  // these the panel stayed collapsed / summary-view because state was
  // initialised once at mount.
  const prevDefaultOpenRef = useRef(defaultOpen);
  useEffect(() => {
    if (!prevDefaultOpenRef.current && defaultOpen) setOpen(true);
    prevDefaultOpenRef.current = defaultOpen;
  }, [defaultOpen]);
  const prevAlwaysShowRef = useRef(alwaysShowXactimate);
  useEffect(() => {
    if (!prevAlwaysShowRef.current && alwaysShowXactimate) setView("detailed");
    prevAlwaysShowRef.current = alwaysShowXactimate;
  }, [alwaysShowXactimate]);

  return (
    <div className="glass-panel p-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 group"
      >
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-cy-300/10 border border-cy-300/20 flex items-center justify-center text-cy-300">
            <Receipt size={14} />
          </div>
          <div className="text-left">
            <div className="font-display font-semibold tracking-tight text-[15px]">
              Line-item breakdown
            </div>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-slate-500 -mt-0.5">
              Xactimate retail · incl. O&amp;P · {detailed.lineItems.length} items · {detailed.squares.toFixed(1)} squares
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono tabular text-[12px] text-slate-200">
            {fmt(detailed.totalLow)} <span className="text-slate-600">–</span> {fmt(detailed.totalHigh)}
          </span>
          <div className="text-slate-400 group-hover:text-slate-200 transition">
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </div>
        </div>
      </button>

      {open && (
        <div className="mt-5 space-y-4">
          {!alwaysShowXactimate && (
            <div className="flex p-1 rounded-xl bg-black/20 border border-white/[0.06]">
              <Toggle active={view === "summary"} onClick={() => setView("summary")}>
                <Layers size={11} /> Summary
              </Toggle>
              <Toggle active={view === "detailed"} onClick={() => setView("detailed")}>
                <Receipt size={11} /> Xactimate codes
              </Toggle>
            </div>
          )}

          {view === "summary" ? (
            <SummaryTable detailed={detailed} />
          ) : (
            <DetailedTable detailed={detailed} />
          )}

          <p className="px-1 text-[11px] leading-relaxed text-slate-500">
            Range based on remote measurements and average regional pricing. Final pricing requires
            on-site inspection.
          </p>
        </div>
      )}
    </div>
  );
}

function Toggle({
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
      className={`flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[12px] font-medium transition ${
        active
          ? "bg-white/10 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
          : "text-slate-400 hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

function SummaryTable({ detailed }: { detailed: DetailedEstimate }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/[0.06]">
      <table className="w-full text-[13px]">
        <tbody>
          {detailed.simplifiedItems.map((item, i) => (
            <tr key={item.group} className={i % 2 === 0 ? "bg-white/[0.012]" : ""}>
              <td className="px-4 py-2.5 text-slate-300">{item.group}</td>
              <td className="px-4 py-2.5 text-right font-mono tabular text-slate-200">
                {fmt(item.totalLow)} <span className="text-slate-600">–</span> {fmt(item.totalHigh)}
              </td>
            </tr>
          ))}
          <tr className="bg-cy-300/[0.04] border-t border-cy-300/15">
            <td className="px-4 py-3 font-display font-semibold tracking-tight">Subtotal</td>
            <td className="px-4 py-3 text-right font-display tabular font-semibold">
              {fmt(detailed.subtotalLow)} – {fmt(detailed.subtotalHigh)}
            </td>
          </tr>
          <tr>
            <td className="px-4 py-2.5 text-slate-400 text-[12px]">Overhead & profit</td>
            <td className="px-4 py-2.5 text-right font-mono tabular text-slate-300 text-[12px]">
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
    <div className="overflow-x-auto rounded-2xl border border-white/[0.06]">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-white/[0.06]">
            <Th>Code</Th>
            <Th>Description</Th>
            <Th align="right">Qty</Th>
            <Th align="right">Unit</Th>
            <Th align="right">Extended</Th>
          </tr>
        </thead>
        <tbody>
          {detailed.lineItems.map((it, i) => (
            <tr key={`${it.code}-${i}`} className="border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02]">
              <td className="px-3 py-2 font-mono text-[10.5px] text-cy-200/80">{it.code}</td>
              <td className="px-3 py-2 text-slate-200">{it.description}</td>
              <td className="px-3 py-2 text-right font-mono tabular text-slate-300">
                {it.quantity.toLocaleString()} <span className="text-slate-600">{it.unit !== "%" ? it.unit : ""}</span>
              </td>
              <td className="px-3 py-2 text-right font-mono tabular text-slate-500">
                {it.unit === "%" ? "—" : `${fmt(it.unitCostLow)}–${fmt(it.unitCostHigh)}`}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular text-slate-100">
                {fmt(it.extendedLow)}<span className="text-slate-600">–</span>{fmt(it.extendedHigh)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th className={`px-3 py-2 label font-normal ${align === "right" ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}
