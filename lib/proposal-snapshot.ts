/**
 * Safe accessor for the `proposals.snapshot` JSONB column. The column
 * stores an `Estimate` (types/estimate.ts) verbatim, but the generated
 * Supabase row type is `Json` — a structural union that defeats type
 * narrowing on read. This helper pulls the dashboard-relevant fields
 * with defensive guards so a malformed historical row never crashes
 * the rep's lead drawer.
 *
 * Only the fields the dashboard needs to summarize are extracted here.
 * The full estimate is still available via the share link at /p/[id].
 */

import type { Json } from "@/types/supabase";

export interface ProposalSummary {
  material: string | null;
  sqft: number | null;
  pitch: string | null;
  addOnCount: number;
  addOnLabels: string[];
  lineItemCount: number;
  total: number | null;
  totalLow: number | null;
  totalHigh: number | null;
  isInsuranceClaim: boolean;
  hasPhotos: boolean;
  photoCount: number;
  staff: string | null;
  notes: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function summarizeProposalSnapshot(snapshot: Json | null): ProposalSummary {
  const empty: ProposalSummary = {
    material: null,
    sqft: null,
    pitch: null,
    addOnCount: 0,
    addOnLabels: [],
    lineItemCount: 0,
    total: null,
    totalLow: null,
    totalHigh: null,
    isInsuranceClaim: false,
    hasPhotos: false,
    photoCount: 0,
    staff: null,
    notes: null,
  };
  if (!isRecord(snapshot)) return empty;

  const assumptions = isRecord(snapshot.assumptions) ? snapshot.assumptions : {};
  const addOnsRaw = Array.isArray(snapshot.addOns) ? snapshot.addOns : [];
  const enabledAddOns = addOnsRaw.filter(
    (a) => isRecord(a) && a.enabled === true,
  ) as Array<Record<string, unknown>>;
  const detailed = isRecord(snapshot.detailed) ? snapshot.detailed : null;
  const lineItems = detailed && Array.isArray(detailed.lineItems) ? detailed.lineItems : [];
  const photos = Array.isArray(snapshot.photos) ? snapshot.photos : [];

  return {
    material: asString(assumptions.material) ?? asString(snapshot.material),
    sqft: asNumber(assumptions.sqft) ?? asNumber(snapshot.estimatedSqft),
    pitch: asString(assumptions.pitch),
    addOnCount: enabledAddOns.length,
    addOnLabels: enabledAddOns
      .map((a) => asString(a.label))
      .filter((s): s is string => s !== null)
      .slice(0, 4),
    lineItemCount: lineItems.length,
    total: asNumber(snapshot.total),
    totalLow: asNumber(snapshot.baseLow),
    totalHigh: asNumber(snapshot.baseHigh),
    isInsuranceClaim: snapshot.isInsuranceClaim === true,
    hasPhotos: photos.length > 0,
    photoCount: photos.length,
    staff: asString(snapshot.staff),
    notes: asString(snapshot.notes),
  };
}

/** Pretty material label — converts "asphalt-architectural" → "Architectural shingle" */
export function fmtMaterial(raw: string | null): string {
  if (!raw) return "—";
  const map: Record<string, string> = {
    "asphalt-3tab": "3-tab asphalt",
    "asphalt-architectural": "Architectural shingle",
    "metal-standing-seam": "Metal · standing seam",
    "tile-concrete": "Concrete tile",
  };
  return map[raw] ?? raw;
}
