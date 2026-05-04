import type { Estimate } from "@/types/estimate";

const KEY = "roofai.estimates";

export function loadEstimates(): Estimate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Estimate[]) : [];
  } catch {
    return [];
  }
}

export function saveEstimate(e: Estimate): void {
  if (typeof window === "undefined") return;
  const list = loadEstimates();
  const existing = list.findIndex((x) => x.id === e.id);
  if (existing >= 0) list[existing] = e;
  else list.unshift(e);
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, 200)));
}

export function deleteEstimate(id: string): void {
  if (typeof window === "undefined") return;
  const list = loadEstimates().filter((e) => e.id !== id);
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function getEstimate(id: string): Estimate | undefined {
  return loadEstimates().find((e) => e.id === id);
}

export function newId(): string {
  return `est_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
