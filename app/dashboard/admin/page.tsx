/**
 * /dashboard/admin — Voxaris-level operator panel.
 *
 * Two functions during the RSS rollout:
 *   1. Provision an office row (the 18 RSS offices, each with their
 *      own slug + branding + Twilio + LiveKit agent name)
 *   2. Invite users via magic-link email, scoped to a specific office
 *
 * Only users with role='admin' can land here. Non-admins see a
 * graceful "not authorized" panel. Admin role is set in
 * `public.users` — promote a user via:
 *
 *   update public.users set role = 'admin' where email = 'ethan@...';
 *
 * Future: replace the SQL bump with a UI toggle in /dashboard/admin
 * once we have more than one admin.
 */

import { Building2, UserPlus, ShieldCheck, Mail } from "lucide-react";
import { getDashboardSupabase } from "@/lib/dashboard";
import { CreateOfficeForm, InviteUserForm } from "./forms";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const supabase = await getDashboardSupabase();

  // Auth gate — only admins past this point.
  let isAdmin = false;
  let myEmail: string | null = null;
  if (supabase) {
    const { data: userRow } = await supabase.from("users").select("role, email").maybeSingle();
    if (userRow) {
      isAdmin = userRow.role === "admin";
      myEmail = userRow.email;
    }
  }

  if (!supabase) {
    return (
      <div className="space-y-6">
        <header>
          <div className="glass-eyebrow mb-3">Admin</div>
          <h1 className="font-display text-2xl sm:text-[28px] tracking-tight font-medium">
            Onboarding console
          </h1>
        </header>
        <div className="glass-panel p-6 text-sm text-amber leading-relaxed">
          Supabase isn&apos;t configured in this environment. Set
          <code className="font-mono"> NEXT_PUBLIC_SUPABASE_URL </code>,
          <code className="font-mono"> NEXT_PUBLIC_SUPABASE_ANON_KEY </code>,
          and
          <code className="font-mono"> SUPABASE_SERVICE_ROLE_KEY </code>
          in Vercel to enable admin operations.
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <header>
          <div className="glass-eyebrow mb-3">Admin</div>
          <h1 className="font-display text-2xl sm:text-[28px] tracking-tight font-medium">
            Not authorized
          </h1>
        </header>
        <div className="glass-panel p-6">
          <div className="flex items-start gap-3">
            <ShieldCheck size={20} className="text-amber mt-0.5 flex-shrink-0" />
            <div className="text-sm text-white/80 leading-relaxed">
              The admin console is only available to Voxaris operators with the{" "}
              <code className="font-mono text-amber">admin</code> role.
              {myEmail ? (
                <>
                  {" "}
                  Signed in as{" "}
                  <span className="font-mono text-white/90">{myEmail}</span>.
                </>
              ) : null}
              <div className="mt-3 text-xs text-white/55">
                If you need admin access, email{" "}
                <a className="text-cy-300 hover:underline" href="mailto:hello@voxaris.io">
                  hello@voxaris.io
                </a>
                .
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Load existing offices for the dropdown + the office list.
  const { data: offices } = await supabase
    .from("offices")
    .select("id, slug, name, state, brand_color, is_active, livekit_agent_name, inbound_number, twilio_number")
    .order("created_at", { ascending: true });

  // Load all users so admin can see who's in which office.
  const { data: users } = await supabase
    .from("users")
    .select("id, email, role, office_id, created_at")
    .order("created_at", { ascending: false });

  const officeNameById = new Map(
    (offices ?? []).map((o) => [o.id, o.name] as const),
  );

  return (
    <div className="space-y-7">
      <header>
        <div className="glass-eyebrow mb-3">Admin</div>
        <h1 className="font-display text-2xl sm:text-[28px] tracking-tight font-medium leading-tight">
          Onboarding console
        </h1>
        <p className="text-[13.5px] text-white/55 mt-2 leading-relaxed max-w-prose">
          Create new client offices and invite their staff. Each office gets
          its own slug, branded customer flow, dashboard, and Sydney voice
          agent.
        </p>
      </header>

      <div className="grid lg:grid-cols-2 gap-5">
        <section className="glass-panel p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-cy-300/10 border border-cy-300/30 text-cy-300">
              <Building2 size={16} />
            </div>
            <div>
              <h2 className="font-display text-[17px] font-semibold tracking-tight">
                Create office
              </h2>
              <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/45 -mt-0.5">
                Provision a new RSS client
              </div>
            </div>
          </div>
          <CreateOfficeForm />
        </section>

        <section className="glass-panel p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-mint/10 border border-mint/30 text-mint">
              <UserPlus size={16} />
            </div>
            <div>
              <h2 className="font-display text-[17px] font-semibold tracking-tight">
                Invite user
              </h2>
              <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/45 -mt-0.5">
                Magic-link onboarding
              </div>
            </div>
          </div>
          <InviteUserForm offices={offices ?? []} />
        </section>
      </div>

      <section className="glass-panel p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.06] flex items-center justify-between">
          <h2 className="font-display text-[17px] font-semibold tracking-tight">
            Offices
          </h2>
          <span className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/45">
            {offices?.length ?? 0} total
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-white/45 border-b border-white/[0.04]">
              <tr>
                <th className="text-left px-6 py-3 font-normal">Name</th>
                <th className="text-left px-3 py-3 font-normal">Slug</th>
                <th className="text-left px-3 py-3 font-normal">State</th>
                <th className="text-left px-3 py-3 font-normal">Inbound #</th>
                <th className="text-left px-3 py-3 font-normal">Agent</th>
                <th className="text-left px-6 py-3 font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {(offices ?? []).map((o) => (
                <tr key={o.id} className="border-b border-white/[0.04] last:border-0">
                  <td className="px-6 py-3 text-white/85">
                    <span className="inline-block w-2 h-2 rounded-full mr-2 align-middle" style={{ background: o.brand_color ?? "#7DD3FC" }} />
                    {o.name}
                  </td>
                  <td className="px-3 py-3 font-mono text-white/65">{o.slug}</td>
                  <td className="px-3 py-3 text-white/65">{o.state ?? "—"}</td>
                  <td className="px-3 py-3 font-mono tabular text-white/65">
                    {o.inbound_number ?? "—"}
                  </td>
                  <td className="px-3 py-3 font-mono text-white/65">
                    {o.livekit_agent_name ?? "—"}
                  </td>
                  <td className="px-6 py-3">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-mono uppercase tracking-[0.12em] border ${
                        o.is_active
                          ? "bg-mint/10 border-mint/30 text-mint"
                          : "bg-white/[0.06] border-white/15 text-white/45"
                      }`}
                    >
                      {o.is_active ? "active" : "paused"}
                    </span>
                  </td>
                </tr>
              ))}
              {(offices ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-[13px] text-white/50">
                    No offices yet — create one above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="glass-panel p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.06] flex items-center justify-between">
          <h2 className="font-display text-[17px] font-semibold tracking-tight">
            Users
          </h2>
          <span className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/45">
            {users?.length ?? 0} total
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-white/45 border-b border-white/[0.04]">
              <tr>
                <th className="text-left px-6 py-3 font-normal">Email</th>
                <th className="text-left px-3 py-3 font-normal">Office</th>
                <th className="text-left px-3 py-3 font-normal">Role</th>
                <th className="text-left px-6 py-3 font-normal">Joined</th>
              </tr>
            </thead>
            <tbody>
              {(users ?? []).map((u) => (
                <tr key={u.id} className="border-b border-white/[0.04] last:border-0">
                  <td className="px-6 py-3 font-mono text-white/85 flex items-center gap-2">
                    <Mail size={12} className="text-white/40" />
                    {u.email}
                  </td>
                  <td className="px-3 py-3 text-white/65">
                    {officeNameById.get(u.office_id) ?? "—"}
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-mono uppercase tracking-[0.12em] border ${
                        u.role === "admin"
                          ? "bg-cy-300/15 border-cy-300/40 text-cy-300"
                          : "bg-white/[0.06] border-white/15 text-white/70"
                      }`}
                    >
                      {u.role}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-white/55">
                    {new Date(u.created_at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </td>
                </tr>
              ))}
              {(users ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-[13px] text-white/50">
                    No users yet — invite one above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
