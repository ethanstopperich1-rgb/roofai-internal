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

/** One-line summary for timeline chips (no raw PII).
 *
 * Sydney's tool payloads carry only non-PII operational fields (the
 * date / office / lead_type enums); raw name / phone / email / address
 * are SHA-256 hashed before they leave the agent. So everything we
 * surface here is safe to render to the rep dashboard. */
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
  if (tool === "book_inspection") {
    const date = typeof p.date === "string" ? p.date : null;
    const win = typeof p.time_window === "string" ? p.time_window : null;
    const office = typeof p.office === "string" ? p.office : null;
    const service = typeof p.service_type === "string" ? p.service_type : null;
    const parts: string[] = [];
    if (date) parts.push(date);
    if (win) parts.push(win);
    if (service) parts.push(prettifyEnum(service));
    if (office) parts.push(`@ ${prettifyEnum(office)}`);
    return parts.length ? `Booked · ${parts.join(" · ")}` : "Booked inspection";
  }
  if (tool === "log_lead") {
    const kind = typeof p.lead_type === "string" ? p.lead_type : null;
    return kind ? `Lead logged · ${prettifyEnum(kind)}` : "Lead logged";
  }
  if (tool === "check_availability") {
    const office = typeof p.office === "string" ? p.office : null;
    const earliest = typeof p.earliest_date === "string" ? p.earliest_date : null;
    if (office && earliest) return `Checked availability · ${prettifyEnum(office)} from ${earliest}`;
    if (office) return `Checked availability · ${prettifyEnum(office)}`;
    return "Checked availability";
  }
  return tool;
}

function prettifyEnum(raw: string): string {
  return raw
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
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
