/**
 * Next.js instrumentation hook — runs once per server/edge worker
 * startup. We use it to initialise Sentry on the server + edge
 * runtimes (the browser-side init lives in `instrumentation-client.ts`).
 *
 * When NEXT_PUBLIC_SENTRY_DSN isn't set (dev, preview without secrets,
 * partner-fork deploys without an observability subscription), Sentry
 * stays uninitialized and `Sentry.captureException` becomes a no-op —
 * no errors thrown, no telemetry sent. This keeps the codebase safe to
 * sprinkle `captureException` calls into without worrying about every
 * deploy environment having credentials.
 */

import * as Sentry from "@sentry/nextjs";

export async function register() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return;

  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init({
      dsn,
      // Capture stack traces but no full-event sampling for server
      // routes (the default 0% would still capture explicit
      // `captureException` calls — which is what we want for now).
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.05"),
      // Environment tag so Vercel's preview deployments don't pollute
      // the production-error feed.
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
      // Include the commit SHA so issues are tied to a specific deploy.
      release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),
      // Quiet Sentry's own warnings about missing optional deps in dev.
      debug: false,
    });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.05"),
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
      release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),
    });
  }
}

// Surfaces nested-route errors to Sentry as well as the default
// `console.error`. Required for Next 15+ to capture App Router server
// errors automatically.
export const onRequestError = Sentry.captureRequestError;
