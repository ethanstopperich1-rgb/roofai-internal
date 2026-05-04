"use client";

import type { Assumptions, Complexity, Material, Pitch, ServiceType } from "@/types/estimate";
import { MATERIAL_RATES } from "@/lib/pricing";
import { Minus, Plus } from "lucide-react";

interface Props {
  value: Assumptions;
  onChange: (a: Assumptions) => void;
}

const PITCHES: Pitch[] = ["4/12", "5/12", "6/12", "7/12", "8/12+"];

const SERVICE_TYPES: Array<{ value: ServiceType; label: string; sublabel: string }> = [
  { value: "new", label: "New", sublabel: "First-time install" },
  { value: "reroof-tearoff", label: "Reroof", sublabel: "Tear off & replace" },
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

  return (
    <div className="glass rounded-2xl p-5 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-bold text-lg">Assumptions</div>
          <div className="text-xs text-slate-400">Tweak anything — total updates live</div>
        </div>
      </div>

      <div>
        <div className="label mb-2">Service Type</div>
        <div className="grid grid-cols-2 gap-2">
          {SERVICE_TYPES.map((s) => {
            const active = serviceType === s.value;
            return (
              <button
                key={s.value}
                onClick={() => set("serviceType", s.value)}
                className={`btn ${active ? "btn-primary" : "btn-ghost"} flex-col items-start py-2`}
              >
                <span className="text-sm">{s.label}</span>
                <span className="text-[10px] opacity-80 font-normal">{s.sublabel}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="label mb-2">Roof Size (sq ft)</div>
        <div className="flex items-center gap-2">
          <button
            className="btn btn-ghost px-3"
            onClick={() => set("sqft", Math.max(200, value.sqft - 100))}
          >
            <Minus size={16} />
          </button>
          <input
            type="number"
            className="input text-center font-bold text-lg"
            value={value.sqft}
            onChange={(e) => set("sqft", Math.max(0, Number(e.target.value) || 0))}
          />
          <button className="btn btn-ghost px-3" onClick={() => set("sqft", value.sqft + 100)}>
            <Plus size={16} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="label mb-2">Pitch</div>
          <select
            className="input"
            value={value.pitch}
            onChange={(e) => set("pitch", e.target.value as Pitch)}
          >
            {PITCHES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div>
          <div className="label mb-2">Age (years)</div>
          <input
            type="number"
            className="input"
            value={value.ageYears}
            onChange={(e) => set("ageYears", Math.max(0, Number(e.target.value) || 0))}
          />
        </div>
      </div>

      <div>
        <div className="label mb-2">Complexity</div>
        <div className="grid grid-cols-3 gap-2">
          {COMPLEXITIES.map((c) => {
            const active = complexity === c.value;
            return (
              <button
                key={c.value}
                onClick={() => set("complexity", c.value)}
                className={`btn ${active ? "btn-primary" : "btn-ghost"} text-sm`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="label mb-2">Material</div>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(MATERIAL_RATES) as Material[]).map((m) => {
            const active = value.material === m;
            return (
              <button
                key={m}
                onClick={() => set("material", m)}
                className={`btn ${active ? "btn-primary" : "btn-ghost"} justify-between`}
              >
                <span className="truncate">{MATERIAL_RATES[m].label}</span>
                <span className="text-xs opacity-80">${MATERIAL_RATES[m].rate}/sf</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="label mb-2">Labor Mult ({value.laborMultiplier.toFixed(2)}x)</div>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={value.laborMultiplier}
            onChange={(e) => set("laborMultiplier", Number(e.target.value))}
            className="w-full accent-sky-400"
          />
        </div>
        <div>
          <div className="label mb-2">Material Mult ({value.materialMultiplier.toFixed(2)}x)</div>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={value.materialMultiplier}
            onChange={(e) => set("materialMultiplier", Number(e.target.value))}
            className="w-full accent-sky-400"
          />
        </div>
      </div>
    </div>
  );
}
