/**
 * Per-business /quote entry point. e.g. /quote/nolands, /quote/quality-first.
 *
 * Server Component that resolves the office slug against the live
 * offices table (via service-role since this is a public, unauthenticated
 * surface — same as /api/leads) and renders the existing customer
 * estimator with that office tagged onto every lead capture.
 *
 * Unknown / inactive slugs 404. The /quote root (no [office] segment)
 * stays available as a fallback that defaults to the "voxaris" office
 * — the platform brand — for visitors who land there without a
 * branded link.
 */
import { notFound } from "next/navigation";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import QuotePage from "../page";

export const dynamic = "force-dynamic";

interface BrandedQuoteParams {
  params: Promise<{ office: string }>;
}

async function isActiveOfficeSlug(slug: string): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/i.test(slug)) return false;
  if (!supabaseServiceRoleConfigured()) {
    // In dev without Supabase, accept any well-formed slug so the route
    // is browsable locally. Prod always has the service role configured.
    return true;
  }
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("offices")
    .select("id")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();
  return !!data;
}

export default async function BrandedQuotePage({ params }: BrandedQuoteParams) {
  const { office } = await params;
  const normalized = office.trim().toLowerCase();
  if (!(await isActiveOfficeSlug(normalized))) {
    notFound();
  }
  return <QuotePage office={normalized} />;
}
