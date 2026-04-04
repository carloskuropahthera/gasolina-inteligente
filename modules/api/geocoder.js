// MODULE: geocoder
// PURPOSE: Free geocoding via Nominatim + heuristic Spanish address normalizer
// DEPENDS ON: nothing (pure fetch, no API key)

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const CACHE = new Map(); // normalized query → result

// ─── Heuristic Normalizer ─────────────────────────────────────────────────

const FILLER_WORDS = [
  'cerca de', 'cerca del', 'junto al', 'junto a', 'por la', 'por el',
  'a un lado de', 'a un lado del', 'frente al', 'frente a',
  'esquina con', 'esquina de', 'pasando el', 'pasando la',
  'detras de', 'detrás de', 'antes de', 'despues de', 'después de',
  'entre', 'por', 'sobre',
];

const ABBREVS = {
  'cdmx':  'Ciudad de México',
  'mty':   'Monterrey',
  'gdl':   'Guadalajara',
  'gda':   'Guadalajara',
  'col\\.': 'Colonia',
  'col ':  'Colonia ',
  'av\\.':  'Avenida',
  'blvd\\.':'Boulevard',
  'carr\\.':'Carretera',
  'fracc\\.':'Fraccionamiento',
  'edif\\.': 'Edificio',
  'desp':  'Despachador',
};

/**
 * Generate 1-3 geocodable query strings from raw user input.
 * @param {string} raw
 * @returns {string[]}
 */
export function normalize(raw) {
  if (!raw || !raw.trim()) return [];

  let s = raw.toLowerCase().trim();

  // 5-digit postal code shortcut
  if (/^\d{5}$/.test(s)) {
    return [`CP ${s}, México`];
  }

  // Strip filler words
  for (const filler of FILLER_WORDS) {
    s = s.replace(new RegExp(`\\b${filler}\\s+`, 'gi'), '');
  }

  // Expand abbreviations
  for (const [abbr, full] of Object.entries(ABBREVS)) {
    s = s.replace(new RegExp(abbr, 'gi'), full);
  }

  // Normalize whitespace
  s = s.replace(/\s+/g, ' ').trim();

  // Remove trailing commas/periods
  s = s.replace(/[,\.]+$/, '').trim();

  // Generate candidates by progressively dropping leading tokens
  const candidates = [s + ', México'];
  const words = s.split(',').map(p => p.trim()).filter(Boolean);
  if (words.length > 1) {
    candidates.push(words.slice(1).join(', ') + ', México');
  }
  if (words.length > 2) {
    candidates.push(words.slice(2).join(', ') + ', México');
  }

  // Deduplicate
  return [...new Set(candidates)];
}

// ─── Nominatim Lookup ─────────────────────────────────────────────────────

const RATE_LIMIT_MS = 1000; // Nominatim: max 1 req/s
let _lastRequestTime = 0;

async function _nominatimSearch(query) {
  const cacheKey = query.toLowerCase();
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  // Rate limiting
  const now = Date.now();
  const wait = RATE_LIMIT_MS - (now - _lastRequestTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRequestTime = Date.now();

  const url = `${NOMINATIM}/search?` + new URLSearchParams({
    q: query,
    format: 'json',
    countrycodes: 'mx',
    limit: '3',
    addressdetails: '1',
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept-Language': 'es', 'User-Agent': 'GasolinaInteligente/1.0' },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    const result = data.length > 0
      ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), displayName: data[0].display_name }
      : null;
    CACHE.set(cacheKey, result);
    return result;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

/**
 * Geocode a single query string.
 * @param {string} query
 * @returns {Promise<{lat: number, lng: number, displayName: string} | null>}
 */
export async function geocode(query) {
  const candidates = normalize(query);
  for (const candidate of candidates) {
    const result = await _nominatimSearch(candidate);
    if (result) return result;
  }
  return null;
}

/**
 * Get typeahead suggestions for an input string (up to 5).
 * @param {string} query
 * @returns {Promise<Array<{label: string, lat: number, lng: number}>>}
 */
export async function suggest(query) {
  if (!query || query.trim().length < 3) return [];

  const candidates = normalize(query);
  const results = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const cacheKey = candidate.toLowerCase();
    if (CACHE.has(cacheKey)) {
      const cached = CACHE.get(cacheKey);
      if (cached && !seen.has(cached.displayName)) {
        seen.add(cached.displayName);
        results.push({ label: _shortLabel(cached.displayName), lat: cached.lat, lng: cached.lng });
      }
      continue;
    }

    // Rate limiting between candidates
    const now = Date.now();
    const wait = RATE_LIMIT_MS - (now - _lastRequestTime);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastRequestTime = Date.now();

    const url = `${NOMINATIM}/search?` + new URLSearchParams({
      q: candidate,
      format: 'json',
      countrycodes: 'mx',
      limit: '3',
      addressdetails: '1',
    });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept-Language': 'es', 'User-Agent': 'GasolinaInteligente/1.0' },
      });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of data) {
        if (!seen.has(item.display_name)) {
          seen.add(item.display_name);
          const r = { lat: parseFloat(item.lat), lng: parseFloat(item.lon), displayName: item.display_name };
          CACHE.set(cacheKey, r);
          results.push({ label: _shortLabel(item.display_name), lat: r.lat, lng: r.lng });
        }
      }
    } catch { /* network error — skip */ }

    if (results.length >= 5) break;
  }

  return results.slice(0, 5);
}

function _shortLabel(displayName) {
  // Trim to first 3 comma-separated segments
  return displayName.split(',').slice(0, 3).map(s => s.trim()).join(', ');
}
