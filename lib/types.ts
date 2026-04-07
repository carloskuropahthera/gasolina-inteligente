export interface StationPrices {
  regular: number | null;
  premium: number | null;
  diesel: number | null;
  updatedAt?: string | null;
}

export interface CommunityPrice {
  price: number;
  reportedAt: string;
  verifications: number;
  reportedBy?: string;
}

export interface Station {
  id: string;
  name: string;
  brand: string;
  address: string;
  city: string;
  state: string;
  zipCode?: string;
  lat: number;
  lng: number;
  prices: StationPrices | null;
  hasData: boolean;
  distanceKm?: number;
  manhattanKm?: number;
  _isAnomaly?: boolean;
  updatedAt?: string | null;
  // Community-sourced data (Supabase / local state for now)
  communityPrices?: {
    regular?: CommunityPrice;
    premium?: CommunityPrice;
    diesel?: CommunityPrice;
  };
  waitTimeMinutes?: number;
  amenities?: {
    store: boolean;
    restrooms: boolean;
    carWash: boolean;
    open24h: boolean;
  };
}

export type FuelType = 'regular' | 'premium' | 'diesel';
export type ViewMode = 'map' | 'list' | 'route';
export type SortField = 'price' | 'name' | 'distance' | 'city';
export type SortDir = 'asc' | 'desc';

export interface AppFilters {
  fuelType: FuelType;
  maxDistanceKm: number | null;
  brands: string[];
  states: string[];
  priceMin: number | null;
  priceMax: number | null;
  showAnomalies: boolean;
  open24h: boolean;
  showOnlyWithData: boolean;
}

export interface NationalStats {
  regular: { avg: number; min: number; max: number; count: number };
  premium: { avg: number; min: number; max: number; count: number };
  diesel:  { avg: number; min: number; max: number; count: number };
  totalStations: number;
  stationsWithData: number;
  cheapest: Station | null;
  cheapestByFuel: { regular: Station | null; premium: Station | null; diesel: Station | null };
  exportedAt: string | null;
}

export interface PriceReport {
  stationId: string;
  fuelType: FuelType;
  price: number;
  lat: number;
  lng: number;
  photoUrl?: string;
  reportedAt: string;
}

export interface UserStats {
  points: number;
  reports: number;
  verifications: number;
  badges: string[];
}
