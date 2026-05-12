/**
 * Server-side helpers shared across the /dashboard/* tree.
 *
 * Office scoping today: every dashboard page hardcodes the `voxaris`
 * office slug and resolves it via the service-role client (RLS-bypass).
 * The follow-up Supabase Auth PR will replace `getDashboardOfficeId()`
 * with a JWT-aware resolution against `current_office_id()` and
 * `createServerClient(cookies)`. The page-level changes are isolated to
 * this module — search "swap to current_office_id()" before the swap.
 */

import {
  createServiceRoleClient,
  resolveOfficeIdBySlug,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import type { Database } from "@/types/supabase";

export type SupabaseService = ReturnType<typeof createServiceRoleClient>;

export type Lead = Database["public"]["Tables"]["leads"]["Row"];
export type Call = Database["public"]["Tables"]["calls"]["Row"];
export type Event = Database["public"]["Tables"]["events"]["Row"];
export type Proposal = Database["public"]["Tables"]["proposals"]["Row"];
export type Office = Database["public"]["Tables"]["offices"]["Row"];

/** Singleton-ish slug for the current phase. TODO: swap to current_office_id()
 *  once Supabase Auth lands and the dashboard reads the user's JWT. */
export const DASHBOARD_OFFICE_SLUG = "voxaris";

/** Resolve office_id for the hardcoded slug, returning null when
 *  Supabase is not configured (preview deploys without env vars). */
export async function getDashboardOfficeId(): Promise<string | null> {
  if (!supabaseServiceRoleConfigured()) return null;
  return resolveOfficeIdBySlug(DASHBOARD_OFFICE_SLUG);
}

/** Service-role client. RLS is bypassed — callers MUST filter by office_id
 *  on every query during this phase. After auth ships this is replaced by
 *  createServerClient + the JWT, and RLS handles isolation. */
export function getDashboardSupabase(): SupabaseService | null {
  if (!supabaseServiceRoleConfigured()) return null;
  return createServiceRoleClient();
}

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

/** Outcome → glass-pill class pair. Maps every known Sydney outcome
 *  plus a few cap_* variants the agent emits today. Unknown values fall
 *  through to the neutral slate styling. */
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

/** Inclusive ISO timestamp for "N days ago". Used for 30-day windows. */
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

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
