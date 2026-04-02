// MODULE: matrix-loader
// PURPOSE: Load pre-computed distance CSVs into indexed in-memory structures for O(1) lookups
// DEPENDS ON: logger, state

import { createLogger } from '../utils/logger.js';
import { setState }     from '../utils/state.js';

const log = createLogger('matrix-loader');

// In-memory indexes: Map<stationId, Neighbor[]>
const indexes = {
  5:  null,
  20: null,
  50: null,
};
const stats = {
  5:  null,
  20: null,
  50: null,
};

/**
 * @typedef {{ stationId: string, distanceKm: number, manhattanKm: number }} Neighbor
 */

/**
 * Parse a CSV string into rows of objects using first-line headers
 * @param {string} csv
 * @returns {Object[]}
 */
function parseCSV(csv) {
  const lines   = csv.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim());
  const rows    = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = lines[i].split(',');
    const row  = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = vals[j]?.trim() ?? '';
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Build lookup index from parsed CSV rows
 * @param {Object[]} rows
 * @returns {Map<string, Neighbor[]>}
 */
function buildIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const idA  = row.ID_A;
    const idB  = row.ID_B;
    const hav  = parseFloat(row.haversine_km);
    const man  = parseFloat(row.manhattan_approx_km);

    if (!idA || idA === idB) continue; // skip self-pairs for neighbor lookups

    if (!index.has(idA)) index.set(idA, []);
    index.get(idA).push({ stationId: idB, distanceKm: hav, manhattanKm: man });
  }
  // Sort each neighbor list by distance ascending
  for (const [, neighbors] of index) {
    neighbors.sort((a, b) => a.distanceKm - b.distanceKm);
  }
  return index;
}

/**
 * Load a distance matrix CSV from the data/static directory.
 * Will silently succeed with null if the file doesn't exist.
 *
 * Distance matrix must be pre-generated via Dev Panel (Ctrl+Shift+D → Generate Matrix)
 * or via Python: python pipeline/scripts/seed.py --generate-matrix
 * Without it, anomaly detection falls back to O(n²) haversine — correct but slow
 * (expect ~200–500ms per detection pass for 10 000 stations vs <5ms with the matrix).
 *
 * @param {number} radiusKm - 5, 20, or 50
 * @returns {Promise<boolean>} true if loaded successfully
 */
export async function loadMatrix(radiusKm) {
  if (![5, 20, 50].includes(radiusKm)) throw new Error(`Invalid radius: ${radiusKm}`);

  const url   = `./data/static/stations_within_${radiusKm}km.csv`;
  const start = Date.now();

  try {
    log.info(`Loading ${radiusKm}km matrix from ${url}…`);
    const res = await fetch(url);
    if (!res.ok) {
      log.info(`${radiusKm}km matrix not found (HTTP ${res.status}) — will use real-time haversine`);
      return false;
    }

    const csv  = await res.text();
    const rows = parseCSV(csv);
    const idx  = buildIndex(rows);
    const ms   = Date.now() - start;

    indexes[radiusKm] = idx;
    stats[radiusKm] = {
      radiusKm,
      stationCount: idx.size,
      pairCount:    rows.length,
      loadedAt:     new Date().toISOString(),
      loadMs:       ms,
      sizeKB:       Math.round(csv.length / 1024),
    };

    log.info(`${radiusKm}km matrix loaded: ${idx.size} stations, ${rows.length} pairs in ${ms}ms`);

    // Update global state with 5km matrix loaded flag
    if (radiusKm === 5) {
      setState({ distanceMatrixLoaded: true, distanceMatrixStats: stats[5] });
    }
    return true;
  } catch (err) {
    log.warn(`Could not load ${radiusKm}km matrix: ${err.message}`);
    return false;
  }
}

/**
 * Get nearby stations for a given station ID from the pre-computed index
 * @param {string} stationId
 * @param {number} [radiusKm=5]
 * @returns {Neighbor[]} sorted by distance ascending, empty array if not found
 */
export function getNearby(stationId, radiusKm = 5) {
  const idx = indexes[radiusKm];
  if (!idx) return [];
  return idx.get(stationId) ?? [];
}

/**
 * Check if a matrix is loaded for a given radius
 * @param {number} radiusKm
 * @returns {boolean}
 */
export function isLoaded(radiusKm) {
  return indexes[radiusKm] !== null;
}

/**
 * Get statistics for a loaded matrix
 * @param {number} [radiusKm=5]
 * @returns {Object|null}
 */
export function getStats(radiusKm = 5) {
  return stats[radiusKm];
}

/**
 * Attempt to load the distance matrix summary JSON
 * @returns {Promise<Object|null>}
 */
export async function loadSummary() {
  try {
    const res = await fetch('./data/static/distance_matrix_summary.json');
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
