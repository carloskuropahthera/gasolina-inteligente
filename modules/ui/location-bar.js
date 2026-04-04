// MODULE: location-bar
// PURPOSE: Smart location input — address typeahead + GPS button + pin mode indicator
// DEPENDS ON: geocoder, state, logger

import { suggest, geocode } from '../api/geocoder.js';
import { setState, getState, subscribe } from '../utils/state.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('location-bar');
const LS_KEY = 'gi_userLocation';

let _container = null;
let _debounceTimer = null;
let _currentSuggestions = [];

const PLACEHOLDERS = [
  'Polanco, CDMX',
  'CP 64000',
  'Av. Insurgentes, Roma Norte',
  'Monterrey, NL',
  'Tlalnepantla',
];
let _placeholderIdx = 0;

// ─── Public API ───────────────────────────────────────────────────────────

export function initLocationBar(containerId) {
  _container = document.getElementById(containerId);
  if (!_container) return;

  _render();
  _restoreFromStorage();
  _startPlaceholderCycle();

  // Re-render when location source changes
  subscribe('userLocationSource', () => _render());
  subscribe('userLocationLabel', () => _render());

  log.info('Location bar initialized');
}

// ─── Render ───────────────────────────────────────────────────────────────

function _render() {
  const { userLocation, userLocationSource, userLocationLabel } = getState();

  if (userLocationSource === 'gps') {
    _container.innerHTML = `
      <div class="loc-bar loc-bar--gps">
        <span class="loc-bar__icon">📍</span>
        <span class="loc-bar__label">Usando GPS</span>
        <button class="loc-bar__switch" id="loc-switch-address">Usar dirección ▼</button>
      </div>`;
    document.getElementById('loc-switch-address')?.addEventListener('click', _switchToAddress);

  } else if (userLocationSource === 'pin') {
    _container.innerHTML = `
      <div class="loc-bar loc-bar--pin">
        <span class="loc-bar__icon">📌</span>
        <span class="loc-bar__label">${_esc(userLocationLabel || 'Pin en el mapa')}</span>
        <button class="loc-bar__gps" id="loc-gps-btn" title="Usar GPS">📍 GPS</button>
        <button class="loc-bar__switch" id="loc-switch-address2">Dirección</button>
        <button class="loc-bar__clear" id="loc-clear-pin">✕</button>
      </div>`;
    document.getElementById('loc-gps-btn')?.addEventListener('click', _requestGPS);
    document.getElementById('loc-switch-address2')?.addEventListener('click', _switchToAddress);
    document.getElementById('loc-clear-pin')?.addEventListener('click', _clearLocation);

  } else {
    // Mode B: no location or address mode
    const label = userLocationSource === 'address' && userLocationLabel
      ? `📍 ${_esc(userLocationLabel)}`
      : '';
    _container.innerHTML = `
      <div class="loc-bar loc-bar--input">
        <div class="loc-bar__input-wrap">
          <span class="loc-bar__search-icon">🔍</span>
          <input
            id="loc-address-input"
            class="loc-bar__input"
            type="text"
            autocomplete="off"
            placeholder="¿Dónde estás? Colonia, dirección, CP…"
          >
          <div id="loc-suggestions" class="loc-suggestions hidden"></div>
        </div>
        <button class="loc-bar__gps" id="loc-gps-btn" title="Usar GPS">📍 GPS</button>
      </div>
      ${label ? `<div class="loc-bar__confirmed">${label}</div>` : ''}`;

    const input = document.getElementById('loc-address-input');
    document.getElementById('loc-gps-btn')?.addEventListener('click', _requestGPS);
    input?.addEventListener('input', _onInput);
    input?.addEventListener('keydown', _onKeyDown);
    input?.addEventListener('blur', () => setTimeout(_hideSuggestions, 200));
    _cyclePlaceholder(input);
  }
}

// ─── Input Handling ───────────────────────────────────────────────────────

function _onInput(e) {
  const val = e.target.value;
  clearTimeout(_debounceTimer);
  if (val.length < 3) { _hideSuggestions(); return; }
  _debounceTimer = setTimeout(() => _fetchSuggestions(val), 400);
}

function _onKeyDown(e) {
  if (e.key === 'Enter') {
    clearTimeout(_debounceTimer);
    const val = e.target.value.trim();
    if (!val) return;
    if (_currentSuggestions.length > 0) {
      _selectSuggestion(_currentSuggestions[0]);
    } else {
      _geocodeAndSet(val);
    }
  }
  if (e.key === 'Escape') _hideSuggestions();
}

async function _fetchSuggestions(query) {
  const list = await suggest(query);
  _currentSuggestions = list;
  _showSuggestions(list);
}

async function _geocodeAndSet(query) {
  _showStatus('Buscando…');
  const result = await geocode(query);
  if (result) {
    _applyLocation(result.lat, result.lng, _shortLabel(result.displayName), 'address');
  } else {
    _showStatus(`Sin resultados para "${query}"`);
  }
}

// ─── Suggestions Dropdown ─────────────────────────────────────────────────

function _showSuggestions(items) {
  const el = document.getElementById('loc-suggestions');
  if (!el) return;
  if (items.length === 0) { _hideSuggestions(); return; }

  el.innerHTML = items.map((item, i) =>
    `<div class="loc-suggestion" data-idx="${i}">${_esc(item.label)}</div>`
  ).join('');
  el.classList.remove('hidden');

  el.querySelectorAll('.loc-suggestion').forEach(div => {
    div.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const idx = parseInt(div.dataset.idx);
      _selectSuggestion(_currentSuggestions[idx]);
    });
  });
}

function _selectSuggestion(item) {
  _hideSuggestions();
  _applyLocation(item.lat, item.lng, item.label, 'address');
}

function _hideSuggestions() {
  document.getElementById('loc-suggestions')?.classList.add('hidden');
}

// ─── Location Application ─────────────────────────────────────────────────

function _applyLocation(lat, lng, label, source) {
  setState({ userLocation: { lat, lng }, userLocationSource: source, userLocationLabel: label });
  _saveToStorage({ lat, lng, label, source });
  log.info(`Location set via ${source}: ${label}`, { lat, lng });
}

function _clearLocation() {
  setState({ userLocation: null, userLocationSource: null, userLocationLabel: null });
  localStorage.removeItem(LS_KEY);
}

// ─── GPS ──────────────────────────────────────────────────────────────────

async function _requestGPS() {
  if (!navigator.geolocation) {
    _showStatus('GPS no disponible en este dispositivo');
    return;
  }
  _showStatus('Obteniendo GPS…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      _applyLocation(lat, lng, 'Tu ubicación GPS', 'gps');
    },
    () => _showStatus('GPS denegado — escribe tu dirección'),
    { timeout: 10000, maximumAge: 60000 }
  );
}

function _switchToAddress() {
  setState({ userLocationSource: null, userLocationLabel: null });
}

// ─── Persistence ──────────────────────────────────────────────────────────

function _restoreFromStorage() {
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (!saved) return;
    const { lat, lng, label, source } = JSON.parse(saved);
    if (lat && lng && source !== 'gps') {
      setState({ userLocation: { lat, lng }, userLocationSource: source, userLocationLabel: label });
      log.info('Restored location from storage', { lat, lng, label });
    }
  } catch { /* corrupt storage */ }
}

function _saveToStorage(data) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch { /* quota */ }
}

// ─── Placeholder Cycle ────────────────────────────────────────────────────

function _startPlaceholderCycle() {
  setInterval(() => {
    _placeholderIdx = (_placeholderIdx + 1) % PLACEHOLDERS.length;
    const input = document.getElementById('loc-address-input');
    if (input && !input.value) input.placeholder = `¿Dónde estás? Ej: ${PLACEHOLDERS[_placeholderIdx]}`;
  }, 3000);
}

function _cyclePlaceholder(input) {
  if (input) input.placeholder = `¿Dónde estás? Ej: ${PLACEHOLDERS[_placeholderIdx]}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function _showStatus(msg) {
  const el = document.getElementById('loc-suggestions');
  if (!el) return;
  el.innerHTML = `<div class="loc-suggestion loc-suggestion--status">${_esc(msg)}</div>`;
  el.classList.remove('hidden');
}

function _shortLabel(displayName) {
  return displayName.split(',').slice(0, 3).map(s => s.trim()).join(', ');
}

function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
