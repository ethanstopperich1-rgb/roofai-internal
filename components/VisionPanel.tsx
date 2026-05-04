"use client";

import { Eye, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { RoofVision } from "@/types/estimate";

const MATERIAL_LABEL: Record<RoofVision["currentMaterial"], string> = {
  "asphalt-3tab": "Asphalt 3-tab",
  "asphalt-architectural": "Architectural shingle",
  "metal-standing-seam": "Standing-seam metal",
  "tile-concrete": "Concrete tile",
  "wood-shake": "Wood shake",
  "flat-membrane": "Flat membrane",
  unknown: "Unknown",
};

const AGE_LABEL: Record<RoofVision["estimatedAge"], string> = {
  new: "New",
  moderate: "Moderate",
  aged: "Aged",
  "very-aged": "Very aged",
  unknown: "Unknown",
};

const FEATURE_LABEL: Record<RoofVision["visibleFeatures"][number], string> = {
  chimney: "chimney",
  skylight: "skylight",
  dormer: "dormer",
  "solar-panels": "solar panels",
  "satellite-dish": "satellite dish",
  vents: "vents",
  "complex-geometry": "complex geometry",
};

const DAMAGE_LABEL: Record<RoofVision["visibleDamage"][number], string> = {
  "missing-shingles": "missing shingles",
  "moss-algae": "moss / algae",
  discoloration: "discoloration",
  "tarp-visible": "tarp visible",
  ponding: "ponding",
  none: "none observed",
};

interface Props {
  vision: RoofVision | null;
  loading: boolean;
  error?: string;
}

export default function VisionPanel({ vision, loading, error }: Props) {
  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 font-bold">
          <Eye size={16} className="text-sky-400" /> AI Roof Assessment
        </div>
        {vision && (
          <span className="text-[10px] uppercase tracking-wider text-slate-400">
            confidence {Math.round(vision.confidence * 100)}%
          </span>
        )}
      </div>

      {loading && !vision && (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 size={14} className="animate-spin" />
          Claude is reading the satellite image...
        </div>
      )}

      {error && !vision && (
        <div className="text-xs text-rose-400">
          Vision analysis unavailable: {error}
        </div>
      )}

      {vision && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label="Material" value={MATERIAL_LABEL[vision.currentMaterial]} />
            <Field
              label="Age"
              value={`${AGE_LABEL[vision.estimatedAge]} (~${vision.estimatedAgeYears} yrs)`}
            />
            <Field label="Complexity" value={vision.complexity} />
            <Field
              label="Damage"
              value={
                vision.visibleDamage.length === 0 || vision.visibleDamage[0] === "none"
                  ? "None observed"
                  : vision.visibleDamage.map((d) => DAMAGE_LABEL[d]).join(", ")
              }
              warn={
                vision.visibleDamage.length > 0 && vision.visibleDamage[0] !== "none"
              }
            />
          </div>

          {vision.visibleFeatures.length > 0 && (
            <div>
              <div className="label mb-1.5">Features</div>
              <div className="flex flex-wrap gap-1.5">
                {vision.visibleFeatures.map((f) => (
                  <span
                    key={f}
                    className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[11px] text-slate-300"
                  >
                    {FEATURE_LABEL[f]}
                  </span>
                ))}
              </div>
            </div>
          )}

          {vision.salesNotes && (
            <div className="rounded-xl border border-sky-400/20 bg-sky-400/5 p-3">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-sky-300 mb-1">
                <CheckCircle2 size={12} />
                Sales note
              </div>
              <div className="text-sm text-slate-200 leading-relaxed">
                {vision.salesNotes}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
      <div className="label flex items-center gap-1.5">
        {warn && <AlertTriangle size={10} className="text-amber-400" />}
        {label}
      </div>
      <div className={`mt-0.5 truncate text-sm font-medium ${warn ? "text-amber-300" : ""}`}>
        {value}
      </div>
    </div>
  );
}
