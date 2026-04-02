// MODULE: prices
// PURPOSE: Price processing, merging, statistics, and history queries
// DEPENDS ON: storage-interface, logger, helpers

import * as storage     from '../storage/storage-interface.js';
import { createLogger } from '../utils/logger.js';
import { percentile }   from '../utils/helpers.js';

const log = createLogger('prices');

const FUEL_TYPES = ['regular', 'premium', 'diesel'];

// ─── Merge ────────────────────────────────────────────────────────────────

/**
 * Merge station list with prices by stationId
 * @param {Station[]} stations
 * @param {Price[]} prices
 * @returns {Merged[]}
 */
export function mergeStationsAndPrices(stations, prices) {
  const priceMap = new Map(prices.map(p => [p.stationId, p]));
  return stations.map(station => ({
    ...station,
    prices:  priceMap.get(station.id) ?? null,
    hasData: priceMap.has(station.id),
  }));
}

// ─── Statistics ───────────────────────────────────────────────────────────

/**
 * Compute price statistics for a fuel type across a dataset
 * @param {Merged[]} mergedData
 * @param {'regular'|'premium'|'diesel'} fuelType
 * @returns {{ min, max, avg, median, p10, p25, p75, p90, stdDev, count }}
 */
export function getStats(mergedData, fuelType) {
  const vals = mergedData
    .filter(s => s.hasData && s.prices?.[fuelType] != null)
    .map(s => s.prices[fuelType]);

  if (vals.length === 0) {
    // Use sentinel infinities so color thresholds never falsely fire:
    // greenThreshold (p10) = -Infinity → no station is "cheap"
    // redThreshold   (p90) = +Infinity → no station is "expensive"
    return { min:null, max:null, avg:null, median:null, p10:-Infinity, p25:null, p75:null, p90:Infinity, stdDev:0, count:0 };
  }

  const sorted = [...vals].sort((a, b) => a - b);
  const avg    = vals.reduce((s, v) => s + v, 0) / vals.length;
  const stdDev = Math.sqrt(vals.reduce((s, v) => s + (v - avg)**2, 0) / vals.length);

  return {
    min:    Math.round(sorted[0] * 100) / 100,
    max:    Math.round(sorted.at(-1) * 100) / 100,
    avg:    Math.round(avg * 100) / 100,
    median: Math.round(percentile(sorted, 50) * 100) / 100,
    p10:    Math.round(percentile(sorted, 10) * 100) / 100,
    p25:    Math.round(percentile(sorted, 25) * 100) / 100,
    p75:    Math.round(percentile(sorted, 75) * 100) / 100,
    p90:    Math.round(percentile(sorted, 90) * 100) / 100,
    stdDev: Math.round(stdDev * 1000) / 1000,
    count:  vals.length,
  };
}

/**
 * Get cheapest N stations for a fuel type
 * @param {Merged[]} mergedData
 * @param {'regular'|'premium'|'diesel'} fuelType
 * @param {number} [limit=10]
 * @returns {Merged[]}
 */
export function getCheapest(mergedData, fuelType, limit = 10) {
  return mergedData
    .filter(s => s.hasData && s.prices?.[fuelType] != null)
    .sort((a, b) => a.prices[fuelType] - b.prices[fuelType])
    .slice(0, limit);
}

/**
 * Get most expensive N stations for a fuel type
 * @param {Merged[]} mergedData
 * @param {'regular'|'premium'|'diesel'} fuelType
 * @param {number} [limit=10]
 * @returns {Merged[]}
 */
export function getMostExpensive(mergedData, fuelType, limit = 10) {
  return mergedData
    .filter(s => s.hasData && s.prices?.[fuelType] != null)
    .sort((a, b) => b.prices[fuelType] - a.prices[fuelType])
    .slice(0, limit);
}

// ─── History ──────────────────────────────────────────────────────────────

/**
 * Get price history for a station from stored snapshots
 * @param {string} stationId
 * @param {'regular'|'premium'|'diesel'} fuelType
 * @param {number} [days=30]
 * @returns {Promise<{date: string, price: number}[]>}
 */
export async function getPriceHistory(stationId, fuelType, days = 30) {
  const dates     = await storage.listSnapshots();
  const recent    = dates.slice(0, days); // newest first, already sorted
  const history   = [];

  for (const date of recent) {
    const snap = await storage.getSnapshot(date);
    if (!snap?.stations) continue;

    const station = snap.stations.find(s => s.id === stationId);
    if (station?.prices?.[fuelType] != null) {
      history.push({ date, price: station.prices[fuelType] });
    }
  }

  return history.reverse(); // chronological (oldest first)
}

/**
 * Compare today's prices to yesterday's
 * @param {Merged[]} today
 * @param {Merged[]} yesterday
 * @returns {Array<{stationId, fuelType, today, yesterday, change, pctChange}>}
 */
export function compareToPrevious(today, yesterday) {
  const yMap   = new Map(yesterday.map(s => [s.id, s]));
  const result = [];

  for (const station of today) {
    if (!station.hasData) continue;
    const prev = yMap.get(station.id);
    if (!prev?.hasData) continue;

    for (const ft of FUEL_TYPES) {
      const t = station.prices?.[ft];
      const y = prev.prices?.[ft];
      if (t == null || y == null) continue;

      const change    = Math.round((t - y) * 100) / 100;
      const pctChange = Math.round((change / y) * 100 * 10) / 10;
      result.push({ stationId: station.id, fuelType: ft, today: t, yesterday: y, change, pctChange });
    }
  }

  return result;
}

// ─── Aggregations ─────────────────────────────────────────────────────────

/**
 * Get city-level price averages
 * @param {Merged[]} mergedData
 * @param {'regular'|'premium'|'diesel'} fuelType
 * @returns {Array<{city, state, avg, min, max, stationCount}>}
 */
export function getPricesByCity(mergedData, fuelType) {
  const cityMap = new Map();
  for (const s of mergedData) {
    if (!s.hasData || s.prices?.[fuelType] == null) continue;
    const key = `${s.city}|${s.state}`;
    if (!cityMap.has(key)) cityMap.set(key, { city: s.city, state: s.state, prices: [] });
    cityMap.get(key).prices.push(s.prices[fuelType]);
  }
  return [...cityMap.values()].map(({ city, state, prices }) => ({
    city, state,
    avg:          Math.round(prices.reduce((a, v) => a + v, 0) / prices.length * 100) / 100,
    min:          Math.min(...prices),
    max:          Math.max(...prices),
    stationCount: prices.length,
  })).sort((a, b) => a.avg - b.avg);
}

/**
 * Get brand-level price averages
 * @param {Merged[]} mergedData
 * @param {'regular'|'premium'|'diesel'} fuelType
 * @returns {Array<{brand, avg, min, max, stationCount}>}
 */
export function getPricesByBrand(mergedData, fuelType) {
  const brandMap = new Map();
  for (const s of mergedData) {
    if (!s.hasData || s.prices?.[fuelType] == null) continue;
    if (!brandMap.has(s.brand)) brandMap.set(s.brand, []);
    brandMap.get(s.brand).push(s.prices[fuelType]);
  }
  return [...brandMap.entries()].map(([brand, prices]) => ({
    brand,
    avg:          Math.round(prices.reduce((a, v) => a + v, 0) / prices.length * 100) / 100,
    min:          Math.min(...prices),
    max:          Math.max(...prices),
    stationCount: prices.length,
  })).sort((a, b) => a.avg - b.avg);
}

/**
 * Get state-level price averages
 * @param {Merged[]} mergedData
 * @param {'regular'|'premium'|'diesel'} fuelType
 * @returns {Array<{state, avg, min, max, stationCount}>}
 */
export function getPricesByState(mergedData, fuelType) {
  const stateMap = new Map();
  for (const s of mergedData) {
    if (!s.hasData || s.prices?.[fuelType] == null) continue;
    if (!stateMap.has(s.state)) stateMap.set(s.state, []);
    stateMap.get(s.state).push(s.prices[fuelType]);
  }
  return [...stateMap.entries()].map(([state, prices]) => ({
    state,
    avg:          Math.round(prices.reduce((a, v) => a + v, 0) / prices.length * 100) / 100,
    min:          Math.min(...prices),
    max:          Math.max(...prices),
    stationCount: prices.length,
  })).sort((a, b) => a.avg - b.avg);
}

/**
 * Build a national summary for all three fuel types
 * @param {Merged[]} mergedData
 * @returns {Object}
 */
export function buildNationalSummary(mergedData) {
  const stationsWithData = mergedData.filter(s => s.hasData).length;
  return {
    date:             new Date().toISOString().slice(0, 10),
    regular:          getStats(mergedData, 'regular'),
    premium:          getStats(mergedData, 'premium'),
    diesel:           getStats(mergedData, 'diesel'),
    totalStations:    mergedData.length,
    stationsWithData,
    coveragePct:      mergedData.length
                        ? Math.round((stationsWithData / mergedData.length) * 100)
                        : 0,
  };
}
