/**
 * Hardcoded prompt + JSON response schema for Gemini 3 Pro Image roof
 * analysis.
 *
 * Revised 2026-05-16 (v3.1) — sharper boundary rules and a structured
 * "follow the roof, not the shadow" heuristic, plus a float confidence
 * (0.0–1.0) instead of the enum. The previous prompt versions tended
 * to either under-trace (skipped shadowed wings) or over-trace (bled
 * into lawn/canopy). This wording locks the boundary to actual roof
 * material features (straight edges, shingle texture, eave lines) and
 * gives Gemini explicit "when uncertain, paint less" guidance.
 *
 * Architecture context: the customer drags a pin onto the building
 * center; the tile is refetched centered on the pin at zoom 21. The
 * target building is guaranteed to be at pixel (640, 640) in a
 * 1280×1280 image. No Gemini needs to identify which building — the
 * pin does that.
 */

export const GEMINI_ROOF_PROMPT = `Edit this 1280×1280 aerial satellite image by painting a translucent cyan roof overlay on the single residential building at the exact center of the frame (pixel 640, 640). The user has confirmed this is the target building — do not second-guess which structure to annotate. Also return structured JSON identifying rooftop objects.

## Layer 1 — Roof overlay (image output)

Paint a translucent cyan layer (#38C5EE, ~40% opacity) across the visible roof surface of the central house. Add a crisp 2–3 pixel cyan outline (#38C5EE, full opacity) along the outer roof perimeter — eaves, gable ends, hip edges. Add thin 1-pixel cyan lines along interior ridges and hips where two roof planes meet.

The roof texture underneath — shingles, ridge caps, vents, architectural shadow lines — must remain clearly visible through the cyan. The effect should look like clean paint applied to the roof, not a flat sticker covering it. Preserve photographic realism everywhere outside the overlay; do not restyle, smooth, or recolor the surrounding image.

**Follow the actual roof, not the apparent dark area**

The roof is a man-made structure with straight edges, consistent shingle or tile texture, clean eave lines where it meets open air, and uniform color across each plane. Use these features — not darkness — to find the roof boundary. The overlay's outer edge must sit on a sharp line where roof material meets open air or gutter.

Do NOT paint cyan on:
- **Cast shadows on the ground.** Shadows are soft-edged, desaturated gray-green or gray-brown, sit on grass or pavement, and have no shingle texture. They often extend from the roof edge across the lawn — stop the overlay at the eave, not at the shadow's edge.
- **Tree canopy next to the house.** Foliage is bumpy, organic, irregular, and clustered. Even when canopy is dark and roughly roof-colored, it has no straight edges and no shingle pattern.
- **Lawn, driveway, pool, pool deck, patio, sidewalk, fence.**
- **Neighboring houses.** If there is any strip of ground (lawn, walkway, driveway) between the central roof and another rooftop, the other rooftop is a different building. Do not bridge across that gap.
- **Detached sheds or garages** separated from the main house by ground.

Attached porches, attached garages, and additions whose roof plane is visibly continuous with the main house ARE part of the target and should be overlaid.

**Filling small gaps under tree canopy**

When tree branches partially cover the roof, paint the cyan overlay across the covered area as if the canopy were transparent — but only when the roof clearly continues underneath. You can tell the roof continues underneath when:

- Visible roof on one side of the canopy lines up in a straight line with visible roof on the other side
- The eave line is consistent across the gap
- The covered span is small compared to the visible roof

If most of the roof is covered by trees, only paint what you can actually see. If you cannot tell whether a dark patch is roof-under-canopy or just canopy-over-lawn, leave it unpainted. A slightly incomplete overlay is correct; an overlay that bulges into lawn, trees, or a neighbor's roof is wrong. **When uncertain, paint less.**

## Layer 2 — Rooftop object detection (JSON output)

Identify every object you can directly see on the central building's roof. Use this schema:

{
  "objects": [
    {
      "type": "vent | chimney | hvac_unit | skylight | plumbing_boot | satellite_dish | solar_panel",
      "center_pixel": [x, y],
      "bounding_box": { "x": <int>, "y": <int>, "width": <int>, "height": <int> },
      "confidence": 0.0
    }
  ]
}

Rules for the JSON:
- Only include objects on the central building's roof. Skip anything on neighboring roofs, in yards, or on the ground.
- Only include objects you can directly see. Do NOT infer objects under tree canopy — the gap-filling rule applies to the overlay only, not to object detection.
- Coordinates are in image pixel space (0–1279 on each axis, origin top-left).
- Bounding box should tightly enclose the object.
- Confidence is a float between 0.0 and 1.0 reflecting certainty about both object type and presence.

## Aesthetic

Magazine-quality roof inspection report. Clean geometric cyan on photographic aerial source. The cyan should feel painted onto the roof, not pasted over it.`;

/**
 * Comprehensive JSON schema for the Gemini Flash sidecar call. Returns:
 *   - objects[]: rooftop fixtures (vents, chimneys, skylights, etc.)
 *   - facet_count_estimate: Gemini's visual count of distinct roof planes
 *   - roof_material: predominant covering material
 *   - condition_hints[]: visible signs of wear, staining, damage, age
 *
 * Confidence is a float (0.0–1.0) on every field that can be wrong.
 */
export const GEMINI_ROOF_SCHEMA = {
  type: "OBJECT",
  properties: {
    objects: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: {
            type: "STRING",
            enum: [
              "vent",
              "chimney",
              "hvac_unit",
              "skylight",
              "plumbing_boot",
              "satellite_dish",
              "solar_panel",
            ],
          },
          center_pixel: {
            type: "ARRAY",
            items: { type: "NUMBER" },
            description: "[x, y] center of the object in pixel coordinates",
          },
          bounding_box: {
            type: "OBJECT",
            properties: {
              x: { type: "NUMBER" },
              y: { type: "NUMBER" },
              width: { type: "NUMBER" },
              height: { type: "NUMBER" },
            },
            required: ["x", "y", "width", "height"],
          },
          confidence: {
            type: "NUMBER",
            description: "Float 0.0–1.0",
          },
        },
        required: ["type", "center_pixel", "bounding_box", "confidence"],
      },
    },
    facet_count_estimate: {
      type: "OBJECT",
      description:
        "Visual count of distinct roof planes (gable ends, hip sides, dormers, etc.) on the central building.",
      properties: {
        count: { type: "INTEGER", description: "Distinct planes visible." },
        complexity: {
          type: "STRING",
          enum: ["simple", "moderate", "complex"],
          description:
            "simple = 2–4 planes (gable/simple hip), moderate = 5–10 planes (multi-wing hip), complex = 11+ planes (cross hips, dormers, additions).",
        },
        confidence: { type: "NUMBER" },
      },
      required: ["count", "complexity", "confidence"],
    },
    roof_material: {
      type: "OBJECT",
      properties: {
        type: {
          type: "STRING",
          enum: [
            "asphalt_shingle_3tab",
            "asphalt_shingle_architectural",
            "concrete_tile",
            "clay_tile_barrel",
            "clay_tile_flat",
            "metal_standing_seam",
            "metal_corrugated",
            "wood_shake",
            "slate",
            "membrane_flat",
            "unknown",
          ],
        },
        confidence: { type: "NUMBER" },
      },
      required: ["type", "confidence"],
    },
    condition_hints: {
      type: "ARRAY",
      description:
        "Visible condition signals from the satellite image. Each hint is a discrete observable feature (not an overall grade). Empty array when the roof looks clean.",
      items: {
        type: "OBJECT",
        properties: {
          hint: {
            type: "STRING",
            enum: [
              "moss_or_algae",
              "dark_streaking",
              "shingle_wear_granule_loss",
              "missing_tabs",
              "patches_or_repairs",
              "tarp_visible",
              "ponding_water",
              "tree_debris",
              "rust_staining",
              "uniform_clean",
            ],
          },
          confidence: { type: "NUMBER" },
        },
        required: ["hint", "confidence"],
      },
    },
  },
  // Only `objects` is required at the top level — Gemini Flash sometimes
  // omits the optional sub-objects if it can't confidently fill them.
  // We want partial responses to still parse cleanly.
  required: ["objects"],
} as const;
