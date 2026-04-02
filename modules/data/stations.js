// MODULE: stations
// PURPOSE: Station filtering, brand metadata, and lookup utilities
// DEPENDS ON: logger

import { createLogger } from '../utils/logger.js';

const log = createLogger('stations');

// Brand color palette — official brand colors
const BRAND_COLORS = {
  'PEMEX':     '#006847',
  'OXXO GAS': '#FF0000',
  'BP':        '#009900',
  'TOTAL':     '#E8142C',
  'SHELL':     '#FFD100',
  'HIDROSINA': '#0066CC',
  'G500':      '#FF6600',
  'default':   '#888888',
};

/**
 * Get the brand color hex for a given brand name
 * @param {string} brand
 * @returns {string} hex color
 */
export function getBrandColor(brand) {
  if (!brand) return BRAND_COLORS.default;
  const key = brand.toUpperCase().trim();
  return BRAND_COLORS[key] ?? BRAND_COLORS.default;
}

/**
 * Filter stations by current filter state
 * @param {Merged[]} stations
 * @param {Object} filters - from state.filters
 * @returns {Merged[]}
 */
export function filterStations(stations, filters) {
  let result = stations;

  if (filters.brands?.length > 0) {
    const brands = filters.brands.map(b => b.toUpperCase());
    result = result.filter(s => brands.includes((s.brand ?? '').toUpperCase()));
  }

  if (filters.states?.length > 0) {
    result = result.filter(s => filters.states.includes(s.state));
  }

  if (filters.cities?.length > 0) {
    result = result.filter(s => filters.cities.includes(s.city));
  }

  if (filters.maxDistanceKm != null && filters.maxDistanceKm > 0) {
    result = result.filter(s => s.distanceKm != null && s.distanceKm <= filters.maxDistanceKm);
  }

  if (filters.priceRange) {
    const { min, max } = filters.priceRange;
    const ft = filters.fuelType ?? 'regular';
    result = result.filter(s => {
      if (!s.hasData || !s.prices) return false;
      const p = s.prices[ft];
      return p != null && p >= min && p <= max;
    });
  }

  if (filters.showAnomaliesOnly) {
    result = result.filter(s => s._isAnomaly === true);
  }

  if (filters.showMissingDataOnly) {
    result = result.filter(s => !s.hasData);
  }

  if (filters.searchQuery) {
    const q = filters.searchQuery.toLowerCase();
    result = result.filter(s =>
      s.name?.toLowerCase().includes(q)    ||
      s.brand?.toLowerCase().includes(q)   ||
      s.city?.toLowerCase().includes(q)    ||
      s.state?.toLowerCase().includes(q)   ||
      s.zipCode?.includes(q)               ||
      s.address?.toLowerCase().includes(q)
    );
  }

  return result;
}

/**
 * Get all unique brands with station counts, sorted by count descending
 * @param {Station[]} stations
 * @returns {{ name: string, count: number }[]}
 */
export function getBrands(stations) {
  const counts = new Map();
  for (const s of stations) {
    const b = s.brand ?? 'OTRO';
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get all unique states with station counts, sorted by count descending
 * @param {Station[]} stations
 * @returns {{ name: string, count: number }[]}
 */
export function getStates(stations) {
  const counts = new Map();
  for (const s of stations) {
    const st = s.state ?? '—';
    counts.set(st, (counts.get(st) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get cities within a state, with counts
 * @param {Station[]} stations
 * @param {string} [state] - filter by state; null = all cities
 * @returns {{ name: string, count: number }[]}
 */
export function getCities(stations, state = null) {
  const filtered = state ? stations.filter(s => s.state === state) : stations;
  const counts   = new Map();
  for (const s of filtered) {
    const c = s.city ?? '—';
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Find a single station by ID
 * @param {Station[]} stations
 * @param {string} id
 * @returns {Station|undefined}
 */
export function getStation(stations, id) {
  return stations.find(s => s.id === id);
}
