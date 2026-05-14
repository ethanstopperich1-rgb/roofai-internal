// lib/storage.ts
import type { Estimate } from "@/types/estimate";
import type { EstimateV2, LoadedEstimate } from "@/types/roof";

const STORAGE_KEY = "roofai.estimates"; // same blob holds both shapes

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Tag a raw estimate row as v1 or v2 (for renderer branching). */
export function tagEstimate(raw: unknown): LoadedEstimate | null {
  if (!isRecord(raw)) return null;
  const result: LoadedEstimate =
    raw.version === 2 && isRecord(raw.roofData)
      ? { kind: "v2", estimate: raw as unknown as EstimateV2 }
      : { kind: "v1", estimate: raw as unknown as Estimate };
  if (typeof window !== "undefined") {
    console.log("[telemetry] estimate_loaded_legacy_vs_v2", {
      id: result.estimate.id,
      kind: result.kind,
    });
  }
  return result;
}

/** Raw load — returns mixed v1/v2 estimates (tagged). */
export function loadEstimatesTagged(): LoadedEstimate[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(tagEstimate)
      .filter((x): x is LoadedEstimate => x !== null);
  } catch {
    return [];
  }
}

/** Back-compat: returns only legacy v1 estimates. */
export function loadEstimates(): Estimate[] {
  return loadEstimatesTagged()
    .filter((x): x is { kind: "v1"; estimate: Estimate } => x.kind === "v1")
    .map((x) => x.estimate);
}

// Cap the rolodex to keep localStorage from growing unbounded over time.
// Matches the pre-Tier-C behavior; same cap covers both v1 and v2 entries.
const MAX_STORED_ESTIMATES = 200;

/** Save a v2 estimate. New estimates always save as v2. */
export function saveEstimateV2(e: EstimateV2): void {
  if (typeof window === "undefined") return;
  const all = loadAllRaw();
  const updated = [
    e,
    ...all.filter((r) => !isRecord(r) || r.id !== e.id),
  ].slice(0, MAX_STORED_ESTIMATES);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

/** Save a legacy v1 estimate. Kept for callers that haven't migrated yet;
 *  new code should use `saveEstimateV2`. */
export function saveEstimate(e: Estimate): void {
  if (typeof window === "undefined") return;
  const all = loadAllRaw();
  const updated = [
    e,
    ...all.filter((r) => !isRecord(r) || r.id !== e.id),
  ].slice(0, MAX_STORED_ESTIMATES);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function deleteEstimate(id: string): void {
  if (typeof window === "undefined") return;
  const all = loadAllRaw();
  const updated = all.filter((r) => isRecord(r) && r.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function getEstimateTagged(id: string): LoadedEstimate | null {
  return (
    loadEstimatesTagged().find((x) => x.estimate.id === id) ?? null
  );
}

export function getEstimate(id: string): Estimate | undefined {
  return loadEstimates().find((e) => e.id === id);
}

export function newId(): string {
  return `est_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function loadAllRaw(): unknown[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
