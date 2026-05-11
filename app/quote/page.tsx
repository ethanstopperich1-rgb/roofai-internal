"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { BotIdClient } from "botid/client";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  MapPin,
} from "lucide-react";
import Link from "next/link";
import { BoltStyleHero, type QuoteHeroFormValues } from "@/components/ui/bolt-style-chat";
import NavHeader from "@/components/ui/nav-header";
import {
  StatsStrip,
  HowItWorks,
  Testimonials,
  FAQ,
  TrustStrip,
} from "@/components/quote/BelowFold";
import EditableRoofMap from "@/components/quote/EditableRoofMap";
import { fmt, MATERIAL_RATES } from "@/lib/pricing";
import type { AddressInfo, Material } from "@/types/estimate";
import { BRAND_CONFIG } from "@/lib/branding";

// 3D viewer is heavy (Cesium + 3D Tiles) — lazy-load it so the initial
// /quote bundle stays small. SSR off because Cesium is browser-only.
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
    title: "Asphalt 3-Tab",
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

export default function QuotePage() {
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
  const [material, setMaterial] = useState<Material>("asphalt-architectural");
  const [addOns, setAddOns] = useState<SimpleAddon[]>(QUOTE_ADDONS);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ leadId: string } | null>(null);
  const [submitError, setSubmitError] = useState("");

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
    let resolvedLat = values.lat;
    let resolvedLng = values.lng;
    let resolvedZip = values.zip;
    let resolvedFormatted = values.address;
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
              };
              if (typeof details.lat === "number" && typeof details.lng === "number") {
                resolvedLat = details.lat;
                resolvedLng = details.lng;
                resolvedZip = details.zip ?? resolvedZip;
                resolvedFormatted = details.formatted ?? resolvedFormatted;
              }
            }
          }
        }
      } catch {
        /* silent — addr will lack coords; fallback UI handles it */
      }
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
        source: "quote-wizard-step-1",
        // TCPA consent — captured at hero form. Server REQUIRES this
        // to be true before firing automated SMS / webhook / CRM
        // outreach. The hero form prevents submit until checked.
        tcpaConsent: values.tcpaConsent,
        tcpaConsentAt: values.tcpaConsentAt,
      }),
    }).catch(() => {
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
      setLoadingRoof(true);
      try {
        let resolvedSqft: number | null = null;
        let resolvedPitch: string | null = null;
        let resolvedPolygon: Array<{ lat: number; lng: number }> | null = null;

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
              `&address=${encodeURIComponent(addr.formatted ?? "")}`,
          ).catch(() => null),
        ]);

        // Pitch + footprint baseline from Solar findClosest.
        let pitchDegrees: number | null = null;
        let solarFootprintSqft: number | null = null;
        let solarSegmentSqft: number | null = null;
        if (solarRes.ok) {
          const data = await solarRes.json();
          pitchDegrees = data.pitchDegrees ?? null;
          solarFootprintSqft = data.buildingFootprintSqft ?? null;
          solarSegmentSqft = data.sqft ?? null;
          resolvedPitch = data.pitch ?? null;
        }
        const slope =
          pitchDegrees && pitchDegrees > 0
            ? 1 / Math.cos((pitchDegrees * Math.PI) / 180)
            : 1.118; // default 6/12

        // Tier 1 — Custom SAM3 (with GIS reconciliation built-in server-side)
        let resolvedKind: "eave" | "wall" | null = null;
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
                // Reconciler returned "footprint-only" / "footprint-occluded"
                // → the polygon traces the GIS wall footprint (1.06 already
                // baked into footprintSqft). Other SAM3 sources trace eaves.
                resolvedKind =
                  sam3?.source === "footprint-only" ||
                  sam3?.source === "footprint-occluded"
                    ? "wall"
                    : "eave";
              }
            }
          } catch {
            /* fall through to Solar mask */
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
          estimatedSqft: sqft,
          material,
          selectedAddOns: addOns.filter((a) => a.enabled).map((a) => a.id),
          estimateLow: range.low,
          estimateHigh: range.high,
          source: "quote-wizard-confirmed",
          // TCPA consent carried forward from step-1 form. The
          // server re-validates on this final post too.
          tcpaConsent: lead.tcpaConsent,
          tcpaConsentAt: lead.tcpaConsentAt,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "submit_failed");
      setSubmitted({ leadId: data.leadId });
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
          title="What will it cost to"
          subtitle="Voxaris's in-house AI measures your roof from satellite imagery and prices it in thirty seconds. Proprietary model, real number, no calls until you ask."
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
    <div className="min-h-screen flex flex-col relative z-[1] lg-env">
      <PublicHeader />
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 sm:px-6 py-10 sm:py-16 space-y-8">
        {!submitted && <Stepper current={stepIdx} />}

        {step === "Roof" && !submitted && (
          <RoofStep
            address={address}
            sqft={sqft}
            pitch={pitch}
            satelliteUrl={satelliteUrl}
            roofPolygon={roofPolygon}
            loading={loadingRoof}
            onChangeSqft={setSqft}
            onPolygonEdited={(poly) => {
              setRoofPolygon(poly);
              // Recompute sqft from the edited polygon: footprint via
              // shoelace × slope multiplier from Solar pitch (or 1.118
              // default for 6/12 when pitch unknown). When the resolved
              // polygon traces walls (MS Buildings, SAM3 reconciler
              // substitution), re-apply the 1.06 eave-overhang factor —
              // otherwise the displayed sqft drops ~6% on the first edit
              // even when the rep nudged a single vertex.
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
            onMaterialChange={setMaterial}
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
            onBack={goBack}
            onSubmit={submitFinal}
            submitting={submitting}
            error={submitError}
          />
        )}

        {submitted && (
          <ThankYou
            leadId={submitted.leadId}
            range={range}
            onReset={() => {
              // Clear every wizard slot so "another property" lands the
              // customer on a fresh Lead step. Without this, the Link
              // navigated to /quote but the page didn't unmount (same
              // route), so submitted stayed set and ThankYou kept rendering.
              setSubmitted(null);
              setStep("Lead");
              setLead(null);
              setAddress(null);
              setSqft(null);
              setPitch(null);
              setSatelliteUrl(null);
              setRoofPolygon(null);
              setMaterial("asphalt-architectural");
              setAddOns(QUOTE_ADDONS);
              setSubmitError("");
            }}
          />
        )}
      </main>
      <PublicFooter />
    </div>
  );
}

/* ─── Header / Footer ─────────────────────────────────────────────────── */

function PublicHeader() {
  return (
    <header
      className="relative z-30"
      style={{
        background:
          "linear-gradient(180deg, rgba(8,11,17,0.55) 0%, rgba(8,11,17,0.25) 100%)",
        backdropFilter: "blur(40px) saturate(1.5)",
        WebkitBackdropFilter: "blur(40px) saturate(1.5)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "inset 0 -1px 0 rgba(255,255,255,0.04)",
      }}
    >
      {/* 3-column grid (1fr | auto | 1fr) instead of flex justify-between, so
          the nav pill in the middle column is truly centered on the page —
          flex justify-between centers it between the left and right
          siblings, which have different widths and pulled the nav
          off-center. */}
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-10 h-16 sm:h-20 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <Link href="/quote" className="flex items-center gap-2 min-w-0 justify-self-start">
          <img
            src="/brand/logo-wordmark-alpha.png"
            alt="Voxaris Pitch"
            width={1672}
            height={941}
            className="h-9 sm:h-14 w-auto max-w-[180px] sm:max-w-none object-contain"
          />
          <span className="hidden md:inline-block ml-1 chip text-[10px]">Quick Quote</span>
        </Link>

        <NavHeader
          items={[
            { label: "Quote", href: "/quote" },
            { label: "How It Works", href: "/quote#how" },
            { label: "FAQ", href: "/quote#faq" },
          ]}
        />

        <div className="hidden sm:flex items-center gap-3 text-[12px] text-white/75 justify-self-end">
          <Check size={13} className="text-mint" />
          <span>Free · No-obligation</span>
        </div>
      </div>
    </header>
  );
}

function PublicFooter() {
  return (
    <footer className="border-t border-white/[0.08] mt-12">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 flex items-center justify-between text-[11px] text-white/45 font-mono">
        <span>© {new Date().getFullYear()} Voxaris</span>
        <div className="flex items-center gap-4">
          <span>Estimates are non-binding</span>
          <span className="hidden sm:inline">·</span>
          <span>{BRAND_CONFIG.tagline}</span>
        </div>
      </div>
    </footer>
  );
}

/* ─── Stepper ─────────────────────────────────────────────────────────── */

function Stepper({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-2 sm:gap-3">
      {STEPS.map((label, i) => {
        const active = i === current;
        const done = i < current;
        return (
          <div key={label} className="flex items-center gap-2 sm:gap-3 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <div
                className={`glass-pill tabular flex-shrink-0 ${
                  active ? "glass-pill-active" : done ? "glass-pill-done" : ""
                }`}
              >
                {done ? <Check size={12} strokeWidth={3} /> : i + 1}
              </div>
              <span
                className={`hidden sm:inline text-[11.5px] font-mono uppercase tracking-[0.14em] ${
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
  );
}

/* ─── Step 2 — Roof confirm ───────────────────────────────────────────── */

function RoofStep({
  address,
  sqft,
  pitch,
  satelliteUrl,
  roofPolygon,
  loading,
  onChangeSqft,
  onPolygonEdited,
  onBack,
  onNext,
}: {
  address: AddressInfo | null;
  sqft: number | null;
  pitch: string | null;
  satelliteUrl: string | null;
  roofPolygon: Array<{ lat: number; lng: number }> | null;
  loading: boolean;
  onChangeSqft: (n: number) => void;
  onPolygonEdited: (poly: Array<{ lat: number; lng: number }>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-6 float-in">
      <div>
        <div className="glass-eyebrow">Step 2 · Confirm your roof</div>
        <h2 className="font-display text-[32px] sm:text-[44px] leading-[1.05] tracking-[-0.025em] font-semibold mt-4 text-white/95">
          This is your roof
        </h2>
        <p className="text-white/55 text-[14px] mt-3 flex items-center gap-2">
          <MapPin size={14} className="text-white/40" />
          {address?.formatted ?? "—"}
        </p>
      </div>

      <div className="glass-panel overflow-hidden aspect-video relative">
        {loading ? (
          <div className="w-full h-full flex items-center justify-center text-white/55 text-[13px]">
            <Loader2 size={16} className="animate-spin mr-2" /> Measuring your roof…
          </div>
        ) : address?.lat != null && address?.lng != null ? (
          <EditableRoofMap
            lat={address.lat}
            lng={address.lng}
            initialPolygon={roofPolygon}
            onPolygonChanged={onPolygonEdited}
          />
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
       *  bundle isn't blocking. No verification — pure visual. */}
      {!loading && address?.lat != null && address?.lng != null && (
        <div className="glass-panel overflow-hidden aspect-video relative">
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
        </div>
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
            {sqft ? "Edit if it looks off" : "Couldn’t auto-measure — enter approximate size"}
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
        <div className="glass-panel p-5">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/55">
            Roof pitch
          </div>
          <div className="font-display tabular text-[32px] font-semibold tracking-[-0.02em] mt-2 text-white/95">
            {pitch ?? "Standard"}
          </div>
          <div className="text-[11.5px] text-white/45 mt-1">
            {pitch ? "Auto-detected from satellite" : "Estimated — confirmed at on-site quote"}
          </div>
        </div>
      </div>

      <NavButtons onBack={onBack} onNext={onNext} disabled={!sqft} />
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

      <div className="grid sm:grid-cols-2 gap-4">
        {(Object.keys(MATERIAL_RATES) as Material[]).map((m) => {
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

      {/* "Optional upgrades" section removed per design — the upgrade
          add-on list felt like noise on the customer-side estimator and
          inflated the estimate cognitive load without commensurate
          conversion lift. The rep-facing internal estimator still has
          full add-on controls; the public /quote flow now shows base
          tear-off + material price only. */}

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
  onBack: () => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string;
}) {
  // Build a transparent line-item breakdown so the rep — and the homeowner —
  // can see why the price is what it is. Itemized estimates dramatically
  // reduce "is this number real?" objections vs a single bottom-line range.
  const m = MATERIAL_RATES[material];
  const breakdown = sqft
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
            {fmt(range.low)} <span className="text-white/35 not-italic">–</span> {fmt(range.high)}
          </div>
          <div className="text-[12.5px] text-white/55 mt-3 max-w-md">
            Materials + labor + tear-off included. Final pricing requires an on-site inspection.
          </div>
        </div>
      </div>

      {breakdown.length > 0 && (
        <div className="glass-panel p-6 space-y-3">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/55">
            What&apos;s in the estimate
          </div>
          <ul className="divide-y divide-white/[0.06]">
            {breakdown.map((row, i) => (
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
          {/* Empty-upgrades helper text removed alongside the Optional
              Upgrades section. When upgrades ARE selected (via the rep
              tool / future re-enable), the count line still surfaces. */}
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
  range,
  onReset,
}: {
  leadId: string;
  range: { low: number; high: number };
  onReset: () => void;
}) {
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
          A {BRAND_CONFIG.companyName} partner roofer will reach out shortly. Reference:
        </p>
        <div className="font-mono text-[13px] mt-2 select-all iridescent-text">{leadId}</div>
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

// Suppress unused-import warning for useEffect (kept for future use)
void useEffect;
