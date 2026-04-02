// MODULE: anomaly-detector
// PURPOSE: Spatial price anomaly detection using Z-score and IQR vs local neighborhood
// DEPENDS ON: geo, logger

import { getNearbyById }  from '../data/geo.js';
import { createLogger }   from '../utils/logger.js';
import { percentile }     from '../utils/helpers.js';

const log = createLogger('anomaly-detector');

// Spatial neighborhood radius used for local comparisons.
// 10 km captures the relevant competitive market around each station in
// Mexican urban areas without crossing into distinct regional price zones.
const DEFAULT_RADIUS_KM  = 10;

// Z-score threshold for anomaly flagging.
// 1.5 standard deviations flags ~13% of a normal distribution — intentionally
// sensitive so borderline outliers surface for human review before they become
// data-quality problems.
const DEFAULT_THRESHOLD  = 1.5;

/**
 * Classify anomaly severity by absolute Z-score.
 *
 * Severity thresholds:
 *   mild     — |z| ≤ 2.0  — worth noting; ~5% of normal distribution tail
 *   moderate — 2.0 < |z| ≤ 3.0 — likely real anomaly; ~0.3% tail
 *   severe   — |z| > 3.0  — strong outlier; likely data error or extreme pricing
 *
 * @param {number} zScore
 * @returns {'mild'|'moderate'|'severe'}
 */
export function classifySeverity(zScore) {
  const abs = Math.abs(zScore);
  if (abs > 3.0)  return 'severe';
  if (abs > 2.0)  return 'moderate';
  return 'mild';
}

/**
 * Detect price anomalies among stations vs their local neighborhood.
 *
 * Dual-method detection (method = 'both'):
 *   Z-score — measures how many standard deviations a station's price lies
 *             from the local neighborhood mean.  Fast and intuitive but
 *             sensitive to skewed distributions.
 *   IQR     — flags prices outside [Q1 − 1.5·IQR, Q3 + 1.5·IQR].  Robust
 *             to outliers in the neighbor set itself (e.g. one extreme neighbor
 *             won't inflate the mean).
 * Using both methods gives higher recall than either alone: a price only needs
 * to be flagged by ONE method to be included in results.
 *
 * @param {Merged[]} mergedData
 * @param {'regular'|'premium'|'diesel'} fuelType
 * @param {{ method?: 'zscore'|'iqr'|'both', threshold?: number, radiusKm?: number }} [options]
 * @returns {Anomaly[]}
 */
export function detectAnomalies(mergedData, fuelType, options = {}) {
  const {
    method    = 'both',
    threshold = DEFAULT_THRESHOLD,
    radiusKm  = DEFAULT_RADIUS_KM,
  } = options;

  const withPrices = mergedData.filter(s => s.hasData && s.prices?.[fuelType] != null);
  if (withPrices.length < 3) {
    log.warn(`Too few stations with ${fuelType} prices (${withPrices.length}) for anomaly detection`);
    return [];
  }

  const anomalies = [];

  for (const station of withPrices) {
    const price = station.prices[fuelType];

    // Get neighbors from matrix (or real-time haversine fallback)
    const neighborRefs = getNearbyById(station.id, mergedData, radiusKm);

    // Resolve neighbor IDs to full station objects with prices
    const neighborData = neighborRefs
      .map(ref => mergedData.find(s => s.id === ref.stationId))
      .filter(s => s?.hasData && s.prices?.[fuelType] != null);

    if (neighborData.length < 2) continue; // not enough local context

    const neighborPrices = neighborData.map(s => s.prices[fuelType]);
    const localAvg = neighborPrices.reduce((a, v) => a + v, 0) / neighborPrices.length;
    const localStdDev = Math.sqrt(
      neighborPrices.reduce((s, v) => s + (v - localAvg)**2, 0) / neighborPrices.length
    );

    let isAnomaly = false;
    let zScore    = 0;

    // Z-score method
    if (method === 'zscore' || method === 'both') {
      if (localStdDev > 0) {
        zScore = (price - localAvg) / localStdDev;
        if (Math.abs(zScore) >= threshold) isAnomaly = true;
      }
      // When stdDev is 0 all neighbors share the exact same price.
      // A station is an anomaly only if its price actually differs from that
      // consensus; we measure the deviation as a percentage of the local avg.
      else if (price === localAvg) {
        zScore = 0; // identical to all neighbors — not an anomaly
      } else {
        const pctDiff = Math.abs(price - localAvg) / localAvg;
        // Flag as anomaly if the price deviates more than 5% from the
        // perfectly uniform neighborhood.  Use threshold+1 so it lands in
        // the 'moderate' severity bucket (abs > 2.0) rather than 'mild'.
        zScore = pctDiff > 0.05
          ? (price > localAvg ? threshold + 1 : -(threshold + 1))
          : 0;
        if (Math.abs(zScore) >= threshold) isAnomaly = true;
      }
    }

    // IQR method
    if ((method === 'iqr' || method === 'both') && !isAnomaly) {
      const sorted = [...neighborPrices].sort((a, b) => a - b);
      const q1     = percentile(sorted, 25);
      const q3     = percentile(sorted, 75);
      const iqr    = q3 - q1;
      const lower  = q1 - 1.5 * iqr;
      const upper  = q3 + 1.5 * iqr;
      if (price < lower || price > upper) {
        isAnomaly = true;
        // Compute z-score for severity classification
        if (localStdDev > 0) {
          zScore = (price - localAvg) / localStdDev;
        } else if (price === localAvg) {
          zScore = 0; // IQR fence triggered but price equals avg — treat as mild
        } else {
          // All neighbors identical; use percentage deviation to size the score
          const pctDiff = Math.abs(price - localAvg) / localAvg;
          zScore = pctDiff > 0.05
            ? (price > localAvg ? threshold + 1 : -(threshold + 1))
            : (price > localAvg ? threshold : -threshold);
        }
      }
    }

    if (isAnomaly) {
      anomalies.push({
        stationId:        station.id,
        name:             station.name,
        brand:            station.brand,
        city:             station.city,
        state:            station.state,
        fuelType,
        price:            Math.round(price * 100) / 100,
        localAvg:         Math.round(localAvg * 100) / 100,
        zScore:           Math.round(zScore * 100) / 100,
        direction:        zScore > 0 ? 'high' : 'low',
        nearbyCount:      neighborData.length,
        severity:         classifySeverity(zScore),
      });
    }
  }

  // Sort by severity then absolute z-score
  const severityOrder = { severe: 0, moderate: 1, mild: 2 };
  anomalies.sort((a, b) => {
    const sd = severityOrder[a.severity] - severityOrder[b.severity];
    if (sd !== 0) return sd;
    const zd = Math.abs(b.zScore) - Math.abs(a.zScore);
    if (zd !== 0) return zd;
    return a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0;
  });

  log.info(`Anomaly detection (${fuelType}): ${anomalies.length} anomalies found`);
  return anomalies;
}

/**
 * Summarize anomaly results
 * @param {Anomaly[]} anomalies
 * @returns {Object}
 */
export function getAnomalySummary(anomalies) {
  const byCity  = new Map();
  const byBrand = new Map();

  for (const a of anomalies) {
    byCity.set(a.city, (byCity.get(a.city) ?? 0) + 1);
    byBrand.set(a.brand, (byBrand.get(a.brand) ?? 0) + 1);
  }

  return {
    total:       anomalies.length,
    highPricers: anomalies.filter(a => a.direction === 'high').length,
    lowPricers:  anomalies.filter(a => a.direction === 'low').length,
    byCity:      [...byCity.entries()]
                   .map(([city, count]) => ({ city, count }))
                   .sort((a, b) => b.count - a.count),
    byBrand:     [...byBrand.entries()]
                   .map(([brand, count]) => ({ brand, count }))
                   .sort((a, b) => b.count - a.count),
    severityCounts: {
      mild:     anomalies.filter(a => a.severity === 'mild').length,
      moderate: anomalies.filter(a => a.severity === 'moderate').length,
      severe:   anomalies.filter(a => a.severity === 'severe').length,
    },
  };
}
