// lib/sources/vision-mappers.ts
import type { Material, RoofObject } from "@/types/roof";
import type { RoofVision } from "@/types/estimate";

export function mapPenetrationKind(
  k: RoofVision["penetrations"][number]["kind"],
): RoofObject["kind"] {
  if (k === "vent") return "vent";
  if (k === "chimney") return "chimney";
  if (k === "skylight") return "skylight";
  if (k === "stack") return "stack";
  if (k === "satellite-dish") return "satellite-dish";
  return "vent"; // "other" -> treat as vent for pipe-boot purposes
}

export function defaultDimForKind(
  k: RoofVision["penetrations"][number]["kind"],
): number {
  if (k === "chimney") return 3;
  if (k === "skylight") return 3;
  return 0.75;
}

export function mapVisionMaterial(m: RoofVision["currentMaterial"]): Material | null {
  if (m === "unknown") return null;
  if (m === "asphalt-3tab") return "asphalt-3tab";
  if (m === "asphalt-architectural") return "asphalt-architectural";
  if (m === "metal-standing-seam") return "metal-standing-seam";
  if (m === "tile-concrete") return "tile-concrete";
  if (m === "wood-shake") return "wood-shake";
  if (m === "flat-membrane") return "flat-membrane";
  return null;
}

/**
 * Map vision penetrations to Tier C RoofObjects. Position is the address
 * center (no per-facet positioning in Tier C); Tier B refines.
 */
export function visionPenetrationsToObjects(
  address: { lat: number; lng: number },
  vision: RoofVision | null,
): RoofObject[] {
  if (!vision) return [];
  return vision.penetrations.map((p, idx) => ({
    id: `obj-${idx}`,
    kind: mapPenetrationKind(p.kind),
    position: { lat: address.lat, lng: address.lng, heightM: 0 },
    dimensionsFt: {
      width: p.approxSizeFt ?? defaultDimForKind(p.kind),
      length: p.approxSizeFt ?? defaultDimForKind(p.kind),
    },
    facetId: null,
  }));
}
