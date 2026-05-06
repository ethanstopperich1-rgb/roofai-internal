import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

interface LeadPayload {
  name: string;
  email: string;
  phone?: string;
  address: string;
  zip?: string;
  lat?: number;
  lng?: number;
  estimatedSqft?: number;
  material?: string;
  selectedAddOns?: string[];
  estimateLow?: number;
  estimateHigh?: number;
  source?: string;
  notes?: string;
}

/**
 * POST /api/leads
 * Receives a homeowner lead from the public /quote wizard. Persists nothing
 * yet (Phase 2 — Supabase) but always echoes a leadId so the UI can show a
 * confirmation. Optionally posts to LEAD_WEBHOOK_URL for CRM intake.
 */
export async function POST(req: Request) {
  const __rl = await rateLimit(req, "public");
  if (__rl) return __rl;
  let body: LeadPayload;
  try {
    body = (await req.json()) as LeadPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.name?.trim() || !body.email?.trim() || !body.address?.trim()) {
    return NextResponse.json(
      { error: "name, email and address are required" },
      { status: 400 },
    );
  }

  const leadId = `lead_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  const submittedAt = new Date().toISOString();

  // Optional CRM/Slack/Email webhook — keep silent failures on the customer
  // path. We log on the server but never fail the lead capture itself.
  const hookUrl = process.env.LEAD_WEBHOOK_URL;
  if (hookUrl) {
    try {
      await fetch(hookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId, submittedAt, ...body }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      console.error("[leads] webhook failed:", err);
    }
  }

  return NextResponse.json({
    leadId,
    submittedAt,
    message: "Thanks — a Voxaris partner will contact you within 1 business hour.",
  });
}
