/**
 * Florida parcel + property-appraiser data sources, by county.
 *
 * Source of truth for every downstream piece of the canvass-list
 * pipeline:
 *   • The nightly Python ingest worker (post-demo) reads from this
 *     table to know where to fetch parcels for each county.
 *   • The /storms canvass UI reads `updateCadence` so it can show
 *     "data current as of <X>" per county.
 *   • The dashboard's `Permit & parcel sources` status card renders
 *     directly from this list — no hand-maintained markup.
 *
 * Add a county by appending to COUNTY_DATA_SOURCES. Anything
 * downstream (UI badges, ingest config, status cards) picks it up
 * automatically because everything keys off `slug`.
 */

export type UpdateCadence = "daily" | "nightly" | "weekly" | "annual" | "as-needed";

export interface CountyDataSource {
  /** URL-safe ID. Used as the Supabase `county_slug` foreign key. */
  slug: string;
  /** Display name — "Seminole", "Orange", etc. (no "County" suffix). */
  name: string;
  /** Marketing tag — the city or region the rep recognizes the county by. */
  region: string;
  /** Estimated population — used to weight canvass density heuristics. */
  populationApprox?: number;
  /** Property Appraiser (PA) — the primary tax-roll source. */
  propertyAppraiser: {
    name: string;
    homepage: string;
    /** Direct CSV / Excel / FTP endpoint the ingest worker pulls. */
    downloadUrl: string;
    /** What's in the export. Used for the status card subtitle. */
    contents: string;
  };
  /** GIS / open-data portal — the source of parcel polygons. */
  gis: {
    name: string;
    homepage: string;
    /** Direct shapefile / geodatabase endpoint. */
    downloadUrl: string;
    /** Format the worker decodes — "shp", "gdb", "geojson". */
    format: "shp" | "gdb" | "geojson" | "csv";
  };
  /** How often the upstream source publishes new data. */
  updateCadence: UpdateCadence;
  /** Operational note — quirks, caveats, why this county is good for canvassing. */
  notes: string;
  /** True when this county has full owner-name + situs-address coverage in
   *  the export. Drives the "personalized canvass list" feature gate; some
   *  counties redact owner names and require a separate join. */
  ownerNamesIncluded: boolean;
}

export const COUNTY_DATA_SOURCES: CountyDataSource[] = [
  {
    slug: "seminole",
    name: "Seminole",
    region: "Oviedo · Sanford · Lake Mary",
    populationApprox: 475_000,
    propertyAppraiser: {
      name: "Seminole County Property Appraiser",
      homepage: "https://www.scpafl.org/",
      downloadUrl: "https://www.scpafl.org/downloads",
      contents: "Daily CSV/Excel: owner name, situs address, land-use code, assessed value",
    },
    gis: {
      name: "Seminole County GIS",
      homepage: "https://www.seminolecountyfl.gov/departments-services/information-services/gis/",
      downloadUrl: "https://scwebapp2.seminolecountyfl.gov:6443/is/gis/GISData/Parcels.gdb.zip",
      format: "gdb",
    },
    updateCadence: "daily",
    notes:
      "Best-in-class for Voxaris HQ territory. Daily refresh, owner names included, parcel polygons updated weekly. Use this as the reference implementation for the ingest worker.",
    ownerNamesIncluded: true,
  },
  {
    slug: "orange",
    name: "Orange",
    region: "Orlando metro",
    populationApprox: 1_473_000,
    propertyAppraiser: {
      name: "Orange County Property Appraiser",
      homepage: "https://www.ocpafl.org/",
      downloadUrl: "https://www.ocpafl.org/searches/parcelsearch.aspx",
      contents: "Full tax roll: owner, situs address, just value, year built, building sqft",
    },
    gis: {
      name: "OCGIS Data Hub",
      homepage: "https://ocgis-datahub-ocfl.hub.arcgis.com/",
      downloadUrl:
        "https://ocgis-datahub-ocfl.hub.arcgis.com/datasets/parcels/explore",
      format: "shp",
    },
    updateCadence: "nightly",
    notes:
      "Largest county by population in our service area. Nightly parcel refresh via OCGIS Data Hub (ArcGIS Open Data). Tax roll + spatial data align cleanly on PARCEL_ID.",
    ownerNamesIncluded: true,
  },
  {
    slug: "lake",
    name: "Lake",
    region: "Clermont · Mount Dora · Leesburg",
    populationApprox: 410_000,
    propertyAppraiser: {
      name: "Lake County Property Appraiser",
      homepage: "https://www.lakecopropappr.com/",
      downloadUrl: "https://c.lakecountyfl.gov/ftp/PA_office/data/",
      contents: "FTP tax roll (CSV): full parcel + owner + assessment data",
    },
    gis: {
      name: "Lake County GeoHub",
      homepage: "https://geohub-lcgis.opendata.arcgis.com/",
      downloadUrl:
        "https://geohub-lcgis.opendata.arcgis.com/datasets/parcels/explore",
      format: "shp",
    },
    updateCadence: "daily",
    notes:
      "Free FTP for tax roll + open GeoHub for polygons. Lake is the south-Clermont and Four Corners gateway — high storm exposure on the Lake/Polk line.",
    ownerNamesIncluded: true,
  },
  {
    slug: "osceola",
    name: "Osceola",
    region: "Kissimmee · Four Corners · St. Cloud",
    populationApprox: 425_000,
    propertyAppraiser: {
      name: "Osceola County Property Appraiser",
      homepage: "https://www.property-appraiser.org/",
      downloadUrl: "https://www.property-appraiser.org/data/",
      contents: "Certified tax roll (~152 MB zip): parcel + owner + values",
    },
    gis: {
      name: "Osceola County GIS",
      homepage: "https://www.gis.osceola.org/",
      downloadUrl: "https://www.gis.osceola.org/portal/home/",
      format: "shp",
    },
    updateCadence: "annual",
    notes:
      "Certified roll published yearly with ongoing supplemental updates. Fastest-growing county in our service area — Kissimmee/Four Corners new construction is a strong reroof pipeline 15+ years out.",
    ownerNamesIncluded: true,
  },
  {
    slug: "volusia",
    name: "Volusia",
    region: "Orange City · Deltona · Daytona",
    populationApprox: 580_000,
    propertyAppraiser: {
      name: "Volusia County Property Appraiser",
      homepage: "https://vcpa.vcgov.org/",
      downloadUrl: "https://vcpa.vcgov.org/data-download.html",
      contents: "Full parcel exports: owner, situs, assessment data",
    },
    gis: {
      name: "Volusia County GIS",
      homepage: "https://maps.vcgov.org/gis/",
      downloadUrl: "https://maps.vcgov.org/gis/downloads/",
      format: "shp",
    },
    updateCadence: "weekly",
    notes:
      "Coastal exposure — every named tropical system that brushes the I-4 corridor lands here. Volusia roof age skews older than inland counties, which lifts the storm-damage-to-claim conversion rate.",
    ownerNamesIncluded: true,
  },
];

/** Total parcels-by-name lookup. */
export function findCountyBySlug(slug: string): CountyDataSource | undefined {
  return COUNTY_DATA_SOURCES.find((c) => c.slug === slug);
}

/** Friendly cadence label for status badges. */
export function cadenceLabel(c: UpdateCadence): string {
  switch (c) {
    case "daily":
      return "Daily";
    case "nightly":
      return "Nightly";
    case "weekly":
      return "Weekly";
    case "annual":
      return "Annual + supplemental";
    case "as-needed":
      return "As published";
  }
}

/** Estimated total addressable parcels across all wired counties.
 *  Used by the marketing card to communicate coverage scale. */
export function totalApproxPopulation(): number {
  return COUNTY_DATA_SOURCES.reduce(
    (sum, c) => sum + (c.populationApprox ?? 0),
    0,
  );
}
