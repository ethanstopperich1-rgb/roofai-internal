"use client";

/**
 * Staff bookmark URL for the internal rep estimator.
 *
 * `app/(internal)/page.tsx` is also served at `/`, but middleware redirects
 * anonymous visitors on `/` to `/quote` so bare-domain visitors see the
 * customer wizard. That redirect runs *before* the browser can show an HTTP
 * Basic challenge, which blocks staff who rely on Basic without a Supabase
 * session. `/rep` is staff-only (see middleware PROTECTED_PAGE_PATHS) and
 * never gets that redirect — same page module as `/`.
 */
export { default } from "../page";
