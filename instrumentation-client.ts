/**
 * Browser-side Sentry init. Runs once when the React app boots.
 *
 * Disabled when the DSN env var is missing (dev / preview / partner
 * forks) — `Sentry.init` is simply not called, and any subsequent
 * `Sentry.captureException` calls are silent no-ops.
 *
 * Browser scope is the highest-volume source of errors (every user
 * device runs this code), so the sample rate stays conservative.
 */

import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: Number(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.02",
    ),
    // Session-replay is OFF by default — it carries privacy implications
    // (customer addresses + phone numbers would be captured on the
    // /quote flow). Turn on per-deploy via env when explicitly wanted.
    replaysOnErrorSampleRate: Number(
      process.env.NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE ?? "0",
    ),
    replaysSessionSampleRate: 0,
    environment:
      process.env.NEXT_PUBLIC_VERCEL_ENV ??
      process.env.NODE_ENV ??
      "development",
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7),
    // Drop noisy ResizeObserver / network warnings that don't represent
    // real failures and just fill the inbox.
    ignoreErrors: [
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
      "Non-Error promise rejection captured",
      "Load failed",
    ],
  });
}
