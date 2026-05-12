/**
 * Demo data for dashboard pages — used as a fallback when the real
 * Supabase queries return zero rows. Keeps the operator console looking
 * populated for sales pitches and onboarding screenshots without ever
 * writing fake rows to the live database.
 *
 * As soon as a real lead / call / proposal lands in Supabase, the live
 * data outweighs the demo values and the dashboard switches to truth.
 *
 * Numbers chosen to mirror the Figma operator-console mocks at
 * https://www.figma.com/design/gO5JrsiCVXinVrVlJ0nngG so the live URL
 * and the design file tell the same story.
 */

export interface DemoMetrics {
  leadsThisMonth: number;
  callsThisMonth: number;
  proposalsThisMonth: number;
  pipelineLow: number;
  pipelineHigh: number;
}

export interface DemoActivityItem {
  id: string;
  at: string;
  kind: "lead" | "call" | "proposal" | "event";
  title: string;
  detail: string | null;
}

export const DEMO_OVERVIEW_METRICS: DemoMetrics = {
  leadsThisMonth: 487,
  callsThisMonth: 873,
  proposalsThisMonth: 312,
  pipelineLow: 1_180_000,
  pipelineHigh: 1_480_000,
};

// Realistic feed — varied between leads, Sydney calls, proposals. Times
// are relative to "now" so the feed always feels fresh on page load.
export function getDemoActivity(): DemoActivityItem[] {
  const now = Date.now();
  const min = 60 * 1000;
  const hr = 60 * min;

  return [
    {
      id: "demo-l-1",
      at: new Date(now - 2 * min).toISOString(),
      kind: "lead",
      title: "New lead — Sarah M.",
      detail: "1234 Oak Ridge Dr, Orlando FL",
    },
    {
      id: "demo-c-1",
      at: new Date(now - 8 * min).toISOString(),
      kind: "call",
      title: "Sydney call — +1 (321) 555-0148",
      detail: "outcome: booked",
    },
    {
      id: "demo-p-1",
      at: new Date(now - 14 * min).toISOString(),
      kind: "proposal",
      title: "Proposal sent",
      detail: "$10,800 – $13,200",
    },
    {
      id: "demo-l-2",
      at: new Date(now - 32 * min).toISOString(),
      kind: "lead",
      title: "New lead — Mike R.",
      detail: "44 Lakeshore Way, Kissimmee FL",
    },
    {
      id: "demo-c-2",
      at: new Date(now - 1 * hr).toISOString(),
      kind: "call",
      title: "Sydney call — +1 (407) 555-0192",
      detail: "outcome: transferred_to_human",
    },
    {
      id: "demo-l-3",
      at: new Date(now - 2 * hr).toISOString(),
      kind: "lead",
      title: "New lead — Emily T.",
      detail: "8821 Magnolia Pkwy, Sanford FL",
    },
    {
      id: "demo-p-2",
      at: new Date(now - 3 * hr).toISOString(),
      kind: "proposal",
      title: "Proposal sent",
      detail: "$18,400 – $22,800",
    },
    {
      id: "demo-c-3",
      at: new Date(now - 4 * hr).toISOString(),
      kind: "call",
      title: "Sydney call — +1 (321) 555-0211",
      detail: "outcome: booked",
    },
  ];
}

// ─── Analytics demo data ──────────────────────────────────────────────

export const DEMO_FUNNEL = {
  leads: 487,
  calls: 412,
  proposals: 312,
  won: 63,
};

// 30-day call volume — dense distribution with a realistic uptrend that
// matches the bar chart in the Figma mock.
export function getDemoCallsByDay(): Array<{ day: string; count: number }> {
  const heights = [
    22, 28, 35, 42, 48, 52, 41, 38, 33, 26,
    31, 44, 56, 63, 58, 49, 42, 55, 68, 72,
    64, 51, 47, 58, 71, 79, 88, 92, 81, 73,
  ];
  return heights.map((count, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (29 - i));
    return { day: d.toISOString().slice(0, 10), count };
  });
}

export const DEMO_TOTAL_CALLS = 873;

export const DEMO_TOP_MATERIALS = [
  { material: "Architectural Shingle", count: 187, avgLow: 9_200, avgHigh: 12_400 },
  { material: "Concrete Tile (S-Tile)", count: 142, avgLow: 14_800, avgHigh: 19_200 },
  { material: "Standing Seam Metal", count: 78, avgLow: 18_600, avgHigh: 26_400 },
  { material: "3-Tab Shingle", count: 52, avgLow: 6_400, avgHigh: 8_800 },
  { material: "Flat / Modified Bitumen", count: 28, avgLow: 7_200, avgHigh: 9_600 },
];

export const DEMO_OUTCOMES = [
  { outcome: "booked", count: 342 },
  { outcome: "transferred_to_human", count: 218 },
  { outcome: "cap_voicemail", count: 128 },
  { outcome: "abandoned", count: 96 },
  { outcome: "wrong_number", count: 49 },
  { outcome: "no_show", count: 40 },
];
