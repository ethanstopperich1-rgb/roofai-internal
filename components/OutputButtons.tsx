"use client";

import { Copy, FileDown, Mail, Save, Check, Link as LinkIcon } from "lucide-react";
import { useState } from "react";
import type { Estimate } from "@/types/estimate";
import { buildSummaryText, generatePdf } from "@/lib/pdf";
import { saveEstimate } from "@/lib/storage";

interface Props {
  estimate: Estimate;
  onSaved?: () => void;
}

export default function OutputButtons({ estimate, onSaved }: Props) {
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
   *  and the localStorage copy still works for the rep's own browser. */
  const persist = () => {
    saveEstimate(estimate);
    void fetch("/api/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estimate }),
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
