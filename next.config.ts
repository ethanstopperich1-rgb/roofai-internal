import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";
import { withSentryConfig } from "@sentry/nextjs";

const config: NextConfig = {
  reactStrictMode: true,
  typedRoutes: false,
  // Cesium loads its workers/assets at runtime from CDN (see Roof3DViewer.tsx
  // — sets CESIUM_BASE_URL before any Cesium code runs), so the bundler
  // doesn't need to copy or alias anything. Empty `turbopack` to silence
  // the missing-config warning under Next 16.
  turbopack: {},
  // Permit /embed and /embed.js to be loaded cross-origin by third-party
  // roofer websites. Default Next.js sets X-Frame-Options: DENY which would
  // block any iframe; we explicitly allow it for the embed surface only.
  async headers() {
    return [
      {
        // The embeddable widget — must be iframable from any host.
        source: "/embed",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
          // Older browsers honor X-Frame-Options; explicitly clear it.
          { key: "X-Frame-Options", value: "ALLOWALL" },
        ],
      },
      {
        // The install snippet served from /embed.js — needs CORS so any
        // origin can fetch it.
        source: "/embed.js",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "public, max-age=300, s-maxage=86400" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
      {
        // Customer proposal pages contain PII (name, address, phone-
        // anchored estimate). Tell every well-behaved crawler not to
        // index them. The Next metadata API in app/p/[id]/layout.tsx
        // covers Googlebot/Bingbot via meta tag; this header is the
        // belt-and-suspenders for crawlers that read response headers
        // only (LLM scrapers, archive.org, IFTTT-style bots).
        source: "/p/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet, noimageindex" },
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
        ],
      },
    ];
  },
};

// Compose enhancers in order:
//   1. BotID — adds challenge headers, propagates per-route protect config
//   2. Sentry — source-map upload + tunnel for ad-blockers; init lives in
//      instrumentation.ts + instrumentation-client.ts. When SENTRY_AUTH_TOKEN
//      is unset (dev / partner forks), `withSentryConfig` skips the upload
//      step but the wrapper is still inert-safe to apply.
const enhanced = withSentryConfig(withBotId(config), {
  // Disable source-map upload when running locally — otherwise Sentry's
  // build plugin prints a warning every `npm run dev`.
  silent: !process.env.CI,
  // tunnelRoute deliberately UNSET. The auto-generated handler at
  // /monitoring accepts unauthenticated POSTs and forwards them to
  // Sentry. Each post = 1 Vercel function invocation, so a hostile
  // script could fill billing with synthetic events.
  //
  // To re-enable safely after the pilot, do BOTH:
  //   1. Add `/monitoring` to lib/ratelimit's "public" bucket
  //   2. Verify the X-Sentry-Auth header pattern matches our DSN before
  //      forwarding (requires a custom route handler since the auto-
  //      generated one doesn't validate)
  //
  // Until then, browsers POST directly to Sentry. Users running content
  // blockers (uBlock, Brave Shields) won't show up in error metrics,
  // which is an acceptable trade vs. an unbounded invocation cost.
  //
  // tunnelRoute: "/monitoring",
  //
  // Disable Sentry's automatic telemetry — we already track our own.
  telemetry: false,
});

export default enhanced;
