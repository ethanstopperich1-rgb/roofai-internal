"use client";

import { Copy, FileDown, Mail, Save, Check } from "lucide-react";
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
  const save = () => {
    saveEstimate(estimate);
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
    onSaved?.();
  };

  return (
    <div className="flex flex-wrap gap-2">
      <button className="btn btn-ghost" onClick={copy}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
        {copied ? "Copied" : "Copy Summary"}
      </button>
      <button className="btn btn-ghost" onClick={pdf}>
        <FileDown size={16} /> PDF Proposal
      </button>
      <button className="btn btn-ghost" onClick={email}>
        <Mail size={16} /> Email Customer
      </button>
      <button className="btn btn-primary" onClick={save}>
        {saved ? <Check size={16} /> : <Save size={16} />}
        {saved ? "Saved" : "Save to History"}
      </button>
    </div>
  );
}
