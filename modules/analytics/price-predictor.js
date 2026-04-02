// MODULE: price-predictor
// PURPOSE: Price prediction from historical snapshots using linear regression
// DEPENDS ON: price-trends, prices, storage-interface, logger
// NOTE: Predictions improve significantly after 30+ days of historical data.
//       With <7 days, results will be extrapolations of a very short trend.

import { getPriceHistory }     from '../data/prices.js';
import { getDailyNationalAvg, detectTrendDirection } from './price-trends.js';
import { createLogger }        from '../utils/logger.js';

const log = createLogger('price-predictor');

// Mexican public holiday dates (YYYY-MM-DD) — prices typically rise 5–15% on long weekends
// Source: Ley Federal del Trabajo Art. 74 + SEP calendar
const MX_HOLIDAYS = [
  '01-01', // Año Nuevo
  '02-03', // Día de la Constitución (1st Mon Feb)
  '03-17', // Natalicio de Benito Juárez (3rd Mon Mar)
  '04-02', // Jueves Santo (variable — approximate)
  '04-03', // Viernes Santo (variable — approximate)
  '05-01', // Día del Trabajo
  '09-16', // Día de la Independencia
  '11-02', // Día de los Muertos (semi-official)
  '11-17', // Revolución Mexicana (3rd Mon Nov)
  '12-12', // Día de la Virgen de Guadalupe
  '12-24', // Nochebuena (unofficial)
  '12-25', // Navidad
  '12-31', // Nochevieja
];

// Price typically rises 3–10 days before major holidays as demand spikes
const HOLIDAY_LOOKAHEAD_DAYS = 7;

/**
 * Simple linear regression over a price series.
 * Returns slope (MXN/day) and predicted next-day value.
 * @param {Array<{price: number}>} series - chronological, oldest first
 * @returns {{ slope: number, nextDay: number, r2: number }}
 */
function linearRegression(series) {
  const n  = series.length;
  if (n < 2) return { slope: 0, nextDay: series[0]?.price ?? 0, r2: 0 };

  const xs = series.map((_, i) => i);
  const ys = series.map(p => p.price);
  const xm = xs.reduce((a, v) => a + v, 0) / n;
  const ym = ys.reduce((a, v) => a + v, 0) / n;

  const ssxy = xs.reduce((s, x, i) => s + (x - xm) * (ys[i] - ym), 0);
  const ssx  = xs.reduce((s, x) => s + (x - xm) ** 2, 0);
  if (ssx === 0) return { slope: 0, nextDay: ym, r2: 0 };

  const slope   = ssxy / ssx;
  const intercept = ym - slope * xm;
  const nextDay   = intercept + slope * n;

  // R² — how well the line fits
  const ssTot = ys.reduce((s, y) => s + (y - ym) ** 2, 0);
  const ssRes = ys.reduce((s, y, i) => s + (y - (intercept + slope * xs[i])) ** 2, 0);
  const r2    = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);

  return { slope: Math.round(slope * 10000) / 10000, nextDay: Math.round(nextDay * 100) / 100, r2: Math.round(r2 * 1000) / 1000 };
}

/**
 * Predict tomorrow's price for a specific station and fuel type.
 * Uses linear regression on recent price history.
 *
 * @param {string} stationId
 * @param {'regular'|'premium'|'diesel'} fuelType
 * @param {number} [lookbackDays=30]
 * @returns {Promise<{ predicted: number, confidence: number, trend: 'rising'|'falling'|'stable', dataPoints: number }>}
 */
export async function predictTomorrowPrice(stationId, fuelType, lookbackDays = 30) {
  const history = await getPriceHistory(stationId, fuelType, lookbackDays);

  if (history.length === 0) {
    log.warn(`predictTomorrowPrice: no history for ${stationId} / ${fuelType}`);
    return { predicted: null, confidence: 0, trend: 'stable', dataPoints: 0 };
  }

  const trend = detectTrendDirection(history);
  const reg   = linearRegression(history);

  // Confidence: function of R² + data density (more points → more confident)
  // Max confidence is 0.80 — we don't claim near-certainty on fuel prices
  const dataDensityScore = Math.min(1, history.length / 30);
  const confidence       = Math.round(reg.r2 * dataDensityScore * 0.80 * 100) / 100;

  log.debug(`Prediction for ${stationId}/${fuelType}: $${reg.nextDay} (trend: ${trend}, confidence: ${confidence}, n=${history.length})`);

  return {
    predicted:  reg.nextDay,
    confidence,
    trend,
    slope:      reg.slope,
    r2:         reg.r2,
    dataPoints: history.length,
    lastPrice:  history[history.length - 1]?.price ?? null,
  };
}

/**
 * Predict the weekly average price for a state and fuel type.
 * Uses national daily averages filtered to the state, then projects 7 days.
 *
 * @param {string} state - e.g. "Ciudad de México"
 * @param {'regular'|'premium'|'diesel'} fuelType
 * @param {Merged[]} mergedData - current station dataset (for state filtering)
 * @returns {Promise<{ avgPredicted: number, weekStart: string, weekEnd: string, trend: string, dataPoints: number }>}
 */
export async function predictWeeklyAvg(state, fuelType, mergedData = []) {
  // Build price series from stations in the given state
  const stateStations = mergedData.filter(s => s.state === state && s.hasData && s.prices?.[fuelType] != null);

  if (stateStations.length === 0) {
    log.warn(`predictWeeklyAvg: no stations for state=${state}`);
    return { avgPredicted: null, weekStart: null, weekEnd: null, trend: 'stable', dataPoints: 0 };
  }

  // Use the national daily averages as the trend proxy (state-level would need more snapshots)
  const dailyAvg = await getDailyNationalAvg(30);
  const series   = dailyAvg.filter(d => d[fuelType] != null).map(d => ({ date: d.date, price: d[fuelType] }));

  if (series.length < 3) {
    // Fall back to current state average if not enough history
    const prices    = stateStations.map(s => s.prices[fuelType]);
    const currentAvg = Math.round(prices.reduce((s, v) => s + v, 0) / prices.length * 100) / 100;
    return { avgPredicted: currentAvg, weekStart: null, weekEnd: null, trend: 'stable', dataPoints: 0 };
  }

  const trend   = detectTrendDirection(series);
  const reg     = linearRegression(series);
  // Project 3.5 days out (midpoint of next week) for the weekly avg
  const midWeek = Math.round((reg.nextDay + reg.nextDay + reg.slope * 7) / 2 * 100) / 100;

  const weekStart = _addDays(new Date(), 1).toISOString().slice(0, 10);
  const weekEnd   = _addDays(new Date(), 7).toISOString().slice(0, 10);

  return { avgPredicted: midWeek, weekStart, weekEnd, trend, dataPoints: series.length };
}

/**
 * Check for upcoming seasonal price pressure.
 * Mexican holiday weekends typically see 5–15% price spikes from increased road traffic.
 *
 * @param {string} [date] - ISO date to check (defaults to today)
 * @returns {{ hasAlert: boolean, daysUntilHoliday?: number, holidayName?: string, estimatedIncreasePct?: number, severity: 'none'|'low'|'medium'|'high' }}
 */
export function getSeasonalAlert(date) {
  const checkDate = date ? new Date(date + 'T00:00:00') : new Date();
  const mmdd      = `${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;

  const HOLIDAY_NAMES = {
    '01-01': 'Año Nuevo',
    '02-03': 'Día de la Constitución',
    '03-17': 'Natalicio de Benito Juárez',
    '04-02': 'Semana Santa',
    '04-03': 'Semana Santa',
    '05-01': 'Día del Trabajo',
    '09-16': 'Día de la Independencia',
    '11-02': 'Día de los Muertos',
    '11-17': 'Revolución Mexicana',
    '12-12': 'Día de la Virgen',
    '12-24': 'Nochebuena',
    '12-25': 'Navidad',
    '12-31': 'Nochevieja',
  };

  // Check each holiday — look for one within lookahead window
  for (const holiday of MX_HOLIDAYS) {
    const [hMonth, hDay] = holiday.split('-').map(Number);
    const year       = checkDate.getFullYear();
    const holidayDate = new Date(year, hMonth - 1, hDay);

    // Also check next year if holiday has passed
    if (holidayDate < checkDate) holidayDate.setFullYear(year + 1);

    const daysUntil = Math.round((holidayDate - checkDate) / (1000 * 60 * 60 * 24));
    if (daysUntil >= 0 && daysUntil <= HOLIDAY_LOOKAHEAD_DAYS) {
      const severity = daysUntil <= 2 ? 'high' : daysUntil <= 4 ? 'medium' : 'low';
      const pct      = severity === 'high' ? 12 : severity === 'medium' ? 8 : 5;
      return {
        hasAlert:            true,
        daysUntilHoliday:    daysUntil,
        holidayName:         HOLIDAY_NAMES[holiday] ?? 'Día festivo',
        estimatedIncreasePct: pct,
        severity,
        message: `⚠️ ${HOLIDAY_NAMES[holiday] ?? 'Día festivo'} en ${daysUntil} día${daysUntil !== 1 ? 's' : ''} — precios pueden subir ~${pct}%`,
      };
    }
  }

  return { hasAlert: false, severity: 'none' };
}

function _addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
