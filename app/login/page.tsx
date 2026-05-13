/**
 * Login redirect — Basic Auth is the active sign-in surface.
 *
 * The magic-link flow was sending an email every visit, which broke the
 * demo loop (open dashboard → check email → click link → land back).
 * Until Supabase Auth is the primary path, this page just bounces to
 * `/dashboard` — the middleware Basic Auth dialog picks up from there
 * and the browser caches the credentials for the session.
 *
 * To re-enable magic-link UI later: restore the previous form from
 * git history (commit 7a68a8c is the last version with the form) and
 * delete this redirect.
 */

import { redirect } from "next/navigation";

export default function LoginPage() {
  redirect("/dashboard");
}
