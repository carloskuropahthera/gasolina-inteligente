// MODULE: dev-panel
// PURPOSE: Developer tools panel (Ctrl+Shift+D) — API, matrix, mock, storage, state, logs
// DEPENDS ON: fetch-strategy, matrix-loader, distance-generator, storage-interface, state, logger

import { testAllProxies, getWorkingProxy }                  from '../api/fetch-strategy.js';
import { loadMatrix, isLoaded, getStats as matrixStats }   from '../precompute/matrix-loader.js';
import { generateMatrix, estimateGenerationTime }          from '../precompute/distance-generator.js';
import * as storage from '../storage/storage-interface.js';
import { getState, setState, subscribeAll }                from '../utils/state.js';
import { getHistory, clearHistory }                        from '../utils/logger.js';
import { formatDuration, downloadJSON, esc }               from '../utils/helpers.js';
import { createLogger }                                    from '../utils/logger.js';

const log = createLogger('dev-panel');

const PLACES_URL = 'https://publicacionexterna.azurewebsites.net/publicaciones/places';
const PRICES_URL = 'https://publicacionexterna.azurewebsites.net/publicaciones/prices';

let _panel      = null;
let _activeTab  = 'api';
let _stateUnsub = null;
let _stateTimer = null;

/**
 * Initialize the dev panel (hidden by default, Ctrl+Shift+D to open)
 * @param {string} panelId
 */
export function initDevPanel(panelId) {
  _panel = document.getElementById(panelId);
  if (!_panel) { log.warn(`Dev panel #${panelId} not found`); return; }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      toggleDevPanel();
    }
  });

  log.info('Dev panel ready (Ctrl+Shift+D)');
}

export function toggleDevPanel() {
  if (!_panel) return;
  const isOpen = _panel.classList.toggle('open');
  if (isOpen) {
    renderPanel();
    startStateWatcher();
  } else {
    stopStateWatcher();
  }
}

// ─── Render ───────────────────────────────────────────────────────────────

function renderPanel() {
  if (!_panel) return;

  const tabs = ['api','matrix','mock','storage','state','logs','perf'];

  _panel.innerHTML = `
    <div class="dev-panel-inner">
      <div class="dev-header">
        <span class="dev-title">🛠 Dev Panel</span>
        <div class="dev-tabs">
          ${tabs.map(t => `<button class="dev-tab${_activeTab === t ? ' active' : ''}" data-tab="${t}">${t.toUpperCase()}</button>`).join('')}
        </div>
        <button class="panel-close" id="dev-close-btn">✕</button>
      </div>
      <div class="dev-content" id="dev-content">
        ${renderTab(_activeTab)}
      </div>
    </div>`;

  attachDevListeners();
}

function renderTab(tab) {
  switch(tab) {
    case 'api':     return renderAPITab();
    case 'matrix':  return renderMatrixTab();
    case 'mock':    return renderMockTab();
    case 'storage': return renderStorageTab();
    case 'state':   return renderStateTab();
    case 'logs':    return renderLogsTab();
    case 'perf':    return renderPerfTab();
    default:        return '<p>Unknown tab</p>';
  }
}

// ── API Tab ───────────────────────────────────────────────────────────────
function renderAPITab() {
  const proxy = getWorkingProxy() ?? 'none cached';
  return `
    <div class="dev-section">
      <strong>Working Proxy:</strong> <code>${proxy}</code>
    </div>
    <div class="dev-row">
      <button class="btn-sm" id="btn-test-proxies">Test All Proxies</button>
      <button class="btn-sm" id="btn-test-places">Test Places API</button>
      <button class="btn-sm" id="btn-test-prices">Test Prices API</button>
    </div>
    <div id="proxy-results" class="dev-results"></div>
    <div id="api-response" class="dev-json-box"></div>`;
}

// ── Matrix Tab ────────────────────────────────────────────────────────────
function renderMatrixTab() {
  const stCount = getState().mergedData.length || 100;
  return `
    <div class="dev-section">
      <strong>Matrix Status:</strong>
      ${[5,20,50].map(r => {
        const loaded = isLoaded(r);
        const ms     = matrixStats(r);
        return `<div class="matrix-row">
          <span class="${loaded ? 'status-ok' : 'status-na'}">${loaded ? '●' : '○'}</span>
          <strong>${r}km</strong>
          ${loaded ? `— ${ms?.stationCount} stations, ${ms?.pairCount} pairs` : '— not loaded'}
        </div>`;
      }).join('')}
    </div>
    ${[5,20,50].map(r => {
      const est = estimateGenerationTime(stCount, r);
      return `<div class="dev-row">
        <button class="btn-sm btn-gen-matrix" data-radius="${r}">
          Generate ${r}km Matrix (~${est}s)
        </button>
      </div>`;
    }).join('')}
    <div id="matrix-progress" class="dev-results"></div>
    <div class="dev-row" style="margin-top:12px">
      <label>Test getNearby: Station ID</label>
      <input id="nearby-test-id" class="dev-input" placeholder="MX001">
      <input id="nearby-test-radius" class="dev-input" placeholder="10" style="width:60px"> km
      <button class="btn-sm" id="btn-test-nearby">Test</button>
    </div>
    <div id="nearby-results" class="dev-results"></div>`;
}

// ── Mock Tab ──────────────────────────────────────────────────────────────
function renderMockTab() {
  const isMock = getState().mockMode;
  return `
    <div class="dev-section">
      <strong>Data Source:</strong>
      <div class="dev-row" style="margin-top:8px">
        <button class="btn-sm ${!isMock ? 'btn-accent' : ''}" id="btn-real-mode">Real API</button>
        <button class="btn-sm ${isMock  ? 'btn-accent' : ''}" id="btn-mock-mode">Mock Data</button>
      </div>
      ${isMock ? '<div class="mock-banner">⚠️ MOCK MODE ACTIVE</div>' : ''}
    </div>
    <div class="dev-row">
      <button class="btn-sm" id="btn-reload-data">Reload Data</button>
    </div>`;
}

// ── Storage Tab ───────────────────────────────────────────────────────────
function renderStorageTab() {
  const snapshots = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('gi_')) {
      const val = localStorage.getItem(key) ?? '';
      snapshots.push({ key, size: `${(val.length / 1024).toFixed(1)}KB`, age: '—' });
    }
  }
  return `
    <div class="dev-row">
      <button class="btn-sm btn-danger" id="btn-clear-all-storage">Clear All (⚠️)</button>
      <button class="btn-sm" id="btn-export-all-storage">Export All Snapshots</button>
    </div>
    <table class="dev-table">
      <thead><tr><th>Key</th><th>Size</th></tr></thead>
      <tbody>
        ${snapshots.map(s => `<tr><td><code>${s.key}</code></td><td>${s.size}</td></tr>`).join('') || '<tr><td colspan="2">Empty</td></tr>'}
      </tbody>
    </table>`;
}

// ── State Tab ─────────────────────────────────────────────────────────────
function renderStateTab() {
  const state = getState();
  // Truncate large arrays
  const display = {
    ...state,
    stations:   `[${state.stations?.length ?? 0} items]`,
    mergedData: `[${state.mergedData?.length ?? 0} items]`,
    filteredData:`[${state.filteredData?.length ?? 0} items]`,
    prices:     `[${state.prices?.length ?? 0} items]`,
  };
  return `
    <div class="dev-section">
      <span class="muted">Auto-refreshes every 2s</span>
    </div>
    <pre class="dev-state-box" id="dev-state-pre">${JSON.stringify(display, null, 2)}</pre>`;
}

// ── Logs Tab ──────────────────────────────────────────────────────────────
function renderLogsTab() {
  const entries = getHistory().slice(-200).reverse();
  return `
    <div class="dev-row">
      <select id="log-level-filter" class="dev-input">
        <option value="all">All Levels</option>
        <option value="debug">Debug+</option>
        <option value="info">Info+</option>
        <option value="warn">Warn+</option>
        <option value="error">Error only</option>
      </select>
      <button class="btn-sm" id="btn-clear-logs">Clear</button>
      <button class="btn-sm" id="btn-export-logs">Export .txt</button>
    </div>
    <div class="dev-log-box" id="dev-log-box">
      ${entries.map(e => `
        <div class="log-entry log-${e.level}">
          <span class="log-ts">${e.ts.slice(11,19)}</span>
          <span class="log-level">${e.level.toUpperCase()}</span>
          <span class="log-mod">[${e.module}]</span>
          <span>${e.message}</span>
        </div>`).join('')}
    </div>`;
}

// ── Perf Tab ──────────────────────────────────────────────────────────────
function renderPerfTab() {
  const state = getState();
  return `
    <div class="dev-section">
      <div class="perf-row"><span>Stations loaded:</span><strong>${state.stations?.length ?? 0}</strong></div>
      <div class="perf-row"><span>Price records:</span><strong>${state.prices?.length ?? 0}</strong></div>
      <div class="perf-row"><span>Filtered results:</span><strong>${state.filteredData?.length ?? 0}</strong></div>
      <div class="perf-row"><span>Anomalies detected:</span><strong>${state.anomalies?.length ?? 0}</strong></div>
      <div class="perf-row"><span>Distance matrix:</span>
        <strong>${state.distanceMatrixLoaded ? 'Loaded (O(1) lookups)' : 'Not loaded (real-time haversine)'}</strong>
      </div>
      <div class="perf-row"><span>Mock mode:</span><strong>${state.mockMode ? 'YES' : 'No'}</strong></div>
      <div class="perf-row"><span>Last fetch:</span><strong>${state.lastFetch ?? '—'}</strong></div>
    </div>`;
}

// ─── Events ───────────────────────────────────────────────────────────────

function attachDevListeners() {
  document.getElementById('dev-close-btn')?.addEventListener('click', () => {
    toggleDevPanel();
  });

  _panel.querySelectorAll('.dev-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      renderPanel();
    });
  });

  // API
  document.getElementById('btn-test-proxies')?.addEventListener('click', async () => {
    const el = document.getElementById('proxy-results');
    if (el) el.innerHTML = 'Testing all proxies…';
    const results = await testAllProxies(PLACES_URL);
    if (el) el.innerHTML = results.map(r =>
      `<div class="${r.success ? 'test-ok' : 'test-fail'}">
        ${r.success ? '✓' : '✗'} ${r.name} — ${r.latencyMs}ms ${r.error ? `(${esc(r.error)})` : ''}
      </div>`
    ).join('');
  });

  document.getElementById('btn-test-places')?.addEventListener('click', async () => {
    const el = document.getElementById('api-response');
    if (el) el.innerHTML = '<pre>Fetching Places API…</pre>';
    const { fetchStations } = await import('../api/cre-client.js');
    const r = await fetchStations(getState().mockMode);
    if (el) {
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify({ success: r.success, count: r.data?.length, meta: r.meta }, null, 2);
      el.replaceChildren(pre);
    }
  });

  document.getElementById('btn-test-prices')?.addEventListener('click', async () => {
    const el = document.getElementById('api-response');
    if (el) el.innerHTML = '<pre>Fetching Prices API…</pre>';
    const { fetchPrices } = await import('../api/cre-client.js');
    const r = await fetchPrices(getState().mockMode);
    if (el) {
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify({ success: r.success, count: r.data?.length, meta: r.meta }, null, 2);
      el.replaceChildren(pre);
    }
  });

  // Matrix
  _panel.querySelectorAll('.btn-gen-matrix').forEach(btn => {
    btn.addEventListener('click', async () => {
      const radius   = parseInt(btn.dataset.radius, 10);
      const progressEl = document.getElementById('matrix-progress');
      const stations = getState().mergedData;

      if (stations.length === 0) {
        if (progressEl) progressEl.innerHTML = '⚠️ No stations loaded. Load data first.';
        return;
      }

      btn.disabled = true;
      if (progressEl) progressEl.innerHTML = `Generating ${radius}km matrix…`;

      const { generateMatrix: gen } = await import('../precompute/distance-generator.js');
      const result = await gen(stations, radius, (processed, total, pairs) => {
        if (progressEl) {
          const pct = Math.round((processed / total) * 100);
          progressEl.innerHTML = `Processing station ${processed}/${total} (${pct}%) — ${pairs} pairs found`;
        }
      });

      if (progressEl) {
        progressEl.innerHTML = `✅ Done: ${result.pairCount} pairs in ${formatDuration(result.durationMs)}. CSV downloaded.`;
      }
      btn.disabled = false;
      // Try reload
      await loadMatrix(radius);
      renderPanel();
    });
  });

  // Test getNearby
  document.getElementById('btn-test-nearby')?.addEventListener('click', async () => {
    const id     = document.getElementById('nearby-test-id')?.value || 'MX001';
    const radius = parseInt(document.getElementById('nearby-test-radius')?.value || '10', 10);
    const el     = document.getElementById('nearby-results');

    const { getNearbyById } = await import('../data/geo.js');
    const results = getNearbyById(id, getState().mergedData, radius);

    if (el) {
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(results.slice(0, 10), null, 2);
      el.replaceChildren(pre);
    }
  });

  // Mock toggle
  document.getElementById('btn-real-mode')?.addEventListener('click', () => {
    setState({ mockMode: false });
    renderPanel();
  });
  document.getElementById('btn-mock-mode')?.addEventListener('click', () => {
    setState({ mockMode: true });
    renderPanel();
  });

  document.getElementById('btn-reload-data')?.addEventListener('click', async () => {
    const { fetchAll, invalidateCache } = await import('../api/cre-client.js');
    invalidateCache();
    const r = await fetchAll(getState().mockMode);
    if (r.success) {
      setState({ mergedData: r.data, filteredData: r.data, lastFetch: r.meta.fetchedAt });
    }
  });

  // Storage
  document.getElementById('btn-clear-all-storage')?.addEventListener('click', async () => {
    if (!confirm('Clear ALL Gasolina Inteligente storage? This deletes all snapshots.')) return;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('gi_')) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
    renderPanel();
  });

  document.getElementById('btn-export-all-storage')?.addEventListener('click', async () => {
    await storage.exportAllSnapshots();
  });

  // Logs
  document.getElementById('btn-clear-logs')?.addEventListener('click', () => {
    clearHistory();
    renderTab('logs');
  });

  document.getElementById('btn-export-logs')?.addEventListener('click', () => {
    const entries = getHistory();
    const text    = entries.map(e => `[${e.ts}] [${e.level.toUpperCase()}] [${e.module}] ${e.message}`).join('\n');
    const blob    = new Blob([text], { type: 'text/plain' });
    const url     = URL.createObjectURL(blob);
    const a       = document.createElement('a');
    a.href = url; a.download = 'gi-logs.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

function startStateWatcher() {
  _stateTimer = setInterval(() => {
    const pre = document.getElementById('dev-state-pre');
    if (pre && _activeTab === 'state') {
      const state = getState();
      const display = {
        ...state,
        stations:    `[${state.stations?.length ?? 0} items]`,
        mergedData:  `[${state.mergedData?.length ?? 0} items]`,
        filteredData:`[${state.filteredData?.length ?? 0} items]`,
        prices:      `[${state.prices?.length ?? 0} items]`,
      };
      pre.textContent = JSON.stringify(display, null, 2);
    }
  }, 2000);
}

function stopStateWatcher() {
  if (_stateTimer) { clearInterval(_stateTimer); _stateTimer = null; }
}
