/**
 * POST /api/canvass/outcome — log an outcome transition for a
 * canvass_target.
 *
 * Two callers:
 *   1. Dashboard rep — authenticated Supabase session, RLS-scoped to
 *      their office.
 *   2. CRM webhook (JobNimbus, ServiceTitan, future) — bearer token
 *      auth, uses service-role client to write across all offices.
 *
 * Phase 2 will add adapter routes at /api/integrations/jobnimbus/
 * webhook that normalize CRM payloads into the body shape this
 * endpoint already accepts. No breaking changes needed here.
 *
 * Body:
 *   canvass_target_id: string (uuid)
 *   outcome:           "contacted" | "quoted" | "won" | "lost" |
 *                      "no_contact" | "disqualified" | "in_progress"
 *   revenue_cents?:    integer (required when outcome='won')
 *   cost_cents?:       integer
 *   lost_reason_category?: enum (see migration 0016)
 *   lost_reason_text?: string
 *   notes?:            string
 *   crm_source?:       string  (defaults to 'manual')
 *   crm_external_id?:  string
 *   occurred_at?:      ISO timestamp (defaults to now())
 */

import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import { getDashboardOfficeId, getDashboardUser } from "@/lib/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_OUTCOMES = new Set([
  "contacted",
  "quoted",
  "won",
  "lost",
  "no_contact",
  "disqualified",
  "in_progress",
]);

const VALID_LOST_CATEGORIES = new Set([
  "not_interested",
  "competitor_won",
  "no_damage",
  "insurance_denied",
  "price_too_high",
  "unreachable",
  "wrong_house",
  "duplicate",
  "other",
]);

interface Body {
  canvass_target_id?: string;
  outcome?: string;
  revenue_cents?: number;
  cost_cents?: number;
  lost_reason_category?: string;
  lost_reason_text?: string;
  notes?: string;
  crm_source?: string;
  crm_external_id?: string;
  occurred_at?: string;
}

export async function POST(req: Request) {
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;

  if (!supabaseServiceRoleConfigured()) {
    return NextResponse.json(
      { error: "supabase_not_configured" },
      { status: 503 },
    );
  }

  // ─── Auth: webhook bearer OR authenticated dashboard user ────────
  const auth = req.headers.get("authorization") ?? "";
  const webhookSecret = process.env.CANVASS_OUTCOME_WEBHOOK_SECRET;
  const isWebhook =
    webhookSecret != null &&
    auth.toLowerCase().startsWith("bearer ") &&
    auth.slice(7).trim() === webhookSecret;

  let scopedOfficeId: string | null = null;
  let userId: string | null = null;

  if (!isWebhook) {
    // Dashboard path — require an authenticated session
    const [officeId, user] = await Promise.all([
      getDashboardOfficeId(),
      getDashboardUser(),
    ]);
    if (!officeId || !user?.id) {
      return NextResponse.json(
        { error: "unauthorized" },
        { status: 401 },
      );
    }
    scopedOfficeId = officeId;
    userId = user.id;
  }

  // ─── Body validation ─────────────────────────────────────────────
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.canvass_target_id || typeof body.canvass_target_id !== "string") {
    return NextResponse.json(
      { error: "canvass_target_id required" },
      { status: 400 },
    );
  }
  if (!body.outcome || !VALID_OUTCOMES.has(body.outcome)) {
    return NextResponse.json(
      { error: "invalid outcome", validOutcomes: [...VALID_OUTCOMES] },
      { status: 400 },
    );
  }
  if (body.outcome === "won") {
    if (
      body.revenue_cents == null ||
      typeof body.revenue_cents !== "number" ||
      body.revenue_cents < 0 ||
      !Number.isInteger(body.revenue_cents)
    ) {
      return NextResponse.json(
        { error: "revenue_cents (positive integer) required when outcome='won'" },
        { status: 400 },
      );
    }
  }
  if (body.outcome === "lost" && body.lost_reason_category) {
    if (!VALID_LOST_CATEGORIES.has(body.lost_reason_category)) {
      return NextResponse.json(
        { error: "invalid lost_reason_category" },
        { status: 400 },
      );
    }
  }

  // ─── DB write ────────────────────────────────────────────────────
  const sb = createServiceRoleClient();

  // Look up the canvass_target to: (a) confirm it exists, (b) get
  // office_id for the insert, (c) for dashboard callers, enforce that
  // the user is writing inside their own office (defense in depth
  // alongside RLS).
  const { data: target, error: targetErr } = await sb
    .from("canvass_targets")
    .select("id, office_id")
    .eq("id", body.canvass_target_id)
    .maybeSingle();
  if (targetErr) {
    return NextResponse.json(
      { error: "lookup_failed", detail: targetErr.message },
      { status: 500 },
    );
  }
  if (!target) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (scopedOfficeId && target.office_id !== scopedOfficeId) {
    return NextResponse.json(
      { error: "cross_office_write_forbidden" },
      { status: 403 },
    );
  }

  // Insert outcome. Trigger sync_canvass_target_outcome handles the
  // denormalized fields on canvass_targets (latest_outcome,
  // latest_outcome_at, status, contacted_at, won_revenue_cents).
  //
  // Casts through `unknown` — migration 0016's canvass_outcomes table
  // post-dates types/supabase.ts and the generated type union doesn't
  // include it yet. Regenerate after 0016 lands in your Supabase
  // project: `npx supabase gen types typescript > types/supabase.ts`
  const insertRes = await (sb as unknown as {
    from: (t: string) => {
      insert: (row: Record<string, unknown>) => {
        select: (cols: string) => {
          single: () => Promise<{
            data: { id: string; outcome: string; occurred_at: string } | null;
            error: { code?: string; message: string } | null;
          }>;
        };
      };
    };
  })
    .from("canvass_outcomes")
    .insert({
      canvass_target_id: target.id,
      office_id: target.office_id,
      outcome: body.outcome,
      revenue_cents: body.revenue_cents ?? null,
      cost_cents: body.cost_cents ?? null,
      lost_reason_category: body.lost_reason_category ?? null,
      lost_reason_text: body.lost_reason_text ?? null,
      notes: body.notes ?? null,
      crm_source: body.crm_source ?? (isWebhook ? "webhook" : "manual"),
      crm_external_id: body.crm_external_id ?? null,
      occurred_at: body.occurred_at ?? new Date().toISOString(),
      logged_by_user_id: userId,
    })
    .select("id, outcome, occurred_at")
    .single();
  const outcomeRow = insertRes.data;
  const insErr = insertRes.error;

  if (insErr) {
    // Dedup conflict on (crm_source, crm_external_id) — treat as
    // idempotent success so webhook retries don't error.
    if (insErr.code === "23505") {
      return NextResponse.json({ ok: true, idempotent: true });
    }
    return NextResponse.json(
      { error: "insert_failed", detail: insErr.message },
      { status: 500 },
    );
  }
  if (!outcomeRow) {
    return NextResponse.json({ error: "insert_no_row" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    outcome_id: outcomeRow.id,
    outcome: outcomeRow.outcome,
    occurred_at: outcomeRow.occurred_at,
  });
}
