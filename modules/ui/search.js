// MODULE: search
// PURPOSE: Real-time station search with dropdown, keyboard nav, city/brand shortcuts
// DEPENDS ON: state, helpers, logger

import { getState, setState, subscribe } from '../utils/state.js';
import { getBrands, getStates }         from '../data/stations.js';
import { getBrandColor }                from '../data/stations.js';
import { debounce, esc }                from '../utils/helpers.js';
import { createLogger }                 from '../utils/logger.js';

const log = createLogger('search');

let _inputEl   = null;
let _dropEl    = null;
let _activeIdx = -1;

/**
 * Initialize the search bar
 * @param {string} inputId   - search input element id
 * @param {string} dropdownId - dropdown container id
 */
export function initSearch(inputId, dropdownId) {
  _inputEl = document.getElementById(inputId);
  _dropEl  = document.getElementById(dropdownId);

  if (!_inputEl || !_dropEl) {
    log.error('Search elements not found');
    return;
  }

  _inputEl.addEventListener('input', debounce(onInput, 250));
  _inputEl.addEventListener('keydown', onKeydown);
  _inputEl.addEventListener('blur', () => setTimeout(closeDropdown, 150));

  log.info('Search initialized');
}

// ─── Input Handler ────────────────────────────────────────────────────────

function onInput(e) {
  const q = e.target.value.trim();
  setState({ searchQuery: q });

  if (q.length < 2) {
    closeDropdown();
    return;
  }
  renderDropdown(q);
}

// ─── Dropdown ─────────────────────────────────────────────────────────────

function renderDropdown(q) {
  const ql      = q.toLowerCase();
  const data    = getState().mergedData;
  const brands  = getBrands(data);
  const states  = getStates(data);

  // Match stations by name/address/zip
  const stationMatches = data
    .filter(s =>
      s.name?.toLowerCase().includes(ql)    ||
      s.city?.toLowerCase().includes(ql)    ||
      s.zipCode?.includes(ql)               ||
      s.address?.toLowerCase().includes(ql)
    )
    .slice(0, 6);

  // Match cities
  const cityMatches = [...new Set(
    data.filter(s => s.city?.toLowerCase().includes(ql)).map(s => s.city)
  )].slice(0, 4);

  // Match brands
  const brandMatches = brands.filter(b => b.name.toLowerCase().includes(ql)).slice(0, 3);

  if (!stationMatches.length && !cityMatches.length && !brandMatches.length) {
    const safe = q.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    _dropEl.innerHTML = `<div class="drop-no-results">No results for "<em>${safe}</em>"</div>`;
    _dropEl.classList.add('open');
    return;
  }

  const items = [];

  if (stationMatches.length) {
    items.push(`<div class="drop-group-header">Stations</div>`);
    items.push(...stationMatches.map(s => `
      <div class="drop-item" data-type="station" data-id="${esc(s.id)}">
        <span class="brand-dot" style="background:${getBrandColor(s.brand)}"></span>
        <span class="drop-name">${highlight(s.name, q)}</span>
        <span class="drop-sub">${esc(s.city)}</span>
      </div>`));
  }

  if (cityMatches.length) {
    items.push(`<div class="drop-group-header">Cities</div>`);
    items.push(...cityMatches.map(city => `
      <div class="drop-item" data-type="city" data-value="${esc(city)}">
        🏙 <span class="drop-name">${highlight(city, q)}</span>
      </div>`));
  }

  if (brandMatches.length) {
    items.push(`<div class="drop-group-header">Brands</div>`);
    items.push(...brandMatches.map(b => `
      <div class="drop-item" data-type="brand" data-value="${esc(b.name)}">
        <span class="brand-dot" style="background:${getBrandColor(b.name)}"></span>
        <span class="drop-name">${highlight(b.name, q)}</span>
        <span class="drop-sub">${b.count} stations</span>
      </div>`));
  }

  _dropEl.innerHTML = items.join('');
  _dropEl.classList.add('open');
  _activeIdx = -1;

  // Attach click handlers
  _dropEl.querySelectorAll('.drop-item').forEach(item => {
    item.addEventListener('click', () => onSelectItem(item));
  });
}

function highlight(text, query) {
  const safe = esc(text);
  if (!query) return safe;
  const safeQ = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${safeQ})`, 'gi');
  return safe.replace(regex, '<mark>$1</mark>');
}

function onSelectItem(item) {
  const type  = item.dataset.type;
  const state = getState();

  if (type === 'station') {
    const station = state.mergedData.find(s => s.id === item.dataset.id);
    if (station) {
      setState({ selectedStation: station });
      import('./map.js').then(m => m.highlightStation(station.id));
    }
  } else if (type === 'city') {
    const city = item.dataset.value;
    setState({ filters: { ...state.filters, cities: [city] } });
    import('./map.js').then(m => {
      const stations = state.mergedData.filter(s => s.city === city);
      m.fitToVisible(stations);
    });
  } else if (type === 'brand') {
    const brand = item.dataset.value;
    setState({ filters: { ...state.filters, brands: [brand] } });
  }

  _inputEl.value = '';
  setState({ searchQuery: '' });
  closeDropdown();
}

// ─── Keyboard Navigation ──────────────────────────────────────────────────

function onKeydown(e) {
  const items = _dropEl.querySelectorAll('.drop-item');
  if (!items.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _activeIdx = (_activeIdx + 1) % items.length;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _activeIdx = (_activeIdx - 1 + items.length) % items.length;
  } else if (e.key === 'Enter' && _activeIdx >= 0) {
    e.preventDefault();
    onSelectItem(items[_activeIdx]);
    return;
  } else if (e.key === 'Escape') {
    closeDropdown();
    _inputEl.blur();
    return;
  } else {
    return;
  }

  items.forEach((el, i) => el.classList.toggle('drop-active', i === _activeIdx));
  items[_activeIdx]?.scrollIntoView({ block: 'nearest' });
}

function closeDropdown() {
  _dropEl?.classList.remove('open');
  _activeIdx = -1;
}
