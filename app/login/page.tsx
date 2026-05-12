"use client";

/**
 * Login page — magic-link email auth via Supabase.
 *
 * Flow:
 *   1. User enters email, clicks "Send link"
 *   2. We call supabase.auth.signInWithOtp() → Supabase emails a
 *      one-time magic link to the address
 *   3. User clicks the link → /auth/callback handles the code exchange
 *      and redirects to /dashboard (or /, if Basic Auth user lands here)
 *
 * Auth is optional during the transition — the dashboard still
 * works behind HTTP Basic. This page exists to PROVISION users into
 * Supabase Auth so the next phase (cookie-based RLS) has rows to
 * read. The handle_new_auth_user trigger auto-creates a public.users
 * row tied to the Voxaris office on first sign-in.
 *
 * Branded with the Liquid Glass design system. Single-purpose page —
 * no nav, no footer, just the form and a quiet wordmark.
 */

import { useState } from "react";
import { Mail, Loader2, ArrowRight, Check } from "lucide-react";
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
          // Where Supabase redirects after the magic link is clicked.
          // The callback route exchanges the code for a session.
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
    <div className="lg-env min-h-screen flex items-center justify-center px-4 py-12">
      <div className="glass-panel w-full max-w-md p-8 sm:p-10">
        <div className="flex items-center justify-center mb-7">
          <img
            src="/brand/logo-wordmark-alpha.png"
            alt="Voxaris Pitch"
            className="h-10 sm:h-12 w-auto"
          />
        </div>

        <div className="glass-eyebrow mb-4">Staff Sign-in</div>
        <h1 className="font-display text-2xl sm:text-[28px] tracking-tight font-medium leading-tight mb-2">
          Welcome back
        </h1>
        <p className="text-[13.5px] text-slate-400 leading-relaxed mb-6">
          We&apos;ll email you a one-time magic link — no password to remember.
        </p>

        {!configured && (
          <div className="mb-5 rounded-xl border border-amber/40 bg-amber/10 px-4 py-3 text-[12.5px] text-amber leading-relaxed">
            Supabase auth isn&apos;t configured in this environment. Set
            <code className="font-mono"> NEXT_PUBLIC_SUPABASE_URL </code>
            and
            <code className="font-mono"> NEXT_PUBLIC_SUPABASE_ANON_KEY </code>
            in Vercel to enable magic-link login.
          </div>
        )}

        {status === "sent" ? (
          <div className="rounded-xl border border-mint/40 bg-mint/10 px-4 py-5 flex items-start gap-3">
            <Check size={18} className="text-mint mt-0.5 flex-shrink-0" />
            <div>
              <div className="text-[13.5px] text-mint font-medium mb-1">
                Magic link sent
              </div>
              <div className="text-[12.5px] text-slate-300 leading-relaxed">
                Check your inbox for{" "}
                <span className="font-mono">{email.trim()}</span>. Click the
                link to finish signing in. The link expires in 1 hour.
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="text-[11.5px] font-mono uppercase tracking-[0.14em] text-slate-400 mb-1.5 block">
                Work email
              </span>
              <div className="relative">
                <Mail
                  size={15}
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
                />
                <input
                  type="email"
                  className="glass-input pl-10"
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
              style={{ paddingTop: "0.85rem", paddingBottom: "0.85rem" }}
            >
              {status === "sending" ? (
                <>
                  <Loader2 size={15} className="animate-spin" /> Sending…
                </>
              ) : (
                <>
                  Send magic link <ArrowRight size={15} />
                </>
              )}
            </button>

            {status === "error" && errorMsg && (
              <div className="text-[12px] text-rose-300 leading-relaxed">
                {errorMsg}
              </div>
            )}
          </form>
        )}

        <div className="mt-7 pt-5 border-t border-white/[0.06] text-[11px] text-slate-500 leading-relaxed">
          Staff access only. By signing in you agree to the Voxaris Pitch
          terms. Need access?{" "}
          <a href="mailto:hello@voxaris.io" className="text-cy-300 hover:underline">
            Email us.
          </a>
        </div>
      </div>
    </div>
  );
}
