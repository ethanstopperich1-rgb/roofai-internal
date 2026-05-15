"use client";

import { Eye, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { RoofVision } from "@/types/estimate";

const MATERIAL_LABEL: Record<RoofVision["currentMaterial"], string> = {
  "asphalt-3tab": "Builder grade shingle",
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
  /** Optional roof age in years — drives the FL SB 2-D claim-helper chip */
  ageYears?: number;
  /** Optional ZIP code — used to detect FL properties for the SB 2-D helper */
  zip?: string;
}

const FL_ZIP_PREFIXES = new Set([
  "32", "33", "34",
]);

function isFlorida(zip?: string): boolean {
  if (!zip) return false;
  return FL_ZIP_PREFIXES.has(zip.slice(0, 2));
}

function hasMaterialDamage(damage: RoofVision["visibleDamage"]): boolean {
  return damage.some((d) => d !== "none");
}

export default function VisionPanel({ vision, loading, error, ageYears, zip }: Props) {
  return (
    <div className="glass-panel p-6 relative overflow-hidden">
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
              Pitch Vision
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
          Analyzing satellite imagery…
        </div>
      )}

      {error && !vision && (
        <div className="text-[12px] text-rose px-3 py-2 rounded-lg bg-rose/[0.08] border border-rose/20">
          Couldn&apos;t analyze this roof. Estimate still works — refresh to retry.
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

          {/* Florida SB 2-D claim-helper. Surfaces when:
               - property is in FL (ZIP starts 32-, 33-, or 34-)
               - roof age < 15 years
               - vision detected at least one damage signal
              SB 2-D bars insurers from denying full replacement on roofs
              under 15 years old based on age alone. Big adjuster ammunition. */}
          {isFlorida(zip) &&
            ageYears != null &&
            ageYears < 15 &&
            hasMaterialDamage(vision.visibleDamage) && (
              <div
                className="rounded-2xl border p-3.5"
                style={{
                  background: "rgba(243,177,75,0.06)",
                  borderColor: "rgba(243,177,75,0.32)",
                }}
              >
                <div className="flex items-center gap-1.5 mb-1.5">
                  <AlertTriangle size={11} className="text-amber" />
                  <span className="label text-amber">
                    FL SB 2-D · adjuster ammunition
                  </span>
                </div>
                <div className="text-[13px] text-slate-200 leading-relaxed">
                  Roof is <span className="font-mono tabular text-amber">{ageYears} years</span> old
                  with visible damage. Under <strong>Florida SB 2-D</strong>, an
                  insurer may not deny full replacement on a roof less than 15
                  years old based on age alone.
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
