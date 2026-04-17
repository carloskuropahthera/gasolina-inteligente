// MODULE: filters
// PURPOSE: Filter controls — fuel type tabs, brand/state/city multi-select, price range, distance
// DEPENDS ON: stations, prices, state, logger

import { getBrands, getStates, getCities, getBrandColor, filterStations } from '../data/stations.js';
import { getStats }                from '../data/prices.js';
import { getState, setState, subscribe } from '../utils/state.js';
import { createLogger }            from '../utils/logger.js';
import { debounce, esc }           from '../utils/helpers.js';

const log = createLogger('filters');

let _sidebar = null;

/**
 * Initialize filter controls
 * @param {string} sidebarId
 */
export function initFilters(sidebarId) {
  _sidebar = document.getElementById(sidebarId);
  if (!_sidebar) { log.error(`Sidebar #${sidebarId} not found`); return; }

  subscribe('mergedData', () => rebuildFilters());
  subscribe('filters',    () => applyFilters());

  // Initial parse of URL hash
  parseURLHash();

  rebuildFilters();
  log.info('Filters initialized');
}

// ─── Rebuild (when data changes) ──────────────────────────────────────────

function rebuildFilters() {
  if (!_sidebar) return;
  const state = getState();
  const data  = state.mergedData;

  if (data.length === 0) return;

  const brands = getBrands(data);
  const states = getStates(data);
  const stats  = getStats(data, state.filters.fuelType ?? 'regular');

  _sidebar.innerHTML = `
    <div class="filters-header">
      <h3>Filters</h3>
      <button class="btn-sm" id="btn-reset-filters">Reset</button>
    </div>

    <!-- Fuel Type Tabs -->
    <div class="filter-section">
      <label class="filter-label">Fuel Type</label>
      <div class="fuel-tabs">
        ${['regular','premium','diesel'].map(ft => `
          <button class="fuel-tab${state.filters.fuelType === ft ? ' active' : ''}"
                  data-fuel="${ft}">
            ${ft.charAt(0).toUpperCase() + ft.slice(1)}
          </button>`).join('')}
      </div>
    </div>

    <!-- Brands -->
    <div class="filter-section">
      <label class="filter-label">Brand <span class="filter-count">${brands.length}</span></label>
      <div class="brand-list" id="brand-list">
        ${brands.map(b => `
          <label class="brand-row">
            <input type="checkbox" class="brand-cb" value="${esc(b.name)}"
              ${state.filters.brands.includes(b.name) ? 'checked' : ''}>
            <span class="brand-dot" style="background:${getBrandColor(b.name)}"></span>
            ${esc(b.name)}
            <span class="brand-count">${b.count}</span>
          </label>`).join('')}
      </div>
    </div>

    <!-- State/City cascading -->
    <div class="filter-section">
      <label class="filter-label">State</label>
      <select id="filter-state" class="filter-select">
        <option value="">All States</option>
        ${states.map(s => `<option value="${esc(s.name)}" ${state.filters.states.includes(s.name) ? 'selected' : ''}>${esc(s.name)} (${s.count})</option>`).join('')}
      </select>
    </div>
    <div class="filter-section" id="city-section">
      <label class="filter-label">City</label>
      <select id="filter-city" class="filter-select">
        <option value="">All Cities</option>
      </select>
    </div>

    <!-- Distance Slider -->
    <div class="filter-section" id="distance-section">
      <label class="filter-label">
        Max Distance
        <span id="dist-val">${state.filters.maxDistanceKm != null ? `${state.filters.maxDistanceKm} km` : 'No limit'}</span>
      </label>
      <input type="range" id="distance-slider" min="1" max="50" step="1"
        value="${state.filters.maxDistanceKm ?? 50}"
        ${!state.userLocation ? 'disabled title="Enable location first"' : ''}>
      ${!state.userLocation ? '<p class="filter-hint">📍 Enable location to filter by distance</p>' : ''}
    </div>

    <!-- Price Range -->
    <div class="filter-section">
      <label class="filter-label">
        Price Range
        <span id="price-range-val"></span>
      </label>
      <div class="price-range-row">
        <input type="number" id="price-min" class="price-input" step="0.01"
          placeholder="${stats.min.toFixed(2)}" value="${state.filters.priceRange?.min ?? ''}">
        <span>–</span>
        <input type="number" id="price-max" class="price-input" step="0.01"
          placeholder="${stats.max.toFixed(2)}" value="${state.filters.priceRange?.max ?? ''}">
      </div>
    </div>

    <!-- Toggles -->
    <div class="filter-section">
      <label class="toggle-row">
        <input type="checkbox" id="toggle-anomalies"
          ${state.filters.showAnomaliesOnly ? 'checked' : ''}>
        Anomalies only
        ${getState().anomalies.length > 0
          ? `<span class="filter-badge">${getState().anomalies.length}</span>` : ''}
      </label>
      <label class="toggle-row">
        <input type="checkbox" id="toggle-missing"
          ${state.filters.showMissingDataOnly ? 'checked' : ''}>
        Missing data only
      </label>
    </div>

    <!-- Active filter count -->
    <div class="active-filters" id="active-filters"></div>
  `;

  updateCityDropdown(state.filters.states[0] ?? null, state.filters.cities[0] ?? null);
  attachFilterListeners();
  updateActiveFilterBadge();
}

function updateCityDropdown(selectedState, selectedCity) {
  const cityEl = document.getElementById('filter-city');
  if (!cityEl) return;

  const cities = getCities(getState().mergedData, selectedState || null);
  cityEl.innerHTML = `<option value="">All Cities</option>` +
    cities.map(c => `<option value="${esc(c.name)}" ${c.name === selectedCity ? 'selected' : ''}>${esc(c.name)} (${c.count})</option>`).join('');
}

// ─── Apply Filters ────────────────────────────────────────────────────────

export function applyFilters() {
  const state    = getState();
  const filtered = filterStations(state.mergedData, { ...state.filters, searchQuery: state.searchQuery });

  // Update active filter badge
  updateActiveFilterBadge();

  // Write URL hash
  writeURLHash(state.filters);

  setState({ filteredData: filtered });
  log.debug(`Filter applied: ${filtered.length}/${state.mergedData.length} stations`);
}

// ─── URL Hash ─────────────────────────────────────────────────────────────

export function parseURLHash() {
  // Support both legacy `#key=val` and new `#?key=val` formats
  let raw = window.location.hash.slice(1);
  if (!raw) return;
  if (raw.startsWith('?')) raw = raw.slice(1);

  const params = new URLSearchParams(raw);
  const update = {};

  const VALID_FUEL_TYPES = ['regular', 'premium', 'diesel', 'regular_plus'];
  if (params.has('fuel')) {
    const fuel = params.get('fuel');
    if (VALID_FUEL_TYPES.includes(fuel)) update.fuelType = fuel;
  }
  if (params.has('brands'))  update.brands   = params.get('brands').split(',').filter(Boolean);
  if (params.has('brand'))   update.brands   = [params.get('brand')];   // legacy compat
  if (params.has('states'))  update.states   = params.get('states').split(',').filter(Boolean);
  if (params.has('state'))   update.states   = [params.get('state')];   // legacy compat
  if (params.has('dist')) {
    const d = parseInt(params.get('dist'), 10);
    if (!isNaN(d)) update.maxDistanceKm = d;
  }

  if (Object.keys(update).length > 0) {
    setState({ filters: { ...getState().filters, ...update } });
    log.info('Parsed URL hash filters', update);
  }

  // Station deep-link: open a specific station card from URL
  if (params.has('station')) {
    const stationId = params.get('station');
    // Defer until data is loaded (mergedData may be empty at parse time)
    const unsub = (() => {
      let fired = false;
      return subscribe('mergedData', (data) => {
        if (fired || !data.length) return;
        const match = data.find(s => s.id === stationId);
        if (match) {
          fired = true;
          setState({ selectedStation: match });
          log.info(`Deep-linked to station: ${match.name}`);
        }
      });
    })();
    void unsub; // suppress unused warning — subscriber auto-cleans on match
  }
}

function writeURLHash(filters) {
  const params = new URLSearchParams();
  if (filters.fuelType && filters.fuelType !== 'regular') params.set('fuel', filters.fuelType);
  if (filters.brands?.length)  params.set('brands', filters.brands.join(','));
  if (filters.states?.length)  params.set('states', filters.states.join(','));
  if (filters.maxDistanceKm != null) params.set('dist', filters.maxDistanceKm);
  const hash = params.toString();
  history.replaceState(null, '', hash ? `#?${hash}` : window.location.pathname);
}

// ─── Badge ────────────────────────────────────────────────────────────────

function updateActiveFilterBadge() {
  const f   = getState().filters;
  let count = 0;
  if (f.brands?.length > 0)      count++;
  if (f.states?.length > 0)      count++;
  if (f.cities?.length > 0)      count++;
  if (f.maxDistanceKm != null)   count++;
  if (f.priceRange != null)      count++;
  if (f.showAnomaliesOnly)       count++;
  if (f.showMissingDataOnly)     count++;

  const el = document.getElementById('active-filters');
  if (el) el.textContent = count > 0 ? `${count} active filter${count > 1 ? 's' : ''}` : '';

  const topBadge = document.getElementById('filter-active-count');
  if (topBadge) {
    topBadge.textContent = count > 0 ? count : '';
    topBadge.style.display = count > 0 ? 'inline-flex' : 'none';
  }
}

// ─── Listeners ────────────────────────────────────────────────────────────

function attachFilterListeners() {
  // Fuel tabs
  _sidebar.querySelectorAll('.fuel-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      setState({ filters: { ...getState().filters, fuelType: btn.dataset.fuel } });
      _sidebar.querySelectorAll('.fuel-tab').forEach(b => b.classList.toggle('active', b === btn));
    });
  });

  // Brand checkboxes
  const updateBrands = debounce(() => {
    const checked = [..._sidebar.querySelectorAll('.brand-cb:checked')].map(cb => cb.value);
    setState({ filters: { ...getState().filters, brands: checked } });
  }, 150);
  _sidebar.querySelectorAll('.brand-cb').forEach(cb => cb.addEventListener('change', updateBrands));

  // State dropdown
  document.getElementById('filter-state')?.addEventListener('change', (e) => {
    const st = e.target.value;
    setState({ filters: { ...getState().filters, states: st ? [st] : [], cities: [] } });
    updateCityDropdown(st || null, null);
  });

  // City dropdown
  document.getElementById('filter-city')?.addEventListener('change', (e) => {
    const c = e.target.value;
    setState({ filters: { ...getState().filters, cities: c ? [c] : [] } });
  });

  // Distance slider
  const distSlider = document.getElementById('distance-slider');
  if (distSlider) {
    distSlider.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.getElementById('dist-val').textContent = v < 50 ? `${v} km` : 'No limit';
    });
    distSlider.addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      setState({ filters: { ...getState().filters, maxDistanceKm: v < 50 ? v : null } });
    });
  }

  // Price range
  const applyPrice = debounce(() => {
    const min = parseFloat(document.getElementById('price-min')?.value);
    const max = parseFloat(document.getElementById('price-max')?.value);
    const range = (!isNaN(min) || !isNaN(max)) ? { min: min || 0, max: max || 999 } : null;
    setState({ filters: { ...getState().filters, priceRange: range } });
  }, 400);
  document.getElementById('price-min')?.addEventListener('input', applyPrice);
  document.getElementById('price-max')?.addEventListener('input', applyPrice);

  // Toggles
  document.getElementById('toggle-anomalies')?.addEventListener('change', (e) => {
    setState({ filters: { ...getState().filters, showAnomaliesOnly: e.target.checked } });
  });
  document.getElementById('toggle-missing')?.addEventListener('change', (e) => {
    setState({ filters: { ...getState().filters, showMissingDataOnly: e.target.checked } });
  });

  // Reset
  document.getElementById('btn-reset-filters')?.addEventListener('click', resetFilters);
}

function resetFilters() {
  setState({
    filters: {
      brands: [], states: [], cities: [],
      fuelType: 'regular',
      maxDistanceKm: null, priceRange: null,
      showAnomaliesOnly: false, showMissingDataOnly: false,
    },
    searchQuery: '',
  });
  rebuildFilters();
  history.replaceState(null, '', window.location.pathname);
  log.info('Filters reset');
}
