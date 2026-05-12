"use server";

/**
 * Admin server actions — onboarding the 18 RSS offices.
 *
 * Two operations:
 *   1. createOffice — provisions an offices row + (optionally) seeds
 *      branding, Twilio number, LiveKit agent name. The slug becomes
 *      the URL identifier used in /api/leads?office=<slug>.
 *   2. inviteUser  — magic-link invite. office_slug travels in user
 *      metadata so handle_new_auth_user() puts them in the right
 *      office on first sign-in.
 *
 * Auth: this file uses the service-role client so it bypasses RLS.
 * We GATE access by checking `public.users.role === 'admin'` for the
 * caller via the cookie-aware server client BEFORE doing anything.
 * Any non-admin caller gets a polite error and nothing happens server-
 * side. The check is intentionally redundant with RLS — RLS handles
 * row-level isolation, but admin-only mutations are app-level policy.
 */

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import {
  createServerClient,
  createServiceRoleClient,
  supabaseConfigured,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";

async function buildCookieAdapter() {
  const cookieStore = await cookies();
  return {
    getAll: () =>
      cookieStore.getAll().map((c) => ({ name: c.name, value: c.value })),
    setAll: () => {},
  };
}

/** Verify the calling user is an admin. Returns null if so; an error
 *  string otherwise. Both checks (env config + admin role) gate the
 *  mutations below. */
async function requireAdmin(): Promise<string | null> {
  if (!supabaseConfigured() || !supabaseServiceRoleConfigured()) {
    return "Supabase isn't configured in this environment.";
  }
  try {
    const supabase = createServerClient(await buildCookieAdapter());
    const { data: userRow } = await supabase
      .from("users")
      .select("role")
      .single();
    if (!userRow || userRow.role !== "admin") {
      return "Admin role required to make these changes.";
    }
    return null;
  } catch {
    return "Auth check failed — make sure you're signed in.";
  }
}

export type AdminActionResult = { ok: true } | { ok: false; error: string };

/**
 * Create a new office. Slug is the URL-safe identifier; name is the
 * display label; state is 2-letter (FL/MN/TX); brand_color is a hex.
 * livekit_agent_name optional — set later when the office's voice
 * agent is provisioned in LiveKit Cloud.
 */
export async function createOffice(formData: FormData): Promise<AdminActionResult> {
  const err = await requireAdmin();
  if (err) return { ok: false, error: err };

  const slugRaw = (formData.get("slug") as string | null)?.trim() ?? "";
  const name = (formData.get("name") as string | null)?.trim() ?? "";
  const state = ((formData.get("state") as string | null) ?? "").trim().slice(0, 2).toUpperCase();
  const brandColor =
    (formData.get("brand_color") as string | null)?.trim() || "#7DD3FC";
  const twilioNumber =
    (formData.get("twilio_number") as string | null)?.trim() || null;
  const inboundNumber =
    (formData.get("inbound_number") as string | null)?.trim() || null;
  const livekitAgentName =
    (formData.get("livekit_agent_name") as string | null)?.trim() || null;

  // Validate slug — lowercase letters / digits / hyphens, 3-32 chars
  if (!/^[a-z0-9-]{3,32}$/.test(slugRaw)) {
    return {
      ok: false,
      error:
        "Slug must be 3-32 chars, lowercase letters / digits / hyphens only.",
    };
  }
  if (!name) return { ok: false, error: "Office name is required." };

  const supabase = createServiceRoleClient();
  const { error: dbErr } = await supabase.from("offices").insert({
    slug: slugRaw,
    name,
    state: state || null,
    brand_color: brandColor,
    twilio_number: twilioNumber,
    inbound_number: inboundNumber,
    livekit_agent_name: livekitAgentName,
    is_active: true,
  });

  if (dbErr) {
    if (dbErr.code === "23505") {
      return { ok: false, error: `Slug "${slugRaw}" is already in use.` };
    }
    return { ok: false, error: dbErr.message };
  }

  revalidatePath("/dashboard/admin");
  return { ok: true };
}

/**
 * Invite a user via magic-link email. office_slug travels in
 * raw_user_meta_data so the handle_new_auth_user() trigger puts them
 * in the right office on first sign-in. role defaults to "rep" (the
 * trigger sets that explicitly).
 */
export async function inviteUser(formData: FormData): Promise<AdminActionResult> {
  const err = await requireAdmin();
  if (err) return { ok: false, error: err };

  const email = ((formData.get("email") as string | null) ?? "").trim().toLowerCase();
  const officeSlug = ((formData.get("office_slug") as string | null) ?? "").trim();

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return { ok: false, error: "Enter a valid email." };
  }
  if (!officeSlug) {
    return { ok: false, error: "Pick the office to invite this user to." };
  }

  const supabase = createServiceRoleClient();

  // Verify the slug exists + is active before sending the invite.
  const { data: office } = await supabase
    .from("offices")
    .select("id, name")
    .eq("slug", officeSlug)
    .eq("is_active", true)
    .maybeSingle();
  if (!office) {
    return { ok: false, error: `No active office for slug "${officeSlug}".` };
  }

  // supabase.auth.admin.inviteUserByEmail sends the magic-link invite.
  // Metadata travels through to auth.users.raw_user_meta_data, which
  // the handle_new_auth_user() trigger reads on first sign-in.
  const { error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(
    email,
    {
      data: {
        office_slug: officeSlug,
        invited_by: "voxaris-admin",
      },
    },
  );

  if (inviteErr) {
    return { ok: false, error: inviteErr.message };
  }

  revalidatePath("/dashboard/admin");
  return { ok: true };
}
