import { NextResponse } from "next/server";
import { generateText } from "ai";
import {
  sendSms,
  toE164,
  twilioConfigured,
  validateTwilioSignature,
} from "@/lib/twilio";
import {
  appendTurn,
  getConversation,
  type SmsConversation,
} from "@/lib/sms-conversation";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/sms/inbound
 *
 * Twilio webhook for inbound SMS. Configure this URL in the Twilio
 * console (Phone Numbers → Manage → Active Numbers → your number →
 * Messaging → "A MESSAGE COMES IN" → set to:
 *
 *   https://<your-domain>/api/sms/inbound   (HTTP POST)
 *
 * Twilio posts an application/x-www-form-urlencoded body with at least:
 *   - From          E.164 sender
 *   - To            E.164 recipient (our Twilio number)
 *   - Body          message text
 *   - MessageSid    unique Twilio ID
 *
 * Flow:
 *   1. Validate X-Twilio-Signature so random POSTs can't trigger the bot
 *   2. Look up the conversation by phone (includes lead context from
 *      /api/leads if the customer filled out the wizard first)
 *   3. Call Qwen via the Vercel AI Gateway with a tight roofing-only
 *      system prompt + the conversation history
 *   4. Send the reply back via Twilio outbound SMS and append both
 *      turns to the conversation log
 *
 * Cost: ~$0.0003/inbound + ~$0.0008/outbound Twilio (US) + ~$0.0005
 * Qwen call = <$0.002 per customer reply.
 */
export async function POST(req: Request) {
  if (!twilioConfigured()) {
    return new Response("Twilio not configured", { status: 503 });
  }

  // Twilio always posts URL-encoded.
  const raw = await req.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;

  // Validate signature. The URL Twilio signs MUST match exactly — we
  // reconstruct from the request, but if you front this behind a proxy
  // that rewrites the host, set TWILIO_WEBHOOK_URL_OVERRIDE.
  const url =
    process.env.TWILIO_WEBHOOK_URL_OVERRIDE ??
    req.url.replace(/^http:\/\//, "https://");
  const signature = req.headers.get("x-twilio-signature");
  if (!validateTwilioSignature({ url, params, signature })) {
    console.warn("[sms-inbound] invalid Twilio signature");
    return new Response("Forbidden", { status: 403 });
  }

  const from = toE164(params.From);
  const body = (params.Body ?? "").trim();
  if (!from || !body) {
    // Twilio expects a 200 even on no-op so it doesn't retry.
    return new Response("<Response/>", {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }

  // STOP / UNSUBSCRIBE / END / QUIT / CANCEL — Twilio handles these
  // automatically but we still log so we don't try to reply.
  if (/^(stop|stopall|unsubscribe|cancel|end|quit)$/i.test(body)) {
    console.log("[sms-inbound] opt-out received from", from);
    return new Response("<Response/>", {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }

  // Append the inbound user message.
  const conv = await appendTurn({ phone: from, role: "user", body });

  // Generate an AI reply. We respond asynchronously via the Twilio
  // REST API rather than via TwiML <Message> because TwiML responses
  // require we finish within Twilio's webhook timeout (~15s) AND we
  // want to keep the reply pipeline identical to outbound paths
  // initiated from the server (e.g., post-quote confirmation).
  let reply: string;
  try {
    reply = await generateReply(conv);
  } catch (err) {
    console.error("[sms-inbound] reply generation failed:", err);
    reply =
      "Thanks for the message — a Voxaris team member will follow up shortly. (Reply HUMAN to skip the bot.)";
  }

  try {
    await sendSms({ to: from, body: reply });
    await appendTurn({ phone: from, role: "assistant", body: reply });
  } catch (err) {
    console.error("[sms-inbound] outbound send failed:", err);
  }

  // ACK Twilio with empty TwiML so it doesn't queue a duplicate reply.
  return new Response("<Response/>", {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

/** System prompt — keeps the bot on-topic and brand-consistent. */
function buildSystemPrompt(conv: SmsConversation): string {
  const lead = conv.lead;
  const ctx = lead
    ? `
The customer already submitted a roofing estimate request:
  Name: ${lead.name}
  Address: ${lead.address}
  Material chosen: ${lead.material ?? "not specified"}
  Roof size: ${lead.estimatedSqft ? `${lead.estimatedSqft} sqft` : "not measured"}
  Estimate range: ${
    lead.estimateLow && lead.estimateHigh
      ? `$${lead.estimateLow.toLocaleString()} – $${lead.estimateHigh.toLocaleString()}`
      : "pending"
  }
  Add-ons: ${(lead.selectedAddOns ?? []).join(", ") || "none"}
  Submitted: ${lead.submittedAt}
`
    : "";

  return `You are the Voxaris Roofing SMS concierge. You text customers who just got an online roofing estimate.

Rules:
1. Keep replies under 320 characters (2 SMS segments max). Most replies should be 1 segment (160 chars).
2. Be warm, direct, and helpful — like a roofing rep, not a chatbot.
3. NEVER make up pricing, warranty terms, or appointment times. If asked something specific you can't answer from the context, say "I'll have a team member confirm — should I have them call you?"
4. Push toward booking a free in-person inspection. That's the goal of every conversation.
5. Stay strictly on roofing topics. If the customer asks about anything off-topic, redirect: "I can only help with your roofing project — anything I can answer there?"
6. Never use emojis. Never use markdown.
7. Sign-off only on the FIRST message of a thread — "— Voxaris". Don't sign every reply.

Context about this customer:${ctx}

Reply to the customer's latest message naturally, using the conversation history for context.`;
}

async function generateReply(conv: SmsConversation): Promise<string> {
  // Build the message list — last 10 turns is plenty for SMS context.
  const recent = conv.turns.slice(-10);
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const t of recent) {
    if (t.role === "user" || t.role === "assistant") {
      messages.push({ role: t.role, content: t.body });
    }
  }

  const { text } = await generateText({
    // Same Gateway model used by /api/voice-note + /api/supplement
    model: "alibaba/qwen-3-235b",
    system: buildSystemPrompt(conv),
    messages,
    maxOutputTokens: 200,
    temperature: 0.6,
  });
  // Defensive trim — Qwen occasionally over-produces despite max tokens.
  const trimmed = text.trim().slice(0, 320);
  return trimmed;
}
