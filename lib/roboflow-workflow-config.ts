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
