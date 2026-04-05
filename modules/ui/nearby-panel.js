// MODULE: nearby-panel
// PURPOSE: Slide-up panel showing nearest + cheapest stations within radius when a pin is active
// DEPENDS ON: state, logger

import { getState, setState, subscribe } from '../utils/state.js';
import { createLogger } from '../utils/logger.js';
import { formatPriceMXN, formatDistance } from '../utils/helpers.js';
import { formatNearbyMessage } from '../integrations/whatsapp-formatter.js';

const log = createLogger('nearby-panel');

let _container = null;

// ─── Public API ───────────────────────────────────────────────────────────

export function initNearbyPanel(containerId) {
  _container = document.getElementById(containerId);
  if (!_container) return;

  subscribe('userLocation', () => _render());
  subscribe('userLocationSource', () => _render());
  subscribe('filteredData', () => _render());

  log.info('Nearby panel initialized');
}

// ─── Render ───────────────────────────────────────────────────────────────

function _render() {
  if (!_container) return;
  const { userLocation, userLocationSource, filteredData, filters } = getState();

  // Only show when a pin is dropped or address/GPS location is active
  if (!userLocation || !userLocationSource) {
    _container.innerHTML = '';
    _container.classList.remove('nearby-panel--visible');
    return;
  }

  const fuelType = filters.fuelType ?? 'regular';
  const maxKm = filters.maxDistanceKm ?? 10;

  // Filter stations within radius that have distance computed
  const withDist = filteredData
    .filter(s => s.distanceKm != null && s.distanceKm <= maxKm && s.lat && s.lng);

  if (withDist.length === 0) {
    _container.innerHTML = `
      <div class="nearby-panel">
        <div class="nearby-panel__header">
          <span>Sin estaciones en ${maxKm} km</span>
          ${_clearBtn()}
        </div>
      </div>`;
    _container.classList.add('nearby-panel--visible');
    _wire();
    return;
  }

  // Nearest 5
  const nearest = [...withDist]
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, 5);

  // Cheapest 5 (must have price data)
  const cheapest = [...withDist]
    .filter(s => s.hasData && s.prices?.[fuelType] != null)
    .sort((a, b) => a.prices[fuelType] - b.prices[fuelType])
    .slice(0, 5);

  _container.innerHTML = `
    <div class="nearby-panel">
      <div class="nearby-panel__header">
        <span>📍 Estaciones en <strong>${maxKm} km</strong> — ${withDist.length} encontradas</span>
        <div class="nearby-panel__actions">
          <button class="nearby-wa-btn" id="nearby-share-wa" title="Compartir por WhatsApp">💬</button>
          ${_clearBtn()}
        </div>
      </div>
      <div class="nearby-panel__cols">
        <div class="nearby-col">
          <div class="nearby-col__title">📏 Más cercanas</div>
          ${nearest.map(s => _stationRow(s, fuelType, 'dist')).join('')}
        </div>
        <div class="nearby-col">
          <div class="nearby-col__title">💰 Más baratas (${_fuelLabel(fuelType)})</div>
          ${cheapest.length > 0
            ? cheapest.map(s => _stationRow(s, fuelType, 'price')).join('')
            : '<div class="nearby-row nearby-row--empty">Sin precios disponibles</div>'}
        </div>
      </div>
    </div>`;

  _container.classList.add('nearby-panel--visible');
  _wire();
  log.info(`Nearby panel: ${nearest.length} nearest, ${cheapest.length} cheapest`);
}

function _stationRow(station, fuelType, mode) {
  const price = station.prices?.[fuelType];
  const priceStr = price != null ? formatPriceMXN(price) : '—';
  const distStr = station.distanceKm != null ? formatDistance(station.distanceKm) : '—';
  const anomaly = station._isAnomaly ? ' <span class="nearby-anomaly">⚠️</span>' : '';

  return `
    <div class="nearby-row" data-id="${_esc(station.id)}">
      <div class="nearby-row__name">${_esc(station.name)}${anomaly}</div>
      <div class="nearby-row__meta">
        ${mode === 'price'
          ? `<span class="nearby-row__price">${priceStr}</span> · ${distStr}`
          : `<span class="nearby-row__dist">${distStr}</span> · ${priceStr}`}
      </div>
    </div>`;
}

function _clearBtn() {
  return `<button class="nearby-panel__clear" id="nearby-clear">✕ Limpiar pin</button>`;
}

function _fuelLabel(type) {
  return type === 'regular' ? 'Regular' : type === 'premium' ? 'Premium' : 'Diésel';
}

function _wire() {
  document.getElementById('nearby-clear')?.addEventListener('click', () => {
    setState({ userLocation: null, userLocationSource: null, userLocationLabel: null });
    localStorage.removeItem('gi_userLocation');
  });

  document.getElementById('nearby-share-wa')?.addEventListener('click', () => {
    const { filteredData, filters, userLocation } = getState();
    const fuelType = filters.fuelType ?? 'regular';
    const nearby = filteredData
      .filter(s => s.distanceKm != null && s.hasData && s.prices?.[fuelType] != null)
      .sort((a, b) => a.prices[fuelType] - b.prices[fuelType])
      .slice(0, 5);
    const msg = formatNearbyMessage(nearby, userLocation, fuelType);
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank', 'noopener');
  });

  document.querySelectorAll('.nearby-row[data-id]').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      const station = getState().mergedData.find(s => s.id === id);
      if (station) setState({ selectedStation: station });
    });
  });
}

function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
