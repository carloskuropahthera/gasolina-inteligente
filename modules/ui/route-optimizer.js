// MODULE: route-optimizer
// PURPOSE: Find cheapest gas station along a user-defined route via OSRM (free)

import { getState } from '../utils/state.js';
import { geocode } from '../api/geocoder.js';
import { formatPriceMXN } from '../utils/helpers.js';

const OSRM = 'https://router.project-osrm.org/route/v1/driving';

export function initRouteOptimizer(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  el.innerHTML = `
    <div class="route-panel" id="route-panel-widget">
      <div class="route-panel__header" id="route-panel-toggle">
        🗺️ Optimizador de ruta  <span class="route-chevron">▼</span>
      </div>
      <div class="route-panel__body" id="route-panel-body">
        <input id="route-start" class="route-input" type="text" placeholder="Origen (ciudad, colonia, CP…)">
        <input id="route-end"   class="route-input" type="text" placeholder="Destino">
        <div class="route-row">
          <label>Eficiencia</label>
          <input id="route-eff" type="number" value="12" min="1" max="40" class="route-mini-input"> km/L
        </div>
        <button id="route-find-btn" class="btn-primary">Encontrar parada más barata</button>
        <div id="route-results"></div>
      </div>
    </div>`;

  document.getElementById('route-panel-toggle')?.addEventListener('click', () => {
    document.getElementById('route-panel-body')?.classList.toggle('route-panel__body--collapsed');
    const ch = document.querySelector('.route-chevron');
    if (ch) ch.textContent = ch.textContent === '▼' ? '▲' : '▼';
  });

  document.getElementById('route-find-btn')?.addEventListener('click', _findCheapest);
}

async function _findCheapest() {
  const startStr   = document.getElementById('route-start')?.value?.trim();
  const endStr     = document.getElementById('route-end')?.value?.trim();
  const efficiency = parseFloat(document.getElementById('route-eff')?.value) || 12;
  const resultsEl  = document.getElementById('route-results');

  if (!startStr || !endStr) {
    resultsEl.innerHTML = '<div class="route-hint">Ingresa origen y destino</div>';
    return;
  }

  resultsEl.innerHTML = '<div class="route-hint">Calculando…</div>';

  const [startGeo, endGeo] = await Promise.all([geocode(startStr), geocode(endStr)]);

  if (!startGeo || !endGeo) {
    resultsEl.innerHTML = '<div class="route-hint route-hint--error">No se encontraron las ubicaciones</div>';
    return;
  }

  let routeCoords = null;
  try {
    const url = `${OSRM}/${startGeo.lng},${startGeo.lat};${endGeo.lng},${endGeo.lat}?overview=full&geometries=geojson`;
    const res  = await fetch(url);
    const data = await res.json();
    routeCoords = data.routes?.[0]?.geometry?.coordinates ?? [];
  } catch {
    resultsEl.innerHTML = '<div class="route-hint route-hint--error">Error al calcular ruta. Intenta de nuevo.</div>';
    return;
  }

  const distKm  = _routeLength(routeCoords);
  const neededL = distKm / efficiency;

  // Find stations within 5km of route (sample every 10 coords)
  const { filteredData, filters } = getState();
  const fuelType = filters.fuelType ?? 'regular';
  const sampled  = routeCoords.filter((_, i) => i % 10 === 0);

  const candidates = filteredData.filter(s => {
    if (!s.hasData || s.prices?.[fuelType] == null || !s.lat || !s.lng) return false;
    return sampled.some(([lng, lat]) => _haversine(lat, lng, s.lat, s.lng) < 5);
  }).sort((a, b) => a.prices[fuelType] - b.prices[fuelType]);

  if (candidates.length === 0) {
    resultsEl.innerHTML = `<div class="route-hint">Sin estaciones con datos en la ruta (${distKm.toFixed(0)} km)</div>`;
    return;
  }

  const top3 = candidates.slice(0, 3);
  resultsEl.innerHTML = `
    <div class="route-summary">Ruta: ~${distKm.toFixed(0)} km · Necesitas ~${neededL.toFixed(1)} L</div>
    ${top3.map(s => {
      const cost = (neededL * s.prices[fuelType]).toFixed(2);
      return `<div class="route-station">
        <div class="route-station__name">${_esc(s.name)}</div>
        <div class="route-station__detail">${formatPriceMXN(s.prices[fuelType])} · Viaje ~$${cost} · ${_esc(s.city)}</div>
      </div>`;
    }).join('')}`;
}

function _routeLength(coords) {
  let km = 0;
  for (let i = 1; i < coords.length; i++) {
    km += _haversine(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);
  }
  return km;
}

function _haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
