export type Material =
  | "asphalt-3tab"
  | "asphalt-architectural"
  | "metal-standing-seam"
  | "tile-concrete";

export type Pitch = "4/12" | "5/12" | "6/12" | "7/12" | "8/12+";

export interface AddOn {
  id: string;
  label: string;
  price: number;
  enabled: boolean;
}

export interface Assumptions {
  sqft: number;
  pitch: Pitch;
  material: Material;
  ageYears: number;
  laborMultiplier: number;
  materialMultiplier: number;
}

export interface AddressInfo {
  formatted: string;
  zip?: string;
  lat?: number;
  lng?: number;
}

export interface Estimate {
  id: string;
  createdAt: string;
  staff: string;
  customerName?: string;
  notes?: string;
  address: AddressInfo;
  assumptions: Assumptions;
  addOns: AddOn[];
  total: number;
  baseLow: number;
  baseHigh: number;
}
