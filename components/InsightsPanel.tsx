"use client";

import { useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import type { Estimate } from "@/types/estimate";

export default function InsightsPanel({ estimate }: { estimate: Estimate }) {
  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  const run = async () => {
    setLoading(true);
    setError("");
    setText("");
    try {
      const res = await fetch("/api/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: estimate.address.formatted,
          zip: estimate.address.zip,
          sqft: estimate.assumptions.sqft,
          pitch: estimate.assumptions.pitch,
          material: estimate.assumptions.material,
          ageYears: estimate.assumptions.ageYears,
          total: estimate.total,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setText(data.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 font-bold">
          <Sparkles size={16} className="text-sky-400" /> AI Sales Insights
        </div>
        <button className="btn btn-ghost py-1.5 px-3 text-sm" onClick={run} disabled={loading}>
          {loading ? <Loader2 size={14} className="animate-spin" /> : "Generate"}
        </button>
      </div>
      {error && <div className="text-xs text-rose-400">{error}</div>}
      {text && (
        <pre className="text-sm whitespace-pre-wrap font-sans text-slate-300 leading-relaxed">{text}</pre>
      )}
      {!text && !error && !loading && (
        <div className="text-xs text-slate-500">Click Generate for tactical sales notes from Gemini.</div>
      )}
    </div>
  );
}
