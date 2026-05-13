/**
 * Demo data for dashboard pages — used as a fallback when the real
 * Supabase queries return zero rows. Keeps the operator console looking
 * populated for sales pitches and onboarding screenshots without ever
 * writing fake rows to the live database.
 *
 * Multi-office: five seeded roofing companies, each with its own
 * realistic volume/mix. The active office is selected via the
 * `voxaris_demo_office` cookie (set by /api/office/switch); all
 * dashboard pages read it via `getDashboardOfficeSlug()` in
 * lib/dashboard.ts and pass the slug into the helpers below.
 *
 * As soon as a real lead / call / proposal lands in Supabase for the
 * matching office, the live queries outweigh the demo values and the
 * dashboard switches to truth.
 */

export type DemoOfficeSlug =
  | "nolands"
  | "quality-first"
  | "earl-johnston"
  | "west-orange"
  | "stratus";

export interface DemoOffice {
  slug: DemoOfficeSlug;
  name: string;
  shortName: string;
  state: string;
  city: string;
  initial: string;
  brand: string;
}

export const DEMO_OFFICES: DemoOffice[] = [
  {
    slug: "nolands",
    name: "Noland's Roofing",
    shortName: "Noland's",
    state: "FL",
    city: "Orlando",
    initial: "N",
    brand: "#0EA5E9",
  },
  {
    slug: "quality-first",
    name: "Quality First Roofing",
    shortName: "Quality First",
    state: "FL",
    city: "Tampa",
    initial: "Q",
    brand: "#10B981",
  },
  {
    slug: "earl-johnston",
    name: "Earl Johnston Roofing",
    shortName: "Earl Johnston",
    state: "FL",
    city: "Fort Lauderdale",
    initial: "E",
    brand: "#F59E0B",
  },
  {
    slug: "west-orange",
    name: "West Orange Roofing",
    shortName: "West Orange",
    state: "FL",
    city: "Winter Garden",
    initial: "W",
    brand: "#8B5CF6",
  },
  {
    slug: "stratus",
    name: "Stratus Roofing",
    shortName: "Stratus",
    state: "FL",
    city: "Jacksonville",
    initial: "S",
    brand: "#EF4444",
  },
];

export const DEFAULT_OFFICE_SLUG: DemoOfficeSlug = "nolands";

export function getDemoOffice(slug: string | null | undefined): DemoOffice {
  if (!slug) return DEMO_OFFICES[0];
  const match = DEMO_OFFICES.find((o) => o.slug === slug);
  return match ?? DEMO_OFFICES[0];
}

export function isDemoOfficeSlug(slug: string | null | undefined): slug is DemoOfficeSlug {
  return !!slug && DEMO_OFFICES.some((o) => o.slug === slug);
}

// ─── Overview metrics (per office) ────────────────────────────────────

export interface DemoMetrics {
  leadsThisMonth: number;
  callsThisMonth: number;
  proposalsThisMonth: number;
  pipelineLow: number;
  pipelineHigh: number;
  supplementRecoveredMtd: number;
  supplementClaimsCount: number;
  supplementVsPrevMonthPct: number;
}

const METRICS_BY_OFFICE: Record<DemoOfficeSlug, DemoMetrics> = {
  nolands: {
    leadsThisMonth: 187,
    callsThisMonth: 312,
    proposalsThisMonth: 118,
    pipelineLow: 462_000,
    pipelineHigh: 581_000,
    supplementRecoveredMtd: 34_820,
    supplementClaimsCount: 12,
    supplementVsPrevMonthPct: 22,
  },
  "quality-first": {
    leadsThisMonth: 94,
    callsThisMonth: 168,
    proposalsThisMonth: 61,
    pipelineLow: 198_000,
    pipelineHigh: 264_000,
    supplementRecoveredMtd: 11_640,
    supplementClaimsCount: 5,
    supplementVsPrevMonthPct: 9,
  },
  "earl-johnston": {
    leadsThisMonth: 142,
    callsThisMonth: 241,
    proposalsThisMonth: 88,
    pipelineLow: 318_000,
    pipelineHigh: 412_000,
    supplementRecoveredMtd: 26_200,
    supplementClaimsCount: 9,
    supplementVsPrevMonthPct: 31,
  },
  "west-orange": {
    leadsThisMonth: 71,
    callsThisMonth: 124,
    proposalsThisMonth: 44,
    pipelineLow: 148_000,
    pipelineHigh: 196_000,
    supplementRecoveredMtd: 8_920,
    supplementClaimsCount: 3,
    supplementVsPrevMonthPct: 18,
  },
  stratus: {
    leadsThisMonth: 116,
    callsThisMonth: 198,
    proposalsThisMonth: 74,
    pipelineLow: 254_000,
    pipelineHigh: 328_000,
    supplementRecoveredMtd: 18_400,
    supplementClaimsCount: 7,
    supplementVsPrevMonthPct: 14,
  },
};

export function getDemoMetrics(slug: string | null | undefined): DemoMetrics {
  const office = getDemoOffice(slug);
  return METRICS_BY_OFFICE[office.slug];
}

/** Legacy export — defaults to Noland's so any caller that still imports
 *  the const sees believable headline numbers. New callers should use
 *  getDemoMetrics(slug) instead. */
export const DEMO_OVERVIEW_METRICS: DemoMetrics = METRICS_BY_OFFICE.nolands;

// ─── Activity feed (per office) ───────────────────────────────────────

export interface DemoActivityItem {
  id: string;
  at: string;
  kind: "lead" | "call" | "proposal" | "event";
  title: string;
  detail: string | null;
}

interface ActivitySeed {
  // Offset from "now" in minutes. Smaller = more recent.
  ago: number;
  kind: DemoActivityItem["kind"];
  title: string;
  detail: string | null;
}

const ACTIVITY_SEEDS: Record<DemoOfficeSlug, ActivitySeed[]> = {
  nolands: [
    { ago: 2, kind: "lead", title: "New lead — Sarah M.", detail: "1234 Oak Ridge Dr, Orlando FL" },
    { ago: 8, kind: "call", title: "Sydney call — +1 (321) 555-0148", detail: "outcome: booked" },
    { ago: 14, kind: "proposal", title: "Proposal sent", detail: "$10,800 – $13,200" },
    { ago: 32, kind: "lead", title: "New lead — Mike R.", detail: "44 Lakeshore Way, Kissimmee FL" },
    { ago: 60, kind: "call", title: "Sydney call — +1 (407) 555-0192", detail: "outcome: transferred" },
    { ago: 120, kind: "lead", title: "New lead — Emily T.", detail: "8821 Magnolia Pkwy, Sanford FL" },
    { ago: 180, kind: "proposal", title: "Proposal sent", detail: "$18,400 – $22,800" },
    { ago: 240, kind: "call", title: "Sydney call — +1 (321) 555-0211", detail: "outcome: booked" },
  ],
  "quality-first": [
    { ago: 6, kind: "call", title: "Sydney call — +1 (813) 555-0166", detail: "outcome: booked" },
    { ago: 22, kind: "lead", title: "New lead — David K.", detail: "5402 Bayshore Blvd, Tampa FL" },
    { ago: 41, kind: "proposal", title: "Proposal sent", detail: "$8,600 – $11,400" },
    { ago: 78, kind: "lead", title: "New lead — Rachel O.", detail: "910 W Azeele St, Tampa FL" },
    { ago: 140, kind: "call", title: "Sydney call — +1 (813) 555-0203", detail: "outcome: logged_lead" },
    { ago: 210, kind: "proposal", title: "Proposal sent", detail: "$14,200 – $17,600" },
    { ago: 290, kind: "lead", title: "New lead — Carlos B.", detail: "3318 Henderson Blvd, Tampa FL" },
    { ago: 380, kind: "call", title: "Sydney call — +1 (727) 555-0188", detail: "outcome: booked" },
  ],
  "earl-johnston": [
    { ago: 4, kind: "lead", title: "New lead — Jasmine H.", detail: "2705 NE 17th Ave, Fort Lauderdale FL" },
    { ago: 18, kind: "call", title: "Sydney call — +1 (954) 555-0142", detail: "outcome: booked" },
    { ago: 36, kind: "proposal", title: "Proposal sent", detail: "$22,400 – $28,800" },
    { ago: 65, kind: "call", title: "Sydney call — +1 (954) 555-0177", detail: "outcome: booked" },
    { ago: 110, kind: "lead", title: "New lead — Anthony G.", detail: "618 SW 6th Ct, Fort Lauderdale FL" },
    { ago: 165, kind: "proposal", title: "Proposal sent", detail: "$31,200 – $38,600" },
    { ago: 220, kind: "event", title: "Supplement filed — Allstate", detail: "+$4,280 recovered" },
    { ago: 300, kind: "lead", title: "New lead — Patricia L.", detail: "1144 Hillsboro Mile, Hillsboro Beach FL" },
  ],
  "west-orange": [
    { ago: 12, kind: "call", title: "Sydney call — +1 (407) 555-0119", detail: "outcome: booked" },
    { ago: 38, kind: "lead", title: "New lead — Robert C.", detail: "16 W Plant St, Winter Garden FL" },
    { ago: 72, kind: "proposal", title: "Proposal sent", detail: "$9,400 – $12,200" },
    { ago: 130, kind: "lead", title: "New lead — Linda P.", detail: "428 Park Ave N, Winter Garden FL" },
    { ago: 200, kind: "call", title: "Sydney call — +1 (407) 555-0156", detail: "outcome: transferred" },
    { ago: 290, kind: "lead", title: "New lead — Greg M.", detail: "751 Daniels Rd, Winter Garden FL" },
    { ago: 410, kind: "proposal", title: "Proposal sent", detail: "$12,800 – $16,400" },
    { ago: 520, kind: "call", title: "Sydney call — +1 (407) 555-0184", detail: "outcome: booked" },
  ],
  stratus: [
    { ago: 5, kind: "call", title: "Sydney call — +1 (904) 555-0131", detail: "outcome: booked" },
    { ago: 24, kind: "lead", title: "New lead — Brandon S.", detail: "3420 Atlantic Blvd, Jacksonville FL" },
    { ago: 48, kind: "proposal", title: "Proposal sent", detail: "$15,600 – $19,800" },
    { ago: 90, kind: "lead", title: "New lead — Tiffany W.", detail: "1208 Riverplace Blvd, Jacksonville FL" },
    { ago: 150, kind: "call", title: "Sydney call — +1 (904) 555-0167", detail: "outcome: booked" },
    { ago: 215, kind: "proposal", title: "Proposal sent", detail: "$20,800 – $25,600" },
    { ago: 320, kind: "event", title: "Supplement filed — Citizens", detail: "+$3,140 recovered" },
    { ago: 430, kind: "lead", title: "New lead — Marcus T.", detail: "9876 San Jose Blvd, Jacksonville FL" },
  ],
};

export function getDemoActivity(slug?: string | null): DemoActivityItem[] {
  const office = getDemoOffice(slug);
  const seeds = ACTIVITY_SEEDS[office.slug];
  const now = Date.now();
  const min = 60 * 1000;
  return seeds.map((s, i) => ({
    id: `demo-${office.slug}-${i}`,
    at: new Date(now - s.ago * min).toISOString(),
    kind: s.kind,
    title: s.title,
    detail: s.detail,
  }));
}

// ─── Analytics demo data (per office) ─────────────────────────────────

export interface DemoFunnel {
  leads: number;
  calls: number;
  proposals: number;
  won: number;
}

const FUNNEL_BY_OFFICE: Record<DemoOfficeSlug, DemoFunnel> = {
  nolands: { leads: 187, calls: 312, proposals: 118, won: 24 },
  "quality-first": { leads: 94, calls: 168, proposals: 61, won: 11 },
  "earl-johnston": { leads: 142, calls: 241, proposals: 88, won: 19 },
  "west-orange": { leads: 71, calls: 124, proposals: 44, won: 8 },
  stratus: { leads: 116, calls: 198, proposals: 74, won: 14 },
};

export function getDemoFunnel(slug?: string | null): DemoFunnel {
  return FUNNEL_BY_OFFICE[getDemoOffice(slug).slug];
}

/** Legacy const — defaults to Noland's. */
export const DEMO_FUNNEL = FUNNEL_BY_OFFICE.nolands;

// Different 30-day call shapes per office — Noland's has the longest live
// history, the others ramp up later in the month.
const CALLS_BY_DAY_SHAPES: Record<DemoOfficeSlug, number[]> = {
  nolands: [
    8, 11, 13, 16, 18, 19, 15, 14, 12, 10,
    11, 16, 21, 23, 22, 18, 16, 21, 25, 27,
    24, 19, 18, 22, 27, 30, 33, 35, 31, 28,
  ],
  "quality-first": [
    2, 3, 3, 4, 5, 5, 4, 4, 3, 3,
    4, 5, 7, 8, 8, 7, 6, 8, 9, 10,
    9, 8, 7, 8, 10, 11, 12, 13, 12, 11,
  ],
  "earl-johnston": [
    6, 8, 10, 12, 14, 15, 12, 11, 9, 8,
    9, 12, 17, 19, 18, 15, 13, 17, 20, 21,
    19, 15, 14, 18, 22, 24, 26, 27, 24, 22,
  ],
  "west-orange": [
    1, 2, 2, 3, 4, 4, 3, 3, 2, 2,
    3, 4, 5, 6, 6, 5, 4, 6, 7, 8,
    7, 6, 5, 6, 8, 9, 10, 10, 9, 8,
  ],
  stratus: [
    4, 5, 6, 8, 9, 10, 8, 7, 6, 5,
    6, 8, 11, 13, 12, 10, 9, 12, 14, 15,
    13, 11, 10, 13, 16, 18, 19, 20, 18, 16,
  ],
};

export function getDemoCallsByDay(slug?: string | null): Array<{ day: string; count: number }> {
  const office = getDemoOffice(slug);
  const heights = CALLS_BY_DAY_SHAPES[office.slug];
  return heights.map((count, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (29 - i));
    return { day: d.toISOString().slice(0, 10), count };
  });
}

export function getDemoTotalCalls(slug?: string | null): number {
  return getDemoMetrics(slug).callsThisMonth;
}

/** Legacy const — defaults to Noland's. */
export const DEMO_TOTAL_CALLS = METRICS_BY_OFFICE.nolands.callsThisMonth;

const TOP_MATERIALS_BY_OFFICE: Record<
  DemoOfficeSlug,
  Array<{ material: string; count: number; avgLow: number; avgHigh: number }>
> = {
  nolands: [
    { material: "Architectural Shingle", count: 78, avgLow: 9_200, avgHigh: 12_400 },
    { material: "Concrete Tile (S-Tile)", count: 54, avgLow: 14_800, avgHigh: 19_200 },
    { material: "Standing Seam Metal", count: 28, avgLow: 18_600, avgHigh: 26_400 },
    { material: "3-Tab Shingle", count: 18, avgLow: 6_400, avgHigh: 8_800 },
    { material: "Flat / Modified Bitumen", count: 9, avgLow: 7_200, avgHigh: 9_600 },
  ],
  "quality-first": [
    { material: "Architectural Shingle", count: 41, avgLow: 9_400, avgHigh: 12_800 },
    { material: "Concrete Tile (S-Tile)", count: 14, avgLow: 14_400, avgHigh: 18_600 },
    { material: "Standing Seam Metal", count: 4, avgLow: 19_200, avgHigh: 27_400 },
    { material: "3-Tab Shingle", count: 2, avgLow: 6_200, avgHigh: 8_600 },
  ],
  "earl-johnston": [
    { material: "Concrete Tile (S-Tile)", count: 38, avgLow: 15_200, avgHigh: 19_800 },
    { material: "Clay Barrel Tile", count: 22, avgLow: 22_400, avgHigh: 31_200 },
    { material: "Architectural Shingle", count: 19, avgLow: 9_600, avgHigh: 12_800 },
    { material: "Standing Seam Metal", count: 6, avgLow: 19_800, avgHigh: 28_400 },
    { material: "Flat / Modified Bitumen", count: 3, avgLow: 7_400, avgHigh: 9_800 },
  ],
  "west-orange": [
    { material: "Architectural Shingle", count: 31, avgLow: 8_800, avgHigh: 11_800 },
    { material: "Concrete Tile (S-Tile)", count: 8, avgLow: 14_400, avgHigh: 18_400 },
    { material: "3-Tab Shingle", count: 4, avgLow: 6_200, avgHigh: 8_400 },
    { material: "Standing Seam Metal", count: 1, avgLow: 19_400, avgHigh: 26_800 },
  ],
  stratus: [
    { material: "Architectural Shingle", count: 48, avgLow: 9_000, avgHigh: 12_200 },
    { material: "Concrete Tile (S-Tile)", count: 14, avgLow: 14_600, avgHigh: 18_800 },
    { material: "Standing Seam Metal", count: 8, avgLow: 18_400, avgHigh: 25_800 },
    { material: "3-Tab Shingle", count: 3, avgLow: 6_400, avgHigh: 8_600 },
    { material: "Flat / Modified Bitumen", count: 1, avgLow: 7_200, avgHigh: 9_400 },
  ],
};

export function getDemoTopMaterials(slug?: string | null) {
  return TOP_MATERIALS_BY_OFFICE[getDemoOffice(slug).slug];
}

/** Legacy const — defaults to Noland's. */
export const DEMO_TOP_MATERIALS = TOP_MATERIALS_BY_OFFICE.nolands;

// Outcomes match the real enum in /api/agent/events line 64 EXACTLY:
// booked / transferred / logged_lead / no_show / wrong_number /
// cap_duration / cap_turns. No invented states.
const OUTCOMES_BY_OFFICE: Record<DemoOfficeSlug, Array<{ outcome: string; count: number }>> = {
  nolands: [
    { outcome: "booked", count: 138 },
    { outcome: "transferred", count: 62 },
    { outcome: "logged_lead", count: 48 },
    { outcome: "no_show", count: 28 },
    { outcome: "wrong_number", count: 22 },
    { outcome: "cap_duration", count: 14 },
  ],
  "quality-first": [
    { outcome: "booked", count: 76 },
    { outcome: "transferred", count: 34 },
    { outcome: "logged_lead", count: 26 },
    { outcome: "no_show", count: 14 },
    { outcome: "wrong_number", count: 12 },
    { outcome: "cap_duration", count: 6 },
  ],
  "earl-johnston": [
    { outcome: "booked", count: 108 },
    { outcome: "transferred", count: 48 },
    { outcome: "logged_lead", count: 38 },
    { outcome: "no_show", count: 22 },
    { outcome: "wrong_number", count: 17 },
    { outcome: "cap_duration", count: 8 },
  ],
  "west-orange": [
    { outcome: "booked", count: 56 },
    { outcome: "transferred", count: 24 },
    { outcome: "logged_lead", count: 22 },
    { outcome: "no_show", count: 11 },
    { outcome: "wrong_number", count: 8 },
    { outcome: "cap_turns", count: 3 },
  ],
  stratus: [
    { outcome: "booked", count: 88 },
    { outcome: "transferred", count: 42 },
    { outcome: "logged_lead", count: 32 },
    { outcome: "no_show", count: 18 },
    { outcome: "wrong_number", count: 13 },
    { outcome: "cap_turns", count: 5 },
  ],
};

export function getDemoOutcomes(slug?: string | null) {
  return OUTCOMES_BY_OFFICE[getDemoOffice(slug).slug];
}

/** Legacy const — defaults to Noland's. */
export const DEMO_OUTCOMES = OUTCOMES_BY_OFFICE.nolands;
