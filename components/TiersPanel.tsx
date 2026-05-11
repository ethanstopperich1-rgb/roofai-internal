"use client";

import { Crown, Star, ShieldCheck, Check, Sparkles } from "lucide-react";
import type { AddOn, Assumptions } from "@/types/estimate";
import { buildTiers, type ProposalTier } from "@/lib/tiers";
import { fmt, MATERIAL_RATES } from "@/lib/pricing";
import { useMemo, useState } from "react";

interface Props {
  assumptions: Assumptions;
  addOns: AddOn[];
  onApplyTier?: (tier: ProposalTier) => void;
}

const ICONS: Record<ProposalTier["key"], React.ReactNode> = {
  good: <ShieldCheck size={14} />,
  better: <Star size={14} />,
  best: <Crown size={14} />,
};

const ACCENTS: Record<ProposalTier["key"], string> = {
  good: "text-slate-300 border-white/[0.08]",
  better: "text-cy-300 border-cy-300/30",
  best: "text-amber border-amber/40",
};

export default function TiersPanel({ assumptions, addOns, onApplyTier }: Props) {
  const tiers = useMemo(() => buildTiers(assumptions, addOns), [assumptions, addOns]);
  const [selected, setSelected] = useState<ProposalTier["key"]>("better");

  return (
    <div className="glass-panel p-6 relative overflow-hidden">
      <div
        className="absolute -top-12 left-1/3 w-72 h-72 blur-3xl pointer-events-none opacity-50"
        style={{ background: "radial-gradient(closest-side, rgba(243,177,75,0.10), transparent)" }}
      />
      <div className="relative flex items-center justify-between mb-5">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-amber/10 border border-amber/20 flex items-center justify-center text-amber">
            <Sparkles size={14} />
          </div>
          <div>
            <div className="font-display font-semibold tracking-tight text-[15px]">Tiered Proposal</div>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-slate-500 -mt-0.5">
              Good · Better · Best · 7.99% APR · 84 mo
            </div>
          </div>
        </div>
      </div>

      <div className="relative grid md:grid-cols-3 gap-3">
        {tiers.map((t) => {
          const isSelected = selected === t.key;
          const isBest = t.key === "best";
          const isMid = t.key === "better";
          return (
            <div
              key={t.key}
              onClick={() => setSelected(t.key)}
              className={`relative rounded-2xl border p-5 cursor-pointer transition group ${
                isSelected
                  ? `${ACCENTS[t.key]} bg-white/[0.04]`
                  : "border-white/[0.05] bg-white/[0.015] hover:border-white/[0.13] hover:bg-white/[0.03]"
              }`}
            >
              {isMid && (
                <span className="absolute -top-2.5 left-5 chip chip-accent text-[10px]">
                  Most popular
                </span>
              )}
              {isBest && (
                <span
                  className="absolute -top-2.5 left-5 chip text-[10px]"
                  style={{
                    background: "rgba(243,177,75,0.12)",
                    borderColor: "rgba(243,177,75,0.40)",
                    color: "#f3b14b",
                  }}
                >
                  Lifetime
                </span>
              )}

              <div className="flex items-center gap-2 mb-2">
                <span className={isSelected ? `${ACCENTS[t.key].split(" ")[0]}` : "text-slate-500"}>
                  {ICONS[t.key]}
                </span>
                <span className="font-display font-semibold tracking-tight text-[14px]">
                  {t.name}
                </span>
              </div>
              <div className="text-[11.5px] text-slate-500 mb-4 leading-relaxed">{t.tagline}</div>

              <div className="font-display tabular text-[34px] font-semibold tracking-[-0.02em] leading-none">
                {fmt(t.total)}
              </div>
              <div className="mt-1 font-mono tabular text-[11px] text-slate-400">
                or <span className="text-cy-200">{fmt(t.monthlyAt8)}/mo</span>
              </div>

              <div className="my-4 divider" />

              <div className="space-y-1.5">
                <div className="text-[11px] text-slate-400 mb-2 flex items-center gap-1.5">
                  <span className="font-mono tabular">{MATERIAL_RATES[t.material].label}</span>
                  <span className="text-slate-600">·</span>
                  <span className="font-mono tabular">{t.warrantyYears}-yr</span>
                </div>
                {t.highlights.map((h) => (
                  <div key={h} className="flex items-start gap-2 text-[12px] text-slate-300">
                    <Check size={12} className="text-mint flex-shrink-0 mt-0.5" />
                    <span className="leading-snug">{h}</span>
                  </div>
                ))}
              </div>

              {onApplyTier && isSelected && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onApplyTier(t);
                  }}
                  className="glass-button-primary w-full mt-5 text-[13px]"
                >
                  Apply this tier
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
