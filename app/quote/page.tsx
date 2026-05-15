"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { BotIdClient } from "botid/client";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  MapPin,
  Phone,
} from "lucide-react";
import Link from "next/link";
import { BoltStyleHero, type QuoteHeroFormValues } from "@/components/ui/bolt-style-chat";
import NavHeader from "@/components/ui/nav-header";
import PublicHeader from "@/components/ui/public-header";
import PublicFooter from "@/components/ui/public-footer";
import {
  StatsStrip,
  HowItWorks,
  Testimonials,
  FAQ,
  TrustStrip,
} from "@/components/quote/BelowFold";
import EditableRoofMap from "@/components/quote/EditableRoofMap";
import { fmt, MATERIAL_RATES } from "@/lib/pricing";
import { saveEstimateV2 } from "@/lib/storage";
import type {
  AddressInfo,
  Assumptions,
  AddOn,
  Estimate,
  Material,
  Pitch,
} from "@/types/estimate";
import type {
  EstimateV2,
  Material as RoofMaterial,
  PricedEstimate,
  PricingInputs,
  RoofData,
} from "@/types/roof";
import { priceRoofData } from "@/lib/roof-engine";
import { RoofTotalsCard } from "@/components/roof/RoofTotalsCard";
import MeasurementVerification from "@/components/roof/MeasurementVerification";
import { DetectedFeaturesPanel } from "@/components/roof/DetectedFeaturesPanel";
import { BRAND_CONFIG } from "@/lib/branding";

// 3D viewer is heavy (Cesium + 3D Tiles) — lazy-load it so the initial
// /quote bundle stays small. SSR off because Cesium is browser-only.
// Tier A.2 visual layer for tier-a-lidar RoofData. Lazy-loaded; falls
// through to Roof3DViewer for Tier B/C data.
const RoofViewer = dynamic(() => import("@/components/roof/RoofViewer"), {
  ssr: false,
});
// Standalone Three.js LiDAR roof renderer. No Google 3D Tiles, no
// Cesium — just a stylized rendering of the per-facet LiDAR output.
// Replaces the old Cesium-overlay path when we have Tier A data
// because a stylized standalone render reads as intentional, while
// an overlay onto a photorealistic mesh creates visible mismatch
// when our measurement isn't perfect.
const RoofRenderer = dynamic(() => import("@/components/roof/RoofRenderer"), {
  ssr: false,
});
const Roof3DViewer = dynamic(() => import("@/components/Roof3DViewer"), {
  ssr: false,
});

const STEPS = ["Lead", "Roof", "Material", "Quote"] as const;
type StepKey = (typeof STEPS)[number];

interface SimpleAddon {
  id: string;
  label: string;
  price: number;
  enabled: boolean;
}

/**
 * Spherical polygon footprint in square feet via shoelace on lat/lng
 * (degrees → meters via cos-latitude scaling). Lives here, not lib/, so the
 * customer wizard has no dependency on the rep-side polygon utilities and
 * stays small for the hero bundle.
 */
function polygonAreaSqftLocal(poly: Array<{ lat: number; lng: number }>): number {
  if (poly.length < 3) return 0;
  const M = 111_320;
  const cLat = poly.reduce((s, v) => s + v.lat, 0) / poly.length;
  const cosLat = Math.cos((cLat * Math.PI) / 180);
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ax = a.lng * M * cosLat;
    const ay = a.lat * M;
    const bx = b.lng * M * cosLat;
    const by = b.lat * M;
    sum += ax * by - bx * ay;
  }
  const m2 = Math.abs(sum) / 2;
  return m2 * 10.7639;
}

const QUOTE_ADDONS: SimpleAddon[] = [
  { id: "ice-water", label: "Ice & water shield", price: 850, enabled: false },
  { id: "ridge-vent", label: "Upgraded ventilation", price: 425, enabled: false },
  { id: "gutters", label: "Seamless gutters", price: 1850, enabled: false },
  { id: "skylight", label: "Skylight replacement", price: 950, enabled: false },
];

const MATERIAL_COPY: Record<
  Material,
  { title: string; tagline: string; warranty: string }
> = {
  "asphalt-3tab": {
    title: "Builder Grade Shingle",
    tagline: "Reliable, budget-friendly",
    warranty: "20-year warranty",
  },
  "asphalt-architectural": {
    title: "Architectural Shingle",
    tagline: "Most popular · best value",
    warranty: "30-year warranty",
  },
  "metal-standing-seam": {
    title: "Standing-Seam Metal",
    tagline: "Premium · 50+ year lifespan",
    warranty: "50-year warranty",
  },
  "tile-concrete": {
    title: "Concrete Tile",
    tagline: "Distinctive · Mediterranean look",
    warranty: "Lifetime warranty",
  },
};

interface QuotePageProps {
  /** Business slug this estimator is branded for. Drives the `office`
   *  field on every /api/leads submission so the resulting lead lands
   *  in the right office_id and Sydney's outbound call brands as the
   *  correct company. Defaults to "nolands" because that's the only
   *  live customer today — bare /quote visitors should go there. The
   *  `/quote/[office]` branded route always overrides this. */
  office?: string;
}

export default function QuotePage({ office = "nolands" }: QuotePageProps = {}) {
  // `?nocache=1` URL param — debug toggle so the user can force a
  // fresh SAM3 round-trip during the demo (bypasses the Redis cache
  // for the resolved polygon). Read once on mount via
  // window.location.search instead of useSearchParams because the
  // latter triggers a CSR-bailout that would require this page to
  // be wrapped in <Suspense> — costly refactor relative to the
  // value of the flag, which never needs to change mid-session.
  // Falls safely to false during SSR / when the param isn't set.
  const [noCacheParam, setNoCacheParam] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setNoCacheParam(
      new URLSearchParams(window.location.search).get("nocache") === "1",
    );
  }, []);
  const sam3NoCacheSuffix = noCacheParam ? "&nocache=1" : "";

  const [step, setStep] = useState<StepKey>("Lead");
  const [lead, setLead] = useState<QuoteHeroFormValues | null>(null);
  const [address, setAddress] = useState<AddressInfo | null>(null);
  const [sqft, setSqft] = useState<number | null>(null);
  const [pitch, setPitch] = useState<string | null>(null);
  const [satelliteUrl, setSatelliteUrl] = useState<string | null>(null);
  // Polygon shown overlaid on the satellite tile so the customer can
  // visually confirm "yes, that's my roof" before trusting the sqft.
  // Comes from whichever tier won (Solar mask / Roboflow / MS Buildings);
  // null when nothing usable returned (manual-entry case).
  const [roofPolygon, setRoofPolygon] = useState<Array<{ lat: number; lng: number }> | null>(null);
  // Classifies the resolved polygon so onPolygonEdited can re-apply the
  // correct multipliers. "wall" sources (MS Buildings, SAM3 reconciler
  // substitution) need the 1.06 eave-overhang factor; "eave" sources
  // (raw SAM3, Solar mask) trace roof material directly and don't.
  const [polygonKind, setPolygonKind] = useState<"eave" | "wall" | null>(null);
  const [loadingRoof, setLoadingRoof] = useState(false);
  // Set true while the "Wrong roof? Tap your house" flow is waiting on
  // a /api/sam3-roof re-trace. The EditableRoofMap renders a spinner +
  // disables both action buttons while this is true so the customer
  // can't fire multiple expensive Roboflow inferences accidentally.
  const [pickingLoading, setPickingLoading] = useState(false);
  // Commercial-scale flag — flipped on when the measured polygon
  // footprint exceeds the residential instant-quote band (>20k sqft).
  // The wizard pivots to a "Talk to a Voxaris rep" branch instead of
  // running the customer through a polygon-failure cascade. Honest UX:
  // we measured your roof and it's bigger than this product is
  // designed for; here's what happens next.
  //
  // The 20k upper limit matches the internal rep tool's
  // `passesAbsoluteSize` gate (app/(internal)/page.tsx:577). Before
  // the alignment /quote rejected anything over 15k, which silently
  // dropped legitimate SAM3 traces of large estates AND of cases
  // where SAM3 picked the wrong building (a 5,000 sqft pole barn
  // traces in the 4-6k band; SAM3 over-traces of complex compounds
  // can clear 15k). On the rep side those traces are accepted and
  // reviewed; on /quote they were falling through to Solar mask or
  // MS Buildings even though SAM3's trace was actually the best
  // available auto-detect. Customers now see SAM3's polygon for
  // 15-20k footprints; the Wrong-roof / Draw-outline buttons let
  // them correct over-traces themselves.
  const [commercialFootprintSqft, setCommercialFootprintSqft] = useState<number | null>(null);
  const [material, setMaterial] = useState<Material>("asphalt-architectural");
  const [addOns, setAddOns] = useState<SimpleAddon[]>(QUOTE_ADDONS);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{
    leadId: string;
    proposalId: string;
  } | null>(null);
  const [submitError, setSubmitError] = useState("");
  /** Public id returned from the step-1 /api/leads call — final submit
   *  updates the same row instead of inserting a duplicate. */
  const existingLeadPublicIdRef = useRef<string | null>(null);

  // ─── Tier C unified pipeline (customer-side) ─────────────────────────
  // Replaces the per-page Solar/SAM3/MS-Buildings/Solar-mask cascade
  // with a single canonical RoofData feed via /api/roof-pipeline.
  // Drives RoofTotalsCard + DetectedFeaturesPanel + priceRoofData below.
  const [roofData, setRoofData] = useState<RoofData | null>(null);
  // Cross-compare payload: when the pipeline runs in `compare=1` mode it
  // returns BOTH the Tier A (LiDAR) and Tier C (Solar) RoofData in
  // parallel, so the 3D viewer can toggle between them and the rep can
  // sanity-check that both sources agree. Null when compare mode isn't
  // used or no compare run has resolved yet.
  const [roofCompare, setRoofCompare] = useState<{
    lidar: RoofData | null;
    solar: RoofData | null;
    agreement: {
      bothPresent: boolean;
      sqftDeltaPct: number | null;
      pitchDeltaDegrees: number | null;
      facetCountDelta: number | null;
    } | null;
  } | null>(null);
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  // Fetch-generation guard — protects against stale responses on rapid
  // address changes (same pattern used in /internal). Each fetch captures
  // the counter; a response whose captured myGen no longer matches the
  // current ref drops its result on the floor.
  const fetchGenRef = useRef(0);
  // Persisted estimate id for both v1 + v2 saves — kept stable across
  // wizard steps so a v2 save on the Quote step lands on the same row
  // the share link reads from.
  const estimateIdRef = useRef<string>(
    `est_${crypto.randomUUID().replace(/-/g, "")}`,
  );
  // Customer's explicit material pick — overrides vision-detected and
  // brand default. Null means "no pick yet, use detection chain".
  const [customerMaterial, setCustomerMaterial] = useState<Material | null>(
    null,
  );

  const stepIdx = STEPS.indexOf(step);

  // Pricing — uses RoofingCalculator's published low/high installed ranges per
  // sqft (already includes labor). Add-ons + tear-off layered on top.
  const range = useMemo(() => {
    if (!sqft) return { low: 0, high: 0 };
    const m = MATERIAL_RATES[material];
    const baseLow = sqft * m.low;
    const baseHigh = sqft * m.high;
    const tearoffLow = sqft * m.removeLow;
    const tearoffHigh = sqft * m.removeHigh;
    const adds = addOns.filter((a) => a.enabled).reduce((s, a) => s + a.price, 0);
    return {
      low: Math.round(baseLow + tearoffLow + adds),
      high: Math.round(baseHigh + tearoffHigh + adds),
    };
  }, [sqft, material, addOns]);

  // ─── Tier C — material selection chain ───────────────────────────────
  // Customer pick > vision detection (when confidence > 0.6) > brand
  // default. Drives the priceRoofData call below — the legacy `material`
  // state above is the customer-visible select; we still feed pricing
  // through this chain because future revisions may show a customer
  // an unselectable "detected by vision" hint.
  const materialFromVision = useMemo<Material | null>(() => {
    if (!roofData || roofData.confidence <= 0.6) return null;
    // Narrow the wider RoofData Material set down to the customer-
    // pickable estimate.ts set. wood-shake / flat-membrane never appear
    // in /quote's selector — when vision detects one, we fall through
    // to the brand default rather than priceRoofData throwing a
    // type-discriminated branch nobody designed for /quote.
    const v = roofData.totals.predominantMaterial as RoofMaterial | null;
    if (!v) return null;
    switch (v) {
      case "asphalt-3tab":
      case "asphalt-architectural":
      case "metal-standing-seam":
      case "tile-concrete":
        return v;
      default:
        return null;
    }
  }, [roofData]);
  const effectiveMaterial: Material =
    customerMaterial ?? materialFromVision ?? material ?? "asphalt-architectural";

  const pricingInputs = useMemo<PricingInputs>(
    () => ({
      material: effectiveMaterial,
      materialMultiplier: 1.0,
      laborMultiplier: 1.0,
      serviceType: "reroof-tearoff",
      addOns: addOns.map((a) => ({
        id: a.id,
        label: a.label,
        price: a.price,
        enabled: a.enabled,
      })),
      isInsuranceClaim: false,
    }),
    [effectiveMaterial, addOns],
  );

  const priced = useMemo<PricedEstimate | null>(() => {
    if (!roofData || roofData.source === "none") return null;
    return priceRoofData(roofData, pricingInputs);
  }, [roofData, pricingInputs]);

  // Once-per-address guard so RoofData-driven sqft seeding doesn't
  // re-stomp the customer's manual sqft edit (the RoofStep input is
  // editable). The customer's first edit "wins" and the pipeline value
  // never lands again for that address.
  const sqftTouchedRef = useRef(false);
  useEffect(() => {
    if (!roofData || roofData.source === "none") return;
    if (sqftTouchedRef.current) return;
    // Seed sqft from the canonical pipeline result so the customer-
    // facing RoofStep + the priced totals show consistent numbers.
    const pipelineSqft = roofData.totals.totalRoofAreaSqft;
    if (pipelineSqft > 0 && pipelineSqft !== sqft) {
      setSqft(pipelineSqft);
    }
  }, [roofData, sqft]);

  /** Tier C unified pipeline call. Replaces the legacy Solar / SAM3 /
   *  Solar-mask / MS-Buildings cascade — one fetch, one canonical
   *  RoofData feed for RoofTotalsCard + DetectedFeaturesPanel + pricing.
   *  Mirrors the fetch-generation guard from /internal so an in-flight
   *  fetch from an earlier address can't stomp the current one. */
  const runRoofPipelineFetch = async (addr: AddressInfo) => {
    if (addr.lat == null || addr.lng == null) return;
    const myGen = ++fetchGenRef.current;
    setPipelineLoading(true);
    setPipelineError(null);
    try {
      // compare=1 runs Tier A (LiDAR) and Tier C (Solar) in parallel and
      // returns BOTH so the 3D viewer can toggle. The response shape is
      // RoofComparison; we store `primary` in the existing roofData slot
      // (back-compat with downstream consumers) and the full payload in
      // `roofCompare` for the renderer's toggle.
      const res = await fetch(
        `/api/roof-pipeline?lat=${addr.lat}&lng=${addr.lng}` +
          `&address=${encodeURIComponent(addr.formatted ?? "")}` +
          `&compare=1` +
          sam3NoCacheSuffix,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`pipeline ${res.status}`);
      const compare = (await res.json()) as {
        primary: RoofData;
        lidar: RoofData | null;
        solar: RoofData | null;
        agreement: {
          bothPresent: boolean;
          sqftDeltaPct: number | null;
          pitchDeltaDegrees: number | null;
          facetCountDelta: number | null;
        };
      };
      if (fetchGenRef.current !== myGen) return; // stale
      setRoofData(compare.primary);
      setRoofCompare({
        lidar: compare.lidar,
        solar: compare.solar,
        agreement: compare.agreement,
      });
      // Note: we intentionally do NOT setRoofPolygon(data.outlinePolygon)
      // here. /quote's tier ladder (Tier 1 SAM3 → Tier 2 mask → Tier 3
      // MS Buildings) drives the displayed polygon, and SAM3 is usually
      // tighter than the bbox-rotated facets. The Tier C mask outline is
      // already integrated as a quality-gated fallback inside the tier
      // ladder below — see the SAM3 quality check.
    } catch (err) {
      if (fetchGenRef.current !== myGen) return;
      setPipelineError(err instanceof Error ? err.message : String(err));
      setRoofData(null);
    } finally {
      if (fetchGenRef.current === myGen) setPipelineLoading(false);
    }
  };

  /** When the lead form is submitted at the hero step:
   *   - Save contact info
   *   - Persist address + lat/lng
   *   - Fire Solar API for roof size + pitch
   *   - Advance to Roof confirmation
   *   - Submit a lead immediately so the contractor sees them even if they
   *     never finish the wizard
   */
  const onLeadSubmit = async (values: QuoteHeroFormValues) => {
    setSubmitting(true);
    setSubmitError("");
    setLead(values);

    // Fallback geocode — if the user typed an address and submitted
    // without picking an autocomplete suggestion, the form values won't
    // include lat/lng. Without coords, the page can't render a map or
    // measure the roof. Try to resolve the typed text via Places API
    // (autocomplete → details) before giving up.
    //
    // Important: we refuse to proceed if the resolved Place ID lacks a
    // `street_number`. Previously the fallback grabbed `suggestions[0]`
    // and accepted whatever Places returned — which on a typed "123
    // Main St" with no pick could resolve to "Main St" alone, silently
    // quoting a nearby roof instead of theirs. Refusing forces the
    // customer back to the address field with a clear message.
    let resolvedLat = values.lat;
    let resolvedLng = values.lng;
    let resolvedZip = values.zip;
    let resolvedFormatted = values.address;
    const userPickedFromAutocomplete = values.lat != null && values.lng != null;
    if (resolvedLat == null || resolvedLng == null) {
      try {
        const acRes = await fetch(
          `/api/places/autocomplete?q=${encodeURIComponent(values.address)}`,
        );
        if (acRes.ok) {
          const acData = (await acRes.json()) as {
            suggestions?: Array<{ placeId?: string }>;
          };
          const firstPlaceId = acData.suggestions?.[0]?.placeId;
          if (firstPlaceId) {
            const detailsRes = await fetch(
              `/api/places/details?placeId=${encodeURIComponent(firstPlaceId)}`,
            );
            if (detailsRes.ok) {
              const details = (await detailsRes.json()) as {
                lat?: number;
                lng?: number;
                zip?: string;
                formatted?: string;
                hasStreetNumber?: boolean;
              };
              if (
                typeof details.lat === "number" &&
                typeof details.lng === "number" &&
                details.hasStreetNumber === true
              ) {
                resolvedLat = details.lat;
                resolvedLng = details.lng;
                resolvedZip = details.zip ?? resolvedZip;
                resolvedFormatted = details.formatted ?? resolvedFormatted;
              }
            }
          }
        }
      } catch {
        /* silent — addr will lack coords; the refusal below handles it */
      }
    }

    // Refuse to proceed when we couldn't resolve to an actual house. The
    // customer typed text didn't match a street-level address, OR
    // matched a street with no house number. Pushing them through the
    // wizard from here would quote the wrong roof.
    if (resolvedLat == null || resolvedLng == null) {
      setSubmitting(false);
      setSubmitError(
        userPickedFromAutocomplete
          ? "We couldn't load your address details. Please try again."
          : "We couldn't find that exact address — please pick one of the suggestions or include a house number (e.g. 1234 Main St).",
      );
      return;
    }

    const addr: AddressInfo = {
      formatted: resolvedFormatted,
      zip: resolvedZip,
      lat: resolvedLat,
      lng: resolvedLng,
    };
    setAddress(addr);

    // Fire-and-forget early lead post (so the contractor gets the lead even
    // if the homeowner abandons the wizard before the final step).
    //
    // Use the RESOLVED address fields (addr.*) — not the raw form values.
    // When the customer typed an address without picking from autocomplete,
    // we resolved lat/lng via Places fallback above; the raw values.lat/lng
    // are undefined in that path. Previously the early lead posted the
    // unresolved coords, so CRM rows for typed-address submissions were
    // missing geo data even though the app had already resolved it.
    fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: values.name,
        email: values.email,
        phone: values.phone,
        address: addr.formatted,
        zip: addr.zip,
        lat: addr.lat,
        lng: addr.lng,
        // Tenancy — which business owns this lead. Drives /api/leads
        // routing, Sydney's outbound brand, dashboard visibility.
        office,
        source: "quote-wizard-step-1",
        // TCPA consent — captured at hero form. Server REQUIRES this
        // to be true before firing automated SMS / webhook / CRM
        // outreach. The hero form prevents submit until checked.
        tcpaConsent: values.tcpaConsent,
        tcpaConsentAt: values.tcpaConsentAt,
      }),
    })
      .then(async (r) => {
        if (!r.ok) return;
        const data = (await r.json()) as { leadId?: string };
        if (data.leadId) existingLeadPublicIdRef.current = data.leadId;
      })
      .catch(() => {
        /* silent */
      });

    // Resolve sqft + pitch via the tier ladder so customers on
    // Solar-uncovered addresses (rural / new construction / non-US) still
    // get a usable estimate instead of a stuck wizard.
    //   Tier 1: Solar segments sum  → photogrammetric, trust as-is
    //   Tier 2: Solar footprint × Solar pitch (when segments missing
    //           but findClosest still returned a building)
    //   Tier 3: Roboflow polygon × 1.118 (default 6/12 pitch). Polygon
    //           is roof-trained ML so it traces just the roof, not the
    //           whole-building footprint.
    //   Tier 4: Microsoft Buildings polygon × 1.118 (footprint × default
    //           pitch). Last resort before manual entry.
    if (addr.lat != null && addr.lng != null) {
      // Fire the Tier C unified pipeline in parallel with the legacy
      // cascade below. We don't await it — the legacy path still drives
      // `sqft` + `satelliteUrl` for the existing UI; the pipeline result
      // populates `roofData` for RoofTotalsCard + priceRoofData. Step 4
      // (refactor) deletes the legacy cascade in favor of pipeline-only.
      runRoofPipelineFetch(addr);

      setLoadingRoof(true);
      try {
        let resolvedSqft: number | null = null;
        let resolvedPitch: string | null = null;
        let resolvedPolygon: Array<{ lat: number; lng: number }> | null = null;
        // Tracks when the measured footprint exceeds the residential
        // instant-quote band (>15k sqft). We surface this to the
        // wizard so a commercial-scale property gets routed to a human
        // reviewer instead of silently failing through every tier.
        let oversizedFootprintSqft: number | null = null;

        // Solar findClosest (cheap, $0.010) fires in parallel with our SAM3
        // model — Solar gives us pitch + facet metadata regardless of which
        // polygon source wins. SAM3 (Tier 1) is the new primary; Solar mask
        // (Tier 2) is now a lazy fallback fired only when SAM3 returns
        // nothing, saving the $0.075 dataLayers cost on the common path.
        const [solarRes, sam3Res] = await Promise.all([
          fetch(`/api/solar?lat=${addr.lat}&lng=${addr.lng}`),
          // Pass address so the OSM building selector can match
          // `addr:housenumber` tags — meaningfully better residence
          // picking on multi-building rural parcels. Internal app
          // already did this; /quote was missing it.
          fetch(
            `/api/sam3-roof?lat=${addr.lat}&lng=${addr.lng}` +
              `&address=${encodeURIComponent(addr.formatted ?? "")}` +
              sam3NoCacheSuffix,
          ).catch(() => null),
        ]);

        // Pitch + footprint baseline from Solar findClosest.
        let pitchDegrees: number | null = null;
        let solarFootprintSqft: number | null = null;
        let solarSegmentSqft: number | null = null;
        let solarSegmentCount = 0;
        if (solarRes.ok) {
          const data = await solarRes.json();
          pitchDegrees = data.pitchDegrees ?? null;
          solarFootprintSqft = data.buildingFootprintSqft ?? null;
          solarSegmentSqft = data.sqft ?? null;
          solarSegmentCount = typeof data.segmentCount === "number" ? data.segmentCount : 0;
          resolvedPitch = data.pitch ?? null;
        }
        const slope =
          pitchDegrees && pitchDegrees > 0
            ? 1 / Math.cos((pitchDegrees * Math.PI) / 180)
            : 1.118; // default 6/12

        // Tier 1 — Custom SAM3 (with GIS reconciliation built-in server-side)
        let resolvedKind: "eave" | "wall" | null = null;
        let sam3Footprint: number | null = null;
        let sam3VertexCount = 0;
        let sam3Source: string | null = null;
        if (sam3Res?.ok) {
          try {
            const sam3 = await sam3Res.json();
            const poly: Array<{ lat: number; lng: number }> | null =
              Array.isArray(sam3?.polygon) && sam3.polygon.length >= 3 ? sam3.polygon : null;
            if (poly) {
              const footprintSqft =
                typeof sam3.footprintSqft === "number" && sam3.footprintSqft > 0
                  ? sam3.footprintSqft
                  : polygonAreaSqftLocal(poly);
              if (footprintSqft >= 200 && footprintSqft <= 20_000) {
                resolvedPolygon = poly;
                resolvedSqft = Math.round(footprintSqft * slope);
                sam3Footprint = footprintSqft;
                sam3VertexCount = poly.length;
                sam3Source = typeof sam3?.source === "string" ? sam3.source : null;
                // Reconciler returned "footprint-only" / "footprint-occluded"
                // → the polygon traces the GIS wall footprint (1.06 already
                // baked into footprintSqft). Other SAM3 sources trace eaves.
                resolvedKind =
                  sam3?.source === "footprint-only" ||
                  sam3?.source === "footprint-occluded"
                    ? "wall"
                    : "eave";
              } else if (footprintSqft > 20_000) {
                // Commercial-scale roof. Capture the measurement but DON'T
                // try to quote it instantly — surface a "connect with a
                // rep" branch to the wizard instead.
                oversizedFootprintSqft = footprintSqft;
              }
            }
          } catch {
            /* fall through to Solar mask */
          }
        }

        // Tier 1.5 — SAM3 quality gate. SAM3 sometimes returns a single
        // simplified rectangle on L-shaped / complex roofs, missing
        // gables and overhanging into lawn/driveway. When the cheap
        // signals say SAM3 is suspect, fetch the Solar dataLayers mask
        // (pixel-accurate, $0.075) and prefer it.
        //
        // Suspect signals (ANY):
        //   • SAM3 area is >30% off from Solar findClosest footprint
        //     (the two are independent measurements of the same building;
        //     disagreement is real signal)
        //   • SAM3 returned ≤5 vertices on a Solar building with ≥3
        //     facets (over-simplification — real roofs that complex
        //     have ≥6 polygon vertices)
        //   • SAM3 source is "footprint-only" / "footprint-occluded"
        //     (server-side fallback — same as Tier 3 quality)
        //
        // Disable with QUOTE_SAM3_MASK_QUALITY_GATE=0. The mask is
        // additive: we use it only if it returns a valid polygon. If
        // the gate triggers but mask fails, SAM3 stays.
        const qualityGateEnabled =
          process.env.NEXT_PUBLIC_QUOTE_SAM3_MASK_QUALITY_GATE !== "0";
        if (qualityGateEnabled && resolvedPolygon && sam3Footprint != null) {
          let suspect = false;
          let suspectReason = "";
          if (
            solarFootprintSqft &&
            Math.abs(sam3Footprint - solarFootprintSqft) / solarFootprintSqft > 0.30
          ) {
            suspect = true;
            suspectReason = `sam3_area_${Math.round(
              ((sam3Footprint - solarFootprintSqft) / solarFootprintSqft) * 100,
            )}pct_off_solar`;
          }
          // solarSegmentCount was extracted from solarRes above; we don't
          // re-fetch /api/solar here.
          if (!suspect && sam3VertexCount <= 5 && solarSegmentCount >= 3) {
            suspect = true;
            suspectReason = `sam3_${sam3VertexCount}vtx_for_${solarSegmentCount}_facets`;
          }
          if (
            !suspect &&
            (sam3Source === "footprint-only" || sam3Source === "footprint-occluded")
          ) {
            suspect = true;
            suspectReason = `sam3_fallback_source_${sam3Source}`;
          }
          if (suspect) {
            console.log("[telemetry] sam3_suspect_fetching_mask", {
              address: addr.formatted,
              reason: suspectReason,
              sam3Footprint,
              solarFootprintSqft,
              sam3VertexCount,
            });
            try {
              const maskRes = await fetch(
                `/api/solar-mask?lat=${addr.lat}&lng=${addr.lng}`,
              );
              if (maskRes.ok) {
                const mask = await maskRes.json();
                const poly: Array<{ lat: number; lng: number }> | null =
                  Array.isArray(mask?.latLng) && mask.latLng.length >= 3
                    ? mask.latLng
                    : null;
                if (poly) {
                  const maskFootprint = polygonAreaSqftLocal(poly);
                  if (maskFootprint >= 200 && maskFootprint <= 20_000) {
                    resolvedPolygon = poly;
                    resolvedSqft = Math.round(maskFootprint * slope);
                    resolvedKind = "eave";
                    console.log("[telemetry] mask_replaced_sam3", {
                      address: addr.formatted,
                      sam3Footprint,
                      maskFootprint,
                      maskVertexCount: poly.length,
                      reason: suspectReason,
                    });
                  }
                }
              }
            } catch {
              /* mask soft-fails — keep SAM3 */
            }
          }
        }

        // Tier 2 — Solar mask. LAZY fallback: only fires when SAM3 didn't
        // return a usable polygon. Saves the $0.075 dataLayers cost on the
        // common path where SAM3 wins.
        if (!resolvedPolygon) {
          try {
            const maskRes = await fetch(
              `/api/solar-mask?lat=${addr.lat}&lng=${addr.lng}`,
            );
            if (maskRes.ok) {
              const mask = await maskRes.json();
              const poly: Array<{ lat: number; lng: number }> | null =
                Array.isArray(mask?.latLng) && mask.latLng.length >= 3 ? mask.latLng : null;
              if (poly) {
                const footprintSqft = polygonAreaSqftLocal(poly);
                if (footprintSqft > 20_000 && oversizedFootprintSqft == null) {
                  oversizedFootprintSqft = footprintSqft;
                }
                if (footprintSqft >= 200 && footprintSqft <= 20_000) {
                  resolvedPolygon = poly;
                  // Solar mask traces eaves photogrammetrically — apply pitch
                  // slope (no overhang multiplier needed; mask already includes it)
                  resolvedSqft = Math.round(footprintSqft * slope);
                  resolvedKind = "eave";
                }
              }
            }
          } catch {
            /* opportunistic */
          }
        }

        // Tier 3 — Microsoft Buildings footprint (last resort before manual)
        if (!resolvedPolygon) {
          try {
            const msRes = await fetch(
              `/api/microsoft-building?lat=${addr.lat}&lng=${addr.lng}`,
            );
            if (msRes.ok) {
              const ms = await msRes.json();
              const poly: Array<{ lat: number; lng: number }> | null =
                Array.isArray(ms?.polygon) && ms.polygon.length >= 3 ? ms.polygon : null;
              if (poly) {
                const footprintSqft = polygonAreaSqftLocal(poly);
                if (footprintSqft > 20_000 && oversizedFootprintSqft == null) {
                  oversizedFootprintSqft = footprintSqft;
                }
                if (footprintSqft >= 200 && footprintSqft <= 20_000) {
                  resolvedPolygon = poly;
                  // MS Buildings is ground-projected wall footprint — apply
                  // 1.06 eave overhang factor before pitch.
                  resolvedSqft = Math.round(footprintSqft * 1.06 * slope);
                  resolvedKind = "wall";
                }
              }
            }
          } catch {
            /* opportunistic */
          }
        }

        // Solar segments-sum sqft (preferred if Solar gave us a real number
        // and we don't yet have a polygon-derived measurement).
        if (!resolvedSqft && solarSegmentSqft) {
          resolvedSqft = solarSegmentSqft;
        }
        // Last-ditch: footprint × pitch from Solar findClosest, no polygon.
        if (!resolvedSqft && solarFootprintSqft) {
          resolvedSqft = Math.round(solarFootprintSqft * slope);
        }

        if (resolvedSqft) setSqft(resolvedSqft);
        if (resolvedPitch) setPitch(resolvedPitch);
        if (resolvedPolygon) setRoofPolygon(resolvedPolygon);
        if (resolvedKind) setPolygonKind(resolvedKind);
        // Surface oversized footprints when every tier rejected because
        // the polygon was too big. If we managed to resolve a polygon
        // within band (resolvedPolygon != null), the customer's roof
        // wasn't the oversized one — don't flag it.
        if (oversizedFootprintSqft != null && resolvedPolygon == null) {
          setCommercialFootprintSqft(oversizedFootprintSqft);
        }

        const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";
        if (key) {
          // Static Maps URL with optional polygon overlay. Brand-cyan
          // translucent fill (0x67dcff at ~26% alpha) + 2px solid stroke
          // — high-contrast against suburban roofs and bright greenery,
          // readable on dark and light tiles.
          const params = new URLSearchParams({
            center: `${addr.lat},${addr.lng}`,
            zoom: "20",
            size: "720x420",
            maptype: "satellite",
            markers: `color:0x67dcff|${addr.lat},${addr.lng}`,
            key,
          });
          let url = `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
          if (resolvedPolygon && resolvedPolygon.length >= 3) {
            // Static Maps caps URL at ~16K chars. Decimating to ≤40
            // vertices keeps the path well under that even at full
            // precision and matches the visual fidelity Static Maps can
            // render at zoom 20.
            const stride = Math.max(1, Math.ceil(resolvedPolygon.length / 40));
            const sampled = resolvedPolygon.filter((_, i) => i % stride === 0);
            const pathPts = sampled
              .map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`)
              .join("|");
            url +=
              "&path=" +
              encodeURIComponent(
                `fillcolor:0x67dcff44|color:0x67dcffff|weight:3|${pathPts}|${sampled[0].lat.toFixed(6)},${sampled[0].lng.toFixed(6)}`,
              );
          }
          setSatelliteUrl(url);
        }
      } finally {
        setLoadingRoof(false);
      }
    }

    setSubmitting(false);
    setStep("Roof");
  };

  const goNext = () => {
    const i = STEPS.indexOf(step);
    if (i < STEPS.length - 1) setStep(STEPS[i + 1]);
  };
  const goBack = () => {
    const i = STEPS.indexOf(step);
    if (i > 0) setStep(STEPS[i - 1]);
  };

  /** Final submit on the Quote step — re-posts lead with the chosen
   *  material + add-ons + estimate range. This is the "confirmed" lead
   *  the contractor's outreach team prioritizes. */
  const submitFinal = async () => {
    if (!lead) return;
    setSubmitError("");
    setSubmitting(true);
    try {
      // Build the customer-side estimate snapshot. Prefer the Tier C v2
      // shape (EstimateV2: roofData + pricingInputs + priced) when the
      // pipeline returned usable data — that's the canonical form the
      // dashboard's summarizeProposalSnapshot + /p/[id] viewer both
      // already understand. Falls back to the legacy v1 Estimate
      // shape when the pipeline is unavailable so degraded sessions
      // still get a proposal row written.
      const sharedAddress = (address ?? { formatted: lead.address }) as AddressInfo;
      const stableId = estimateIdRef.current;
      const customerEstimate: EstimateV2 | Estimate =
        priced && roofData && roofData.source !== "none"
          ? ({
              version: 2,
              id: stableId,
              createdAt: new Date().toISOString(),
              staff: "Customer · self-served",
              customerName: lead.name,
              address: sharedAddress,
              roofData,
              pricingInputs,
              priced,
              isInsuranceClaim: false,
            } satisfies EstimateV2)
          : ({
              id: stableId,
              createdAt: new Date().toISOString(),
              staff: "Customer · self-served",
              customerName: lead.name,
              address: sharedAddress,
              assumptions: {
                sqft: sqft ?? 0,
                pitch: (pitch ?? "6/12") as Pitch,
                material,
                ageYears: 15,
                laborMultiplier: 1,
                materialMultiplier: 1,
                serviceType: "reroof-tearoff",
                complexity: "moderate",
              } satisfies Assumptions,
              addOns: addOns.map((a) => ({
                id: a.id,
                label: a.label,
                price: a.price,
                enabled: a.enabled,
              })) satisfies AddOn[],
              total: Math.round((range.low + range.high) / 2),
              baseLow: range.low,
              baseHigh: range.high,
            } satisfies Estimate);

      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: lead.name,
          email: lead.email,
          phone: lead.phone,
          address: address?.formatted ?? lead.address,
          zip: address?.zip,
          lat: address?.lat,
          lng: address?.lng,
          estimatedSqft:
            priced && roofData && roofData.source !== "none"
              ? roofData.totals.totalRoofAreaSqft
              : sqft,
          material: effectiveMaterial,
          selectedAddOns: addOns.filter((a) => a.enabled).map((a) => a.id),
          estimateLow:
            priced && roofData && roofData.source !== "none"
              ? Math.round(priced.totalLow)
              : range.low,
          estimateHigh:
            priced && roofData && roofData.source !== "none"
              ? Math.round(priced.totalHigh)
              : range.high,
          // Tenancy — carries through to lead row, Sydney outbound dispatch.
          office,
          source: "quote-wizard-confirmed",
          existingLeadPublicId: existingLeadPublicIdRef.current ?? undefined,
          // Full Estimate snapshot — server writes a proposals row
          // pinned to this lead so the dashboard surfaces it.
          estimate: customerEstimate,
          // TCPA consent carried forward from step-1 form. The
          // server re-validates on this final post too.
          tcpaConsent: lead.tcpaConsent,
          tcpaConsentAt: lead.tcpaConsentAt,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "submit_failed");
      // Mirror the snapshot to localStorage so the customer can revisit
      // the share link offline / on the same device. v2 saves go
      // through saveEstimateV2 (canonical); v1 fallback handled below.
      if (
        typeof customerEstimate === "object" &&
        (customerEstimate as EstimateV2).version === 2
      ) {
        saveEstimateV2(customerEstimate as EstimateV2);
      }
      setSubmitted({ leadId: data.leadId, proposalId: estimateIdRef.current });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  };

  // Step 1 — full-bleed bolt hero followed by the public-facing
  // funnel sections (How It Works, Reviews, FAQ). Each section has an
  // anchor id matched by the top-nav so clicks scroll directly to the
  // relevant content. Logo lives inside the bolt canvas — no seam
  // between header strip and hero background.
  if (step === "Lead" && !submitted) {
    return (
      <div className="relative z-[1] lg-env">
        {/* Vercel BotID — transparent challenge before the lead form
            submits. Bots that try to POST /api/leads via curl/script
            get rejected server-side; humans see nothing. */}
        <BotIdClient protect={[{ path: "/api/leads", method: "POST" }]} />
        <BoltStyleHero
          title="What will it cost"
          titleAccent="to replace your roof"
          subtitle="We measure your roof from satellite imagery and price it in thirty seconds. Proprietary model, real number, no calls until you ask."
          onSubmit={onLeadSubmit}
          submitting={submitting}
          nav={
            <NavHeader
              items={[
                { label: "How It Works", href: "#how" },
                // Only show the Reviews tab when verified reviews are live —
                // matches the gate in components/quote/BelowFold.tsx so the
                // tab and the section appear/disappear together.
                ...(process.env.NEXT_PUBLIC_REVIEWS_VERIFIED === "true"
                  ? [{ label: "Reviews", href: "#reviews" }]
                  : []),
                { label: "FAQ", href: "#faq" },
              ]}
            />
          }
        />

        <div className="lg-env">
          <StatsStrip />
          <HowItWorks />
          <Testimonials />
          <FAQ />
          <TrustStrip />
          <PublicFooter />
        </div>
      </div>
    );
  }

  // Steps 2–4 — wizard with stepper, floating over the visionOS Liquid Glass
  // background environment (layered radial washes behind the glass panels).
  return (
    <div className="min-h-[100dvh] flex flex-col relative z-[1] lg-env">
      <PublicHeader
        chip="Quick Quote"
        nav={[
          { label: "Quote", href: "/quote" },
          { label: "How It Works", href: "/quote#how" },
          { label: "FAQ", href: "/quote#faq" },
        ]}
      />
      <main id="main-content" className="flex-1 max-w-3xl mx-auto w-full px-4 sm:px-6 py-10 sm:py-16 space-y-8">
        {!submitted && <Stepper current={stepIdx} />}

        {step === "Roof" && !submitted && commercialFootprintSqft != null && (
          <CommercialBranch
            footprintSqft={commercialFootprintSqft}
            address={address?.formatted}
          />
        )}

        {step === "Roof" && !submitted && commercialFootprintSqft == null && (
          <RoofStep
            address={address}
            sqft={sqft}
            // True when the displayed sqft came from the mesh's per-
            // facet measurements (`roofData.totals.totalRoofAreaSqft`)
            // and the customer hasn't manually overridden it. Drives
            // the "Measured from N facets" label vs. "Edit if it
            // looks off" — without this signal the UI can't honestly
            // say where the number came from.
            sqftFromMesh={
              !sqftTouchedRef.current &&
              roofData != null &&
              roofData.source !== "none" &&
              roofData.facets.length > 0 &&
              roofData.totals.totalRoofAreaSqft > 0
            }
            pitch={pitch}
            satelliteUrl={satelliteUrl}
            roofPolygon={roofPolygon}
            roofData={roofData}
            roofCompare={roofCompare}
            loading={loadingRoof || pipelineLoading}
            pickingLoading={pickingLoading}
            // Click-pick re-trace. Fired when the customer taps a
            // different building in the satellite tile (via the "Wrong
            // roof?" button). Forwards the tapped lat/lng to
            // /api/sam3-roof which re-runs SAM3 centred on the click
            // and returns a fresh polygon. We update `roofPolygon` +
            // `sqft` exactly as we do on the initial auto-detect, so
            // downstream pricing reflects the new building immediately.
            onClickPick={async (clickLat, clickLng) => {
              if (address?.lat == null || address?.lng == null) return;
              setPickingLoading(true);
              try {
                const url =
                  `/api/sam3-roof?lat=${address.lat}&lng=${address.lng}` +
                  `&clickLat=${clickLat}&clickLng=${clickLng}` +
                  `&address=${encodeURIComponent(address.formatted ?? "")}`;
                const res = await fetch(url);
                if (!res.ok) return;
                const data = (await res.json()) as {
                  polygon?: Array<{ lat: number; lng: number }>;
                  footprintSqft?: number;
                  source?: string;
                };
                if (!data.polygon || data.polygon.length < 3) return;
                // Same slope/overhang math the initial auto-detect path
                // uses (lines ~343-355 above) — kept verbatim so the
                // sqft a customer sees after click-pick matches what
                // they'd have seen if SAM3 had landed there the first
                // time. polygonKind tracks whether the new polygon
                // traces eaves or walls so subsequent vertex edits
                // re-apply the right overhang multiplier.
                const PITCH_MAP: Record<string, number> = {
                  "4/12": 18.43,
                  "5/12": 22.62,
                  "6/12": 26.57,
                  "7/12": 30.26,
                  "8/12+": 35.0,
                };
                const pitchDeg = pitch
                  ? (PITCH_MAP[pitch] ?? 26.57)
                  : 26.57;
                const slope = 1 / Math.cos((pitchDeg * Math.PI) / 180);
                const footprintSqft =
                  typeof data.footprintSqft === "number" && data.footprintSqft > 0
                    ? data.footprintSqft
                    : polygonAreaSqftLocal(data.polygon);
                const newSqft = Math.round(footprintSqft * slope);
                if (newSqft >= 200 && newSqft <= 30_000) {
                  setRoofPolygon(data.polygon);
                  setSqft(newSqft);
                  setPolygonKind(
                    data.source === "footprint-only" ||
                      data.source === "footprint-occluded"
                      ? "wall"
                      : "eave",
                  );
                }
              } catch {
                // Network or parse error — leave the existing polygon
                // in place. The customer's still got "Draw outline
                // myself" as a fallback.
              } finally {
                setPickingLoading(false);
              }
            }}
            onChangeSqft={(n) => {
              sqftTouchedRef.current = true;
              setSqft(n);
            }}
            onPolygonEdited={(poly) => {
              setRoofPolygon(poly);

              // Phase 2 sqft-source fix — the polygon's flat shoelace
              // area × global pitch is LESS ACCURATE than the per-facet
              // mesh measurements in `roofData.totals.totalRoofAreaSqft`
              // (which sums sloped sqft across N facets, each at its own
              // measured pitch). Previously every polygon vertex nudge
              // overrode the mesh sqft with this approximation; the user
              // pointed out the bug.
              //
              // New behavior: when a usable mesh exists, the mesh sqft
              // remains authoritative. Polygon edits update the visual
              // outline (useful for the "is this the right building?"
              // confirmation) but DON'T touch sqft. The original "wrong
              // building" use case is still handled — the user hits
              // "Wrong roof?" which re-runs the pipeline against the
              // picked location, refreshing the mesh entirely.
              const hasUsableMesh =
                roofData &&
                roofData.source !== "none" &&
                roofData.facets.length > 0 &&
                roofData.totals.totalRoofAreaSqft > 0;
              if (hasUsableMesh) {
                // Don't set sqftTouchedRef — the user nudged the polygon,
                // not the sqft input. If the pipeline later returns a
                // refined mesh, the seed effect can update sqft normally.
                return;
              }

              // No mesh available — fall back to polygon-derived sqft
              // as the only signal we have. Mark it user-touched so the
              // seed effect doesn't overwrite if a mesh arrives later
              // for a substantially different building.
              sqftTouchedRef.current = true;
              const PITCH_MAP: Record<string, number> = {
                "4/12": 18.43,
                "5/12": 22.62,
                "6/12": 26.57,
                "7/12": 30.26,
                "8/12+": 35.0,
              };
              const pitchDeg = pitch ? (PITCH_MAP[pitch] ?? 26.57) : 26.57;
              const slope = 1 / Math.cos((pitchDeg * Math.PI) / 180);
              const overhang = polygonKind === "wall" ? 1.06 : 1;
              const footprint = polygonAreaSqftLocal(poly);
              const newSqft = Math.round(footprint * overhang * slope);
              if (newSqft >= 200 && newSqft <= 30_000) setSqft(newSqft);
            }}
            onBack={goBack}
            onNext={goNext}
          />
        )}

        {step === "Material" && !submitted && (
          <MaterialStep
            material={material}
            onMaterialChange={(m) => {
              setMaterial(m);
              // A material pick on this step is an explicit customer
              // choice — record it so the Tier C pricing chain uses it
              // ahead of vision detection.
              setCustomerMaterial(m);
            }}
            addOns={addOns}
            onAddOnsChange={setAddOns}
            onBack={goBack}
            onNext={goNext}
          />
        )}

        {step === "Quote" && !submitted && (
          <QuoteStep
            range={range}
            lead={lead}
            sqft={sqft}
            material={material}
            addOns={addOns}
            roofData={roofData}
            priced={priced}
            pipelineLoading={pipelineLoading}
            pipelineError={pipelineError}
            onBack={goBack}
            onSubmit={submitFinal}
            submitting={submitting}
            error={submitError}
          />
        )}

        {submitted && (
          <ThankYou
            leadId={submitted.leadId}
            proposalId={submitted.proposalId}
            range={range}
            onReset={() => {
              // Clear every wizard slot so "another property" lands the
              // customer on a fresh Lead step. Without this, the Link
              // navigated to /quote but the page didn't unmount (same
              // route), so submitted stayed set and ThankYou kept rendering.
              setSubmitted(null);
              setStep("Lead");
              setLead(null);
              existingLeadPublicIdRef.current = null;
              setAddress(null);
              setSqft(null);
              setPitch(null);
              setSatelliteUrl(null);
              setRoofPolygon(null);
              setMaterial("asphalt-architectural");
              setCustomerMaterial(null);
              setAddOns(QUOTE_ADDONS);
              setSubmitError("");
              // Reset Tier C pipeline state so the next address starts
              // clean; bump the gen so any in-flight fetch is ignored.
              fetchGenRef.current++;
              setRoofData(null);
              setPipelineError(null);
              setPipelineLoading(false);
              sqftTouchedRef.current = false;
              estimateIdRef.current = `est_${crypto.randomUUID().replace(/-/g, "")}`;
            }}
          />
        )}
      </main>
      <PublicFooter />
    </div>
  );
}

/* ─── Commercial Branch ───────────────────────────────────────────────── */

/**
 * Rendered in place of RoofStep when the measured footprint indicates
 * a commercial-scale property. Two design goals:
 *   1. Be honest — we measured a big roof, instant quoting isn't
 *      designed for it, here's what happens next.
 *   2. Capture the lead — they came in, they expect a follow-up;
 *      route them to a human rather than dumping them.
 */
function CommercialBranch({
  footprintSqft,
  address,
}: {
  footprintSqft: number;
  address?: string;
}) {
  return (
    <div className="lg-panel-strong rounded-3xl p-8 sm:p-10 space-y-6 max-w-2xl mx-auto text-center">
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber/10 border border-amber/30 text-amber text-[11px] font-mono uppercase tracking-[0.14em]">
        Commercial-scale property
      </div>
      <h2 className="font-display text-[28px] sm:text-[36px] leading-tight tracking-tight font-semibold text-slate-50">
        Your roof is bigger than our instant quote handles.
      </h2>
      <p className="text-[15px] sm:text-[16px] text-slate-300 leading-relaxed max-w-prose mx-auto">
        We measured your property at approximately{" "}
        <span className="font-mono tabular text-slate-50">
          {Math.round(footprintSqft).toLocaleString()} sqft
        </span>{" "}
        of roof footprint
        {address ? (
          <>
            {" "}at <span className="text-slate-50">{address}</span>
          </>
        ) : null}
        . Properties above ~15,000 sqft typically have multiple roof
        sections, mixed materials, and code requirements that need an
        on-site assessment to price accurately — instant quotes set
        wrong expectations on that scale.
      </p>
      <p className="text-[14px] text-slate-400 leading-relaxed max-w-prose mx-auto">
        We&apos;ve captured your information. A Voxaris specialist will
        be in touch within one business day to scope your project
        directly. No instant number — but a real one, faster than the
        usual commercial bid cycle.
      </p>
      <div className="pt-2 text-[11px] font-mono uppercase tracking-[0.14em] text-slate-500">
        Estimate is non-binding · We don&apos;t sell your information
      </div>
    </div>
  );
}

/* ─── Header / Footer ─────────────────────────────────────────────────── */

// PublicHeader + PublicFooter were inlined here previously. Both have
// been promoted to @/components/ui/public-header.tsx + /public-footer.tsx
// so /storms, /p/[id], /embed/install, and the (legal) layout share
// the same brand chrome. Per-page usage (this file) passes
// chip="Quick Quote" + a nav array; other pages pass their own.

/* ─── Stepper ─────────────────────────────────────────────────────────── */

function Stepper({ current }: { current: number }) {
  const currentLabel = STEPS[current] ?? "";
  return (
    <>
      {/* Mobile (<sm): single "Step X of 4 — Current label" line.
          Previously the four number pills rendered with their labels
          hidden via sm:inline, leaving "1 2 3 4" as noise without any
          text orientation. A single labeled progress line carries the
          same information with less visual weight. */}
      <div
        className="sm:hidden flex items-center justify-between text-[11.5px] font-mono uppercase tracking-[0.14em] text-white/65"
        aria-label={`Step ${current + 1} of ${STEPS.length}: ${currentLabel}`}
        role="status"
        aria-live="polite"
      >
        <span className="text-white/45">
          Step <span className="text-white/95 tabular">{current + 1}</span> of {STEPS.length}
        </span>
        <span className="text-cy-300">{currentLabel}</span>
      </div>

      {/* Desktop (≥sm): full 4-pill stepper with connecting rails. */}
      <div className="hidden sm:flex items-center gap-3">
        {STEPS.map((label, i) => {
          const active = i === current;
          const done = i < current;
          return (
            <div key={label} className="flex items-center gap-3 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <div
                  className={`glass-pill tabular flex-shrink-0 ${
                    active ? "glass-pill-active" : done ? "glass-pill-done" : ""
                  }`}
                >
                  {done ? <Check size={12} strokeWidth={3} /> : i + 1}
                </div>
                <span
                  className={`text-[11.5px] font-mono uppercase tracking-[0.14em] ${
                    active
                      ? "text-white/95"
                      : done
                        ? "text-white/65"
                        : "text-white/40"
                  }`}
                >
                  {label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={`flex-1 h-px ${
                    i < current
                      ? "bg-gradient-to-r from-mint/0 via-mint/50 to-mint/0"
                      : "bg-white/[0.06]"
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ─── Step 2 — Roof confirm ───────────────────────────────────────────── */

function RoofStep({
  address,
  sqft,
  sqftFromMesh,
  pitch,
  satelliteUrl,
  roofPolygon,
  roofData,
  roofCompare,
  loading,
  pickingLoading,
  onChangeSqft,
  onPolygonEdited,
  onClickPick,
  onBack,
  onNext,
}: {
  address: AddressInfo | null;
  sqft: number | null;
  /** True iff the displayed sqft came from the per-facet mesh
   *  measurement (not user-overridden, not polygon-derived). Drives
   *  the "Measured from N facets" label so the customer knows the
   *  number reflects real geometry rather than a flat-polygon × global-
   *  pitch approximation. */
  sqftFromMesh: boolean;
  pitch: string | null;
  satelliteUrl: string | null;
  roofPolygon: Array<{ lat: number; lng: number }> | null;
  /** Tier C/B/A canonical RoofData. When source === "tier-a-lidar", the
   *  Tier A.2 RoofViewer mounts instead of the legacy Roof3DViewer. */
  roofData: RoofData | null;
  /** Cross-compare payload — when present, the 3D viewer renders the
   *  blueprint and shows a Solar/LiDAR toggle button so the customer
   *  can switch between the two measurements. */
  roofCompare: {
    lidar: RoofData | null;
    solar: RoofData | null;
    agreement: {
      bothPresent: boolean;
      sqftDeltaPct: number | null;
      pitchDeltaDegrees: number | null;
      facetCountDelta: number | null;
    } | null;
  } | null;
  loading: boolean;
  pickingLoading: boolean;
  onChangeSqft: (n: number) => void;
  onPolygonEdited: (poly: Array<{ lat: number; lng: number }>) => void;
  onClickPick: (clickLat: number, clickLng: number) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-6 float-in">
      <header>
        <div className="glass-eyebrow">Step 2 · Confirm your roof</div>
        <h2 className="font-display text-[32px] sm:text-[44px] leading-[1.05] tracking-[-0.025em] font-semibold mt-4 text-white/95 text-balance">
          This is your roof
        </h2>
        <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.025] px-3 py-1.5 text-[12.5px] text-white/65">
          <MapPin size={13} className="text-cy-300 flex-shrink-0" />
          <span className="truncate">{address?.formatted ?? "—"}</span>
        </div>
      </header>

      <div className="glass-panel overflow-hidden aspect-video relative">
        {loading ? (
          <div
            role="status"
            aria-live="polite"
            className="w-full h-full flex items-center justify-center text-white/55 text-[13px]"
          >
            <Loader2 size={16} className="animate-spin mr-2" aria-hidden /> Measuring your roof…
          </div>
        ) : address?.lat != null && address?.lng != null ? (
          <>
            <EditableRoofMap
              lat={address.lat}
              lng={address.lng}
              initialPolygon={roofPolygon}
              onPolygonChanged={onPolygonEdited}
              onClickPick={onClickPick}
              pickingLoading={pickingLoading}
              // Per-facet overlay is OFF for now. The original idea was to
              // render Solar's per-facet polygons as faint structural lines
              // under the editable polygon — but Solar's findClosest
              // returns bbox-rotated rectangles, and on a 17-facet hip
              // roof those overlap into visual chaos. Until we have
              // pixel-accurate facet outlines from Tier A LiDAR, the
              // single editable mask polygon is the cleanest UX.
              facetOverlay={null}
            />
            {/* Click-pick re-trace overlay. Fires when the customer
                hits "Wrong roof?" and taps a new building — the
                /api/sam3-roof re-run takes 5-30s and the customer
                otherwise sees the old (wrong) polygon hang on-screen
                while Roboflow works. Same "Re-tracing your roof…"
                language as the EditableRoofMap inline pill, just
                full-area for unambiguous state. Stays positioned
                absolute over the map (not full-screen) so the
                customer can still see the satellite imagery
                underneath — they tapped somewhere and the spinner
                confirms we're acting on it. */}
            {pickingLoading && (
              <div
                role="status"
                aria-live="polite"
                className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 text-white/85 text-[13px] font-medium"
                style={{ background: "rgba(7,9,13,0.78)" }}
              >
                <Loader2 size={22} className="animate-spin text-cy-300" aria-hidden />
                Re-tracing your roof…
              </div>
            )}
          </>
        ) : satelliteUrl ? (
          <img
            src={satelliteUrl}
            alt={`Satellite view of ${address?.formatted}`}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-white/45 text-[12.5px] gap-1 px-6 text-center">
            <span>Couldn&apos;t locate that address.</span>
            <span className="text-white/35">
              Go back and pick a suggestion from the dropdown to load satellite imagery.
            </span>
          </div>
        )}
      </div>

      {/* Photorealistic 3D flyover — visual centerpiece of the customer's
       *  roof. Loads only after the address is resolved + initial measurement
       *  is done, so the satellite map renders first and the heavy Cesium
       *  bundle isn't blocking. No verification — pure visual.
       *  Shorter aspect ratio than the 2D map (16:9 → 21:9) so it reads as
       *  a complementary flyover rather than a second hero — kept the
       *  combined first-screen weight from feeling top-heavy. */}
      {!loading && address?.lat != null && address?.lng != null && (
        <div
          className="glass-panel overflow-hidden aspect-[21/9] relative"
          aria-label={`3D photorealistic view of the roof at ${address?.formatted ?? "this property"}`}
          role="img"
        >
          {roofData && roofData.source !== "none" && roofData.facets.length > 0 ? (
            // Standalone blueprint renderer. Works for BOTH LiDAR (Tier A)
            // and Solar (Tier C) measurements — they produce the same
            // RoofData shape (facets, edges, objects). When cross-compare
            // is active, a Solar/LiDAR toggle appears top-right so the
            // customer can flip between the two measurements; agreement
            // chip top-left shows whether they agree on sqft/pitch.
            // No photorealistic mesh underneath = no overlay-mismatch
            // problem, no Map Tiles cost.
            <RoofRenderer
              key={`renderer-${address.lat.toFixed(6)},${address.lng.toFixed(6)}`}
              data={roofData}
              lidar={roofCompare?.lidar ?? null}
              solar={roofCompare?.solar ?? null}
              agreement={roofCompare?.agreement ?? null}
              className="absolute inset-0"
            />
          ) : (
            <Roof3DViewer
              // Hard-remount on every address change so the previous Cesium
              // camera + tiles can't linger.
              key={`${address.lat.toFixed(6)},${address.lng.toFixed(6)}`}
              lat={address.lat}
              lng={address.lng}
              address={address.formatted}
              polygons={roofPolygon ? [roofPolygon] : undefined}
              polygonSource={roofPolygon ? "sam3" : undefined}
              // Lock user input on the customer-facing flow: auto-orbit still
              // plays (the wow factor) but pan/zoom/rotate are disabled, so
              // the customer can't drive up Map Tiles cost by exploring the
              // neighborhood. Caps per-session cost at ~$0.05–0.10 instead
              // of $0.30+ on heavily-explored sessions.
              interactive={false}
            />
          )}
        </div>
      )}

      {/* Provenance + cross-source verification — shown as soon as the
          pipeline has settled, not at the very end of the wizard. This
          is the customer's "we measured this with real data" moment;
          burying it on Step 4 means they spent Step 2/3 trusting a
          polygon they had no provenance signal on. Auto-hides on
          source === "none". */}
      {!loading && roofData && roofData.source !== "none" && (
        <MeasurementVerification data={roofData} variant="customer" />
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="glass-panel p-5">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/55">
            Estimated roof size
          </div>
          <div className="flex items-baseline gap-1.5 mt-2">
            <input
              type="number"
              value={sqft ?? ""}
              onChange={(e) => onChangeSqft(Number(e.target.value) || 0)}
              placeholder="Enter sq ft"
              // Auto-size to content via field-sizing (Chrome 124+, Safari
              // 17.4+) with size="5" as the fallback width hint. Avoids the
              // huge "4946________sq ft" gap from the prior fixed w-32.
              size={5}
              style={{ fieldSizing: "content" } as React.CSSProperties}
              className="bg-transparent border-0 outline-none font-display tabular text-[32px] font-semibold tracking-[-0.02em] text-white/95 placeholder:text-white/25 placeholder:text-[18px]"
            />
            <span className="font-mono text-[12px] text-white/55">sq ft</span>
          </div>
          <div className="text-[11.5px] text-white/45 mt-1">
            {sqft
              ? sqftFromMesh && roofData
                ? `Measured from ${roofData.totals.facetsCount} roof facets — per-facet pitch + slope`
                : "Edit if it looks off"
              : "Couldn’t auto-measure — enter approximate size"}
          </div>
          {/* Sets the customer's expectation that the roof number is bigger
              than their Zillow heated-sqft. */}
          {sqft ? (
            <div className="text-[11.5px] text-white/55 mt-4 leading-relaxed pt-3 border-t border-white/[0.06]">
              Includes the roof over your garage and any covered patios. Often larger
              than your home’s interior square footage because it covers the full
              footprint, not just heated living space.
            </div>
          ) : null}
        </div>
        <PerFacetPitchPanel roofData={roofData} fallbackPitch={pitch} />
      </div>

      <NavButtons onBack={onBack} onNext={onNext} disabled={!sqft} />
    </div>
  );
}

/** Per-facet pitch panel. Replaces the old single-pitch display with a
 *  breakdown that reflects the truth: pricing already uses per-facet
 *  pitch (priceRoofData loops over data.facets and applies pitch-
 *  specific labor multipliers), so the customer should see that the
 *  measurement is per-facet, not a flat average.
 *
 *  Layout:
 *    - Lead line: range "Y/12 – Z/12" (or single value when all facets agree)
 *    - Below: per-facet list (top 4 by area; "+N more" when more exist)
 *    - Trust line: "Pricing applies pitch per facet — steep slopes
 *      surface as a labor adder in your estimate."
 */
function PerFacetPitchPanel({
  roofData,
  fallbackPitch,
}: {
  roofData: RoofData | null;
  fallbackPitch: string | null;
}) {
  // No measurement yet — keep the original "assumed" fallback so the
  // wizard still shows something while the pipeline is in flight.
  if (!roofData || roofData.source === "none" || roofData.facets.length === 0) {
    return (
      <div className="glass-panel p-5">
        <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/55">
          Roof pitch
        </div>
        <div className="font-display tabular text-[32px] font-semibold tracking-[-0.02em] mt-2 text-white/95">
          {fallbackPitch ?? "6/12"}
          {!fallbackPitch && (
            <span className="ml-2 text-[12px] font-mono uppercase tracking-[0.12em] text-amber align-middle">
              assumed
            </span>
          )}
        </div>
        <div className="text-[11.5px] text-white/45 mt-1">
          {fallbackPitch
            ? "Auto-detected from satellite imagery"
            : "We couldn’t measure pitch from the imagery — using a 6/12 assumption. Final pitch confirmed on-site."}
        </div>
      </div>
    );
  }

  const facets = roofData.facets.filter((f) => (f.areaSqftSloped ?? 0) > 0);
  const pitchRise = (deg: number) =>
    Math.max(0, Math.round(12 * Math.tan((deg * Math.PI) / 180)));
  // Per-facet pitch in /12 — group by rise so 4.1° and 4.4° both read 1/12.
  const pitches = facets.map((f) => pitchRise(f.pitchDegrees));
  const minRise = Math.min(...pitches);
  const maxRise = Math.max(...pitches);

  // Top-area facets for the breakdown list.
  const top = [...facets]
    .sort((a, b) => b.areaSqftSloped - a.areaSqftSloped)
    .slice(0, 4);
  const remaining = facets.length - top.length;

  return (
    <div className="glass-panel p-5">
      <div className="flex items-baseline justify-between">
        <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/55">
          Roof pitch
        </div>
        <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-cy-300/70">
          {facets.length} facets · per facet
        </div>
      </div>
      <div className="font-display tabular text-[32px] font-semibold tracking-[-0.02em] mt-2 text-white/95">
        {minRise === maxRise ? `${minRise}/12` : `${minRise}–${maxRise}/12`}
      </div>
      <div className="text-[11.5px] text-white/45 mt-1">
        Measured per facet across the roof — steepest and shallowest shown above.
      </div>

      {/* Per-facet rows — top 4 by area. Customer-friendly, no IDs. */}
      <div className="mt-4 pt-3 border-t border-white/[0.06] space-y-1.5">
        {top.map((f, i) => {
          const rise = pitchRise(f.pitchDegrees);
          return (
            <div
              key={f.id}
              className="flex items-center justify-between text-[11.5px]"
            >
              <span className="text-white/55 font-mono tabular">
                Facet {i + 1}
              </span>
              <span className="text-white/85 tabular">
                {rise}/12{" "}
                <span className="text-white/40">
                  · {Math.round(f.areaSqftSloped).toLocaleString()} sqft
                </span>
              </span>
            </div>
          );
        })}
        {remaining > 0 && (
          <div className="text-[11px] text-white/40 pt-1">
            + {remaining} more facet{remaining === 1 ? "" : "s"}
          </div>
        )}
      </div>

      <div className="mt-3 text-[11px] text-white/45 leading-relaxed">
        Pricing applies pitch <span className="text-white/70">per facet</span> —
        steep slopes surface as a labor adder in your estimate.
      </div>
    </div>
  );
}

/* ─── Step 3 — Material + add-ons ─────────────────────────────────────── */

function MaterialStep({
  material,
  onMaterialChange,
  addOns,
  onAddOnsChange,
  onBack,
  onNext,
}: {
  material: Material;
  onMaterialChange: (m: Material) => void;
  addOns: SimpleAddon[];
  onAddOnsChange: (a: SimpleAddon[]) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-6 float-in">
      <div>
        <div className="glass-eyebrow">Step 3 · Pick your roof</div>
        <h2 className="font-display text-[32px] sm:text-[44px] leading-[1.05] tracking-[-0.025em] font-semibold mt-4 text-white/95">
          What kind of roof do you want?
        </h2>
        <p className="text-white/55 text-[14px] mt-3 max-w-xl">
          Most homeowners go with architectural shingles. You can change this later — this is
          just for the estimate.
        </p>
      </div>

      {/* Demo configuration: only Architectural Shingle is offered on the
          customer-side estimator. The other materials remain in
          MATERIAL_RATES / MATERIAL_COPY (used by the rep-facing internal
          estimator) so swapping back to the multi-option grid is a
          one-line change. The page state defaults to
          "asphalt-architectural", so the single card below renders pre-
          selected — Next is always enabled. */}
      <div className="grid grid-cols-1 gap-4 max-w-xl">
        {(["asphalt-architectural"] as Material[]).map((m) => {
          const active = material === m;
          const copy = MATERIAL_COPY[m];
          return (
            <button
              key={m}
              onClick={() => onMaterialChange(m)}
              className={`glass-panel is-interactive text-left p-5 ${
                active ? "glass-panel-selected" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="font-display font-semibold tracking-[-0.015em] text-[16px] text-white/95">
                  {copy.title}
                </div>
                {active && (
                  <div
                    className="w-5 h-5 rounded-full flex items-center justify-center text-[#051019]"
                    style={{
                      background:
                        "linear-gradient(180deg, rgba(224,242,254,0.98) 0%, rgba(125,211,252,0.94) 100%)",
                      boxShadow:
                        "inset 0 1px 0 rgba(255,255,255,0.7), 0 4px 12px -3px rgba(125,211,252,0.55)",
                    }}
                  >
                    <Check size={12} strokeWidth={3} />
                  </div>
                )}
              </div>
              <div className="text-[13px] text-white/70 mt-1.5">{copy.tagline}</div>
              <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-white/50 mt-4">
                {copy.warranty}
              </div>
            </button>
          );
        })}
      </div>

      {/* Optional upgrades — re-introduced for Tier C so the customer
          can toggle the four QUOTE_ADDONS into priceRoofData. Each
          toggle re-runs the priced memo upstream and is reflected in
          the Quote step's headline + simplifiedItems. */}
      <div className="space-y-3 max-w-xl">
        <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/55">
          Optional upgrades
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {addOns.map((a) => {
            const active = a.enabled;
            return (
              <button
                key={a.id}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  onAddOnsChange(
                    addOns.map((x) =>
                      x.id === a.id ? { ...x, enabled: !x.enabled } : x,
                    ),
                  )
                }
                className={`glass-panel is-interactive text-left p-3 flex items-center gap-3 ${
                  active ? "glass-panel-selected" : ""
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-md flex items-center justify-center flex-shrink-0 ${
                    active
                      ? "bg-cy-300 text-[#051019]"
                      : "border border-white/20"
                  }`}
                >
                  {active && <Check size={10} strokeWidth={3} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-white/90">{a.label}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <NavButtons onBack={onBack} onNext={onNext} />
    </div>
  );
}

/* ─── Step 4 — Quote display + final confirm ─────────────────────────── */

function QuoteStep({
  range,
  lead,
  sqft,
  material,
  addOns,
  roofData,
  priced,
  pipelineLoading,
  pipelineError,
  onBack,
  onSubmit,
  submitting,
  error,
}: {
  range: { low: number; high: number };
  lead: QuoteHeroFormValues | null;
  sqft: number | null;
  material: Material;
  addOns: SimpleAddon[];
  roofData: RoofData | null;
  priced: PricedEstimate | null;
  pipelineLoading: boolean;
  pipelineError: string | null;
  onBack: () => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string;
}) {
  // Pricing source-of-truth — when the Tier C pipeline returned usable
  // data, the headline + line-item totals come from priceRoofData.
  // Falls back to the legacy MATERIAL_RATES range when the pipeline
  // hasn't landed (still loading) or returned source === "none" (every
  // tier failed). Keeps the wizard navigable in degraded scenarios.
  const hasPricedV2 = !!(priced && roofData && roofData.source !== "none");
  const headlineLow = hasPricedV2 ? priced.totalLow : range.low;
  const headlineHigh = hasPricedV2 ? priced.totalHigh : range.high;

  // Legacy breakdown (used only as fallback when v2 pricing isn't ready).
  const m = MATERIAL_RATES[material];
  const legacyBreakdown = sqft
    ? [
        {
          label: `${MATERIAL_COPY[material].title} (${sqft.toLocaleString()} sf)`,
          low: Math.round(sqft * m.low),
          high: Math.round(sqft * m.high),
        },
        ...(m.removeLow > 0
          ? [
              {
                label: "Tear-off + haul-away",
                low: Math.round(sqft * m.removeLow),
                high: Math.round(sqft * m.removeHigh),
              },
            ]
          : []),
        ...addOns
          .filter((a) => a.enabled)
          .map((a) => ({ label: a.label, low: a.price, high: a.price })),
      ]
    : [];
  const enabledAddonCount = addOns.filter((a) => a.enabled).length;
  return (
    <div className="space-y-7 float-in">
      <div>
        <div className="glass-eyebrow">Step 4 · Your estimate</div>
        <h2 className="font-display text-[32px] sm:text-[44px] leading-[1.05] tracking-[-0.025em] font-semibold mt-4 text-white/95">
          Your estimated price range
        </h2>
      </div>

      <div className="glass-panel-hero p-7 sm:p-10 relative overflow-hidden">
        <div
          className="absolute -top-24 -right-10 w-[520px] h-[340px] blur-3xl pointer-events-none opacity-70"
          style={{
            background:
              "radial-gradient(closest-side, rgba(125,211,252,0.22), transparent)",
          }}
        />
        <div
          className="absolute -bottom-24 -left-10 w-[480px] h-[320px] blur-3xl pointer-events-none opacity-60"
          style={{
            background:
              "radial-gradient(closest-side, rgba(167,139,250,0.18), transparent)",
          }}
        />
        <div className="relative">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/55">
            Estimated total
          </div>
          <div className="font-display tabular text-[48px] sm:text-[72px] leading-[0.95] font-semibold tracking-[-0.04em] mt-2 iridescent-text">
            {fmt(headlineLow)} <span className="text-white/35 not-italic">–</span> {fmt(headlineHigh)}
          </div>
          <div className="text-[12.5px] text-white/55 mt-3 max-w-md">
            Materials + labor + tear-off included. Final pricing requires an on-site inspection.
          </div>
        </div>
      </div>

      {/* Tier C — RoofData panels. Customer-variant of DetectedFeaturesPanel
          shows counts only (no per-facet attribution). The "none" case
          surfaces a clear message so the customer isn't left wondering
          why no roof analysis loaded. While the pipeline is still in
          flight we show nothing here — the legacy range above keeps
          the wizard usable. */}
      {hasPricedV2 && roofData && (
        <>
          <MeasurementVerification data={roofData} variant="customer" />
          <RoofTotalsCard data={roofData} />
          <DetectedFeaturesPanel data={roofData} variant="customer" />
        </>
      )}
      {roofData?.source === "none" && !pipelineLoading && (
        <div
          className="rounded-xl border border-amber/30 bg-amber/[0.06] px-4 py-3 text-[13px] text-amber"
          role="status"
        >
          We couldn&apos;t analyze this address — please double-check the pin or
          try a different address.
        </div>
      )}
      {pipelineError && !pipelineLoading && (
        <div className="text-[11.5px] text-white/45 font-mono tracking-wide">
          Analysis warning: {pipelineError}
        </div>
      )}

      {/* What's in the estimate — Tier C grouped simplifiedItems when
          the pipeline returned usable data, otherwise legacy per-line
          breakdown. simplifiedItems collapse per-facet detail into
          friendly category groups (Tear-off, Shingles, Flashing, etc.)
          which is the customer-appropriate view. */}
      {hasPricedV2 && priced.simplifiedItems.length > 0 && (
        <div className="glass-panel p-6 space-y-3">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/55">
            What&apos;s in the estimate
          </div>
          <ul className="divide-y divide-white/[0.06]">
            {priced.simplifiedItems.map((row, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-3 py-3 text-[13px]"
              >
                <span className="text-white/85">{row.group}</span>
                <span className="font-mono tabular text-white/75 text-[12.5px]">
                  {row.totalLow === row.totalHigh
                    ? fmt(row.totalLow)
                    : `${fmt(row.totalLow)} – ${fmt(row.totalHigh)}`}
                </span>
              </li>
            ))}
          </ul>
          {enabledAddonCount > 0 && (
            <div className="text-[11.5px] text-white/45 pt-1">
              {`${enabledAddonCount} upgrade${enabledAddonCount === 1 ? "" : "s"} selected.`}
            </div>
          )}
        </div>
      )}
      {!hasPricedV2 && legacyBreakdown.length > 0 && (
        <div className="glass-panel p-6 space-y-3">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/55">
            What&apos;s in the estimate
          </div>
          <ul className="divide-y divide-white/[0.06]">
            {legacyBreakdown.map((row, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-3 py-3 text-[13px]"
              >
                <span className="text-white/85">{row.label}</span>
                <span className="font-mono tabular text-white/75 text-[12.5px]">
                  {row.low === row.high
                    ? fmt(row.low)
                    : `${fmt(row.low)} – ${fmt(row.high)}`}
                </span>
              </li>
            ))}
          </ul>
          {enabledAddonCount > 0 && (
            <div className="text-[11.5px] text-white/45 pt-1">
              {`${enabledAddonCount} upgrade${enabledAddonCount === 1 ? "" : "s"} selected.`}
            </div>
          )}
        </div>
      )}

      {lead && (
        <div className="glass-panel p-6 space-y-3">
          <div className="font-display font-semibold tracking-[-0.015em] text-[16px] text-white/95">
            We have your details
          </div>
          <div className="text-[12.5px] text-white/65 leading-relaxed">
            We&apos;ll reach out to <span className="text-white/95">{lead.name}</span> at{" "}
            <span className="text-white/95">{lead.email}</span> within 1 business hour. No
            unsolicited follow-up beyond that.
          </div>
        </div>
      )}

      {error && (
        <div
          className="text-[12.5px] px-4 py-3 rounded-2xl"
          style={{
            color: "#ffb3bd",
            background: "rgba(255,122,138,0.10)",
            border: "1px solid rgba(255,122,138,0.25)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
          }}
        >
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-2">
        <button onClick={onBack} className="glass-button-secondary">
          <ArrowLeft size={14} /> Back
        </button>
        <button
          onClick={onSubmit}
          disabled={submitting}
          className="glass-button-primary"
        >
          {submitting ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Sending…
            </>
          ) : (
            <>
              Confirm &amp; request detailed quote <ArrowRight size={14} />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/* ─── Thank-you ───────────────────────────────────────────────────────── */

function ThankYou({
  leadId,
  proposalId,
  range,
  onReset,
}: {
  leadId: string;
  /** The persisted proposal's public_id (matches estimateIdRef.current
   *  and the row stored at /p/{proposalId}). This — not leadId — is the
   *  id the share link reads from, so we surface it as the reference. */
  proposalId: string;
  range: { low: number; high: number };
  onReset: () => void;
}) {
  // Suppress unused warning — leadId still arrives in case future copy
  // wants to surface it separately, but the customer-facing reference is
  // proposalId (the share-link key).
  void leadId;
  return (
    <div className="space-y-8 float-in">
      <div className="text-center">
        <div
          className="w-16 h-16 mx-auto rounded-2xl flex items-center justify-center text-mint"
          style={{
            background:
              "linear-gradient(180deg, rgba(95,227,176,0.18) 0%, rgba(95,227,176,0.06) 100%)",
            border: "1px solid rgba(95,227,176,0.35)",
            boxShadow:
              "inset 0 1px 0 rgba(255,255,255,0.15), 0 12px 32px -10px rgba(95,227,176,0.35)",
            backdropFilter: "blur(28px) saturate(1.5)",
            WebkitBackdropFilter: "blur(28px) saturate(1.5)",
          }}
        >
          <Check size={28} strokeWidth={2.5} />
        </div>
        <h2 className="font-display text-[36px] sm:text-[52px] leading-[1.05] tracking-[-0.03em] font-semibold mt-6 text-white/95">
          You&apos;re all set.
        </h2>
        <p className="text-white/65 text-[14.5px] mt-4 max-w-xl mx-auto">
          A {BRAND_CONFIG.companyName} partner roofer will reach out shortly. Proposal reference:
        </p>
        <div className="font-mono text-[13px] mt-2 select-all iridescent-text">{proposalId}</div>
        {/* Inbound number — Noland's brand DID. Customers who'd rather
            call IN than wait for the outbound see this immediately on
            the confirmation screen. Click-to-call works on mobile; on
            desktop it copies cleanly. Wrap in a glass-pill so it reads
            as an offered affordance, not buried metadata. */}
        <a
          href="tel:+13219851104"
          className="inline-flex items-center gap-2.5 mt-6 px-4 py-2.5 rounded-full text-[13px] font-medium text-cy-200 bg-cy-300/[0.08] border border-cy-300/30 hover:bg-cy-300/[0.14] hover:border-cy-300/50 hover:text-white transition-colors"
          aria-label="Call Voxaris Pitch at 1-321-985-1104"
        >
          <Phone size={13} className="text-cy-300" />
          <span className="font-mono tabular tracking-wide">+1 (321) 985-1104</span>
          <span className="text-white/45 text-[12px]">or we&apos;ll call you</span>
        </a>
      </div>

      <div className="glass-panel p-6 max-w-md mx-auto text-center">
        <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/55">
          Your estimate range
        </div>
        <div className="font-display tabular text-[32px] sm:text-[36px] font-semibold tracking-[-0.025em] mt-2 iridescent-text">
          {fmt(range.low)} <span className="text-white/35">–</span> {fmt(range.high)}
        </div>
        <div className="text-[11.5px] text-white/45 mt-3">
          Final pricing requires an on-site inspection.
        </div>
      </div>

      {/* What happens next — concrete timeline. */}
      <div className="glass-panel p-7 max-w-2xl mx-auto">
        <div className="flex justify-center">
          <div className="glass-eyebrow">What happens next</div>
        </div>
        <ol className="mt-5 space-y-4">
          <NextStep
            n={1}
            title="Within 1 business hour"
            body="Your assigned roofer emails a refined quote with material specs, pitch confirmation, and licensing/insurance details. No phone calls unless you check the box for a callback."
            time="≤ 1 hr"
          />
          <NextStep
            n={2}
            title="Within 1–3 business days"
            body="If you'd like an on-site walkthrough, your roofer schedules a 20-minute inspection (drone or ladder) at no charge. Storm-damage cases are typically same-day."
            time="1–3 days"
          />
          <NextStep
            n={3}
            title="Whenever you're ready"
            body="Pick a start date, sign the contract digitally, and (if needed) apply for 0% APR financing through the contractor. No commitment required at any prior step."
            time="up to you"
            last
          />
        </ol>
      </div>

      <div className="text-center">
        <button
          onClick={onReset}
          className="text-[12px] font-mono uppercase tracking-[0.14em] text-white/55 hover:text-white/95 transition-colors"
        >
          Get a quote for another property →
        </button>
      </div>
    </div>
  );
}

function NextStep({
  n,
  title,
  body,
  time,
  last,
}: {
  n: number;
  title: string;
  body: string;
  time: string;
  last?: boolean;
}) {
  return (
    <li className="relative flex gap-4">
      <div className="flex flex-col items-center">
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-mono font-semibold flex-shrink-0"
          style={{
            color: "#bae6fd",
            background: "rgba(125,211,252,0.10)",
            border: "1px solid rgba(186,230,253,0.30)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
          }}
        >
          {n}
        </div>
        {!last && <div className="flex-1 w-px bg-white/[0.08] mt-1" />}
      </div>
      <div className="flex-1 pb-4">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-[14px] font-medium text-white/95">{title}</div>
          <div className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-white/45 flex-shrink-0">
            {time}
          </div>
        </div>
        <p className="text-[13px] text-white/65 mt-1.5 leading-relaxed">{body}</p>
      </div>
    </li>
  );
}

/* ─── NavButtons ──────────────────────────────────────────────────────── */

function NavButtons({
  onBack,
  onNext,
  disabled,
}: {
  onBack: () => void;
  onNext: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 pt-3">
      <button onClick={onBack} className="glass-button-secondary">
        <ArrowLeft size={14} /> Back
      </button>
      <button
        onClick={onNext}
        disabled={disabled}
        className="glass-button-primary"
      >
        Next <ArrowRight size={14} />
      </button>
    </div>
  );
}

