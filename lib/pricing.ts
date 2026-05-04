import type { AddOn, Assumptions, Material, Pitch } from "@/types/estimate";

export const MATERIAL_RATES: Record<Material, { label: string; rate: number }> = {
  "asphalt-3tab": { label: "Asphalt 3-Tab", rate: 4.5 },
  "asphalt-architectural": { label: "Architectural Shingle", rate: 6.25 },
  "metal-standing-seam": { label: "Metal Standing Seam", rate: 12.0 },
  "tile-concrete": { label: "Concrete Tile", rate: 10.5 },
};

export const PITCH_FACTOR: Record<Pitch, number> = {
  "4/12": 1.0,
  "5/12": 1.05,
  "6/12": 1.12,
  "7/12": 1.2,
  "8/12+": 1.32,
};

export const DEFAULT_ADDONS: AddOn[] = [
  { id: "ice-water", label: "Ice & Water Shield", price: 850, enabled: false },
  { id: "ridge-vent", label: "Ridge Vent", price: 425, enabled: false },
  { id: "solar-ready", label: "Solar Ready Prep", price: 1200, enabled: false },
  { id: "gutters", label: "Seamless Gutters", price: 1850, enabled: false },
  { id: "skylight", label: "Skylight Replacement", price: 950, enabled: false },
  { id: "drip-edge", label: "Drip Edge Upgrade", price: 320, enabled: false },
];

export function computeBase(a: Assumptions): { low: number; high: number; mid: number } {
  const rate = MATERIAL_RATES[a.material].rate * a.materialMultiplier;
  const labor = 3.25 * a.laborMultiplier;
  const pitch = PITCH_FACTOR[a.pitch];
  const perSqft = (rate + labor) * pitch;
  const mid = a.sqft * perSqft;
  return { low: mid * 0.92, high: mid * 1.12, mid };
}

export function computeTotal(a: Assumptions, addOns: AddOn[]): number {
  const { mid } = computeBase(a);
  const adds = addOns.filter((x) => x.enabled).reduce((s, x) => s + x.price, 0);
  return Math.round(mid + adds);
}

export function fmt(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
