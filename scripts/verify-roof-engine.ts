// scripts/verify-roof-engine.ts
import assert from "node:assert/strict";
import {
  classifyComplexity,
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
