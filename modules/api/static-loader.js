// MODULE: static-loader
// PURPOSE: Load pre-built station data from static JSON produced by the Python pipeline
// DEPENDS ON: logger

import { createLogger } from '../utils/logger.js';

const log = createLogger('static-loader');

// Relative path from the web app root to the pipeline export
const STATIC_PATH = './data/stations_latest.json';

/**
 * Normalize a station record from pipeline export format to the JS app shape.
 * Handles both the old canonical_ prefix names and the new short aliases —
 * so this works whether the file was written by old or new export_for_app.py.
 */
function normalizeStation(raw) {
  const prices = raw.prices
    ? {
        regular:   raw.prices.regular   ?? raw.prices.gasolina_regular  ?? null,
        premium:   raw.prices.premium   ?? raw.prices.gasolina_premium  ?? null,
        diesel:    raw.prices.diesel    ?? null,
        updatedAt: raw.prices.updatedAt ?? raw.prices.updated_at        ?? null,
      }
    : null;

  const hasData = raw.hasData ??
    (prices != null && (prices.regular != null || prices.premium != null || prices.diesel != null));

  return {
    id:      String(raw.id      ?? raw.master_id          ?? ''),
    name:    raw.name    ?? raw.canonical_name             ?? '',
    brand:   raw.brand   ?? raw.canonical_brand            ?? 'OTRO',
    address: raw.address ?? raw.canonical_address          ?? '',
    city:    raw.city    ?? raw.canonical_municipality     ?? '',
    state:   raw.state   ?? raw.canonical_state            ?? '',
    zipCode: raw.zipCode ?? raw.canonical_zip              ?? '',
    lat:     parseFloat(raw.lat ?? 0),
    lng:     parseFloat(raw.lng ?? 0),
    prices,
    hasData,
    // pass through pipeline metadata if present
    pl_number:      raw.pl_number      ?? null,
    confidence:     raw.confidence     ?? null,
    primary_source: raw.primary_source ?? null,
  };
}

/**
 * Load pre-built station data from the static JSON file.
 * Returns null on failure so the caller can fall back to the live CRE API.
 *
 * @returns {Promise<{success: boolean, data: Merged[], meta: Object, error?: string}>}
 */
export async function loadStaticData() {
  try {
    const t0  = Date.now();
    // Cache-bust with today's date so the browser doesn't serve a stale placeholder
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const res = await fetch(`${STATIC_PATH}?v=${today}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();

    // Schema validation — catch drift between pipeline export format and JS app expectations
    if (typeof json !== 'object' || json === null) throw new Error('Invalid JSON: expected object');
    if (json.total === 0 || (Array.isArray(json.stations) && json.stations.length === 0)) {
      log.info('Static data file is empty placeholder — skipping');
      return { success: false, data: [], error: 'empty placeholder', meta: {} };
    }

    const raw      = json.stations ?? json.data ?? (Array.isArray(json) ? json : []);
    if (!Array.isArray(raw)) throw new Error('Invalid JSON: stations field is not an array');

    const stations = raw
      .map(normalizeStation)
      .filter(s => s.id && s.lat && s.lng);

    const ms = Date.now() - t0;
    log.info(`Static data loaded: ${stations.length} stations in ${ms}ms (exported ${json.exported_at ?? 'unknown'})`);

    return {
      success: true,
      data:    stations,
      meta: {
        source:     'static',
        count:      stations.length,
        exportedAt: json.exported_at ?? null,
        fetchMs:    ms,
      },
    };
  } catch (err) {
    log.info(`Static data unavailable (${err.message}) — will use live CRE API`);
    return { success: false, data: [], error: err.message, meta: {} };
  }
}
