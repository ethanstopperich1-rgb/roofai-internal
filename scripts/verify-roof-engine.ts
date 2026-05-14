// scripts/verify-roof-engine.ts
import assert from "node:assert/strict";
import { computeFlashing } from "@/lib/roof-engine";
import type { Edge, RoofObject } from "@/types/roof";

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
