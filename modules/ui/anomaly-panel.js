// MODULE: anomaly-panel
// PURPOSE: Anomaly alerts dashboard with severity tabs and VIPER-style export
// DEPENDS ON: anomaly-detector, state, helpers, logger

import { detectAnomalies, getAnomalySummary } from '../analytics/anomaly-detector.js';
import { getState, setState, subscribe }      from '../utils/state.js';
import { getBrandColor }                      from '../data/stations.js';
import { arrayToCSV, downloadCSV, esc }       from '../utils/helpers.js';
import { createLogger }                       from '../utils/logger.js';

const log = createLogger('anomaly-panel');

let _panel     = null;
let _activeTab = 'severity';

/**
 * Initialize the anomaly panel
 * @param {string} panelId
 */
export function initAnomalyPanel(panelId) {
  _panel = document.getElementById(panelId);
  if (!_panel) { log.error(`Panel #${panelId} not found`); return; }

  subscribe('anomalies', () => {
    updateBadge();
    if (_panel.classList.contains('open')) renderPanel();
  });

  log.info('Anomaly panel initialized');
}

/**
 * Toggle panel open/closed
 */
export function toggleAnomalyPanel() {
  if (!_panel) return;
  _panel.classList.toggle('open');
  if (_panel.classList.contains('open')) renderPanel();
}

function updateBadge() {
  const badge  = document.getElementById('anomaly-badge');
  const count  = getState().anomalies.length;
  if (badge) {
    badge.textContent = count > 0 ? count : '';
    badge.style.display = count > 0 ? 'inline-flex' : 'none';
  }
}

// ─── Render ───────────────────────────────────────────────────────────────

function renderPanel() {
  if (!_panel) return;
  const anomalies = getState().anomalies;
  const summary   = getAnomalySummary(anomalies);

  _panel.innerHTML = `
    <div class="panel-inner">
      <div class="panel-header">
        <h2>⚠️ Price Anomalies</h2>
        <button class="panel-close" id="anomaly-close-btn">✕</button>
      </div>

      <div class="anom-headline">
        ${summary.total} station${summary.total !== 1 ? 's' : ''} detected
        — <span class="anom-hl-severe">${summary.severityCounts.severe} severe</span>,
        <span class="anom-hl-moderate">${summary.severityCounts.moderate} moderate</span>,
        <span class="anom-hl-mild">${summary.severityCounts.mild} mild</span>
      </div>

      <div class="anomaly-summary">
        <div class="anom-stat"><span class="anom-num">${summary.total}</span><span>Total</span></div>
        <div class="anom-stat anom-high"><span class="anom-num">${summary.highPricers}</span><span>High Pricers</span></div>
        <div class="anom-stat anom-low"><span class="anom-num">${summary.lowPricers}</span><span>Low Pricers</span></div>
        <div class="anom-stat anom-severe"><span class="anom-num">${summary.severityCounts.severe}</span><span>Severe</span></div>
      </div>

      <div class="panel-tabs">
        <button class="tab-btn${_activeTab === 'severity' ? ' active' : ''}" data-tab="severity">By Severity</button>
        <button class="tab-btn${_activeTab === 'city'     ? ' active' : ''}" data-tab="city">By City</button>
        <button class="tab-btn${_activeTab === 'brand'    ? ' active' : ''}" data-tab="brand">By Brand</button>
      </div>

      <div class="panel-tab-content">
        ${renderTabContent(anomalies, summary)}
      </div>

      <div class="panel-footer">
        <button class="btn-accent" id="btn-run-anomaly">🔍 Re-run Analysis</button>
        <button class="btn-sm" id="btn-export-anomaly">⬇ Export CSV</button>
      </div>
    </div>`;

  attachPanelListeners(anomalies);
}

function renderTabContent(anomalies, summary) {
  if (_activeTab === 'city') {
    return `<div class="agg-list">
      ${summary.byCity.map(item => `
        <div class="agg-row">
          <span>${esc(item.city)}</span>
          <span class="agg-count">${item.count}</span>
        </div>`).join('') || '<p class="muted">No data</p>'}
    </div>`;
  }

  if (_activeTab === 'brand') {
    return `<div class="agg-list">
      ${summary.byBrand.map(item => `
        <div class="agg-row">
          <span class="brand-dot" style="background:${getBrandColor(item.brand)}"></span>
          <span>${esc(item.brand)}</span>
          <span class="agg-count">${item.count}</span>
        </div>`).join('') || '<p class="muted">No data</p>'}
    </div>`;
  }

  // Default: by severity
  if (anomalies.length === 0) return '<p class="muted">No anomalies detected</p>';

  return anomalies.map(a => {
    const pctDiff = a.localAvg > 0
      ? (((a.price - a.localAvg) / a.localAvg) * 100)
      : 0;
    const pctLabel = pctDiff >= 0
      ? `+${pctDiff.toFixed(1)}% above area avg`
      : `${pctDiff.toFixed(1)}% below area avg`;
    const pctCls = pctDiff >= 0 ? 'price-hi' : 'price-lo';

    return `
    <div class="anomaly-card sev-${a.severity}" data-id="${a.stationId}">
      <div class="anom-card-header">
        <span class="brand-badge-sm" style="background:${getBrandColor(a.brand)}">${esc(a.brand)}</span>
        <span class="severity-badge severity-${a.severity}">${a.severity.toUpperCase()}</span>
        <span class="anom-dir ${a.direction === 'high' ? 'price-hi' : 'price-lo'}">
          ${a.direction === 'high' ? '↑ HIGH' : '↓ LOW'}
        </span>
      </div>
      <div class="anom-card-name">${esc(a.name)}</div>
      <div class="anom-card-city">${esc(a.city)}, ${esc(a.state)}</div>
      <div class="anom-card-detail">
        ${a.fuelType.charAt(0).toUpperCase() + a.fuelType.slice(1)}:
        <strong>$${a.price.toFixed(2)}</strong>
        <span class="anom-pct-diff ${pctCls}">${pctLabel}</span>
        — $${Math.abs(a.price - a.localAvg).toFixed(2)}
        ${a.direction === 'high' ? 'above' : 'below'}
        local avg $${a.localAvg.toFixed(2)}
        (z=${a.zScore.toFixed(1)}, ${a.nearbyCount} neighbors)
      </div>
      <button class="btn-xs view-on-map-btn" data-id="${a.stationId}">View on Map</button>
    </div>`;
  }).join('');
}

// ─── Events ───────────────────────────────────────────────────────────────

function attachPanelListeners(anomalies) {
  document.getElementById('anomaly-close-btn')?.addEventListener('click', () => {
    _panel.classList.remove('open');
  });

  _panel.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      renderPanel();
    });
  });

  _panel.querySelectorAll('.view-on-map-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = btn.dataset.id ?? e.target.dataset.id;
      const s  = getState().mergedData.find(st => st.id === id);
      if (s) {
        setState({ selectedStation: s });
        _panel.classList.remove('open');
        // highlight on map
        import('./map.js').then(m => m.highlightStation(id));
      }
    });
  });

  document.getElementById('btn-run-anomaly')?.addEventListener('click', async () => {
    const { mergedData, filters } = getState();
    const anoms = detectAnomalies(mergedData, filters.fuelType ?? 'regular');
    // Tag stations with anomaly flag
    const anomIds = new Set(anoms.map(a => a.stationId));
    const tagged  = mergedData.map(s => ({ ...s, _isAnomaly: anomIds.has(s.id) }));
    setState({ anomalies: anoms, mergedData: tagged });
    log.info(`Re-run anomaly detection: ${anoms.length} found`);
  });

  document.getElementById('btn-export-anomaly')?.addEventListener('click', () => {
    const rows = anomalies.map(a => ({
      stationId: a.stationId, name: a.name, brand: a.brand,
      city: a.city, state: a.state, fuelType: a.fuelType,
      price: a.price, localAvg: a.localAvg, zScore: a.zScore,
      direction: a.direction, severity: a.severity, nearbyCount: a.nearbyCount,
    }));
    const csv = arrayToCSV(rows, Object.keys(rows[0] ?? {}));
    downloadCSV(`anomalies_${new Date().toISOString().slice(0,10)}.csv`, csv);
  });

  // Anomaly card click → select station
  _panel.querySelectorAll('.anomaly-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('view-on-map-btn')) return;
      const id = card.dataset.id;
      const s  = getState().mergedData.find(st => st.id === id);
      if (s) setState({ selectedStation: s });
    });
  });
}
