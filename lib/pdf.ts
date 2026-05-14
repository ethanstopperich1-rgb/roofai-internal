"use client";

import jsPDF from "jspdf";
import type {
  Assumptions,
  DetailedEstimate,
  Estimate,
  LineItem,
  Material,
  RoofLengths,
} from "@/types/estimate";
import type { EstimateV2 } from "@/types/roof";
import type { EdgeType } from "@/types/roof";
import { MATERIAL_RATES, fmt } from "./pricing";
import { BRAND_CONFIG } from "./branding";
import { CARRIERS } from "./carriers";

/** Narrow that doesn't widen the input to `Estimate`. */
function isV2(e: Estimate | EstimateV2): e is EstimateV2 {
  return (e as EstimateV2).version === 2;
}

/** Project an EstimateV2 into the legacy Estimate shape the renderer was
 *  built around. The PDF body code path then runs unchanged. Note: this
 *  is a render-time projection only — v2 estimates persist as EstimateV2,
 *  and we never round-trip the projection back to storage. */
function projectV2ToLegacy(v2: EstimateV2): Estimate {
  const { pricingInputs, priced, roofData } = v2;
  const sumEdges = (type: EdgeType) =>
    roofData.edges.filter((e) => e.type === type).reduce((s, e) => s + e.lengthFt, 0);
  const totals = roofData.totals;

  // v2's PricingInputs uses Material that includes "wood-shake"/"flat-membrane"
  // which the legacy Assumptions.material doesn't carry. Coerce unknown
  // materials to the closest legacy match — wood-shake renders as
  // architectural, flat-membrane as 3-tab. PDF only uses MATERIAL_RATES[m].label
  // so the visual impact is just the spec-row label.
  const legacyMaterial: Material =
    pricingInputs.material === "wood-shake"
      ? "asphalt-architectural"
      : pricingInputs.material === "flat-membrane"
        ? "asphalt-3tab"
        : (pricingInputs.material as Material);

  const assumptions: Assumptions = {
    sqft: Math.round(totals.totalRoofAreaSqft),
    pitch:
      totals.averagePitchDegrees >= 35
        ? "8/12+"
        : totals.averagePitchDegrees >= 30
          ? "7/12"
          : totals.averagePitchDegrees >= 26
            ? "6/12"
            : totals.averagePitchDegrees >= 22
              ? "5/12"
              : "4/12",
    material: legacyMaterial,
    ageYears: roofData.ageYearsEstimate ?? 0,
    laborMultiplier: pricingInputs.laborMultiplier,
    materialMultiplier: pricingInputs.materialMultiplier,
    serviceType: pricingInputs.serviceType,
    complexity: totals.complexity,
  };

  const detailed: DetailedEstimate = {
    lineItems: priced.lineItems.map((li) => ({
      code: li.code,
      description: li.description,
      friendlyName: li.friendlyName,
      quantity: li.quantity,
      unit: li.unit,
      unitCostLow: li.unitCostLow,
      unitCostHigh: li.unitCostHigh,
      extendedLow: li.extendedLow,
      extendedHigh: li.extendedHigh,
      category: li.category,
    })),
    simplifiedItems: priced.simplifiedItems,
    subtotalLow: priced.subtotalLow,
    subtotalHigh: priced.subtotalHigh,
    overheadProfit: priced.overheadProfit,
    totalLow: priced.totalLow,
    totalHigh: priced.totalHigh,
    squares: priced.squares,
  };

  const lengths: RoofLengths = {
    perimeterLf: roofData.flashing.dripEdgeLf,
    eavesLf: sumEdges("eave"),
    rakesLf: sumEdges("rake"),
    ridgesLf: sumEdges("ridge"),
    hipsLf: sumEdges("hip"),
    valleysLf: sumEdges("valley"),
    dripEdgeLf: roofData.flashing.dripEdgeLf,
    // Continuous-metal flashing: chimney/skylight kits + Tier B's headwall
    // + apron pieces. Wall step flashing is per-shingle stepped (below).
    flashingLf:
      roofData.flashing.chimneyLf +
      roofData.flashing.skylightLf +
      roofData.flashing.headwallLf +
      roofData.flashing.apronLf,
    // Step flashing — dormer cheek walls + Tier B non-dormer wall-step.
    stepFlashingLf: roofData.flashing.dormerStepLf + roofData.flashing.wallStepLf,
    iwsSqft: roofData.flashing.iwsSqft,
    source: "polygons",
  };

  return {
    id: v2.id,
    createdAt: v2.createdAt,
    staff: v2.staff,
    customerName: v2.customerName,
    notes: v2.notes,
    address: v2.address,
    assumptions,
    addOns: pricingInputs.addOns,
    total: Math.round((priced.totalLow + priced.totalHigh) / 2),
    baseLow: priced.totalLow,
    baseHigh: priced.totalHigh,
    isInsuranceClaim: v2.isInsuranceClaim,
    detailed,
    lengths,
    photos: v2.photos,
    claim: v2.claim,
  };
}

const SERVICE_LABEL: Record<NonNullable<Estimate["assumptions"]["serviceType"]>, string> = {
  new: "New install",
  "reroof-tearoff": "Reroof (tear-off)",
  layover: "Layover",
  repair: "Repair only",
};

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const num = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

export function generatePdf(input: Estimate | EstimateV2) {
  const e: Estimate = isV2(input) ? projectV2ToLegacy(input) : input;
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const W = 612;
  const H = 792;
  const MARGIN = 40;
  let y = 0;

  // ---------- Header bar ----------
  const [pr, pg, pb] = hexToRgb(BRAND_CONFIG.primaryColor);
  const [ar, ag, ab] = hexToRgb(BRAND_CONFIG.accentColor);
  doc.setFillColor(pr, pg, pb);
  doc.rect(0, 0, W, 90, "F");
  doc.setTextColor(ar, ag, ab);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.text(BRAND_CONFIG.companyName, MARGIN, 50);
  doc.setTextColor(180, 200, 220);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text("Roofing Estimate Proposal", MARGIN, 70);

  if (BRAND_CONFIG.phone || BRAND_CONFIG.email) {
    const contact = [BRAND_CONFIG.phone, BRAND_CONFIG.email].filter(Boolean).join("  ·  ");
    doc.text(contact, W - MARGIN, 70, { align: "right" });
  }

  // Insurance-claim badge — colored to match the carrier's brand when known
  if (e.isInsuranceClaim) {
    const carrier = e.claim?.carrier ? CARRIERS[e.claim.carrier] : undefined;
    const [br, bg, bb] = carrier
      ? hexToRgb(carrier.accent)
      : [251, 191, 36];
    doc.setFillColor(br, bg, bb);
    doc.roundedRect(W - MARGIN - 150, 28, 150, 22, 4, 4, "F");
    // Choose readable text color based on luminance
    const lum = 0.299 * br + 0.587 * bg + 0.114 * bb;
    doc.setTextColor(lum < 140 ? 255 : 0, lum < 140 ? 255 : 0, lum < 140 ? 255 : 0);
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    const label = carrier ? `${carrier.name.toUpperCase()} CLAIM` : "INSURANCE CLAIM";
    doc.text(label, W - MARGIN - 75, 43, { align: "center", maxWidth: 145 });
  }

  y = 130;

  // ---------- Meta row ----------
  doc.setTextColor(20, 20, 20);
  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.text(`Estimate ID: ${e.id}`, MARGIN, y);
  doc.text(`Date: ${new Date(e.createdAt).toLocaleDateString()}`, 400, y);
  y += 18;
  doc.text(`Prepared by: ${e.staff || "—"}`, MARGIN, y);
  if (e.customerName) doc.text(`Customer: ${e.customerName}`, 400, y);
  y += 28;

  // ---------- Carrier claim metadata (insurance mode only) ------------
  if (e.isInsuranceClaim && e.claim) {
    const carrier = CARRIERS[e.claim.carrier] ?? CARRIERS.other;
    const [cr, cg, cb] = hexToRgb(carrier.accent);
    doc.setFillColor(cr, cg, cb);
    doc.rect(MARGIN - 4, y - 12, 4, 70, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(20, 20, 20);
    doc.text(`Claim — ${carrier.name}`, MARGIN, y);
    y += 14;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(70, 70, 70);
    const claimRows: Array<[string, string | undefined]> = [
      ["Claim #", e.claim.claimNumber],
      ["Policy #", e.claim.policyNumber],
      ["Adjuster", e.claim.adjusterName],
      ["Adjuster Phone", e.claim.adjusterPhone],
      ["Date of Loss", e.claim.dateOfLoss ? new Date(e.claim.dateOfLoss).toLocaleDateString() : undefined],
      ["Peril", e.claim.peril],
    ].filter(([, v]) => v) as Array<[string, string]>;
    const colW = (W - MARGIN * 2) / 2;
    claimRows.forEach(([k, v], i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      doc.setTextColor(120, 120, 120);
      doc.text(k, MARGIN + col * colW, y + row * 14);
      doc.setTextColor(20, 20, 20);
      doc.text(v ?? "—", MARGIN + col * colW + 90, y + row * 14);
    });
    y += Math.ceil(claimRows.length / 2) * 14 + 14;
    doc.setTextColor(20, 20, 20);
  }

  // ---------- Property ----------
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Property", MARGIN, y);
  y += 16;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(e.address.formatted, MARGIN, y, { maxWidth: 530 });
  y += 28;

  // ---------- Specifications ----------
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Specifications", MARGIN, y);
  y += 16;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  const serviceType = e.assumptions.serviceType ?? "reroof-tearoff";
  const specs: Array<[string, string]> = [
    ["Service", SERVICE_LABEL[serviceType]],
    ["Roof Size", `${e.assumptions.sqft.toLocaleString()} sq ft`],
    ["Pitch", e.assumptions.pitch],
    ["Material", MATERIAL_RATES[e.assumptions.material].label],
    ["Estimated Age", `${e.assumptions.ageYears} years`],
    ["Complexity", e.assumptions.complexity ?? "moderate"],
    ["Labor Multiplier", e.assumptions.laborMultiplier.toFixed(2)],
    ["Material Multiplier", e.assumptions.materialMultiplier.toFixed(2)],
  ];
  specs.forEach(([k, v]) => {
    doc.text(k, MARGIN, y);
    doc.text(String(v), 220, y);
    y += 16;
  });

  y += 6;

  // ---------- Vision (if available) ----------
  if (e.vision && e.vision.confidence > 0.4) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("AI Roof Assessment", MARGIN, y);
    y += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    if (e.vision.visibleDamage.length && e.vision.visibleDamage[0] !== "none") {
      doc.text(`Visible signals: ${e.vision.visibleDamage.join(", ")}`, MARGIN, y);
      y += 14;
    }
    if (e.vision.salesNotes) {
      const lines = doc.splitTextToSize(e.vision.salesNotes, 530);
      doc.text(lines, MARGIN, y);
      y += lines.length * 12;
    }
    y += 8;
  }

  // ---------- Roof measurements (EagleView-style Length Diagram) ----------
  if (e.lengths) {
    if (y > H - 200) { doc.addPage(); y = MARGIN; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Roof Measurements", MARGIN, y);
    y += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);

    const measurements: Array<[string, string]> = [
      ["Ridges", `${e.lengths.ridgesLf} ft`],
      ["Hips", `${e.lengths.hipsLf} ft`],
      ["Valleys", `${e.lengths.valleysLf} ft`],
      ["Rakes", `${e.lengths.rakesLf} ft`],
      ["Eaves", `${e.lengths.eavesLf} ft`],
      ["Drip edge", `${e.lengths.dripEdgeLf} ft`],
      ["Flashing", `${e.lengths.flashingLf} ft`],
      ["Step flashing", `${e.lengths.stepFlashingLf} ft`],
      ["Ice & water shield", `${e.lengths.iwsSqft.toLocaleString()} sqft`],
    ];
    // 2-column grid
    const colW = (W - MARGIN * 2) / 2;
    measurements.forEach(([k, v], i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const xK = MARGIN + col * colW;
      const xV = xK + colW - 8;
      doc.text(k, xK, y + row * 14);
      doc.text(v, xV, y + row * 14, { align: "right" });
    });
    y += Math.ceil(measurements.length / 2) * 14 + 6;
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    const sourceLabel =
      e.lengths.source === "polygons"
        ? "Computed from refined roof polygons."
        : e.lengths.source === "footprint"
          ? "Estimated from building footprint."
          : "Approximated from sqft + complexity.";
    doc.text(sourceLabel, MARGIN, y);
    doc.setTextColor(20, 20, 20);
    y += 14;
  }

  // ---------- Penetrations summary ----------
  if (e.vision?.penetrations && e.vision.penetrations.length > 0) {
    if (y > H - 100) { doc.addPage(); y = MARGIN; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(`Penetrations (${e.vision.penetrations.length})`, MARGIN, y);
    y += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    e.vision.penetrations.forEach((p, i) => {
      const sizeStr = p.approxSizeFt ? ` ~${p.approxSizeFt} ft` : "";
      doc.text(`#${i + 1}  ${p.kind}${sizeStr}`, MARGIN, y);
      y += 13;
    });
    y += 6;
  }

  // ---------- Waste calculation table ----------
  if (e.waste) {
    if (y > H - 200) { doc.addPage(); y = MARGIN; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Waste Calculation", MARGIN, y);
    y += 16;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text("WASTE %", MARGIN, y);
    doc.text("AREA (SQFT)", 280, y, { align: "right" });
    doc.text("SQUARES", W - MARGIN, y, { align: "right" });
    y += 4;
    doc.setDrawColor(200);
    doc.line(MARGIN, y, W - MARGIN, y);
    y += 10;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    e.waste.rows.forEach((row) => {
      const tag = row.isMeasured
        ? "  measured"
        : row.isSuggested
          ? "  suggested"
          : "";
      doc.setFont(row.isSuggested ? "helvetica" : "helvetica", row.isSuggested ? "bold" : "normal");
      doc.text(`${row.pct}%${tag}`, MARGIN, y);
      doc.text(row.areaSqft.toLocaleString(), 280, y, { align: "right" });
      doc.text(row.squares.toFixed(2), W - MARGIN, y, { align: "right" });
      y += 13;
    });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    doc.text(
      "Squares are rounded up to the nearest 1/3. Add ridge / hip / starter materials separately.",
      MARGIN,
      y,
      { maxWidth: 530 },
    );
    doc.setTextColor(20, 20, 20);
    y += 14;
  }

  // ---------- Add-ons ----------
  const enabledAddOns = e.addOns.filter((a) => a.enabled);
  if (enabledAddOns.length) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Add-Ons", MARGIN, y);
    y += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    enabledAddOns.forEach((a) => {
      doc.text(`• ${a.label}`, MARGIN, y);
      doc.text(fmt(a.price), 470, y, { align: "right" });
      y += 16;
    });
    y += 8;
  }

  // ---------- Insurance: full Xactimate-style line items ----------
  // Skip if `detailed` is missing. /internal + /dashboard/estimate both
  // populate `detailed` from the priced engine at save time (v1) or via
  // the v2→v1 projection above (v2). Pre-Tier-C v1 saves without
  // `detailed` will render without the itemized scope — acceptable, those
  // estimates are stale.
  if (e.isInsuranceClaim && e.detailed) {
    const detailed = e.detailed;

    if (y > H - 200) {
      doc.addPage();
      y = MARGIN;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Itemized Scope (Xactimate-style)", MARGIN, y);
    y += 18;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text("CODE", MARGIN, y);
    doc.text("DESCRIPTION", MARGIN + 64, y);
    doc.text("QTY", 380, y, { align: "right" });
    doc.text("EXTENDED", W - MARGIN, y, { align: "right" });
    y += 6;
    doc.setDrawColor(180);
    doc.line(MARGIN, y, W - MARGIN, y);
    y += 10;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    detailed.lineItems.forEach((it: LineItem) => {
      if (y > H - MARGIN - 60) {
        doc.addPage();
        y = MARGIN;
      }
      doc.text(it.code, MARGIN, y);
      const descLines = doc.splitTextToSize(it.description, 290);
      doc.text(descLines, MARGIN + 64, y);
      const qty = `${it.quantity.toLocaleString()} ${it.unit !== "%" ? it.unit : ""}`;
      doc.text(qty, 380, y, { align: "right" });
      doc.text(`${fmt(it.extendedLow)}–${fmt(it.extendedHigh)}`, W - MARGIN, y, {
        align: "right",
      });
      y += Math.max(12, descLines.length * 12);
    });

    y += 8;
    doc.setDrawColor(180);
    doc.line(MARGIN, y, W - MARGIN, y);
    y += 16;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("Subtotal", MARGIN, y);
    doc.text(`${fmt(detailed.subtotalLow)} – ${fmt(detailed.subtotalHigh)}`, W - MARGIN, y, {
      align: "right",
    });
    y += 14;
    doc.text("Overhead & Profit", MARGIN, y);
    doc.text(
      `${fmt(detailed.overheadProfit.low)} – ${fmt(detailed.overheadProfit.high)}`,
      W - MARGIN,
      y,
      { align: "right" },
    );
    y += 14;
    doc.setFontSize(11);
    doc.text("Detailed Total", MARGIN, y);
    doc.setTextColor(ar, ag, ab);
    doc.text(`${fmt(detailed.totalLow)} – ${fmt(detailed.totalHigh)}`, W - MARGIN, y, {
      align: "right",
    });
    doc.setTextColor(20, 20, 20);
    y += 22;
  }

  // ---------- Headline total ----------
  if (y > H - 140) {
    doc.addPage();
    y = MARGIN;
  }
  doc.setDrawColor(220);
  doc.line(MARGIN, y, W - MARGIN, y);
  y += 22;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Estimated Range", MARGIN, y);
  doc.text(`${fmt(e.baseLow)} – ${fmt(e.baseHigh)}`, 470, y, { align: "right" });
  y += 22;
  doc.setFontSize(16);
  doc.text("Total Estimate", MARGIN, y);
  doc.setTextColor(ar, ag, ab);
  doc.text(fmt(e.total), 470, y, { align: "right" });

  y += 50;
  doc.setTextColor(20, 20, 20);
  doc.setFontSize(9);
  doc.setFont("helvetica", "italic");
  doc.text(
    "This is a preliminary estimate based on remote assessment. Final pricing subject to on-site inspection. Valid for 30 days.",
    MARGIN,
    y,
    { maxWidth: 530 },
  );

  y += 60;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.line(MARGIN, y, 280, y);
  doc.line(320, y, 560, y);
  doc.text("Customer Signature", MARGIN, y + 14);
  doc.text("Date", 320, y + 14);

  // ─── Field Photos appendix ──────────────────────────────────────────
  // For insurance work (and just for proposal credibility), append every
  // uploaded photo with its AI caption + EXIF metadata. 6 photos per page,
  // 3-col × 2-row grid.
  if (e.photos && e.photos.length > 0) {
    doc.addPage();
    let py = MARGIN;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(20, 20, 20);
    doc.text("Field Inspection Photos", MARGIN, py);
    py += 8;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(110, 110, 120);
    const claimReady = e.photos.filter((p) => p.claimReady).length;
    doc.text(
      `${e.photos.length} photo${e.photos.length === 1 ? "" : "s"} · ${claimReady} claim-ready (with GPS + timestamp)`,
      MARGIN,
      py + 8,
    );
    py += 24;

    const cols = 3;
    const rows = 2;
    const perPage = cols * rows;
    const cellW = (W - MARGIN * 2 - (cols - 1) * 8) / cols;
    const cellH = (H - py - MARGIN - (rows - 1) * 8) / rows;

    for (let i = 0; i < e.photos.length; i++) {
      const localIdx = i % perPage;
      if (i > 0 && localIdx === 0) {
        doc.addPage();
        py = MARGIN;
      }
      const col = localIdx % cols;
      const row = Math.floor(localIdx / cols);
      const x = MARGIN + col * (cellW + 8);
      const y = py + row * (cellH + 8);
      const photo = e.photos[i];

      // Caption + tag chip area: bottom 36pt of the cell
      const imgH = cellH - 36;
      try {
        // jsPDF accepts data: URIs and remote URLs (when 'compress' option is fine).
        // We pass URL directly; jsPDF fetches via Image() under the hood when
        // running in a browser environment.
        doc.addImage(photo.url, "JPEG", x, y, cellW, imgH, undefined, "FAST");
      } catch {
        doc.setDrawColor(220);
        doc.rect(x, y, cellW, imgH);
        doc.setFontSize(8);
        doc.text("[image unavailable]", x + 6, y + 14);
      }

      // Index badge top-left
      doc.setFillColor(7, 9, 13);
      doc.roundedRect(x + 4, y + 4, 22, 14, 2, 2, "F");
      doc.setTextColor(230, 237, 245);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.text(`#${i + 1}`, x + 15, y + 13, { align: "center" });

      // Footer caption + tags
      doc.setTextColor(20, 20, 20);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      const caption = photo.caption || photo.filename;
      const capLines = doc.splitTextToSize(caption, cellW);
      doc.text(capLines.slice(0, 2), x, y + imgH + 10);

      // Tags + claim-ready badge
      const tagText = photo.tags
        .slice(0, 3)
        .map((t) => t.kind.replace(/-/g, " "))
        .join(" · ");
      doc.setTextColor(110, 110, 120);
      doc.setFontSize(7);
      doc.text(tagText, x, y + imgH + 28);
      const dateStr = photo.takenAt ? new Date(photo.takenAt).toLocaleDateString() : "—";
      const meta = `${dateStr}${photo.location ? " · GPS ✓" : ""}${photo.claimReady ? " · CLAIM-READY" : ""}`;
      doc.text(meta, x + cellW, y + imgH + 28, { align: "right" });
    }
  }

  // ─── AI-disclosure footer (Texas SB 1665 effective 2026; voluntary best
  // practice everywhere else). Roof measurements + damage flags came from
  // automated satellite analysis with optional human review. Surfacing this
  // up-front protects against "did a person look at this?" disputes during
  // claim review and is *required* if this PDF will be submitted in TX.
  // ─────────────────────────────────────────────────────────────────────
  const FOOTER_Y = H - 50;
  doc.setDrawColor(220);
  doc.line(MARGIN, FOOTER_Y, W - MARGIN, FOOTER_Y);
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 120);
  doc.setFont("helvetica", "normal");
  doc.text(
    "AI-assisted estimate disclosure: Roof measurements and damage signals were generated by automated satellite analysis and AI vision. " +
      "All figures are reviewed by the preparing roofing professional before delivery. Final pricing requires on-site inspection.",
    MARGIN,
    FOOTER_Y + 12,
    { maxWidth: W - MARGIN * 2 },
  );
  doc.text(
    `Estimate ${e.id} · ${BRAND_CONFIG.companyName} · ${new Date(e.createdAt).toISOString().slice(0, 10)}`,
    MARGIN,
    FOOTER_Y + 30,
  );

  doc.save(`${BRAND_CONFIG.productName}_Estimate_${e.id}.pdf`);
}

export function buildSummaryText(input: Estimate | EstimateV2): string {
  const e: Estimate = isV2(input) ? projectV2ToLegacy(input) : input;
  const enabled = e.addOns.filter((a) => a.enabled);
  const serviceType = e.assumptions.serviceType ?? "reroof-tearoff";
  const lines = [
    `${BRAND_CONFIG.companyName} Estimate — ${new Date(e.createdAt).toLocaleDateString()}`,
    `Property: ${e.address.formatted}`,
    `Service: ${SERVICE_LABEL[serviceType]}`,
    `Roof Size: ${e.assumptions.sqft.toLocaleString()} sq ft`,
    `Pitch: ${e.assumptions.pitch}`,
    `Material: ${MATERIAL_RATES[e.assumptions.material].label}`,
    `Estimated Age: ${e.assumptions.ageYears} years`,
    enabled.length ? `Add-Ons: ${enabled.map((a) => a.label).join(", ")}` : "Add-Ons: none",
  ];
  if (e.isInsuranceClaim) lines.push("Insurance claim: yes");
  if (e.vision?.salesNotes) lines.push(`Notes: ${e.vision.salesNotes}`);
  lines.push(
    `Estimated Range: ${fmt(e.baseLow)} – ${fmt(e.baseHigh)}`,
    `Total: ${fmt(e.total)}`,
    "",
    "Prepared by " + (e.staff || `${BRAND_CONFIG.companyName} Team`),
  );
  return lines.join("\n");
}
