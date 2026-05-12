"use client";

/**
 * Login — Voxaris staff sign-in.
 *
 * visionOS Liquid Glass aesthetic: glass-panel-hero over the aurora
 * environment, iridescent wordmark, clean primary CTA. Single-purpose
 * page (no nav, no footer chrome) so it reads as a destination, not a
 * sub-page.
 *
 * The amber "not configured" banner is intentional — when env vars are
 * missing in a preview env, fail loudly rather than letting the staff
 * member burn time wondering why the magic link never arrived.
 */

import { useState } from "react";
import { Mail, Loader2, ArrowRight, Check, ShieldCheck, Sparkles } from "lucide-react";
import { createBrowserClient, supabaseConfigured } from "@/lib/supabase";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const configured = supabaseConfigured();
  const valid = /^\S+@\S+\.\S+$/.test(email.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || status === "sending") return;
    setStatus("sending");
    setErrorMsg("");
    try {
      const supabase = createBrowserClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo:
            typeof window !== "undefined"
              ? `${window.location.origin}/auth/callback`
              : undefined,
        },
      });
      if (error) {
        setStatus("error");
        setErrorMsg(error.message);
        return;
      }
      setStatus("sent");
    } catch (err) {
      console.error("[login] OTP send failed:", err);
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
    }
  };

  return (
    <div className="lg-env min-h-screen flex flex-col items-center justify-center px-4 py-12 relative">
      {/* Wordmark above the card — gives the page a brand "anchor" */}
      <div className="mb-8 flex flex-col items-center gap-3">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-2xl bg-gradient-to-br from-cy-300/80 to-violet-300/60 flex items-center justify-center shadow-[0_8px_28px_-8px_rgba(125,211,252,0.55)]">
            <Sparkles className="w-4 h-4 text-[#051019]" />
          </div>
          <span className="iridescent-text font-semibold tracking-tight text-[22px]">
            Voxaris AI
          </span>
        </div>
        <div className="glass-eyebrow">Operator Console</div>
      </div>

      {/* The card */}
      <div className="glass-panel-hero w-full max-w-md p-10 sm:p-12 relative">
        <h1 className="font-display text-[28px] sm:text-[32px] tracking-tight font-medium leading-tight mb-2 text-white">
          Welcome back
        </h1>
        <p className="text-[14px] text-white/65 leading-relaxed mb-7">
          We&apos;ll email a one-time magic link to your work address.
          No passwords. Expires in 60 minutes.
        </p>

        {!configured && (
          <div className="mb-6 rounded-2xl border border-amber/30 bg-amber/[0.08] px-4 py-3.5 text-[12.5px] text-amber leading-relaxed backdrop-blur-xl">
            <div className="flex items-center gap-2 font-medium mb-1">
              <ShieldCheck className="w-3.5 h-3.5" />
              Authentication not yet configured
            </div>
            <div className="text-[11.5px] text-amber/80 font-mono leading-relaxed">
              Set NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY in Vercel to enable magic-link sign-in.
            </div>
          </div>
        )}

        {status === "sent" ? (
          <div className="rounded-2xl border border-mint/30 bg-mint/[0.08] px-5 py-5 flex items-start gap-3 backdrop-blur-xl">
            <div className="h-8 w-8 rounded-full bg-mint/20 border border-mint/40 flex items-center justify-center flex-shrink-0">
              <Check size={14} className="text-mint" />
            </div>
            <div>
              <div className="text-[14px] text-mint font-medium mb-1">
                Magic link sent
              </div>
              <div className="text-[12.5px] text-white/70 leading-relaxed">
                Check{" "}
                <span className="font-mono text-white/90">{email.trim()}</span>.
                Click the link from your phone or this device to finish signing in.
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <label className="block">
              <span className="glass-eyebrow mb-2 inline-flex">Work email</span>
              <div className="relative mt-1.5">
                <Mail
                  size={16}
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-cy-300/70 pointer-events-none z-10"
                />
                <input
                  type="email"
                  className="glass-input"
                  style={{ paddingLeft: "2.85rem" }}
                  placeholder="you@voxaris.io"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  autoFocus
                  disabled={!configured || status === "sending"}
                />
              </div>
            </label>

            <button
              type="submit"
              disabled={!valid || !configured || status === "sending"}
              className="glass-button-primary w-full"
              style={{ paddingTop: "0.95rem", paddingBottom: "0.95rem" }}
            >
              {status === "sending" ? (
                <>
                  <Loader2 size={15} className="animate-spin" /> Sending magic link…
                </>
              ) : (
                <>
                  Send magic link <ArrowRight size={15} />
                </>
              )}
            </button>

            {status === "error" && errorMsg && (
              <div className="text-[12px] text-rose-300/90 leading-relaxed bg-rose-500/[0.06] border border-rose-300/20 rounded-xl px-3.5 py-2.5">
                {errorMsg}
              </div>
            )}
          </form>
        )}

        <div className="mt-8 pt-6 border-t border-white/[0.06] flex items-center justify-between text-[11px] text-white/45 leading-relaxed">
          <span className="font-mono tabular tracking-wider uppercase">
            Staff access only
          </span>
          <a
            href="mailto:ethan@voxaris.io"
            className="text-cy-300/90 hover:text-cy-300 transition-colors"
          >
            Need access? →
          </a>
        </div>
      </div>

      {/* Footer status strip — fills bottom whitespace, signals "live system" */}
      <div className="mt-10 flex items-center gap-4 text-[11px] text-white/40 font-mono tabular uppercase tracking-[0.18em]">
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-mint shadow-[0_0_8px_rgba(95,227,176,0.6)] animate-pulse" />
          Systems operational
        </span>
        <span className="text-white/20">·</span>
        <span>pitch.voxaris.io</span>
      </div>
    </div>
  );
}
