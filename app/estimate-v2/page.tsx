"use client";

/**
 * /estimate-v2 — V3 "holy-grail" pin-confirmed Gemini-painted flow.
 *
 * Customer journey:
 *   1. Enter address (Google Places autocomplete).
 *   2. Address resolves → satellite map shows a red draggable pin.
 *   3. Customer drags pin onto the EXACT center of their roof.
 *   4. Click "Confirm Building Center".
 *   5. ~22s loading state while /api/gemini-roof?pinConfirmed=1 runs:
 *        - Solar API (free, ~1s) → headline sqft + pitch
 *        - Gemini 3 Pro Image multimodal → cyan-painted PNG
 *        - Gemini 2.5 Flash (text) → rooftop-object JSON
 *      All three fan out in parallel; total wall-clock ≈ max(three).
 *   6. Painted image displayed full-width with measurement chips + a
 *      rooftop-object chip strip. "Re-pin" to redo / "New address"
 *      to start over.
 *
 * Standalone route — does NOT touch the legacy /estimate page.
 */

import { useEffect, useRef, useState } from "react";
import { loadGoogle } from "@/lib/google";

type Step = "address" | "pin-drag" | "loading" | "result" | "error";

interface AddressResolved {
  formatted: string;
  lat: number;
  lng: number;
}

interface V3Response {
  solar: {
    sqft: number | null;
    footprintSqft: number | null;
    pitchDegrees: number | null;
    segmentCount: number;
    imageryQuality: string | null;
    imageryDate: string | null;
  };
  correction: {
    applied: boolean;
    reason: string;
    solarRawSlopedSqft: number;
    solarRawFootprintSqft: number;
    gisSource: string | null;
    gisFootprintSqft: number | null;
    slopeFactor: number | null;
  } | null;
  tile: {
    centerLat: number;
    centerLng: number;
    zoom: number;
    widthPx: number;
    heightPx: number;
  };
  paintedImageBase64: string | null;
  objects: Array<{
    type: string;
    centerPx: { x: number; y: number };
    bboxPx: { x: number; y: number; width: number; height: number };
    confidence: number;
  }>;
  penetrationTotals: {
    count: number;
    perimeterFt: number;
    areaSqft: number;
  };
  edges: {
    ridgesHipsLf: number | null;
    valleysLf: number | null;
    rakesLf: number | null;
    eavesLf: number | null;
  };
  geminiEdges: {
    ridgesHipsLf: number;
    valleysLf: number;
    rakesLf: number;
    eavesLf: number;
    linesCount: number;
  } | null;
  facets: Array<{
    pitchDegrees: number;
    pitchOnTwelve: string;
    azimuthDegrees: number;
    compassDirection: string;
    slopedSqft: number;
    footprintSqft: number;
  }>;
  derived: {
    stories: number;
    estimatedAtticSqft: number | null;
    predominantCompass: string | null;
    complexity: "simple" | "moderate" | "complex";
  };
  solarPotential: {
    maxPanels: number | null;
    annualSunshineHours: number | null;
  };
  geminiAnalysis: {
    facetCountEstimate: {
      count: number;
      complexity: "simple" | "moderate" | "complex";
      confidence: number;
    } | null;
    roofMaterial: { type: string; confidence: number } | null;
    conditionHints: Array<{ hint: string; confidence: number }>;
  };
  modelVersion: string;
  computedAt: string;
}

// Loading messages cycle so the 22-second wait feels alive rather
// than frozen. Indexed by elapsed-seconds buckets.
const LOADING_MESSAGES: Array<{ at: number; text: string }> = [
  { at: 0, text: "Fetching satellite tile…" },
  { at: 2, text: "Querying Google Solar API for measurements…" },
  { at: 5, text: "Gemini is identifying the roof boundary…" },
  { at: 12, text: "Painting cyan overlay onto your roof…" },
  { at: 20, text: "Finalizing rooftop object detection…" },
];

export default function EstimateV2Page() {
  const [step, setStep] = useState<Step>("address");
  const [addressText, setAddressText] = useState("");
  const [resolved, setResolved] = useState<AddressResolved | null>(null);
  const [pinLat, setPinLat] = useState<number | null>(null);
  const [pinLng, setPinLng] = useState<number | null>(null);
  const [result, setResult] = useState<V3Response | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loadingElapsedSec, setLoadingElapsedSec] = useState(0);

  // ─── Contact-capture state ─────────────────────────────────────────
  // After the V3 result renders, the customer fills in name/email/
  // phone + TCPA consent. On submit we POST to /api/leads with the
  // contact info AND the full V3 payload, which the server uploads
  // the painted PNG to Storage and persists the rest as
  // roof_v3_json on the lead row. Dashboard /leads picks it up.
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [tcpaConsent, setTcpaConsent] = useState(false);
  const [submitState, setSubmitState] = useState<
    "idle" | "submitting" | "done" | "error"
  >("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedLeadId, setSubmittedLeadId] = useState<string | null>(null);

  // ─── Address autocomplete (Google Places) ──────────────────────────
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (step !== "address" || !inputRef.current) return;
    let cancelled = false;
    let autocomplete: google.maps.places.Autocomplete | null = null;
    loadGoogle().then((g) => {
      if (cancelled || !inputRef.current) return;
      autocomplete = new g.maps.places.Autocomplete(inputRef.current, {
        types: ["address"],
        componentRestrictions: { country: "us" },
        fields: ["formatted_address", "geometry"],
      });
      autocomplete.addListener("place_changed", () => {
        const place = autocomplete!.getPlace();
        const loc = place.geometry?.location;
        if (!loc) return;
        const addr: AddressResolved = {
          formatted: place.formatted_address ?? inputRef.current!.value,
          lat: loc.lat(),
          lng: loc.lng(),
        };
        setResolved(addr);
        setPinLat(addr.lat);
        setPinLng(addr.lng);
        setStep("pin-drag");
      });
    });
    return () => {
      cancelled = true;
    };
  }, [step]);

  // ─── Pin-drag map (Google Maps draggable marker) ───────────────────
  const mapElRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  useEffect(() => {
    if (step !== "pin-drag" || !mapElRef.current || !resolved) return;
    let cancelled = false;
    loadGoogle().then((g) => {
      if (cancelled || !mapElRef.current) return;
      const center = { lat: resolved.lat, lng: resolved.lng };
      const map = new g.maps.Map(mapElRef.current, {
        center,
        zoom: 20,
        mapTypeId: g.maps.MapTypeId.SATELLITE,
        tilt: 0,
        disableDefaultUI: true,
        gestureHandling: "greedy",
        zoomControl: true,
        keyboardShortcuts: false,
        styles: [],
      });
      mapRef.current = map;
      const marker = new g.maps.Marker({
        position: center,
        map,
        draggable: true,
        cursor: "grab",
        title: "Drag to the center of the roof",
        animation: g.maps.Animation.DROP,
      });
      markerRef.current = marker;
      marker.addListener("dragend", () => {
        const pos = marker.getPosition();
        if (!pos) return;
        setPinLat(pos.lat());
        setPinLng(pos.lng());
      });
    });
    return () => {
      cancelled = true;
      markerRef.current?.setMap(null);
      markerRef.current = null;
    };
  }, [step, resolved]);

  // ─── Loading-state ticker ──────────────────────────────────────────
  useEffect(() => {
    if (step !== "loading") return;
    const t0 = Date.now();
    setLoadingElapsedSec(0);
    const id = window.setInterval(() => {
      setLoadingElapsedSec(Math.floor((Date.now() - t0) / 1000));
    }, 250);
    return () => window.clearInterval(id);
  }, [step]);

  // ─── Confirm pin → fire V3 endpoint ────────────────────────────────
  async function confirmPin(): Promise<void> {
    if (pinLat == null || pinLng == null) return;
    setStep("loading");
    setErrorMsg(null);
    setResult(null);
    try {
      const url =
        `/api/gemini-roof?lat=${pinLat}&lng=${pinLng}&pinConfirmed=1`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as V3Response;
      setResult(data);
      setStep("result");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep("error");
    }
  }

  function resetAll(): void {
    setStep("address");
    setAddressText("");
    setResolved(null);
    setPinLat(null);
    setPinLng(null);
    setResult(null);
    setErrorMsg(null);
    setContactName("");
    setContactEmail("");
    setContactPhone("");
    setTcpaConsent(false);
    setSubmitState("idle");
    setSubmitError(null);
    setSubmittedLeadId(null);
  }
  function rePin(): void {
    setResult(null);
    setStep("pin-drag");
    setSubmitState("idle");
    setSubmitError(null);
    setSubmittedLeadId(null);
  }

  // ─── Submit contact form → POST /api/leads ─────────────────────────
  async function submitContact(): Promise<void> {
    if (!result || !resolved) return;
    if (!contactName.trim() || !contactEmail.trim() || !tcpaConsent) return;
    setSubmitState("submitting");
    setSubmitError(null);
    try {
      // Strip the heaviest field for the JSON body but keep base64 so
      // the server can upload it to Storage. Server peels it off before
      // persisting to roof_v3_json.
      const roofV3 = {
        paintedImageBase64: result.paintedImageBase64,
        solar: result.solar,
        correction: result.correction,
        tile: result.tile,
        objects: result.objects,
        penetrationTotals: result.penetrationTotals,
        edges: result.edges,
        geminiEdges: result.geminiEdges,
        facets: result.facets,
        derived: result.derived,
        solarPotential: result.solarPotential,
        geminiAnalysis: result.geminiAnalysis,
        modelVersion: result.modelVersion,
        computedAt: result.computedAt,
      };

      const r = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: contactName.trim(),
          email: contactEmail.trim(),
          phone: contactPhone.trim() || undefined,
          address: resolved.formatted,
          lat: resolved.lat,
          lng: resolved.lng,
          estimatedSqft: result.solar.sqft ?? undefined,
          material:
            result.geminiAnalysis.roofMaterial?.type
              ?.replace(/_/g, " ")
              .replace(/\b\w/g, (c) => c.toUpperCase()) ?? undefined,
          source: "estimate-v2",
          tcpaConsent: true,
          roofV3,
        }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
      }
      const data = (await r.json()) as { leadId?: string };
      setSubmittedLeadId(data.leadId ?? null);
      setSubmitState("done");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
      setSubmitState("error");
    }
  }

  const loadingMessage =
    LOADING_MESSAGES.filter((m) => m.at <= loadingElapsedSec).pop()?.text ??
    LOADING_MESSAGES[0].text;

  // ─── Render ────────────────────────────────────────────────────────
  return (
    <div className="text-slate-100 font-sans">
      {/* HEADER */}
      <header className="mb-6 sm:mb-8">
        <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">
          Voxaris · Roof Analysis · V3
        </p>
        <h1 className="font-display text-3xl sm:text-4xl mt-1 leading-tight">
          Where are we{" "}
          <span className="text-[#38C5EE]">roofing</span> today?
        </h1>
        <p className="text-sm text-slate-400 mt-2 max-w-xl">
          Pin the exact center of any roof. We measure with Google Solar and
          paint the outline with Gemini 3 — a clean inspection-grade report
          in about 25 seconds.
        </p>
      </header>

      {/* STEPPER — hide on loading/error (transient states) */}
      {step !== "error" && (
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-[10px] uppercase tracking-[0.18em] mb-6">
          {(["address", "pin-drag", "result"] as const).map((s, i) => {
            const order = ["address", "pin-drag", "result"] as const;
            const currentIdx = step === "loading" ? 1.5 : order.indexOf(step as (typeof order)[number]);
            const active = Math.floor(currentIdx) === i || (step === "loading" && i === 1);
            const passed = currentIdx > i;
            return (
              <div key={s} className="flex items-center gap-2">
                <div
                  className={`w-1.5 h-1.5 rounded-full transition-colors ${
                    active
                      ? "bg-[#38C5EE] shadow-[0_0_8px_#38C5EE]"
                      : passed
                        ? "bg-slate-400"
                        : "bg-slate-700"
                  }`}
                />
                <span
                  className={
                    active
                      ? "text-[#38C5EE]"
                      : passed
                        ? "text-slate-400"
                        : "text-slate-600"
                  }
                >
                  {s === "address"
                    ? "1 · Address"
                    : s === "pin-drag"
                      ? "2 · Confirm pin"
                      : "3 · Result"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* STEP CONTENT */}
      {step === "address" && (
        <section className="bg-ink-900/80 border border-ink-700 rounded-2xl p-6 sm:p-8 animate-in fade-in duration-300">
          <label
            htmlFor="address-input"
            className="block text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-3"
          >
            Property address
          </label>
          <div className="relative">
            <input
              ref={inputRef}
              id="address-input"
              type="text"
              value={addressText}
              onChange={(e) => setAddressText(e.target.value)}
              placeholder="123 Main St, Jupiter, FL 33458"
              className="w-full bg-ink-800 border border-ink-600 rounded-xl px-4 py-3.5 text-base text-slate-100 placeholder-slate-500 outline-none focus:border-[#38C5EE] focus:bg-ink-800 transition-colors"
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <p className="text-xs text-slate-500 mt-3">
            We&apos;ll pull a satellite tile so you can drag a pin to the
            exact center of the roof in the next step.
          </p>
        </section>
      )}

      {step === "pin-drag" && resolved && (
        <section className="bg-ink-900/80 border border-ink-700 rounded-2xl overflow-hidden animate-in fade-in duration-300">
          <div className="px-4 sm:px-6 pt-4 pb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-ink-700/60">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-[0.18em] text-[#38C5EE]">
                Drag the pin onto the center of the roof
              </p>
              <p className="font-mono text-xs text-slate-300 mt-1 truncate">
                {resolved.formatted}
              </p>
            </div>
            <button
              onClick={resetAll}
              className="text-[10px] uppercase tracking-[0.18em] text-slate-500 hover:text-slate-200 transition-colors"
            >
              ← Change address
            </button>
          </div>
          <div
            ref={mapElRef}
            className="w-full h-[55vh] min-h-[400px] max-h-[640px]"
            style={{ background: "#0b0e14" }}
          />
          <div className="px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3 border-t border-ink-700/60">
            <p className="text-xs text-slate-500 font-mono">
              {pinLat?.toFixed(5)}, {pinLng?.toFixed(5)}
            </p>
            <button
              onClick={confirmPin}
              className="bg-[#38C5EE] text-ink-950 font-medium px-6 py-2.5 rounded-xl uppercase tracking-[0.12em] text-xs hover:bg-[#65d4f0] active:bg-[#1ba9d4] transition-colors shadow-[0_0_24px_rgba(56,197,238,0.25)]"
            >
              Confirm building center →
            </button>
          </div>
        </section>
      )}

      {step === "loading" && (
        <section className="bg-ink-900/80 border border-ink-700 rounded-2xl p-8 sm:p-14 text-center animate-in fade-in duration-300">
          <div className="relative inline-block">
            <div className="w-14 h-14 border-2 border-ink-700 border-t-[#38C5EE] rounded-full animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-[#38C5EE] shadow-[0_0_10px_#38C5EE]" />
            </div>
          </div>
          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 mt-6">
            Analyzing roof
          </p>
          <p className="font-display text-2xl text-slate-100 mt-2">
            {loadingMessage}
          </p>
          <p className="font-mono text-xs text-slate-500 mt-6">
            {loadingElapsedSec}s elapsed · typically 20–30s
          </p>
        </section>
      )}

      {step === "error" && (
        <section className="bg-ink-900/80 border border-rose-900/50 rounded-2xl p-6 sm:p-8 animate-in fade-in duration-300">
          <p className="text-[10px] uppercase tracking-[0.18em] text-rose-400 mb-2">
            Analysis failed
          </p>
          <p className="font-mono text-xs text-rose-300 break-all">
            {errorMsg}
          </p>
          <div className="mt-5 flex gap-3">
            <button
              onClick={rePin}
              className="bg-ink-700 text-slate-100 font-medium px-5 py-2 rounded-xl uppercase tracking-[0.12em] text-xs hover:bg-ink-600 transition-colors"
            >
              ← Re-pin
            </button>
            <button
              onClick={resetAll}
              className="text-[10px] uppercase tracking-[0.18em] text-slate-500 hover:text-slate-200 self-center transition-colors"
            >
              Start over
            </button>
          </div>
        </section>
      )}

      {step === "result" && result && (
        <section className="space-y-4 animate-in fade-in duration-500">
          {/* Painted image — the visual hero */}
          <div className="bg-ink-900/80 border border-ink-700 rounded-2xl overflow-hidden">
            <div className="px-4 sm:px-6 pt-4 pb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-ink-700/60">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">
                  Roof analysis · Painted by Gemini 3 Pro Image
                </p>
                <p className="font-mono text-xs text-slate-300 mt-1 truncate">
                  {resolved?.formatted}
                </p>
              </div>
              <div className="flex gap-3 text-[10px] uppercase tracking-[0.18em]">
                <button
                  onClick={rePin}
                  className="text-slate-400 hover:text-slate-200 transition-colors"
                >
                  ← Re-pin
                </button>
                <button
                  onClick={resetAll}
                  className="text-slate-400 hover:text-slate-200 transition-colors"
                >
                  New address
                </button>
              </div>
            </div>

            {result.paintedImageBase64 ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`data:image/png;base64,${result.paintedImageBase64}`}
                alt="Roof outline painted in cyan"
                className="w-full h-auto block"
              />
            ) : (
              <div className="bg-ink-800/70 p-8 sm:p-12 text-center">
                <p className="text-slate-300 text-sm">
                  Painted overlay unavailable — Solar measurements below are
                  still authoritative.
                </p>
                <p className="text-xs text-slate-500 mt-2">
                  Gemini call failed but Solar API succeeded. The headline
                  number is unaffected.
                </p>
              </div>
            )}
          </div>

          {/* Contact capture — send this analysis to the dashboard.
              On submit we POST to /api/leads with the full V3 payload;
              the server uploads the painted PNG to Storage and persists
              the rest as roof_v3_json. The dashboard /leads tab picks
              up the new lead with a V3 badge + the painted preview. */}
          {submitState !== "done" ? (
            <div className="bg-ink-900/80 border border-[#38C5EE]/40 rounded-2xl p-5 sm:p-6">
              <div className="flex items-baseline justify-between mb-4 gap-3">
                <p className="text-[10px] uppercase tracking-[0.18em] text-[#38C5EE]">
                  Send this analysis to your contractor
                </p>
                <p className="text-[9px] uppercase tracking-[0.18em] text-slate-500">
                  Free · No obligation
                </p>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed mb-4">
                Get this roof report sent to a licensed roofer in your area
                for a no-pressure quote. We&apos;ll save your measurements,
                material, and the painted overlay above.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitContact();
                }}
                className="space-y-3"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-[10px] uppercase tracking-[0.14em] text-slate-400">
                      Full name
                    </span>
                    <input
                      type="text"
                      required
                      autoComplete="name"
                      value={contactName}
                      onChange={(e) => setContactName(e.target.value)}
                      className="mt-1 w-full bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#38C5EE] focus:ring-1 focus:ring-[#38C5EE]/40"
                      placeholder="Jane Smith"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] uppercase tracking-[0.14em] text-slate-400">
                      Email
                    </span>
                    <input
                      type="email"
                      required
                      autoComplete="email"
                      value={contactEmail}
                      onChange={(e) => setContactEmail(e.target.value)}
                      className="mt-1 w-full bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#38C5EE] focus:ring-1 focus:ring-[#38C5EE]/40"
                      placeholder="jane@example.com"
                    />
                  </label>
                </div>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-[0.14em] text-slate-400">
                    Phone (optional, for fastest response)
                  </span>
                  <input
                    type="tel"
                    autoComplete="tel"
                    value={contactPhone}
                    onChange={(e) => setContactPhone(e.target.value)}
                    className="mt-1 w-full bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#38C5EE] focus:ring-1 focus:ring-[#38C5EE]/40"
                    placeholder="(555) 555-0123"
                  />
                </label>

                <label className="flex items-start gap-2 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    required
                    checked={tcpaConsent}
                    onChange={(e) => setTcpaConsent(e.target.checked)}
                    className="mt-0.5 accent-[#38C5EE]"
                  />
                  <span className="text-[11px] text-slate-400 leading-relaxed">
                    By checking this box and submitting, I consent to receive
                    automated marketing calls, texts, and emails from Voxaris
                    and its partner contractors at the phone number and email
                    above. Consent is not required to make a purchase.
                    Message frequency varies; message/data rates may apply.
                    Reply STOP to opt out. See our{" "}
                    <a href="/privacy" className="underline text-slate-300 hover:text-slate-100">
                      Privacy Policy
                    </a>{" "}
                    and{" "}
                    <a href="/terms" className="underline text-slate-300 hover:text-slate-100">
                      Terms
                    </a>
                    .
                  </span>
                </label>

                {submitError && (
                  <p className="text-xs text-rose-400 font-mono">
                    {submitError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={
                    submitState === "submitting" ||
                    !contactName.trim() ||
                    !contactEmail.trim() ||
                    !tcpaConsent
                  }
                  className="w-full sm:w-auto bg-[#38C5EE] text-ink-950 font-semibold text-sm px-5 py-2.5 rounded-lg hover:bg-[#38C5EE]/90 transition-colors disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed"
                >
                  {submitState === "submitting"
                    ? "Sending…"
                    : "Send this roof report"}
                </button>
              </form>
            </div>
          ) : (
            <div className="bg-emerald-500/5 border border-emerald-500/30 rounded-2xl p-5 sm:p-6">
              <div className="flex items-start gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgb(16,185,129)] mt-1.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-emerald-300 mb-1">
                    Sent to the dashboard
                  </p>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    A licensed roofer will be in touch shortly. Your lead ID
                    is{" "}
                    <span className="font-mono text-slate-100">
                      {submittedLeadId ?? "—"}
                    </span>
                    .
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* GIS correction badge — only shown when fix actually fired */}
          {result.correction?.applied && (
            <div className="bg-[#38C5EE]/5 border border-[#38C5EE]/30 rounded-2xl p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-[#38C5EE] shadow-[0_0_8px_#38C5EE] mt-1.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-[#38C5EE] mb-1">
                    Headline area corrected · {result.correction.gisSource?.toUpperCase()} footprint × Solar pitch
                  </p>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Solar&apos;s {result.solar.imageryQuality} imagery only saw{" "}
                    <span className="font-mono">
                      {result.correction.solarRawSlopedSqft.toLocaleString()}
                    </span>{" "}
                    sq ft. We cross-checked against the actual building
                    footprint from{" "}
                    <span className="text-slate-100">
                      {result.correction.gisSource === "microsoft-buildings"
                        ? "Microsoft Buildings"
                        : "OpenStreetMap"}
                    </span>{" "}
                    (
                    <span className="font-mono">
                      {result.correction.gisFootprintSqft?.toLocaleString()}
                    </span>{" "}
                    sq ft) and applied Solar&apos;s measured pitch (slope factor{" "}
                    <span className="font-mono">
                      {result.correction.slopeFactor?.toFixed(3)}
                    </span>
                    ) to land at{" "}
                    <span className="font-mono text-[#38C5EE]">
                      {result.solar.sqft?.toLocaleString()}
                    </span>{" "}
                    sq ft.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Solar measurement chips */}
          <div className="bg-ink-900/80 border border-ink-700 rounded-2xl p-5 sm:p-6">
            <div className="flex items-baseline justify-between mb-4">
              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">
                Measurements · Google Solar API
              </p>
              <div className="flex flex-wrap gap-3 text-[9px] uppercase tracking-[0.18em] text-slate-500">
                {result.solar.imageryQuality && (
                  <span>
                    Imagery{" "}
                    <span className="text-slate-300">
                      {result.solar.imageryQuality}
                    </span>
                  </span>
                )}
                {result.solar.imageryDate && (
                  <span>
                    Captured{" "}
                    <span className="text-slate-300 font-mono">
                      {result.solar.imageryDate}
                    </span>
                  </span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
              <Stat
                label={
                  result.correction?.applied ? "Roof area (GIS-corrected)" : "Roof area"
                }
                value={
                  result.solar.sqft != null
                    ? result.solar.sqft.toLocaleString()
                    : "—"
                }
                unit="sq ft"
                emphasize
              />
              <Stat
                label="Footprint"
                value={
                  result.solar.footprintSqft != null
                    ? result.solar.footprintSqft.toLocaleString()
                    : "—"
                }
                unit="sq ft"
              />
              <Stat
                label="Predominant pitch"
                value={
                  result.solar.pitchDegrees != null
                    ? `${Math.max(
                        1,
                        Math.round(
                          Math.tan(
                            (result.solar.pitchDegrees * Math.PI) / 180,
                          ) * 12,
                        ),
                      )}/12`
                    : "—"
                }
                unit=""
              />
              <Stat
                label="Facets"
                value={String(result.solar.segmentCount)}
                unit=""
              />
            </div>
          </div>

          {/* EagleView-equivalent anatomy: edges + attic + stories + complexity */}
          <div className="bg-ink-900/80 border border-ink-700 rounded-2xl p-5 sm:p-6">
            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-4">
              Roof anatomy · Derived
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
              <Stat
                label="Stories"
                value={String(result.derived.stories)}
                unit={result.derived.stories === 1 ? "story" : "stories"}
              />
              <Stat
                label="Est. attic"
                value={
                  result.derived.estimatedAtticSqft != null
                    ? result.derived.estimatedAtticSqft.toLocaleString()
                    : "—"
                }
                unit="sq ft"
              />
              <Stat
                label="Complexity"
                value={result.derived.complexity}
                unit=""
              />
              <Stat
                label="Faces"
                value={result.derived.predominantCompass ?? "—"}
                unit=""
              />
            </div>
          </div>

          {/* Edge lengths — prefer Gemini line detection (reliable);
              fall back to Solar bbox geometry only when Gemini missing
              AND Solar values look plausible. Solar's rotated-bbox
              vertices don't share precise lat/lng, so classifyEdges
              regularly returns garbage (e.g. 1,490 ft of rakes, 0 eaves
              on a 17-facet hip roof). Gemini line detection from the
              tile is far more trustworthy. */}
          {(() => {
            const g = result.geminiEdges;
            const s = result.edges;
            const solarVals = [s.ridgesHipsLf, s.valleysLf, s.rakesLf, s.eavesLf];
            const solarHasAny = solarVals.some((v) => v != null);
            const solarTotal = solarVals.reduce<number>(
              (a, v) => a + (v ?? 0),
              0,
            );
            const solarMax = Math.max(...solarVals.map((v) => v ?? 0));
            // Sanity heuristic: one bucket >70% of total = classifier misfire
            const solarLooksSane =
              solarHasAny &&
              solarTotal > 0 &&
              solarMax / solarTotal < 0.7 &&
              (s.eavesLf ?? 0) > 0;

            if (g) {
              return (
                <div className="bg-ink-900/80 border border-ink-700 rounded-2xl p-5 sm:p-6">
                  <div className="flex items-baseline justify-between mb-4">
                    <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">
                      Roof anatomy · Edge lengths
                    </p>
                    <p className="text-[9px] uppercase tracking-[0.18em] text-slate-500">
                      Gemini line detection · {g.linesCount} lines
                    </p>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
                    <Stat label="Ridges + hips" value={g.ridgesHipsLf.toLocaleString()} unit="ft" />
                    <Stat label="Valleys" value={g.valleysLf.toLocaleString()} unit="ft" />
                    <Stat label="Rakes" value={g.rakesLf.toLocaleString()} unit="ft" />
                    <Stat label="Eaves" value={g.eavesLf.toLocaleString()} unit="ft" />
                  </div>
                  <p className="text-[10px] text-slate-500 mt-3 font-mono">
                    Vision-based line detection from the painted satellite tile.
                  </p>
                </div>
              );
            }

            if (solarLooksSane) {
              return (
                <div className="bg-ink-900/80 border border-ink-700 rounded-2xl p-5 sm:p-6">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-4">
                    Roof anatomy · Edge lengths
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
                    <Stat label="Ridges + hips" value={(s.ridgesHipsLf ?? 0).toLocaleString()} unit="ft" />
                    <Stat label="Valleys" value={(s.valleysLf ?? 0).toLocaleString()} unit="ft" />
                    <Stat label="Rakes" value={(s.rakesLf ?? 0).toLocaleString()} unit="ft" />
                    <Stat label="Eaves" value={(s.eavesLf ?? 0).toLocaleString()} unit="ft" />
                  </div>
                  <p className="text-[10px] text-slate-500 mt-3 font-mono">
                    Edge lengths from Solar facet geometry (vision classifier
                    unavailable for this tile).
                  </p>
                </div>
              );
            }

            return null;
          })()}

          {/* Per-facet breakdown */}
          {result.facets.length > 0 && (
            <div className="bg-ink-900/80 border border-ink-700 rounded-2xl p-5 sm:p-6">
              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-4">
                Per-facet breakdown · {result.facets.length} planes
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {result.facets.map((f, i) => (
                  <div
                    key={i}
                    className="bg-ink-800/60 border border-ink-700 rounded-lg px-3 py-2 flex items-baseline justify-between gap-3"
                  >
                    <span className="font-mono text-slate-400 text-[10px] uppercase">
                      Facet {String.fromCharCode(65 + i)}
                    </span>
                    <span className="font-mono text-slate-200">
                      {f.compassDirection.padEnd(2)} · {f.pitchOnTwelve} ·{" "}
                      {f.slopedSqft.toLocaleString()} sq ft
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Roof material + condition hints (Gemini visual analysis) */}
          {(result.geminiAnalysis.roofMaterial ||
            result.geminiAnalysis.conditionHints.length > 0) && (
            <div className="bg-ink-900/80 border border-ink-700 rounded-2xl p-5 sm:p-6">
              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-4">
                Roof condition · Gemini visual analysis
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {result.geminiAnalysis.roofMaterial && (
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-1">
                      Material
                    </p>
                    <p className="font-display text-xl text-slate-100">
                      {result.geminiAnalysis.roofMaterial.type
                        .replace(/_/g, " ")
                        .replace(/^\w/, (c) => c.toUpperCase())}
                      <span className="ml-2 text-xs text-slate-500 font-sans">
                        {Math.round(
                          result.geminiAnalysis.roofMaterial.confidence * 100,
                        )}
                        %
                      </span>
                    </p>
                  </div>
                )}
                {result.geminiAnalysis.conditionHints.length > 0 && (
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-2">
                      Condition signals
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {result.geminiAnalysis.conditionHints
                        .slice()
                        .sort((a, b) => b.confidence - a.confidence)
                        .map((h, i) => {
                          const tier =
                            h.confidence >= 0.75
                              ? "high"
                              : h.confidence >= 0.5
                                ? "med"
                                : "low";
                          const isGood = h.hint === "uniform_clean";
                          return (
                            <span
                              key={i}
                              className={`px-3 py-1.5 rounded-full text-xs font-mono border ${
                                isGood
                                  ? "border-emerald-500/40 text-emerald-300 bg-emerald-500/5"
                                  : tier === "high"
                                    ? "border-amber-500/40 text-amber-300 bg-amber-500/5"
                                    : tier === "med"
                                      ? "border-slate-600 text-slate-300 bg-ink-800"
                                      : "border-slate-700 text-slate-500 bg-ink-800/50"
                              }`}
                              title={`confidence: ${h.confidence.toFixed(2)}`}
                            >
                              {h.hint.replace(/_/g, " ")}{" "}
                              <span className="opacity-60">
                                {Math.round(h.confidence * 100)}%
                              </span>
                            </span>
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Solar potential */}
          {(result.solarPotential.maxPanels ||
            result.solarPotential.annualSunshineHours) && (
            <div className="bg-ink-900/80 border border-ink-700 rounded-2xl p-5 sm:p-6">
              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-4">
                Solar potential · Google Solar API
              </p>
              <div className="grid grid-cols-2 gap-3 sm:gap-4">
                <Stat
                  label="Max PV panels"
                  value={
                    result.solarPotential.maxPanels != null
                      ? result.solarPotential.maxPanels.toLocaleString()
                      : "—"
                  }
                  unit="panels"
                />
                <Stat
                  label="Annual sunshine"
                  value={
                    result.solarPotential.annualSunshineHours != null
                      ? Math.round(
                          result.solarPotential.annualSunshineHours,
                        ).toLocaleString()
                      : "—"
                  }
                  unit="hrs/yr"
                />
              </div>
            </div>
          )}

          {/* Penetration totals (mirror EagleView block) */}
          <div className="bg-ink-900/80 border border-ink-700 rounded-2xl p-5 sm:p-6">
            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-4">
              Roof penetrations · Derived from Gemini bboxes
            </p>
            <div className="grid grid-cols-3 gap-3 sm:gap-4">
              <Stat
                label="Count"
                value={String(result.penetrationTotals.count)}
                unit=""
              />
              <Stat
                label="Perimeter"
                value={result.penetrationTotals.perimeterFt.toFixed(1)}
                unit="ft"
              />
              <Stat
                label="Total area"
                value={result.penetrationTotals.areaSqft.toFixed(1)}
                unit="sq ft"
              />
            </div>
          </div>

          {/* Objects */}
          {result.objects.length > 0 && (
            <div className="bg-ink-900/80 border border-ink-700 rounded-2xl p-5 sm:p-6">
              <div className="flex items-baseline justify-between mb-4">
                <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">
                  Rooftop objects · Detected by Gemini
                </p>
                <p className="text-[9px] uppercase tracking-[0.18em] text-slate-500">
                  {result.objects.length} total
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {result.objects
                  .slice()
                  .sort((a, b) => b.confidence - a.confidence)
                  .map((o, i) => {
                    const conf = o.confidence;
                    const tier =
                      conf >= 0.75 ? "high" : conf >= 0.5 ? "med" : "low";
                    return (
                      <span
                        key={i}
                        className={`px-3 py-1.5 rounded-full text-xs font-mono border ${
                          tier === "high"
                            ? "border-[#38C5EE]/40 text-[#38C5EE] bg-[#38C5EE]/5"
                            : tier === "med"
                              ? "border-slate-600 text-slate-300 bg-ink-800"
                              : "border-slate-700 text-slate-500 bg-ink-800/50"
                        }`}
                        title={`confidence: ${conf.toFixed(2)}`}
                      >
                        {o.type.replace(/_/g, " ")}
                        <span className="ml-2 opacity-60">
                          {Math.round(conf * 100)}%
                        </span>
                      </span>
                    );
                  })}
              </div>
              <p className="text-[10px] text-slate-500 mt-4 font-mono">
                Sorted by Gemini confidence (high → low)
              </p>
            </div>
          )}

          {/* Provenance footer */}
          <div className="text-[10px] uppercase tracking-[0.18em] text-slate-600 text-center pt-2">
            {result.modelVersion} · {result.tile.zoom}x · generated{" "}
            {new Date(result.computedAt).toLocaleString()}
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  emphasize = false,
}: {
  label: string;
  value: string;
  unit: string;
  emphasize?: boolean;
}): React.ReactElement {
  return (
    <div
      className={`bg-ink-800/60 border rounded-xl px-3 sm:px-4 py-3 ${
        emphasize ? "border-[#38C5EE]/30" : "border-ink-700"
      }`}
    >
      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
        {label}
      </p>
      <p
        className={`font-display mt-1 leading-none ${
          emphasize ? "text-3xl text-[#38C5EE]" : "text-2xl text-slate-100"
        }`}
      >
        {value}
        {unit && (
          <span className="text-sm text-slate-400 ml-1 font-sans">{unit}</span>
        )}
      </p>
    </div>
  );
}
