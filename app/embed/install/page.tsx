"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import PublicHeader from "@/components/ui/public-header";
import PublicFooter from "@/components/ui/public-footer";

/**
 * /embed/install — public-facing install instructions for the Voxaris Pitch
 * embed widget. Linkable URL we can hand to a roofer's webmaster: "paste
 * these two lines on your site." Renders a live preview iframe alongside the
 * snippet so they can see what they'll get before installing.
 *
 * Page is noindex,nofollow via app/embed/install/layout.tsx — this is
 * docs for contractor webmasters, not a public marketing surface that
 * homeowners should ever land on via Google.
 */
export default function EmbedInstallPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <PublicHeader chip="Install" />
      <main className="flex-1 max-w-4xl mx-auto w-full px-4 sm:px-6 lg:px-10 py-12 sm:py-20 space-y-12">
      <header className="space-y-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-cy-300/90 px-2 py-0.5 rounded-full border border-cy-300/30 bg-cy-300/5">
          embed · v1
        </span>
        <h1 className="font-display text-[32px] sm:text-[44px] leading-[1.05] tracking-tight font-semibold">
          Drop a roof estimator on any website in two lines
        </h1>
        <p className="text-[14.5px] text-slate-400 max-w-2xl leading-relaxed">
          Paste the snippet below into your site&apos;s HTML — typically inside
          the body, where you want the form to appear. The widget loads in an
          iframe, auto-resizes to fit its content, and posts every lead to
          your Pitch dashboard tagged with the brand attribution.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="font-display text-[18px] font-semibold text-slate-100">1 · The snippet</h2>
        <CodeBlock
          code={`<div data-voxaris-pitch
     data-brand="your-brand-slug"
     data-accent="67dcff"></div>
<script src="https://pitch.voxaris.io/embed.js" async></script>`}
        />
        <p className="text-[12.5px] text-slate-400 leading-relaxed">
          Replace <code className="font-mono text-slate-300 bg-white/[0.04] px-1 rounded">your-brand-slug</code> with
          your brand identifier (e.g. <code className="font-mono text-slate-300 bg-white/[0.04] px-1 rounded">noland</code>) so leads
          show up correctly attributed in your dashboard.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-[18px] font-semibold text-slate-100">2 · Live preview</h2>
        <p className="text-[13px] text-slate-400">
          Exactly what your customers will see, rendered in a sandboxed iframe.
        </p>
        <LivePreview />
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-[18px] font-semibold text-slate-100">3 · Customization</h2>
        <p className="text-[13px] text-slate-400">
          Every option is a <code className="font-mono text-slate-300 bg-white/[0.04] px-1 rounded">data-*</code> attribute on the
          placeholder div.
        </p>

        <div className="rounded-2xl border border-white/[0.06] overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="bg-white/[0.02] text-[11px] font-mono uppercase tracking-[0.14em] text-slate-400">
              <tr>
                <th className="text-left px-4 py-2.5">Attribute</th>
                <th className="text-left px-4 py-2.5">Default</th>
                <th className="text-left px-4 py-2.5">What it does</th>
              </tr>
            </thead>
            <tbody className="text-slate-300">
              <Row attr="data-brand" def="default" desc="Tags every lead with source: embed-{brand} for attribution." />
              <Row attr="data-accent" def="67dcff" desc="Hex color (no #) for the CTA button + outline accents." />
              <Row attr="data-headline" def="Free roof estimate in 30 seconds" desc="H1 override. URL-encoded if it contains special chars." />
              <Row attr="data-sub" def="Satellite-measured. No tape measure visit. No spam calls." desc="Subhead override." />
              <Row attr="data-phone" def="true" desc='Set to "false" to drop the phone field for low-friction forms.' />
              <Row attr="data-redirect" def="(stays in place)" desc="URL to redirect to on submit. Receives ?leadId=…" />
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-[18px] font-semibold text-slate-100">
          4 · Track conversions
        </h2>
        <p className="text-[13px] text-slate-400">
          Listen for the <code className="font-mono text-slate-300 bg-white/[0.04] px-1 rounded">voxaris-pitch:lead-submitted</code> postMessage
          to fire your own analytics or pixel:
        </p>
        <CodeBlock
          code={`window.addEventListener("message", (e) => {
  if (e.origin !== "https://pitch.voxaris.io") return;
  if (e.data?.type === "voxaris-pitch:lead-submitted") {
    // GA4 / Meta / TikTok / Google Ads conversion event
    gtag("event", "generate_lead", {
      send_to: "AW-1234567890/AbCdEf",
      value: 1,
      currency: "USD",
      transaction_id: e.data.leadId,
    });
  }
});`}
        />
      </section>

      {/* Page-specific contact strip — kept inside the main column
          because it's contextual to the install docs ("got a custom
          need? email us"). The site-wide PublicFooter renders below
          for legal links + brand consistency. */}
      <div className="border-t border-white/[0.06] pt-6 text-[12px] text-slate-500 flex items-center justify-between flex-wrap gap-3">
        <span className="font-mono">Pitch embed · v1</span>
        <a
          href="mailto:hello@voxaris.io"
          className="inline-flex items-center gap-1.5 text-slate-300 hover:text-white"
        >
          Need a custom integration? <ExternalLink size={11} />
        </a>
      </div>
      </main>
      <PublicFooter />
    </div>
  );
}

function Row({ attr, def, desc }: { attr: string; def: string; desc: string }) {
  return (
    <tr className="border-t border-white/[0.04] hover:bg-white/[0.02]">
      <td className="px-4 py-3 font-mono text-[12.5px] text-slate-100 whitespace-nowrap">
        {attr}
      </td>
      <td className="px-4 py-3 font-mono text-[12px] text-slate-400 whitespace-nowrap">
        {def}
      </td>
      <td className="px-4 py-3 leading-relaxed">{desc}</td>
    </tr>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="relative rounded-xl border border-white/[0.08] bg-[#0c1118] overflow-hidden">
      <button
        type="button"
        onClick={onCopy}
        className="absolute top-2 right-2 px-2.5 py-1.5 rounded-md bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.10] text-[11px] font-mono uppercase tracking-[0.14em] text-slate-200 inline-flex items-center gap-1.5"
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="p-4 sm:p-5 text-[12.5px] leading-relaxed text-slate-200 overflow-x-auto font-mono">
        {code}
      </pre>
    </div>
  );
}

function LivePreview() {
  // Live, in-place iframe of /embed so the roofer can see the widget
  // without leaving the install page.
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (typeof e.data !== "object" || !e.data) return;
      if (e.data.type === "voxaris-pitch:resize" && iframeRef.current) {
        iframeRef.current.style.height = `${e.data.height}px`;
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#07090d] p-1">
      <iframe
        ref={iframeRef}
        src="/embed?brand=preview"
        title="Embed preview"
        className="w-full bg-[#07090d] rounded-xl"
        style={{ minHeight: 460, border: 0, colorScheme: "dark" }}
      />
    </div>
  );
}
