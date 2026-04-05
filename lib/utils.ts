import type { Station, FuelType, AppFilters, NationalStats } from './types';

export function formatMXN(value: number | null | undefined): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatDistance(km: number | undefined): string {
  if (km == null) return '';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

export function timeAgo(isoDate: string | null | undefined): string {
  if (!isoDate) return 'fecha desconocida';
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'hace un momento';
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `hace ${days}d`;
}

export function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function addDistances(stations: Station[], lat: number, lng: number): Station[] {
  return stations.map(s => ({
    ...s,
    distanceKm: haversine(lat, lng, s.lat, s.lng),
  }));
}

export function computeStats(stations: Station[]): NationalStats {
  const withData = stations.filter(s => s.hasData && s.prices);
  const vals = (ft: FuelType) => withData.map(s => s.prices![ft]).filter((v): v is number => v != null);

  const stat = (ft: FuelType) => {
    const v = vals(ft);
    if (!v.length) return { avg: 0, min: 0, max: 0, count: 0 };
    const avg = v.reduce((a, b) => a + b, 0) / v.length;
    return { avg, min: Math.min(...v), max: Math.max(...v), count: v.length };
  };

  const regVals = vals('regular');
  const cheapest = regVals.length
    ? withData.filter(s => s.prices?.regular != null)
        .sort((a, b) => (a.prices!.regular! - b.prices!.regular!))[0]
    : null;

  return {
    regular: stat('regular'),
    premium: stat('premium'),
    diesel: stat('diesel'),
    totalStations: stations.length,
    stationsWithData: withData.length,
    cheapest: cheapest ?? null,
    exportedAt: stations[0]?.updatedAt ?? null,
  };
}

export function filterStations(stations: Station[], filters: AppFilters): Station[] {
  return stations.filter(s => {
    const price = s.prices?.[filters.fuelType];

    if (filters.brands.length && !filters.brands.includes(s.brand)) return false;
    if (filters.states.length && !filters.states.includes(s.state)) return false;
    if (filters.showAnomalies && !s._isAnomaly) return false;
    if (filters.maxDistanceKm != null && (s.distanceKm == null || s.distanceKm > filters.maxDistanceKm)) return false;
    if (filters.priceMin != null && (price == null || price < filters.priceMin)) return false;
    if (filters.priceMax != null && (price == null || price > filters.priceMax)) return false;
    if (filters.open24h && !s.amenities?.open24h) return false;
    return true;
  });
}

export function priceColor(price: number, min: number, max: number): string {
  if (max === min) return '#4fc3f7';
  const pct = (price - min) / (max - min);
  if (pct <= 0.33) return '#00e676'; // green — cheap
  if (pct <= 0.66) return '#ffca28'; // amber — average
  return '#ff5252';                   // red — expensive
}

export function getBrandColor(brand: string): string {
  const colors: Record<string, string> = {
    'PEMEX':     '#006341',
    'MOBIL':     '#E2231A',
    'SHELL':     '#FFC72C',
    'BP':        '#009900',
    'CHEVRON':   '#0066B2',
    'TOTAL':     '#EE3124',
    'G500':      '#1565C0',
    'HIDROSINA': '#7B1FA2',
    'EXTRA':     '#F57C00',
  };
  const upper = (brand ?? '').toUpperCase();
  for (const [key, color] of Object.entries(colors)) {
    if (upper.includes(key)) return color;
  }
  return '#546E7A';
}

export const FUEL_LABELS: Record<string, string> = {
  regular: 'Magna/Regular',
  premium: 'Premium',
  diesel: 'Diésel',
};

export const DEFAULT_FILTERS: AppFilters = {
  fuelType: 'regular',
  maxDistanceKm: null,
  brands: [],
  states: [],
  priceMin: null,
  priceMax: null,
  showAnomalies: false,
  open24h: false,
};
