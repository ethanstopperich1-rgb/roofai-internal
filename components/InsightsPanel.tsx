"use client";

import { useEffect, useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import type { Estimate } from "@/types/estimate";

export default function InsightsPanel({ estimate }: { estimate: Estimate }) {
  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  // Clear previous AI notes whenever the address changes (otherwise the last
  // house's sales notes linger on screen for the next estimate).
  useEffect(() => {
    setText("");
    setError("");
    setLoading(false);
  }, [estimate.address.formatted, estimate.address.lat, estimate.address.lng]);

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
    <div className="glass rounded-3xl p-5 relative overflow-hidden">
      <div
        className="absolute -top-12 -left-8 w-56 h-56 blur-3xl pointer-events-none opacity-50"
        style={{ background: "radial-gradient(closest-side, rgba(95,227,176,0.10), transparent)" }}
      />
      <div className="relative flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-mint/10 border border-mint/20 flex items-center justify-center text-mint">
            <Sparkles size={13} />
          </div>
          <div>
            <div className="font-display font-semibold tracking-tight text-[14px]">AI Sales Insights</div>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-slate-500 -mt-0.5">
              Pitch Intelligence
            </div>
          </div>
        </div>
        <button onClick={run} disabled={loading} className="btn btn-ghost py-1.5 px-3 text-[12px]">
          {loading ? <Loader2 size={12} className="animate-spin" /> : "Generate"}
        </button>
      </div>
      {error && (
        <div className="text-[12px] text-rose px-3 py-2 rounded-lg bg-rose/[0.08] border border-rose/20">
          {error}
        </div>
      )}
      {text && (
        <div className="rounded-2xl p-4 bg-black/20 border border-white/[0.05]">
          <pre className="text-[13px] whitespace-pre-wrap font-sans text-slate-200 leading-relaxed">
            {text}
          </pre>
        </div>
      )}
      {!text && !error && !loading && (
        <div className="text-[12px] text-slate-500 leading-relaxed">
          Tactical sales notes — likely concerns, upsell opportunities, common objections.
        </div>
      )}
    </div>
  );
}
