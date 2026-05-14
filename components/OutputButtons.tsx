"use client";

import { Copy, FileDown, Mail, Save, Check, Link as LinkIcon } from "lucide-react";
import { useState } from "react";
import type { Estimate } from "@/types/estimate";
import { buildSummaryText, generatePdf } from "@/lib/pdf";
import { saveEstimate } from "@/lib/storage";

interface Props {
  estimate: Estimate;
  onSaved?: () => void;
  /** Optional override for the FULL save flow (localStorage + Supabase).
   *  When provided, the visible Save button calls this INSTEAD of the
   *  built-in legacy persist path (saveEstimate + POST /api/proposals
   *  with v1 snapshot). The /internal page now uses this to send a v2
   *  EstimateV2 snapshot to BOTH localStorage (via saveEstimateV2) AND
   *  Supabase (via its own POST) — so the dashboard sees v2 proposals
   *  from rep-tool saves, not just v1 projections. v1-only callers
   *  (/quote ingest, embeds) keep omitting it and get the legacy path. */
  onSave?: () => void | Promise<void>;
  /** Optional — when the rep opened this estimator from an existing lead
   *  drawer (or from a /quote ingest where we know the lead public_id),
   *  passing it here lets /api/proposals do an exact match by id rather
   *  than guessing via address. Strongest signal. */
  leadPublicId?: string;
  /** Optional — customer email. Used as a fallback by /api/proposals
   *  when the explicit leadPublicId isn't set AND the formatted address
   *  doesn't match (Maps autocomplete sometimes rewrites the string
   *  between /quote and the rep tool). */
  customerEmail?: string;
  /** Business slug the proposal belongs to — drives `office_id` on the
   *  proposals row in Supabase + which dashboard sees it. Defaults to
   *  "voxaris" (platform) when unset, so legacy callers keep working. */
  office?: string;
}

export default function OutputButtons({
  estimate,
  onSaved,
  onSave,
  leadPublicId,
  customerEmail,
  office,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [linked, setLinked] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(buildSummaryText(estimate));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  const pdf = () => generatePdf(estimate);
  const email = () => {
    const subject = encodeURIComponent(`Roofing Estimate — ${estimate.address.formatted}`);
    const body = encodeURIComponent(buildSummaryText(estimate));
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };
  /** Persist the estimate to BOTH localStorage (the local fallback /
   *  rep history view) AND Supabase via /api/proposals (the cross-
   *  device share-link path). The Supabase POST is fire-and-forget so
   *  the UI still reports "saved" instantly; failure logs a warning
   *  and the localStorage copy still works for the rep's own browser.
   *
   *  When onSave is provided (i.e. from /internal), the CALLER owns the
   *  full save flow — both the localStorage write AND the Supabase POST.
   *  We don't double-up here because /internal sends a v2 snapshot while
   *  this default path would re-POST a v1 projection, leaving Supabase
   *  with the inferior shape. v1-only callers (/quote ingest, embeds)
   *  keep using the legacy path below. */
  const persist = () => {
    if (onSave) {
      void onSave();
      return;
    }
    saveEstimate(estimate);
    void fetch("/api/proposals", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        estimate,
        // Tenancy — drops the proposal into the right office_id.
        ...(office ? { office } : {}),
        // Optional resolution hints — /api/proposals uses these to
        // attach the proposal to the right lead row. Both safely fall
        // back to address-based matching when undefined.
        ...(leadPublicId ? { leadPublicId } : {}),
        ...(customerEmail ? { email: customerEmail } : {}),
      }),
    }).catch((err) => console.warn("[output] supabase save failed:", err));
  };

  const save = () => {
    persist();
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
    onSaved?.();
  };
  const shareLink = async () => {
    persist();
    const url = `${window.location.origin}/p/${estimate.id}`;
    await navigator.clipboard.writeText(url);
    setLinked(true);
    setTimeout(() => setLinked(false), 1800);
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <SecondaryAction onClick={copy} icon={copied ? <Check size={14} /> : <Copy size={14} />} label={copied ? "Copied" : "Copy"} active={copied} />
        <SecondaryAction onClick={pdf} icon={<FileDown size={14} />} label="PDF" />
        <SecondaryAction onClick={email} icon={<Mail size={14} />} label="Email" />
        <SecondaryAction onClick={shareLink} icon={linked ? <Check size={14} /> : <LinkIcon size={14} />} label={linked ? "Link copied" : "Share link"} active={linked} />
      </div>
      <button className="glass-button-primary w-full" style={{ paddingTop: "0.85rem", paddingBottom: "0.85rem" }} onClick={save}>
        {saved ? <Check size={15} /> : <Save size={15} />}
        {saved ? "Saved to history" : "Save to History"}
      </button>
    </div>
  );
}

function SecondaryAction({
  onClick,
  icon,
  label,
  active,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center justify-center gap-1.5 py-3 rounded-xl border text-[12px] font-medium transition ${
        active
          ? "border-mint/40 bg-mint/[0.08] text-mint"
          : "border-white/[0.06] bg-white/[0.015] text-slate-200 hover:border-white/[0.13] hover:bg-white/[0.04]"
      }`}
    >
      <span className={active ? "text-mint" : "text-slate-400"}>{icon}</span>
      {label}
    </button>
  );
}
