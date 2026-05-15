/**
 * /estimate — PUBLIC mirror of the rep estimator that lives at `/`.
 *
 * The root `/` route is gated by Supabase auth / Basic Auth (see
 * middleware.ts → PROTECTED_PAGE_PATHS). This route renders the exact
 * same UI without auth so the page can be shared with partners /
 * shoulder-tap demos / sales prospects without an account.
 *
 * Implementation is a thin re-export of the same `<HomePage />`
 * component used by `/`. No duplicated logic, no drift — both routes
 * always render identically.
 *
 * Why a separate route instead of just removing the gate on `/`? The
 * `/` route is also the post-login landing for authenticated staff —
 * we don't want to expose the staff entry-point unauthenticated. A
 * second public URL gives us a clean split: `/` for staff, `/estimate`
 * for shareable demos. middleware.ts will not gate this path because
 * PROTECTED_PAGE_PATHS is a Set lookup against the exact string "/".
 */

// Re-export the internal estimator page component. The internal route
// group's default export is `HomePage` (HomePageInner + Suspense boundary).
export { default } from "../(internal)/page";
