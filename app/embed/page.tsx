"use client";

/**
 * /embed — iframeable lead-capture widget.
 *
 * Designed to be dropped on any roofing-brand website via a one-line script
 * tag (see public/embed.js). Single-page form (address + name + email +
 * phone) that POSTs to /api/leads with `source: "embed-{brand}"` so each
 * brand's leads are attributable. Auto-resizes its host iframe via
 * postMessage so the host site doesn't have to scroll inside the widget.
 *
 * Brand customization via URL params:
 *   ?brand=noland    — used in lead source attribution + page title
 *   ?accent=67dcff   — hex without #, overrides the cyan CTA color
 *   ?headline=...    — override the H1 (URL-encoded)
 *   ?phone=true      — when "false", drops the phone field for low-friction
 *                      forms (some markets convert better without it)
 */

import React, { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Loader2, MapPin, Search, ShieldCheck } from "lucide-react";

interface Suggestion {
  placeId: string;
  text: string;
}

interface PickedAddress {
  zip?: string;
  lat?: number;
  lng?: number;
}

function EmbedWidget() {
  const params = useSearchParams();
  const brand = (params.get("brand") ?? "default").slice(0, 32);
  const accentHex = (params.get("accent") ?? "67dcff").replace(/[^0-9a-fA-F]/g, "").slice(0, 6) || "67dcff";
  const accent = `#${accentHex}`;
  const headline = params.get("headline") || "Free roof estimate in 30 seconds";
  const subheadline = params.get("sub") || "Satellite-measured. No tape measure visit. No spam calls.";
  const requirePhone = params.get("phone") !== "false";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [picked, setPicked] = useState<PickedAddress | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSugg, setShowSugg] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ leadId: string } | null>(null);
  const [error, setError] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-resize the host iframe via postMessage. The companion embed.js
  // listens for `voxaris-pitch:resize` and resizes the iframe element.
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const h = Math.ceil(entries[0]?.contentRect.height ?? 0);
      if (h > 0 && typeof window !== "undefined" && window.parent !== window) {
        window.parent.postMessage(
          { type: "voxaris-pitch:resize", height: h, brand },
          "*",
        );
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [brand]);

  // Address autocomplete via /api/places/autocomplete (debounced)
  useEffect(() => {
    if (picked || address.length < 4) {
      setSuggestions([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/places/autocomplete?input=${encodeURIComponent(address)}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) return;
        const data = await res.json();
        setSuggestions(
          (data.suggestions ?? []).slice(0, 5).map((s: { placeId: string; text: string }) => ({
            placeId: s.placeId,
            text: s.text,
          })),
        );
      } catch {
        // ignore
      }
    }, 250);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [address, picked]);

  const pickSuggestion = async (s: Suggestion) => {
    setAddress(s.text);
    setShowSugg(false);
    setSuggestions([]);
    try {
      const res = await fetch(`/api/places/details?placeId=${encodeURIComponent(s.placeId)}`);
      if (res.ok) {
        const data = await res.json();
        setPicked({
          zip: data.zip,
          lat: data.location?.latitude,
          lng: data.location?.longitude,
        });
      }
    } catch {
      // ignore — lead still submits with address text only
    }
  };

  const valid =
    name.trim().length > 1 &&
    /\S+@\S+\.\S+/.test(email) &&
    (!requirePhone || phone.replace(/\D/g, "").length >= 7) &&
    address.trim().length > 4;

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          address: address.trim(),
          zip: picked?.zip,
          lat: picked?.lat,
          lng: picked?.lng,
          source: `embed-${brand}`,
        }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      setSubmitted({ leadId: data.leadId });
      // Notify the host page so they can fire their own analytics / conversion
      // pixel ("voxaris-pitch:lead-submitted" event listenable via embed.js).
      if (typeof window !== "undefined" && window.parent !== window) {
        window.parent.postMessage(
          {
            type: "voxaris-pitch:lead-submitted",
            brand,
            leadId: data.leadId,
            address: address.trim(),
          },
          "*",
        );
      }
    } catch (err) {
      setError("Couldn't submit — please try again or call directly.");
      console.warn("[embed] submit failed:", err);
    } finally {
      setSubmitting(false);
    }
  };

  // Submitted state — minimal confirmation, parent site can track via
  // the postMessage and decide what to do next (redirect, open scheduler,
  // etc.). The default in-iframe success state stays simple.
  if (submitted) {
    return (
      <div ref={containerRef} className="w-full p-6 sm:p-10">
        <div
          className="rounded-2xl border p-6 sm:p-8 text-center"
          style={{ borderColor: `${accent}55`, background: `${accent}10` }}
        >
          <div
            className="w-12 h-12 mx-auto rounded-full flex items-center justify-center mb-4"
            style={{ background: accent, color: "#051019" }}
          >
            <ShieldCheck size={22} strokeWidth={2.5} />
          </div>
          <div className="font-display font-semibold text-[20px] text-slate-50 mb-2">
            Got it — your estimate is on the way
          </div>
          <p className="text-[13.5px] text-slate-300 leading-relaxed max-w-md mx-auto">
            We&apos;ll reach out to <span className="text-slate-100 font-medium">{name}</span> at{" "}
            <span className="text-slate-100 font-mono text-[12.5px]">{email}</span> within 1
            business hour with your range. No spam.
          </p>
          <div className="mt-4 text-[10.5px] font-mono uppercase tracking-[0.16em] text-slate-500">
            ref · {submitted.leadId}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full p-6 sm:p-10 max-w-2xl mx-auto">
      {/* Header */}
      <div className="mb-6 sm:mb-8 text-center">
        <h2
          className="font-display text-[22px] sm:text-[28px] leading-[1.1] tracking-tight font-semibold text-slate-50"
        >
          {headline}
        </h2>
        <p className="text-[13px] text-slate-300 mt-2 leading-relaxed max-w-md mx-auto">
          {subheadline}
        </p>
      </div>

      {/* Form */}
      <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 sm:p-5 space-y-3">
        {/* Address with autocomplete */}
        <div className="relative">
          <div className="flex items-center gap-2 px-3 h-12 rounded-xl bg-white/[0.04] border border-white/[0.06] focus-within:border-white/[0.18]">
            <Search size={14} className="text-slate-500 shrink-0" />
            <input
              type="text"
              placeholder="123 Main St, your city, state"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setPicked(null);
                setShowSugg(true);
              }}
              onFocus={() => setShowSugg(true)}
              onBlur={() => setTimeout(() => setShowSugg(false), 150)}
              className="flex-1 bg-transparent border-0 outline-none text-[14px] text-slate-100 placeholder:text-slate-500"
              autoComplete="street-address"
            />
          </div>
          {showSugg && suggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 z-20 rounded-xl border border-white/[0.10] bg-[#0c1118]/95 backdrop-blur-md shadow-2xl overflow-hidden">
              {suggestions.map((s) => (
                <button
                  key={s.placeId}
                  type="button"
                  onMouseDown={() => pickSuggestion(s)}
                  className="w-full text-left px-3 py-2.5 text-[13px] text-slate-200 hover:bg-white/[0.04] flex items-center gap-2"
                >
                  <MapPin size={12} className="text-slate-500 shrink-0" />
                  <span className="truncate">{s.text}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Name + Email + (Phone) */}
        <div className={`grid gap-2 ${requirePhone ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
          <input
            type="text"
            placeholder="Full name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-11 px-3 rounded-xl bg-white/[0.04] border border-white/[0.06] focus:border-white/[0.18] text-[13.5px] text-slate-100 placeholder:text-slate-500 outline-none"
            autoComplete="name"
          />
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-11 px-3 rounded-xl bg-white/[0.04] border border-white/[0.06] focus:border-white/[0.18] text-[13.5px] text-slate-100 placeholder:text-slate-500 outline-none"
            autoComplete="email"
          />
          {requirePhone && (
            <input
              type="tel"
              placeholder="Phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="h-11 px-3 rounded-xl bg-white/[0.04] border border-white/[0.06] focus:border-white/[0.18] text-[13.5px] text-slate-100 placeholder:text-slate-500 outline-none"
              autoComplete="tel"
            />
          )}
        </div>

        {/* CTA */}
        <button
          type="button"
          onClick={submit}
          disabled={!valid || submitting}
          className="w-full h-12 rounded-xl font-medium text-[14px] flex items-center justify-center gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            background: valid && !submitting ? accent : "rgba(255,255,255,0.05)",
            color: valid && !submitting ? "#051019" : "#94a3b8",
            boxShadow: valid && !submitting ? `0 4px 24px -6px ${accent}88` : "none",
          }}
        >
          {submitting ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Pulling your roof from satellite…
            </>
          ) : (
            <>
              Get my free estimate <ArrowRight size={14} />
            </>
          )}
        </button>

        {error && (
          <div className="text-[12px] text-red-300 text-center">{error}</div>
        )}
      </div>

      {/* Trust line */}
      <div className="mt-4 flex items-center justify-center gap-2 text-[10.5px] font-mono uppercase tracking-[0.14em] text-slate-400">
        <ShieldCheck size={11} style={{ color: accent }} />
        <span>No spam · No obligation · We never sell your info</span>
      </div>
    </div>
  );
}

export default function EmbedPage() {
  return (
    <Suspense
      fallback={
        <div className="w-full h-32 flex items-center justify-center text-slate-500 text-[12px]">
          Loading…
        </div>
      }
    >
      <EmbedWidget />
    </Suspense>
  );
}
