import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";

// Stub API — Phase 2 will write to Supabase / Vercel Postgres.
// MVP persists via localStorage on the client.

export async function GET() {
  return NextResponse.json({ estimates: [], note: "MVP uses localStorage. Wire Supabase in Phase 2." });
}

export async function POST(req: Request) {
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;
  const body = await req.json().catch(() => ({}));
  return NextResponse.json({ ok: true, received: body });
}
