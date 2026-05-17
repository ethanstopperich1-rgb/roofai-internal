"use client";

/**
 * Login — Voxaris staff sign-in.
 *
 * Replaces the ugly browser-native HTTP Basic Auth dialog with a styled
 * username + password form. On success, POST /api/auth/staff-login
 * validates against STAFF_AUTH_USER / STAFF_AUTH_PASS and sets an
 * HttpOnly `voxaris-staff` cookie. Middleware reads that cookie and
 * lets the user through to /dashboard (or wherever `?next=` points).
 *
 * Aesthetic: visionOS Liquid Glass — glass-panel-hero on the aurora
 * env. Single-purpose page, no nav or chrome.
 */

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, ArrowRight, Sparkles, Lock, User } from "lucide-react";

function LoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const next = sp?.get("next") || "/dashboard";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  // If the user is already signed in (cookie present), bounce them
  // straight through. Avoids the "login form blinks then redirects"
  // flash on a normal navigation.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (/(?:^|; )voxaris-staff=/.test(document.cookie)) {
      router.replace(next);
    }
  }, [next, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || status === "submitting") return;
    setStatus("submitting");
    setErrorMsg("");
    try {
      const r = await fetch("/api/auth/staff-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        setStatus("error");
        setErrorMsg(
          data.error ?? `Sign-in failed (HTTP ${r.status}). Try again.`,
        );
        return;
      }
      router.replace(next);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Network error");
    }
  };

  return (
    <div className="lg-env min-h-screen flex flex-col items-center justify-center px-4 py-12 relative">
      <div className="mb-8 flex flex-col items-center gap-3">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-2xl bg-gradient-to-br from-cy-300/80 to-violet-300/60 flex items-center justify-center shadow-[0_8px_28px_-8px_rgba(125,211,252,0.55)]">
            <Sparkles className="w-4 h-4 text-[#051019]" />
          </div>
          <span className="iridescent-text font-semibold tracking-tight text-[22px]">
            Voxaris Pitch
          </span>
        </div>
        <div className="glass-eyebrow">Operator Console</div>
      </div>

      <div className="glass-panel-hero w-full max-w-md p-10 sm:p-12 relative">
        <h1 className="font-display text-[28px] sm:text-[32px] tracking-tight font-medium leading-tight mb-2 text-white">
          Welcome back
        </h1>
        <p className="text-[14px] text-white/65 leading-relaxed mb-7">
          Sign in with your Voxaris staff credentials to reach the operator
          dashboard and rep tools.
        </p>

        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="text-[10.5px] uppercase tracking-[0.18em] text-white/45">
              Username
            </span>
            <div className="relative mt-1.5">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
              <input
                type="text"
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-10 pr-3 py-2.5 text-[14px] text-white placeholder:text-white/35 focus:outline-none focus:border-cy-300/60 focus:ring-2 focus:ring-cy-300/20 transition-colors"
                placeholder="voxaris"
              />
            </div>
          </label>

          <label className="block">
            <span className="text-[10.5px] uppercase tracking-[0.18em] text-white/45">
              Password
            </span>
            <div className="relative mt-1.5">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-10 pr-3 py-2.5 text-[14px] text-white placeholder:text-white/35 focus:outline-none focus:border-cy-300/60 focus:ring-2 focus:ring-cy-300/20 transition-colors"
                placeholder="••••••••"
              />
            </div>
          </label>

          {status === "error" && errorMsg ? (
            <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl px-3.5 py-2.5">
              <p className="text-[12.5px] text-rose-300 leading-relaxed">
                {errorMsg}
              </p>
            </div>
          ) : null}

          <button
            type="submit"
            disabled={
              status === "submitting" || !username.trim() || !password
            }
            className="w-full bg-gradient-to-br from-cy-300 to-cy-400 text-[#051019] font-semibold text-[14px] px-5 py-2.5 rounded-xl hover:from-cy-200 hover:to-cy-300 transition-all disabled:from-white/10 disabled:to-white/10 disabled:text-white/40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2 shadow-[0_8px_28px_-8px_rgba(125,211,252,0.45)]"
          >
            {status === "submitting" ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Signing in…
              </>
            ) : (
              <>
                Sign in
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        <p className="text-[11px] text-white/40 mt-6 leading-relaxed">
          Staff credentials only. Customers can reach the public estimator
          at{" "}
          <a
            href="/estimate-v2"
            className="underline text-white/55 hover:text-white"
          >
            /estimate-v2
          </a>
          .
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  // Wrap in Suspense — useSearchParams() requires it at the page level
  // under the App Router's static-prerender behavior.
  return (
    <Suspense fallback={<div className="lg-env min-h-screen" />}>
      <LoginForm />
    </Suspense>
  );
}
