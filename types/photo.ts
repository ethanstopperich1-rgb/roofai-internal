/**
 * Field-photo metadata. Captured on upload, persisted with the estimate,
 * embedded in the proposal PDF + claim packet.
 */
export type PhotoTagKind =
  | "missing-shingles"
  | "lifted-shingle"
  | "hail-impact"
  | "granule-loss"
  | "moss-algae"
  | "discoloration"
  | "tarp"
  | "ponding"
  | "damaged-flashing"
  | "damaged-vent"
  | "damaged-chimney"
  | "soffit-fascia-damage"
  | "gutter-damage"
  | "skylight-damage"
  | "drip-edge"
  | "ridge-vent"
  | "valley"
  | "general-context"
  | "interior-leak"
  | "other";

export interface PhotoTag {
  kind: PhotoTagKind;
  /** 0–1 confidence */
  confidence: number;
  /** Free-text caption for the homeowner / adjuster proposal */
  caption?: string;
}

export interface PhotoLocation {
  /** GPS latitude from EXIF when available */
  lat?: number;
  /** GPS longitude from EXIF when available */
  lng?: number;
  /** Camera direction the photo was taken (0=N, 90=E, …) */
  bearingDeg?: number;
}

export interface PhotoMeta {
  /** UUID-like, unique per upload */
  id: string;
  /** Public URL — Vercel Blob in prod, data: URI fallback in dev */
  url: string;
  /** Original filename when uploaded */
  filename: string;
  /** ISO timestamp the photo was TAKEN (from EXIF) — falls back to upload time */
  takenAt: string;
  /** ISO timestamp it landed in our storage */
  uploadedAt: string;
  /** Bytes */
  sizeBytes: number;
  /** Pixel dimensions */
  width?: number;
  height?: number;
  /** GPS / heading from EXIF */
  location?: PhotoLocation;
  /** AI-generated damage tags + caption */
  tags: PhotoTag[];
  /** AI summary in one sentence */
  caption?: string;
  /** Whether the photo metadata appears valid for an insurance claim
   *  (has EXIF timestamp + GPS + recent date). Drives the green/amber
   *  "claim-ready" badge in the UI. */
  claimReady: boolean;
}
