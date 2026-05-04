import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function estimateRoofSize(): number {
  // Placeholder heuristic until aerial/parcel data is wired in.
  // Avg US single-family roof ~2,000 sqft; +/- jitter for variety.
  return Math.round(1800 + Math.random() * 800);
}

export function estimateAge(): number {
  return Math.round(8 + Math.random() * 17);
}
