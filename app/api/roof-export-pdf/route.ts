// app/api/roof-export-pdf/route.ts
//
// Tier A.2 — Puppeteer-driven PDF stills + 360° orbit MP4 export.
//
// POST { roofDataId | url } → { stills: string[], mp4: string | null }
//
// Rep-triggered on demand from /internal "Export PDF stills" button.
// Latency: 30-60s for 6 stills + an 8s MP4. NOT wired into auto-save.
//
// Default state: 503 — the captureOrbit dep (Puppeteer + headless Chrome)
// isn't installed by default. See lib/puppeteer-orbit.ts for the install
// path and implementation outline. The route is shape-stable so the
// /internal button can be wired now and start working as soon as the
// deps land.

import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import {
  captureOrbit,
  PuppeteerNotInstalledError,
} from "@/lib/puppeteer-orbit";

export const runtime = "nodejs";
export const maxDuration = 300; // up to 5 min for the full orbit + encode

interface RequestBody {
  /** Public URL of an embeddable RoofViewer mount (e.g.
   *  https://app.example.com/internal/export-frame?id=...). */
  url?: string;
  /** Optional list of camera headings for the stills. Defaults to
   *  [0, 60, 120, 180, 240, 300]. */
  stillHeadings?: number[];
  /** Whether to render the 8s orbit MP4. Default true. */
  renderMp4?: boolean;
}

export async function POST(req: Request) {
  const __rl = await rateLimit(req, "expensive");
  if (__rl) return __rl;

  let body: RequestBody;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!body.url || !/^https?:\/\//.test(body.url)) {
    return NextResponse.json({ error: "url required (absolute http(s))" }, { status: 400 });
  }

  // The TS function will throw PuppeteerNotInstalledError when the
  // browser-automation deps aren't installed. Catch + 503 → the UI tells
  // the rep "export not configured" rather than 500-erroring.
  try {
    const result = await captureOrbit({
      url: body.url,
      outputDir: "/tmp/voxaris-export",
      stillHeadings: body.stillHeadings,
      renderMp4: body.renderMp4 ?? true,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PuppeteerNotInstalledError) {
      return NextResponse.json(
        {
          error: "export_not_configured",
          message:
            "Tier A.2 PDF export requires Puppeteer + headless Chromium. " +
            "See lib/puppeteer-orbit.ts for setup instructions.",
        },
        { status: 503 },
      );
    }
    console.error("[roof-export-pdf] error:", err);
    return NextResponse.json(
      { error: "export_failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 502 },
    );
  }
}
