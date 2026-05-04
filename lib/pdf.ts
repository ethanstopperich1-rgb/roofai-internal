"use client";

import jsPDF from "jspdf";
import type { Estimate, LineItem } from "@/types/estimate";
import { MATERIAL_RATES, fmt, buildDetailedEstimate } from "./pricing";
import { BRAND_CONFIG } from "./branding";

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

export function generatePdf(e: Estimate) {
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

  // Insurance-claim badge
  if (e.isInsuranceClaim) {
    doc.setFillColor(251, 191, 36);
    doc.roundedRect(W - MARGIN - 110, 28, 110, 22, 4, 4, "F");
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text("INSURANCE CLAIM", W - MARGIN - 55, 43, { align: "center" });
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
  if (e.isInsuranceClaim) {
    const detailed =
      e.detailed ??
      buildDetailedEstimate(e.assumptions, e.addOns, {
        buildingFootprintSqft: e.solar?.buildingFootprintSqft ?? null,
        segmentCount: e.solar?.segmentCount ?? 4,
      });

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

  doc.save(`RoofAI_Estimate_${e.id}.pdf`);
}

export function buildSummaryText(e: Estimate): string {
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
