// MODULE: distance-generator
// PURPOSE: One-time pre-computation of station pair distance matrices using grid-cell spatial index
// DEPENDS ON: logger, helpers, state

import { createLogger }          from '../utils/logger.js';
import { roundKm, arrayToCSV, downloadCSV, downloadJSON } from '../utils/helpers.js';
import { setState }              from '../utils/state.js';

const log = createLogger('distance-generator');

// Haversine formula — returns km
function haversine(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat/2)**2 +
               Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Manhattan road-distance proxy
function manhattan(lat1, lng1, lat2, lng2) {
  const avgLat   = (lat1 + lat2) / 2;
  const kmPerLat = 111.32;
  const kmPerLng = 111.32 * Math.cos(avgLat * Math.PI / 180);
  return Math.abs(lat1 - lat2) * kmPerLat + Math.abs(lng1 - lng2) * kmPerLng;
}

// Grid cell size in degrees (~0.45° ≈ 50km at Mexico latitudes)
const CELL_DEG = 0.45;

function cellKey(lat, lng) {
  return `${Math.floor(lat / CELL_DEG)},${Math.floor(lng / CELL_DEG)}`;
}

function buildGrid(stations) {
  const grid = new Map();
  for (const s of stations) {
    const key = cellKey(s.lat, s.lng);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(s);
  }
  return grid;
}

function neighborCells(lat, lng) {
  const cellLat = Math.floor(lat / CELL_DEG);
  const cellLng = Math.floor(lng / CELL_DEG);
  const cells   = [];
  for (let dlat = -1; dlat <= 1; dlat++) {
    for (let dlng = -1; dlng <= 1; dlng++) {
      cells.push(`${cellLat + dlat},${cellLng + dlng}`);
    }
  }
  return cells;
}

const CSV_HEADERS = ['ID_A','ID_B','CRE_ID_A','CRE_ID_B','haversine_km','manhattan_approx_km'];

/**
 * Generate the distance matrix for a given radius and trigger a CSV download.
 * Uses grid-cell spatial index to avoid O(n²) brute force.
 *
 * @param {Station[]} stations
 * @param {number} radiusKm - 5, 20, or 50
 * @param {Function} [onProgress] - (processed, total, pairsFound) callback
 * @returns {Promise<{pairCount: number, durationMs: number}>}
 */
export async function generateMatrix(stations, radiusKm, onProgress) {
  const start = Date.now();
  log.info(`Starting ${radiusKm}km matrix for ${stations.length} stations…`);

  const grid  = buildGrid(stations);
  const rows  = [];
  let   pairs = 0;
  let   processed = 0;
  const total = stations.length;

  // Add self-pairs (distance = 0) — required for Power BI / analytics compatibility
  for (const s of stations) {
    rows.push({
      ID_A: s.id, ID_B: s.id,
      CRE_ID_A: s.creId ?? s.id, CRE_ID_B: s.creId ?? s.id,
      haversine_km: 0, manhattan_approx_km: 0,
    });
    pairs++;
  }

  // Process each station, looking only at neighboring grid cells
  for (const stationA of stations) {
    const cells    = neighborCells(stationA.lat, stationA.lng);
    const checked  = new Set();

    for (const cellKey of cells) {
      const cellStations = grid.get(cellKey) ?? [];
      for (const stationB of cellStations) {
        if (stationB.id === stationA.id) continue;       // skip self
        if (checked.has(stationB.id)) continue;           // deduplicate
        checked.add(stationB.id);

        const hav = roundKm(haversine(stationA.lat, stationA.lng, stationB.lat, stationB.lng));
        if (hav > radiusKm) continue;

        const man = roundKm(manhattan(stationA.lat, stationA.lng, stationB.lat, stationB.lng));
        rows.push({
          ID_A: stationA.id, ID_B: stationB.id,
          CRE_ID_A: stationA.creId ?? stationA.id,
          CRE_ID_B: stationB.creId ?? stationB.id,
          haversine_km: hav, manhattan_approx_km: man,
        });
        pairs++;
      }
    }

    processed++;
    if (processed % 50 === 0 || processed === total) {
      const pct = Math.round((processed / total) * 100);
      const msg = `Processing station ${processed}/${total} (${pct}%) — ${pairs} pairs found`;
      log.debug(msg);
      setState({ loadingMessage: msg });
      onProgress && onProgress(processed, total, pairs);

      // Yield to browser event loop every 50 stations
      await new Promise(r => setTimeout(r, 0));
    }
  }

  const durationMs = Date.now() - start;
  log.info(`${radiusKm}km matrix complete: ${pairs} pairs in ${(durationMs/1000).toFixed(1)}s`);

  // Download CSV
  const csv      = arrayToCSV(rows, CSV_HEADERS);
  const filename = `stations_within_${radiusKm}km.csv`;
  downloadCSV(filename, csv);
  log.info(`Downloaded ${filename} (${(csv.length/1024).toFixed(0)}KB)`);

  return { pairCount: pairs, durationMs };
}

/**
 * Generate all three matrices (5km, 20km, 50km) and the summary JSON.
 * @param {Station[]} stations
 * @param {Function} [onProgress]
 * @returns {Promise<Object>} summary metadata
 */
export async function generateAllMatrices(stations, onProgress) {
  const generatedAt = new Date().toISOString();
  const results     = {};

  for (const radius of [5, 20, 50]) {
    setState({ loadingMessage: `Generating ${radius}km matrix…` });
    results[radius] = await generateMatrix(stations, radius, onProgress);
  }

  const summary = {
    generatedAt,
    stationCount:   stations.length,
    pairCount_5km:  results[5].pairCount,
    pairCount_20km: results[20].pairCount,
    pairCount_50km: results[50].pairCount,
    coveragePercent: Math.round(
      (stations.filter(s => s.lat && s.lng).length / stations.length) * 100
    ),
    generationTimeMs: results[5].durationMs + results[20].durationMs + results[50].durationMs,
  };

  downloadJSON('distance_matrix_summary.json', summary);
  log.info('All matrices generated', summary);
  return summary;
}

/**
 * Estimate generation time in seconds for a given station count and radius
 * @param {number} stationCount
 * @param {number} radiusKm
 * @returns {number} estimated seconds
 */
export function estimateGenerationTime(stationCount, radiusKm) {
  // Empirical estimate: roughly O(n × neighborDensity)
  const baseMs = { 5: 30, 20: 120, 50: 480 };
  const scale  = (stationCount / 12000);
  return Math.round(baseMs[radiusKm] * scale);
}
