// MODULE: app
// PURPOSE: Main orchestration — startup sequence, module wiring, toast notifications
// DEPENDS ON: all modules

import { createLogger }                   from './modules/utils/logger.js';
import { setState, getState, subscribe }  from './modules/utils/state.js';
import { setDriver }                      from './modules/storage/storage-interface.js';
import { localDriver }                    from './modules/storage/local-driver.js';
import { fetchAll }                        from './modules/api/cre-client.js';
import { loadStaticData }                 from './modules/api/static-loader.js?v=9';
import { loadMatrix, loadSummary }        from './modules/precompute/matrix-loader.js';
import { initScraper }                    from './modules/scraper/daily-scraper.js';
import { detectAnomalies }               from './modules/analytics/anomaly-detector.js?v=2';
import { addDistances, getUserLocation }  from './modules/data/geo.js?v=2';
import { todayISO, formatDuration }       from './modules/utils/helpers.js';

// UI modules
import { initMap, renderStations, highlightStation, showAnomalies, updateUserPin } from './modules/ui/map.js';
import { initLocationBar } from './modules/ui/location-bar.js';
import { initNearbyPanel } from './modules/ui/nearby-panel.js';
import { initFuelCalculator } from './modules/ui/fuel-calculator.js';
import { initRouteOptimizer } from './modules/ui/route-optimizer.js';
import { initPriceList }    from './modules/ui/price-list.js';
import { initFilters, parseURLHash, applyFilters } from './modules/ui/filters.js';
import { initSearch }       from './modules/ui/search.js';
import { initStationCard }  from './modules/ui/station-card.js';
import { initAnomalyPanel, toggleAnomalyPanel } from './modules/ui/anomaly-panel.js';
import { initScraperPanel, toggleScraperPanel } from './modules/ui/scraper-panel.js';
import { initDevPanel }     from './modules/ui/dev-panel.js';

performance.mark('app-start');

const log = createLogger('app');

// Register service worker for offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => log.info('Service worker registered', { scope: reg.scope }))
      .catch(err => log.warn('Service worker registration failed', { error: String(err) }));
  });
}

// Expose station selector globally (used in map popup onclick)
window._gi_selectStation = (id) => {
  const station = getState().mergedData.find(s => s.id === id);
  if (station) setState({ selectedStation: station });
};

// ─── Startup Sequence ─────────────────────────────────────────────────────

// Guard against double-boot (e.g. if DOMContentLoaded fires more than once in
// some edge-case browser/extension environments, or if this module is evaluated
// multiple times due to a stale service-worker cache serving two different module
// versions at the same time).
let _booted = false;

async function boot() {
  if (_booted) { log.warn('boot() called more than once — ignoring'); return; }
  _booted = true;
  const startTime = Date.now();
  log.info('Gasolina Inteligente booting…');

  // 1. Storage driver
  setDriver(localDriver);
  localDriver.setStorageWarningCallback?.(({ type, message }) => {
    showToast(message, 'warn', 8000);
    if (type === 'purge') log.warn('Storage auto-purge triggered');
  });
  const storageStats = await localDriver.getStorageStats();
  log.info('Storage ready', storageStats);

  // 2. Show loading overlay
  showLoading('Iniciando Gasolina Inteligente…');

  // 3. Initialize all UI shells (DOM must exist)
  initMap('map-container');
  initPriceList('price-list-container');
  initStationCard('station-drawer');
  initAnomalyPanel('anomaly-panel');
  initScraperPanel('scraper-panel');
  initDevPanel('dev-panel');
  initFilters('sidebar');
  initSearch('search-input', 'search-dropdown');
  initLocationBar('location-bar');
  initNearbyPanel('nearby-panel');
  initFuelCalculator('fuel-calculator');
  initRouteOptimizer('route-optimizer');

  // 4. Wire header buttons and mobile helpers
  wireHeaderButtons();
  initScrollToListBtn();

  // 5. Subscribe to state changes for cross-module updates
  wireStateSubscriptions();

  // 6. Check mock mode from localStorage
  const savedMock = localStorage.getItem('gi_meta_mockMode');
  if (savedMock === 'true') {
    setState({ mockMode: true });
    showMockBanner(true);
  }

  // 7. Load distance matrix FIRST — anomaly detection inside loadData needs it for O(1) lookups.
  //    Without it, detectAnomalies falls back to O(n²) haversine which freezes the page.
  showLoading('Cargando matriz de distancias…');
  await tryLoadMatrix();

  // 8. Load data (anomaly detection will now use the pre-loaded matrix)
  showLoading('Cargando estaciones y precios…');
  await loadData();

  // 9. Get user location (non-blocking)
  getUserLocation().then(loc => {
    if (loc) {
      setState({ userLocation: loc, userLocationSource: 'gps', userLocationLabel: 'Tu ubicación GPS' });
      log.info('User location obtained', loc);
      remergeWithDistances(loc);
    }
  });

  // 10. Parse URL hash filters
  parseURLHash();

  // 11. Apply initial filters (triggers filteredData → map re-render)
  applyFilters();

  // 12. Start scraper scheduler
  await initScraper();

  // 13. Check if today's data is fresh — prompt if not scraped today
  checkScrapeStatus();

  // 14. Done
  hideLoading();
  setState({ isLoading: false, loadingMessage: '' });

  const ms = Date.now() - startTime;
  log.info(`Boot complete in ${formatDuration(ms)}`);

  performance.mark('app-ready');
  performance.measure('app-boot', 'app-start', 'app-ready');
  const [measure] = performance.getEntriesByName('app-boot');
  log.info(`App boot time: ${measure.duration.toFixed(0)}ms`);

  showToast(`Gasolina Inteligente listo — ${getState().mergedData.length} estaciones cargadas`, 'success');
}

// ─── Data Loading ─────────────────────────────────────────────────────────

async function loadData() {
  const useMock = getState().mockMode;
  setState({ isLoading: true, loadingMessage: 'Fetching CRE data…' });

  try {
    // Try storage snapshot first (today's data)
    const today    = todayISO();
    const snapshot = await localDriver.getSnapshot(today);

    let merged;

    if (!useMock) {
      // Priority 1: static JSON built by Python pipeline (GitHub Actions daily refresh)
      // Prefer pipeline data only if it's from today; otherwise today's browser snapshot wins
      const staticResult = await loadStaticData();
      const staticDate   = staticResult.meta?.exportedAt?.slice(0, 10) ?? null;
      const staticIsToday = staticDate === today;

      if (staticResult.success && staticResult.data.length > 0) {
        // Use static if it's today's data, OR if no today's snapshot exists
        if (staticIsToday || !snapshot?.stations) {
          merged = staticResult.data;
          setState({ lastFetch: staticResult.meta.exportedAt });
          log.info(`Using static pipeline data: ${merged.length} stations (exported ${staticDate})`);
        } else {
          log.info(`Static data is from ${staticDate} — today's snapshot is newer, preferring snapshot`);
        }
      }
    }

    if (!merged) {
      // Priority 2: today's localStorage snapshot (browser scraper)
      if (snapshot?.stations && !useMock) {
        log.info(`Using stored snapshot for ${today} (${snapshot.stationCount} stations)`);
        merged = snapshot.stations;
        setState({ lastFetch: snapshot.fetchedAt });
      } else {
        // Priority 3: live CRE API (CORS proxy)
        const result = await fetchAll(useMock);
        if (!result.success) throw new Error(result.error);
        merged = result.data;
        setState({ lastFetch: result.meta.fetchedAt });
        log.info(`Fetched from ${result.meta.source}: ${merged.length} stations`);
      }
    }

    // Run anomaly detection
    showLoading('Detectando anomalías…');
    const fuelType = getState().filters.fuelType ?? 'regular';
    const anomalies = detectAnomalies(merged, fuelType, { method: 'both', threshold: 1.5 });

    // Tag merged data with anomaly flag
    const anomalyIds = new Set(anomalies.map(a => a.stationId));
    const tagged = merged.map(s => ({ ...s, _isAnomaly: anomalyIds.has(s.id) }));

    setState({
      mergedData:  tagged,
      filteredData: tagged,
      anomalies,
    });

    // filteredData subscription already triggers renderStations — just show anomalies
    if (anomalies.length > 0) showAnomalies(anomalies);

    log.info(`Data ready: ${tagged.length} stations, ${anomalies.length} anomalies`);

  } catch (err) {
    log.error('loadData failed', err);
    hideLoading();
    setState({ error: err.message, isLoading: false });
    showToast(`Error loading data: ${err.message}`, 'error');
  }
}

async function tryLoadMatrix() {
  try {
    const loaded = await loadMatrix(5);
    if (loaded) {
      const summary = await loadSummary();
      setState({ distanceMatrixLoaded: true, distanceMatrixStats: summary });
      log.info('Distance matrix loaded (O(1) lookups enabled)');
    } else {
      log.info('Distance matrix not found — using real-time haversine');
    }
  } catch (err) {
    log.warn('Matrix load failed (non-critical)', err.message);
  }
}

function remergeWithDistances(loc) {
  const { mergedData } = getState();
  const withDist = addDistances(mergedData, loc.lat, loc.lng);
  setState({ mergedData: withDist });
  applyFilters();
  renderStations(getState().filteredData, getState().filters.fuelType ?? 'regular');
}

// ─── Scrape Status Check ──────────────────────────────────────────────────

async function checkScrapeStatus() {
  // Skip the "not scraped" warning if we already have static pipeline data
  const { mergedData } = getState();
  const hasStaticData = mergedData.length > 0 && mergedData.some(s => s.hasData);
  if (hasStaticData) return;

  const today = todayISO();
  const snap  = await localDriver.getSnapshot(today);
  if (!snap) {
    showToast('Precios de hoy no capturados — abre el panel del scraper para capturar ahora', 'warn');
  }
}

// ─── State Subscriptions ──────────────────────────────────────────────────

function wireStateSubscriptions() {
  subscribe('mockMode', (isMock) => {
    showMockBanner(isMock);
    localStorage.setItem('gi_meta_mockMode', String(isMock));
  });

  subscribe('isLoading', (loading) => {
    const dot = document.getElementById('status-dot');
    if (dot) {
      dot.className = loading ? 'warn' : 'ok';
      dot.title     = loading ? 'Loading…' : 'Ready';
    }
  });

  subscribe('anomalies', (anomalies) => {
    const badge = document.getElementById('anomaly-badge');
    if (badge) {
      badge.textContent = anomalies.length > 0 ? anomalies.length : '';
      badge.style.display = anomalies.length > 0 ? 'inline-flex' : 'none';
    }
  });

  // filteredData is set by filters.js — just re-render the map when it changes
  subscribe('filteredData', (filtered) => {
    const { filters } = getState();
    renderStations(filtered, filters.fuelType ?? 'regular');
  });

  // Update user pin/circle on the map whenever location changes
  subscribe('userLocation', () => {
    const { userLocation, userLocationSource, filters } = getState();
    updateUserPin(userLocation, userLocationSource, filters.maxDistanceKm);
  });

  subscribe('selectedStation', (station) => {
    if (station) highlightStation(station.id);
  });
}

// ─── Mobile Scroll-to-List Button ────────────────────────────────────────

function initScrollToListBtn() {
  const btn       = document.getElementById('btn-scroll-to-list');
  const priceList = document.getElementById('price-list-panel');
  const mainArea  = document.getElementById('main-area');
  if (!btn || !priceList || !mainArea) return;

  // Clicking the button scrolls main-area down to the price list panel
  btn.addEventListener('click', () => {
    priceList.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Hide the button once the price list is in view; show when user is in the map zone
  const observer = new IntersectionObserver(
    ([entry]) => { btn.classList.toggle('hidden-scroll', entry.isIntersecting); },
    { root: mainArea, threshold: 0.15 }
  );
  observer.observe(priceList);
}

// ─── Header Buttons ───────────────────────────────────────────────────────

function wireHeaderButtons() {
  // Sidebar toggle (mobile)
  document.getElementById('btn-toggle-sidebar')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('open');
  });

  // Anomaly panel
  document.getElementById('btn-anomaly')?.addEventListener('click', toggleAnomalyPanel);

  // Scraper panel
  document.getElementById('btn-scraper')?.addEventListener('click', toggleScraperPanel);

  // Location button
  document.getElementById('btn-location')?.addEventListener('click', async () => {
    showLoading('Obteniendo ubicación…');
    const loc = await getUserLocation();
    hideLoading();
    if (loc) {
      setState({ userLocation: loc, userLocationSource: 'gps', userLocationLabel: 'Tu ubicación GPS' });
      remergeWithDistances(loc);
      showToast('Ubicación obtenida', 'success');
    } else {
      showToast('No se pudo obtener la ubicación', 'warn');
    }
  });

  // Dev panel (also Ctrl+Shift+D)
  document.getElementById('btn-dev')?.addEventListener('click', () => {
    import('./modules/ui/dev-panel.js').then(m => m.toggleDevPanel());
  });
}

// ─── Loading Overlay ──────────────────────────────────────────────────────

function showLoading(msg = '') {
  const overlay = document.getElementById('loading-overlay');
  const msgEl   = document.getElementById('loading-msg');
  if (overlay) overlay.classList.remove('hidden');
  if (msgEl)   msgEl.textContent = msg;
  setState({ isLoading: true, loadingMessage: msg });
}

function hideLoading() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.classList.add('hidden');
}

// ─── Toasts ───────────────────────────────────────────────────────────────

export function showToast(message, type = 'info', durationMs = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.remove(); }, durationMs);
}

// ─── Mock Banner ──────────────────────────────────────────────────────────

function showMockBanner(show) {
  const banner = document.getElementById('mock-banner');
  if (banner) banner.classList.toggle('visible', show);
}

// ─── PWA Install Banner ───────────────────────────────────────────────────

let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;

  // Don't re-show if user already dismissed
  if (sessionStorage.getItem('pwa_install_dismissed')) return;

  const banner = document.createElement('div');
  banner.id = 'pwa-install-banner';
  banner.innerHTML = `
    <span>⛽ Instala Gasolina Inteligente para acceso rápido</span>
    <button id="pwa-install-btn">Instalar</button>
    <button id="pwa-install-dismiss" aria-label="Cerrar">✕</button>`;
  document.body.appendChild(banner);

  document.getElementById('pwa-install-btn')?.addEventListener('click', async () => {
    banner.remove();
    if (_deferredInstallPrompt) {
      _deferredInstallPrompt.prompt();
      const { outcome } = await _deferredInstallPrompt.userChoice;
      log.info(`PWA install outcome: ${outcome}`);
      _deferredInstallPrompt = null;
    }
  });

  document.getElementById('pwa-install-dismiss')?.addEventListener('click', () => {
    banner.remove();
    sessionStorage.setItem('pwa_install_dismissed', '1');
  });
});

window.addEventListener('appinstalled', () => {
  log.info('PWA installed');
  _deferredInstallPrompt = null;
});

// ─── Global Error Handler ─────────────────────────────────────────────────

window.addEventListener('unhandledrejection', (event) => {
  log.error('Unhandled promise rejection', event.reason);
  showToast(`Error inesperado: ${event.reason?.message ?? event.reason}`, 'error', 6000);
});

window.addEventListener('error', (event) => {
  log.error('Uncaught error', event.error ?? event.message);
});

// ─── Boot ─────────────────────────────────────────────────────────────────

const BOOT_TIMEOUT_MS = 30_000;

document.addEventListener('DOMContentLoaded', () => {
  // 30s watchdog — if boot hangs (network down, CORS failure, parse error),
  // hide the spinner and show a retry button so the user isn't left frozen.
  const watchdog = setTimeout(() => {
    log.error('Boot timeout — taking longer than 30s');
    hideLoading();
    setState({ isLoading: false });
    showBootError('Tiempo de carga agotado. Verifica tu conexión e intenta de nuevo.');
  }, BOOT_TIMEOUT_MS);

  boot()
    .then(() => clearTimeout(watchdog))
    .catch((err) => {
      clearTimeout(watchdog);
      log.error('Boot failed', err);
      hideLoading();
      setState({ isLoading: false });
      showBootError(`No se pudo iniciar la app: ${err.message}`);
    });
});

function showBootError(message) {
  const overlay = document.getElementById('loading-overlay');
  const msgEl   = document.getElementById('loading-msg');
  const label   = document.getElementById('loading-label');

  if (label)  label.textContent  = '⚠️ Error';
  if (msgEl)  msgEl.textContent  = message;

  // Replace spinner with retry button
  const spinner = overlay?.querySelector('.spinner');
  if (spinner) {
    const btn = document.createElement('button');
    btn.textContent = 'Reintentar';
    btn.className   = 'btn-sm btn-accent';
    btn.style.cssText = 'margin-top:16px;padding:10px 24px;font-size:14px;cursor:pointer';
    btn.addEventListener('click', () => window.location.reload());
    spinner.replaceWith(btn);
  }

  if (overlay) overlay.classList.remove('hidden');
}
