// MODULE: map
// PURPOSE: Leaflet.js map with marker clustering, heatmap, and station interaction
// DEPENDS ON: stations, state, logger

import { getBrandColor }    from '../data/stations.js';
import { setState, getState } from '../utils/state.js';
import { createLogger }     from '../utils/logger.js';
import { formatPriceMXN, formatDistance, esc } from '../utils/helpers.js';

const log = createLogger('map');

let _map        = null;
let _markers    = null; // MarkerClusterGroup
let _markerMap  = new Map(); // stationId → L.Marker
let _heatLayer  = null;
let _userPin    = null; // L.Marker for drop-a-pin
let _radiusCircle = null; // L.Circle for distance radius

const TILE_URL     = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIB  = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/**
 * Initialize the Leaflet map in a container element
 * @param {string} containerId
 * @returns {L.Map}
 */
export function initMap(containerId) {
  if (_map) { _map.remove(); _map = null; }

  _map = L.map(containerId, { // eslint-disable-line no-undef
    center:  [23.6345, -102.5528],
    zoom:    5,
    minZoom: 4,
    maxZoom: 18,
  });

  L.tileLayer(TILE_URL, { attribution: TILE_ATTRIB, maxZoom: 19 }).addTo(_map); // eslint-disable-line no-undef

  // MarkerClusterGroup — chunkedLoading keeps the main thread responsive with 14k+ markers
  _markers = L.markerClusterGroup({ // eslint-disable-line no-undef
    maxClusterRadius: 50,
    disableClusteringAtZoom: 13,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    chunkedLoading: true,   // process markers asynchronously in timed chunks
    chunkSize: 200,         // markers per chunk
    chunkInterval: 100,     // ms between chunks (keeps UI at ~10fps during load)
    chunkDelay: 50,         // ms before first chunk starts
  });
  _map.addLayer(_markers);

  // Drop-a-pin: clicking the map sets userLocation with source='pin'
  _map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    setState({
      userLocation: { lat, lng },
      userLocationSource: 'pin',
      userLocationLabel: `Pin (${lat.toFixed(4)}, ${lng.toFixed(4)})`,
    });
  });

  log.info('Map initialized');
  return _map;
}

// ─── Marker Icons ─────────────────────────────────────────────────────────

function createMarkerIcon(color, isCheapest = false, isAnomaly = false) {
  const size   = isCheapest ? 14 : 10;
  const border = isAnomaly ? '#FFD700' : '#ffffff';
  const badge  = isCheapest ? '★' : '';
  const html   = `
    <div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${color};border:2px solid ${border};
      display:flex;align-items:center;justify-content:center;
      font-size:8px;color:#fff;font-weight:bold;
      ${isCheapest ? 'box-shadow:0 0 6px 2px rgba(0,255,136,0.6);' : ''}
    ">${badge}</div>`;

  return L.divIcon({ // eslint-disable-line no-undef
    html,
    className: '',
    iconSize:  [size, size],
    iconAnchor:[size/2, size/2],
    popupAnchor:[0, -size/2],
  });
}

// ─── Popup Builder ────────────────────────────────────────────────────────

function buildPopup(station) {
  const p         = station.prices;
  const loc       = getState().userLocation;
  const distInfo  = station.distanceKm != null
    ? `<div class="popup-dist">
         📍 ${formatDistance(station.distanceKm)} as-the-crow-flies
         / ~${formatDistance(station.manhattanKm)} road est.
       </div>`
    : '';

  const priceRow = (label, val, avg) => {
    if (val == null) return `<tr><td>${label}</td><td colspan="2">—</td></tr>`;
    const delta  = avg ? (val - avg) : 0;
    const sign   = delta > 0.01 ? `<span class="price-hi">▲$${delta.toFixed(2)}</span>`
                 : delta < -0.01 ? `<span class="price-lo">▼$${Math.abs(delta).toFixed(2)}</span>`
                 : '';
    return `<tr><td>${label}</td><td>${formatPriceMXN(val)}</td><td>${sign}</td></tr>`;
  };

  const anomalyBanner = station._isAnomaly
    ? `<div class="popup-anomaly">⚠️ Anomaly detected — check details</div>`
    : '';

  return `
    <div class="map-popup">
      <div class="popup-header">
        <strong>${esc(station.name)}</strong>
        <span class="brand-badge" style="background:${getBrandColor(station.brand)}">${esc(station.brand)}</span>
      </div>
      <div class="popup-addr">${esc(station.address)}, ${esc(station.city)}</div>
      ${distInfo}
      ${anomalyBanner}
      <table class="popup-prices">
        <thead><tr><th>Fuel</th><th>Price</th><th>vs Avg</th></tr></thead>
        <tbody>
          ${priceRow('Regular', p?.regular, null)}
          ${priceRow('Premium', p?.premium, null)}
          ${priceRow('Diesel',  p?.diesel,  null)}
        </tbody>
      </table>
      <button class="popup-detail-btn" onclick="window._gi_selectStation(decodeURIComponent('${encodeURIComponent(station.id)}'))">
        View Details →
      </button>
    </div>`;
}

// ─── Render ───────────────────────────────────────────────────────────────

/**
 * Render all stations as map markers with clustering
 * @param {Merged[]} mergedData
 * @param {string} [fuelType='regular']
 */
/**
 * Render all stations as map markers with clustering.
 *
 * MarkerClusterGroup is initialized with chunkedLoading:true so addLayers()
 * returns immediately and processes markers in the background — the main
 * thread stays responsive and the boot sequence can finish while markers
 * progressively appear on the map.
 *
 * @param {Merged[]} mergedData
 * @param {string} [fuelType='regular']
 */
export function renderStations(mergedData, fuelType = 'regular') {
  _markers.clearLayers();
  _markerMap.clear();

  // Determine cheapest 10% for star badges
  const prices = mergedData
    .filter(s => s.hasData && s.prices?.[fuelType] != null)
    .map(s => s.prices[fuelType]);
  prices.sort((a, b) => a - b);
  const p10 = prices[Math.floor(prices.length * 0.1)] ?? 0;

  // Build all marker objects
  const allLayers = [];
  for (const station of mergedData) {
    if (!station.lat || !station.lng) continue;

    const color      = getBrandColor(station.brand);
    const stPrice    = station.prices?.[fuelType];
    const isCheapest = stPrice != null && stPrice <= p10;
    const isAnomaly  = station._isAnomaly === true;
    const icon       = createMarkerIcon(color, isCheapest, isAnomaly);

    const marker = L.marker([station.lat, station.lng], { icon, title: station.name }); // eslint-disable-line no-undef
    // Lazy popup: HTML built only when opened — not for all 14k markers upfront
    marker.bindPopup(() => buildPopup(station), { maxWidth: 280, className: 'gi-popup' });
    marker.on('click', () => setState({ selectedStation: station }));

    allLayers.push(marker);
    _markerMap.set(station.id, marker);
  }

  // addLayers with chunkedLoading:true returns immediately;
  // MarkerClusterGroup processes chunks via internal setTimeout intervals
  _markers.addLayers(allLayers); // eslint-disable-line no-undef
  log.info(`Queued ${allLayers.length} station markers for chunked render`);
}

/**
 * Pan and zoom to a station, open its popup
 * @param {string} stationId
 */
export function highlightStation(stationId) {
  const station = getState().mergedData.find(s => s.id === stationId);
  if (!station || !_map) return;

  _map.setView([station.lat, station.lng], 15, { animate: true });
  const marker = _markerMap.get(stationId);
  if (marker) {
    _markers.zoomToShowLayer(marker, () => marker.openPopup());
  }
}

/**
 * Highlight cheapest N stations with green outlines
 * @param {Merged[]} mergedData
 * @param {string} fuelType
 * @param {number} [n=10]
 */
export function showCheapest(mergedData, fuelType, n = 10) {
  const cheapest = [...mergedData]
    .filter(s => s.hasData && s.prices?.[fuelType] != null)
    .sort((a, b) => a.prices[fuelType] - b.prices[fuelType])
    .slice(0, n);

  for (const s of cheapest) {
    const marker = _markerMap.get(s.id);
    if (marker) {
      marker.setIcon(createMarkerIcon('#00FF88', true, false));
    }
  }
}

/**
 * Highlight anomaly stations with orange/red markers
 * @param {Anomaly[]} anomalies
 */
export function showAnomalies(anomalies) {
  for (const a of anomalies) {
    const marker = _markerMap.get(a.stationId);
    if (marker) {
      const color = a.severity === 'severe' ? '#FF4444'
                  : a.severity === 'moderate' ? '#FF8C00' : '#FFD700';
      marker.setIcon(createMarkerIcon(color, false, true));
    }
  }
}

/**
 * Fit map view to the currently visible stations
 * @param {Merged[]} stations
 */
export function fitToVisible(stations) {
  if (!_map || stations.length === 0) return;
  const valid = stations.filter(s => s.lat && s.lng);
  if (valid.length === 0) return;

  const bounds = L.latLngBounds(valid.map(s => [s.lat, s.lng])); // eslint-disable-line no-undef
  _map.fitBounds(bounds, { padding: [20, 20] });
}

/**
 * Toggle a heatmap layer showing price intensity
 * @param {Merged[]} mergedData
 * @param {string} fuelType
 */
export function toggleHeatmap(mergedData, fuelType) {
  if (_heatLayer) {
    _map.removeLayer(_heatLayer);
    _heatLayer = null;
    return;
  }
  // Requires leaflet.heat plugin — graceful degradation if not loaded
  if (typeof L.heatLayer === 'undefined') { // eslint-disable-line no-undef
    log.warn('leaflet.heat not loaded — heatmap unavailable');
    return;
  }
  const points = mergedData
    .filter(s => s.hasData && s.prices?.[fuelType] != null && s.lat && s.lng)
    .map(s => [s.lat, s.lng, s.prices[fuelType]]);

  _heatLayer = L.heatLayer(points, { radius: 25, blur: 15, maxZoom: 10 }); // eslint-disable-line no-undef
  _map.addLayer(_heatLayer);
}

/** Get the underlying Leaflet map instance */
export function getMap() { return _map; }

/**
 * Update or remove the draggable user-location pin and radius circle.
 * Called from app.js whenever state.userLocation or state.userLocationSource changes.
 * @param {{ lat: number, lng: number } | null} loc
 * @param {'gps'|'address'|'pin'|null} source
 * @param {number|null} radiusKm
 */
export function updateUserPin(loc, source, radiusKm) {
  if (!_map) return;

  // Remove existing pin + circle
  if (_userPin) { _map.removeLayer(_userPin); _userPin = null; }
  if (_radiusCircle) { _map.removeLayer(_radiusCircle); _radiusCircle = null; }

  if (!loc) return;

  // Choose icon based on source
  const pinHtml = source === 'pin'
    ? `<div style="font-size:28px;line-height:1;filter:drop-shadow(0 2px 4px #0008)">📌</div>`
    : `<div style="font-size:24px;line-height:1;filter:drop-shadow(0 2px 4px #0008)">📍</div>`;

  const pinIcon = L.divIcon({ // eslint-disable-line no-undef
    html: pinHtml,
    className: '',
    iconSize: [32, 32],
    iconAnchor: [16, 28],
  });

  _userPin = L.marker([loc.lat, loc.lng], { // eslint-disable-line no-undef
    icon: pinIcon,
    draggable: source === 'pin',
    zIndexOffset: 1000,
  }).addTo(_map);

  if (source === 'pin') {
    _userPin.on('dragend', (e) => {
      const { lat, lng } = e.target.getLatLng();
      setState({
        userLocation: { lat, lng },
        userLocationSource: 'pin',
        userLocationLabel: `Pin (${lat.toFixed(4)}, ${lng.toFixed(4)})`,
      });
    });
  }

  // Draw radius circle if a distance limit is set
  const radius = radiusKm ?? 10;
  _radiusCircle = L.circle([loc.lat, loc.lng], { // eslint-disable-line no-undef
    radius: radius * 1000,
    color: '#4fc3f7',
    fillColor: '#4fc3f7',
    fillOpacity: 0.06,
    weight: 1.5,
    dashArray: '6 4',
  }).addTo(_map);
}
