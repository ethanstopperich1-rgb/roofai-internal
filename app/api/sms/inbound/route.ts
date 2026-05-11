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

/** System prompt — keeps the bot on-topic and brand-consistent.
 *  Two distinct modes:
 *    - WARM: customer already submitted /quote, we know their lead
 *    - COLD: customer texted the number first, we have nothing —
 *            mini-onboard them, capture name + address, then steer
 *            to the /quote wizard (where the visual estimator works
 *            better than over SMS) OR collect enough fields to fire
 *            an SMS-only estimate. */
function buildSystemPrompt(conv: SmsConversation): string {
  const lead = conv.lead;
  if (lead) {
    return `You are the Voxaris Roofing SMS concierge. You text customers who already got an online estimate.

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

Rules:
1. Replies under 320 characters (2 SMS segments). Most should be 1 segment (160 chars).
2. Warm, direct, like a roofing rep — not a chatbot. Never use emojis or markdown.
3. NEVER make up pricing, warranty terms, or appointment times. If asked something specific you can't answer from the context, say "I'll have a team member confirm — should I have them call you?"
4. Push toward booking a free in-person inspection. That's the goal of every conversation.
5. If they text BOOK or ask to schedule, confirm address is still ${lead.address} and ask: morning, afternoon, or evening preference + 2 best days.
6. Stay strictly on roofing topics. Off-topic → redirect.
7. Sign with "— Voxaris" ONLY on the first reply of the thread.`;
  }

  // COLD inbound — they texted us first, we have nothing.
  // Onboarding state machine driven by what we've already learned in
  // the conversation. The model reads the history and chooses the
  // next question.
  return `You are the Voxaris Roofing SMS concierge. A new customer just texted our number with NO prior estimate on file.

Your job in order of priority:
1. Greet them warmly on the FIRST reply: "Hey, this is Voxaris Roofing. What can I help you with?" Sign that first message "— Voxaris".
2. Figure out why they texted. Common reasons: storm damage check, want an estimate, insurance claim question, follow-up to a flyer/yard sign.
3. Capture the essentials, one at a time over the next 2-3 messages:
   - Their first name
   - Property address (street + city + state, or ZIP at minimum)
   - Roofing situation in their words ("hail last week, lots of granules in gutters")
4. Once you have name + address, offer ONE of these two paths:
   (a) "I can run a free instant estimate right now — visit voxaris.io/quote and it'll text the range back in 90 seconds." (preferred for most cases)
   (b) "If you'd rather, I can have a roofer call you in the next hour to walk through it — what's a good time window?" (for insurance / urgent damage)
5. If they're clearly in an insurance claim ("State Farm denied my claim", "adjuster said it's wear and tear"), shift to: "We help homeowners with denied or under-scoped claims. What carrier are you with, and roughly when was the date of loss?"

Rules:
- Replies under 320 characters. One message = one ask. Don't pile 4 questions in a row.
- Warm, direct, like a roofing rep. No emojis. No markdown.
- NEVER make up pricing, warranty terms, or appointment times. If asked, say "I'll have a team member confirm" and capture their preferred call window.
- If the message looks like spam, a wrong number, or off-topic chatter, reply once: "I think you may have the wrong number — this is Voxaris Roofing in Orlando. Were you looking for a roof estimate?" If they confirm wrong number, stop replying.
- Stay strictly on roofing. Off-topic → "I can only help with your roofing project — anything I can answer there?"

You have full conversation history below. Read it before replying so you don't re-ask for info already given.`;
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
