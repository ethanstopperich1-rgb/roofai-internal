// lib/puppeteer-orbit.ts
//
// Capture helper for the Tier A.2 PDF export pipeline. Uses Puppeteer (or
// Playwright) to drive a headless Chromium that orbits the on-page Cesium
// viewer + captures 6 stills + an 8s MP4 H.264 orbit.
//
// Why this is a stub: Puppeteer + Chromium are heavyweight (binary
// + ~50MB function-bundle hit on Vercel). The Tier A.2 decisions doc
// flags this as rep-on-demand only — it doesn't need to ship enabled by
// default. To enable, install one of:
//
//   npm i puppeteer @sparticuz/chromium-min        (Vercel-friendly path)
//   npm i playwright                                (full-fat dev path)
//
// Then implement `captureOrbit` below with `chromium.launch()` + the
// Cesium camera-pose loop. The /api/roof-export-pdf route is wired but
// returns 503 until this lands.

export interface CaptureOptions {
  /** Public URL of an embeddable /quote or /internal page rendering the
   *  target RoofData. Headless Chromium loads it like a real browser. */
  url: string;
  /** Output dir on the function tmpfs. Stills + MP4 are written here. */
  outputDir: string;
  /** Heading degrees for each still. Defaults to N/E/S/W + top + iso. */
  stillHeadings?: number[];
  /** Whether to render the 8s 360° MP4 orbit (true by default). */
  renderMp4?: boolean;
}

export interface CaptureResult {
  stillPaths: string[];
  mp4Path: string | null;
  durationMs: number;
}

export class PuppeteerNotInstalledError extends Error {
  constructor() {
    super(
      "Puppeteer is not installed. See lib/puppeteer-orbit.ts for setup instructions.",
    );
    this.name = "PuppeteerNotInstalledError";
  }
}

/**
 * Capture the 6 stills + optional MP4 orbit for a roof's 3D viewer.
 * Throws PuppeteerNotInstalledError when the browser-automation deps
 * aren't available — the API route catches this and returns 503.
 *
 * Implementation outline (when enabling):
 *
 *   const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath() });
 *   const page = await browser.newPage();
 *   await page.setViewport({ width: 1920, height: 1080 });
 *   await page.goto(opts.url, { waitUntil: "networkidle0" });
 *   await page.waitForSelector("[data-roof-viewer-ready=true]");
 *   for (const heading of headings) {
 *     await page.evaluate((h) => window.__roofViewerSetCamera(h), heading);
 *     await page.waitForTimeout(800);
 *     await page.screenshot({ path: path.join(opts.outputDir, `still-${heading}.png`) });
 *   }
 *   if (opts.renderMp4) {
 *     // Use ffmpeg to encode 240 stills (30fps × 8s) into mp4.
 *     // Or use Puppeteer's HeadlessExperimental.beginFrame() for high-quality MP4.
 *   }
 *   await browser.close();
 */
export async function captureOrbit(opts: CaptureOptions): Promise<CaptureResult> {
  // Probe for the dep without a static import — preserves typecheck cleanliness
  // when puppeteer isn't in package.json. The dynamic Function-wrapped import
  // sidesteps Next's bundler treating "puppeteer" as a hard dependency.
  let puppeteer: unknown = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    puppeteer = (await (new Function("return import('puppeteer').catch(() => null)"))()) as any;
  } catch {
    puppeteer = null;
  }
  if (!puppeteer) {
    throw new PuppeteerNotInstalledError();
  }
  // Real capture implementation lives here once the deps are installed.
  // See the JSDoc above for the suggested structure.
  console.log("[puppeteer-orbit] would capture", {
    url: opts.url,
    stillCount: (opts.stillHeadings ?? []).length || 6,
    mp4: opts.renderMp4 ?? true,
  });
  throw new Error("captureOrbit: implementation pending. See lib/puppeteer-orbit.ts.");
}
