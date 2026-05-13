/**
 * Rep-focused overview screen. Server Component.
 *
 * Replaces the operator scoreboard when the active user has role='rep'.
 * Where the operator view answers "how is the whole office doing?", this
 * answers "what should I do RIGHT NOW?" — a single column of actionable
 * triage:
 *   1. My-pipeline tiles (open leads, calls this week, my pipeline $,
 *      and won this month).
 *   2. Needs-attention list — leads where the rep should follow up
 *      today (proposal pending, no contact in N days, Sydney booked
 *      an inspection that's not yet logged).
 *   3. My leads list — assigned-to-me only, with the same search +
 *      status filter as the operator leads page.
 *   4. Quick actions — direct path to the rep tool to start a new
 *      estimate.
 *
 * The data sources reuse the same Supabase helpers as the operator
 * pages; the only difference is the `assigned_to = me` filter, which
 * is applied here (and enforced server-side via RLS once 0008 lands).
 */
import Link from "next/link";
import { Phone, MapPin, ChevronRight, Plus, AlertCircle } from "lucide-react";
import {
  fmtDateTime,
  fmtUSD,
  statusStyle,
  type Lead,
} from "@/lib/dashboard";

interface RepMetrics {
  openLeads: number;
  pipelineLow: number;
  pipelineHigh: number;
  callsThisWeek: number;
  wonThisMonth: number;
}

interface AttentionItem {
  leadId: string;
  publicId: string;
  name: string;
  address: string;
  reason: string;
  reasonTone: "amber" | "rose" | "cy";
  at: string;
}

export interface RepOverviewProps {
  fullName: string;
  metrics: RepMetrics;
  myLeads: Lead[];
  attention: AttentionItem[];
  /** "/demo" on the public demo surface, "/dashboard" for the real
   *  staff dashboard. Drives sub-page link prefixes so demo visitors
   *  don't get bounced to the protected /dashboard/* routes (which
   *  prompt HTTP Basic auth). */
  basePath: string;
  /** Hides the "New estimate" CTA on /demo — demo visitors are
   *  prospects, not reps with an account; the button would link to
   *  the protected rep-tool at "/" and trigger an auth prompt. */
  isDemo: boolean;
}

export default function RepOverview({
  fullName,
  metrics,
  myLeads,
  attention,
  basePath,
  isDemo,
}: RepOverviewProps) {
  const pipelineMid =
    metrics.pipelineLow === 0 && metrics.pipelineHigh === 0
      ? null
      : Math.round((metrics.pipelineLow + metrics.pipelineHigh) / 2);
  const pipelineDisplay =
    pipelineMid === null
      ? "—"
      : pipelineMid >= 1_000_000
        ? `$${(pipelineMid / 1_000_000).toFixed(2)}M`
        : `$${Math.round(pipelineMid / 1000)}K`;
  const firstName = fullName?.split(/\s+/)[0] ?? "rep";

  return (
    <div className="flex flex-col gap-6 lg:gap-7">
      {/* HEADER */}
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
        <div>
          <span className="glass-eyebrow">My Console · {monthLabel()}</span>
          <h1 className="text-[28px] sm:text-[34px] lg:text-[40px] tracking-[-0.025em] font-semibold leading-[1.04] mt-3 text-white/95">
            <span className="iridescent-text">{firstName}</span>{" "}
            <span className="text-white/40 font-medium">/ today</span>
          </h1>
        </div>
        {!isDemo && (
          <Link
            href="/"
            className="glass-button-primary"
            aria-label="Open the rep estimator"
          >
            <Plus className="w-4 h-4" />
            New estimate
          </Link>
        )}
      </header>

      {/* MY SCOREBOARD */}
      <div className="scoreboard" role="group" aria-label="Rep metrics">
        <div className="scoreboard-tile">
          <div className="label">Open leads</div>
          <div className="value">{metrics.openLeads.toLocaleString()}</div>
          <div className="sublabel">assigned to me</div>
        </div>
        <div className="scoreboard-tile">
          <div className="label">Calls · week</div>
          <div className="value">{metrics.callsThisWeek.toLocaleString()}</div>
          <div className="sublabel">Sydney + outbound</div>
        </div>
        <div className="scoreboard-tile accent-amber">
          <div className="label">My pipeline</div>
          <div className="value">{pipelineDisplay}</div>
          <div className="sublabel">
            {pipelineMid === null
              ? "no open estimates"
              : `range ${fmtUSD(metrics.pipelineLow, 0)} – ${fmtUSD(
                  metrics.pipelineHigh,
                  0,
                )}`}
          </div>
        </div>
        <div className="scoreboard-tile accent-mint">
          <div className="label">Won · MTD</div>
          <div className="value">{metrics.wonThisMonth.toLocaleString()}</div>
          <div className="sublabel">contracts signed</div>
        </div>
      </div>

      {/* NEEDS ATTENTION */}
      <div className="console-section-rule">
        <span className="pulse" aria-hidden="true" />
        <span>Needs attention · today</span>
      </div>
      <div className="glass-panel overflow-hidden">
        {attention.length === 0 ? (
          <div className="px-5 py-7 text-center text-[13px] text-white/55">
            Inbox zero. Nothing requires immediate follow-up — pull up your full lead list
            below or start a fresh estimate.
          </div>
        ) : (
          <ul className="flex flex-col">
            {attention.map((item) => (
              <li key={item.leadId}>
                <Link
                  href={`${basePath}/leads?focus=${encodeURIComponent(item.publicId)}`}
                  className="flex items-start gap-3 px-4 py-3 border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.03] focus:bg-white/[0.05] focus:outline-none transition-colors"
                >
                  <AlertCircle
                    className={[
                      "w-3.5 h-3.5 mt-0.5 flex-shrink-0",
                      item.reasonTone === "rose"
                        ? "text-rose-300"
                        : item.reasonTone === "amber"
                          ? "text-amber"
                          : "text-cy-300",
                    ].join(" ")}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-white/92 font-medium truncate">
                      {item.name}
                      <span className="text-white/40 mx-1.5">·</span>
                      <span className="text-[12px] text-white/65 font-normal">
                        {item.reason}
                      </span>
                    </div>
                    <div className="text-[11.5px] text-white/45 truncate mt-0.5 font-mono tabular">
                      {item.address}
                    </div>
                  </div>
                  <div className="text-[10.5px] text-white/35 font-mono tabular whitespace-nowrap pt-0.5">
                    {fmtDateTime(item.at)}
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-white/30 mt-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* MY LEADS — compact list, not the full table */}
      <div className="console-section-rule">
        <span className="pulse" aria-hidden="true" />
        <span>My leads · {myLeads.length} active</span>
      </div>
      {myLeads.length === 0 ? (
        <div className="glass-panel px-5 py-8 text-center text-[13px] text-white/55">
          No leads assigned to you yet. New leads will land here as soon as Sydney books
          an inspection or a customer requests a quote.
        </div>
      ) : (
        <div className="glass-panel overflow-hidden">
          <ul className="flex flex-col">
            {myLeads.slice(0, 12).map((l) => {
              const ss = statusStyle(l.status);
              const range =
                l.estimate_low != null && l.estimate_high != null
                  ? `${fmtUSD(l.estimate_low, 0)}–${fmtUSD(l.estimate_high, 0)}`
                  : "—";
              return (
                <li key={l.id}>
                  <Link
                    href={`${basePath}/leads?focus=${encodeURIComponent(l.public_id)}`}
                    className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-4 py-3 border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.03] focus:bg-white/[0.05] focus:outline-none transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] text-white/92 font-medium truncate">
                        {l.name}
                      </div>
                      <div className="text-[11px] text-white/50 font-mono tabular truncate mt-0.5 flex items-center gap-2">
                        <MapPin className="w-3 h-3 inline opacity-60" />
                        {l.address}
                        {l.phone && (
                          <>
                            <span className="text-white/20">·</span>
                            <Phone className="w-3 h-3 inline opacity-60" />
                            {l.phone}
                          </>
                        )}
                      </div>
                    </div>
                    <div className="text-right font-mono tabular text-[12px] text-white/85 whitespace-nowrap">
                      {range}
                    </div>
                    <span className={`text-[10.5px] px-2 py-0.5 rounded-full border ${ss.className} font-mono tabular`}>
                      {ss.label}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {myLeads.length > 12 && (
            <Link
              href={`${basePath}/leads`}
              className="block px-4 py-3 text-[11.5px] font-mono tabular text-cy-300 uppercase tracking-[0.16em] border-t border-white/[0.05] hover:bg-white/[0.03] transition-colors text-center"
            >
              View all {myLeads.length} of my leads →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function monthLabel(): string {
  return new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
