/**
 * ATTOM Data Property API wrapper.
 * Returns property metadata that EagleView reports show:
 * stories, year built, lot size, building sqft, bedrooms, baths, etc.
 *
 * Free tier: 250 calls/month at api.developer.attomdata.com.
 * Cached server-side via lib/cache.ts to stay under quota.
 */

const ATTOM_BASE = "https://api.gateway.attomdata.com/propertyapi/v1.0.0";

export interface AttomProperty {
  storyCount: number | null;
  yearBuilt: number | null;
  buildingSqft: number | null;
  lotSqft: number | null;
  beds: number | null;
  baths: number | null;
  propertyType: string | null;
  /** All raw attributes for debugging / future fields */
  raw?: unknown;
}

/**
 * Look up a single property's basic profile.
 * Uses ATTOM's "address1+address2" parameters since street+city,state,zip is the
 * most reliable way to query their dataset.
 */
export async function fetchAttomProperty(opts: {
  formattedAddress: string;
  apiKey: string;
}): Promise<AttomProperty | null> {
  const { formattedAddress, apiKey } = opts;
  // Split "123 Main St, City, ST 12345" → "123 Main St", "City, ST 12345"
  const parts = formattedAddress.split(",").map((s) => s.trim());
  if (parts.length < 2) return null;

  const address1 = parts[0];
  const address2 = parts.slice(1).join(", ");

  const url =
    `${ATTOM_BASE}/property/basicprofile` +
    `?address1=${encodeURIComponent(address1)}` +
    `&address2=${encodeURIComponent(address2)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/json",
        apikey: apiKey,
      },
      cache: "no-store",
    });
  } catch (err) {
    console.error("[attom] network error:", err);
    return null;
  }

  if (!res.ok) {
    if (res.status === 401) {
      console.warn("[attom] 401 — invalid ATTOM_API_KEY");
    } else if (res.status !== 404) {
      console.warn(`[attom] non-OK ${res.status} for ${address1}`);
    }
    return null;
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    console.error("[attom] JSON parse error:", err);
    return null;
  }

  // ATTOM nests the property data under .property[0].
  type AttomRow = {
    building?: {
      summary?: { storyCount?: number; yearBuilt?: number; propType?: string };
      size?: { livingsize?: number; bldgsize?: number };
      rooms?: { beds?: number; bathstotal?: number };
    };
    summary?: { yearBuilt?: number; propType?: string; propclass?: string };
    lot?: { lotsize1?: number; lotsize2?: number };
  };
  const row = (json as { property?: AttomRow[] })?.property?.[0];
  if (!row) return null;

  const storyCount = row.building?.summary?.storyCount ?? null;
  const yearBuilt = row.building?.summary?.yearBuilt ?? row.summary?.yearBuilt ?? null;
  const buildingSqft =
    row.building?.size?.livingsize ?? row.building?.size?.bldgsize ?? null;
  const beds = row.building?.rooms?.beds ?? null;
  const baths = row.building?.rooms?.bathstotal ?? null;
  const propertyType =
    row.building?.summary?.propType ?? row.summary?.propType ?? row.summary?.propclass ?? null;

  // ATTOM lotsize1 is acres, lotsize2 is sqft
  const lotSqft = row.lot?.lotsize2
    ? Math.round(row.lot.lotsize2)
    : row.lot?.lotsize1
      ? Math.round(row.lot.lotsize1 * 43_560)
      : null;

  return {
    storyCount: typeof storyCount === "number" ? storyCount : null,
    yearBuilt: typeof yearBuilt === "number" && yearBuilt > 1800 ? yearBuilt : null,
    buildingSqft: typeof buildingSqft === "number" ? buildingSqft : null,
    lotSqft,
    beds: typeof beds === "number" ? beds : null,
    baths: typeof baths === "number" ? baths : null,
    propertyType,
    raw: row,
  };
}
