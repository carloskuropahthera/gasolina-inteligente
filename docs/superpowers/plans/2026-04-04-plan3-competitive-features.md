# Competitive Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the feasible features from the competitive analysis that will differentiate Gasolina Inteligente from Gasoapp, GasApp, Litro por Litro, and PETROIntelligence — all without backend infrastructure or paid APIs.

**Architecture:** Layered onto the existing vanilla JS + static JSON foundation. Each feature is a new module with a clear state integration point. No framework changes. PWA-ready (already has service worker).

**Tech Stack:** Vanilla JS, Leaflet.js, Chart.js (already loaded), localStorage, CRE XML feed, Nominatim.

**Feasibility Filter Applied:**
| Feature | Feasible Now | Needs Backend | Notes |
|---|---|---|---|
| Price displayed on map pins | ✅ | No | Replaces cluster number |
| Price history charts | ✅ | No | From pipeline daily snapshots |
| Price staleness badges | ✅ | No | Compare exportedAt vs today |
| Profeco one-tap report | ✅ | No | Opens Profeco form with prefill |
| Data freshness indicator | ✅ | No | "Verified today" badge |
| Savings calculator | ✅ | No | Already partially done |
| Trip route optimizer | ✅ | No | OSRM free routing API |
| Crowdsourced prices | ❌ | Yes | Needs auth + DB |
| Gamification / points | ❌ | Yes | Needs user accounts |
| Wait times | ❌ | Yes | Needs active users |
| Live push alerts | ❌ | Yes | Needs backend + FCM |

---

## File Map

| File | Change |
|---|---|
| `modules/ui/map.js` | Price labels on zoom ≥13 markers |
| `modules/ui/price-badge.js` | NEW — Freshness + verification badges |
| `modules/ui/price-trends.js` | NEW — Chart.js price history panel |
| `modules/ui/route-optimizer.js` | NEW — Cheapest stop on route via OSRM |
| `modules/ui/profeco-report.js` | NEW — Pre-filled Profeco complaint form |
| `modules/ui/station-card.js` | Add freshness badge + Profeco button |
| `modules/utils/freshness.js` | NEW — Staleness logic (days since data) |
| `style.css` | New component styles |
| `app.js` | Init new modules |
| `index.html` | Add containers |

---

### Task 1: Price Labels on Map Pins at High Zoom

**Files:**
- Modify: `modules/ui/map.js`

Show the actual price (e.g., "$22.34") directly on map markers when zoomed in to street level (zoom ≥ 13), so users never need to tap a station to see its price.

- [ ] **Step 1: Add `_showPriceLabels` flag and zoom listener in `initMap()`**

```js
// Inside initMap(), after _map.addLayer(_markers):
_map.on('zoomend', () => {
  const zoom = _map.getZoom();
  _markers.eachLayer(marker => {
    if (marker._giStation) {
      const station = marker._giStation;
      const { filters } = getState();
      const fuelType = filters.fuelType ?? 'regular';
      const price = station.prices?.[fuelType];
      const color = getBrandColor(station.brand);
      marker.setIcon(createMarkerIcon(color, false, station._isAnomaly, zoom >= 13 ? price : null));
    }
  });
});
```

- [ ] **Step 2: Update `createMarkerIcon` to accept optional price label**

```js
function createMarkerIcon(color, isCheapest = false, isAnomaly = false, priceLabel = null) {
  const size   = isCheapest ? 14 : 10;
  const border = isAnomaly ? '#FFD700' : '#ffffff';
  const badge  = isCheapest ? '★' : '';

  if (priceLabel != null) {
    // Price-label mode: wider pill, shows "$22.34"
    const html = `
      <div style="
        background:${color};border:2px solid ${border};border-radius:4px;
        padding:2px 5px;font-size:9px;color:#fff;font-weight:700;
        white-space:nowrap;box-shadow:0 1px 4px #0008;
      ">$${Number(priceLabel).toFixed(2)}</div>`;
    const w = 48;
    return L.divIcon({ html, className: '', iconSize: [w, 16], iconAnchor: [w/2, 8] });
  }

  const html = `
    <div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${color};border:2px solid ${border};
      display:flex;align-items:center;justify-content:center;
      font-size:8px;color:#fff;font-weight:bold;
      ${isCheapest ? 'box-shadow:0 0 6px 2px rgba(0,255,136,0.6);' : ''}
    ">${badge}</div>`;

  return L.divIcon({ html, className: '', iconSize: [size, size], iconAnchor: [size/2, size/2], popupAnchor: [0, -size/2] });
}
```

- [ ] **Step 3: Store `_giStation` on each marker during `renderStations()`**

Inside the marker creation loop in `renderStations()`, add:
```js
marker._giStation = station;
```

- [ ] **Step 4: Verify in browser**

Open app → zoom in to zoom level 13+ on a dense area (CDMX) → markers should show prices as pills. Zoom out → revert to dots.

- [ ] **Step 5: Commit**

```bash
git add modules/ui/map.js
git commit -m "feat: show price labels on map markers at zoom >= 13"
```

---

### Task 2: Data Freshness Module + Station Badge

**Files:**
- Create: `modules/utils/freshness.js`
- Modify: `modules/ui/station-card.js`
- Modify: `modules/ui/map.js` (popup)

CRE data that hasn't changed in 80+ days is flagged as likely stale. Show a badge in station cards and popups.

- [ ] **Step 1: Create `modules/utils/freshness.js`**

```js
// MODULE: freshness
// PURPOSE: Classify how fresh a station's price data is

/**
 * @param {string|null} lastUpdated  ISO date string or null
 * @returns {'today'|'recent'|'stale'|'unknown'}
 */
export function getFreshness(lastUpdated) {
  if (!lastUpdated) return 'unknown';
  const days = (Date.now() - new Date(lastUpdated).getTime()) / 86_400_000;
  if (days < 1)  return 'today';
  if (days < 7)  return 'recent';
  if (days < 80) return 'ok';
  return 'stale';
}

/**
 * @param {'today'|'recent'|'ok'|'stale'|'unknown'} status
 * @returns {{ label: string, color: string, icon: string }}
 */
export function freshnessLabel(status) {
  return {
    today:   { label: 'Verificado hoy',    color: '#00FF88', icon: '✅' },
    recent:  { label: 'Reciente (< 7d)',   color: '#4fc3f7', icon: '🔵' },
    ok:      { label: 'Datos oficiales',   color: '#AAAAAA', icon: '📋' },
    stale:   { label: 'Datos desactualizados (80+ días)', color: '#FF8C00', icon: '⚠️' },
    unknown: { label: 'Sin fecha',         color: '#666680', icon: '❓' },
  }[status] ?? { label: 'Desconocido', color: '#666680', icon: '❓' };
}
```

- [ ] **Step 2: Import freshness in `modules/ui/map.js` popup builder**

Add to imports:
```js
import { getFreshness, freshnessLabel } from '../utils/freshness.js';
```

Add freshness badge to `buildPopup()` after `anomalyBanner`:
```js
const freshStatus = getFreshness(station.updatedAt ?? station.lastSeen ?? null);
const fresh = freshnessLabel(freshStatus);
const freshBadge = `<div class="popup-fresh" style="color:${fresh.color}">${fresh.icon} ${fresh.label}</div>`;
```

Insert `${freshBadge}` in the popup HTML after `${anomalyBanner}`.

- [ ] **Step 3: Read `modules/ui/station-card.js` to find where to add the badge**

Run: `Read modules/ui/station-card.js` — find the station name/header section.

Add freshness badge next to station name:
```js
import { getFreshness, freshnessLabel } from '../utils/freshness.js';
// In render function:
const fresh = freshnessLabel(getFreshness(station.updatedAt ?? null));
// Add to header HTML:
`<span class="fresh-badge" style="color:${fresh.color}" title="${fresh.label}">${fresh.icon}</span>`
```

- [ ] **Step 4: Add CSS to `style.css`**

```css
.popup-fresh { font-size: 11px; margin: 4px 0; padding: 2px 6px; border-radius: 3px; background: rgba(255,255,255,0.05); }
.fresh-badge { font-size: 14px; margin-left: 6px; cursor: help; }
```

- [ ] **Step 5: Commit**

```bash
git add modules/utils/freshness.js modules/ui/map.js modules/ui/station-card.js style.css
git commit -m "feat: data freshness badges on station cards and popups"
```

---

### Task 3: Profeco One-Tap Complaint Button

**Files:**
- Create: `modules/ui/profeco-report.js`
- Modify: `modules/ui/station-card.js`

Users can tap one button to open a pre-filled complaint against a station on the official Profeco portal (REPECO). Builds trust and official goodwill.

- [ ] **Step 1: Create `modules/ui/profeco-report.js`**

```js
// MODULE: profeco-report
// PURPOSE: Pre-fill and open Profeco REPECO complaint form for a station

const REPECO_URL = 'https://repeco.profeco.gob.mx/';

/**
 * Generate a report URL or data object for a station price complaint.
 * Profeco REPECO doesn't support URL pre-fill, so we open the site
 * and copy station info to clipboard so user can paste.
 * @param {Object} station
 * @param {string} complaintType  'precio_diferente'|'litros_cortos'|'mala_atencion'
 */
export async function openProfecoReport(station, complaintType = 'precio_diferente') {
  const labels = {
    precio_diferente: 'Precio diferente al anunciado',
    litros_cortos: 'Litros cortos / medida incorrecta',
    mala_atencion: 'Mala atención al cliente',
  };

  const text = [
    `Estación: ${station.name}`,
    `Marca: ${station.brand}`,
    `Dirección: ${station.address}, ${station.city}, ${station.state}`,
    `CRE ID: ${station.cre_id ?? station.id}`,
    `Motivo: ${labels[complaintType] ?? complaintType}`,
  ].join('\n');

  try {
    await navigator.clipboard.writeText(text);
  } catch { /* clipboard denied — show in alert */ }

  window.open(REPECO_URL, '_blank', 'noopener');
  return text;
}

/**
 * Render the complaint button HTML (for injection into station card).
 * @param {string} stationId
 * @returns {string}
 */
export function renderReportButton(stationId) {
  return `
    <div class="profeco-section">
      <div class="profeco-label">¿Precio incorrecto?</div>
      <div class="profeco-btns">
        <button class="profeco-btn" data-station-id="${stationId}" data-type="precio_diferente">💸 Precio diferente</button>
        <button class="profeco-btn" data-station-id="${stationId}" data-type="litros_cortos">📏 Litros cortos</button>
      </div>
      <div class="profeco-note">Abre Profeco REPECO y copia los datos de la estación al portapapeles.</div>
    </div>`;
}
```

- [ ] **Step 2: Read `modules/ui/station-card.js`** — find where the card HTML is assembled.

- [ ] **Step 3: Add import and button to station card**

```js
import { openProfecoReport, renderReportButton } from './profeco-report.js';

// In the card render, after the prices table:
${renderReportButton(station.id)}

// In the event wiring:
card.querySelectorAll('.profeco-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const type = btn.dataset.type;
    const text = await openProfecoReport(station, type);
    showToast('Datos copiados. Abriendo Profeco…', 'info');
  });
});
```

- [ ] **Step 4: Add CSS**

```css
.profeco-section { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }
.profeco-label { font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
.profeco-btns { display: flex; gap: 8px; flex-wrap: wrap; }
.profeco-btn {
  background: var(--bg-hover); border: 1px solid var(--border);
  color: var(--text-secondary); border-radius: var(--radius-sm);
  padding: 5px 10px; font-size: 12px; cursor: pointer;
}
.profeco-btn:hover { border-color: var(--accent-orange); color: var(--accent-orange); }
.profeco-note { font-size: 10px; color: var(--text-muted); margin-top: 6px; }
```

- [ ] **Step 5: Commit**

```bash
git add modules/ui/profeco-report.js modules/ui/station-card.js style.css
git commit -m "feat: one-tap Profeco complaint button on station cards"
```

---

### Task 4: Route Cheapest Stop Optimizer (OSRM — Free)

**Files:**
- Create: `modules/ui/route-optimizer.js`
- Modify: `index.html` (add `#route-panel`)
- Modify: `app.js` (init)

User enters start + end point → app finds the cheapest station within 5km of the route using the free OSRM public API for route geometry. No API key required.

- [ ] **Step 1: Create `modules/ui/route-optimizer.js`**

```js
// MODULE: route-optimizer
// PURPOSE: Find cheapest gas station along a user-defined route via OSRM

import { getState } from '../utils/state.js';
import { geocode } from '../api/geocoder.js';
import { formatPriceMXN, formatDistance } from '../utils/helpers.js';

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
  const startStr = document.getElementById('route-start')?.value?.trim();
  const endStr   = document.getElementById('route-end')?.value?.trim();
  const efficiency = parseFloat(document.getElementById('route-eff')?.value) || 12;
  const resultsEl = document.getElementById('route-results');

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

  // Get route from OSRM
  let routeCoords = null;
  try {
    const url = `${OSRM}/${startGeo.lng},${startGeo.lat};${endGeo.lng},${endGeo.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    const data = await res.json();
    routeCoords = data.routes?.[0]?.geometry?.coordinates ?? [];
  } catch {
    resultsEl.innerHTML = '<div class="route-hint route-hint--error">Error al calcular ruta. Intenta de nuevo.</div>';
    return;
  }

  const distKm = _routeLength(routeCoords);
  const neededL = distKm / efficiency;

  // Find stations within 5km of any route point (sampled every 10 points)
  const { filteredData, filters } = getState();
  const fuelType = filters.fuelType ?? 'regular';
  const sampled = routeCoords.filter((_, i) => i % 10 === 0);

  const candidates = filteredData.filter(s => {
    if (!s.hasData || !s.prices?.[fuelType] || !s.lat || !s.lng) return false;
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
        <div class="route-station__detail">${formatPriceMXN(s.prices[fuelType])} · Trip cost ~$${cost} · ${_esc(s.city)}</div>
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
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
```

- [ ] **Step 2: Add `<div id="route-optimizer">` to `index.html`** inside `#sidebar` after `#fuel-calculator`.

- [ ] **Step 3: Import and init in `app.js`**

```js
import { initRouteOptimizer } from './modules/ui/route-optimizer.js';
// In boot():
initRouteOptimizer('route-optimizer');
```

- [ ] **Step 4: Add CSS to `style.css`**

```css
.route-panel__header { display:flex; justify-content:space-between; font-size:13px; font-weight:600; color:var(--text-secondary); cursor:pointer; padding:4px 0; user-select:none; }
.route-panel__body { overflow:hidden; max-height:600px; transition: max-height 0.3s ease; }
.route-panel__body--collapsed { max-height:0; }
.route-input { width:100%; background:var(--bg-input); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text-primary); font-size:13px; padding:6px 8px; outline:none; margin-top:8px; box-sizing:border-box; }
.route-row { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-secondary); margin-top:8px; }
.route-mini-input { width:50px; background:var(--bg-input); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text-primary); font-size:13px; padding:4px 6px; outline:none; }
.route-hint { font-size:12px; color:var(--text-muted); text-align:center; padding:8px; }
.route-hint--error { color:var(--accent-red); }
.route-summary { font-size:12px; color:var(--text-secondary); padding:8px 0; border-bottom:1px solid var(--border); margin-bottom:8px; }
.route-station { padding:6px 0; border-bottom:1px solid var(--border); }
.route-station__name { font-size:13px; color:var(--text-primary); }
.route-station__detail { font-size:11px; color:var(--text-secondary); }
```

- [ ] **Step 5: Verify**

Open app → sidebar → route optimizer → enter "CDMX" and "Guadalajara" → should compute route and show top 3 cheapest stations along it.

- [ ] **Step 6: Commit**

```bash
git add modules/ui/route-optimizer.js index.html app.js style.css
git commit -m "feat: route optimizer — cheapest station along route via OSRM (free)"
```

---

### Task 5: Price History Chart Enhancement

**Files:**
- Modify: `modules/ui/station-card.js` (the chart is already there via Chart.js)

The station card already has a Chart.js history chart stub. Wire it to the real `price_history` array from pipeline snapshots. Add a trend indicator (📈 / 📉 / ➡️).

- [ ] **Step 1: Read `modules/ui/station-card.js`** to understand the existing chart implementation.

- [ ] **Step 2: Find the chart rendering section** — look for `new Chart` or `Chart.js` usage.

- [ ] **Step 3: Wire real price_history data**

The station object has `price_history` from `export_for_app.py`. Add trend calculation:

```js
function _priceTrend(history, fuelType) {
  const vals = (history ?? [])
    .map(h => h.prices?.[fuelType])
    .filter(v => v != null)
    .slice(-7); // last 7 days
  if (vals.length < 2) return null;
  const delta = vals[vals.length - 1] - vals[0];
  return delta > 0.05 ? '📈 Subiendo' : delta < -0.05 ? '📉 Bajando' : '➡️ Estable';
}
```

Add trend badge next to price in station card header:
```js
const trend = _priceTrend(station.price_history, fuelType);
// In HTML: ${trend ? `<span class="trend-badge">${trend}</span>` : ''}
```

- [ ] **Step 4: CSS**

```css
.trend-badge { font-size: 12px; margin-left: 8px; background: var(--bg-hover); border-radius: var(--radius-sm); padding: 2px 6px; }
```

- [ ] **Step 5: Commit**

```bash
git add modules/ui/station-card.js style.css
git commit -m "feat: price trend indicator (up/down/stable) in station cards"
```

---

### Task 6: Push to GitHub + Verify Vercel Deployment

- [ ] **Step 1: Push all commits**

```bash
git push origin main
```

- [ ] **Step 2: Verify Vercel deployment**

Go to `https://gasolina-inteligente.vercel.app` — confirm:
- Map shows price labels when zoomed in
- Station cards show freshness badge and Profeco button
- Sidebar has route optimizer and fuel calculator
- Location bar shows address input with typeahead

- [ ] **Step 3: Test on mobile** (or DevTools mobile emulation)

Resize to 375px width. Confirm:
- Location bar fits
- Nearby panel slides up correctly
- Route optimizer is collapsible

---

## Success Criteria

1. **Price labels at zoom 13+** — users see prices without tapping
2. **Freshness badges** — "Verificado hoy" vs "80+ días" clearly visible
3. **Profeco button** — copies station info + opens Profeco REPECO in one tap
4. **Route optimizer** — find cheapest station along any Mexico route
5. **Trend indicator** — 📈📉➡️ on station card prices

## What Was NOT Included (Needs Backend — Plan 4)

- **Crowdsourced price updates** — requires user auth, photo upload, vote system, DB
- **Gamification / points** — requires user accounts and reward backend
- **Live wait times** — requires real-time user check-ins
- **Push price alerts** — requires FCM/APNS + backend scheduler
- **Verified photo submissions** — requires storage + moderation

These are the features that would make this a market-dominating product but require a backend phase (Supabase + Edge Functions estimated ~2 weeks to scaffold).
