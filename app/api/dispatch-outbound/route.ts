/**
 * POST /api/dispatch-outbound
 *
 * Internal route. Triggers an OUTBOUND call from Sydney to a customer
 * immediately after they submit the /quote wizard. This is the demo's
 * killer move: customer fills the form, their phone rings within seconds
 * with Sydney on the line, ready to qualify by name and book the
 * inspection. The call's start/end events flow through /api/agent/events
 * and land on /dashboard/calls in real time.
 *
 * Flow:
 *   1. Caller (POST /api/leads) validates BotID + TCPA + creates the
 *      Supabase lead row, then forwards the lead context here.
 *   2. We create a unique LiveKit room.
 *   3. AgentDispatchClient.createDispatch sends Sydney into that room
 *      with the lead context encoded as JSON in job metadata.
 *   4. SipClient.createSipParticipant places an outbound SIP call to
 *      the customer's phone via the Twilio outbound trunk. When they
 *      answer, the SIP leg joins the same room.
 *   5. Sydney reads ctx.job.metadata, knows the caller's name + address
 *      + estimate, opens with a personalized greeting.
 *
 * Auth: this is INTERNAL — gated by x-dispatch-secret header matching
 * INTERNAL_DISPATCH_SECRET. Prevents random scripts hitting this endpoint
 * with crafted phone numbers to make Sydney dial arbitrary destinations.
 * Same shape as /api/agent/events (HMAC-secret-gated).
 *
 * Costs:
 *   - LiveKit Telephony egress (SIP outbound minutes)
 *   - Twilio outbound trunk minutes
 *   - LiveKit Cloud Inference (LLM/STT/TTS for Sydney during the call)
 * Rate-limited at the bucket level so a hostile /api/leads spammer can't
 * burn $$$ by triggering dispatches; /api/leads itself is BotID-guarded
 * which is the primary defense layer.
 */

import { NextResponse } from "next/server";
import { AgentDispatchClient, SipClient } from "livekit-server-sdk";
import { rateLimit } from "@/lib/ratelimit";

interface DispatchPayload {
  leadId: string;
  name: string;
  phone: string; // E.164 (+1...)
  address: string;
  estimateLow?: number;
  estimateHigh?: number;
  estimatedSqft?: number;
  material?: string;
  office?: string;
  agentName?: string; // optional override; defaults to "sydney"
}

const LIVEKIT_URL = process.env.LIVEKIT_URL ?? "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? "";
const SIP_OUTBOUND_TRUNK_ID = process.env.SIP_OUTBOUND_TRUNK_ID ?? "";

function configured(): boolean {
  return Boolean(
    LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET && SIP_OUTBOUND_TRUNK_ID,
  );
}

function isE164(s: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(s.trim());
}

export async function POST(req: Request) {
  // Standard rate-limit bucket — agent dispatch is "expensive" enough
  // to deserve protection but not "expensive" tier (which is for AI
  // pipelines billed per token).
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;

  // Same-origin gate via shared secret. /api/leads sets this header
  // when forwarding a lead for outbound dispatch.
  const expected = process.env.INTERNAL_DISPATCH_SECRET;
  if (!expected) {
    console.error("[dispatch-outbound] INTERNAL_DISPATCH_SECRET not set");
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }
  const provided = req.headers.get("x-dispatch-secret") ?? "";
  if (provided !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!configured()) {
    return NextResponse.json(
      { error: "livekit_not_configured" },
      { status: 503 },
    );
  }

  let body: DispatchPayload;
  try {
    body = (await req.json()) as DispatchPayload;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.leadId || !body.phone || !body.name || !body.address) {
    return NextResponse.json(
      { error: "missing_fields", required: ["leadId", "phone", "name", "address"] },
      { status: 400 },
    );
  }

  if (!isE164(body.phone)) {
    return NextResponse.json(
      { error: "invalid_phone", message: "phone must be E.164 (+1...)" },
      { status: 400 },
    );
  }

  const agentName = body.agentName ?? "sydney";
  const safeLeadId = body.leadId.replace(/[^a-z0-9_-]/gi, "").slice(0, 48);
  const roomName = `outbound-${safeLeadId}-${Date.now()}`;

  // Lead context — Sydney's agent reads this from ctx.job.metadata and
  // switches into outbound mode (personalized opener, knows the
  // estimate, references the address by name).
  const leadContext = {
    mode: "outbound" as const,
    leadId: body.leadId,
    name: body.name,
    phone: body.phone,
    address: body.address,
    estimateLow: body.estimateLow ?? null,
    estimateHigh: body.estimateHigh ?? null,
    estimatedSqft: body.estimatedSqft ?? null,
    material: body.material ?? null,
    office: body.office ?? "voxaris",
  };
  const metadata = JSON.stringify(leadContext);

  try {
    // 1. Dispatch Sydney into the room with the lead context.
    //    The agent will be queued by LiveKit and join when the room
    //    materializes.
    const dispatchClient = new AgentDispatchClient(
      LIVEKIT_URL,
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
    );
    const dispatch = await dispatchClient.createDispatch(roomName, agentName, {
      metadata,
    });
    console.log("[dispatch-outbound] agent dispatched", {
      leadId: body.leadId,
      room_name: roomName,
      agent_name: agentName,
      dispatch_id: dispatch?.id ?? null,
    });

    // 2. Place the SIP outbound call to the customer's phone — OR skip
    //    this when the agent worker is configured to place the call
    //    itself.
    //
    // SIP_PLACED_BY_AGENT=true means Sydney's worker handles the SIP
    // participant creation inside its entrypoint (canonical LiveKit
    // outbound pattern — matches Andie and /telephony/making-calls/
    // outbound-calls/). The worker calls create_sip_participant with
    // wait_until_answered=True, so the customer answer is synchronized
    // with the agent being ready in the room. Previously placing the
    // SIP leg here caused a race: cold worker → SIP leg connects →
    // customer answers into an empty room.
    //
    // Default (flag unset/false): legacy behavior — this route places
    // the SIP leg. Safe to leave on during deploys: the worker only
    // creates a SIP participant when SYDNEY_PLACE_SIP_IN_AGENT=true on
    // the worker side. Both flags off = legacy. Both flags on = double
    // dial (don't do this). Worker-side on + API-side off = canonical.
    //
    // DIAGNOSTIC MODE: in legacy path, set SIP_WAIT_UNTIL_ANSWERED=true
    // to make createSipParticipant BLOCK until the customer picks up so
    // failures surface in logs instead of disappearing.
    const sipPlacedByAgent =
      (process.env.SIP_PLACED_BY_AGENT ?? "").toLowerCase() === "true";

    if (sipPlacedByAgent) {
      console.log("[dispatch-outbound] SIP placement delegated to agent", {
        leadId: body.leadId,
        room_name: roomName,
      });
      return NextResponse.json({
        status: "dispatched",
        room_name: roomName,
        agent_name: agentName,
        dispatch_id: dispatch?.id ?? null,
        sip_placed_by: "agent",
      });
    }

    const sipClient = new SipClient(
      LIVEKIT_URL,
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
    );
    const waitUntilAnswered =
      (process.env.SIP_WAIT_UNTIL_ANSWERED ?? "").toLowerCase() === "true";
    const sipParticipant = await sipClient.createSipParticipant(
      SIP_OUTBOUND_TRUNK_ID,
      body.phone,
      roomName,
      {
        participantIdentity: `customer-${safeLeadId}`,
        participantName: body.name,
        waitUntilAnswered,
      },
    );
    console.log("[dispatch-outbound] sip participant created", {
      leadId: body.leadId,
      room_name: roomName,
      wait_until_answered: waitUntilAnswered,
      // Whatever SipClient returns — usually includes participantId,
      // participantIdentity, sipCallId, callStatus. Logged so the
      // operator can correlate against LiveKit Cloud's SIP call view.
      sip_participant: sipParticipant ?? null,
    });

    return NextResponse.json({
      status: "dispatched",
      room_name: roomName,
      agent_name: agentName,
      dispatch_id: dispatch?.id ?? null,
      sip_participant_id: (sipParticipant as { participantId?: string } | null)?.participantId ?? null,
      sip_call_id: (sipParticipant as { sipCallId?: string } | null)?.sipCallId ?? null,
      sip_placed_by: "api",
    });
  } catch (err) {
    // TwirpError carries metadata.sip_status_code / .twirp_message which
    // tells us whether Twilio rejected, the trunk doesn't exist, the
    // destination was unreachable, etc. Log it ALL so operators don't
    // have to guess.
    const e = err as {
      message?: string;
      code?: string;
      metadata?: Record<string, unknown>;
      status?: number;
    };
    console.error("[dispatch-outbound] FAILED", {
      leadId: body.leadId,
      room_name: roomName,
      message: e?.message,
      code: e?.code,
      metadata: e?.metadata,
      status: e?.status,
    });
    return NextResponse.json(
      {
        error: "dispatch_failed",
        message: e?.message ?? String(err),
        sip_status_code: (e?.metadata as { sip_status_code?: string })?.sip_status_code ?? null,
      },
      { status: 500 },
    );
  }
}
