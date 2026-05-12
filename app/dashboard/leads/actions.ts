"use server";

import { revalidatePath } from "next/cache";
import {
  DASHBOARD_OFFICE_SLUG,
  LEAD_STATUSES,
  getDashboardOfficeId,
  getDashboardSupabase,
  type LeadStatus,
} from "@/lib/dashboard";

/**
 * Inline status mutator wired to the Leads table.
 *
 * Office scoping is enforced via the WHERE clause — `office_id` is
 * resolved server-side from the hardcoded `voxaris` slug. The follow-up
 * Supabase Auth PR will replace this with a JWT-aware query and rely on
 * RLS for the office filter instead. // TODO: swap to current_office_id()
 * once Supabase Auth lands.
 */
export async function updateLeadStatus(leadId: string, status: string): Promise<{ ok: boolean; error?: string }> {
  if (!LEAD_STATUSES.includes(status as LeadStatus)) {
    return { ok: false, error: "Invalid status" };
  }
  const supabase = await getDashboardSupabase();
  const officeId = await getDashboardOfficeId();
  if (!supabase || !officeId) {
    return { ok: false, error: "Supabase not configured" };
  }
  const { error } = await supabase
    .from("leads")
    .update({ status })
    .eq("id", leadId)
    .eq("office_id", officeId);
  if (error) {
    console.error("[dashboard/leads] update status failed", { slug: DASHBOARD_OFFICE_SLUG, leadId, error: error.message });
    return { ok: false, error: error.message };
  }
  revalidatePath("/dashboard/leads");
  revalidatePath("/dashboard");
  return { ok: true };
}
