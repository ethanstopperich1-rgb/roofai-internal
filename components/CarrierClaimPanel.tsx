"use client";

import { ShieldCheck } from "lucide-react";
import { CARRIER_LIST, CARRIERS, type ClaimContext } from "@/lib/carriers";

interface Props {
  context: ClaimContext;
  onChange: (c: ClaimContext) => void;
}

/**
 * Carrier-specific claim metadata form. Only rendered when
 * `isInsuranceClaim` is true. The selected carrier drives the PDF's
 * first-page layout, accent color, scope-section header, and photo-
 * section title via lib/carriers.ts.
 */
export default function CarrierClaimPanel({ context, onChange }: Props) {
  const carrier = CARRIERS[context.carrier] ?? CARRIERS.other;
  const fields = new Set(carrier.claimFields);

  return (
    <div
      className="rounded-3xl border p-5 space-y-4"
      style={{
        background: "rgba(243,177,75,0.04)",
        borderColor: "rgba(243,177,75,0.25)",
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center text-amber bg-amber/10 border border-amber/30">
            <ShieldCheck size={14} />
          </div>
          <div>
            <div className="font-display font-semibold tracking-tight text-[15px] text-amber">
              Insurance Claim Details
            </div>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-slate-500 -mt-0.5">
              Drives the carrier-specific PDF layout
            </div>
          </div>
        </div>
        {carrier.unverified && (
          <span className="chip text-amber" title="Layout for this carrier is a reasonable default — confirm with adjuster on first claim">
            unverified
          </span>
        )}
      </div>

      <div>
        <div className="label mb-2">Carrier</div>
        <select
          className="input"
          value={context.carrier}
          onChange={(e) =>
            onChange({ ...context, carrier: e.target.value as ClaimContext["carrier"] })
          }
        >
          {CARRIER_LIST.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
              {c.unverified ? " (unverified)" : ""}
            </option>
          ))}
        </select>
        {carrier.notes && (
          <div className="text-[11px] text-slate-400 mt-2 leading-relaxed italic">
            {carrier.notes}
          </div>
        )}
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        {fields.has("claim-number") && (
          <Field label="Claim #">
            <input
              className="input"
              value={context.claimNumber ?? ""}
              onChange={(e) => onChange({ ...context, claimNumber: e.target.value })}
              placeholder="ABC-12345"
            />
          </Field>
        )}
        {fields.has("policy-number") && (
          <Field label="Policy #">
            <input
              className="input"
              value={context.policyNumber ?? ""}
              onChange={(e) => onChange({ ...context, policyNumber: e.target.value })}
            />
          </Field>
        )}
        {fields.has("adjuster-name") && (
          <Field label="Adjuster">
            <input
              className="input"
              value={context.adjusterName ?? ""}
              onChange={(e) => onChange({ ...context, adjusterName: e.target.value })}
            />
          </Field>
        )}
        {fields.has("adjuster-phone") && (
          <Field label="Adjuster phone">
            <input
              className="input"
              type="tel"
              value={context.adjusterPhone ?? ""}
              onChange={(e) => onChange({ ...context, adjusterPhone: e.target.value })}
            />
          </Field>
        )}
        {fields.has("date-of-loss") && (
          <Field label="Date of loss">
            <input
              className="input"
              type="date"
              value={context.dateOfLoss ?? ""}
              onChange={(e) => onChange({ ...context, dateOfLoss: e.target.value })}
            />
          </Field>
        )}
        {fields.has("peril") && (
          <Field label="Peril">
            <select
              className="input"
              value={context.peril ?? ""}
              onChange={(e) => onChange({ ...context, peril: e.target.value })}
            >
              <option value="">— select —</option>
              {carrier.perils.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label mb-1.5">{label}</div>
      {children}
    </div>
  );
}
