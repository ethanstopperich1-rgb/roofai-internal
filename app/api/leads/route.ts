import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { rateLimit } from "@/lib/ratelimit";
import { checkBotId } from "botid/server";
import { sendSms, toE164, twilioConfigured } from "@/lib/twilio";
import { attachLeadContext } from "@/lib/sms-conversation";
import {
  createServiceRoleClient,
  resolveOfficeIdBySlug,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";

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
  /** Office slug — drives multi-tenant routing in Supabase. Customer
   *  /quote sends this via the embed config / branded subdomain;
   *  defaults to "voxaris" (the seed office). */
  office?: string;
  /** TCPA consent — required. The client form gates the submit button
   *  but a direct POST could bypass it; we enforce server-side too. */
  tcpaConsent?: boolean;
  /** Exact disclosure text shown to the customer at consent time. We
   *  store this verbatim so we can prove what they agreed to if asked
   *  by FTC / a partner contractor in a compliance audit. */
  tcpaConsentText?: string;
  /** When the wizard already created a row (e.g. step-1 capture), pass
   *  the same public_id so the final submit updates instead of inserting
   *  a duplicate. Server requires the same email as the original row. */
  existingLeadPublicId?: string;
}

/** TCPA disclosure text — the exact wording the customer agrees to.
 *  Pin this constant so any change to the consent text is tracked in
 *  git and survives consent audits. If the wording is updated, this
 *  string AND the rendered checkbox copy in
 *  `components/ui/bolt-style-chat.tsx` MUST change together — they're
 *  the same legal disclosure and must remain byte-equivalent for the
 *  audit trail to be defensible. Last updated 2026-05-12 to match the
 *  /privacy + /terms links rolled out in commit d0a0293. */
export const TCPA_CONSENT_TEXT =
  "By submitting this form, you consent to receive automated marketing " +
  "calls, texts, and emails from Voxaris and its partner contractors at " +
  "the phone number and email provided. Consent is not required to make " +
  "a purchase. Message frequency varies; message and data rates may apply. " +
  "Reply STOP to opt out, HELP for help. See our Privacy Policy at " +
  "/privacy and Terms of Service at /terms.";

function isValidExistingLeadPublicId(id: unknown): id is string {
  return typeof id === "string" && /^lead_[0-9a-f]{32}$/i.test(id.trim());
}

/**
 * POST /api/leads
 * Receives a homeowner lead from the public /quote wizard. Persists to
 * Supabase when configured; always echoes a leadId. Optionally posts to
 * LEAD_WEBHOOK_URL for CRM intake.
 */
export async function POST(req: Request) {
  const __rl = await rateLimit(req, "public");
  if (__rl) return __rl;

  // TCPA receipts must capture IP + UA at consent time (FTC guidance &
  // standard TCPA defense playbook). `x-forwarded-for` may be a comma-
  // separated proxy chain; the leftmost value is the client.
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const consentIp =
    xff.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    null;
  const consentUserAgent = req.headers.get("user-agent") || null;

  // Vercel BotID — paired with <BotIdClient> mounted on /quote + /embed.
  // The client widget runs a transparent JS challenge before the form
  // submits; the server side here verifies the signed verdict in the
  // request headers. Bots that bypass the widget (curl, script, etc.)
  // are rejected with 403. Human submissions are sub-50ms transparent.
  // No legit user sees a CAPTCHA.
  const verdict = await checkBotId();
  if ("isBot" in verdict && verdict.isBot && !verdict.isVerifiedBot) {
    return NextResponse.json(
      { error: "Bot detected" },
      { status: 403 },
    );
  }

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

  // TCPA consent enforcement — server-side gate. The client form gates
  // the submit button via React state, but a direct POST could bypass
  // that check. We REQUIRE tcpaConsent === true before any SMS or
  // automated outreach fires for this lead.
  if (body.tcpaConsent !== true) {
    return NextResponse.json(
      {
        error: "tcpa_consent_required",
        message:
          "TCPA consent is required before submitting marketing-eligible " +
          "contact information. Check the consent box and resubmit.",
      },
      { status: 400 },
    );
  }

  const submittedAt = new Date().toISOString();
  const emailNorm = body.email.trim().toLowerCase();
  const officeSlug = body.office ?? "voxaris";

  let leadId = `lead_${crypto.randomUUID().replace(/-/g, "")}`;
  let isLeadUpdate = false;

  if (supabaseServiceRoleConfigured() && isValidExistingLeadPublicId(body.existingLeadPublicId)) {
    const oid = await resolveOfficeIdBySlug(officeSlug);
    if (oid) {
      const sb = createServiceRoleClient();
      const { data: prior } = await sb
        .from("leads")
        .select("id, email, public_id")
        .eq("public_id", body.existingLeadPublicId.trim())
        .eq("office_id", oid)
        .maybeSingle();
      if (prior && prior.email === emailNorm) {
        leadId = prior.public_id;
        isLeadUpdate = true;
      }
    }
  }

  // ─── Supabase persistence ──────────────────────────────────────────
  // Primary destination for the lead. When Supabase env vars aren't
  // set (dev / preview), this silently no-ops and the legacy webhook
  // flow below still fires. office slug → office_id lookup is cached
  // 1h in resolveOfficeIdBySlug.
  if (supabaseServiceRoleConfigured()) {
    try {
      const officeId = await resolveOfficeIdBySlug(officeSlug);
      if (!officeId) {
        console.warn(`[leads] no active office for slug='${officeSlug}'`);
      } else {
        const supabase = createServiceRoleClient();
        const row = {
          name: body.name.trim(),
          email: emailNorm,
          phone: body.phone?.trim() || null,
          address: body.address.trim(),
          zip: body.zip ?? null,
          lat: body.lat ?? null,
          lng: body.lng ?? null,
          estimated_sqft: body.estimatedSqft ?? null,
          material: body.material ?? null,
          selected_add_ons: body.selectedAddOns ?? null,
          estimate_low: body.estimateLow ?? null,
          estimate_high: body.estimateHigh ?? null,
          source: body.source ?? null,
          notes: body.notes ?? null,
          tcpa_consent: true,
          tcpa_consent_at: submittedAt,
          tcpa_consent_text: TCPA_CONSENT_TEXT,
        };

        if (isLeadUpdate) {
          const { error } = await supabase
            .from("leads")
            .update(row)
            .eq("public_id", leadId)
            .eq("office_id", officeId);
          if (error) {
            console.error("[leads] supabase update failed:", error.message);
          }
        } else {
          const { data, error } = await supabase
            .from("leads")
            .insert({
              office_id: officeId,
              public_id: leadId,
              ...row,
            })
            .select("id")
            .single();
          if (error) {
            console.error("[leads] supabase insert failed:", error.message);
          } else if (data) {
            // Audit-trail row in consents — append-only, regulator-grade
            // receipt of what disclosure the customer agreed to.
            await supabase.from("consents").insert({
              office_id: officeId,
              lead_id: data.id,
              // Matches the documented enum in migrations/0001:
              // 'tcpa_marketing' | 'call_recording' | 'sms' | 'email_marketing'.
              consent_type: "tcpa_marketing",
              disclosure_text: TCPA_CONSENT_TEXT,
              email: emailNorm,
              phone: body.phone?.trim() || null,
              ip_address: consentIp,
              user_agent: consentUserAgent,
            });
          }
        }
      }
    } catch (err) {
      console.error("[leads] supabase block threw:", err);
    }
  }

  // Optional CRM/Slack/Email webhook — keep silent failures on the customer
  // path. We log on the server but never fail the lead capture itself.
  const hookUrl = process.env.LEAD_WEBHOOK_URL;
  if (hookUrl) {
    try {
      await fetch(hookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId,
          submittedAt,
          ...body,
          email: emailNorm,
          // Always echo back the verbatim consent text we BELIEVE the
          // customer saw, plus the server-side timestamp. The body's
          // tcpaConsentText is client-supplied and could be spoofed;
          // ours is the canonical receipt.
          tcpaConsent: true,
          tcpaConsentText: TCPA_CONSENT_TEXT,
          tcpaConsentAt: submittedAt,
        }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      console.error("[leads] webhook failed:", err);
    }
  }

  // Audit log — every successful consent gets recorded. Vercel logs are
  // a SECONDARY destination with limited retention + access controls, so
  // we deliberately do NOT write raw PII here. Instead we log:
  //   - leadId (server-issued, opaque)
  //   - submittedAt (server timestamp)
  //   - emailHash + phoneHash (first 12 chars of SHA-256 — enough for
  //     correlation across log lines without leaking the underlying
  //     identifier)
  //   - canonical consent text (constant — for proving what the user saw)
  //
  // The CRM/Slack webhook above (and Supabase persistence when wired)
  // is the PRIMARY destination for raw PII — that path has proper
  // retention + access controls. The webhook payload still carries the
  // full email + phone unchanged.
  const hashFragment = (v: string): string =>
    createHash("sha256").update(v).digest("hex").slice(0, 12);
  console.log(
    JSON.stringify({
      tag: "tcpa-consent",
      leadId,
      submittedAt,
      emailHash: hashFragment(emailNorm),
      phoneHash: body.phone ? hashFragment(body.phone.replace(/\D/g, "")) : null,
      consentText: TCPA_CONSENT_TEXT,
    }),
  );

  // SMS confirmation. Fire-and-forget — Twilio failures must NEVER
  // break the lead capture (the lead is still in the webhook + UI
  // confirmation). We also seed conversation memory so when the
  // customer texts back, the SMS bot already knows their estimate.
  const phoneE164 = toE164(body.phone);
  if (phoneE164 && twilioConfigured() && !isLeadUpdate) {
    const estimateLine =
      body.estimateLow && body.estimateHigh
        ? `Your estimate range: $${body.estimateLow.toLocaleString()}-$${body.estimateHigh.toLocaleString()}. `
        : "";
    const firstName = body.name.split(/\s+/)[0];
    const smsBody = `Hi ${firstName}, this is Voxaris Roofing. We got your estimate request for ${body.address}. ${estimateLine}Reply with any questions or text BOOK to schedule a free inspection. — Voxaris`;

    // Run both writes in parallel and don't await — keep the API
    // response fast.
    void Promise.all([
      sendSms({ to: phoneE164, body: smsBody })
        .then((r) =>
          console.log("[leads] sent confirmation SMS", {
            leadId,
            sid: r.sid,
            status: r.status,
          }),
        )
        .catch((err) =>
          console.error("[leads] SMS send failed:", err),
        ),
      attachLeadContext({
        phone: phoneE164,
        lead: {
          leadId,
          name: body.name,
          email: body.email,
          address: body.address,
          estimateLow: body.estimateLow,
          estimateHigh: body.estimateHigh,
          material: body.material,
          estimatedSqft: body.estimatedSqft,
          selectedAddOns: body.selectedAddOns,
          submittedAt,
        },
      }).catch((err) =>
        console.error("[leads] attachLeadContext failed:", err),
      ),
    ]);
  } else if (phoneE164 && twilioConfigured() && isLeadUpdate) {
    void attachLeadContext({
      phone: phoneE164,
      lead: {
        leadId,
        name: body.name,
        email: body.email,
        address: body.address,
        estimateLow: body.estimateLow,
        estimateHigh: body.estimateHigh,
        material: body.material,
        estimatedSqft: body.estimatedSqft,
        selectedAddOns: body.selectedAddOns,
        submittedAt,
      },
    }).catch((err) =>
      console.error("[leads] attachLeadContext failed:", err),
    );
  }

  // ─── Sydney outbound dispatch ────────────────────────────────────────
  // After the lead is captured, immediately dispatch Sydney to OUTBOUND
  // call the customer's phone. Fire-and-forget — failures don't block
  // the API response. The /api/dispatch-outbound route validates env
  // (LiveKit + SIP trunk), the dispatch secret, and the phone format
  // before any LiveKit call is made.
  if (phoneE164 && process.env.INTERNAL_DISPATCH_SECRET && !isLeadUpdate) {
    const origin = new URL(req.url).origin;
    void fetch(`${origin}/api/dispatch-outbound`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dispatch-secret": process.env.INTERNAL_DISPATCH_SECRET,
      },
      body: JSON.stringify({
        leadId,
        name: body.name,
        phone: phoneE164,
        address: body.address,
        estimateLow: body.estimateLow,
        estimateHigh: body.estimateHigh,
        material: body.material,
        office: body.office ?? "voxaris",
      }),
    })
      .then(async (r) => {
        const text = await r.text().catch(() => "");
        if (!r.ok) {
          console.error("[leads] outbound dispatch non-OK:", r.status, text);
        } else {
          console.log("[leads] outbound dispatched:", { leadId, body: text });
        }
      })
      .catch((err) =>
        console.error("[leads] outbound dispatch failed:", err),
      );
  }

  return NextResponse.json({
    leadId,
    submittedAt,
    message: "Thanks — a Voxaris partner will contact you within 1 business hour.",
  });
}
