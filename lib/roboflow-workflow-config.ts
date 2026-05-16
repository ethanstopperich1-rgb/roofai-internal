/**
 * Roboflow SAM3 Workflow — shared configuration constants.
 *
 * Two places consume this:
 *   - app/api/sam3-roof/route.ts  (the actual inference call)
 *   - app/api/healthz/route.ts    (the URL-resolves liveness probe)
 *
 * Centralizing here keeps the workflow URL / prompt / confidence
 * floors in lockstep across both files. Earlier the URL was
 * duplicated and drifted — fixed in this module.
 *
 * Override these per deploy via env vars when the workflow gets
 * republished (Roboflow assigns a new ID on every publish) or moves
 * to a different workspace.
 */

/** Default workflow URL — points at `bradens-workspace/sam3-roof-
 *  segmentation-test-1778124556737`. Override via
 *  ROBOFLOW_SAM3_WORKFLOW_URL when the workflow is republished. */
const DEFAULT_WORKFLOW_URL =
  "https://serverless.roboflow.com/infer/workflows/bradens-workspace/sam3-roof-segmentation-test-1778124556737";

export const SAM3_WORKFLOW_URL =
  process.env.ROBOFLOW_SAM3_WORKFLOW_URL ?? DEFAULT_WORKFLOW_URL;

/** SAM3 segmentation prompt. Matches the workflow's Roboflow-side
 *  configuration — kept in lockstep. Override via ROBOFLOW_SAM3_PROMPT. */
export const SAM3_PROMPT =
  process.env.ROBOFLOW_SAM3_PROMPT ?? "entire house roof";

/** Confidence floor passed to the workflow. Workflow default is 0.3. */
export const SAM3_CONFIDENCE = Number(
  process.env.ROBOFLOW_SAM3_CONFIDENCE ?? "0.3",
);

// ─── SAM2 surface segmentation (Phase 2) ───────────────────────────────
//
// Distinct from SAM3 above: SAM3 produces the OUTER roof outline polygon
// for the whole house. SAM2 runs INSIDE that polygon and classifies each
// roof surface (main shingle, lanai screen, skylight, garage, etc.).
//
// Env-gated with an empty default so production builds don't break when
// the workflow URL isn't set yet — the route + pipeline both check
// `isSam2Configured()` and degrade gracefully (returns empty surfaces
// list). When the user creates the Roboflow workflow, set:
//
//   ROBOFLOW_SAM2_WORKFLOW_URL=https://serverless.roboflow.com/infer/workflows/<workspace>/<workflow-id>
//   ROBOFLOW_SAM2_CONFIDENCE=0.4  (optional — default 0.4)
//
// in the Vercel project's env vars. No code redeploy needed to activate.

import type { SurfaceClass } from "@/types/estimate";

/** Roboflow SAM2 workflow URL. Empty string → not configured, route
 *  returns 200 with `surfaces: []` (no-op). Override at deploy time
 *  with ROBOFLOW_SAM2_WORKFLOW_URL. */
export const SAM2_WORKFLOW_URL = process.env.ROBOFLOW_SAM2_WORKFLOW_URL ?? "";

/** Class list passed to the SAM2 workflow as the segmentation prompt.
 *  Order matters — Roboflow's prompted-segmentation blocks treat the
 *  list as a comma-separated prompt where earlier classes get
 *  segmentation priority. "main_shingle" first so the bulk of any
 *  residential roof gets the right primary class. "unknown" is NOT
 *  prompted (the workflow can't be asked to detect "unknown") — it's
 *  reserved as a server-side fallback when the workflow returns a
 *  class string the type system doesn't know. */
export const SAM2_CLASSES: SurfaceClass[] = [
  "main_shingle",
  "flat_roof",
  "lanai_screen",
  "garage",
  "skylight",
  "solar_panel",
  "pool",
  "driveway",
];

/** Natural-language prompts sent to SAM3's text-prompted segmenter, in
 *  the same order as SAM2_CLASSES. SAM3 ("Run SAM3 with text prompts for
 *  zero-shot segmentation") expects everyday language — "main_shingle"
 *  segments poorly because SAM3 was trained on captions, not snake_case
 *  enum strings. The workflow `sam3-roof-surface-segmentation-voxaris`
 *  built via MCP on 2026-05-15 uses these strings as `classes` input.
 *
 *  Response classes coming back through this layer get normalized back
 *  to SurfaceClass via `normalizeClass()` in app/api/sam2-surfaces — that
 *  routine handles every variant ("shingle", "main_shingle", "Main
 *  Shingle Roof") so this list can stay human-readable. */
export const SAM2_PROMPT_CLASSES: string[] = [
  "main shingle roof",
  "flat roof",
  "lanai screen enclosure",
  "garage roof",
  "skylight",
  "solar panel",
  "swimming pool",
  "driveway",
];

/** Confidence floor for SAM2 predictions. Slightly higher than SAM3's
 *  0.3 because we're classifying inside a known building, so low-
 *  confidence noise predictions are more likely garbage than they are
 *  hard-to-segment edges of the actual roof. */
export const SAM2_CONFIDENCE = Number(
  process.env.ROBOFLOW_SAM2_CONFIDENCE ?? "0.4",
);

/** Whether SAM2 is wired up for this deploy. Both the API route and
 *  the pipeline integration check this before doing any work — when
 *  false, callers should treat surfaces as a no-op (empty list, no
 *  upstream call, no logged error). Keeps Phase 2 strictly additive. */
export function isSam2Configured(): boolean {
  return SAM2_WORKFLOW_URL.length > 0;
}
