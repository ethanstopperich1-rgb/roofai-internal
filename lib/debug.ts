/**
 * Debug-gated logger. Replaces noisy `console.log` in hot paths so prod
 * Vercel function logs aren't drowned in per-request diagnostics. Set
 * `DEBUG=true` (or any truthy value) on a deploy to re-enable verbose
 * output for troubleshooting.
 *
 * Errors and warnings still go through `console.error`/`console.warn`
 * unconditionally — those should always be visible.
 */
const ENABLED = (() => {
  const v = process.env.DEBUG;
  return v && v !== "false" && v !== "0";
})();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function debug(...args: any[]): void {
  if (ENABLED) console.log(...args);
}
