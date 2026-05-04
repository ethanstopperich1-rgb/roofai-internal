import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  typedRoutes: false,
  // Cesium loads its workers/assets at runtime from CDN (see Roof3DViewer.tsx
  // — sets CESIUM_BASE_URL before any Cesium code runs), so the bundler
  // doesn't need to copy or alias anything. Empty `turbopack` to silence
  // the missing-config warning under Next 16.
  turbopack: {},
};

export default config;
