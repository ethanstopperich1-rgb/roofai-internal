/**
 * GET /api/proposals/[publicId] — anonymous-readable proposal lookup.
 *
 * The customer's /p/[id] page fetches this — they have no Supabase
 * session, so RLS isn't an option for this read. We use the service-
 * role client server-side and gate by public_id (an opaque random
 * string the rep had to share). This intentionally lets anyone with
 * the link read; the threat model is "links shared deliberately."
 *
 * We never expose office_id, lead_id (UUIDs), or any other PII outside
 * the snapshot itself — the API returns ONLY what the customer needs
 * to render their proposal page.
 */

import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  // Anonymous customers open /p/[id] from shared networks — use the
  // standard bucket (60/min per IP) instead of `public` (5/min), which
  // caused false 429s on office Wi‑Fi and family devices.
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;

  if (!supabaseServiceRoleConfigured()) {
    // Caller (the /p/[id] page) falls back to localStorage when this
    // returns 503, preserving the existing flow during phased rollout.
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const { publicId } = await params;
  if (!publicId || publicId.length < 4) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("proposals")
    .select("snapshot, total_low, total_high, created_at")
    .eq("public_id", publicId)
    .maybeSingle();

  if (error) {
    console.error("[proposals/get] db error:", error.message);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Return the snapshot directly. The /p/[id] client parses it as
  // an Estimate; the schema matches what saveEstimate / getEstimate
  // store in localStorage.
  return NextResponse.json({
    estimate: data.snapshot,
    totalLow: data.total_low,
    totalHigh: data.total_high,
    createdAt: data.created_at,
  });
}
