/**
 * Pure formatters + style helpers for the /dashboard/* tree.
 *
 * Lives in its own file so client components can import them without
 * dragging `next/headers` (the server-only auth helpers live in
 * lib/dashboard.ts and would break a client bundle).
 *
 * Symbols re-exported from lib/dashboard.ts for legacy callers, so
 * the rest of the dashboard code keeps working without changes.
 */

import type { Database } from "@/types/supabase";

export type Lead = Database["public"]["Tables"]["leads"]["Row"];
export type Call = Database["public"]["Tables"]["calls"]["Row"];
export type Event = Database["public"]["Tables"]["events"]["Row"];
export type Proposal = Database["public"]["Tables"]["proposals"]["Row"];
export type Office = Database["public"]["Tables"]["offices"]["Row"];

/** $0.14 — always two decimals, $ prefix, hyphen-minus for null. */
export function fmtUSD(value: number | null | undefined, fractionDigits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

/** "3m 24s" / "47s" / "—" */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

/** Pretty timestamp for dashboard tables. Local time, short month form. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

/** "May 11" — date only. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

/** Outcome → glass-pill class pair. */
export function outcomeStyle(outcome: string | null | undefined): {
  label: string;
  className: string;
} {
  const o = (outcome ?? "").toLowerCase();
  if (o === "booked")
    return { label: "Booked", className: "bg-mint/15 border-mint/40 text-mint" };
  if (o === "transferred" || o === "transferred_to_human")
    return { label: "Transferred", className: "bg-cy-300/15 border-cy-300/40 text-cy-300" };
  if (o === "no_show" || o === "no-show")
    return { label: "No-show", className: "bg-white/[0.06] border-white/15 text-white/65" };
  if (o === "wrong_number")
    return { label: "Wrong number", className: "bg-white/[0.06] border-white/15 text-white/65" };
  if (o.startsWith("cap_"))
    return { label: outcomeLabelize(o), className: "bg-amber/15 border-amber/40 text-amber" };
  if (o === "abandoned")
    return { label: "Abandoned", className: "bg-rose/15 border-rose/40 text-rose-300" };
  if (!o) return { label: "Unknown", className: "bg-white/[0.06] border-white/15 text-white/55" };
  return { label: outcomeLabelize(o), className: "bg-white/[0.06] border-white/15 text-white/65" };
}

function outcomeLabelize(o: string): string {
  return o.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export const LEAD_STATUSES = ["new", "contacted", "quoted", "won", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export function statusStyle(status: string): { label: string; className: string } {
  switch (status) {
    case "new":
      return { label: "New", className: "bg-cy-300/15 border-cy-300/40 text-cy-300" };
    case "contacted":
      return { label: "Contacted", className: "bg-white/[0.06] border-white/15 text-white/75" };
    case "quoted":
      return { label: "Quoted", className: "bg-cy-300/10 border-cy-300/30 text-cy-300/90" };
    case "won":
      return { label: "Won", className: "bg-mint/15 border-mint/40 text-mint" };
    case "lost":
      return { label: "Lost", className: "bg-rose/15 border-rose/40 text-rose-300" };
    default:
      return { label: status, className: "bg-white/[0.06] border-white/15 text-white/55" };
  }
}

/** Inclusive ISO timestamp for "N days ago". */
export function daysAgoISO(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Start of current month (UTC) as ISO. */
export function monthStartISO(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/** Map the internal `leads.source` string into a human-readable label
 *  for the dashboard. Internal strings (e.g. "quote-wizard-step-1",
 *  "embed-acme", "sydney_inbound") leak directly from the capture
 *  endpoints — fine as analytics keys but confusing on the rep table.
 *  Unknown values get a graceful title-case fallback so a future
 *  source string doesn't show up as raw kebab-case. */
export function fmtLeadSource(raw: string | null | undefined): string {
  if (!raw) return "—";
  // Embedded widget on a partner site — preserve the brand suffix if any
  if (raw.startsWith("embed-")) {
    const brand = raw.slice("embed-".length).trim();
    if (!brand || brand === "default") return "Embed widget";
    return `Embed · ${titleCase(brand)}`;
  }
  const map: Record<string, string> = {
    "quote-wizard-step-1": "Web · address entry",
    "quote-wizard-confirmed": "Web · confirmed quote",
    "quote_form": "Web · quote form",
    "embed": "Embed widget",
    "sydney_inbound": "Sydney · inbound call",
    "sydney_outbound": "Sydney · outbound call",
  };
  if (map[raw]) return map[raw];
  return titleCase(raw);
}
function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
