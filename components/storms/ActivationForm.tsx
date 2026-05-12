"use client";

import { useState } from "react";
import { ArrowRight, Loader2, Check } from "lucide-react";

/**
 * Lead-capture form for the Storm Intelligence page.
 *
 * Posts to /api/leads with a `source: "storms-page"` tag so the
 * incoming requests are visible in the dashboard as a separate cohort
 * from the homeowner /quote flow. The shape matches what /api/leads
 * already accepts — name, email, phone, address, tcpaConsent.
 *
 * Honesty hooks:
 *   - Submit doesn't promise "we'll activate within X hours."
 *   - Confirmation copy: "We'll review your territory and follow up
 *     within 1 business day to confirm coverage and timeline."
 *   - No SMS/call promised — only an email + manual operator outreach.
 */

interface FormState {
  name: string;
  email: string;
  phone: string;
  company: string;
  territory: string;
  consent: boolean;
}

const INITIAL: FormState = {
  name: "",
  email: "",
  phone: "",
  company: "",
  territory: "",
  consent: false,
};

export default function ActivationForm() {
  const [state, setState] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHint, setShowHint] = useState(false);

  const fieldsValid =
    state.name.trim().length > 1 &&
    /\S+@\S+\.\S+/.test(state.email) &&
    state.phone.replace(/\D/g, "").length >= 7 &&
    state.company.trim().length > 1 &&
    state.territory.trim().length > 1;
  const valid = fieldsValid && state.consent;

  const validationHint = !state.consent && fieldsValid
    ? "Check the consent box to continue."
    : !fieldsValid
      ? "Please complete every field above."
      : null;

  const submit = async () => {
    if (!valid) {
      setShowHint(true);
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: state.name.trim(),
          email: state.email.trim(),
          phone: state.phone.trim(),
          // Storms-page leads use the company name as address-substitute
          // so the route's address-required check passes. Real territory
          // info goes in `notes`.
          address: `${state.company.trim()} · ${state.territory.trim()}`,
          source: "storms-page",
          notes: `Territory of interest: ${state.territory.trim()}. Company: ${state.company.trim()}.`,
          tcpaConsent: true,
          tcpaConsentAt: new Date().toISOString(),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message ?? `submission failed (${res.status})`);
      }
      setSubmitted(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Email hello@voxaris.io and we'll respond directly.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="glass-panel-hero p-8 sm:p-10 max-w-2xl">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-mint/10 border border-mint/30 text-mint mb-5">
          <Check size={20} strokeWidth={2.5} />
        </div>
        <h3 className="font-display text-[26px] sm:text-[32px] font-semibold tracking-tight text-slate-50 mb-3">
          Got it — we&apos;ll be in touch.
        </h3>
        <p className="text-[14.5px] text-slate-300 leading-relaxed max-w-prose">
          Within one business day we&apos;ll review your territory,
          confirm watched-region coverage, and follow up with timeline
          + setup steps. No SMS, no auto-calls — just a real reply
          from a real person.
        </p>
        <p className="text-[12.5px] text-slate-500 mt-4">
          If you don&apos;t hear from us, email{" "}
          <a href="mailto:hello@voxaris.io" className="text-cy-300 hover:underline">
            hello@voxaris.io
          </a>{" "}
          directly.
        </p>
      </div>
    );
  }

  return (
    <div className="glass-panel-hero p-6 sm:p-8 max-w-2xl">
      <div className="grid sm:grid-cols-2 gap-4 sm:gap-5">
        <Field
          label="Your name"
          value={state.name}
          onChange={(v) => setState((s) => ({ ...s, name: v }))}
          placeholder="Jane Smith"
          autoComplete="name"
        />
        <Field
          label="Company"
          value={state.company}
          onChange={(v) => setState((s) => ({ ...s, company: v }))}
          placeholder="Acme Roofing"
          autoComplete="organization"
        />
        <Field
          label="Email"
          type="email"
          value={state.email}
          onChange={(v) => setState((s) => ({ ...s, email: v }))}
          placeholder="you@acmeroofing.com"
          autoComplete="email"
        />
        <Field
          label="Phone"
          type="tel"
          value={state.phone}
          onChange={(v) => setState((s) => ({ ...s, phone: v }))}
          placeholder="(407) 555-0142"
          autoComplete="tel"
        />
      </div>
      <div className="mt-4 sm:mt-5">
        <Field
          label="Territory (cities, counties, or zip range)"
          value={state.territory}
          onChange={(v) => setState((s) => ({ ...s, territory: v }))}
          placeholder="e.g. Orlando + Apopka + Sanford, FL"
        />
      </div>

      <label className="mt-5 flex items-start gap-2.5 cursor-pointer group">
        <input
          type="checkbox"
          checked={state.consent}
          onChange={(e) =>
            setState((s) => ({ ...s, consent: e.target.checked }))
          }
          className="mt-0.5 h-4 w-4 flex-shrink-0 cursor-pointer rounded border border-white/20 bg-white/5 accent-cy-300"
          aria-label="Consent to receive a follow-up about activation"
        />
        <span className="text-[11.5px] leading-[1.55] text-slate-400 group-hover:text-slate-300 transition-colors">
          I agree to receive a follow-up call or email from Voxaris
          about Storm Intelligence activation. No marketing, no
          automated calls. See our{" "}
          <a href="/privacy" target="_blank" rel="noopener noreferrer" className="text-cy-300 hover:underline">
            Privacy Policy
          </a>
          {" "}and{" "}
          <a href="/terms" target="_blank" rel="noopener noreferrer" className="text-cy-300 hover:underline">
            Terms
          </a>
          .
        </span>
      </label>

      {error && (
        <div
          role="alert"
          className="mt-4 px-3 py-2.5 rounded-lg bg-rose/10 border border-rose/30 text-[12.5px] text-rose"
        >
          {error}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between gap-3">
        <span className="text-[11px] font-mono uppercase tracking-[0.14em] text-slate-500 hidden sm:inline">
          One business day · No automated marketing
        </span>
        <button
          onClick={submit}
          disabled={submitting}
          aria-disabled={!valid || submitting}
          className="glass-button-primary inline-flex items-center gap-2 px-5 py-3 text-[14px] disabled:cursor-not-allowed"
        >
          {submitting ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Submitting…
            </>
          ) : (
            <>
              Request activation <ArrowRight size={14} />
            </>
          )}
        </button>
      </div>

      {showHint && validationHint && (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 px-3 py-2.5 rounded-lg bg-amber/[0.08] border border-amber/30 text-[12.5px] text-amber font-medium"
        >
          {validationHint}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  type = "text",
  value,
  onChange,
  placeholder,
  autoComplete,
}: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="label block mb-2">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="glass-input w-full"
      />
    </label>
  );
}
