/**
 * Client-safe copy + helpers for the /dashboard/calls drawer.
 * Explains LiveKit ↔ Twilio Elastic SIP ↔ PSTN and surfaces tool payloads.
 */

import type { Event } from "@/lib/dashboard-format";

/** Shown in the operator console — matches how numbers are wired in prod. */
export const VOICE_PATH_BLURB =
  "Audio to the PSTN is carried as SIP between LiveKit and your Twilio Elastic SIP trunk; Twilio completes the carrier leg. A SIP status on a failed bridge usually means Twilio rejected or could not route the INVITE (trunk ACL, origination URI, termination, or caller-ID / number attachment).";

export function toolFiredEvents(events: Event[]): Event[] {
  return events.filter((e) => e.type.startsWith("tool_fired:"));
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** One-line summary for timeline chips (no raw PII). */
export function summarizeToolEvent(e: Event): string {
  const tool = e.type.replace(/^tool_fired:/, "");
  const p = asRecord(e.payload);
  if (!p) return tool;
  if (tool === "transfer_to_human") {
    const st = p.status;
    const sip = p.sip_status_code;
    const err = p.error;
    const parts = [String(st ?? "unknown")];
    if (sip != null) parts.push(`SIP ${sip}`);
    if (typeof err === "string" && err) parts.push(err);
    return `transfer → ${parts.join(" · ")}`;
  }
  return tool;
}

export function transferDiagnostics(events: Event[]): {
  tool: string;
  at: string;
  payload: Record<string, unknown>;
}[] {
  return toolFiredEvents(events)
    .filter((e) => e.type === "tool_fired:transfer_to_human")
    .map((e) => ({
      tool: "transfer_to_human",
      at: e.at,
      payload: asRecord(e.payload) ?? {},
    }));
}
