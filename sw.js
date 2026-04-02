/**
 * Gasolina Inteligente Service Worker
 * Strategy: Cache-first for app shell, network-first for station data
 */
const CACHE_VERSION = 'gi-v1';
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;

// App shell files to cache on install
const APP_SHELL_FILES = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/modules/api/cre-client.js',
  '/modules/api/static-loader.js',
  '/modules/api/fetch-strategy.js',
  '/modules/api/cache.js',
  '/modules/data/geo.js',
  '/modules/data/prices.js',
  '/modules/data/stations.js',
  '/modules/ui/price-list.js',
  '/modules/ui/filters.js',
  '/modules/ui/search.js',
  '/modules/ui/map.js',
  '/modules/ui/station-card.js',
  '/modules/ui/scraper-panel.js',
  '/modules/ui/anomaly-panel.js',
  '/modules/ui/dev-panel.js',
  '/modules/analytics/anomaly-detector.js',
  '/modules/analytics/price-trends.js',
  '/modules/analytics/savings-calculator.js',
  '/modules/scraper/daily-scraper.js',
  '/modules/storage/storage-interface.js',
  '/modules/storage/local-driver.js',
  '/modules/utils/helpers.js',
  '/modules/utils/state.js',
  '/modules/utils/logger.js',
  '/modules/precompute/matrix-loader.js',
];

// Install: pre-cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) => {
      console.log('[SW] Caching app shell');
      // Cache files individually so one failure doesn't block all
      return Promise.allSettled(
        APP_SHELL_FILES.map((url) => cache.add(url).catch(() => {
          console.warn('[SW] Failed to cache:', url);
        }))
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== APP_SHELL_CACHE && key !== DATA_CACHE)
          .map((key) => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for shell, network-first for station data
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and cross-origin (Leaflet CDN, Chart.js CDN, etc.)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Station JSON data: network-first (fresh data is priority), fall back to cache
  if (url.pathname.startsWith('/data/') || url.pathname.endsWith('.json')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(DATA_CACHE).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // App shell: cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const clone = response.clone();
        caches.open(APP_SHELL_CACHE).then((cache) => cache.put(event.request, clone));
        return response;
      });
    })
  );
});
