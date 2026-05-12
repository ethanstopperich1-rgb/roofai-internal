import { Settings as SettingsIcon } from "lucide-react";
import {
  DASHBOARD_OFFICE_SLUG,
  getDashboardOfficeId,
  getDashboardSupabase,
  type Office,
} from "@/lib/dashboard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function loadOffice(): Promise<Office | null> {
  const officeId = await getDashboardOfficeId();
  const supabase = getDashboardSupabase();
  if (!officeId || !supabase) return null;
  const { data } = await supabase.from("offices").select("*").eq("id", officeId).single();
  return data ?? null;
}

export default async function SettingsPage() {
  const office = await loadOffice();

  return (
    <div className="flex flex-col gap-6">
      <header>
        <div className="glass-eyebrow mb-2 inline-flex">Office · Settings</div>
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
          <span className="iridescent-text">Configuration</span>
        </h1>
        <p className="text-sm text-white/60 mt-1.5">
          Read-only this phase. Editable after Supabase Auth lands and admin role checks are wired.
        </p>
      </header>

      {!office ? (
        <div className="glass-panel p-10 flex flex-col items-center text-center gap-3">
          <SettingsIcon className="w-8 h-8 text-cy-300" />
          <div className="text-lg font-semibold tracking-tight">Office not found</div>
          <p className="text-sm text-white/60 max-w-md">
            Could not resolve office <span className="font-mono">{DASHBOARD_OFFICE_SLUG}</span> in
            Supabase. Verify the office seed exists and service-role env vars are configured.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card label="Office name" value={office.name} />
          <Card label="Slug" value={office.slug} mono />
          <Card label="State" value={office.state ?? "—"} />
          <Card
            label="Brand color"
            value={office.brand_color ?? "—"}
            mono
            swatch={office.brand_color ?? undefined}
          />
          <Card label="Twilio number" value={office.twilio_number ?? "—"} mono />
          <Card label="Inbound number" value={office.inbound_number ?? "—"} mono />
          <Card label="LiveKit agent" value={office.livekit_agent_name ?? "—"} mono />
          <Card label="Status" value={office.is_active ? "Active" : "Disabled"} />
        </div>
      )}

      <aside className="glass-panel p-5 text-[12px] text-white/55 leading-relaxed">
        <span className="text-white/75 font-medium">Note · </span>
        Editable after Supabase Auth lands. The migration will scope all writes to admin users and
        replace this page&apos;s service-role read with a JWT-aware server client. Until then this
        view is intentionally read-only.
      </aside>
    </div>
  );
}

function Card({
  label,
  value,
  mono,
  swatch,
}: {
  label: string;
  value: string;
  mono?: boolean;
  swatch?: string;
}) {
  return (
    <div className="glass-panel p-4">
      <div className="text-[10.5px] uppercase tracking-wider text-white/45">{label}</div>
      <div className="mt-2 flex items-center gap-2">
        {swatch && (
          <span
            className="inline-block w-4 h-4 rounded-md border border-white/20"
            style={{ backgroundColor: swatch }}
          />
        )}
        <div className={["text-sm text-white/90 break-words", mono ? "font-mono tabular" : ""].join(" ")}>
          {value}
        </div>
      </div>
    </div>
  );
}
