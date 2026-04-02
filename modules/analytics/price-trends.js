// MODULE: price-trends
// PURPOSE: Historical price trend analysis from stored snapshots
// DEPENDS ON: storage-interface, logger

import * as storage     from '../storage/storage-interface.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('price-trends');

/**
 * Get daily national average prices for each fuel type over N days
 * @param {number} [days=30]
 * @returns {Promise<Array<{date, regular, premium, diesel}>>}
 */
export async function getDailyNationalAvg(days = 30) {
  const dates  = await storage.listSnapshots();
  const recent = dates.slice(0, days);
  const result = [];

  for (const date of recent) {
    const snap = await storage.getSnapshot(date);
    if (!snap?.stations) continue;

    const withData = snap.stations.filter(s => s.hasData && s.prices);
    const avg = (ft) => {
      const vals = withData.map(s => s.prices?.[ft]).filter(v => v != null);
      if (vals.length === 0) return null;
      return Math.round(vals.reduce((a, v) => a + v, 0) / vals.length * 100) / 100;
    };

    result.push({
      date,
      regular: avg('regular'),
      premium: avg('premium'),
      diesel:  avg('diesel'),
    });
  }

  return result.reverse(); // oldest → newest
}

/**
 * Compute a simple moving average over a price series
 * @param {Array<{date: string, price: number}>} series
 * @param {number} [window=7]
 * @returns {Array<{date: string, price: number, ma: number}>}
 */
export function getMovingAverage(series, window = 7) {
  return series.map((point, i) => {
    const start  = Math.max(0, i - window + 1);
    const slice  = series.slice(start, i + 1);
    const avg    = slice.reduce((s, p) => s + p.price, 0) / slice.length;
    return { ...point, ma: Math.round(avg * 100) / 100 };
  });
}

/**
 * Detect price trend direction using linear regression slope over last 7 days
 * @param {Array<{price: number}>} series - chronological array
 * @returns {'rising'|'falling'|'stable'}
 */
export function detectTrendDirection(series) {
  const recent = series.slice(-7);
  if (recent.length < 3) return 'stable';

  const n   = recent.length;
  const xs  = recent.map((_, i) => i);
  const ys  = recent.map(p => p.price);
  const xm  = xs.reduce((a, v) => a + v, 0) / n;
  const ym  = ys.reduce((a, v) => a + v, 0) / n;

  const num = xs.reduce((s, x, i) => s + (x - xm) * (ys[i] - ym), 0);
  const den = xs.reduce((s, x) => s + (x - xm)**2, 0);
  if (den === 0) return 'stable';

  const slope = num / den;
  if (slope >  0.02) return 'rising';
  if (slope < -0.02) return 'falling';
  return 'stable';
}

/**
 * Compute price volatility (stdDev) for a station over N days
 * @param {string} stationId
 * @param {'regular'|'premium'|'diesel'} fuelType
 * @param {number} [days=30]
 * @returns {Promise<number>} standard deviation in MXN
 */
export async function getPriceVolatility(stationId, fuelType, days = 30) {
  const dates = await storage.listSnapshots();
  const recent = dates.slice(0, days);
  const prices = [];

  for (const date of recent) {
    const snap = await storage.getSnapshot(date);
    const st   = snap?.stations?.find(s => s.id === stationId);
    if (st?.prices?.[fuelType] != null) prices.push(st.prices[fuelType]);
  }

  if (prices.length < 2) return 0;
  const avg = prices.reduce((s, v) => s + v, 0) / prices.length;
  const variance = prices.reduce((s, v) => s + (v - avg)**2, 0) / prices.length;
  return Math.round(Math.sqrt(variance) * 1000) / 1000;
}

/**
 * Get average price by day of week for a station
 * @param {string} stationId
 * @param {'regular'|'premium'|'diesel'} fuelType
 * @returns {Promise<Array<{dayOfWeek: number, avgPrice: number}>>}
 */
export async function getWeeklyPattern(stationId, fuelType) {
  const dates   = await storage.listSnapshots();
  const byDay   = new Map([0,1,2,3,4,5,6].map(d => [d, []]));

  for (const date of dates) {
    const snap = await storage.getSnapshot(date);
    const st   = snap?.stations?.find(s => s.id === stationId);
    if (st?.prices?.[fuelType] == null) continue;

    const day = new Date(date + 'T00:00:00').getDay();
    byDay.get(day).push(st.prices[fuelType]);
  }

  return [...byDay.entries()].map(([dayOfWeek, prices]) => ({
    dayOfWeek,
    avgPrice: prices.length
      ? Math.round(prices.reduce((s, v) => s + v, 0) / prices.length * 100) / 100
      : null,
  }));
}

/**
 * Get stations that improved the most in price since one week ago
 * @param {Merged[]} today
 * @param {Merged[]} weekAgo
 * @param {'regular'|'premium'|'diesel'} fuelType
 * @param {number} [limit=10]
 * @returns {Array<{station, change}>}
 */
export function getMostImprovedStations(today, weekAgo, fuelType, limit = 10) {
  return _priceChanges(today, weekAgo, fuelType)
    .filter(r => r.change < 0)
    .sort((a, b) => a.change - b.change)
    .slice(0, limit);
}

/**
 * Get stations that worsened (increased) the most in price
 * @param {Merged[]} today
 * @param {Merged[]} weekAgo
 * @param {'regular'|'premium'|'diesel'} fuelType
 * @param {number} [limit=10]
 */
export function getMostWorsenedStations(today, weekAgo, fuelType, limit = 10) {
  return _priceChanges(today, weekAgo, fuelType)
    .filter(r => r.change > 0)
    .sort((a, b) => b.change - a.change)
    .slice(0, limit);
}

function _priceChanges(today, weekAgo, fuelType) {
  const weekMap = new Map(weekAgo.map(s => [s.id, s]));
  const result  = [];

  for (const station of today) {
    if (!station.hasData || !station.prices?.[fuelType]) continue;
    const prev = weekMap.get(station.id);
    if (!prev?.hasData || !prev.prices?.[fuelType]) continue;

    const change = Math.round((station.prices[fuelType] - prev.prices[fuelType]) * 100) / 100;
    result.push({ station, change });
  }
  return result;
}
