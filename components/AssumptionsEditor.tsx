"use client";

import type { Assumptions, Complexity, Material, Pitch, ServiceType } from "@/types/estimate";
import { MATERIAL_RATES } from "@/lib/pricing";
import { Minus, Plus, Sliders } from "lucide-react";

interface Props {
  value: Assumptions;
  onChange: (a: Assumptions) => void;
}

const PITCHES: Pitch[] = ["4/12", "5/12", "6/12", "7/12", "8/12+"];

const SERVICE_TYPES: Array<{ value: ServiceType; label: string; sublabel: string }> = [
  { value: "new", label: "New", sublabel: "First-time" },
  { value: "reroof-tearoff", label: "Reroof", sublabel: "Tear-off" },
  { value: "layover", label: "Layover", sublabel: "Over existing" },
  { value: "repair", label: "Repair", sublabel: "Patch only" },
];

const COMPLEXITIES: Array<{ value: Complexity; label: string }> = [
  { value: "simple", label: "Simple" },
  { value: "moderate", label: "Moderate" },
  { value: "complex", label: "Complex" },
];

export default function AssumptionsEditor({ value, onChange }: Props) {
  const set = <K extends keyof Assumptions>(k: K, v: Assumptions[K]) =>
    onChange({ ...value, [k]: v });

  const serviceType: ServiceType = value.serviceType ?? "reroof-tearoff";
  const complexity: Complexity = value.complexity ?? "moderate";
  const laborPct = ((value.laborMultiplier - 0.5) / 1.5) * 100;
  const matPct = ((value.materialMultiplier - 0.5) / 1.5) * 100;

  return (
    <div className="glass rounded-3xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-cy-300/10 border border-cy-300/20 flex items-center justify-center text-cy-300">
            <Sliders size={14} />
          </div>
          <div>
            <div className="font-display font-semibold tracking-tight text-[15px]">Assumptions</div>
            <div className="text-[11px] text-slate-500 -mt-0.5">Tweak anything · live recalculation</div>
          </div>
        </div>
      </div>

      {/* Service type */}
      <div>
        <div className="label mb-2">Service Type</div>
        <div className="grid grid-cols-2 gap-2">
          {SERVICE_TYPES.map((s) => {
            const active = serviceType === s.value;
            return (
              <button
                key={s.value}
                onClick={() => set("serviceType", s.value)}
                className={`relative text-left p-3 rounded-xl border transition group overflow-hidden ${
                  active
                    ? "border-cy-300/40 bg-cy-300/[0.06]"
                    : "border-white/[0.06] bg-white/[0.015] hover:border-white/[0.12] hover:bg-white/[0.03]"
                }`}
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-0 pointer-events-none rounded-xl"
                    style={{
                      background:
                        "radial-gradient(closest-side at 100% 0%, rgba(103,220,255,0.18), transparent 70%)",
                    }}
                  />
                )}
                <div className={`relative font-display text-[13px] font-medium tracking-tight ${active ? "text-cy-200" : "text-slate-100"}`}>
                  {s.label}
                </div>
                <div className="relative font-mono text-[10px] uppercase tracking-[0.12em] text-slate-500 mt-0.5">
                  {s.sublabel}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Roof size */}
      <div>
        <div className="label mb-2">Roof Size · sq ft</div>
        <div className="flex items-stretch gap-2">
          <button
            className="btn btn-ghost px-3 aspect-square"
            onClick={() => set("sqft", Math.max(200, value.sqft - 100))}
            aria-label="Decrease size"
          >
            <Minus size={14} />
          </button>
          <input
            type="number"
            className="input text-center font-display tabular text-[22px] font-semibold py-2 tracking-tight"
            value={value.sqft}
            onChange={(e) => set("sqft", Math.max(0, Number(e.target.value) || 0))}
          />
          <button
            className="btn btn-ghost px-3 aspect-square"
            onClick={() => set("sqft", value.sqft + 100)}
            aria-label="Increase size"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Pitch + age */}
      <div className="grid grid-cols-[1fr_auto] gap-4">
        <div className="min-w-0">
          <div className="label mb-2">Pitch</div>
          <div className="flex gap-1 p-1 rounded-xl bg-black/20 border border-white/[0.06]">
            {PITCHES.map((p) => {
              const active = value.pitch === p;
              return (
                <button
                  key={p}
                  onClick={() => set("pitch", p)}
                  className={`flex-1 px-1 py-1.5 rounded-lg text-[11.5px] font-mono tabular transition whitespace-nowrap ${
                    active
                      ? "bg-white/10 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                      : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]"
                  }`}
                >
                  {p}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <div className="label mb-2">Age · yrs</div>
          <input
            type="number"
            className="input w-20 text-center font-display tabular font-semibold"
            value={value.ageYears}
            onChange={(e) => set("ageYears", Math.max(0, Number(e.target.value) || 0))}
          />
        </div>
      </div>

      {/* Complexity */}
      <div>
        <div className="label mb-2">Complexity</div>
        <div className="flex p-1 rounded-xl bg-black/20 border border-white/[0.06]">
          {COMPLEXITIES.map((c) => {
            const active = complexity === c.value;
            return (
              <button
                key={c.value}
                onClick={() => set("complexity", c.value)}
                className={`flex-1 py-1.5 rounded-lg text-[12px] font-medium transition ${
                  active
                    ? "bg-white/10 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Material */}
      <div>
        <div className="label mb-2">Material</div>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(MATERIAL_RATES) as Material[]).map((m) => {
            const active = value.material === m;
            return (
              <button
                key={m}
                onClick={() => set("material", m)}
                className={`relative text-left p-3 rounded-xl border transition group overflow-hidden ${
                  active
                    ? "border-cy-300/40 bg-cy-300/[0.06]"
                    : "border-white/[0.06] bg-white/[0.015] hover:border-white/[0.12] hover:bg-white/[0.03]"
                }`}
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-0 pointer-events-none rounded-xl"
                    style={{
                      background:
                        "radial-gradient(closest-side at 100% 0%, rgba(103,220,255,0.18), transparent 70%)",
                    }}
                  />
                )}
                <div className="relative flex items-center justify-between gap-2">
                  <span className={`font-display text-[13px] font-medium tracking-tight ${active ? "text-cy-200" : "text-slate-100"}`}>
                    {MATERIAL_RATES[m].label}
                  </span>
                  <span className="font-mono tabular text-[11px] text-slate-500">
                    ${MATERIAL_RATES[m].rate}
                    <span className="text-slate-600">/sf</span>
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Multipliers */}
      <div className="grid grid-cols-2 gap-5">
        <SliderField
          label="Labor mult"
          value={value.laborMultiplier}
          pct={laborPct}
          onChange={(v) => set("laborMultiplier", v)}
        />
        <SliderField
          label="Material mult"
          value={value.materialMultiplier}
          pct={matPct}
          onChange={(v) => set("materialMultiplier", v)}
        />
      </div>
    </div>
  );
}

function SliderField({
  label,
  value,
  pct,
  onChange,
}: {
  label: string;
  value: number;
  pct: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="label">{label}</div>
        <div className="font-mono tabular text-[12px] text-cy-200">{value.toFixed(2)}×</div>
      </div>
      <input
        type="range"
        min={0.5}
        max={2}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ["--pct" as string]: `${pct}%` }}
        className="w-full"
      />
      <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-600 tabular">
        <span>0.5×</span>
        <span>1.0×</span>
        <span>2.0×</span>
      </div>
    </div>
  );
}
