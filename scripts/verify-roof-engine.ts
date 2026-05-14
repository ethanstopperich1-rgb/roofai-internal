// scripts/verify-roof-engine.ts
import assert from "node:assert/strict";
import {
  classifyComplexity,
  classifyEdges,
  computeFlashing,
  computeTotals,
  suggestedWastePctTierC,
} from "@/lib/roof-engine";
import type { Edge, Facet, RoofObject } from "@/types/roof";

const tests: Array<{ name: string; run: () => void }> = [];
function test(name: string, run: () => void) {
  tests.push({ name, run });
}

// ---- computeFlashing -------------------------------------------------------

test("computeFlashing: empty inputs return zeros", () => {
  const result = computeFlashing([], [], []);
  assert.equal(result.chimneyLf, 0);
  assert.equal(result.valleyLf, 0);
  assert.equal(result.iwsSqft, 0);
  assert.equal(result.pipeBootCount, 0);
  assert.equal(result.wallStepLf, 0);
});

test("computeFlashing: chimney perimeter math", () => {
  const objects: RoofObject[] = [
    {
      id: "c1",
      kind: "chimney",
      position: { lat: 0, lng: 0, heightM: 0 },
      dimensionsFt: { width: 3, length: 4 },
      facetId: null,
    },
  ];
  const result = computeFlashing([], [], objects);
  // 2 * (3 + 4) = 14 LF
  assert.equal(result.chimneyLf, 14);
});

test("computeFlashing: skylight perimeter math (2 skylights)", () => {
  const objects: RoofObject[] = [
    {
      id: "s1", kind: "skylight",
      position: { lat: 0, lng: 0, heightM: 0 },
      dimensionsFt: { width: 2, length: 4 },
      facetId: null,
    },
    {
      id: "s2", kind: "skylight",
      position: { lat: 0, lng: 0, heightM: 0 },
      dimensionsFt: { width: 3, length: 3 },
      facetId: null,
    },
  ];
  const result = computeFlashing([], [], objects);
  // 2*(2+4) + 2*(3+3) = 12 + 12 = 24
  assert.equal(result.skylightLf, 24);
});

test("computeFlashing: dormer step = 2 * cheek wall length", () => {
  const objects: RoofObject[] = [
    {
      id: "d1", kind: "dormer",
      position: { lat: 0, lng: 0, heightM: 0 },
      dimensionsFt: { width: 6, length: 8 },
      facetId: null,
    },
  ];
  const result = computeFlashing([], [], objects);
  // 2 * 8 = 16
  assert.equal(result.dormerStepLf, 16);
});

test("computeFlashing: valley LF gets 5% overlap, IWS uses post-overlap valley", () => {
  const edges: Edge[] = [
    { id: "e1", type: "valley", polyline: [], lengthFt: 20, facetIds: [], confidence: 0.4 },
  ];
  const result = computeFlashing([], edges, []);
  // 20 * 1.05 = 21 (rounded)
  assert.equal(result.valleyLf, 21);
  // iws = eaves*3 + valley*6 = 0 + 21*6 = 126
  assert.equal(result.iwsSqft, 126);
});

test("computeFlashing: drip edge = eaves + rakes; IWS includes eave*3", () => {
  const edges: Edge[] = [
    { id: "e1", type: "eave", polyline: [], lengthFt: 30, facetIds: [], confidence: 0.4 },
    { id: "e2", type: "rake", polyline: [], lengthFt: 20, facetIds: [], confidence: 0.4 },
  ];
  const result = computeFlashing([], edges, []);
  assert.equal(result.dripEdgeLf, 50);
  // iws = 30*3 + 0 = 90
  assert.equal(result.iwsSqft, 90);
});

test("computeFlashing: pipe boots count vents + stacks (not other kinds)", () => {
  const objects: RoofObject[] = [
    { id: "v1", kind: "vent", position: { lat: 0, lng: 0, heightM: 0 }, dimensionsFt: { width: 0.5, length: 0.5 }, facetId: null },
    { id: "s1", kind: "stack", position: { lat: 0, lng: 0, heightM: 0 }, dimensionsFt: { width: 0.5, length: 0.5 }, facetId: null },
    { id: "rv", kind: "ridge-vent", position: { lat: 0, lng: 0, heightM: 0 }, dimensionsFt: { width: 4, length: 4 }, facetId: null },
  ];
  const result = computeFlashing([], [], objects);
  assert.equal(result.pipeBootCount, 2);
});

// ---- classifyComplexity / suggestedWastePctTierC --------------------------

function emptyFacet(id: string, polygon: Array<{ lat: number; lng: number }>): Facet {
  return {
    id, polygon,
    normal: { x: 0, y: 0, z: 1 },
    pitchDegrees: 22.6, azimuthDeg: 180,
    areaSqftSloped: 1000, areaSqftFootprint: 900,
    material: null, isLowSlope: false,
  };
}

test("classifyComplexity: 1 facet, no dormers, no valleys -> simple", () => {
  const result = classifyComplexity({
    facets: [emptyFacet("f1", [
      { lat: 0, lng: 0 }, { lat: 0, lng: 1 },
      { lat: 1, lng: 1 }, { lat: 1, lng: 0 },
    ])],
    edges: [],
    objects: [],
  });
  assert.equal(result, "simple");
});

test("classifyComplexity: 4 facets -> moderate", () => {
  const facets = [1, 2, 3, 4].map((i) =>
    emptyFacet(`f${i}`, [
      { lat: 0, lng: 0 }, { lat: 0, lng: 1 },
      { lat: 1, lng: 1 }, { lat: 1, lng: 0 },
    ]),
  );
  const result = classifyComplexity({ facets, edges: [], objects: [] });
  assert.equal(result, "moderate");
});

test("classifyComplexity: 6 facets -> complex", () => {
  const facets = [1, 2, 3, 4, 5, 6].map((i) =>
    emptyFacet(`f${i}`, [
      { lat: 0, lng: 0 }, { lat: 0, lng: 1 },
      { lat: 1, lng: 1 }, { lat: 1, lng: 0 },
    ]),
  );
  const result = classifyComplexity({ facets, edges: [], objects: [] });
  assert.equal(result, "complex");
});

test("classifyComplexity: 1 dormer bumps to moderate", () => {
  const result = classifyComplexity({
    facets: [emptyFacet("f1", [
      { lat: 0, lng: 0 }, { lat: 0, lng: 1 },
      { lat: 1, lng: 1 }, { lat: 1, lng: 0 },
    ])],
    edges: [],
    objects: [{
      id: "d1", kind: "dormer",
      position: { lat: 0.5, lng: 0.5, heightM: 0 },
      dimensionsFt: { width: 6, length: 8 },
      facetId: null,
    }],
  });
  assert.equal(result, "moderate");
});

test("classifyComplexity: 3 dormers -> complex (dormer-heavy signal)", () => {
  const result = classifyComplexity({
    facets: [emptyFacet("f1", [
      { lat: 0, lng: 0 }, { lat: 0, lng: 1 },
      { lat: 1, lng: 1 }, { lat: 1, lng: 0 },
    ])],
    edges: [],
    objects: [1, 2, 3].map((i) => ({
      id: `d${i}`, kind: "dormer" as const,
      position: { lat: 0.5, lng: 0.5, heightM: 0 },
      dimensionsFt: { width: 6, length: 8 },
      facetId: null,
    })),
  });
  assert.equal(result, "complex");
});

test("classifyComplexity: 60 LF of valleys -> complex", () => {
  const result = classifyComplexity({
    facets: [emptyFacet("f1", [
      { lat: 0, lng: 0 }, { lat: 0, lng: 1 },
      { lat: 1, lng: 1 }, { lat: 1, lng: 0 },
    ])],
    edges: [
      { id: "v1", type: "valley", polyline: [], lengthFt: 30, facetIds: [], confidence: 0.4 },
      { id: "v2", type: "valley", polyline: [], lengthFt: 35, facetIds: [], confidence: 0.4 },
    ],
    objects: [],
  });
  assert.equal(result, "complex");
});

test("suggestedWastePctTierC: 7 / 11 / 14", () => {
  assert.equal(suggestedWastePctTierC("simple"), 7);
  assert.equal(suggestedWastePctTierC("moderate"), 11);
  assert.equal(suggestedWastePctTierC("complex"), 14);
});

// ---- computeTotals --------------------------------------------------------

test("computeTotals: empty facets -> all-zero totals", () => {
  const result = computeTotals([], [], []);
  assert.equal(result.facetsCount, 0);
  assert.equal(result.totalRoofAreaSqft, 0);
  assert.equal(result.averagePitchDegrees, 0);
  assert.equal(result.complexity, "simple");
  assert.equal(result.wastePct, 7);
});

test("computeTotals: area-weighted average pitch + squares rounding", () => {
  const f1 = emptyFacet("f1", []);
  f1.pitchDegrees = 20;
  f1.areaSqftSloped = 1000;
  const f2 = emptyFacet("f2", []);
  f2.pitchDegrees = 30;
  f2.areaSqftSloped = 1000;
  const result = computeTotals([f1, f2], [], []);
  assert.equal(result.averagePitchDegrees, 25);
  assert.equal(result.totalRoofAreaSqft, 2000);
  // 2000 / 100 = 20 squares, already on a 1/3 boundary
  assert.equal(result.totalSquares, 20);
});

test("computeTotals: wasteOverridePct wins over suggested when positive", () => {
  const result = computeTotals([], [], [], 17);
  assert.equal(result.wastePct, 17);
});

test("computeTotals: wasteOverridePct = 0 falls through to suggested (not honored)", () => {
  const result = computeTotals([], [], [], 0);
  assert.equal(result.wastePct, 7); // empty -> simple -> 7%
});

test("computeTotals: predominant material is most-area material, ignoring null", () => {
  const f1 = emptyFacet("f1", []);
  f1.material = "asphalt-architectural";
  f1.areaSqftSloped = 1500;
  const f2 = emptyFacet("f2", []);
  f2.material = "metal-standing-seam";
  f2.areaSqftSloped = 500;
  const f3 = emptyFacet("f3", []);
  f3.material = null;
  f3.areaSqftSloped = 3000; // largest area, but null — must be ignored
  const result = computeTotals([f1, f2, f3], [], []);
  assert.equal(result.predominantMaterial, "asphalt-architectural");
});

test("computeTotals: all-null facets -> predominantMaterial null", () => {
  const f1 = emptyFacet("f1", []);
  f1.material = null;
  f1.areaSqftSloped = 1000;
  const result = computeTotals([f1], [], []);
  assert.equal(result.predominantMaterial, null);
});

// ---- classifyEdges --------------------------------------------------------

test("classifyEdges: empty facets -> empty edges", () => {
  const result = classifyEdges([], null);
  assert.deepStrictEqual(result, []);
});

test("classifyEdges: single rectangular facet -> 4 exterior edges, confidence 0.4", () => {
  const facet = emptyFacet("f1", [
    { lat: 0.0000, lng: 0.0000 },
    { lat: 0.0000, lng: 0.0003 },
    { lat: 0.00027, lng: 0.0003 },
    { lat: 0.00027, lng: 0.0000 },
  ]);
  const result = classifyEdges([facet], null);
  // 1 facet -> length-ranked eave/rake fallback. All 4 are exterior.
  assert.equal(result.length, 4);
  assert.ok(result.every((e) => e.confidence === 0.4));
  const eaveCount = result.filter((e) => e.type === "eave").length;
  const rakeCount = result.filter((e) => e.type === "rake").length;
  assert.equal(eaveCount + rakeCount, 4);
});

test("classifyEdges: two adjacent facets share one edge -> 1 shared edge typed by bearing", () => {
  // Two rectangles sharing an east edge (north-south oriented)
  const fA = emptyFacet("fA", [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 0.0003 },
    { lat: 0.0003, lng: 0.0003 },
    { lat: 0.0003, lng: 0 },
  ]);
  const fB = emptyFacet("fB", [
    { lat: 0, lng: 0.0003 },
    { lat: 0, lng: 0.0006 },
    { lat: 0.0003, lng: 0.0006 },
    { lat: 0.0003, lng: 0.0003 },
  ]);
  // dominantAzimuth = 0 means the dominant axis is north-south. The shared
  // edge runs north-south (same as axis) -> ridge candidate.
  const result = classifyEdges([fA, fB], 0);
  // 8 raw edges, 1 shared pair -> 7 emitted (1 shared + 6 exterior).
  assert.equal(result.length, 7);
  const shared = result.filter((e) => e.facetIds.length === 2);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].type, "ridge");
});

test("classifyEdges: shared edge geometry preserved (real lat/lng polyline at heightM=0)", () => {
  const fA = emptyFacet("fA", [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 0.0003 },
    { lat: 0.0003, lng: 0.0003 },
    { lat: 0.0003, lng: 0 },
  ]);
  const fB = emptyFacet("fB", [
    { lat: 0, lng: 0.0003 },
    { lat: 0, lng: 0.0006 },
    { lat: 0.0003, lng: 0.0006 },
    { lat: 0.0003, lng: 0.0003 },
  ]);
  const result = classifyEdges([fA, fB], 0);
  const shared = result.find((e) => e.facetIds.length === 2)!;
  assert.equal(shared.polyline.length, 2);
  for (const pt of shared.polyline) {
    assert.equal(pt.heightM, 0);
    assert.ok(typeof pt.lat === "number");
    assert.ok(typeof pt.lng === "number");
  }
});

test("classifyEdges: null dominantAzimuth + 2+ facets -> synthetic axis from longest exterior edge", () => {
  // Two facets with a clear shared edge. Pass null dominantAzimuth.
  // Implementation should reconstruct the axis from the longest exterior
  // edge instead of falling all the way back to length-ranked assignment.
  const fA = emptyFacet("fA", [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 0.0006 },
    { lat: 0.0003, lng: 0.0006 },
    { lat: 0.0003, lng: 0 },
  ]);
  const fB = emptyFacet("fB", [
    { lat: 0, lng: 0.0006 },
    { lat: 0, lng: 0.0012 },
    { lat: 0.0003, lng: 0.0012 },
    { lat: 0.0003, lng: 0.0006 },
  ]);
  const result = classifyEdges([fA, fB], null);
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => e.confidence === 0.4));
});

test("classifyEdges: ridge cap fires — only longest ridge passes; excess demoted to hip", () => {
  // Build 4 facets in a 2x2 grid sharing 4 edges between them, all oriented
  // east-west (parallel to dominantAxis = 90°, perpendicular to the
  // north-south "across" edges). This forces all 4 shared edges into the
  // ridge candidate bucket. Simple complexity = ridgeCap 0.85; first edge
  // passes unconditionally, remainder are subjected to the cap.
  //
  // Layout (each cell is one facet):
  //   fNW │ fNE
  //   ----+----   <- shared east-west edge
  //   fSW │ fSE
  //
  // To force 4 east-west shared edges (all parallel to axis=90°), use a
  // cross of 4 facets stacked along the east-west axis with shared edges
  // at lat boundaries (north-south matched on different facets).
  //
  // Simpler: stack 5 facets in a north-south strip sharing east-west
  // edges. This yields 4 shared edges all oriented east-west.
  const facets = [];
  for (let i = 0; i < 5; i++) {
    facets.push({
      id: `f${i}`,
      polygon: [
        { lat: i * 0.0003, lng: 0 },
        { lat: i * 0.0003, lng: 0.0006 },
        { lat: (i + 1) * 0.0003, lng: 0.0006 },
        { lat: (i + 1) * 0.0003, lng: 0 },
      ],
      normal: { x: 0, y: 0, z: 1 },
      pitchDegrees: 22.6,
      azimuthDeg: 180,
      areaSqftSloped: 1000,
      areaSqftFootprint: 900,
      material: null,
      isLowSlope: false,
    });
  }
  // dominantAzimuth = 90 → axis runs east-west. Shared edges between
  // adjacent strip facets are also east-west, so all 4 are ridge
  // candidates. Cap (for 5 facets = complex, ridgeCap 0.40) admits only
  // the first ~40% of shared LF as ridge; the rest demote to hip.
  const result = classifyEdges(facets, 90);
  const shared = result.filter((e) => e.facetIds.length === 2);
  // 4 shared edges between 5 strip facets
  assert.equal(shared.length, 4);
  const ridges = shared.filter((e) => e.type === "ridge");
  const hips = shared.filter((e) => e.type === "hip");
  // At least one ridge admitted (the first), and at least one demoted to hip.
  assert.ok(ridges.length >= 1, "expected at least 1 ridge");
  assert.ok(hips.length >= 1, "expected ridge cap to demote at least 1 to hip");
  // Total ridge + hip should equal shared count (no valleys since all parallel to axis)
  assert.equal(ridges.length + hips.length, 4);
});

// ---- runner ---------------------------------------------------------------

let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`PASS  ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${t.name}`);
    console.error(err);
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${tests.length} verification(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} verifications passed`);
