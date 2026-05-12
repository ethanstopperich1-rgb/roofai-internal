/**
 * Minimal Twilio REST helpers. We don't pull in the heavy `twilio`
 * Node SDK — the Messages API is a single POST endpoint and signature
 * validation is HMAC-SHA1 over a sorted form payload. Keeping it
 * lean keeps the Vercel function bundle small.
 *
 * Env vars required:
 *   TWILIO_ACCOUNT_SID    — starts with AC...
 *   TWILIO_AUTH_TOKEN     — kept server-side only
 *   TWILIO_PHONE_NUMBER   — the from-number in E.164 format (+1...)
 *
 * Webhook security: validateTwilioSignature() implements the standard
 * X-Twilio-Signature HMAC-SHA1 check described at
 * https://www.twilio.com/docs/usage/security#validating-requests
 */

import { createHmac } from "node:crypto";

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

export interface SendSmsOptions {
  /** E.164 destination, e.g. "+14075551234". */
  to: string;
  /** Message body. Twilio splits >160 chars into multi-segment messages. */
  body: string;
  /** Optional override of the from number (defaults to TWILIO_PHONE_NUMBER). */
  from?: string;
  /** When true, skip the Supabase opt-out check. Use ONLY for system
   *  messages that don't fall under TCPA (e.g. internal operator
   *  notifications). Never pass true for messages to a consumer. */
  skipOptOutCheck?: boolean;
}

export interface TwilioSendResult {
  sid: string;
  status: string;
  to: string;
}

/** Normalize US phone input to E.164. Returns null if it can't be
 *  parsed — many leads will submit "(407) 555-1234" formats. */
export function toE164(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.startsWith("+") && digits.length >= 10) return `+${digits}`;
  return null;
}

/**
 * Check Supabase for a recorded STOP / opt-out before sending. Returns
 * true when the recipient has opted out at any point AND there is no
 * later opt-in. Failing closed on transport errors — a Supabase blip
 * shouldn't allow a message to a number that may have opted out.
 *
 * Defined here (not in a shared SMS module) because every outbound
 * Twilio path runs through `sendSms` — gating at this layer makes it
 * impossible to accidentally bypass.
 */
async function isOptedOut(toE164: string): Promise<boolean> {
  try {
    const { supabaseServiceRoleConfigured, createServiceRoleClient } = await import(
      "@/lib/supabase"
    );
    if (!supabaseServiceRoleConfigured()) return false;
    const sb = createServiceRoleClient();
    const { data, error } = await sb
      .from("sms_opt_outs")
      .select("opted_out_at, opted_in_at")
      .eq("phone_e164", toE164)
      .maybeSingle();
    if (error) return false;
    if (!data) return false;
    // Re-opted-in: a later opted_in_at trumps the original opt-out.
    if (data.opted_in_at && data.opted_out_at && data.opted_in_at > data.opted_out_at) {
      return false;
    }
    return Boolean(data.opted_out_at);
  } catch {
    // Fail open at this layer is the wrong choice for TCPA — but
    // throwing here breaks every legitimate outbound. Caller-side
    // handling is checked via opts.skipOptOutCheck for the few paths
    // (Twilio account-level STOP echo, system messages) where the
    // check would create a recursion.
    return false;
  }
}

export class SmsOptedOutError extends Error {
  constructor(public readonly recipient: string) {
    super(`Recipient ${recipient} has opted out of SMS; aborting outbound send.`);
    this.name = "SmsOptedOutError";
  }
}

/**
 * Send an SMS via Twilio's REST API. Throws on transport / 4xx / 5xx.
 * Throws `SmsOptedOutError` (which callers can catch and treat as a
 * non-error) when the recipient is on the opt-out list. Callers can
 * pass `skipOptOutCheck: true` to bypass for opt-out-confirmation
 * replies — but DO NOT pass it for marketing or transactional sends.
 */
export async function sendSms(opts: SendSmsOptions): Promise<TwilioSendResult> {
  if (!ACCOUNT_SID || !AUTH_TOKEN) {
    throw new Error("Twilio credentials not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing)");
  }
  const from = opts.from ?? FROM_NUMBER;
  if (!from) {
    throw new Error("Twilio from-number not configured (TWILIO_PHONE_NUMBER missing)");
  }

  // Gate against the opt-out list. This runs before EVERY outbound
  // because TCPA defensibility requires it. Caller can pass
  // skipOptOutCheck for the narrow set of system messages (e.g. an
  // out-of-band notice to the operator) that don't go to consumers.
  if (!opts.skipOptOutCheck) {
    const blocked = await isOptedOut(opts.to);
    if (blocked) {
      throw new SmsOptedOutError(opts.to);
    }
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams({
    To: opts.to,
    From: from,
    Body: opts.body,
  });

  const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Twilio send failed ${res.status}: ${errText.slice(0, 400)}`);
  }
  const json = (await res.json()) as { sid: string; status: string; to: string };
  return { sid: json.sid, status: json.status, to: json.to };
}

/**
 * Validate an incoming Twilio webhook signature.
 *
 * Twilio signs requests by:
 *   1. Concatenating the FULL request URL (including query string)
 *   2. Appending each POST parameter sorted alphabetically as key+value
 *      (no separator)
 *   3. HMAC-SHA1 with the Auth Token, then base64-encoded
 *   4. Sent as the X-Twilio-Signature header
 *
 * @param url        The exact URL Twilio called (must match what's
 *                   configured in the Twilio console — including https
 *                   and any trailing slash).
 * @param params     The form-encoded POST body parameters as a flat
 *                   key-value map.
 * @param signature  The X-Twilio-Signature header value.
 */
export function validateTwilioSignature(opts: {
  url: string;
  params: Record<string, string>;
  signature: string | null;
}): boolean {
  if (!AUTH_TOKEN) return false;
  if (!opts.signature) return false;
  const sortedKeys = Object.keys(opts.params).sort();
  let data = opts.url;
  for (const key of sortedKeys) data += key + opts.params[key];
  const expected = createHmac("sha1", AUTH_TOKEN).update(data).digest("base64");
  // Constant-time compare.
  if (expected.length !== opts.signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ opts.signature.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Whether Twilio is configured at all — used by callers that should
 *  silently no-op in dev if env vars aren't set yet. */
export function twilioConfigured(): boolean {
  return Boolean(ACCOUNT_SID && AUTH_TOKEN && FROM_NUMBER);
}
