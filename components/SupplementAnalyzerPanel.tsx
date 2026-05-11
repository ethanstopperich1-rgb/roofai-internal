"use client";

import { useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Copy,
  FileText,
  Loader2,
  ShieldAlert,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import type { Assumptions } from "@/types/estimate";
import type { ClaimContext } from "@/lib/carriers";

interface ExtractedScope {
  lineItems: Array<{
    description: string;
    quantity?: number | null;
    unit?: string | null;
    unitCost?: number | null;
    extended?: number | null;
    xactimateCode?: string | null;
  }>;
  carrierSubtotal: number | null;
  carrierHasOP: boolean;
  dateOfLoss: string | null;
  carrierName: string | null;
  deductible: number | null;
}

interface SupplementFlag {
  rule: {
    id: string;
    title: string;
    rationale: string;
    xactimateCode: string;
    severity: "required" | "expected" | "common" | "advisory";
  };
  reason: string;
  estimatedDollars: number | null;
}

interface AnalyzerResponse {
  extracted: ExtractedScope;
  mrmsContext: {
    eventsNearDateOfLoss: Array<{
      date: string;
      inches: number;
      distanceMiles: number;
    }>;
  } | null;
  flags: SupplementFlag[];
  stats: {
    totalRecommended: number;
    estimatedDollarsRecovered: number | null;
  };
  parserSource: "qwen" | "claude-fallback" | "none";
}

interface Props {
  assumptions: Assumptions;
  claim: ClaimContext;
  state?: string | null;
  propertyLat?: number | null;
  propertyLng?: number | null;
}

const SEVERITY_STYLE: Record<
  SupplementFlag["rule"]["severity"],
  { label: string; pillCls: string; rowCls: string; icon: typeof AlertCircle }
> = {
  required: {
    label: "Required",
    pillCls: "bg-rose/15 border-rose/40 text-rose",
    rowCls: "border-rose/25 bg-rose/[0.04]",
    icon: ShieldAlert,
  },
  expected: {
    label: "Expected",
    pillCls: "bg-amber/15 border-amber/40 text-amber",
    rowCls: "border-amber/25 bg-amber/[0.04]",
    icon: AlertTriangle,
  },
  common: {
    label: "Common",
    pillCls: "bg-cy-300/15 border-cy-300/40 text-cy-200",
    rowCls: "border-cy-300/15 bg-cy-300/[0.03]",
    icon: AlertCircle,
  },
  advisory: {
    label: "Advisory",
    pillCls: "bg-white/[0.06] border-white/[0.12] text-slate-300",
    rowCls: "border-white/[0.06] bg-white/[0.015]",
    icon: AlertCircle,
  },
};

export default function SupplementAnalyzerPanel({
  assumptions,
  claim,
  state,
  propertyLat,
  propertyLng,
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzerResponse | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const reset = () => {
    setFile(null);
    setResult(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const onFile = (f: File | null) => {
    if (!f) return;
    if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) {
      setError("File must be a PDF.");
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      setError("PDF too large (max 10 MB).");
      return;
    }
    setError(null);
    setFile(f);
    void analyze(f);
  };

  const analyze = async (f: File) => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("pdf", f);
      fd.append("assumptions", JSON.stringify(assumptions));
      if (state) fd.append("state", state);
      if (claim.carrier) fd.append("carrier", claim.carrier);
      if (propertyLat != null) fd.append("propertyLat", String(propertyLat));
      if (propertyLng != null) fd.append("propertyLng", String(propertyLng));
      const r = await fetch("/api/supplement", { method: "POST", body: fd });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      const data = (await r.json()) as AnalyzerResponse;
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="glass rounded-3xl p-5 relative overflow-hidden">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center bg-cy-300/10 border border-cy-300/20 text-cy-300">
            <Sparkles size={14} />
          </div>
          <div>
            <div className="font-display font-semibold tracking-tight text-[15px]">
              Supplement Analyzer
            </div>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-slate-500 -mt-0.5">
              Upload carrier scope · find missing items
            </div>
          </div>
        </div>
        {result && (
          <button
            onClick={reset}
            type="button"
            className="text-[11px] font-mono uppercase tracking-[0.12em] text-slate-400 hover:text-slate-200 inline-flex items-center gap-1.5"
          >
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* Drop zone OR file summary */}
      {!file && !result && (
        <DropZone
          dragActive={dragActive}
          onDragActive={setDragActive}
          onPick={() => inputRef.current?.click()}
          onDrop={(f) => onFile(f)}
        />
      )}
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
      />

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-3 px-4 py-5 rounded-2xl border border-white/[0.06] bg-white/[0.02]">
          <Loader2 size={16} className="text-cy-300 animate-spin shrink-0" />
          <div className="text-[13px] text-slate-300">
            Parsing carrier scope &amp; cross-referencing radar hail data…
            <span className="block text-[11px] text-slate-500 mt-0.5">
              Typically 5-15 seconds.
            </span>
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="rounded-2xl border border-rose/30 bg-rose/[0.05] px-4 py-3 text-[12.5px] text-rose flex items-start gap-2.5">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-medium">Couldn&apos;t analyze that PDF.</div>
            <div className="text-rose/80 mt-0.5">Re-upload or try a different file.</div>
          </div>
        </div>
      )}

      {/* Results */}
      {result && !loading && (
        <div className="space-y-4">
          <ScopeSummary scope={result.extracted} mrmsContext={result.mrmsContext} />
          <FlagsList flags={result.flags} stats={result.stats} />
          {result.flags.length === 0 && (
            <div className="rounded-2xl border border-mint/30 bg-mint/[0.05] px-4 py-3 text-[12.5px] text-mint flex items-center gap-2">
              <Check size={14} /> No supplement opportunities found — scope
              looks clean against the rule catalog.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────

function DropZone({
  dragActive,
  onDragActive,
  onPick,
  onDrop,
}: {
  dragActive: boolean;
  onDragActive: (v: boolean) => void;
  onPick: () => void;
  onDrop: (f: File) => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      onDragEnter={(e) => {
        e.preventDefault();
        onDragActive(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        onDragActive(false);
      }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDragActive(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onDrop(f);
      }}
      className={`w-full rounded-2xl border-2 border-dashed px-4 py-8 flex flex-col items-center gap-2 transition ${
        dragActive
          ? "border-cy-300/60 bg-cy-300/[0.04]"
          : "border-white/[0.10] bg-white/[0.012] hover:border-white/[0.20] hover:bg-white/[0.02]"
      }`}
    >
      <Upload size={20} className="text-cy-300" />
      <div className="text-[13.5px] text-slate-100 font-medium">
        Drop the carrier&apos;s Xactimate PDF here
      </div>
      <div className="text-[11.5px] text-slate-400">
        or click to upload · max 10 MB · text PDFs only (no scans yet)
      </div>
    </button>
  );
}

function ScopeSummary({
  scope,
  mrmsContext,
}: {
  scope: ExtractedScope;
  mrmsContext: AnalyzerResponse["mrmsContext"];
}) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.012] px-4 py-3 space-y-2">
      <div className="flex items-center gap-1.5 text-[10.5px] font-mono uppercase tracking-[0.14em] text-slate-400">
        <FileText size={11} className="text-cy-300" /> Scope detected
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[12.5px]">
        <Field label="Carrier" value={scope.carrierName ?? "—"} />
        <Field
          label="Date of loss"
          value={
            scope.dateOfLoss
              ? new Date(scope.dateOfLoss).toLocaleDateString()
              : "—"
          }
        />
        <Field
          label="Subtotal (RCV)"
          value={
            scope.carrierSubtotal != null
              ? `$${scope.carrierSubtotal.toLocaleString()}`
              : "—"
          }
        />
        <Field
          label="Line items"
          value={String(scope.lineItems.length)}
        />
      </div>
      {mrmsContext && mrmsContext.eventsNearDateOfLoss.length > 0 && (
        <div className="border-t border-white/[0.06] pt-2 mt-2">
          <div className="flex items-center gap-1.5 text-[10.5px] font-mono uppercase tracking-[0.14em] text-cy-300/90 mb-1.5">
            <ShieldAlert size={11} /> Radar evidence (NOAA MRMS, ±14d from DoL)
          </div>
          <div className="space-y-1">
            {mrmsContext.eventsNearDateOfLoss.slice(0, 3).map((e) => (
              <div
                key={e.date}
                className="flex items-center justify-between text-[12px] text-slate-200"
              >
                <span>
                  <span className="font-mono tabular text-amber font-medium">
                    {e.inches}&Prime;
                  </span>{" "}
                  hail at {e.distanceMiles} mi away
                </span>
                <span className="text-slate-500 font-mono tabular text-[11px]">
                  {e.date.length === 8
                    ? `${e.date.slice(4, 6)}/${e.date.slice(6, 8)}/${e.date.slice(2, 4)}`
                    : e.date}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-slate-500">
        {label}
      </div>
      <div className="text-slate-100 font-medium mt-0.5 truncate">
        {value}
      </div>
    </div>
  );
}

function FlagsList({
  flags,
  stats,
}: {
  flags: SupplementFlag[];
  stats: AnalyzerResponse["stats"];
}) {
  if (flags.length === 0) return null;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-slate-400">
          {stats.totalRecommended} item{stats.totalRecommended === 1 ? "" : "s"} flagged
        </div>
        {stats.estimatedDollarsRecovered != null && stats.estimatedDollarsRecovered > 0 && (
          <div className="text-[12px] text-slate-300">
            Est. recoverable:{" "}
            <span className="font-mono tabular font-semibold text-cy-200">
              ${stats.estimatedDollarsRecovered.toLocaleString()}+
            </span>
          </div>
        )}
      </div>
      <div className="space-y-2">
        {flags.map((flag, i) => (
          <FlagRow key={flag.rule.id + i} flag={flag} />
        ))}
      </div>
    </div>
  );
}

function FlagRow({ flag }: { flag: SupplementFlag }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const style = SEVERITY_STYLE[flag.rule.severity];
  const Icon = style.icon;
  const copy = async () => {
    const text = `Re: missing line "${flag.rule.title}" (Xactimate ${flag.rule.xactimateCode})\n\n${flag.rule.rationale}\n\nSpecific to this scope: ${flag.reason}`;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className={`rounded-2xl border px-4 py-3 ${style.rowCls}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 flex-1 min-w-0">
          <Icon size={14} className="text-slate-100 mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`text-[9.5px] font-mono uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-md border ${style.pillCls}`}
              >
                {style.label}
              </span>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-slate-500">
                {flag.rule.xactimateCode}
              </span>
              {flag.estimatedDollars != null && (
                <span className="font-mono tabular text-[12px] font-semibold text-cy-200">
                  ${flag.estimatedDollars.toLocaleString()}
                </span>
              )}
            </div>
            <div className="text-[13.5px] text-slate-100 font-medium mt-1">
              {flag.rule.title}
            </div>
            <div className="text-[12.5px] text-slate-300 mt-1 leading-relaxed">
              {flag.reason}
            </div>
            {expanded && (
              <div className="text-[12px] text-slate-400 mt-2 leading-relaxed border-t border-white/[0.06] pt-2">
                {flag.rule.rationale}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={copy}
            className="px-2 py-1 rounded-md bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[10.5px] font-mono uppercase tracking-[0.12em] text-slate-200 inline-flex items-center gap-1"
            aria-label="Copy supplement language"
          >
            {copied ? <Check size={10} /> : <Copy size={10} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-slate-500 hover:text-slate-300 mt-2"
      >
        {expanded ? "Hide rationale" : "Show rationale"}
      </button>
    </div>
  );
}
