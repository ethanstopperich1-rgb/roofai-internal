"use client";

import type { AddOn } from "@/types/estimate";
import { fmt } from "@/lib/pricing";
import { Check } from "lucide-react";

interface Props {
  addOns: AddOn[];
  onChange: (a: AddOn[]) => void;
}

export default function AddOnsPanel({ addOns, onChange }: Props) {
  const toggle = (id: string) =>
    onChange(addOns.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)));
  const setPrice = (id: string, price: number) =>
    onChange(addOns.map((a) => (a.id === id ? { ...a, price } : a)));

  return (
    <div className="glass rounded-2xl p-5">
      <div className="font-bold text-lg mb-1">Add-Ons</div>
      <div className="text-xs text-slate-400 mb-4">Toggle to include · prices editable</div>
      <div className="grid sm:grid-cols-2 gap-2">
        {addOns.map((a) => (
          <div
            key={a.id}
            className={`flex items-center gap-3 p-3 rounded-xl border transition cursor-pointer ${
              a.enabled
                ? "border-sky-400/50 bg-sky-400/5"
                : "border-white/5 bg-white/[0.02] hover:bg-white/[0.04]"
            }`}
            onClick={() => toggle(a.id)}
          >
            <div
              className={`w-5 h-5 rounded-md flex items-center justify-center border ${
                a.enabled ? "bg-sky-400 border-sky-400 text-slate-900" : "border-white/20"
              }`}
            >
              {a.enabled && <Check size={14} />}
            </div>
            <div className="flex-1 text-sm font-medium">{a.label}</div>
            <input
              type="number"
              value={a.price}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setPrice(a.id, Number(e.target.value) || 0)}
              className="w-24 text-right bg-transparent text-sm font-mono text-slate-300 focus:outline-none"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
