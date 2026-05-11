import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";

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
    ];
  },
};

// Wrap with Vercel BotID — adds challenge headers + propagates the
// per-route protect config from <BotIdClient> down to the verifier in
// /api/leads. The actual route-level enforcement happens via
// `await checkBotId()` inside the route handler.
export default withBotId(config);
