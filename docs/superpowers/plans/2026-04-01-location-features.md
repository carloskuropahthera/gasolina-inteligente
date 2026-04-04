# Location Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three location features: (1) a smart address input bar with Nominatim typeahead, (2) drop-a-pin on the map with radius circle, (3) a nearby panel showing nearest + cheapest stations within the radius.

**Architecture:** All three features write to `state.userLocation` — the same field GPS already uses. This means distance filtering, distance sorting, and the price list all work automatically with zero changes to their logic. New modules: `geocoder.js` (Nominatim wrapper), `location-bar.js` (address input UI), `nearby-panel.js` (results panel). Map.js gets a click handler, pin marker, and radius circle.

**Tech Stack:** Vanilla JS ES modules, Leaflet.js (already loaded), Nominatim public API (free, no key), existing state.js observable pattern.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `modules/api/geocoder.js` | **Create** | Heuristic normalizer + Nominatim geocode/suggest |
| `modules/ui/location-bar.js` | **Create** | Address input, GPS button, typeahead dropdown, location status |
| `modules/ui/nearby-panel.js` | **Create** | Slide-up panel: nearest 5 + cheapest 5 within radius |
| `modules/ui/map.js` | **Modify** | Add click→pin handler, draggable pin marker, radius circle |
| `modules/utils/state.js` | **Modify** | Add `userLocationSource` and `userLocationLabel` fields |
| `modules/ui/filters.js` | **Modify** | Remove "Enable location" hint (location-bar owns this now) |
| `app.js` | **Modify** | Import + init location-bar and nearby-panel |
| `index.html` | **Modify** | Add `<div id="location-bar">` above sidebar, `<div id="nearby-panel">` in map |

---

### Task 1: Extend state with location source fields

**Files:**
- Modify: `modules/utils/state.js` (line ~10, inside `_state` object)

- [ ] **Step 1: Add two fields to `_state`**

In `modules/utils/state.js`, find the line `userLocation: null,` and add two fields immediately after:

```js
  userLocation: null,
  userLocationSource: null,   // 'gps' | 'pin' | 'address' | null
  userLocationLabel: null,    // human-readable string for display, or null
```

- [ ] **Step 2: Verify in browser console**

Start the dev server. Open browser console and run:
```js
import('./modules/utils/state.js').then(m => console.log(Object.keys(m.getState())))
```
Expected: array includes `'userLocationSource'` and `'userLocationLabel'`.

- [ ] **Step 3: Commit**

```bash
git add modules/utils/state.js
git commit -m "feat: add userLocationSource and userLocationLabel to state"
```

---

### Task 2: Build the geocoder module

**Files:**
- Create: `modules/api/geocoder.js`

- [ ] **Step 1: Create `modules/api/geocoder.js`**

```js
// MODULE: geocoder
// PURPOSE: Heuristic Spanish address normalizer + Nominatim geocode/suggest
// DEPENDS ON: nothing (pure fetch)

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

// Spanish filler words to strip before geocoding
const FILLERS = [
  'cerca del', 'cerca de la', 'cerca de', 'junto al', 'junto a la', 'junto a',
  'frente al', 'frente a la', 'frente a', 'a un lado del', 'a un lado de',
  'por la', 'por el', 'sobre la', 'sobre el', 'entre la', 'entre el',
  'esquina con', 'esquina de',
];

// Common Mexican abbreviations → expanded forms
const ABBREVS = {
  'cdmx': 'Ciudad de México',
  'mty': 'Monterrey',
  'gdl': 'Guadalajara',
  'gto': 'Guanajuato',
  'qro': 'Querétaro',
  'col.': 'Colonia ',
  ' col ': ' Colonia ',
  'av.': 'Avenida ',
  'blvd.': 'Boulevard ',
  'carr.': 'Carretera ',
};

// Session cache: normalized query string → array of results
const _cache = new Map();

/**
 * Preprocess raw Spanish input into 1–3 geocodable candidate strings.
 * @param {string} raw
 * @returns {string[]}
 */
export function normalize(raw) {
  let q = raw.toLowerCase().trim();

  // Strip filler words
  for (const filler of FILLERS) {
    q = q.replace(new RegExp(`\\b${filler}\\b`, 'g'), '').trim();
  }

  // Expand abbreviations
  for (const [abbr, full] of Object.entries(ABBREVS)) {
    q = q.replaceAll(abbr, full).trim();
  }

  // 5-digit postal code
  if (/^\d{5}$/.test(q.trim())) {
    return [`CP ${q.trim()}, México`];
  }

  // Remove double spaces
  q = q.replace(/\s+/g, ' ').trim();

  // Generate candidates by progressively dropping leading tokens
  const tokens = q.split(/[,\s]+/).filter(Boolean);
  const candidates = [q];
  if (tokens.length > 2) candidates.push(tokens.slice(1).join(' '));
  if (tokens.length > 3) candidates.push(tokens.slice(2).join(' '));

  return [...new Set(candidates)].filter(c => c.length >= 3);
}

/**
 * Query Nominatim for a single string, returning up to 3 results.
 * Results are cached for the session.
 * @param {string} query
 * @returns {Promise<Array<{lat: number, lng: number, displayName: string}>>}
 */
async function _nominatim(query) {
  const key = query.toLowerCase().trim();
  if (_cache.has(key)) return _cache.get(key);

  const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&countrycodes=mx&format=json&limit=3&addressdetails=0`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept-Language': 'es-MX,es',
        'User-Agent': 'GasolinaInteligente/1.0 (educational project)',
      },
    });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const data = await res.json();
    const results = data.map(r => ({
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      displayName: r.display_name,
    }));
    _cache.set(key, results);
    return results;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Geocoding timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Geocode a raw Spanish query to a single best result.
 * @param {string} query
 * @returns {Promise<{lat: number, lng: number, displayName: string} | null>}
 */
export async function geocode(query) {
  const candidates = normalize(query);
  for (const candidate of candidates) {
    try {
      const results = await _nominatim(candidate);
      if (results.length > 0) return results[0];
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Return up to 5 location suggestions for a raw query (for typeahead).
 * @param {string} query
 * @returns {Promise<Array<{label: string, lat: number, lng: number}>>}
 */
export async function suggest(query) {
  if (!query || query.trim().length < 3) return [];
  const candidates = normalize(query);
  const seen = new Set();
  const results = [];

  for (const candidate of candidates) {
    try {
      const hits = await _nominatim(candidate);
      for (const hit of hits) {
        // Deduplicate by rounded coordinates
        const key = `${hit.lat.toFixed(2)},${hit.lng.toFixed(2)}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ label: hit.displayName, lat: hit.lat, lng: hit.lng });
        }
      }
    } catch {
      // continue with remaining candidates
    }
  }

  return results.slice(0, 5);
}
```

- [ ] **Step 2: Smoke-test in browser console**

With the dev server running, open the browser console and run:
```js
const m = await import('./modules/api/geocoder.js');
console.log(m.normalize('cerca del oxxo en polanco cdmx'));
// Expected: ['oxxo en polanco Ciudad de México', 'en polanco Ciudad de México', 'polanco Ciudad de México']

const r = await m.geocode('Polanco CDMX');
console.log(r);
// Expected: { lat: ~19.43, lng: ~-99.19, displayName: 'Polanco, ..., Ciudad de México, ...' }

const s = await m.suggest('monterrey centro');
console.log(s);
// Expected: array of 1–5 objects each with { label, lat, lng }
```

- [ ] **Step 3: Commit**

```bash
git add modules/api/geocoder.js
git commit -m "feat: add geocoder module with heuristic normalizer and Nominatim typeahead"
```

---

### Task 3: Build the location bar UI module

**Files:**
- Create: `modules/ui/location-bar.js`

- [ ] **Step 1: Create `modules/ui/location-bar.js`**

```js
// MODULE: location-bar
// PURPOSE: Address input with typeahead + GPS button above the filters sidebar
// DEPENDS ON: geocoder, state, logger

import { createLogger }            from '../utils/logger.js';
import { getState, setState, subscribe } from '../utils/state.js';
import { geocode, suggest }        from '../api/geocoder.js';

const log = createLogger('location-bar');
const STORAGE_KEY = 'gi_userLocation';

let _container    = null;
let _debounceTimer = null;

// ─── Public API ───────────────────────────────────────────────────────────────

export function initLocationBar(containerId) {
  _container = document.getElementById(containerId);
  if (!_container) { log.warn(`Container #${containerId} not found`); return; }
  _restoreFromStorage();
  subscribe('userLocation',       _render);
  subscribe('userLocationSource', _render);
  subscribe('userLocationLabel',  _render);
  _render();
}

// ─── Storage ──────────────────────────────────────────────────────────────────

function _restoreFromStorage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    const { lat, lng, displayName } = JSON.parse(saved);
    if (lat && lng && !getState().userLocation) {
      setState({
        userLocation:       { lat, lng },
        userLocationSource: 'address',
        userLocationLabel:  displayName ?? null,
      });
      log.info('Restored location from storage:', displayName);
    }
  } catch { /* ignore corrupt storage */ }
}

function _persist(lat, lng, displayName) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ lat, lng, displayName }));
  } catch { /* ignore quota errors */ }
}

function _clearStorage() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function _render() {
  if (!_container) return;
  const { userLocation, userLocationSource, userLocationLabel } = getState();
  const addressVal = userLocationSource === 'address' ? (userLocationLabel ?? '') : '';

  _container.innerHTML = `
    <div class="location-bar">
      <div class="location-input-row">
        <div class="location-input-wrap">
          <span class="location-pin-icon">📍</span>
          <input
            id="location-input"
            type="text"
            class="location-input"
            placeholder="Colonia, dirección, CP…"
            value="${addressVal.replace(/"/g, '&quot;')}"
            autocomplete="off"
            spellcheck="false"
          >
          <div id="location-suggestions" class="location-suggestions hidden"></div>
        </div>
        <button class="btn-gps ${userLocationSource === 'gps' ? 'btn-gps--active' : ''}"
                id="btn-use-gps" title="Usar mi ubicación GPS">
          📡
        </button>
      </div>
      ${userLocation ? `
        <div class="location-status">
          ${userLocationSource === 'gps'
            ? '📡 GPS activo'
            : userLocationSource === 'pin'
              ? '📌 Pin en mapa'
              : `📍 ${userLocationLabel ?? 'Ubicación manual'}`}
          <button class="btn-clear-location" id="btn-clear-location" title="Limpiar ubicación">✕</button>
        </div>
      ` : ''}
    </div>
  `;

  _attachListeners();
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

function _attachListeners() {
  const input       = document.getElementById('location-input');
  const suggestions = document.getElementById('location-suggestions');

  input?.addEventListener('input', e => {
    clearTimeout(_debounceTimer);
    const q = e.target.value.trim();
    if (q.length < 3) { _hideSuggestions(); return; }
    _debounceTimer = setTimeout(() => _showSuggestions(q), 400);
  });

  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      clearTimeout(_debounceTimer);
      _hideSuggestions();
      _resolveQuery(input.value);
    }
    if (e.key === 'Escape') _hideSuggestions();
  });

  // Hide suggestions on click outside
  document.addEventListener('click', e => {
    if (!_container?.contains(e.target)) _hideSuggestions();
  }, { once: true });

  document.getElementById('btn-use-gps')?.addEventListener('click', _requestGPS);

  document.getElementById('btn-clear-location')?.addEventListener('click', () => {
    setState({
      userLocation:       null,
      userLocationSource: null,
      userLocationLabel:  null,
    });
    _clearStorage();
  });
}

function _hideSuggestions() {
  document.getElementById('location-suggestions')?.classList.add('hidden');
}

// ─── Typeahead ────────────────────────────────────────────────────────────────

async function _showSuggestions(query) {
  const el = document.getElementById('location-suggestions');
  if (!el) return;
  el.innerHTML = '<div class="suggestion-loading">Buscando…</div>';
  el.classList.remove('hidden');

  let results;
  try {
    results = await suggest(query);
  } catch {
    el.innerHTML = '<div class="suggestion-empty">Error al buscar</div>';
    return;
  }

  if (!results.length) {
    el.innerHTML = '<div class="suggestion-empty">Sin resultados</div>';
    return;
  }

  el.innerHTML = results.map((r, i) =>
    `<div class="suggestion-item" data-i="${i}"
          data-lat="${r.lat}" data-lng="${r.lng}"
          data-label="${r.label.replace(/"/g, '&quot;')}">
       ${r.label}
     </div>`
  ).join('');

  el.querySelectorAll('.suggestion-item[data-lat]').forEach(item => {
    item.addEventListener('click', () => {
      const lat   = parseFloat(item.dataset.lat);
      const lng   = parseFloat(item.dataset.lng);
      const label = item.dataset.label;
      _hideSuggestions();
      const input = document.getElementById('location-input');
      if (input) input.value = label;
      _applyLocation(lat, lng, label);
    });
  });
}

// ─── Geocode on Enter ─────────────────────────────────────────────────────────

async function _resolveQuery(query) {
  if (!query.trim()) return;
  let result;
  try {
    result = await geocode(query);
  } catch {
    log.warn('Geocode failed for:', query);
    return;
  }
  if (!result) {
    log.info('No geocode result for:', query);
    return;
  }
  _applyLocation(result.lat, result.lng, result.displayName);
}

// ─── Apply location ───────────────────────────────────────────────────────────

function _applyLocation(lat, lng, label) {
  setState({
    userLocation:       { lat, lng },
    userLocationSource: 'address',
    userLocationLabel:  label,
  });
  _persist(lat, lng, label);
  log.info('Location set:', label, { lat, lng });
}

// ─── GPS ──────────────────────────────────────────────────────────────────────

function _requestGPS() {
  if (!navigator.geolocation) {
    log.warn('Geolocation not supported by this browser');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      setState({
        userLocation:       { lat: pos.coords.latitude, lng: pos.coords.longitude },
        userLocationSource: 'gps',
        userLocationLabel:  null,
      });
      _clearStorage();
      log.info('GPS location acquired', { lat: pos.coords.latitude, lng: pos.coords.longitude });
    },
    err => log.warn('GPS error:', err.message),
    { timeout: 10000, maximumAge: 60000 },
  );
}
```

- [ ] **Step 2: Add CSS for location-bar to `style.css`**

Append to `style.css`:

```css
/* ── Location Bar ──────────────────────────────────────────── */
.location-bar {
  padding: 8px 12px;
  background: #1a1a2e;
  border-bottom: 1px solid #2a2a3e;
}

.location-input-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.location-input-wrap {
  position: relative;
  flex: 1;
}

.location-pin-icon {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 14px;
  pointer-events: none;
}

.location-input {
  width: 100%;
  padding: 7px 8px 7px 28px;
  background: #12122a;
  border: 1px solid #3a3a5e;
  border-radius: 6px;
  color: #e0e0ff;
  font-size: 13px;
  box-sizing: border-box;
}

.location-input:focus {
  outline: none;
  border-color: #6c63ff;
}

.location-input::placeholder { color: #555577; }

.btn-gps {
  background: #1e1e3a;
  border: 1px solid #3a3a5e;
  border-radius: 6px;
  color: #aaaacc;
  padding: 7px 10px;
  cursor: pointer;
  font-size: 16px;
  flex-shrink: 0;
}

.btn-gps--active {
  border-color: #6c63ff;
  color: #6c63ff;
}

.btn-gps:hover { border-color: #6c63ff; }

.location-status {
  margin-top: 5px;
  font-size: 11px;
  color: #8888aa;
  display: flex;
  align-items: center;
  gap: 6px;
}

.btn-clear-location {
  background: none;
  border: none;
  color: #666688;
  cursor: pointer;
  padding: 0 2px;
  font-size: 12px;
  line-height: 1;
}

.btn-clear-location:hover { color: #ff6666; }

/* Suggestions dropdown */
.location-suggestions {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: #1a1a2e;
  border: 1px solid #3a3a5e;
  border-radius: 6px;
  z-index: 9999;
  max-height: 200px;
  overflow-y: auto;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
}

.location-suggestions.hidden { display: none; }

.suggestion-item {
  padding: 8px 12px;
  font-size: 12px;
  color: #c0c0e0;
  cursor: pointer;
  border-bottom: 1px solid #2a2a3e;
  line-height: 1.4;
}

.suggestion-item:last-child { border-bottom: none; }
.suggestion-item:hover, .suggestion-item:focus { background: #252540; }
.suggestion-loading, .suggestion-empty {
  padding: 8px 12px;
  font-size: 12px;
  color: #666688;
  font-style: italic;
}
```

- [ ] **Step 3: Add `<div id="location-bar">` to `index.html`**

In `index.html`, find `<aside id="sidebar"></aside>` and replace with:

```html
    <!-- Location Bar (above sidebar) -->
    <div id="location-bar"></div>

    <!-- Filters Sidebar -->
    <aside id="sidebar"></aside>
```

- [ ] **Step 4: Wire into `app.js`**

Add import at the top of `app.js` with the other UI imports:

```js
import { initLocationBar }  from './modules/ui/location-bar.js';
```

Inside the `boot()` function, after `initFilters('sidebar');`, add:

```js
  initLocationBar('location-bar');
```

- [ ] **Step 5: Remove "Enable location" hint from `filters.js`**

In `modules/ui/filters.js`, find and remove this line:

```js
      ${!state.userLocation ? '<p class="filter-hint">📍 Enable location to filter by distance</p>' : ''}
```

- [ ] **Step 6: Update `geo.js` GPS init to use new state fields**

In `modules/data/geo.js` (or wherever GPS init currently calls `setState({ userLocation })`), update to also set `userLocationSource`:

Find the existing GPS success callback (search for `setState.*userLocation`) and change it to:
```js
setState({ userLocation: { lat, lng }, userLocationSource: 'gps', userLocationLabel: null });
```

- [ ] **Step 7: Bump `index.html` version to force module reload**

In `index.html`, update the script tag:
```html
<script type="module" src="app.js?v=12"></script>
```

- [ ] **Step 8: Smoke test**

Restart dev server. Open the app. Verify:
- Location bar appears above the filters sidebar
- Typing "Polanco CDMX" shows a typeahead dropdown within 1s
- Clicking a suggestion updates the location status to "📍 [address]"
- Distance slider in filters becomes enabled
- Refreshing the page restores the saved address silently

- [ ] **Step 9: Commit**

```bash
git add modules/api/geocoder.js modules/ui/location-bar.js modules/ui/filters.js modules/data/geo.js app.js index.html style.css
git commit -m "feat: add location bar with address input, GPS button, and Nominatim typeahead"
```

---

### Task 4: Drop-a-pin on the map

**Files:**
- Modify: `modules/ui/map.js`

- [ ] **Step 1: Add module-level pin variables at top of `map.js`**

After the existing `let _heatLayer = null;` line, add:

```js
let _pinMarker  = null;   // draggable user-placed pin
let _pinCircle  = null;   // radius circle around pin
```

- [ ] **Step 2: Add `_updatePinAndCircle()` helper to `map.js`**

Add this function before `initMap`:

```js
function _updatePinAndCircle(lat, lng, radiusKm) {
  if (!_map) return;

  // Remove existing pin and circle
  if (_pinMarker) { _pinMarker.remove(); _pinMarker = null; }
  if (_pinCircle) { _pinCircle.remove(); _pinCircle = null; }

  if (lat == null || lng == null) return;

  const pinIcon = L.divIcon({ // eslint-disable-line no-undef
    className: '',
    html: `<div class="user-pin">📌</div>`,
    iconSize:   [28, 28],
    iconAnchor: [14, 28],
  });

  _pinMarker = L.marker([lat, lng], { icon: pinIcon, draggable: true }) // eslint-disable-line no-undef
    .addTo(_map);

  _pinMarker.on('dragend', e => {
    const { lat: newLat, lng: newLng } = e.target.getLatLng();
    setState({
      userLocation:       { lat: newLat, lng: newLng },
      userLocationSource: 'pin',
      userLocationLabel:  null,
    });
  });

  const radiusM = (radiusKm ?? 10) * 1000;
  _pinCircle = L.circle([lat, lng], { // eslint-disable-line no-undef
    radius:      radiusM,
    color:       '#6c63ff',
    fillColor:   '#6c63ff',
    fillOpacity: 0.08,
    weight:      2,
    dashArray:   '6 4',
  }).addTo(_map);
}
```

- [ ] **Step 3: Add map click handler in `initMap()`**

Inside `initMap()`, after `_map.addLayer(_markers);`, add:

```js
  // Drop-a-pin: click on map (not on a marker) sets userLocation
  _map.on('click', e => {
    // Don't fire if clicking on a station marker popup
    if (e.originalEvent.target.closest?.('.leaflet-marker-icon, .leaflet-popup')) return;
    const { lat, lng } = e.latlng;
    setState({
      userLocation:       { lat, lng },
      userLocationSource: 'pin',
      userLocationLabel:  null,
    });
  });
```

- [ ] **Step 4: Add exported `updateUserPin()` function to `map.js`**

At the bottom of `map.js`, add:

```js
/**
 * Update or remove the user pin and radius circle on the map.
 * Called from app.js state subscription.
 * @param {object|null} userLocation - { lat, lng } or null
 * @param {string|null} source - 'pin' | 'gps' | 'address' | null
 * @param {number|null} radiusKm - radius to draw, null = 10km default
 */
export function updateUserPin(userLocation, source, radiusKm) {
  if (source === 'pin') {
    _updatePinAndCircle(userLocation?.lat, userLocation?.lng, radiusKm);
  } else {
    // GPS or address — remove any existing pin
    _updatePinAndCircle(null, null, null);
  }
}
```

- [ ] **Step 5: Add user-pin CSS to `style.css`**

```css
/* ── User drop pin ─────────────────────────────────────────── */
.user-pin {
  font-size: 24px;
  line-height: 1;
  filter: drop-shadow(0 2px 4px rgba(0,0,0,0.6));
  cursor: grab;
}
.user-pin:active { cursor: grabbing; }
```

- [ ] **Step 6: Wire `updateUserPin` in `app.js`**

Add `updateUserPin` to the map import in `app.js`:

```js
import { initMap, renderStations, highlightStation, showAnomalies, updateUserPin } from './modules/ui/map.js';
```

In the `wireStateSubscriptions()` function inside `app.js`, add a subscription:

```js
  subscribe('userLocation', () => {
    const { userLocation, userLocationSource, filters } = getState();
    updateUserPin(userLocation, userLocationSource, filters.maxDistanceKm);
  });
  subscribe('userLocationSource', () => {
    const { userLocation, userLocationSource, filters } = getState();
    updateUserPin(userLocation, userLocationSource, filters.maxDistanceKm);
  });
```

Also update the distance slider subscription (if one exists) to call `updateUserPin` when `maxDistanceKm` changes so the circle resizes. Find where `filters` changes are subscribed and add:

```js
  subscribe('filters', () => {
    const { userLocation, userLocationSource, filters } = getState();
    updateUserPin(userLocation, userLocationSource, filters.maxDistanceKm);
  });
```

- [ ] **Step 7: Smoke test**

Reload the app. Click on an empty area of the map (not on a cluster). Verify:
- A 📌 pin appears at the click point
- A purple dashed circle appears around the pin (default 10km)
- The location bar status changes to "📌 Pin en mapa"
- The pin is draggable — drag it and the circle follows
- Moving the distance slider resizes the circle

- [ ] **Step 8: Commit**

```bash
git add modules/ui/map.js app.js style.css
git commit -m "feat: add drop-a-pin on map with draggable pin and radius circle"
```

---

### Task 5: Build the nearby panel

**Files:**
- Create: `modules/ui/nearby-panel.js`

- [ ] **Step 1: Create `modules/ui/nearby-panel.js`**

```js
// MODULE: nearby-panel
// PURPOSE: Slide-up panel showing nearest + cheapest stations within radius when pin/location is active
// DEPENDS ON: state, logger, helpers

import { createLogger }          from '../utils/logger.js';
import { getState, subscribe }   from '../utils/state.js';
import { formatPriceMXN, formatDistance, esc } from '../utils/helpers.js';

const log = createLogger('nearby-panel');

let _container = null;
const DEFAULT_RADIUS_KM = 10;
const PANEL_SIZE = 5;

// ─── Public API ───────────────────────────────────────────────────────────────

export function initNearbyPanel(containerId) {
  _container = document.getElementById(containerId);
  if (!_container) { log.warn(`Container #${containerId} not found`); return; }
  subscribe('userLocation',       _render);
  subscribe('userLocationSource', _render);
  subscribe('filteredData',       _render);
  subscribe('filters',            _render);
  _render();
}

// ─── Render ───────────────────────────────────────────────────────────────────

function _render() {
  if (!_container) return;
  const { userLocation, userLocationSource, filteredData, filters } = getState();

  // Panel only shows when a location is set
  if (!userLocation) {
    _container.classList.add('hidden');
    return;
  }

  const fuelType = filters.fuelType ?? 'regular';
  const radiusKm = filters.maxDistanceKm ?? DEFAULT_RADIUS_KM;

  // Stations within radius that have distance data
  const inRadius = filteredData
    .filter(s => s.distanceKm != null && s.distanceKm <= radiusKm);

  if (!inRadius.length) {
    _container.classList.remove('hidden');
    _container.innerHTML = `
      <div class="nearby-panel">
        <div class="nearby-header">
          <span>📍 Sin estaciones en ${radiusKm} km</span>
          <button class="nearby-close" id="btn-nearby-close">✕</button>
        </div>
      </div>`;
    document.getElementById('btn-nearby-close')?.addEventListener('click', _close);
    return;
  }

  // Nearest 5
  const nearest = [...inRadius]
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, PANEL_SIZE);

  // Cheapest 5 (must have price data)
  const cheapest = [...inRadius]
    .filter(s => s.prices?.[fuelType] != null)
    .sort((a, b) => a.prices[fuelType] - b.prices[fuelType])
    .slice(0, PANEL_SIZE);

  _container.classList.remove('hidden');
  _container.innerHTML = `
    <div class="nearby-panel">
      <div class="nearby-header">
        <span>📍 ${inRadius.length} estaciones en ${radiusKm} km</span>
        <button class="nearby-close" id="btn-nearby-close">✕</button>
      </div>
      <div class="nearby-columns">
        <div class="nearby-col">
          <div class="nearby-col-title">Más cercanas</div>
          ${nearest.map(s => _stationRow(s, fuelType, 'distance')).join('')}
        </div>
        <div class="nearby-col">
          <div class="nearby-col-title">Más baratas (${fuelType})</div>
          ${cheapest.length
            ? cheapest.map(s => _stationRow(s, fuelType, 'price')).join('')
            : '<div class="nearby-empty">Sin precios disponibles</div>'}
        </div>
      </div>
    </div>
  `;

  document.getElementById('btn-nearby-close')?.addEventListener('click', _close);

  _container.querySelectorAll('.nearby-station-row').forEach(row => {
    row.addEventListener('click', () => {
      const id      = row.dataset.id;
      const station = getState().filteredData.find(s => s.id === id);
      if (station) {
        const { setState: _setState } = getState.__stateModule ?? {};
        // Use the global setState via dynamic import (module is already loaded)
        import('../utils/state.js').then(m => m.setState({ selectedStation: station }));
      }
    });
  });
}

function _stationRow(s, fuelType, emphasis) {
  const price = s.prices?.[fuelType];
  return `
    <div class="nearby-station-row" data-id="${esc(s.id)}">
      <div class="nearby-station-name">${esc(s.name)}</div>
      <div class="nearby-station-meta">
        ${emphasis === 'distance'
          ? `<span class="nearby-highlight">${formatDistance(s.distanceKm)}</span> · ${price != null ? formatPriceMXN(price) : '—'}`
          : `<span class="nearby-highlight">${price != null ? formatPriceMXN(price) : '—'}</span> · ${formatDistance(s.distanceKm)}`}
      </div>
    </div>
  `;
}

function _close() {
  _container.classList.add('hidden');
}
```

- [ ] **Step 2: Add nearby panel container to `index.html`**

Inside the `<div id="map">` block, after `<div id="map-container"></div>`, add:

```html
      <!-- Nearby Panel: slide-up card when location is active -->
      <div id="nearby-panel" class="hidden"></div>
```

- [ ] **Step 3: Add nearby panel CSS to `style.css`**

```css
/* ── Nearby Panel ──────────────────────────────────────────── */
#nearby-panel {
  position: absolute;
  bottom: 40px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 800;
  width: min(560px, 95vw);
  max-height: 280px;
  overflow-y: auto;
}

#nearby-panel.hidden { display: none; }

.nearby-panel {
  background: #12122a;
  border: 1px solid #3a3a5e;
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  overflow: hidden;
}

.nearby-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 14px;
  background: #1a1a3a;
  border-bottom: 1px solid #2a2a4e;
  font-size: 12px;
  color: #9999cc;
  font-weight: 600;
}

.nearby-close {
  background: none;
  border: none;
  color: #666688;
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
}
.nearby-close:hover { color: #ff6666; }

.nearby-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
}

.nearby-col {
  padding: 8px 0;
  border-right: 1px solid #2a2a3e;
}
.nearby-col:last-child { border-right: none; }

.nearby-col-title {
  padding: 4px 14px 6px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #6c63ff;
}

.nearby-station-row {
  padding: 6px 14px;
  cursor: pointer;
  border-bottom: 1px solid #1e1e3a;
  transition: background 0.1s;
}
.nearby-station-row:hover { background: #1e1e3a; }
.nearby-station-row:last-child { border-bottom: none; }

.nearby-station-name {
  font-size: 12px;
  color: #d0d0f0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nearby-station-meta {
  font-size: 11px;
  color: #7777aa;
  margin-top: 2px;
}

.nearby-highlight {
  color: #a0f0a0;
  font-weight: 600;
}

.nearby-empty {
  padding: 6px 14px;
  font-size: 11px;
  color: #555577;
  font-style: italic;
}
```

- [ ] **Step 4: Wire into `app.js`**

Add import:
```js
import { initNearbyPanel } from './modules/ui/nearby-panel.js';
```

In `boot()`, after `initLocationBar('location-bar');`, add:
```js
  initNearbyPanel('nearby-panel');
```

- [ ] **Step 5: Smoke test**

Reload the app. Drop a pin on the map by clicking. Verify:
- Nearby panel slides up from the bottom of the map
- Shows "X estaciones en 10 km"
- Two columns: "Más cercanas" (sorted by distance) and "Más baratas" (sorted by price)
- Clicking a row in the panel opens the station detail drawer
- "✕" button closes the panel
- Moving the distance slider changes the radius circle AND updates the panel count

- [ ] **Step 6: Commit**

```bash
git add modules/ui/nearby-panel.js index.html app.js style.css
git commit -m "feat: add nearby panel showing nearest and cheapest stations within radius"
```

---

### Task 6: Final integration test

- [ ] **Step 1: Full user flow test — address input**

1. Open the app
2. In the location bar, type "Roma Norte CDMX"
3. Verify: typeahead appears with suggestions within 1s
4. Click a suggestion
5. Verify: location status shows "📍 Roma Norte, ..."
6. Verify: distance slider in filters is now enabled
7. Verify: nearby panel appears with stations
8. Reload the page
9. Verify: location is restored silently from localStorage, nearby panel still shows

- [ ] **Step 2: Full user flow test — drop pin**

1. Click the GPS button (📡) — confirm GPS is requested (browser permission prompt)
2. Click on the map (empty area, not a station cluster)
3. Verify: 📌 pin appears, purple dashed circle appears
4. Verify: location bar shows "📌 Pin en mapa"
5. Drag the pin to a new location
6. Verify: circle moves, nearby panel updates

- [ ] **Step 3: Full user flow test — clearing**

1. With a location set, click "✕" in the location bar status
2. Verify: pin disappears, circle disappears, nearby panel hides, distance slider disables

- [ ] **Step 4: Final commit**

```bash
git add .
git commit -m "feat: location features complete — address input, drop-a-pin, nearby panel"
```

---

## Success Criteria

- Typing fuzzy Spanish address → Nominatim typeahead → distance filtering works
- Clicking map → pin drops → radius circle → nearby panel shows nearest + cheapest 5
- Dragging pin → circle and panel update
- Clearing location → pin, circle, panel all removed, distance slider disabled
- Location persists across page reloads (address mode only)
- No new external API costs — Nominatim is free
