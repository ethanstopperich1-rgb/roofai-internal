"use client";

import jsPDF from "jspdf";
import type { Estimate } from "@/types/estimate";
import { MATERIAL_RATES, fmt } from "./pricing";

export function generatePdf(e: Estimate) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const W = 612;
  let y = 56;

  doc.setFillColor(10, 13, 18);
  doc.rect(0, 0, W, 90, "F");
  doc.setTextColor(56, 189, 248);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.text("RoofAI Internal", 40, 50);
  doc.setTextColor(180, 200, 220);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text("Roofing Estimate Proposal", 40, 70);

  y = 130;
  doc.setTextColor(20, 20, 20);
  doc.setFontSize(11);
  doc.text(`Estimate ID: ${e.id}`, 40, y);
  doc.text(`Date: ${new Date(e.createdAt).toLocaleDateString()}`, 400, y);
  y += 18;
  doc.text(`Prepared by: ${e.staff || "—"}`, 40, y);
  if (e.customerName) doc.text(`Customer: ${e.customerName}`, 400, y);
  y += 28;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Property", 40, y);
  y += 16;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(e.address.formatted, 40, y, { maxWidth: 530 });
  y += 28;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Specifications", 40, y);
  y += 16;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  const specs = [
    ["Roof Size", `${e.assumptions.sqft.toLocaleString()} sq ft`],
    ["Pitch", e.assumptions.pitch],
    ["Material", MATERIAL_RATES[e.assumptions.material].label],
    ["Estimated Age", `${e.assumptions.ageYears} years`],
    ["Labor Multiplier", e.assumptions.laborMultiplier.toFixed(2)],
    ["Material Multiplier", e.assumptions.materialMultiplier.toFixed(2)],
  ];
  specs.forEach(([k, v]) => {
    doc.text(k, 40, y);
    doc.text(String(v), 220, y);
    y += 16;
  });

  y += 12;
  const enabledAddOns = e.addOns.filter((a) => a.enabled);
  if (enabledAddOns.length) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Add-Ons", 40, y);
    y += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    enabledAddOns.forEach((a) => {
      doc.text(`• ${a.label}`, 40, y);
      doc.text(fmt(a.price), 470, y, { align: "right" });
      y += 16;
    });
    y += 8;
  }

  doc.setDrawColor(220);
  doc.line(40, y, W - 40, y);
  y += 22;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Estimated Range", 40, y);
  doc.text(`${fmt(e.baseLow)} – ${fmt(e.baseHigh)}`, 470, y, { align: "right" });
  y += 22;
  doc.setFontSize(16);
  doc.text("Total Estimate", 40, y);
  doc.setTextColor(8, 145, 178);
  doc.text(fmt(e.total), 470, y, { align: "right" });

  y += 50;
  doc.setTextColor(20, 20, 20);
  doc.setFontSize(9);
  doc.setFont("helvetica", "italic");
  doc.text(
    "This is a preliminary estimate based on remote assessment. Final pricing subject to on-site inspection. Valid for 30 days.",
    40, y, { maxWidth: 530 }
  );

  y += 60;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.line(40, y, 280, y);
  doc.line(320, y, 560, y);
  doc.text("Customer Signature", 40, y + 14);
  doc.text("Date", 320, y + 14);

  doc.save(`RoofAI_Estimate_${e.id}.pdf`);
}

export function buildSummaryText(e: Estimate): string {
  const enabled = e.addOns.filter((a) => a.enabled);
  return [
    `RoofAI Estimate — ${new Date(e.createdAt).toLocaleDateString()}`,
    `Property: ${e.address.formatted}`,
    `Roof Size: ${e.assumptions.sqft.toLocaleString()} sq ft`,
    `Pitch: ${e.assumptions.pitch}`,
    `Material: ${MATERIAL_RATES[e.assumptions.material].label}`,
    `Estimated Age: ${e.assumptions.ageYears} years`,
    enabled.length ? `Add-Ons: ${enabled.map((a) => a.label).join(", ")}` : "Add-Ons: none",
    `Estimated Range: ${fmt(e.baseLow)} – ${fmt(e.baseHigh)}`,
    `Total: ${fmt(e.total)}`,
    "",
    "Prepared by " + (e.staff || "RoofAI Team"),
  ].join("\n");
}
