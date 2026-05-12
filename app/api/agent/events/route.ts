/**
 * Sydney (and future voice agents) event sink.
 *
 * Sydney's Python worker posts here on:
 *   - call_started   when the SIP leg lands and the agent room opens
 *   - tool_fired     for transfer_to_human / book_inspection / log_lead
 *   - call_ended     on shutdown — includes duration, transcript, cost
 *
 * Auth: HMAC-SHA256 of the request body using `AGENT_EVENTS_SECRET`.
 * Sydney signs every POST with the same secret; we reject anything that
 * doesn't validate. No JWT, no Supabase auth — this endpoint is hit by
 * a backend worker, not a browser.
 *
 * Multi-tenancy: every Sydney instance is configured with a specific
 * `agent_name` (e.g. "sydney" for Noland's, "sydney-clermont" for the
 * Clermont office). We resolve agent_name → office_id via the offices
 * table's `livekit_agent_name` column. Any agent_name we don't recognize
 * gets dropped silently so a hostile / misconfigured caller can't write
 * to the wrong office.
 *
 * Idempotency: each event carries a `room_name` (unique per LiveKit
 * call). We use it to upsert the calls row — call_started inserts,
 * subsequent events update. tool_fired events go to the events table
 * (multiple rows per call OK).
 */

import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { rateLimit } from "@/lib/ratelimit";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 30;

interface CallStartedEvent {
  type: "call_started";
  agent_name: string;
  room_name: string;
  started_at: string; // ISO
  caller_number?: string | null;
}

interface ToolFiredEvent {
  type: "tool_fired";
  agent_name: string;
  room_name: string;
  tool: string;
  // Redacted summary — Sydney already strips PII before posting.
  // Hashes + lengths + structural metadata. See agents/sydney/tools.py.
  summary: Record<string, unknown>;
  at: string; // ISO
}

interface CallEndedEvent {
  type: "call_ended";
  agent_name: string;
  room_name: string;
  ended_at: string; // ISO
  duration_sec: number;
  turn_count: number;
  outcome?:
    | "booked"
    | "transferred"
    | "logged_lead"
    | "no_show"
    | "wrong_number"
    | "cap_duration"
    | "cap_turns"
    | "unknown";
  transcript?: string | null;
  summary?: string | null;
  llm_prompt_tokens?: number;
  llm_completion_tokens?: number;
  tts_chars?: number;
  stt_secs?: number;
  estimated_cost_usd?: number;
}

type AgentEvent = CallStartedEvent | ToolFiredEvent | CallEndedEvent;

/**
 * Validate HMAC-SHA256 signature over the raw request body. The
 * X-Agent-Signature header carries `sha256=<hex>`. Constant-time
 * comparison.
 */
function validateSignature(opts: {
  body: string;
  signature: string | null;
  secret: string;
}): boolean {
  if (!opts.signature) return false;
  const [scheme, given] = opts.signature.split("=", 2);
  if (scheme !== "sha256" || !given) return false;
  const expected = createHmac("sha256", opts.secret)
    .update(opts.body)
    .digest("hex");
  if (expected.length !== given.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(given, "hex"));
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  // Sydney can emit several tool_fired rows per call; "expensive" (10/min
  // per IP) was starving legitimate workers behind a shared egress NAT.
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;

  if (!supabaseServiceRoleConfigured()) {
    // Endpoint exists but DB isn't wired up yet — silently 202 so the
    // agent's retry logic doesn't spam.
    return NextResponse.json({ status: "no-db" }, { status: 202 });
  }

  const secret = process.env.AGENT_EVENTS_SECRET;
  if (!secret) {
    console.error("[agent-events] AGENT_EVENTS_SECRET not set — refusing all events");
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  // Read raw body BEFORE parsing so HMAC validates against the exact
  // bytes the agent signed.
  const raw = await req.text();
  const sig = req.headers.get("x-agent-signature");
  if (!validateSignature({ body: raw, signature: sig, secret })) {
    console.warn("[agent-events] invalid signature");
    return NextResponse.json({ error: "invalid_signature" }, { status: 403 });
  }

  let event: AgentEvent;
  try {
    event = JSON.parse(raw) as AgentEvent;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!event.type || !event.agent_name || !event.room_name) {
    return NextResponse.json({ error: "missing_required_fields" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  // Resolve agent_name → office_id via the offices table.
  // Cached at the JS module scope — agent_name → office_id is immutable
  // for the life of the deploy, no need to hit the DB for every event.
  const officeId = await resolveOfficeIdByAgentName(event.agent_name);
  if (!officeId) {
    console.warn(`[agent-events] unknown agent_name='${event.agent_name}' — dropping event`);
    // 200 to suppress retries — this is a config issue, not a transient failure.
    return NextResponse.json({ status: "unknown_agent" }, { status: 200 });
  }

  try {
    if (event.type === "call_started") {
      // Upsert by room_name — idempotent against retries.
      const { error } = await supabase
        .from("calls")
        .upsert(
          {
            office_id: officeId,
            agent_name: event.agent_name,
            room_name: event.room_name,
            started_at: event.started_at,
            caller_number: event.caller_number ?? null,
          },
          { onConflict: "room_name" },
        );
      if (error) {
        console.error("[agent-events] call_started upsert failed:", error.message);
        return NextResponse.json({ error: "db_error" }, { status: 500 });
      }
      return NextResponse.json({ status: "ok" });
    }

    if (event.type === "tool_fired") {
      // Resolve call row by room_name to set call_id on the event.
      const { data: call } = await supabase
        .from("calls")
        .select("id")
        .eq("room_name", event.room_name)
        .maybeSingle();
      const { error } = await supabase.from("events").insert({
        office_id: officeId,
        call_id: call?.id ?? null,
        type: `tool_fired:${event.tool}`,
        // Round-trip through JSON.stringify/parse so the Json column
        // type accepts the value — TS sees `Record<string, unknown>`
        // as wider than the Supabase `Json` union, but the runtime
        // shape is identical for any redacted summary we send.
        payload: JSON.parse(JSON.stringify(event.summary)),
        at: event.at,
      });
      if (error) {
        console.error("[agent-events] tool_fired insert failed:", error.message);
        return NextResponse.json({ error: "db_error" }, { status: 500 });
      }
      return NextResponse.json({ status: "ok" });
    }

    if (event.type === "call_ended") {
      const patch = {
        ended_at: event.ended_at,
        duration_sec: event.duration_sec,
        turn_count: event.turn_count,
        outcome: event.outcome ?? "unknown",
        transcript: event.transcript ?? null,
        summary: event.summary ?? null,
        llm_prompt_tokens: event.llm_prompt_tokens ?? null,
        llm_completion_tokens: event.llm_completion_tokens ?? null,
        tts_chars: event.tts_chars ?? null,
        stt_secs: event.stt_secs ?? null,
        estimated_cost_usd: event.estimated_cost_usd ?? null,
      };
      const { data: updatedRows, error: updateErr } = await supabase
        .from("calls")
        .update(patch)
        .eq("room_name", event.room_name)
        .select("id");
      if (updateErr) {
        console.error("[agent-events] call_ended update failed:", updateErr.message);
        return NextResponse.json({ error: "db_error" }, { status: 500 });
      }
      // If call_started was dropped (network, DB error) but call_ended
      // arrived, synthesize a row so the dashboard still has a record.
      if (!updatedRows?.length) {
        const endedMs = Date.parse(event.ended_at);
        const startedGuess =
          Number.isFinite(endedMs) && event.duration_sec >= 0
            ? new Date(endedMs - event.duration_sec * 1000).toISOString()
            : event.ended_at;
        const { error: insertErr } = await supabase.from("calls").insert({
          office_id: officeId,
          agent_name: event.agent_name,
          room_name: event.room_name,
          started_at: startedGuess,
          ...patch,
        });
        if (insertErr) {
          console.error("[agent-events] call_ended insert fallback failed:", insertErr.message);
          return NextResponse.json({ error: "db_error" }, { status: 500 });
        }
      }
      return NextResponse.json({ status: "ok" });
    }

    return NextResponse.json({ error: "unknown_event_type" }, { status: 400 });
  } catch (err) {
    console.error("[agent-events] unexpected:", err);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

/**
 * agent_name → office_id resolver, in-memory cached.
 *
 * Sydney's `agent_name` is set in agents/sydney/agent.py (currently
 * "sydney" → Noland's). When we onboard more clients, each gets a
 * distinct agent_name; offices.livekit_agent_name maps them back to
 * the right office_id.
 */
const AGENT_OFFICE_CACHE = new Map<string, { id: string; fetchedAt: number }>();
const AGENT_TTL_MS = 60 * 60 * 1000; // 1h

async function resolveOfficeIdByAgentName(agentName: string): Promise<string | null> {
  const cached = AGENT_OFFICE_CACHE.get(agentName);
  if (cached && Date.now() - cached.fetchedAt < AGENT_TTL_MS) {
    return cached.id;
  }
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("offices")
    .select("id")
    .eq("livekit_agent_name", agentName)
    .eq("is_active", true)
    .single();
  if (!data) return null;
  AGENT_OFFICE_CACHE.set(agentName, { id: data.id, fetchedAt: Date.now() });
  return data.id;
}
