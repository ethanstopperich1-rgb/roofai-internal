"use client";

import type { AddOn } from "@/types/estimate";
import { Check, PackagePlus } from "lucide-react";

interface Props {
  addOns: AddOn[];
  onChange: (a: AddOn[]) => void;
}

export default function AddOnsPanel({ addOns, onChange }: Props) {
  const toggle = (id: string) =>
    onChange(addOns.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)));
  const setPrice = (id: string, price: number) =>
    onChange(addOns.map((a) => (a.id === id ? { ...a, price } : a)));

  const enabledCount = addOns.filter((a) => a.enabled).length;
  const enabledTotal = addOns
    .filter((a) => a.enabled)
    .reduce((s, x) => s + x.price, 0);

  return (
    <div className="glass rounded-3xl p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-mint/10 border border-mint/20 flex items-center justify-center text-mint">
            <PackagePlus size={14} />
          </div>
          <div>
            <div className="font-display font-semibold tracking-tight text-[15px]">Add-Ons</div>
            <div className="text-[11px] text-slate-500 -mt-0.5">Toggle to include · prices editable</div>
          </div>
        </div>
        {enabledCount > 0 && (
          <div className="font-mono tabular text-[11px] text-mint">
            +${enabledTotal.toLocaleString()} · {enabledCount}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        {addOns.map((a) => (
          <div
            key={a.id}
            onClick={() => toggle(a.id)}
            className={`group flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition select-none ${
              a.enabled
                ? "border-cy-300/40 bg-cy-300/[0.06]"
                : "border-white/[0.05] bg-white/[0.015] hover:border-white/[0.12] hover:bg-white/[0.03]"
            }`}
          >
            <div
              className={`w-[18px] h-[18px] rounded-md flex items-center justify-center border transition ${
                a.enabled
                  ? "bg-cy-300 border-cy-300 text-[#051019]"
                  : "border-white/20 group-hover:border-white/40"
              }`}
            >
              {a.enabled && <Check size={12} strokeWidth={3} />}
            </div>
            <div className={`flex-1 text-[13.5px] tracking-tight ${a.enabled ? "text-white" : "text-slate-200"}`}>
              {a.label}
            </div>
            <div
              className="flex items-baseline gap-1 cursor-text"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="font-mono text-[11px] text-slate-500">$</span>
              <input
                type="number"
                value={a.price}
                onChange={(e) => setPrice(a.id, Number(e.target.value) || 0)}
                className={`w-20 text-right bg-transparent font-mono tabular text-[13px] focus:outline-none ${
                  a.enabled ? "text-cy-200" : "text-slate-400"
                }`}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
