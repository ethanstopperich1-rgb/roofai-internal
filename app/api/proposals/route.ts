/**
 * POST /api/proposals — persist a generated estimate so the customer
 * can open the /p/[id] share link from ANY device.
 *
 * Today the rep tool also stores the estimate in localStorage as a
 * fallback (useful for offline + when Supabase isn't configured), but
 * the share link only works cross-device when this endpoint succeeds.
 *
 * Auth: this is called from the rep tool at /, which is staff-only via
 * `middleware.ts`. We use the service-role client because the staff
 * user doesn't have a Supabase Auth JWT yet (auth migration is a later
 * PR). office_id is hardcoded to the seed Voxaris office during this
 * transition — same TODO as the dashboard pages.
 */

import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import {
  createServiceRoleClient,
  resolveOfficeIdBySlug,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import type { Estimate } from "@/types/estimate";

export const runtime = "nodejs";

interface SaveProposalRequest {
  estimate: Estimate;
  /** Office slug. Defaults to "voxaris" while auth migration is pending.
   *  Once Supabase Auth lands, the office comes from the JWT and this
   *  param goes away. */
  office?: string;
}

export async function POST(req: Request) {
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;

  if (!supabaseServiceRoleConfigured()) {
    return NextResponse.json(
      { error: "not_configured", message: "Supabase env not set." },
      { status: 503 },
    );
  }

  let body: SaveProposalRequest;
  try {
    body = (await req.json()) as SaveProposalRequest;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const estimate = body.estimate;
  if (!estimate || !estimate.id) {
    return NextResponse.json(
      { error: "missing_estimate", message: "Provide estimate with an id." },
      { status: 400 },
    );
  }

  // TODO: swap to office from JWT once Supabase Auth lands. For now the
  // rep tool only operates against the seed Voxaris office.
  const officeSlug = body.office ?? "voxaris";
  const officeId = await resolveOfficeIdBySlug(officeSlug);
  if (!officeId) {
    return NextResponse.json(
      { error: "unknown_office", message: `No active office for '${officeSlug}'.` },
      { status: 400 },
    );
  }

  const supabase = createServiceRoleClient();

  // Try to link to an existing lead by formatted address — when the rep
  // generates a proposal after the customer filled out /quote, the
  // lead already exists with that address. Best-effort match; falls
  // back to null lead_id. (Estimate doesn't carry email directly;
  // address is the only field present on BOTH lead and estimate.)
  let leadId: string | null = null;
  const addr = estimate.address?.formatted;
  if (addr) {
    const { data: lead } = await supabase
      .from("leads")
      .select("id")
      .eq("office_id", officeId)
      .eq("address", addr)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lead) leadId = lead.id;
  }

  // Upsert by public_id so re-saves of the same estimate (rep clicks
  // Save twice) update rather than collide. JSON.parse(JSON.stringify)
  // round-trip widens the snapshot to the Supabase `Json` type — the
  // runtime shape is unchanged; this is purely to satisfy the typegen.
  const { error } = await supabase
    .from("proposals")
    .upsert(
      {
        office_id: officeId,
        lead_id: leadId,
        public_id: estimate.id,
        snapshot: JSON.parse(JSON.stringify(estimate)),
        total_low: estimate.baseLow ?? null,
        total_high: estimate.baseHigh ?? null,
      },
      { onConflict: "public_id" },
    );

  if (error) {
    console.error("[proposals] insert failed:", error.message);
    return NextResponse.json(
      { error: "db_error", message: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    status: "ok",
    publicId: estimate.id,
    shareUrl: `/p/${estimate.id}`,
  });
}
