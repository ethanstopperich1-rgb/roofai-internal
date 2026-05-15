"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, MinusCircle, Loader2 } from "lucide-react";

/**
 * components/roof/LidarHealthChip.tsx
 *
 * Compact status chip showing whether Tier A (the Modal LiDAR service)
 * is reachable. Lives near the top of the rep view so the partner can
 * tell at a glance whether the URL/deploy is set up correctly — without
 * this, a misconfigured Modal URL is invisible (the pipeline falls
 * through to Tier C silently and looks "fine").
 *
 * Polls /api/lidar-health once on mount + on demand. The endpoint
 * always returns 200; the chip color is driven by the `state` field
 * in the JSON payload.
 */

type Health =
  | { state: "loading" }
  | { state: "unconfigured" }
  | {
      state: "configured";
      healthUrl: string;
      submitUrl: string;
      latencyMs: number;
      isModal: boolean;
      service?: { service?: string };
    }
  | {
      state: "unreachable";
      healthUrl: string;
      submitUrl: string;
      status?: number;
      error?: string;
      hint?: string;
      isModal?: boolean;
    }
  | { state: "malformed"; url: string; error: string; hint?: string };

export function LidarHealthChip() {
  const [h, setH] = useState<Health>({ state: "loading" });
  const [open, setOpen] = useState(false);

  async function fetchHealth(): Promise<Health> {
    try {
      const r = await fetch("/api/lidar-health", { cache: "no-store" });
      return (await r.json()) as Health;
    } catch (err) {
      return {
        state: "unreachable",
        healthUrl: "(client error)",
        submitUrl: "(client error)",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Explicit re-check (button click) — shows loading, then results.
  async function check() {
    setH({ state: "loading" });
    setH(await fetchHealth());
  }

  // Initial fetch on mount. Don't synchronously set loading here —
  // the initial useState is already "loading", and re-setting it in
  // the effect body trips react-hooks/set-state-in-effect.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await fetchHealth();
      if (!cancelled) setH(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const tone =
    h.state === "configured"
      ? "border-emerald-400/30 bg-emerald-400/[0.06] text-emerald-200"
      : h.state === "loading"
        ? "border-white/[0.07] bg-white/[0.03] text-white/55"
        : h.state === "unconfigured"
          ? "border-white/[0.07] bg-white/[0.03] text-white/55"
          : "border-amber-400/30 bg-amber-400/[0.06] text-amber-200";

  const Icon =
    h.state === "configured"
      ? CheckCircle2
      : h.state === "loading"
        ? Loader2
        : h.state === "unconfigured"
          ? MinusCircle
          : AlertTriangle;

  const label =
    h.state === "configured"
      ? `Tier A · LiDAR ready (${h.latencyMs}ms)`
      : h.state === "loading"
        ? "Tier A · checking…"
        : h.state === "unconfigured"
          ? "Tier A · not configured"
          : h.state === "malformed"
            ? "Tier A · URL malformed"
            : "Tier A · unreachable";

  return (
    <div className={`rounded-xl border ${tone} text-[12px]`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2"
        aria-expanded={open}
      >
        <Icon
          size={13}
          className={h.state === "loading" ? "animate-spin" : ""}
        />
        <span className="font-mono tracking-wide">{label}</span>
        <span className="ml-auto text-[10.5px] opacity-60">
          {open ? "Hide" : "Details"}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-1 text-[11px] font-mono leading-relaxed">
          {h.state === "configured" && (
            <>
              <div>health: {h.healthUrl}</div>
              <div>submit: {h.submitUrl}</div>
              {h.service?.service && <div>service: {h.service.service}</div>}
              <div className="opacity-70">
                Estimates against this address will route to Tier A.
              </div>
            </>
          )}
          {h.state === "unconfigured" && (
            <>
              <div className="opacity-80">
                LIDAR_SERVICE_URL is not set on this deployment.
              </div>
              <div className="opacity-70">
                Deploy services/roof-lidar/ to Modal and paste the{" "}
                <code>...-submit.modal.run</code> URL into Vercel project env.
              </div>
            </>
          )}
          {h.state === "malformed" && (
            <>
              <div className="opacity-80">value: {h.url}</div>
              <div className="opacity-80">error: {h.error}</div>
              {h.hint && <div className="opacity-70">{h.hint}</div>}
            </>
          )}
          {h.state === "unreachable" && (
            <>
              <div>health: {h.healthUrl}</div>
              <div>submit: {h.submitUrl}</div>
              {"status" in h && h.status != null && <div>HTTP: {h.status}</div>}
              {h.error && <div className="opacity-80">error: {h.error}</div>}
              {h.hint && <div className="opacity-70">{h.hint}</div>}
            </>
          )}
          <button
            type="button"
            onClick={() => void check()}
            className="mt-1 text-[10.5px] underline decoration-dotted opacity-70 hover:opacity-100"
          >
            Re-check
          </button>
        </div>
      )}
    </div>
  );
}
