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
    <div className="glass rounded-3xl p-6 relative overflow-hidden">
      <div
        className="absolute -top-12 -right-8 w-56 h-56 blur-3xl pointer-events-none opacity-50"
        style={{ background: "radial-gradient(closest-side, rgba(103,220,255,0.10), transparent)" }}
      />
      <div className="relative flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-cy-300/10 border border-cy-300/20 flex items-center justify-center text-cy-300">
            <Eye size={14} />
          </div>
          <div>
            <div className="font-display font-semibold tracking-tight text-[15px]">AI Roof Assessment</div>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-slate-500 -mt-0.5">
              Claude · Vision
            </div>
          </div>
        </div>
        {vision && (
          <div className="chip">
            <span className="font-mono tabular text-cy-200">{Math.round(vision.confidence * 100)}%</span>
            confidence
          </div>
        )}
      </div>

      {loading && !vision && (
        <div className="flex items-center gap-2 text-[13px] text-slate-400">
          <Loader2 size={13} className="animate-spin text-cy-300" />
          Claude is reading the satellite image…
        </div>
      )}

      {error && !vision && (
        <div className="text-[12px] text-rose px-3 py-2 rounded-lg bg-rose/[0.08] border border-rose/20">
          Vision unavailable: {error}
        </div>
      )}

      {vision && (
        <div className="relative space-y-4">
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Material" value={MATERIAL_LABEL[vision.currentMaterial]} />
            <Field
              label="Age"
              value={`${AGE_LABEL[vision.estimatedAge]} · ~${vision.estimatedAgeYears}y`}
            />
            <Field label="Complexity" value={vision.complexity} />
            <Field
              label="Damage"
              value={
                vision.visibleDamage.length === 0 || vision.visibleDamage[0] === "none"
                  ? "None observed"
                  : vision.visibleDamage.map((d) => DAMAGE_LABEL[d]).join(", ")
              }
              warn={vision.visibleDamage.length > 0 && vision.visibleDamage[0] !== "none"}
            />
          </div>

          {vision.visibleFeatures.length > 0 && (
            <div>
              <div className="label mb-2">Features</div>
              <div className="flex flex-wrap gap-1.5">
                {vision.visibleFeatures.map((f) => (
                  <span key={f} className="chip">{FEATURE_LABEL[f]}</span>
                ))}
              </div>
            </div>
          )}

          {vision.penetrations.length > 0 && (
            <div>
              <div className="label mb-2 flex items-center justify-between">
                <span>Penetrations</span>
                <span className="font-mono text-[10px] tabular text-slate-500">
                  {vision.penetrations.length} located on the map
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {vision.penetrations.map((p, i) => (
                  <span key={i} className="chip">
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber/30 text-[9px] font-semibold text-amber">
                      {i + 1}
                    </span>
                    {p.kind}
                    {p.approxSizeFt ? (
                      <span className="ml-0.5 font-mono text-[10px] text-slate-500">
                        ~{p.approxSizeFt}ft
                      </span>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          )}

          {vision.salesNotes && (
            <div className="rounded-2xl border border-cy-300/20 bg-cy-300/[0.05] p-3.5">
              <div className="flex items-center gap-1.5 mb-1.5">
                <CheckCircle2 size={11} className="text-cy-300" />
                <span className="label text-cy-300">Sales note</span>
              </div>
              <div className="text-[13px] text-slate-200 leading-relaxed">
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
    <div className={`rounded-2xl border px-3.5 py-2.5 ${warn ? "border-amber/30 bg-amber/[0.05]" : "border-white/[0.05] bg-white/[0.015]"}`}>
      <div className="label flex items-center gap-1.5">
        {warn && <AlertTriangle size={10} className="text-amber" />}
        {label}
      </div>
      <div className={`mt-1 truncate font-display text-[14px] font-medium tracking-tight ${warn ? "text-amber" : "text-slate-100"}`}>
        {value}
      </div>
    </div>
  );
}
