/**
 * POST /api/proposals — persist a generated estimate so the customer
 * can open the /p/[id] share link from ANY device.
 *
 * Today the rep tool also stores the estimate in localStorage as a
 * fallback (useful for offline + when Supabase isn't configured), but
 * the share link only works cross-device when this endpoint succeeds.
 *
 * Auth: POST is gated in `middleware.ts` (HTTP Basic or Supabase session),
 * same as the rep tool at `/`. We still use the service-role client
 * because the staff JWT path is not wired through PostgREST yet.
 * office_id comes from the optional `office` body field (defaults voxaris).
 */

import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import {
  createServiceRoleClient,
  resolveOfficeIdBySlug,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import type { Estimate } from "@/types/estimate";
import type { EstimateV2 } from "@/types/roof";

export const runtime = "nodejs";

interface SaveProposalRequest {
  /** v1 Estimate or v2 EstimateV2 — discriminated at runtime via the
   *  `version` field. Both shapes carry an `id`, `address`, and totals
   *  the route can map onto the proposals row. */
  estimate: Estimate | EstimateV2;
  /** Office slug. Defaults to "voxaris" while auth migration is pending.
   *  Once Supabase Auth lands, the office comes from the JWT and this
   *  param goes away. */
  office?: string;
  /** Optional explicit lead public-id (lead_ + 32hex). When the rep opened
   *  the estimator directly from a lead drawer we'd rather match by id
   *  than guess by address — addresses get reformatted by Maps autocomplete
   *  and the loose match drifts. Falls back to address+email matching when
   *  unset. */
  leadPublicId?: string;
  /** Optional customer email — used as a stronger fallback than address
   *  when the rep changes the formatted address slightly between /quote
   *  and the rep tool. */
  email?: string;
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

  // Tenancy — the rep tool now passes `office` explicitly from its
  // `?office=` query param (and eventually from the rep's Supabase
  // JWT). Validate the slug shape + active-status against the offices
  // table — unknown slugs get rejected so a typo in the URL doesn't
  // silently file the proposal under the wrong business. Defaults
  // to "nolands" — the only live customer today — for callers that
  // haven't been updated to pass `office` yet.
  const officeSlug =
    typeof body.office === "string" && body.office.trim()
      ? body.office.trim().toLowerCase()
      : "nolands";
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/i.test(officeSlug)) {
    return NextResponse.json(
      { error: "invalid_office", message: "office must be a slug like 'nolands'." },
      { status: 400 },
    );
  }
  const officeId = await resolveOfficeIdBySlug(officeSlug);
  if (!officeId) {
    return NextResponse.json(
      {
        error: "unknown_office",
        message: `No active business is registered for the slug '${officeSlug}'.`,
      },
      { status: 400 },
    );
  }

  const supabase = createServiceRoleClient();

  // Link the estimate to a lead. Resolution order — strongest signal first:
  //   1. Explicit lead public_id (rep opened estimator from the lead drawer)
  //   2. Exact address match within the same office
  //   3. Customer email match within the same office (covers cases where
  //      Maps autocomplete rewrites the address between /quote and the
  //      rep tool — most common when the rep retypes the address)
  // Falls back to null lead_id when nothing matches. We never CREATE a
  // lead from this route — that path lives in /api/leads with TCPA gating.
  let leadId: string | null = null;
  const isValidLeadId = (v: unknown): v is string =>
    typeof v === "string" && /^lead_[0-9a-f]{32}$/i.test(v.trim());

  if (isValidLeadId(body.leadPublicId)) {
    const { data: lead } = await supabase
      .from("leads")
      .select("id")
      .eq("office_id", officeId)
      .eq("public_id", body.leadPublicId.trim())
      .maybeSingle();
    if (lead) leadId = lead.id;
  }
  if (!leadId) {
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
  }
  if (!leadId && body.email?.trim()) {
    const emailNorm = body.email.trim().toLowerCase();
    const { data: lead } = await supabase
      .from("leads")
      .select("id")
      .eq("office_id", officeId)
      .eq("email", emailNorm)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lead) leadId = lead.id;
  }

  // Derive totals for the proposals.total_low / total_high columns.
  // v2 snapshots have version: 2 and totals under priced.totalLow /
  // priced.totalHigh. v1 carries baseLow / baseHigh at the top. The
  // columns are integer, so we round.
  let totalLow: number | null = null;
  let totalHigh: number | null = null;
  if ((estimate as EstimateV2).version === 2) {
    const v2 = estimate as EstimateV2;
    if (Number.isFinite(v2.priced?.totalLow)) {
      totalLow = Math.round(v2.priced.totalLow);
    }
    if (Number.isFinite(v2.priced?.totalHigh)) {
      totalHigh = Math.round(v2.priced.totalHigh);
    }
  } else {
    const v1 = estimate as Estimate;
    if (typeof v1.baseLow === "number") totalLow = Math.round(v1.baseLow);
    if (typeof v1.baseHigh === "number") totalHigh = Math.round(v1.baseHigh);
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
        total_low: totalLow,
        total_high: totalHigh,
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
