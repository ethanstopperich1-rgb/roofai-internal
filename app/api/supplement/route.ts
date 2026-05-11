import { NextResponse } from "next/server";
import { generateText } from "ai";
import { PDFParse } from "pdf-parse";
import { rateLimit } from "@/lib/ratelimit";
import {
  evaluateSupplementRules,
  type ExtractedLineItem,
  type SupplementContext,
  type SupplementFlag,
} from "@/lib/supplement-rules";
import type { Assumptions } from "@/types/estimate";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/supplement
 *
 * The Supplement Analyzer. A rep uploads a carrier's Xactimate PDF
 * (the initial scope from the adjuster's first inspection), we:
 *   1. Extract text from the PDF
 *   2. Qwen-parse the text into structured line items (description,
 *      quantity, unit, cost, inferred Xactimate code) + claim metadata
 *      (date of loss, carrier name, deductible)
 *   3. Optionally cross-reference MRMS hail data ±14d from the date
 *      of loss (the unique unlock — radar evidence for date
 *      discrepancies or claim-strengthening confirmation)
 *   4. Run the supplement rule catalog against the parsed scope +
 *      property context to surface missing items
 *   5. Return everything as a single response the SupplementAnalyzerPanel
 *      renders as a flagged-items list with copy-paste rationale
 *
 * Why this matters: industry data (Reverend Roofer + Roof Supplement
 * Pros, 2023-2025) shows initial carrier scopes are under-billed by
 * 20-40% on average due to missed O&P, code items, matching law, and
 * decking allowances. Every flagged item the analyzer surfaces is a
 * concrete dollar recovery the rep can fight for. At RSS scale of 16
 * offices × ~200 claims/year × $1,500 avg supplement = ~$4.8M/year in
 * recovered claim value the rep would otherwise leave on the table.
 *
 * Request (multipart/form-data):
 *   pdf            File — the carrier scope (≤ 10 MB)
 *   assumptions    JSON-stringified Assumptions object (the rep's
 *                  current estimate state — pitch, material, age,
 *                  sqft for cross-comparison)
 *   state          2-letter US state code (optional, for state-specific
 *                  rules like FL matching law)
 *   carrier        CarrierKey (optional, for carrier-specific quirks)
 *   propertyLat    optional, lat of property (for MRMS cross-ref)
 *   propertyLng    optional, lng of property
 *
 * Response:
 *   {
 *     extracted: {
 *       lineItems: ExtractedLineItem[],
 *       carrierSubtotal: number | null,
 *       carrierHasOP: boolean,
 *       dateOfLoss: string | null,    // ISO YYYY-MM-DD
 *       carrierName: string | null,
 *       deductible: number | null,
 *     },
 *     mrmsContext: {
 *       eventsNearDateOfLoss: Array<{ date, inches, distanceMiles }>,
 *     } | null,
 *     flags: SupplementFlag[],
 *     stats: {
 *       totalRecommended: number,    // count of fired rules
 *       estimatedDollarsRecovered: number | null,
 *     },
 *     parserSource: "qwen" | "claude-fallback" | "none",
 *   }
 */

interface ExtractedScope {
  lineItems: ExtractedLineItem[];
  carrierSubtotal: number | null;
  carrierHasOP: boolean;
  dateOfLoss: string | null;
  carrierName: string | null;
  deductible: number | null;
}

const EXTRACT_PROMPT = `You are a roofing insurance supplement analyst. The user has pasted
text extracted from a carrier's Xactimate scope PDF (the initial damage
estimate the adjuster sent the homeowner). Parse it into structured
JSON matching this exact schema. Return ONLY the JSON object, no
markdown, no preamble.

Schema:
{
  "lineItems": [
    {
      "description": string,         // raw line text from the scope
      "quantity": number | null,     // SF, LF, EA — leave null if no quantity
      "unit": string | null,         // "SF" "LF" "EA" "SQ" etc.
      "unitCost": number | null,     // dollars per unit
      "extended": number | null,     // line total in dollars
      "xactimateCode": string | null // canonical code if explicit (e.g. "RFG ARCH"), else null
    }
  ],
  "carrierSubtotal": number | null,  // RCV subtotal BEFORE O&P, tax, depreciation
  "carrierHasOP": boolean,           // true if the scope has a separate O&P line (10%+10%, 20%, etc.)
  "dateOfLoss": string | null,       // ISO YYYY-MM-DD
  "carrierName": string | null,      // "State Farm" "Citizens" "Allstate" etc.
  "deductible": number | null        // homeowner's deductible amount
}

Be conservative. If a line is ambiguous, set the field to null rather
than guess. Only count the LINE ITEMS section — skip cover-page boilerplate,
summary blocks, signatures. The schema's "carrierSubtotal" excludes O&P
(if O&P is on a separate line, the subtotal is what it was calculated on).

If the document doesn't look like a roofing scope at all, return:
{"lineItems":[],"carrierSubtotal":null,"carrierHasOP":false,"dateOfLoss":null,"carrierName":null,"deductible":null}`;

async function extractPdfText(buf: Buffer): Promise<string> {
  // pdf-parse@2.x exposes a class-based API. getText() returns an
  // object with per-page `text` plus a combined `text` at top level.
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return (result.text ?? "").trim();
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function parseScopeViaQwen(
  rawText: string,
): Promise<{ scope: ExtractedScope; source: "qwen" | "none" }> {
  if (!rawText || rawText.length < 50) {
    return { scope: emptyScope(), source: "none" };
  }
  // Cap input to ~50k chars (~15k tokens) — Xactimate PDFs longer
  // than that are usually scanned images full of OCR noise; clipping
  // protects us from a runaway token bill.
  const clipped = rawText.slice(0, 50_000);
  try {
    const { text } = await generateText({
      model: "alibaba/qwen-3-235b",
      system: EXTRACT_PROMPT,
      prompt: clipped,
      maxOutputTokens: 4000,
      temperature: 0,
    });
    const parsed = parseJsonStrict(text);
    if (parsed) return { scope: parsed as ExtractedScope, source: "qwen" };
  } catch (err) {
    console.warn("[supplement] qwen parse failed:", err);
  }
  return { scope: emptyScope(), source: "none" };
}

function parseJsonStrict(raw: string): ExtractedScope | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    const obj = JSON.parse(cleaned);
    // Validate shape minimally — bad keys default safely
    return {
      lineItems: Array.isArray(obj.lineItems) ? obj.lineItems : [],
      carrierSubtotal:
        typeof obj.carrierSubtotal === "number" ? obj.carrierSubtotal : null,
      carrierHasOP: !!obj.carrierHasOP,
      dateOfLoss:
        typeof obj.dateOfLoss === "string" ? obj.dateOfLoss : null,
      carrierName:
        typeof obj.carrierName === "string" ? obj.carrierName : null,
      deductible:
        typeof obj.deductible === "number" ? obj.deductible : null,
    };
  } catch {
    return null;
  }
}

function emptyScope(): ExtractedScope {
  return {
    lineItems: [],
    carrierSubtotal: null,
    carrierHasOP: false,
    dateOfLoss: null,
    carrierName: null,
    deductible: null,
  };
}

/** Cross-reference MRMS hail data ±14 days from the date of loss.
 *  Re-uses the existing /api/hail-mrms route so the cache + Blob
 *  storage layer is identical to what the Storm History card uses. */
async function fetchMrmsAroundDate(opts: {
  lat: number;
  lng: number;
  dateOfLoss: string; // ISO
  origin: string;
}): Promise<Array<{ date: string; inches: number; distanceMiles: number }>> {
  try {
    // Compute the date range window — ±14 days, expressed in years
    // back from today (the API only takes yearsBack). yearsBack of 1
    // covers the past 365 days; we filter results client-side to ±14d.
    const dolDate = new Date(opts.dateOfLoss);
    const daysSinceDol = Math.max(
      1,
      Math.ceil(
        (Date.now() - dolDate.getTime()) / (24 * 3600 * 1000),
      ),
    );
    const yearsBack = Math.max(1, Math.ceil((daysSinceDol + 30) / 365));
    const url = `${opts.origin}/api/hail-mrms?lat=${opts.lat}&lng=${opts.lng}&radiusMiles=5&yearsBack=${yearsBack}&minInches=0.5`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return [];
    const data = (await r.json()) as {
      events: Array<{ date: string; maxInches: number; distanceMiles: number }>;
    };
    const dolMs = dolDate.getTime();
    return data.events
      .map((e) => {
        const ed = new Date(
          e.date.length === 8
            ? `${e.date.slice(0, 4)}-${e.date.slice(4, 6)}-${e.date.slice(6, 8)}`
            : e.date,
        );
        const deltaDays = Math.abs(
          (ed.getTime() - dolMs) / (24 * 3600 * 1000),
        );
        return {
          date: e.date,
          inches: e.maxInches,
          distanceMiles: e.distanceMiles,
          deltaDays,
        };
      })
      .filter((e) => e.deltaDays <= 14)
      .sort((a, b) => a.deltaDays - b.deltaDays)
      .slice(0, 5)
      .map(({ date, inches, distanceMiles }) => ({ date, inches, distanceMiles }));
  } catch (err) {
    console.warn("[supplement] mrms cross-ref failed:", err);
    return [];
  }
}

export async function POST(req: Request) {
  const limited = await rateLimit(req, "expensive");
  if (limited) return limited;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "expected multipart/form-data" },
      { status: 400 },
    );
  }

  const pdfFile = form.get("pdf");
  if (!(pdfFile instanceof File)) {
    return NextResponse.json(
      { error: "pdf field required" },
      { status: 400 },
    );
  }
  if (pdfFile.size > 10 * 1024 * 1024) {
    return NextResponse.json(
      { error: "pdf too large (max 10 MB)" },
      { status: 413 },
    );
  }

  // Parse assumptions JSON from the form (rep's current estimate)
  const assumptionsRaw = (form.get("assumptions") as string | null) ?? "{}";
  let assumptions: Assumptions;
  try {
    assumptions = JSON.parse(assumptionsRaw) as Assumptions;
  } catch {
    return NextResponse.json(
      { error: "assumptions must be JSON" },
      { status: 400 },
    );
  }

  const state = (form.get("state") as string | null)?.slice(0, 2).toUpperCase() ?? null;
  const carrier = (form.get("carrier") as string | null) ?? null;
  // County passed in by the rep when known. Used by HVHZ-aware rules
  // (FL Miami-Dade / Broward vs. rest of FL). Optional — supplement
  // rules fall back to advisory/suppress when null.
  const county = (form.get("county") as string | null)?.trim() || null;
  const latStr = form.get("propertyLat") as string | null;
  const lngStr = form.get("propertyLng") as string | null;
  const propertyLat = latStr ? Number(latStr) : null;
  const propertyLng = lngStr ? Number(lngStr) : null;

  // ─── 1. PDF → text ──────────────────────────────────────────────
  let rawText = "";
  try {
    const buf = Buffer.from(await pdfFile.arrayBuffer());
    rawText = await extractPdfText(buf);
  } catch (err) {
    console.warn("[supplement] pdf-parse failed:", err);
    return NextResponse.json(
      { error: "PDF parse failed — is this a text PDF? Scanned/image PDFs aren't supported yet." },
      { status: 422 },
    );
  }

  // ─── 2. Text → structured scope via Qwen ────────────────────────
  const { scope: extracted, source: parserSource } = await parseScopeViaQwen(rawText);

  // ─── 3. Cross-reference MRMS hail data ──────────────────────────
  let mrmsEvents: Array<{ date: string; inches: number; distanceMiles: number }> = [];
  if (extracted.dateOfLoss && propertyLat != null && propertyLng != null) {
    const origin = new URL(req.url).origin;
    mrmsEvents = await fetchMrmsAroundDate({
      lat: propertyLat,
      lng: propertyLng,
      dateOfLoss: extracted.dateOfLoss,
      origin,
    });
  }

  // ─── 4. Run rules ───────────────────────────────────────────────
  const ctx: SupplementContext = {
    assumptions,
    state,
    carrier,
    county,
    carrierLineItems: extracted.lineItems,
    carrierSubtotal: extracted.carrierSubtotal,
    carrierHasOP: extracted.carrierHasOP,
    mrmsHailAroundDateOfLoss: mrmsEvents,
    dateOfLoss: extracted.dateOfLoss,
  };
  const flags = evaluateSupplementRules(ctx);

  // ─── 5. Summary ─────────────────────────────────────────────────
  const dollarTotals = flags
    .map((f) => f.estimatedDollars)
    .filter((d): d is number => typeof d === "number");
  const stats = {
    totalRecommended: flags.length,
    estimatedDollarsRecovered:
      dollarTotals.length > 0
        ? dollarTotals.reduce((s, d) => s + d, 0)
        : null,
  };

  return NextResponse.json({
    extracted,
    mrmsContext: mrmsEvents.length
      ? { eventsNearDateOfLoss: mrmsEvents }
      : null,
    flags: flags satisfies SupplementFlag[],
    stats,
    parserSource,
  });
}
