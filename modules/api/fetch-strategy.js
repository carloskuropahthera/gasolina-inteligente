// MODULE: fetch-strategy
// PURPOSE: Browser CORS proxy waterfall — tries proxies in order until one works
// DEPENDS ON: logger

import { createLogger } from '../utils/logger.js';

const log = createLogger('fetch-strategy');
const CACHE_KEY = 'gi_working_proxy';
const TIMEOUT_MS = 8000;

const PROXIES = [
  {
    name: 'direct',
    wrap: (url) => url,
  },
  {
    name: 'corsproxy.io',
    wrap: (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  },
  {
    name: 'allorigins',
    wrap: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  },
  {
    name: 'thingproxy',
    wrap: (url) => `https://thingproxy.freeboard.io/fetch/${url}`,
  },
];

function getProxyOrder() {
  const cached = localStorage.getItem(CACHE_KEY);
  if (!cached) return PROXIES;
  const sorted = [...PROXIES].sort((a, b) =>
    a.name === cached ? -1 : b.name === cached ? 1 : 0
  );
  return sorted;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Fetch a URL using a CORS proxy waterfall.
 * Tries each proxy in order; caches the first working one.
 * @param {string} url - The CRE API URL to fetch
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
export async function fetchWithStrategy(url, options = {}) {
  const proxies = getProxyOrder();
  const errors  = [];

  for (const proxy of proxies) {
    const proxyUrl = proxy.wrap(url);
    const start    = Date.now();
    try {
      log.debug(`Trying proxy: ${proxy.name}`, proxyUrl);
      const res = await withTimeout(fetch(proxyUrl, options), TIMEOUT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const latencyMs = Date.now() - start;
      log.info(`✓ Proxy succeeded: ${proxy.name} (${latencyMs}ms)`);
      localStorage.setItem(CACHE_KEY, proxy.name);
      return res;
    } catch (err) {
      const latencyMs = Date.now() - start;
      log.warn(`✗ Proxy failed: ${proxy.name} (${latencyMs}ms) — ${err.message}`);
      errors.push({ name: proxy.name, error: err.message, latencyMs });
    }
  }

  // Clear cached proxy since it apparently stopped working
  localStorage.removeItem(CACHE_KEY);
  const err = { code: 'CORS_ALL_FAILED', triedProxies: errors };
  log.error('All proxies failed', err);
  throw err;
}

/**
 * Test all 4 proxies for a given URL and return latency results.
 * Used by dev panel.
 * @param {string} url
 * @returns {Promise<Array<{name: string, success: boolean, latencyMs: number, error?: string}>>}
 */
export async function testAllProxies(url) {
  const results = await Promise.allSettled(
    PROXIES.map(async (proxy) => {
      const proxyUrl = proxy.wrap(url);
      const start = Date.now();
      try {
        const res = await withTimeout(fetch(proxyUrl), TIMEOUT_MS);
        const latencyMs = Date.now() - start;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { name: proxy.name, success: true, latencyMs };
      } catch (err) {
        return { name: proxy.name, success: false, latencyMs: Date.now() - start, error: err.message };
      }
    })
  );
  return results.map(r => r.value ?? r.reason);
}

/**
 * Get the currently cached working proxy name, or null
 * @returns {string|null}
 */
export function getWorkingProxy() {
  return localStorage.getItem(CACHE_KEY);
}
