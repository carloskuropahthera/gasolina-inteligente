// MODULE: fuel-calculator
// PURPOSE: Simple trip fuel cost calculator — feasible Plan 2 addition from competitive analysis
// DEPENDS ON: state, logger

import { getState, subscribe } from '../utils/state.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('fuel-calc');
const LS_KEY = 'gi_vehicleProfile';

let _container = null;

// ─── Public API ───────────────────────────────────────────────────────────

export function initFuelCalculator(containerId) {
  _container = document.getElementById(containerId);
  if (!_container) return;

  _render();
  subscribe('filteredData', () => _updatePrices());
  log.info('Fuel calculator initialized');
}

// ─── Render ───────────────────────────────────────────────────────────────

function _render() {
  const profile = _loadProfile();
  _container.innerHTML = `
    <div class="fuel-calc" id="fuel-calc-widget">
      <div class="fuel-calc__header" id="fuel-calc-toggle">
        <span>⛽ Calculadora de viaje</span>
        <span class="fuel-calc__chevron">▼</span>
      </div>
      <div class="fuel-calc__body" id="fuel-calc-body">
        <div class="fuel-calc__row">
          <label>Eficiencia</label>
          <input id="fc-efficiency" type="number" min="1" max="40" step="0.5" value="${profile.efficiency}" placeholder="km/L">
          <span class="fuel-calc__unit">km/L</span>
        </div>
        <div class="fuel-calc__row">
          <label>Tanque</label>
          <input id="fc-tank" type="number" min="10" max="120" step="1" value="${profile.tankL}" placeholder="L">
          <span class="fuel-calc__unit">L</span>
        </div>
        <div class="fuel-calc__row">
          <label>Nivel actual</label>
          <input id="fc-level" type="number" min="0" max="100" step="5" value="${profile.levelPct}" placeholder="%">
          <span class="fuel-calc__unit">%</span>
        </div>
        <div class="fuel-calc__row">
          <label>Distancia</label>
          <input id="fc-distance" type="number" min="1" max="5000" step="10" value="${profile.distanceKm}" placeholder="km">
          <span class="fuel-calc__unit">km</span>
        </div>
        <div class="fuel-calc__results" id="fc-results"></div>
      </div>
    </div>`;

  // Toggle collapse
  document.getElementById('fuel-calc-toggle')?.addEventListener('click', () => {
    document.getElementById('fuel-calc-body')?.classList.toggle('fuel-calc__body--collapsed');
    const chevron = document.querySelector('.fuel-calc__chevron');
    if (chevron) chevron.textContent = chevron.textContent === '▼' ? '▲' : '▼';
  });

  // Live calculation on any input change
  ['fc-efficiency','fc-tank','fc-level','fc-distance'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => { _saveProfile(); _calculate(); });
  });

  _calculate();
}

function _calculate() {
  const efficiency = parseFloat(document.getElementById('fc-efficiency')?.value) || 0;
  const tankL      = parseFloat(document.getElementById('fc-tank')?.value) || 0;
  const levelPct   = parseFloat(document.getElementById('fc-level')?.value) ?? 50;
  const distanceKm = parseFloat(document.getElementById('fc-distance')?.value) || 0;

  const resultsEl = document.getElementById('fc-results');
  if (!resultsEl) return;

  if (!efficiency || !tankL || !distanceKm) {
    resultsEl.innerHTML = '<div class="fc-hint">Llena los campos para ver el costo</div>';
    return;
  }

  const currentFuelL = tankL * (levelPct / 100);
  const neededL = distanceKm / efficiency;
  const toFillL = Math.max(0, neededL - currentFuelL);

  // Get cheapest price from filtered data
  const { filteredData, filters } = getState();
  const fuelType = filters.fuelType ?? 'regular';
  const prices = filteredData
    .filter(s => s.hasData && s.prices?.[fuelType] != null)
    .map(s => s.prices[fuelType])
    .sort((a, b) => a - b);

  const cheapest = prices[0];
  const avg = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : null;

  const range = efficiency > 0 ? (currentFuelL * efficiency).toFixed(0) : '—';
  const fillCost = cheapest != null && toFillL > 0
    ? `<div class="fc-result fc-result--cost">💰 Llenar ${toFillL.toFixed(1)} L ≈ <strong>$${(toFillL * cheapest).toFixed(2)}</strong> (precio más bajo)</div>`
    : toFillL <= 0
    ? `<div class="fc-result fc-result--ok">✅ Combustible suficiente para el viaje</div>`
    : '';

  const avgCost = avg != null && toFillL > 0
    ? `<div class="fc-result">Precio promedio zona: $${(toFillL * avg).toFixed(2)}</div>`
    : '';

  resultsEl.innerHTML = `
    <div class="fc-result">Necesitas: <strong>${neededL.toFixed(1)} L</strong> · Autonomía actual: ~${range} km</div>
    ${fillCost}
    ${avgCost}`;
}

function _updatePrices() {
  // Re-run calculation when station data changes (new filters applied)
  _calculate();
}

// ─── Profile Persistence ──────────────────────────────────────────────────

function _loadProfile() {
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) return { efficiency: 12, tankL: 50, levelPct: 50, distanceKm: 100, ...JSON.parse(saved) };
  } catch { /* corrupt */ }
  return { efficiency: 12, tankL: 50, levelPct: 50, distanceKm: 100 };
}

function _saveProfile() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      efficiency: parseFloat(document.getElementById('fc-efficiency')?.value) || 12,
      tankL:      parseFloat(document.getElementById('fc-tank')?.value) || 50,
      levelPct:   parseFloat(document.getElementById('fc-level')?.value) ?? 50,
      distanceKm: parseFloat(document.getElementById('fc-distance')?.value) || 100,
    }));
  } catch { /* quota */ }
}
