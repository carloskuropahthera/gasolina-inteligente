// MODULE: scraper-panel
// PURPOSE: Scraper status panel — schedule controls, history table, storage management
// DEPENDS ON: daily-scraper, storage-interface, state, helpers, logger

import { runScrape, getStatus, getScrapeHistory } from '../scraper/daily-scraper.js';
import * as storage   from '../storage/storage-interface.js';
import { getState, subscribe }   from '../utils/state.js';
import { formatDuration, todayISO, esc } from '../utils/helpers.js';
import { createLogger }          from '../utils/logger.js';

const log = createLogger('scraper-panel');

let _panel = null;
let _countdownInterval = null;

// ─── Countdown helpers ────────────────────────────────────────────────────

/**
 * Returns the number of ms until the next 6 AM Mexico City time.
 * The scraper window is 6–8 AM; we count down to 6 AM.
 */
function msUntilNextScrapeWindow() {
  const now = new Date();
  // Current time in Mexico City
  const mxNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const target = new Date(mxNow);
  target.setHours(6, 0, 0, 0);
  if (mxNow >= target) {
    // Next window is tomorrow at 6 AM
    target.setDate(target.getDate() + 1);
  }
  return target - mxNow;
}

function formatCountdown(ms) {
  if (ms <= 0) return '0h 0m';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

function startCountdown() {
  stopCountdown();
  function tick() {
    const el = document.getElementById('scraper-countdown');
    if (!el) { stopCountdown(); return; }
    el.textContent = formatCountdown(msUntilNextScrapeWindow());
  }
  tick();
  _countdownInterval = setInterval(tick, 30000); // update every 30 s
}

function stopCountdown() {
  if (_countdownInterval) { clearInterval(_countdownInterval); _countdownInterval = null; }
}

/**
 * Initialize the scraper panel
 * @param {string} panelId
 */
export function initScraperPanel(panelId) {
  _panel = document.getElementById(panelId);
  if (!_panel) { log.error(`Panel #${panelId} not found`); return; }

  subscribe('scrapeHistory', () => {
    if (_panel.classList.contains('open')) renderPanel();
  });

  log.info('Scraper panel initialized');
}

/**
 * Toggle panel open/closed
 */
export async function toggleScraperPanel() {
  if (!_panel) return;
  _panel.classList.toggle('open');
  if (_panel.classList.contains('open')) {
    await renderPanel();
    startCountdown();
  } else {
    stopCountdown();
  }
}

// ─── Render ───────────────────────────────────────────────────────────────

async function renderPanel() {
  if (!_panel) return;

  const [status, history, storageStats] = await Promise.all([
    getStatus(),
    Promise.resolve(getScrapeHistory()),
    storage.getStorageStats(),
  ]);

  const statusDot  = status.todayScraped ? '🟢'
                   : getState().isLoading ? '🟡' : '🔴';
  const statusText = status.todayScraped
    ? `Today scraped at ${status.lastScrapeTime} — ${(status.lastScrapeCount ?? 0).toLocaleString()} stations`
    : getState().isLoading
      ? 'Running...'
      : 'Not scraped today';

  const missedBanner = status.consecutiveDaysMissed > 1
    ? `<div class="missed-banner">⚠️ ${status.consecutiveDaysMissed} consecutive days missed</div>`
    : '';

  const storageBar = renderStorageBar(storageStats);
  const historyTable = renderHistoryTable(history);
  const isRunning = getState().isLoading;

  // Last run log text for copy button (most recent history entry)
  const lastEntry = [...history].reverse()[0];
  const lastLogText = lastEntry
    ? `Date: ${lastEntry.date}\nTime: ${lastEntry.time ?? '—'}\nStatus: ${lastEntry.status}\nStations: ${lastEntry.stationCount ?? '—'}\nDuration: ${lastEntry.durationMs ? formatDuration(lastEntry.durationMs) : '—'}${lastEntry.error ? `\nError: ${lastEntry.error}` : ''}`
    : '';

  _panel.innerHTML = `
    <div class="panel-inner">
      <div class="panel-header">
        <h2>📅 Data Scraper</h2>
        <button class="panel-close" id="scraper-close-btn">✕</button>
      </div>

      <div class="scraper-status">
        <div class="status-dot-row">${statusDot} ${statusText}</div>
        ${missedBanner}
        ${isRunning ? `
          <div class="scrape-progress">
            <div class="progress-bar scrape-progress-animated">
              <div class="progress-fill progress-indeterminate"></div>
            </div>
            <span class="muted scrape-spinner">⏳ ${getState().loadingMessage ?? 'Scraping…'}</span>
          </div>` : `
          <div class="scrape-countdown">
            ⏰ Next auto-scrape in: <strong id="scraper-countdown">—</strong>
            <span class="muted">(6–8 AM Mexico City)</span>
          </div>`}
      </div>

      <div class="scraper-actions">
        <button class="btn-accent" id="btn-scrape-now"
          ${isRunning ? 'disabled' : ''}>
          ▶ Scrape Now
        </button>
        <button class="btn-sm" id="btn-download-today"
          ${!status.todayScraped ? 'disabled' : ''}>
          ⬇ Download Today's JSON
        </button>
        <button class="btn-sm" id="btn-download-all">⬇ Download All (ZIP)</button>
        <label class="btn-sm btn-upload" for="import-snapshot-file">⬆ Import Snapshot</label>
        <input type="file" id="import-snapshot-file" accept=".json" style="display:none">
        <button class="btn-sm" id="btn-copy-last-log" ${!lastEntry ? 'disabled' : ''}
          data-log="${esc(lastLogText)}" title="Copy last run log to clipboard">
          📋 Copy Last Log
        </button>
      </div>

      <div class="storage-section">
        <h3>Storage</h3>
        ${storageBar}
        <button class="btn-sm btn-danger" id="btn-clear-old">Clear snapshots > 30 days</button>
      </div>

      <div class="history-section">
        <h3>Scrape History (last 14 days)</h3>
        ${historyTable}
      </div>
    </div>`;

  attachPanelListeners();
}

function renderStorageBar(stats) {
  const pct   = Math.min(100, stats.usedPercent ?? 0);
  const fill  = pct > 70 ? 'bar-warn' : pct > 50 ? 'bar-mid' : 'bar-ok';
  return `
    <div class="storage-bar-wrap">
      <div class="storage-bar"><div class="storage-fill ${fill}" style="width:${pct}%"></div></div>
      <div class="storage-meta">
        ${pct.toFixed(0)}% used —
        ${stats.snapshotCount} snapshots |
        Oldest: ${stats.oldestSnapshot ?? '—'} |
        Est. ${stats.estimatedDaysLeft} days remaining
      </div>
    </div>`;
}

/**
 * Format an ISO timestamp string to Mexico City local time.
 * Falls back to the raw value if parsing fails.
 */
function formatMXTime(isoOrTime) {
  if (!isoOrTime) return '—';
  try {
    // If it looks like a bare HH:MM or HH:MM:SS string (no date), return as-is
    if (/^\d{1,2}:\d{2}/.test(isoOrTime) && !isoOrTime.includes('T')) return isoOrTime;
    const d = new Date(isoOrTime);
    if (isNaN(d.getTime())) return isoOrTime;
    return d.toLocaleTimeString('es-MX', {
      timeZone: 'America/Mexico_City',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return isoOrTime;
  }
}

function renderHistoryTable(history) {
  const recentHistory = [...history].reverse().slice(0, 14);

  if (recentHistory.length === 0) {
    return '<p class="muted">No scrape history yet</p>';
  }

  const rows = recentHistory.map(r => {
    const icon = r.status === 'success' ? '✅'
               : r.status === 'error'   ? '❌' : '⚠️';
    return `<tr>
      <td>${r.date}</td>
      <td>${formatMXTime(r.time)}</td>
      <td>${r.stationCount ? r.stationCount.toLocaleString() : '—'}</td>
      <td>${r.durationMs ? formatDuration(r.durationMs) : '—'}</td>
      <td>${icon} ${r.status} ${r.error ? `<span class="muted">(${esc(r.error.slice(0,30))}…)</span>` : ''}</td>
    </tr>`;
  }).join('');

  return `
    <table class="history-table">
      <thead><tr><th>Date</th><th>Time (MX)</th><th>Stations</th><th>Duration</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ─── Events ───────────────────────────────────────────────────────────────

function attachPanelListeners() {
  document.getElementById('scraper-close-btn')?.addEventListener('click', () => {
    _panel.classList.remove('open');
    stopCountdown();
  });

  document.getElementById('btn-scrape-now')?.addEventListener('click', async () => {
    stopCountdown();
    await renderPanel(); // update UI to "running"
    await runScrape(true);
    await renderPanel();
    startCountdown();
  });

  document.getElementById('btn-copy-last-log')?.addEventListener('click', async (e) => {
    const logText = e.currentTarget.dataset.log ?? '';
    try {
      await navigator.clipboard.writeText(logText);
      const btn = e.currentTarget;
      const orig = btn.textContent;
      btn.textContent = '✅ Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    } catch {
      log.warn('Clipboard write failed — check browser permissions');
    }
  });

  // Restart countdown after panel re-render (it was cleared by innerHTML reassignment)
  startCountdown();

  document.getElementById('btn-download-today')?.addEventListener('click', async () => {
    try {
      await storage.exportSnapshot(todayISO());
    } catch (e) {
      log.error('Download today failed', e.message);
    }
  });

  document.getElementById('btn-download-all')?.addEventListener('click', async () => {
    try {
      await storage.exportAllSnapshots();
    } catch (e) {
      log.error('Download all failed', e.message);
    }
  });

  document.getElementById('import-snapshot-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const result = await storage.importSnapshotFile(file);
    if (result.success) {
      log.info(`Imported snapshot: ${result.date}`);
      await renderPanel();
    } else {
      log.error(`Import failed: ${result.error}`);
    }
  });

  document.getElementById('btn-clear-old')?.addEventListener('click', async () => {
    if (!confirm('Delete all snapshots older than 30 days?')) return;
    const { deleted } = await storage.clearOldSnapshots(30);
    log.info(`Cleared ${deleted} old snapshots`);
    await renderPanel();
  });
}
