/**
 * Per-office row-shaped demo data for the dashboard subpages
 * (calls / leads / proposals). Sits alongside lib/dashboard-demo.ts —
 * that file holds aggregate metrics + activity, this file holds full
 * Supabase-Row-shaped arrays that the existing tables can render
 * without any UI changes.
 *
 * Design rules — read before touching:
 *
 *   1. NOTHING IN HERE LIES ABOUT CAPABILITY. Sydney's tools, outcomes,
 *      and event types match exactly what the agent in agents/sydney/
 *      actually emits today:
 *        - tools: transfer_to_human, check_availability, book_inspection, log_lead
 *        - outcomes: booked / transferred_to_human / cap_voicemail / abandoned
 *          / wrong_number / no_show
 *      Don't invent capabilities (e.g. "Sydney closed the deal") — that
 *      breaks demo trust the moment a prospect probes.
 *
 *   2. Sydney does NOT generate proposals. Proposals are saved by reps
 *      from pitch.voxaris.io/. So in the demo data, proposals always
 *      have generated_by = an email of a person who could plausibly be
 *      a rep at that office, never Sydney.
 *
 *   3. Phone numbers use the 555-01xx reserved fake range and the area
 *      code that matches the office's FL city.
 *
 *   4. Generators are DETERMINISTIC — same office slug returns the same
 *      array on every call. No randomness. Server Components re-render
 *      and we don't want flicker.
 *
 *   5. Internal consistency: every call.lead_id and proposal.lead_id
 *      refers to a real lead in the same office's array. Events nest
 *      under their call_id.
 */

import type { Database } from "@/types/supabase";
import type { DemoOfficeSlug } from "@/lib/dashboard-demo";

type Lead = Database["public"]["Tables"]["leads"]["Row"];
type Call = Database["public"]["Tables"]["calls"]["Row"];
type Proposal = Database["public"]["Tables"]["proposals"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];

// Deterministic UUIDs scoped by office + role + index. The format is
// invalid as a real UUID but TypeScript types only require `string` and
// our queries never compare these to real DB ids — the demo fallback
// kicks in BEFORE we ever hit the DB.
const officeIdOf = (slug: DemoOfficeSlug) =>
  `00000000-0000-0000-0000-${("000000000000" + hash(slug)).slice(-12)}`;

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function id(prefix: string, slug: string, i: number): string {
  const padded = ("000000000000" + (hash(slug) + i * 991)).slice(-12);
  return `${prefix}-${slug.slice(0, 4)}-0000-0000-${padded}`;
}

// minutes ago → ISO
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

// hours / days ago → ISO
const hoursAgo = (h: number) => ago(h * 60);
const daysAgo = (d: number) => ago(d * 60 * 24);

// ─── Seed people (the customers Sydney has handled per office) ────────
//
// Each tuple: [firstName, lastName, phoneSuffix, street, zip,
//              status, material, sqft]
// status drives the lead pipeline distribution
// material drives the estimate range

type Status = "new" | "contacted" | "quoted" | "won" | "lost";
type Material =
  | "Architectural Shingle"
  | "Concrete Tile (S-Tile)"
  | "Standing Seam Metal"
  | "3-Tab Shingle"
  | "Clay Barrel Tile"
  | "Flat / Modified Bitumen";

interface PersonSeed {
  first: string;
  last: string;
  phone4: string; // last 4 digits, area code derived from office
  street: string;
  zip: string;
  status: Status;
  material: Material;
  sqft: number;
}

// Per-office area codes + city/county metadata. `company` is the
// spoken name Sydney uses for the office in the verbatim greeting and
// the close; matches the office_short_name in the prompt.
const CITY_META: Record<
  DemoOfficeSlug,
  {
    area: string;
    city: string;
    county: string;
    lat: number;
    lng: number;
    company: string;
    closeOfficeLabel: string;
  }
> = {
  nolands: {
    area: "321",
    city: "Orlando",
    county: "Orange",
    lat: 28.5383,
    lng: -81.3792,
    company: "Noland's Roofing",
    closeOfficeLabel: "Orlando",
  },
  "quality-first": {
    area: "813",
    city: "Tampa",
    county: "Hillsborough",
    lat: 27.9506,
    lng: -82.4572,
    company: "Quality First Roofing",
    closeOfficeLabel: "Tampa",
  },
  "earl-johnston": {
    area: "954",
    city: "Fort Lauderdale",
    county: "Broward",
    lat: 26.1224,
    lng: -80.1373,
    company: "Earl Johnston Roofing",
    closeOfficeLabel: "Fort Lauderdale",
  },
  "west-orange": {
    area: "407",
    city: "Winter Garden",
    county: "Orange",
    lat: 28.5653,
    lng: -81.5862,
    company: "West Orange Roofing",
    closeOfficeLabel: "Winter Garden",
  },
  stratus: {
    area: "904",
    city: "Jacksonville",
    county: "Duval",
    lat: 30.3322,
    lng: -81.6557,
    company: "Stratus Roofing",
    closeOfficeLabel: "Jacksonville",
  },
};

// Realistic material → price band per sqft (Florida 2026, conservative)
const MATERIAL_BANDS: Record<Material, { perSqftLow: number; perSqftHigh: number }> = {
  "Architectural Shingle": { perSqftLow: 4.2, perSqftHigh: 5.8 },
  "Concrete Tile (S-Tile)": { perSqftLow: 7.4, perSqftHigh: 9.6 },
  "Standing Seam Metal": { perSqftLow: 9.2, perSqftHigh: 13.4 },
  "3-Tab Shingle": { perSqftLow: 3.2, perSqftHigh: 4.4 },
  "Clay Barrel Tile": { perSqftLow: 11.2, perSqftHigh: 15.6 },
  "Flat / Modified Bitumen": { perSqftLow: 4.8, perSqftHigh: 6.4 },
};

function estimateBand(material: Material, sqft: number) {
  const b = MATERIAL_BANDS[material];
  return {
    low: Math.round((b.perSqftLow * sqft) / 100) * 100,
    high: Math.round((b.perSqftHigh * sqft) / 100) * 100,
  };
}

// Per-office seed people. ~15 each. Status mix targets a healthy funnel.
const SEEDS: Record<DemoOfficeSlug, PersonSeed[]> = {
  nolands: [
    { first: "Sarah",   last: "Mitchell",  phone4: "0148", street: "1234 Oak Ridge Dr",   zip: "32801", status: "new",       material: "Architectural Shingle", sqft: 2400 },
    { first: "Mike",    last: "Rodriguez", phone4: "0192", street: "44 Lakeshore Way",    zip: "34741", status: "contacted", material: "Concrete Tile (S-Tile)", sqft: 2800 },
    { first: "Emily",   last: "Thompson",  phone4: "0211", street: "8821 Magnolia Pkwy",  zip: "32771", status: "quoted",    material: "Architectural Shingle", sqft: 2100 },
    { first: "James",   last: "Carter",    phone4: "0226", street: "412 Pine Hollow Cir", zip: "32803", status: "won",       material: "Standing Seam Metal",    sqft: 2600 },
    { first: "Linda",   last: "Park",      phone4: "0274", street: "6201 Lake Underhill", zip: "32807", status: "quoted",    material: "Architectural Shingle", sqft: 1900 },
    { first: "David",   last: "Nguyen",    phone4: "0289", street: "1715 N Mills Ave",    zip: "32803", status: "new",       material: "Concrete Tile (S-Tile)", sqft: 3100 },
    { first: "Rachel",  last: "Brooks",    phone4: "0312", street: "9904 Lee Vista Blvd", zip: "32827", status: "contacted", material: "Architectural Shingle", sqft: 2300 },
    { first: "Tom",     last: "Sullivan",  phone4: "0345", street: "3320 Conway Rd",      zip: "32812", status: "won",       material: "Architectural Shingle", sqft: 2700 },
    { first: "Jasmine", last: "Patel",     phone4: "0367", street: "5044 Curry Ford Rd",  zip: "32812", status: "quoted",    material: "Concrete Tile (S-Tile)", sqft: 2900 },
    { first: "Chris",   last: "Walker",    phone4: "0398", street: "2710 Hoffner Ave",    zip: "32812", status: "new",       material: "Architectural Shingle", sqft: 2200 },
    { first: "Megan",   last: "Foster",    phone4: "0421", street: "780 Lake Holden Ter", zip: "32839", status: "lost",      material: "3-Tab Shingle",         sqft: 1800 },
    { first: "Marcus",  last: "Lee",       phone4: "0438", street: "4115 Bumby Ave",      zip: "32806", status: "contacted", material: "Standing Seam Metal",    sqft: 2500 },
    { first: "Olivia",  last: "Diaz",      phone4: "0466", street: "1822 Edgewater Dr",   zip: "32804", status: "quoted",    material: "Concrete Tile (S-Tile)", sqft: 3200 },
    { first: "Brandon", last: "Hayes",     phone4: "0489", street: "6310 Stardust Ln",    zip: "32818", status: "new",       material: "Architectural Shingle", sqft: 2000 },
    { first: "Priya",   last: "Sharma",    phone4: "0512", street: "1149 Sligh Blvd",     zip: "32806", status: "won",       material: "Architectural Shingle", sqft: 2350 },
  ],
  "quality-first": [
    { first: "David",     last: "Kelley",   phone4: "0166", street: "5402 Bayshore Blvd",    zip: "33611", status: "new",       material: "Architectural Shingle", sqft: 2500 },
    { first: "Rachel",    last: "Ochoa",    phone4: "0203", street: "910 W Azeele St",       zip: "33606", status: "contacted", material: "Standing Seam Metal",    sqft: 2200 },
    { first: "Carlos",    last: "Benitez",  phone4: "0188", street: "3318 Henderson Blvd",   zip: "33609", status: "quoted",    material: "Architectural Shingle", sqft: 2400 },
    { first: "Nicole",    last: "Howard",   phone4: "0244", street: "401 S Howard Ave",      zip: "33606", status: "won",       material: "Architectural Shingle", sqft: 1950 },
    { first: "Steve",     last: "Murray",   phone4: "0271", street: "1812 W Cleveland St",   zip: "33606", status: "new",       material: "3-Tab Shingle",         sqft: 1700 },
    { first: "Amanda",    last: "Bell",     phone4: "0298", street: "5005 W San Jose St",    zip: "33629", status: "contacted", material: "Architectural Shingle", sqft: 2600 },
    { first: "Phillip",   last: "Tran",     phone4: "0317", street: "2204 W Watrous Ave",    zip: "33629", status: "quoted",    material: "Concrete Tile (S-Tile)", sqft: 2800 },
    { first: "Jordan",    last: "Pierce",   phone4: "0341", street: "7716 N Boulevard",      zip: "33604", status: "new",       material: "Architectural Shingle", sqft: 2100 },
    { first: "Kelly",     last: "Reeves",   phone4: "0382", street: "3401 W Bay To Bay Blvd",zip: "33629", status: "lost",      material: "Architectural Shingle", sqft: 2050 },
    { first: "Hector",    last: "Diaz",     phone4: "0419", street: "1208 E 18th Ave",       zip: "33605", status: "won",       material: "Standing Seam Metal",    sqft: 2400 },
    { first: "Stephanie", last: "Olsen",    phone4: "0447", street: "4719 W Beach Park Dr",  zip: "33611", status: "quoted",    material: "Architectural Shingle", sqft: 2300 },
    { first: "Greg",      last: "Manning",  phone4: "0476", street: "1604 W Swann Ave",      zip: "33606", status: "new",       material: "Concrete Tile (S-Tile)", sqft: 3000 },
    { first: "Vanessa",   last: "Holt",     phone4: "0498", street: "2920 W Bay Dr",         zip: "33611", status: "contacted", material: "Architectural Shingle", sqft: 2150 },
  ],
  "earl-johnston": [
    { first: "Jasmine",  last: "Henderson", phone4: "0142", street: "2705 NE 17th Ave",        zip: "33305", status: "new",       material: "Clay Barrel Tile",        sqft: 2400 },
    { first: "Anthony",  last: "Gallo",     phone4: "0177", street: "618 SW 6th Ct",           zip: "33312", status: "contacted", material: "Concrete Tile (S-Tile)",  sqft: 2700 },
    { first: "Patricia", last: "Lin",       phone4: "0204", street: "1144 Hillsboro Mile",     zip: "33062", status: "quoted",    material: "Clay Barrel Tile",        sqft: 3400 },
    { first: "Richard",  last: "Vasquez",   phone4: "0231", street: "3209 NE 32nd St",         zip: "33308", status: "won",       material: "Concrete Tile (S-Tile)",  sqft: 2900 },
    { first: "Diane",    last: "McCormick", phone4: "0256", street: "510 SE 17th St",          zip: "33316", status: "quoted",    material: "Standing Seam Metal",      sqft: 2200 },
    { first: "Eric",     last: "Park",      phone4: "0289", street: "4221 N Ocean Dr",         zip: "33308", status: "new",       material: "Clay Barrel Tile",        sqft: 3100 },
    { first: "Christine",last: "Albers",    phone4: "0313", street: "1816 SE 12th Ct",         zip: "33316", status: "contacted", material: "Concrete Tile (S-Tile)",  sqft: 2500 },
    { first: "Andre",    last: "Singh",     phone4: "0344", street: "729 NE 56th St",          zip: "33334", status: "won",       material: "Clay Barrel Tile",        sqft: 3200 },
    { first: "Vanessa",  last: "Reyes",     phone4: "0372", street: "2304 N Andrews Ave",      zip: "33311", status: "quoted",    material: "Architectural Shingle",    sqft: 2100 },
    { first: "Greg",     last: "Kim",       phone4: "0405", street: "5410 NE 22nd Ave",        zip: "33308", status: "new",       material: "Standing Seam Metal",      sqft: 2400 },
    { first: "Lauren",   last: "Castro",    phone4: "0438", street: "1207 Seven Isles Dr",     zip: "33301", status: "contacted", material: "Clay Barrel Tile",        sqft: 3500 },
    { first: "Daniel",   last: "Briggs",    phone4: "0461", street: "3522 NE 28th Ave",        zip: "33308", status: "lost",      material: "Concrete Tile (S-Tile)",  sqft: 2300 },
    { first: "Sofia",    last: "Marquez",   phone4: "0487", street: "650 SE 13th Ave",         zip: "33301", status: "quoted",    material: "Clay Barrel Tile",        sqft: 2800 },
  ],
  "west-orange": [
    { first: "Robert",  last: "Crawford", phone4: "0119", street: "16 W Plant St",       zip: "34787", status: "new",       material: "Architectural Shingle", sqft: 2100 },
    { first: "Linda",   last: "Pearson",  phone4: "0156", street: "428 Park Ave N",      zip: "34787", status: "contacted", material: "Architectural Shingle", sqft: 2300 },
    { first: "Greg",    last: "McKenzie", phone4: "0184", street: "751 Daniels Rd",      zip: "34787", status: "quoted",    material: "Concrete Tile (S-Tile)", sqft: 2800 },
    { first: "Karen",   last: "Wallace",  phone4: "0207", street: "2240 Avalon Rd",      zip: "34787", status: "won",       material: "Architectural Shingle", sqft: 2200 },
    { first: "Brett",   last: "Hammond",  phone4: "0241", street: "13601 Tilden Rd",     zip: "34787", status: "new",       material: "3-Tab Shingle",          sqft: 1800 },
    { first: "Stacy",   last: "Park",     phone4: "0268", street: "9305 Bay Vista Dr",   zip: "34786", status: "contacted", material: "Architectural Shingle", sqft: 2400 },
    { first: "Jonas",   last: "Webb",     phone4: "0292", street: "318 Stoneybrook Way", zip: "34786", status: "quoted",    material: "Standing Seam Metal",    sqft: 2500 },
    { first: "Heather", last: "Lange",    phone4: "0316", street: "1422 Lakeview Dr",    zip: "34787", status: "new",       material: "Architectural Shingle", sqft: 2000 },
    { first: "Tyler",   last: "Boone",    phone4: "0349", street: "806 E Crown Point Rd",zip: "34787", status: "lost",      material: "Architectural Shingle", sqft: 1950 },
    { first: "Rosa",    last: "Salinas",  phone4: "0378", street: "210 N Highland Ave",  zip: "34787", status: "won",       material: "Concrete Tile (S-Tile)", sqft: 2600 },
    { first: "Wade",    last: "Coleman",  phone4: "0411", street: "5505 Reams Rd",       zip: "34787", status: "quoted",    material: "Architectural Shingle", sqft: 2150 },
  ],
  stratus: [
    { first: "Brandon",  last: "Stevens",  phone4: "0131", street: "3420 Atlantic Blvd",   zip: "32207", status: "new",       material: "Architectural Shingle",  sqft: 2300 },
    { first: "Tiffany",  last: "Walsh",    phone4: "0167", street: "1208 Riverplace Blvd", zip: "32207", status: "contacted", material: "Concrete Tile (S-Tile)",  sqft: 2700 },
    { first: "Marcus",   last: "Thornton", phone4: "0193", street: "9876 San Jose Blvd",   zip: "32257", status: "quoted",    material: "Architectural Shingle",  sqft: 2500 },
    { first: "Amber",    last: "Whitaker", phone4: "0218", street: "415 Park St",          zip: "32204", status: "won",       material: "Standing Seam Metal",     sqft: 2400 },
    { first: "Kyle",     last: "Greer",    phone4: "0246", street: "4400 Roosevelt Blvd",  zip: "32210", status: "new",       material: "3-Tab Shingle",          sqft: 1850 },
    { first: "Bianca",   last: "Hollins",  phone4: "0273", street: "2702 Hendricks Ave",   zip: "32207", status: "contacted", material: "Architectural Shingle",  sqft: 2200 },
    { first: "Reggie",   last: "Whitfield",phone4: "0301", street: "5118 Beach Blvd",      zip: "32207", status: "quoted",    material: "Concrete Tile (S-Tile)",  sqft: 2900 },
    { first: "Hannah",   last: "Costa",    phone4: "0334", street: "1340 Greenridge Rd",   zip: "32207", status: "new",       material: "Architectural Shingle",  sqft: 2050 },
    { first: "Jared",    last: "Donovan",  phone4: "0357", street: "8125 Baymeadows Rd",   zip: "32256", status: "lost",      material: "Architectural Shingle",  sqft: 2100 },
    { first: "Naomi",    last: "Banks",    phone4: "0381", street: "3604 St Johns Ave",    zip: "32205", status: "won",       material: "Architectural Shingle",  sqft: 2350 },
    { first: "Calvin",   last: "Reyes",    phone4: "0419", street: "6710 Old Kings Rd",    zip: "32219", status: "quoted",    material: "Standing Seam Metal",     sqft: 2500 },
    { first: "Lisa",     last: "Townsend", phone4: "0446", street: "2401 Atlantic Blvd",   zip: "32207", status: "contacted", material: "Architectural Shingle",  sqft: 2200 },
  ],
};

// Stagger times: oldest seeds first, recent last.
// Per-office spacing scales with volume — bigger offices = newer leads
// land closer together.
const SPACING_HOURS: Record<DemoOfficeSlug, number> = {
  nolands: 6,
  "quality-first": 14,
  "earl-johnston": 9,
  "west-orange": 22,
  stratus: 11,
};

// ─── Lead generator ───────────────────────────────────────────────────

export function getDemoLeads(slug: DemoOfficeSlug): Lead[] {
  const seeds = SEEDS[slug];
  const meta = CITY_META[slug];
  const officeId = officeIdOf(slug);
  const spacing = SPACING_HOURS[slug];
  const tcpaText = "I agree to receive calls and texts from this roofing company about my quote.";

  // Reverse so the most recent lead is index 0 (matches list order)
  return seeds
    .map((p, i) => {
      const band = estimateBand(p.material, p.sqft);
      const createdAt = hoursAgo(spacing * (i + 1));
      const lead: Lead = {
        id: id("lead", slug, i),
        office_id: officeId,
        public_id: `${slug}-${i.toString().padStart(3, "0")}`,
        name: `${p.first} ${p.last}`,
        email: `${p.first}.${p.last}`.toLowerCase().replace(/[^a-z.]/g, "") + "@example.com",
        phone: `+1${meta.area}555${p.phone4}`,
        address: `${p.street}, ${meta.city} ${slug === "earl-johnston" ? "FL" : "FL"} ${p.zip}`,
        zip: p.zip,
        county: meta.county,
        lat: meta.lat + (i % 7) * 0.004 - 0.014,
        lng: meta.lng + (i % 5) * 0.006 - 0.012,
        estimated_sqft: p.sqft,
        estimate_low: band.low,
        estimate_high: band.high,
        material: p.material,
        selected_add_ons: i % 3 === 0 ? ["drip_edge", "ice_water_shield"] : null,
        source: sourceFor(i),
        status: p.status,
        notes: null,
        tcpa_consent: true,
        tcpa_consent_at: createdAt,
        tcpa_consent_text: tcpaText,
        // Assignment fields (added by migration 0007). For demo we
        // pretend every other lead is assigned to a fake rep id so the
        // rep-view filter has something to chew on. Real users get a
        // real auth.uid() here from /api/leads + the rep tool.
        assigned_to: i % 2 === 0 ? `demo-rep-${slug}` : null,
        assigned_at: i % 2 === 0 ? createdAt : null,
        // V3 roof payload — demo rows are pre-V3, leave null. Real
        // leads from /estimate-v2 carry painted_url + sqft + edges.
        roof_v3_json: null,
        created_at: createdAt,
        updated_at: createdAt,
      };
      return lead;
    })
    .reverse();
}

function sourceFor(i: number): string {
  // ~50% inbound voice, ~30% web quote, ~15% outbound, ~5% embed
  const r = i % 20;
  if (r < 10) return "sydney_inbound";
  if (r < 16) return "quote_form";
  if (r < 19) return "sydney_outbound";
  return "embed";
}

// ─── Call generator (Sydney) ──────────────────────────────────────────
//
// Transcripts follow Sydney's actual script in
// agents/sydney/prompts/sydney_system_prompt_v2.md:
//   - Verbatim opener with AI + recording disclosures
//   - Warm Southern receptionist tone, filler words ("got it",
//     "alright", "mhm", "sure thing"), contractions, one-question turns
//   - Five-phase flow on routine bookings:
//       1. Greet & Listen → 2. Empathy & Diagnose → 3. Address &
//       Service Area → 4. Inspection Setup → 5. Confirm & Close
//   - Spells out numbers ("one to five" not "1-5", "twelve thirty-four")
//   - Close: "Perfect. One of our specialists from the [office] office
//     will give you a call the morning of..." then "Alright, thanks so
//     much for calling. We'll take good care of you. Have a great day."
//
// Outcome enum matches /api/agent/events line 64 EXACTLY:
//   booked / transferred / logged_lead / no_show / wrong_number /
//   cap_duration / cap_turns / unknown

type Outcome =
  | "booked"
  | "transferred"
  | "logged_lead"
  | "no_show"
  | "wrong_number"
  | "cap_duration"
  | "cap_turns";

interface CallShape {
  outcome: Outcome;
  durationSec: number;
  turnCount: number;
  promptTokens: number;
  completionTokens: number;
  sttSecs: number;
  ttsChars: number;
  summaryFor: (firstName: string) => string;
  transcriptFor: (args: {
    firstName: string;
    addressShort: string;
    company: string;
    officeLabel: string;
  }) => string;
}

function opener(company: string): string {
  return (
    `Sydney: Thanks for calling ${company}. This is Sydney, your virtual booking assistant. ` +
    `This call may be recorded for quality. What can I help you with today?`
  );
}

const CALL_SHAPES: Record<Outcome, CallShape> = {
  booked: {
    outcome: "booked",
    durationSec: 224,
    turnCount: 18,
    promptTokens: 2240,
    completionTokens: 520,
    sttSecs: 224,
    ttsChars: 1480,
    summaryFor: (n) =>
      `${n} called about visible shingle damage after last week's storm. Confirmed homeowner, property in service area, ` +
      `roof ~13 years old. Booked free inspection for tomorrow afternoon, one to five window. log_lead fired with type new_inspection.`,
    transcriptFor: ({ firstName: n, addressShort, company, officeLabel }) =>
      [
        opener(company),
        `${n}: Yeah hi, I think I need somebody out to look at my roof — it's been leaking a little after that last storm.`,
        `Sydney: Oh man — got it. Yeah let's get someone out there to take a look. Was that from a recent storm by any chance?`,
        `${n}: Last Thursday, yeah.`,
        `Sydney: Mhm, okay. And how old is the roof, do you know?`,
        `${n}: I want to say thirteen years, maybe fourteen.`,
        `Sydney: Alright, that's right in the window where we'd want eyes on it. What's the address over there so I can make sure the right team takes care of you?`,
        `${n}: ${addressShort}.`,
        `Sydney: Got it — ${addressShort}. Sound right?`,
        `${n}: That's right.`,
        `Sydney: And you're the homeowner on the property?`,
        `${n}: Yes ma'am.`,
        `Sydney: Cool — we do free inspections, no obligation. Takes about thirty to forty-five minutes. Do mornings or afternoons work better for you?`,
        `${n}: Afternoons probably.`,
        `Sydney: What day this week or next would be good?`,
        `${n}: Tomorrow if you can.`,
        `Sydney: Sure thing. I can put you down for tomorrow afternoon, between one and five.`,
        `${n}: That works.`,
        `Sydney: Alright. Can I get your full name?`,
        `${n}: ${n} — last name's on file.`,
        `Sydney: And the best number to reach you on?`,
        `${n}: Same number I'm calling from.`,
        `Sydney: Got it. And an email for the confirmation?`,
        `${n}: It's the one on file.`,
        `Sydney: Alright, let me read this back. I've got you down for tomorrow afternoon, between one and five, at ${addressShort}. Sound right?`,
        `${n}: That's it.`,
        `Sydney: Perfect. One of our specialists from the ${officeLabel} office will give you a call the morning of to let you know they're on the way. You'll get a text confirmation in just a minute. Anything else I can help you with?`,
        `${n}: No that's it, thank you.`,
        `Sydney: Alright, thanks so much for calling. We'll take good care of you. Have a great day.`,
      ].join("\n"),
  },
  transferred: {
    outcome: "transferred",
    durationSec: 64,
    turnCount: 6,
    promptTokens: 720,
    completionTokens: 160,
    sttSecs: 64,
    ttsChars: 380,
    summaryFor: (n) =>
      `${n} pushed on insurance claim handling after initial qualifying. Per FL § 627.7152 trip-wire rules, ` +
      `Sydney transferred to specialist with caller summary. transfer_to_human fired with reason "sales".`,
    transcriptFor: ({ firstName: n, company }) =>
      [
        opener(company),
        `${n}: Hi yeah, I had an adjuster out for hail damage and they lowballed me. I want someone to handle the claim and work directly with my insurance.`,
        `Sydney: Got it. Insurance work — that's something our specialist walks through. Let me get you to someone who can help, one moment.`,
        `${n}: Okay, thanks.`,
        `Sydney: Sure thing — flagging this and connecting you now.`,
        `[transfer_to_human invoked — reason "sales", priority "normal"]`,
      ].join("\n"),
  },
  logged_lead: {
    outcome: "logged_lead",
    durationSec: 108,
    turnCount: 10,
    promptTokens: 1080,
    completionTokens: 240,
    sttSecs: 108,
    ttsChars: 660,
    summaryFor: (n) =>
      `${n} called about a roof leak but the address is outside the four-office service area. Per Golden Rule, ` +
      `framed as fit not judgment, collected name/phone/email/notes. log_lead fired with type "outside_area".`,
    transcriptFor: ({ firstName: n, company }) =>
      [
        opener(company),
        `${n}: Hi yeah, I've got a leak in the back bedroom from last night's rain. Wondering if you all can come take a look.`,
        `Sydney: Oh no, okay — let's see what we can do. Is the water still coming in right now?`,
        `${n}: Not actively, but I've got a stain spreading on the ceiling.`,
        `Sydney: Mhm, got it. What's the address over there so I can make sure the right team takes care of you?`,
        `${n}: It's a little ways out — Tallahassee, off Apalachee Parkway.`,
        `Sydney: Got it — for our service area we cover the ${company.split(" ")[0]} region primarily. Let me take down your info and the team will reach out to see if we can still help.`,
        `${n}: Sure, that'd be great.`,
        `Sydney: Alright. Can I get your full name and the best number to reach you on?`,
        `${n}: ${n} — and the number I'm calling from is fine.`,
        `Sydney: Got it. And an email so we can send something over if it makes sense?`,
        `${n}: I'll spell it for you.`,
        `Sydney: Sure thing.`,
        `${n}: [email spelled]`,
        `Sydney: Got it. Alright, someone will reach out by tomorrow if we can help. Thanks so much for calling.`,
        `[log_lead invoked — type "outside_area"]`,
      ].join("\n"),
  },
  no_show: {
    outcome: "no_show",
    durationSec: 218,
    turnCount: 17,
    promptTokens: 2180,
    completionTokens: 510,
    sttSecs: 218,
    ttsChars: 1460,
    summaryFor: (n) =>
      `${n} originally booked a free inspection on this call — full five-phase flow, log_lead fired. Outcome updated ` +
      `to "no_show" later by the office after the inspector arrived and there was no answer at the door.`,
    transcriptFor: ({ firstName: n, addressShort, company, officeLabel }) =>
      [
        opener(company),
        `${n}: Hey, I'd like to get someone out to look at my roof. The neighbor said you all did theirs.`,
        `Sydney: Sure thing, glad they sent you our way. What's going on with the roof?`,
        `${n}: Just looks rough up there — some shingles curling. It's old.`,
        `Sydney: Mhm, okay. How old is the roof, do you know?`,
        `${n}: I want to say eighteen years.`,
        `Sydney: Alright, that's right in the window where we'd want eyes on it. What's the address over there so I can make sure the right team takes care of you?`,
        `${n}: ${addressShort}.`,
        `Sydney: Got it — ${addressShort}. Sound right?`,
        `${n}: Yep.`,
        `Sydney: And you're the homeowner on the property?`,
        `${n}: I am.`,
        `Sydney: Cool — we do free inspections, no obligation. Takes about thirty to forty-five minutes. Do mornings or afternoons work better for you?`,
        `${n}: Mornings.`,
        `Sydney: What day this week or next would be good?`,
        `${n}: This Friday if you've got room.`,
        `Sydney: Sure thing. I can put you down for Friday morning, between nine and noon.`,
        `${n}: That works.`,
        `Sydney: Alright, let me read this back. I've got you down for Friday morning, between nine and noon, at ${addressShort}. Sound right?`,
        `${n}: Yep, sounds good.`,
        `Sydney: Perfect. One of our specialists from the ${officeLabel} office will give you a call the morning of to let you know they're on the way. You'll get a text confirmation in just a minute. Anything else I can help you with?`,
        `${n}: No that's it.`,
        `Sydney: Alright, thanks so much for calling. We'll take good care of you. Have a great day.`,
        `[Office update — Friday morning: inspector arrived, no answer at the door after two attempts and a voicemail. Outcome flipped to no_show.]`,
      ].join("\n"),
  },
  wrong_number: {
    outcome: "wrong_number",
    durationSec: 22,
    turnCount: 3,
    promptTokens: 240,
    completionTokens: 40,
    sttSecs: 22,
    ttsChars: 180,
    summaryFor: () => `Caller dialed in error — was looking for a different business. No lead created.`,
    transcriptFor: ({ firstName: n, company }) =>
      [
        opener(company),
        `${n}: Oh — I think I dialed wrong, I was trying to reach my electric company.`,
        `Sydney: No worries — this is the roofing line. Best of luck getting them sorted.`,
        `${n}: Sorry about that.`,
        `Sydney: All good, ya'll have a good one.`,
      ].join("\n"),
  },
  cap_duration: {
    outcome: "cap_duration",
    durationSec: 412,
    turnCount: 32,
    promptTokens: 4120,
    completionTokens: 980,
    sttSecs: 412,
    ttsChars: 2480,
    summaryFor: (n) =>
      `${n} described multiple roof concerns and asked extensive questions about materials. Call exceeded duration cap ` +
      `at six minutes fifty-two seconds. Sydney gracefully wrapped with a callback offer; office to follow up. log_lead fired with type "callback".`,
    transcriptFor: ({ firstName: n, company }) =>
      [
        opener(company),
        `${n}: Hi, I've been thinking about replacing my roof and I have a lot of questions about the different materials.`,
        `Sydney: Sure thing, happy to help where I can. What's prompting the replacement?`,
        `${n}: Well, it's an older home, and I've been looking at metal versus tile versus the architectural shingles...`,
        `[...several minutes of homeowner questions on materials, warranties, financing, and timing...]`,
        `Sydney: Got it. Yeah every roof's a little different — the specialist will give you a real number and walk you through the options after they come out. Where I want to take you is the inspection so you've got real data to compare against what you've been reading.`,
        `${n}: That makes sense. Let me check my calendar and call you back.`,
        `Sydney: Sure thing — and if you'd like, I can take your name and number now so someone reaches out at a good time for you.`,
        `${n}: Yeah, ${n}, and the number I'm calling from.`,
        `Sydney: Got it. Someone from the team will give you a call back tomorrow. Thanks so much for calling.`,
        `[log_lead invoked — type "callback"]`,
      ].join("\n"),
  },
  cap_turns: {
    outcome: "cap_turns",
    durationSec: 286,
    turnCount: 41,
    promptTokens: 3260,
    completionTokens: 780,
    sttSecs: 286,
    ttsChars: 1860,
    summaryFor: (n) =>
      `${n} cycled through repeated objections (price, shopping around, spouse approval). Sydney hit the turn cap ` +
      `after three objection axes and gracefully exited with the lead logged. log_lead fired with type "callback".`,
    transcriptFor: ({ firstName: n, company }) =>
      [
        opener(company),
        `${n}: I'm just calling to get a ballpark price on a new roof.`,
        `Sydney: Yeah every roof's a little different — depends on the size, the materials, the slope. The specialist will give you a real number after the inspection. Want to get someone out this week?`,
        `${n}: I really just want a number over the phone.`,
        `Sydney: I hear you — but I really can't ballpark something I haven't seen. The free inspection takes thirty to forty-five minutes and you get a written estimate. Mornings or afternoons work better?`,
        `${n}: I'm shopping around, just want to compare.`,
        `Sydney: Smart move. We do best when folks compare us. Want me to get someone out so you've got a real number to compare?`,
        `${n}: I need to check with my husband first.`,
        `Sydney: Of course — and totally fair. Let me grab your name and number, and someone will follow up after you've had a chance to talk it over. Sound good?`,
        `${n}: Yeah okay. ${n}, and the number I'm calling from.`,
        `Sydney: Got it. Thanks so much for calling — someone will reach out this week. Have a great day.`,
        `[log_lead invoked — type "callback"]`,
      ].join("\n"),
  },
};

// Distribution of outcomes per office — recent-first. Mix targets a
// realistic answered-and-engaged Sydney run. ~45% booked, ~20%
// transferred, ~15% logged_lead, ~10% no_show, ~5% wrong_number, ~5%
// cap_duration/cap_turns. All outcomes match the enum in
// /api/agent/events line 64 EXACTLY — no invented states.
const CALL_OUTCOMES_PER_OFFICE: Record<DemoOfficeSlug, Outcome[]> = {
  nolands: [
    "booked", "booked", "transferred", "booked", "logged_lead",
    "booked", "no_show", "transferred", "booked", "logged_lead",
    "booked", "wrong_number", "booked", "cap_duration",
  ],
  "quality-first": [
    "booked", "transferred", "logged_lead", "booked", "booked",
    "transferred", "logged_lead", "wrong_number", "booked", "cap_turns",
  ],
  "earl-johnston": [
    "booked", "booked", "transferred", "booked", "no_show",
    "booked", "transferred", "logged_lead", "booked", "wrong_number",
    "booked", "cap_duration",
  ],
  "west-orange": [
    "booked", "transferred", "logged_lead", "booked", "logged_lead",
    "booked", "wrong_number", "no_show",
  ],
  stratus: [
    "booked", "booked", "transferred", "logged_lead", "booked",
    "cap_turns", "booked", "transferred", "booked", "wrong_number",
  ],
};

export function getDemoCalls(slug: DemoOfficeSlug): Call[] {
  const seeds = SEEDS[slug];
  const meta = CITY_META[slug];
  const officeId = officeIdOf(slug);
  const outcomes = CALL_OUTCOMES_PER_OFFICE[slug];
  const calls: Call[] = [];

  outcomes.forEach((outcome, i) => {
    const shape = CALL_SHAPES[outcome];
    // Stagger calls — recent first. Spacing tighter for busier offices.
    const minutesAgo = 14 + i * 47;
    const startedAt = ago(minutesAgo);
    const endedAt = new Date(
      Date.now() - minutesAgo * 60_000 + shape.durationSec * 1000,
    ).toISOString();

    // Tie ~70% of calls to a real lead in this office:
    //   booked / no_show — Sydney got the full address (5-phase flow)
    //   transferred — Sydney captured caller summary before transfer
    //   logged_lead — Sydney captured contact info on Golden-Rule fit exit
    //   cap_duration / cap_turns — Sydney still captured a callback lead
    //   wrong_number — NOT linkable, no real caller info
    const linkable = outcome !== "wrong_number";
    const seedIdx = i % seeds.length;
    const seed = seeds[seedIdx];
    const leadId = linkable ? id("lead", slug, seeds.length - 1 - seedIdx) : null;

    const firstName = linkable ? seed.first : "Caller";
    const addressShort = linkable ? `${seed.street}, ${meta.city}` : "";

    calls.push({
      id: id("call", slug, i),
      office_id: officeId,
      lead_id: leadId,
      agent_name: "Sydney",
      room_name: `voxaris-${slug}-${i.toString().padStart(4, "0")}`,
      caller_number: linkable ? `+1${meta.area}555${seed.phone4}` : `+1${meta.area}5550${(i * 7 + 11) % 1000}`,
      started_at: startedAt,
      ended_at: endedAt,
      duration_sec: shape.durationSec,
      // Token / STT / TTS usage stay populated for any internal admin
      // view that wants them, but estimated_cost_usd is intentionally
      // null in demo data — the client-facing dashboard never surfaces
      // per-call Voxaris cost. See CallsTable.tsx (cost displays removed).
      llm_prompt_tokens: shape.promptTokens,
      llm_completion_tokens: shape.completionTokens,
      stt_secs: shape.sttSecs,
      tts_chars: shape.ttsChars,
      turn_count: shape.turnCount,
      estimated_cost_usd: null,
      outcome,
      summary: shape.summaryFor(firstName),
      transcript: shape.transcriptFor({
        firstName,
        addressShort,
        company: meta.company,
        officeLabel: meta.closeOfficeLabel,
      }),
      created_at: startedAt,
    });
  });

  return calls;
}

// ─── Event generator ──────────────────────────────────────────────────
//
// Match the event types written by /api/agent/events:
//   - call_started
//   - tool_fired:<tool>     where tool is check_availability /
//                           book_inspection / transfer_to_human / log_lead
//   - call_ended

export function getDemoEvents(slug: DemoOfficeSlug): Event[] {
  const calls = getDemoCalls(slug);
  const officeId = officeIdOf(slug);
  const events: Event[] = [];
  let evtCounter = 0;

  for (const call of calls) {
    if (!call.outcome) continue;
    const tStart = new Date(call.started_at).getTime();
    const tEnd = call.ended_at ? new Date(call.ended_at).getTime() : tStart;

    // call_started at t=0
    events.push({
      id: id("evt", slug, evtCounter++),
      office_id: officeId,
      call_id: call.id,
      type: "call_started",
      at: new Date(tStart).toISOString(),
      payload: { caller_number: call.caller_number, room_name: call.room_name },
    });

    // tool_fired chain depends on outcome. Sydney's tools (per
    // agents/sydney/tools.py): transfer_to_human, check_availability,
    // book_inspection, log_lead. Sequence matches her 5-phase flow.
    if (call.outcome === "booked" || call.outcome === "no_show") {
      events.push({
        id: id("evt", slug, evtCounter++),
        office_id: officeId,
        call_id: call.id,
        type: "tool_fired:check_availability",
        at: new Date(tStart + (tEnd - tStart) * 0.55).toISOString(),
        payload: { requested_window: "tomorrow PM" },
      });
      events.push({
        id: id("evt", slug, evtCounter++),
        office_id: officeId,
        call_id: call.id,
        type: "tool_fired:book_inspection",
        at: new Date(tStart + (tEnd - tStart) * 0.78).toISOString(),
        payload: { status: "mock_logged" },
      });
      events.push({
        id: id("evt", slug, evtCounter++),
        office_id: officeId,
        call_id: call.id,
        type: "tool_fired:log_lead",
        at: new Date(tStart + (tEnd - tStart) * 0.9).toISOString(),
        payload: { lead_type: "new_inspection", status: "mock_logged" },
      });
    } else if (call.outcome === "transferred") {
      events.push({
        id: id("evt", slug, evtCounter++),
        office_id: officeId,
        call_id: call.id,
        type: "tool_fired:transfer_to_human",
        at: new Date(tStart + (tEnd - tStart) * 0.75).toISOString(),
        payload: { reason: "sales", priority: "normal" },
      });
    } else if (call.outcome === "logged_lead") {
      events.push({
        id: id("evt", slug, evtCounter++),
        office_id: officeId,
        call_id: call.id,
        type: "tool_fired:log_lead",
        at: new Date(tStart + (tEnd - tStart) * 0.85).toISOString(),
        payload: { lead_type: "outside_area", status: "mock_logged" },
      });
    } else if (call.outcome === "cap_duration" || call.outcome === "cap_turns") {
      events.push({
        id: id("evt", slug, evtCounter++),
        office_id: officeId,
        call_id: call.id,
        type: "tool_fired:log_lead",
        at: new Date(tStart + (tEnd - tStart) * 0.92).toISOString(),
        payload: { lead_type: "callback", status: "mock_logged" },
      });
    }

    // call_ended at tEnd. Cost intentionally not in payload — the
    // event timeline in the drawer renders only event.type, but if
    // any future view dumps payload, we don't want cost leaking.
    events.push({
      id: id("evt", slug, evtCounter++),
      office_id: officeId,
      call_id: call.id,
      type: "call_ended",
      at: new Date(tEnd).toISOString(),
      payload: {
        outcome: call.outcome,
        duration_sec: call.duration_sec,
      },
    });
  }

  return events;
}

export function getDemoEventsByCall(slug: DemoOfficeSlug): Record<string, Event[]> {
  const evts = getDemoEvents(slug);
  const byCall: Record<string, Event[]> = {};
  for (const e of evts) {
    if (!e.call_id) continue;
    (byCall[e.call_id] ??= []).push(e);
  }
  return byCall;
}

// ─── Proposal generator ───────────────────────────────────────────────
//
// Proposals are generated by reps from the internal estimator at
// pitch.voxaris.io/  — NOT by Sydney. So generated_by is always a
// plausible rep email, never sydney@voxaris.io.

const REP_EMAILS: Record<DemoOfficeSlug, string[]> = {
  nolands: ["mike.r@nolandsroofing.com", "jen.b@nolandsroofing.com"],
  "quality-first": ["chris.t@qualityfirstroof.com", "sandra.m@qualityfirstroof.com"],
  "earl-johnston": ["alex.p@earljohnstonroofing.com", "monica.r@earljohnstonroofing.com"],
  "west-orange": ["tony.w@westorangeroofing.com"],
  stratus: ["dan.k@stratusroofing.com", "priya.s@stratusroofing.com"],
};

// Proposals are made for leads in quoted / won status — those are the
// leads where a rep actually opened the estimator and saved the result.
export function getDemoProposals(slug: DemoOfficeSlug): Proposal[] {
  const leads = getDemoLeads(slug);
  const officeId = officeIdOf(slug);
  const reps = REP_EMAILS[slug];
  const eligible = leads.filter((l) => l.status === "quoted" || l.status === "won");

  return eligible.map((lead, i) => {
    const totalLow = lead.estimate_low ?? 9_000;
    const totalHigh = lead.estimate_high ?? 12_000;
    // Proposal created sometime after the lead — between 2h and 4d later.
    const leadCreatedAt = new Date(lead.created_at).getTime();
    const offsetMs = (2 + (i % 4) * 14) * 60 * 60 * 1000;
    const createdAt = new Date(leadCreatedAt + offsetMs).toISOString();

    return {
      id: id("prop", slug, i),
      office_id: officeId,
      lead_id: lead.id,
      public_id: `${slug}-p-${i.toString().padStart(3, "0")}`,
      snapshot: {
        material: lead.material ?? "Architectural Shingle",
        estimated_sqft: lead.estimated_sqft ?? 2200,
        line_items: [],
        demo: true,
      },
      total_low: totalLow,
      total_high: totalHigh,
      // ~70% have a PDF ready, ~30% pending (reflects real rep
      // workflow where some reps save before generating the PDF)
      pdf_url: i % 10 < 7 ? `/p/${slug}-p-${i.toString().padStart(3, "0")}/pdf` : null,
      generated_by: reps[i % reps.length],
      created_at: createdAt,
    };
  });
}
