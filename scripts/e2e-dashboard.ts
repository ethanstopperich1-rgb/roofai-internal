/**
 * E2E smoke harness for the dashboard / production-hardening surface.
 *
 * Exercises the same code paths Sydney + customer + rep traffic hit, against a
 * running Next.js instance (local dev server OR a staging Vercel deploy).
 *
 * Run:
 *   # against local dev:
 *   E2E_BASE_URL=http://localhost:3000 \
 *   AGENT_EVENTS_SECRET=... \
 *   STAFF_AUTH_USER=... STAFF_AUTH_PASS=... \
 *   npx tsx scripts/e2e-dashboard.ts
 *
 *   # against staging:
 *   E2E_BASE_URL=https://pitch-staging.vercel.app \
 *   AGENT_EVENTS_SECRET=... \
 *   STAFF_AUTH_USER=... STAFF_AUTH_PASS=... \
 *   npx tsx scripts/e2e-dashboard.ts
 *
 * What it does:
 *   1. /api/agent/events
 *        - rejects unsigned POSTs with 403
 *        - rejects wrong-signature POSTs with 403
 *        - accepts call_started → tool_fired → call_ended with valid HMAC
 *   2. /api/proposals
 *        - rejects anonymous POST with 401
 *        - accepts staff Basic-auth POST (or skips with WARN when creds absent)
 *   3. /api/leads
 *        - step-1 then final-submit with same email + existingLeadPublicId
 *          should NOT 4xx, server logs `isLeadUpdate=true`
 *          (we can't verify DB row count from here without service-role keys,
 *          so this asserts only HTTP-level success — DB assertion belongs in
 *          a Supabase-aware variant, gated on SUPABASE_SERVICE_ROLE_KEY)
 *
 * Exit codes:
 *   0 — all assertions passed (skipped checks emit WARN but still pass)
 *   1 — one or more assertions failed
 *
 * Secrets policy: this script reads everything from env. Never hard-code.
 * Pair it with a `.env.e2e.local` (git-ignored) or CI secret store.
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";

const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const SECRET = process.env.AGENT_EVENTS_SECRET ?? "";
const STAFF_USER = process.env.STAFF_AUTH_USER ?? "";
const STAFF_PASS = process.env.STAFF_AUTH_PASS ?? "";

type Result = { name: string; status: "pass" | "fail" | "skip"; detail?: string };
const RESULTS: Result[] = [];

function pass(name: string, detail?: string) {
  RESULTS.push({ name, status: "pass", detail });
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name: string, detail: string) {
  RESULTS.push({ name, status: "fail", detail });
  console.error(`  FAIL  ${name} — ${detail}`);
}
function skip(name: string, reason: string) {
  RESULTS.push({ name, status: "skip", detail: reason });
  console.warn(`  SKIP  ${name} — ${reason}`);
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

function signBody(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

async function readBody(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "";
  }
}

/** Wrap fetch so a network error becomes a single FAIL rather than crashing
 *  the whole harness — important when running against a deploy that's
 *  partially up (one route reachable, another not). */
async function safeFetch(
  label: string,
  url: string,
  init: RequestInit,
): Promise<Response | null> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(label, `network error: ${msg}`);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Agent events sink
// ───────────────────────────────────────────────────────────────────────────
async function testAgentEvents() {
  section("Agent events sink (/api/agent/events)");

  if (!SECRET) {
    skip(
      "agent-events: signed flow",
      "AGENT_EVENTS_SECRET not set — set the SAME value the deploy uses or this is meaningless",
    );
    return;
  }

  const url = `${BASE}/api/agent/events`;
  const roomName = `e2e-${randomUUID()}`;
  const startedAt = new Date().toISOString();

  // 1a. unsigned should 403
  {
    const body = JSON.stringify({
      type: "call_started",
      agent_name: "sydney",
      room_name: roomName,
      started_at: startedAt,
    });
    const r = await safeFetch("unsigned POST → 403", url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!r) {
      // network error already reported; skip the rest of this section because
      // the endpoint is unreachable.
      return;
    }
    if (r.status === 403) pass("unsigned POST → 403");
    else fail("unsigned POST → 403", `got ${r.status}: ${(await readBody(r)).slice(0, 120)}`);
  }

  // 1b. wrong signature should 403
  {
    const body = JSON.stringify({
      type: "call_started",
      agent_name: "sydney",
      room_name: roomName,
      started_at: startedAt,
    });
    const r = await safeFetch("bad-signature POST → 403", url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Signature": "sha256=deadbeef" },
      body,
    });
    if (!r) return;
    if (r.status === 403) pass("bad-signature POST → 403");
    else fail("bad-signature POST → 403", `got ${r.status}: ${(await readBody(r)).slice(0, 120)}`);
  }

  // 1c. valid signature: call_started → tool_fired → call_ended
  async function postSigned(payload: Record<string, unknown>, label: string) {
    const body = JSON.stringify(payload);
    const r = await safeFetch(`signed ${label}`, url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Signature": signBody(SECRET, body) },
      body,
    });
    if (!r) return { status: 0, text: "" };
    const text = await readBody(r);
    // Accept 200 (DB write) and 202 (no-db / unknown-agent). 200 is the real path.
    // unknown_agent => agent_name not mapped in offices.livekit_agent_name (silent drop).
    if (r.status === 200 || r.status === 202) {
      pass(`signed ${label} → ${r.status}`, text.slice(0, 80));
    } else {
      fail(`signed ${label}`, `status=${r.status} body=${text.slice(0, 200)}`);
    }
    return { status: r.status, text };
  }

  await postSigned(
    {
      type: "call_started",
      agent_name: "sydney",
      room_name: roomName,
      started_at: startedAt,
      caller_number: "+15555550100",
    },
    "call_started",
  );

  await postSigned(
    {
      type: "tool_fired",
      agent_name: "sydney",
      room_name: roomName,
      tool: "transfer_to_human",
      at: new Date().toISOString(),
      summary: { e2e: true, reason: "general", priority: "normal", target_hash: "x".repeat(12) },
    },
    "tool_fired",
  );

  await postSigned(
    {
      type: "call_ended",
      agent_name: "sydney",
      room_name: roomName,
      ended_at: new Date(Date.now() + 60_000).toISOString(),
      duration_sec: 60,
      turn_count: 4,
      outcome: "logged_lead",
      transcript: "e2e synthetic transcript",
      summary: "[e2e] synthetic call_ended",
      llm_prompt_tokens: 500,
      llm_completion_tokens: 200,
      tts_chars: 1200,
      stt_secs: 30,
      estimated_cost_usd: 0.01,
    },
    "call_ended",
  );

  // 1d. call_ended-only path (synthetic-insert fallback in route.ts:230)
  const lostRoom = `e2e-lost-${randomUUID()}`;
  await postSigned(
    {
      type: "call_ended",
      agent_name: "sydney",
      room_name: lostRoom,
      ended_at: new Date().toISOString(),
      duration_sec: 30,
      turn_count: 2,
      outcome: "no_show",
    },
    "call_ended-only (synthetic insert path)",
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Proposal POST gate
// ───────────────────────────────────────────────────────────────────────────
async function testProposalGate() {
  section("Proposal write gate (POST /api/proposals)");

  const url = `${BASE}/api/proposals`;
  // Minimal estimate-like payload — the gate fires BEFORE schema validation,
  // so we expect 401 well before any body inspection.
  const body = JSON.stringify({ estimate: { id: `est-${randomUUID()}` } });

  // 2a. anonymous → 401
  {
    const r = await safeFetch("anonymous POST → 401", url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!r) return;
    if (r.status === 401) pass("anonymous POST → 401");
    else fail("anonymous POST → 401", `got ${r.status}: ${(await readBody(r)).slice(0, 120)}`);
  }

  // 2b. with Basic auth → not 401 (may be 200/400/500 — anything not 401 means
  //     the gate let us through; downstream errors are unrelated to auth).
  if (!STAFF_USER || !STAFF_PASS) {
    skip(
      "staff POST → not 401",
      "STAFF_AUTH_USER / STAFF_AUTH_PASS not set — cannot exercise authenticated path",
    );
    return;
  }
  {
    const auth = "Basic " + Buffer.from(`${STAFF_USER}:${STAFF_PASS}`).toString("base64");
    const r = await safeFetch("staff Basic POST", url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body,
    });
    if (!r) return;
    if (r.status !== 401) pass(`staff Basic POST → ${r.status} (gate accepted creds)`);
    else fail("staff Basic POST → not 401", "credentials rejected; check STAFF_AUTH_* env values");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Leads dedupe
// ───────────────────────────────────────────────────────────────────────────
async function testLeadsDedupe() {
  section("Leads dedupe (POST /api/leads with existingLeadPublicId)");

  const url = `${BASE}/api/leads`;
  const stamp = randomBytes(4).toString("hex");
  const email = `e2e-${stamp}@example.invalid`;
  const phone = `+1555555${(1000 + Math.floor(Math.random() * 8999)).toString()}`;
  const tcpaConsentAt = new Date().toISOString();

  // 3a. step-1 capture
  const step1Body = {
    name: "E2E Tester",
    email,
    phone,
    address: "123 E2E Lane, Orlando, FL 32801",
    source: "e2e-step-1",
    tcpaConsent: true,
    tcpaConsentAt,
    tcpaConsentText: "test",
  };
  const r1 = await safeFetch("leads step-1", url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(step1Body),
  });
  if (!r1) return;
  const t1 = await readBody(r1);
  if (!r1.ok) {
    // BotID will 403 here when run outside a real browser. That's expected
    // for this surface — log a SKIP rather than a failure, because the
    // server-side dedupe logic can't be reached without bypassing BotID.
    if (r1.status === 403 && t1.includes("Bot")) {
      skip(
        "leads step-1",
        "BotID rejected (expected when running without browser challenge — exercise via Playwright/browser to cover this path)",
      );
      return;
    }
    fail("leads step-1", `status=${r1.status} body=${t1.slice(0, 200)}`);
    return;
  }
  let leadId: string | undefined;
  try {
    leadId = (JSON.parse(t1) as { leadId?: string }).leadId;
  } catch {
    /* ignore */
  }
  if (leadId && /^lead_[0-9a-f]{32}$/.test(leadId)) {
    pass("leads step-1 → leadId issued", leadId);
  } else {
    fail("leads step-1 → leadId issued", `got body=${t1.slice(0, 200)}`);
    return;
  }

  // 3b. final submit, same email + existingLeadPublicId
  const step2Body = {
    ...step1Body,
    estimatedSqft: 2400,
    material: "asphalt-architectural",
    estimateLow: 18000,
    estimateHigh: 25000,
    selectedAddOns: [],
    source: "e2e-final",
    existingLeadPublicId: leadId,
  };
  const r2 = await safeFetch("leads final submit (update)", url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(step2Body),
  });
  if (!r2) return;
  const t2 = await readBody(r2);
  if (!r2.ok) {
    fail("leads final submit (update)", `status=${r2.status} body=${t2.slice(0, 200)}`);
    return;
  }
  let leadId2: string | undefined;
  try {
    leadId2 = (JSON.parse(t2) as { leadId?: string }).leadId;
  } catch {
    /* ignore */
  }
  if (leadId2 === leadId) {
    pass("leads final submit returns SAME leadId (update path)", leadId2);
  } else {
    // The route always returns SOMETHING; we surface the divergence loudly.
    fail(
      "leads final submit returns SAME leadId (update path)",
      `expected ${leadId}, got ${leadId2 ?? "<none>"} — server may have inserted a new row instead of updating. Verify isLeadUpdate branch in app/api/leads/route.ts:139`,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`E2E target: ${BASE}\n`);
  await testAgentEvents();
  await testProposalGate();
  await testLeadsDedupe();

  const passes = RESULTS.filter((r) => r.status === "pass").length;
  const fails = RESULTS.filter((r) => r.status === "fail").length;
  const skips = RESULTS.filter((r) => r.status === "skip").length;
  console.log(`\nSummary: ${passes} pass, ${fails} fail, ${skips} skip`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nE2E harness crashed:", err);
  process.exit(2);
});
