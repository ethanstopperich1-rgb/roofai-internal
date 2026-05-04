"use client";

import { Loader } from "@googlemaps/js-api-loader";

let loaderPromise: Promise<typeof google> | null = null;

export function loadGoogle(): Promise<typeof google> {
  if (loaderPromise) return loaderPromise;
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";
  const loader = new Loader({
    apiKey,
    version: "weekly",
    // geometry → spherical.computeArea() for polygon sqft labels.
    // drawing → DrawingManager for manual click-to-trace polygon mode
    libraries: ["places", "geometry", "drawing"],
  });
  loaderPromise = loader.load();
  return loaderPromise;
}
