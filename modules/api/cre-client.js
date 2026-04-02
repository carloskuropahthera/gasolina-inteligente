// MODULE: cre-client
// PURPOSE: Single point of contact for all CRE government API calls
// DEPENDS ON: fetch-strategy, cache, logger

import { fetchWithStrategy } from './fetch-strategy.js';
import { createCache }       from './cache.js';
import { createLogger }      from '../utils/logger.js';

const log = createLogger('cre-client');

const PLACES_URL = 'https://publicacionexterna.azurewebsites.net/publicaciones/places';
const PRICES_URL = 'https://publicacionexterna.azurewebsites.net/publicaciones/prices';

const placesCache = createCache(24 * 60); // 24 hours
const pricesCache = createCache(60);      // 60 minutes

// ─── Normalizers ──────────────────────────────────────────────────────────

/**
 * Normalize a raw CRE place record into our Station shape
 * @param {Object} raw
 * @returns {Station}
 */
function normalizeStation(raw) {
  return {
    id:      String(raw.place_id   ?? raw.id ?? ''),
    creId:   String(raw.cre_id     ?? raw.place_id ?? raw.id ?? ''),
    name:    raw.name              ?? raw.nombre    ?? '',
    brand:   raw.brand             ?? raw.marca     ?? 'OTRO',
    address: raw.address           ?? raw.domicilio ?? '',
    city:    raw.municipality      ?? raw.municipio ?? raw.ciudad ?? '',
    state:   raw.state             ?? raw.estado    ?? '',
    zipCode: String(raw.zip_code   ?? raw.cp ?? ''),
    lat:     parseFloat(raw.latitude  ?? raw.lat ?? 0),
    lng:     parseFloat(raw.longitude ?? raw.lon ?? raw.lng ?? 0),
  };
}

/**
 * Normalize a raw CRE price record into our Price shape
 * @param {Object} raw
 * @returns {Price}
 */
function normalizePrice(raw) {
  return {
    stationId: String(raw.place_id ?? raw.id ?? ''),
    regular:   raw.regular  != null ? parseFloat(raw.regular)  : null,
    premium:   raw.premium  != null ? parseFloat(raw.premium)  : null,
    diesel:    raw.diesel   != null ? parseFloat(raw.diesel)   : null,
    updatedAt: raw.updated_at ?? new Date().toISOString(),
  };
}

// ─── XML Parser (CRE places endpoint returns XML) ─────────────────────────

/**
 * Parse the CRE places XML response into a plain array of objects
 * matching the same field names that normalizeStation() expects.
 *
 * XML shape:
 *   <places>
 *     <place place_id="2039">
 *       <name>...</name>
 *       <cre_id>PL/658/EXP/ES/2015</cre_id>
 *       <location><x>-116.92</x><y>32.47</y></location>
 *     </place>
 *   </places>
 *
 * Note: brand / address / city / state are absent from places XML —
 * they are merged in from the prices endpoint later.
 *
 * @param {string} xmlText
 * @returns {Array<Object>}
 */
function parseXMLPlaces(xmlText) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML in places response');
  const places = doc.querySelectorAll('place');
  const result = [];

  places.forEach(p => {
    const placeId = p.getAttribute('place_id') || '';
    const name    = p.querySelector('name')?.textContent?.trim()   || '';
    const creId   = p.querySelector('cre_id')?.textContent?.trim() || '';
    const x       = parseFloat(p.querySelector('location > x')?.textContent || '0'); // lng
    const y       = parseFloat(p.querySelector('location > y')?.textContent || '0'); // lat

    if (placeId && x && y) {
      result.push({ place_id: placeId, name, cre_id: creId, latitude: y, longitude: x });
    }
  });

  log.info(`Parsed ${result.length} places from CRE XML`);
  return result;
}

/**
 * Parse the CRE prices XML response into a plain array of objects
 * matching what normalizePrice() expects.
 *
 * XML shape:
 *   <places>
 *     <place place_id="11703">
 *       <gas_price type="regular">22.95</gas_price>
 *       <gas_price type="premium">26.55</gas_price>
 *     </place>
 *   </places>
 *
 * A single place_id can appear multiple times; we merge all its gas_price
 * elements into one record.
 *
 * @param {string} xmlText
 * @returns {Array<Object>}
 */
function parseXMLPrices(xmlText) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML in prices response');
  const places = doc.querySelectorAll('place');
  const byId   = new Map();

  places.forEach(p => {
    const placeId = p.getAttribute('place_id') || '';
    if (!placeId) return;

    if (!byId.has(placeId)) byId.set(placeId, { place_id: placeId });
    const rec = byId.get(placeId);

    p.querySelectorAll('gas_price').forEach(gp => {
      const type = gp.getAttribute('type');
      const val  = parseFloat(gp.textContent);
      if (type && !isNaN(val)) rec[type] = val;
    });
  });

  const result = Array.from(byId.values());
  log.info(`Parsed ${result.length} price records from CRE XML`);
  return result;
}

// ─── API Fetchers ─────────────────────────────────────────────────────────

/**
 * Fetch all gas station locations from CRE
 * @param {boolean} [useMock=false]
 * @returns {Promise<{success: boolean, data: Station[], meta: Object, error?: string}>}
 */
export async function fetchStations(useMock = false) {
  const cacheKey = 'stations';
  if (placesCache.has(cacheKey)) {
    const data = placesCache.get(cacheKey);
    log.info(`Stations from cache (${data.length})`);
    return { success: true, data, meta: { source: 'cache', count: data.length } };
  }

  if (useMock) {
    const data = MOCK_STATIONS;
    placesCache.set(cacheKey, data);
    log.info(`Stations from mock (${data.length})`);
    return { success: true, data, meta: { source: 'mock', count: data.length } };
  }

  try {
    const start   = Date.now();
    const res     = await fetchWithStrategy(PLACES_URL);
    const text    = await res.text();
    const isXML   = text.trimStart().startsWith('<');
    let raw;
    try {
      raw = isXML ? parseXMLPlaces(text) : JSON.parse(text);
    } catch (parseErr) {
      throw new Error(`Parse error (${isXML ? 'XML' : 'JSON'}): ${parseErr.message}`);
    }

    // CRE API returns { places: [...] } or directly [...]
    const list  = Array.isArray(raw) ? raw : (raw.places ?? raw.data ?? []);
    const data  = list.map(normalizeStation).filter(s => s.id && s.lat && s.lng);

    placesCache.set(cacheKey, data);
    const ms = Date.now() - start;
    log.info(`Stations fetched from API: ${data.length} in ${ms}ms`);
    return { success: true, data, meta: { source: 'api', count: data.length, fetchMs: ms } };
  } catch (err) {
    log.error('fetchStations failed', err);
    return { success: false, data: [], error: String(err.message ?? err), meta: {} };
  }
}

/**
 * Fetch today's fuel prices from CRE
 * @param {boolean} [useMock=false]
 * @returns {Promise<{success: boolean, data: Price[], meta: Object, error?: string}>}
 */
export async function fetchPrices(useMock = false) {
  const cacheKey = 'prices';
  if (pricesCache.has(cacheKey)) {
    const data = pricesCache.get(cacheKey);
    log.info(`Prices from cache (${data.length})`);
    return { success: true, data, meta: { source: 'cache', count: data.length } };
  }

  if (useMock) {
    const data = MOCK_PRICES;
    pricesCache.set(cacheKey, data);
    log.info(`Prices from mock (${data.length})`);
    return { success: true, data, meta: { source: 'mock', count: data.length } };
  }

  try {
    const start  = Date.now();
    const res    = await fetchWithStrategy(PRICES_URL);
    const text   = await res.text();
    const isXML  = text.trimStart().startsWith('<');
    let raw;
    try {
      raw = isXML ? parseXMLPrices(text) : JSON.parse(text);
    } catch (parseErr) {
      throw new Error(`Parse error (${isXML ? 'XML' : 'JSON'}): ${parseErr.message}`);
    }

    // CRE API returns { prices: [...] } or directly [...]
    const list  = Array.isArray(raw) ? raw : (raw.prices ?? raw.data ?? []);
    const data  = list.map(normalizePrice).filter(p => p.stationId);

    pricesCache.set(cacheKey, data);
    const ms = Date.now() - start;
    log.info(`Prices fetched from API: ${data.length} in ${ms}ms`);
    return { success: true, data, meta: { source: 'api', count: data.length, fetchMs: ms } };
  } catch (err) {
    log.error('fetchPrices failed', err);
    return { success: false, data: [], error: String(err.message ?? err), meta: {} };
  }
}

/**
 * Fetch stations + prices simultaneously and merge by stationId
 * @param {boolean} [useMock=false]
 * @returns {Promise<{success: boolean, data: Merged[], meta: Object, error?: string}>}
 */
export async function fetchAll(useMock = false) {
  const start = Date.now();
  const [stResult, prResult] = await Promise.all([
    fetchStations(useMock),
    fetchPrices(useMock),
  ]);

  if (!stResult.success && !prResult.success) {
    return { success: false, data: [], error: 'Both stations and prices fetch failed', meta: {} };
  }

  const priceMap = new Map(prResult.data.map(p => [p.stationId, p]));
  const merged   = stResult.data.map(station => ({
    ...station,
    prices:   priceMap.get(station.id) ?? null,
    hasData:  priceMap.has(station.id),
  }));

  const missingPrices = merged.filter(m => !m.hasData).length;
  const fetchedAt     = new Date().toISOString();
  const ms            = Date.now() - start;

  log.info(`fetchAll complete: ${merged.length} merged, ${missingPrices} missing prices, ${ms}ms`);

  return {
    success: true,
    data: merged,
    meta: {
      stationCount:  stResult.data.length,
      pricesCount:   prResult.data.length,
      mergedCount:   merged.length,
      missingPrices,
      fetchedAt,
      source:        useMock ? 'mock' : 'api',
      fetchMs:       ms,
    },
  };
}

/** Invalidate both caches — forces next fetch to hit API */
export function invalidateCache() {
  placesCache.invalidate('stations');
  pricesCache.invalidate('prices');
}

// ─── Mock Data — 100 stations across Mexico ───────────────────────────────

const MOCK_STATIONS = [
  // ── CDMX (30 stations) ───────────────────────────────────────────────────
  // Polanco
  { id:'MX001', creId:'CRE-01001', name:'Gasolinera Polanco Norte',   brand:'PEMEX',     address:'Av. Presidente Masaryk 123',        city:'Miguel Hidalgo',     state:'Ciudad de México', zipCode:'11560', lat:19.4326, lng:-99.1967 },
  { id:'MX002', creId:'CRE-01002', name:'OXXO GAS Polanco',           brand:'OXXO GAS',  address:'Homero 456, Col. Polanco',          city:'Miguel Hidalgo',     state:'Ciudad de México', zipCode:'11550', lat:19.4289, lng:-99.1911 },
  { id:'MX003', creId:'CRE-01003', name:'Gasolinera BP Anzures',      brand:'BP',        address:'Ejército Nacional 301',             city:'Miguel Hidalgo',     state:'Ciudad de México', zipCode:'11590', lat:19.4358, lng:-99.1883 },
  // Roma Norte
  { id:'MX004', creId:'CRE-01004', name:'Total Roma Norte',           brand:'TOTAL',     address:'Álvaro Obregón 234, Roma Norte',   city:'Cuauhtémoc',         state:'Ciudad de México', zipCode:'06700', lat:19.4197, lng:-99.1577 },
  { id:'MX005', creId:'CRE-01005', name:'PEMEX Roma Sur',             brand:'PEMEX',     address:'Insurgentes Sur 567',               city:'Cuauhtémoc',         state:'Ciudad de México', zipCode:'06760', lat:19.4101, lng:-99.1638 },
  { id:'MX006', creId:'CRE-01006', name:'Shell Álvaro Obregón',       brand:'SHELL',     address:'Sonora 123, Col. Condesa',          city:'Cuauhtémoc',         state:'Ciudad de México', zipCode:'06100', lat:19.4133, lng:-99.1739 },
  // Condesa
  { id:'MX007', creId:'CRE-01007', name:'PEMEX Condesa Central',      brand:'PEMEX',     address:'Tamaulipas 890, Condesa',           city:'Cuauhtémoc',         state:'Ciudad de México', zipCode:'06140', lat:19.4109, lng:-99.1811 },
  { id:'MX008', creId:'CRE-01008', name:'Hidrosina Condesa',          brand:'HIDROSINA', address:'Ámsterdam 45, Condesa',             city:'Cuauhtémoc',         state:'Ciudad de México', zipCode:'06100', lat:19.4155, lng:-99.1760 },
  // Narvarte
  { id:'MX009', creId:'CRE-01009', name:'OXXO GAS Narvarte',         brand:'OXXO GAS',  address:'Moctezuma 302, Narvarte',           city:'Benito Juárez',      state:'Ciudad de México', zipCode:'03020', lat:19.3983, lng:-99.1617 },
  { id:'MX010', creId:'CRE-01010', name:'G500 Insurgentes Centro',    brand:'G500',      address:'Insurgentes Centro 1120',           city:'Benito Juárez',      state:'Ciudad de México', zipCode:'03600', lat:19.3870, lng:-99.1700 },
  // Xochimilco
  { id:'MX011', creId:'CRE-01011', name:'PEMEX Xochimilco',           brand:'PEMEX',     address:'Guillermo Prieto 88, Xochimilco',  city:'Xochimilco',         state:'Ciudad de México', zipCode:'16000', lat:19.2569, lng:-99.1017 },
  { id:'MX012', creId:'CRE-01012', name:'Total Xochimilco Sur',       brand:'TOTAL',     address:'División del Norte 4500',          city:'Xochimilco',         state:'Ciudad de México', zipCode:'16050', lat:19.2480, lng:-99.0950 },
  // Iztapalapa
  { id:'MX013', creId:'CRE-01013', name:'PEMEX Iztapalapa',           brand:'PEMEX',     address:'Calzada Ermita Iztapalapa 1800',   city:'Iztapalapa',         state:'Ciudad de México', zipCode:'09000', lat:19.3569, lng:-99.0617 },
  { id:'MX014', creId:'CRE-01014', name:'OXXO GAS Iztapalapa 2',     brand:'OXXO GAS',  address:'Av. Rio Churubusco 1190',          city:'Iztapalapa',         state:'Ciudad de México', zipCode:'09100', lat:19.3640, lng:-99.0545 },
  { id:'MX015', creId:'CRE-01015', name:'BP Iztapalapa',              brand:'BP',        address:'Sur 8 No. 44',                     city:'Iztapalapa',         state:'Ciudad de México', zipCode:'09020', lat:19.3500, lng:-99.0700 },
  // Tlalpan
  { id:'MX016', creId:'CRE-01016', name:'PEMEX Tlalpan',              brand:'PEMEX',     address:'Calzada de Tlalpan 4200',          city:'Tlalpan',            state:'Ciudad de México', zipCode:'14000', lat:19.2569, lng:-99.1717 },
  { id:'MX017', creId:'CRE-01017', name:'G500 Periferico Sur',        brand:'G500',      address:'Periférico Sur 5900',              city:'Tlalpan',            state:'Ciudad de México', zipCode:'14010', lat:19.2600, lng:-99.1900 },
  // Coyoacán
  { id:'MX018', creId:'CRE-01018', name:'Shell Coyoacán',             brand:'SHELL',     address:'Miguel Ángel de Quevedo 560',      city:'Coyoacán',           state:'Ciudad de México', zipCode:'04000', lat:19.3483, lng:-99.1617 },
  { id:'MX019', creId:'CRE-01019', name:'PEMEX Coyoacán Centro',      brand:'PEMEX',     address:'Av. Coyoacán 1800',                city:'Coyoacán',           state:'Ciudad de México', zipCode:'04100', lat:19.3420, lng:-99.1580 },
  // Azcapotzalco
  { id:'MX020', creId:'CRE-01020', name:'PEMEX Azcapotzalco',         brand:'PEMEX',     address:'Av. Azcapotzalco La Villa 889',    city:'Azcapotzalco',       state:'Ciudad de México', zipCode:'02000', lat:19.4783, lng:-99.1917 },
  { id:'MX021', creId:'CRE-01021', name:'Total Vallejo',              brand:'TOTAL',     address:'Av. Vallejo 400, Vallejo',         city:'Azcapotzalco',       state:'Ciudad de México', zipCode:'02300', lat:19.4850, lng:-99.1800 },
  // Ecatepec
  { id:'MX022', creId:'CRE-01022', name:'PEMEX Ecatepec Norte',       brand:'PEMEX',     address:'Av. Central 2200, Ecatepec',       city:'Ecatepec',           state:'Estado de México', zipCode:'55000', lat:19.6083, lng:-99.0517 },
  { id:'MX023', creId:'CRE-01023', name:'OXXO GAS Ecatepec 2',       brand:'OXXO GAS',  address:'Las Américas 560',                 city:'Ecatepec',           state:'Estado de México', zipCode:'55010', lat:19.6000, lng:-99.0600 },
  // Other CDMX
  { id:'MX024', creId:'CRE-01024', name:'PEMEX Santa Fe',             brand:'PEMEX',     address:'Vasco de Quiroga 3900, Santa Fe',  city:'Álvaro Obregón',     state:'Ciudad de México', zipCode:'05109', lat:19.3623, lng:-99.2706 },
  { id:'MX025', creId:'CRE-01025', name:'BP Satélite',                brand:'BP',        address:'Blvd. Manuel Ávila Camacho 1905',  city:'Naucalpan',          state:'Estado de México', zipCode:'53100', lat:19.5100, lng:-99.2280 },
  { id:'MX026', creId:'CRE-01026', name:'Hidrosina Cuatro Caminos',   brand:'HIDROSINA', address:'Av. Lomas Verdes 500',             city:'Naucalpan',          state:'Estado de México', zipCode:'53120', lat:19.4950, lng:-99.2300 },
  { id:'MX027', creId:'CRE-01027', name:'PEMEX San Ángel',            brand:'PEMEX',     address:'Insurgentes Sur 2345, San Ángel',  city:'Álvaro Obregón',     state:'Ciudad de México', zipCode:'01000', lat:19.3530, lng:-99.1916 },
  { id:'MX028', creId:'CRE-01028', name:'OXXO GAS Pedregal',         brand:'OXXO GAS',  address:'Periférico Sur 4190',              city:'Álvaro Obregón',     state:'Ciudad de México', zipCode:'01900', lat:19.3200, lng:-99.2100 },
  { id:'MX029', creId:'CRE-01029', name:'G500 Churubusco',            brand:'G500',      address:'Av. Río Churubusco 3000',          city:'Coyoacán',           state:'Ciudad de México', zipCode:'04530', lat:19.3605, lng:-99.1200 },
  { id:'MX030', creId:'CRE-01030', name:'Shell Peralvillo',           brand:'SHELL',     address:'Calzada San Martín 12, Peralvillo',city:'Cuauhtémoc',         state:'Ciudad de México', zipCode:'06300', lat:19.4450, lng:-99.1350 },

  // ── Guadalajara (20 stations) ─────────────────────────────────────────────
  { id:'MX031', creId:'CRE-02001', name:'PEMEX Guadalajara Centro',   brand:'PEMEX',     address:'Av. Vallarta 1200',                city:'Guadalajara',        state:'Jalisco', zipCode:'44100', lat:20.6696, lng:-103.3492 },
  { id:'MX032', creId:'CRE-02002', name:'OXXO GAS Zapopan',          brand:'OXXO GAS',  address:'Av. López Mateos Norte 3200',      city:'Zapopan',            state:'Jalisco', zipCode:'45050', lat:20.7000, lng:-103.4100 },
  { id:'MX033', creId:'CRE-02003', name:'BP Providencia',             brand:'BP',        address:'Av. México 3002, Providencia',     city:'Guadalajara',        state:'Jalisco', zipCode:'44630', lat:20.6800, lng:-103.3800 },
  { id:'MX034', creId:'CRE-02004', name:'Total Chapalita',            brand:'TOTAL',     address:'Av. Niños Héroes 2240',            city:'Guadalajara',        state:'Jalisco', zipCode:'44260', lat:20.6600, lng:-103.4000 },
  { id:'MX035', creId:'CRE-02005', name:'PEMEX Tlaquepaque',          brand:'PEMEX',     address:'Av. Niños Héroes 800, Tlaquepaque',city:'San Pedro Tlaquepaque',state:'Jalisco',zipCode:'45500', lat:20.6383, lng:-103.3103 },
  { id:'MX036', creId:'CRE-02006', name:'Shell Tonalá',               brand:'SHELL',     address:'Av. Tonaltecas 200',               city:'Tonalá',             state:'Jalisco', zipCode:'45400', lat:20.6234, lng:-103.2344 },
  { id:'MX037', creId:'CRE-02007', name:'Hidrosina GDL Oriente',      brand:'HIDROSINA', address:'Av. Federalismo Norte 1100',       city:'Guadalajara',        state:'Jalisco', zipCode:'44240', lat:20.6812, lng:-103.3492 },
  { id:'MX038', creId:'CRE-02008', name:'PEMEX Zapopan 2',            brand:'PEMEX',     address:'Av. Patria 1600, Zapopan',         city:'Zapopan',            state:'Jalisco', zipCode:'45070', lat:20.7200, lng:-103.4000 },
  { id:'MX039', creId:'CRE-02009', name:'G500 GDL',                   brand:'G500',      address:'Calz. González Gallo 490',         city:'Guadalajara',        state:'Jalisco', zipCode:'44430', lat:20.6489, lng:-103.3300 },
  { id:'MX040', creId:'CRE-02010', name:'OXXO GAS Plaza del Sol',    brand:'OXXO GAS',  address:'Av. López Mateos Sur 2200',        city:'Guadalajara',        state:'Jalisco', zipCode:'45050', lat:20.6413, lng:-103.4018 },
  { id:'MX041', creId:'CRE-02011', name:'PEMEX Periférico GDL',       brand:'PEMEX',     address:'Periférico Poniente 2100',         city:'Zapopan',            state:'Jalisco', zipCode:'45160', lat:20.7050, lng:-103.4350 },
  { id:'MX042', creId:'CRE-02012', name:'Total Tlajomulco',           brand:'TOTAL',     address:'Carr. Tlajomulco 500',             city:'Tlajomulco',         state:'Jalisco', zipCode:'45640', lat:20.4850, lng:-103.4380 },
  { id:'MX043', creId:'CRE-02013', name:'PEMEX Tesistán',             brand:'PEMEX',     address:'Carretera a Nogales 2800',         city:'Zapopan',            state:'Jalisco', zipCode:'45204', lat:20.7700, lng:-103.4500 },
  { id:'MX044', creId:'CRE-02014', name:'BP Lomas del Valle',         brand:'BP',        address:'Av. Américas 1600',                city:'Guadalajara',        state:'Jalisco', zipCode:'44610', lat:20.6890, lng:-103.4080 },
  { id:'MX045', creId:'CRE-02015', name:'PEMEX La Perla',             brand:'PEMEX',     address:'Av. Revolución 1560',              city:'Guadalajara',        state:'Jalisco', zipCode:'44810', lat:20.6580, lng:-103.3450 },
  { id:'MX046', creId:'CRE-02016', name:'Shell GDL Centro',           brand:'SHELL',     address:'Hidalgo 234',                      city:'Guadalajara',        state:'Jalisco', zipCode:'44100', lat:20.6739, lng:-103.3435 },
  { id:'MX047', creId:'CRE-02017', name:'OXXO GAS Minerva',          brand:'OXXO GAS',  address:'Av. Vallarta 3200',                city:'Guadalajara',        state:'Jalisco', zipCode:'44130', lat:20.6700, lng:-103.4200 },
  { id:'MX048', creId:'CRE-02018', name:'PEMEX Satelite GDL',         brand:'PEMEX',     address:'Av. Moctezuma 5000',               city:'Guadalajara',        state:'Jalisco', zipCode:'44280', lat:20.6360, lng:-103.3100 },
  { id:'MX049', creId:'CRE-02019', name:'Hidrosina Zapopan',          brand:'HIDROSINA', address:'Av. Acueducto 2000',               city:'Zapopan',            state:'Jalisco', zipCode:'45116', lat:20.7100, lng:-103.4200 },
  { id:'MX050', creId:'CRE-02020', name:'G500 GDL Sur',               brand:'G500',      address:'Av. 8 de Julio 1800',              city:'Guadalajara',        state:'Jalisco', zipCode:'44910', lat:20.6208, lng:-103.3419 },

  // ── Monterrey (20 stations) ───────────────────────────────────────────────
  { id:'MX051', creId:'CRE-03001', name:'PEMEX San Pedro Garza García',brand:'PEMEX',    address:'Av. Vasconcelos 502 Ote.',         city:'San Pedro Garza García',state:'Nuevo León',zipCode:'66220', lat:25.6600, lng:-100.4010 },
  { id:'MX052', creId:'CRE-03002', name:'OXXO GAS Cumbres MTY',       brand:'OXXO GAS', address:'Blvd. Díaz Ordaz 234',             city:'Monterrey',          state:'Nuevo León', zipCode:'64610', lat:25.7500, lng:-100.3900 },
  { id:'MX053', creId:'CRE-03003', name:'BP Monterrey Centro',         brand:'BP',       address:'Av. Pino Suárez 500',              city:'Monterrey',          state:'Nuevo León', zipCode:'64000', lat:25.6700, lng:-100.3200 },
  { id:'MX054', creId:'CRE-03004', name:'Total Santa Catarina',        brand:'TOTAL',    address:'Carr. Nac. 5400, Santa Catarina',  city:'Santa Catarina',     state:'Nuevo León', zipCode:'66350', lat:25.6735, lng:-100.4618 },
  { id:'MX055', creId:'CRE-03005', name:'PEMEX Apodaca',               brand:'PEMEX',    address:'Av. Sendero 4500, Apodaca',        city:'Apodaca',            state:'Nuevo León', zipCode:'66600', lat:25.7814, lng:-100.1834 },
  { id:'MX056', creId:'CRE-03006', name:'Shell Monterrey Norte',       brand:'SHELL',    address:'Av. Lincoln 2000',                 city:'Monterrey',          state:'Nuevo León', zipCode:'64350', lat:25.7200, lng:-100.3100 },
  { id:'MX057', creId:'CRE-03007', name:'PEMEX San Nicolás',           brand:'PEMEX',    address:'Av. Universidad 1000, San Nicolás',city:'San Nicolás de los Garza',state:'Nuevo León',zipCode:'66450',lat:25.7400,lng:-100.2800 },
  { id:'MX058', creId:'CRE-03008', name:'Hidrosina MTY',               brand:'HIDROSINA',address:'Av. Revolución 2800',              city:'Monterrey',          state:'Nuevo León', zipCode:'64800', lat:25.6890, lng:-100.3400 },
  { id:'MX059', creId:'CRE-03009', name:'G500 Escobedo',               brand:'G500',     address:'Av. Escobedo 1200',                city:'General Escobedo',   state:'Nuevo León', zipCode:'66050', lat:25.7900, lng:-100.3360 },
  { id:'MX060', creId:'CRE-03010', name:'OXXO GAS Valle MTY',          brand:'OXXO GAS', address:'Av. Calzada del Valle 200 Ote.',   city:'San Pedro Garza García',state:'Nuevo León',zipCode:'66269', lat:25.6500, lng:-100.3750 },
  { id:'MX061', creId:'CRE-03011', name:'PEMEX Guadalupe NL',          brand:'PEMEX',    address:'Av. Benito Juárez 3600',           city:'Guadalupe',          state:'Nuevo León', zipCode:'67100', lat:25.6806, lng:-100.2556 },
  { id:'MX062', creId:'CRE-03012', name:'Total Nuevo León Centro',     brand:'TOTAL',    address:'Dr. Coss 400',                     city:'Monterrey',          state:'Nuevo León', zipCode:'64000', lat:25.6755, lng:-100.3156 },
  { id:'MX063', creId:'CRE-03013', name:'BP Garza Sada',               brand:'BP',       address:'Av. Garza Sada 2500',              city:'Monterrey',          state:'Nuevo León', zipCode:'64860', lat:25.6350, lng:-100.2900 },
  { id:'MX064', creId:'CRE-03014', name:'PEMEX Carretera Nacional',    brand:'PEMEX',    address:'Carretera Nacional 8300',          city:'Monterrey',          state:'Nuevo León', zipCode:'64988', lat:25.5950, lng:-100.2400 },
  { id:'MX065', creId:'CRE-03015', name:'Shell Contry',                brand:'SHELL',    address:'Av. Roble 300, Col. Contry',       city:'Monterrey',          state:'Nuevo León', zipCode:'64860', lat:25.6460, lng:-100.3020 },
  { id:'MX066', creId:'CRE-03016', name:'PEMEX Pesquería',             brand:'PEMEX',    address:'Carretera a Pesquería 500',        city:'Pesquería',          state:'Nuevo León', zipCode:'65920', lat:25.7600, lng:-100.0500 },
  { id:'MX067', creId:'CRE-03017', name:'OXXO GAS Mitras',            brand:'OXXO GAS', address:'Av. Félix U. Gómez 900',           city:'Monterrey',          state:'Nuevo León', zipCode:'64460', lat:25.6977, lng:-100.3264 },
  { id:'MX068', creId:'CRE-03018', name:'Hidrosina Nuevo León',        brand:'HIDROSINA',address:'Av. Eugenio Garza Sada 4000',      city:'Monterrey',          state:'Nuevo León', zipCode:'64310', lat:25.6200, lng:-100.2800 },
  { id:'MX069', creId:'CRE-03019', name:'PEMEX Juárez NL',             brand:'PEMEX',    address:'Carr. a Juárez 1200',              city:'Juárez',             state:'Nuevo León', zipCode:'67250', lat:25.6000, lng:-100.1200 },
  { id:'MX070', creId:'CRE-03020', name:'G500 Monterrey Sur',          brand:'G500',     address:'Av. Las Torres 800',               city:'Monterrey',          state:'Nuevo León', zipCode:'64905', lat:25.6100, lng:-100.3100 },

  // ── Tijuana (10 stations) ─────────────────────────────────────────────────
  { id:'MX071', creId:'CRE-04001', name:'PEMEX Tijuana Centro',        brand:'PEMEX',    address:'Blvd. Agua Caliente 2200',         city:'Tijuana',            state:'Baja California', zipCode:'22010', lat:32.5165, lng:-117.0264 },
  { id:'MX072', creId:'CRE-04002', name:'OXXO GAS TIJ Otay',          brand:'OXXO GAS', address:'Blvd. Otay 3100',                  city:'Tijuana',            state:'Baja California', zipCode:'22430', lat:32.5420, lng:-116.9750 },
  { id:'MX073', creId:'CRE-04003', name:'BP Mesa de Otay',             brand:'BP',       address:'Av. Industrial 800',               city:'Tijuana',            state:'Baja California', zipCode:'22400', lat:32.5500, lng:-116.9900 },
  { id:'MX074', creId:'CRE-04004', name:'Total Zona Rio',              brand:'TOTAL',    address:'Paseo de los Héroes 10400',        city:'Tijuana',            state:'Baja California', zipCode:'22010', lat:32.5251, lng:-117.0330 },
  { id:'MX075', creId:'CRE-04005', name:'PEMEX Playas de Tijuana',     brand:'PEMEX',    address:'Av. del Pacífico 1200',            city:'Tijuana',            state:'Baja California', zipCode:'22200', lat:32.5027, lng:-117.1031 },
  { id:'MX076', creId:'CRE-04006', name:'Shell Tijuana Norte',         brand:'SHELL',    address:'Blvd. Díaz Ordaz 1800',            city:'Tijuana',            state:'Baja California', zipCode:'22700', lat:32.5760, lng:-117.0150 },
  { id:'MX077', creId:'CRE-04007', name:'PEMEX Tecate Corridor',       brand:'PEMEX',    address:'Carr. Tijuana-Tecate Km 12',       city:'Tijuana',            state:'Baja California', zipCode:'22253', lat:32.5300, lng:-116.9200 },
  { id:'MX078', creId:'CRE-04008', name:'Hidrosina TIJ',               brand:'HIDROSINA',address:'Av. Industrial 1500, Otay',        city:'Tijuana',            state:'Baja California', zipCode:'22444', lat:32.5600, lng:-116.9800 },
  { id:'MX079', creId:'CRE-04009', name:'PEMEX La Mesa TIJ',           brand:'PEMEX',    address:'Blvd. Insurgentes 15700, La Mesa', city:'Tijuana',            state:'Baja California', zipCode:'22150', lat:32.4900, lng:-116.9700 },
  { id:'MX080', creId:'CRE-04010', name:'G500 Rosarito',               brand:'G500',     address:'Blvd. Juárez 200, Rosarito',       city:'Playas de Rosarito', state:'Baja California', zipCode:'22710', lat:32.3380, lng:-117.0620 },

  // ── Puebla (10 stations) ──────────────────────────────────────────────────
  { id:'MX081', creId:'CRE-05001', name:'PEMEX Puebla Centro',         brand:'PEMEX',    address:'Blvd. Atlixcáyotl 5200',          city:'Puebla',             state:'Puebla', zipCode:'72810', lat:19.0414, lng:-98.2063 },
  { id:'MX082', creId:'CRE-05002', name:'OXXO GAS Angelópolis',       brand:'OXXO GAS', address:'Av. Juárez 2200, Angelópolis',     city:'Puebla',             state:'Puebla', zipCode:'72360', lat:19.0250, lng:-98.2450 },
  { id:'MX083', creId:'CRE-05003', name:'BP Huexotitla',               brand:'BP',       address:'10 Sur 6902',                      city:'Puebla',             state:'Puebla', zipCode:'72530', lat:19.0100, lng:-98.2200 },
  { id:'MX084', creId:'CRE-05004', name:'Total Tehuacán',              brand:'TOTAL',    address:'Av. Independencia 700',            city:'Tehuacán',           state:'Puebla', zipCode:'75700', lat:18.4650, lng:-97.3920 },
  { id:'MX085', creId:'CRE-05005', name:'PEMEX San Andrés Cholula',    brand:'PEMEX',    address:'Av. Camino Real a Cholula 500',    city:'San Andrés Cholula', state:'Puebla', zipCode:'72810', lat:19.0599, lng:-98.2975 },
  { id:'MX086', creId:'CRE-05006', name:'Shell Puebla Norte',          brand:'SHELL',    address:'Blvd. Norte 4500',                 city:'Puebla',             state:'Puebla', zipCode:'72140', lat:19.0750, lng:-98.1960 },
  { id:'MX087', creId:'CRE-05007', name:'PEMEX Atlixco',               brand:'PEMEX',    address:'Av. Hidalgo 800, Atlixco',         city:'Atlixco',            state:'Puebla', zipCode:'74200', lat:18.9050, lng:-98.4400 },
  { id:'MX088', creId:'CRE-05008', name:'Hidrosina Puebla',            brand:'HIDROSINA',address:'Av. 45 Ote 1600',                  city:'Puebla',             state:'Puebla', zipCode:'72180', lat:19.0500, lng:-98.1700 },
  { id:'MX089', creId:'CRE-05009', name:'PEMEX Teziutlán',             brand:'PEMEX',    address:'Av. Juárez 1100, Teziutlán',       city:'Teziutlán',          state:'Puebla', zipCode:'73800', lat:19.8182, lng:-97.3619 },
  { id:'MX090', creId:'CRE-05010', name:'G500 Puebla Sur',             brand:'G500',     address:'Blvd. Valsequillo 1800',           city:'Puebla',             state:'Puebla', zipCode:'72590', lat:18.9900, lng:-98.1800 },

  // ── Highway Corridors (10 stations) ──────────────────────────────────────
  // MEX-57 (CDMX–Querétaro)
  { id:'MX091', creId:'CRE-06001', name:'PEMEX MEX-57 Km45',           brand:'PEMEX',    address:'Autopista México-Querétaro Km 45', city:'Tepotzotlán',        state:'Estado de México', zipCode:'54600', lat:19.7130, lng:-99.2270 },
  { id:'MX092', creId:'CRE-06002', name:'G500 MEX-57 Km85',            brand:'G500',     address:'Autopista México-Querétaro Km 85', city:'Jilotepec',          state:'Estado de México', zipCode:'54240', lat:20.0200, lng:-99.5300 },
  // MEX-15 (CDMX–Toluca)
  { id:'MX093', creId:'CRE-06003', name:'Shell MEX-15 Las Cruces',     brand:'SHELL',    address:'Autopista México-Toluca Km 47',    city:'Xalatlaco',          state:'Estado de México', zipCode:'52080', lat:19.2500, lng:-99.4000 },
  { id:'MX094', creId:'CRE-06004', name:'PEMEX Toluca Centro',         brand:'PEMEX',    address:'Paseo Tollocan 900',               city:'Toluca',             state:'Estado de México', zipCode:'50180', lat:19.2826, lng:-99.6557 },
  // MEX-2 (Tijuana–Nogales)
  { id:'MX095', creId:'CRE-06005', name:'PEMEX MEX-2 Mexicali',        brand:'PEMEX',    address:'Blvd. Lázaro Cárdenas 1200',      city:'Mexicali',           state:'Baja California', zipCode:'21100', lat:32.6278, lng:-115.4545 },
  { id:'MX096', creId:'CRE-06006', name:'OXXO GAS Ensenada',          brand:'OXXO GAS', address:'Av. Reforma 600, Ensenada',        city:'Ensenada',           state:'Baja California', zipCode:'22800', lat:31.8676, lng:-116.5964 },
  // MEX-45 (Guadalajara–Ciudad Juárez)
  { id:'MX097', creId:'CRE-06007', name:'PEMEX Aguascalientes',        brand:'PEMEX',    address:'Av. Aguascalientes Sur 1800',      city:'Aguascalientes',     state:'Aguascalientes', zipCode:'20020', lat:21.8818, lng:-102.2916 },
  { id:'MX098', creId:'CRE-06008', name:'BP Zacatecas',                brand:'BP',       address:'Blvd. López Portillo 500',         city:'Zacatecas',          state:'Zacatecas', zipCode:'98000', lat:22.7709, lng:-102.5832 },
  // MEX-85D (Monterrey–Nuevo Laredo)
  { id:'MX099', creId:'CRE-06009', name:'Total Nuevo Laredo',          brand:'TOTAL',    address:'Av. Guerrero 1600',                city:'Nuevo Laredo',       state:'Tamaulipas', zipCode:'88000', lat:27.4765, lng:-99.5156 },
  { id:'MX100', creId:'CRE-06010', name:'PEMEX Saltillo',              brand:'PEMEX',    address:'Blvd. Luis Echeverría 3000',       city:'Saltillo',           state:'Coahuila', zipCode:'25000', lat:25.4383, lng:-100.9928 },
];

// ─── Mock Prices — realistic variation, 3 anomalous stations ──────────────
// Base prices (national averages ~2026):
// Regular ≈ $22.50, Premium ≈ $24.80, Diesel ≈ $23.10

const BASE = { regular: 22.50, premium: 24.80, diesel: 23.10 };

function mockPrice(id, rDelta = 0, pDelta = 0, dDelta = 0) {
  return {
    stationId: id,
    regular:  Math.round((BASE.regular  + rDelta) * 100) / 100,
    premium:  Math.round((BASE.premium  + pDelta) * 100) / 100,
    diesel:   Math.round((BASE.diesel   + dDelta) * 100) / 100,
    updatedAt: new Date().toISOString(),
  };
}

const MOCK_PRICES = [
  // CDMX
  mockPrice('MX001',  0.20, 0.30,  0.10),
  mockPrice('MX002', -0.30,-0.20, -0.15),
  mockPrice('MX003',  0.10, 0.15,  0.05),
  mockPrice('MX004', -0.50,-0.40, -0.30), // cheap Regular
  mockPrice('MX005',  0.30, 0.25,  0.20),
  mockPrice('MX006', -0.10,-0.05, -0.08),
  mockPrice('MX007',  0.45, 3.50,  0.20), // ⚠️ ANOMALY: Premium $28.30 (+$3.50)
  mockPrice('MX008',  0.00, 0.10,  0.00),
  mockPrice('MX009', -0.20,-0.15, -0.10),
  mockPrice('MX010',  0.15, 0.20,  0.08),
  mockPrice('MX011', -0.40,-0.35, -0.25),
  mockPrice('MX012',  0.05, 0.10,  0.03),
  mockPrice('MX013', -0.25,-0.20, -0.15),
  mockPrice('MX014',  0.35, 0.30,  0.25),
  mockPrice('MX015',  0.10, 0.08,  0.05),
  mockPrice('MX016', -0.15,-0.10, -0.08),
  mockPrice('MX017',  0.55, 0.60,  0.45), // slightly high
  mockPrice('MX018', -0.30,-0.25, -0.20),
  mockPrice('MX019',  0.20, 0.15,  0.10),
  mockPrice('MX020', -0.60,-0.55, -0.40), // very cheap
  mockPrice('MX021',  0.00, 0.05,  0.00),
  mockPrice('MX022',  0.25, 0.20,  0.15),
  mockPrice('MX023', -0.10,-0.08, -0.05),
  mockPrice('MX024',  0.40, 3.80,  0.30), // ⚠️ ANOMALY: Premium $28.60 (+$3.80)
  mockPrice('MX025',  0.15, 0.12,  0.08),
  mockPrice('MX026', -0.35,-0.30, -0.22),
  mockPrice('MX027',  0.10, 0.08,  0.05),
  mockPrice('MX028', -0.20,-0.15, -0.12),
  mockPrice('MX029',  0.30, 0.25,  0.18),
  mockPrice('MX030',  0.05, 0.00,  0.03),
  // GDL
  mockPrice('MX031',  0.10, 0.15,  0.05),
  mockPrice('MX032', -0.25,-0.20, -0.15),
  mockPrice('MX033',  0.20, 0.18,  0.12),
  mockPrice('MX034', -0.40,-0.35, -0.28),
  mockPrice('MX035',  0.05, 0.08,  0.03),
  mockPrice('MX036', -0.15,-0.10, -0.08),
  mockPrice('MX037',  0.35, 0.30,  0.22),
  mockPrice('MX038', -0.30,-0.25, -0.18),
  mockPrice('MX039',  0.00, 0.05,  0.00),
  mockPrice('MX040',  0.15, 0.12,  0.08),
  mockPrice('MX041', -0.20,-0.18, -0.12),
  mockPrice('MX042',  0.08, 0.10,  0.05),
  mockPrice('MX043', -0.45,-0.40, -0.30),
  mockPrice('MX044',  0.25, 0.22,  0.15),
  mockPrice('MX045', -0.10,-0.08, -0.05),
  mockPrice('MX046',  0.30, 0.28,  0.18),
  mockPrice('MX047', -0.35,-0.30, -0.22),
  mockPrice('MX048',  0.12, 0.10,  0.07),
  mockPrice('MX049', -0.18,-0.15, -0.10),
  mockPrice('MX050',  0.22, 0.20,  0.13),
  // MTY
  mockPrice('MX051', -0.30,-0.25, -0.18),
  mockPrice('MX052',  0.15, 0.12,  0.08),
  mockPrice('MX053', -0.10,-0.08, -0.05),
  mockPrice('MX054',  0.40, 0.35,  0.25),
  mockPrice('MX055', -0.20,-0.18, -0.12),
  mockPrice('MX056',  0.05, 0.08,  0.03),
  mockPrice('MX057', -0.35,-0.30, -0.22),
  mockPrice('MX058',  0.25, 0.22,  0.15),
  mockPrice('MX059', -0.15,-0.12, -0.08),
  mockPrice('MX060',  0.45, 4.20,  0.30), // ⚠️ ANOMALY: Premium $29.00 (+$4.20)
  mockPrice('MX061', -0.25,-0.20, -0.15),
  mockPrice('MX062',  0.10, 0.08,  0.05),
  mockPrice('MX063', -0.40,-0.35, -0.25),
  mockPrice('MX064',  0.20, 0.18,  0.12),
  mockPrice('MX065', -0.08,-0.05, -0.03),
  mockPrice('MX066',  0.35, 0.30,  0.20),
  mockPrice('MX067', -0.50,-0.45, -0.35),
  mockPrice('MX068',  0.00, 0.03,  0.00),
  mockPrice('MX069', -0.18,-0.15, -0.10),
  mockPrice('MX070',  0.28, 0.25,  0.17),
  // Tijuana
  mockPrice('MX071',  0.30, 0.25,  0.18),
  mockPrice('MX072', -0.20,-0.15, -0.10),
  mockPrice('MX073',  0.10, 0.08,  0.05),
  mockPrice('MX074', -0.35,-0.30, -0.22),
  mockPrice('MX075',  0.05, 0.03,  0.02),
  mockPrice('MX076', -0.15,-0.12, -0.08),
  mockPrice('MX077',  0.40, 0.35,  0.25),
  mockPrice('MX078', -0.08,-0.05, -0.03),
  mockPrice('MX079',  0.22, 0.20,  0.13),
  mockPrice('MX080', -0.45,-0.40, -0.30),
  // Puebla
  mockPrice('MX081',  0.15, 0.12,  0.08),
  mockPrice('MX082', -0.28,-0.22, -0.18),
  mockPrice('MX083',  0.08, 0.05,  0.03),
  mockPrice('MX084', -0.40,-0.35, -0.25),
  mockPrice('MX085',  0.20, 0.18,  0.10),
  mockPrice('MX086', -0.12,-0.10, -0.07),
  mockPrice('MX087',  0.35, 0.30,  0.20),
  mockPrice('MX088', -0.22,-0.18, -0.13),
  mockPrice('MX089',  0.05, 0.03,  0.02),
  mockPrice('MX090', -0.50,-0.45, -0.33),
  // Highway
  mockPrice('MX091',  0.80, 0.75,  0.60), // highway premium
  mockPrice('MX092',  0.90, 0.85,  0.70),
  mockPrice('MX093',  0.70, 0.65,  0.55),
  mockPrice('MX094',  0.20, 0.18,  0.12),
  mockPrice('MX095',  0.50, 0.45,  0.35),
  mockPrice('MX096',  0.40, 0.35,  0.28),
  mockPrice('MX097',  0.10, 0.08,  0.05),
  mockPrice('MX098',  0.60, 0.55,  0.45),
  mockPrice('MX099',  0.75, 0.70,  0.58),
  mockPrice('MX100',  0.30, 0.28,  0.20),
];
