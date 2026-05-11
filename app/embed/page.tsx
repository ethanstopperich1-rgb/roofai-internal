"use client";

/**
 * /embed — iframeable lead-capture widget.
 *
 * Visually IDENTICAL to /quote's bolt-style hero (same blue rays, same
 * announcement chip, same italicized accent headline, same card form, same
 * autocomplete dropdown). Just rendered in `embedMode` so it:
 *   - drops min-h-screen (host iframe controls its own height)
 *   - hides the Voxaris top-bar (logo / nav / free-chip — third-party
 *     site already has its own header)
 *   - swaps the 3-column trust pill row for a single "Powered by Voxaris
 *     Pitch" footer line
 *
 * Brand customization via URL params:
 *   ?brand=noland       — lead source attribution
 *   ?accent=ff6b35      — hex (no #) overriding cyan accent on CTA + headline
 *   ?headline=...       — override H1 prefix ("Get your" instead of "What
 *                         will it cost to")
 *   ?accent_text=...    — override the italicized accent words ("Noland
 *                         Roofing quote")
 *   ?sub=...            — override subheadline
 *   ?phone=true|false   — phone field reserved for future toggling (the
 *                         shared form keeps phone always-on for now)
 *
 * postMessage events to host page:
 *   { type: "voxaris-pitch:resize", height, brand }
 *     auto-fires from a ResizeObserver — embed.js sizes the iframe.
 *   { type: "voxaris-pitch:lead-submitted", brand, leadId, address }
 *     fires once on successful POST so the host can run a conversion pixel.
 */

import React, { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { BotIdClient } from "botid/client";
import { BoltStyleHero, type QuoteHeroFormValues } from "@/components/ui/bolt-style-chat";

function EmbedWidget() {
  const params = useSearchParams();
  const brand = (params.get("brand") ?? "default").slice(0, 32);
  const accentHex = (params.get("accent") ?? "").replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
  const accent = accentHex ? `#${accentHex}` : "#67dcff";
  const accentParam = accentHex ? accent : undefined;

  const headline = params.get("headline") || "What will it cost to";
  const accentText = params.get("accent_text") || "roof your house";
  const sub = params.get("sub") || "Free, instant, no calls until you ask.";
  const announcement =
    params.get("announce") ||
    (brand === "default" ? "Voxaris Pitch · Quick Quote" : `${prettyBrand(brand)} · Quick Quote`);

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ leadId: string; name: string; email: string } | null>(null);
  const [error, setError] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-resize the host iframe via postMessage. Companion embed.js
  // listens for `voxaris-pitch:resize` and sets iframe.style.height.
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

  const onSubmit = async (values: QuoteHeroFormValues) => {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: values.name,
          email: values.email,
          phone: values.phone,
          address: values.address,
          zip: values.zip,
          lat: values.lat,
          lng: values.lng,
          source: `embed-${brand}`,
        }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      setSubmitted({ leadId: data.leadId, name: values.name, email: values.email });
      if (typeof window !== "undefined" && window.parent !== window) {
        window.parent.postMessage(
          {
            type: "voxaris-pitch:lead-submitted",
            brand,
            leadId: data.leadId,
            address: values.address,
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

  // Submitted state — keep the same bolt rays + announcement + headline,
  // just swap the form card for a confirmation card so it still feels
  // like the same product.
  if (submitted) {
    return (
      <div ref={containerRef} className="w-full">
        <SuccessCard
          accent={accent}
          name={submitted.name}
          email={submitted.email}
          leadId={submitted.leadId}
        />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full">
      {/* BotID — even more important on /embed than on /quote because
          the widget runs on third-party sites and is the more obvious
          target for scrapers / spam scripts. */}
      <BotIdClient protect={[{ path: "/api/leads", method: "POST" }]} />
      <BoltStyleHero
        title={headline}
        titleAccent={accentText}
        subtitle={sub}
        announcementText={announcement}
        onSubmit={onSubmit}
        submitting={submitting}
        embedMode
        accentHex={accentParam}
      />
      {error && (
        <div className="text-center text-[12.5px] text-red-300 -mt-4 pb-4">{error}</div>
      )}
    </div>
  );
}

/* ─── Success card — keeps the bolt rays so the post-submit state still
   reads as the same product. */
function SuccessCard({
  accent,
  name,
  email,
  leadId,
}: {
  accent: string;
  name: string;
  email: string;
  leadId: string;
}) {
  return (
    <div className="relative w-full overflow-hidden py-12 sm:py-16">
      {/* Reuse the same RayBackground via a CSS gradient — keeps the
          embedded RayBackground component out of the success state to
          avoid double-rendering the heavy concentric rings. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at center 30%, rgba(20,136,252,0.35) 0%, rgba(20,136,252,0.08) 25%, #0a0e16 60%)",
        }}
      />
      <div className="relative z-10 max-w-md mx-auto px-6 text-center">
        <div
          className="w-14 h-14 mx-auto rounded-full flex items-center justify-center mb-5"
          style={{ background: accent, color: "#051019" }}
        >
          <ShieldCheck size={26} strokeWidth={2.5} />
        </div>
        <h2 className="font-display text-[24px] sm:text-[28px] leading-[1.1] tracking-tight font-semibold text-white">
          Got it — your estimate is on the way
        </h2>
        <p className="text-[14px] text-slate-300 mt-3 leading-relaxed">
          We&apos;ll reach out to{" "}
          <span className="text-white font-medium">{name}</span> at{" "}
          <span className="font-mono text-[13px] text-slate-100">{email}</span> within 1
          business hour with your range. No spam, no obligation.
        </p>
        <div className="mt-5 text-[10.5px] font-mono uppercase tracking-[0.18em] text-slate-500">
          ref · {leadId}
        </div>
      </div>
    </div>
  );
}

/** "noland" → "Noland", "earl-johnston" → "Earl Johnston". Used in the
 *  default announcement chip when a brand slug is passed but no explicit
 *  ?announce override is set. */
function prettyBrand(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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
