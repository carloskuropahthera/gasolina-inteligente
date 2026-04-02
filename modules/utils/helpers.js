// MODULE: helpers
// PURPOSE: Pure utility functions — formatting, math, dates, CSV, file downloads
// DEPENDS ON: nothing (browser globals: Blob, URL, document for download fns)

// ─── Price Formatting ──────────────────────────────────────────────────────

/**
 * Format a price in Mexican pesos
 * @param {number} n
 * @returns {string} e.g. "$22.50"
 */
export function formatPriceMXN(n) {
  if (n == null || isNaN(n)) return '—';
  return `$${Number(n).toFixed(2)}`;
}

/**
 * Format a price in USD using a conversion rate
 * @param {number} n - Price in MXN
 * @param {number} rate - MXN per USD exchange rate
 * @returns {string} e.g. "USD 1.18"
 */
export function formatPriceUSD(n, rate) {
  if (n == null || isNaN(n) || !rate) return '—';
  return `USD ${(n / rate).toFixed(2)}`;
}

// ─── Date / Time ───────────────────────────────────────────────────────────

const DAYS_ES   = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
const MONTHS_ES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

/**
 * Format ISO date in Spanish long form
 * @param {string} iso
 * @returns {string} "Lunes 11 Mar 2026"
 */
export function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
  return `${DAYS_ES[d.getDay()]} ${d.getDate()} ${MONTHS_ES[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Format ISO date in short form
 * @param {string} iso
 * @returns {string} "11/03"
 */
export function formatDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
}

/**
 * Format ISO datetime to HH:MM
 * @param {string} iso
 * @returns {string} "14:35"
 */
export function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

/**
 * Get today's date as ISO string in Mexico City timezone
 * @returns {string} "2026-03-11"
 */
export function todayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
}

/**
 * Get ISO date string N days ago (Mexico City tz)
 * @param {number} n
 * @returns {string}
 */
export function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
}

// ─── Distance ──────────────────────────────────────────────────────────────

/**
 * Format distance for display
 * @param {number} km
 * @returns {string} "2.3 km" or "850 m"
 */
export function formatDistance(km) {
  if (km == null || isNaN(km)) return '—';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

/**
 * Round km to 2 decimal places
 * @param {number} km
 * @returns {number}
 */
export function roundKm(km) {
  return Math.round(km * 100) / 100;
}

// ─── Duration ──────────────────────────────────────────────────────────────

/**
 * Format milliseconds as human duration
 * @param {number} ms
 * @returns {string} "2.3s" or "142ms"
 */
export function formatDuration(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

// ─── Price Analytics ───────────────────────────────────────────────────────

/**
 * Compute price delta vs average
 * @param {number} price
 * @param {number} avg
 * @returns {{ value: number, pct: number, label: string, dir: 'above'|'below'|'equal' }}
 */
export function priceDelta(price, avg) {
  if (price == null || avg == null || avg === 0) {
    return { value: 0, pct: 0, label: '—', dir: 'equal' };
  }
  const value = price - avg;
  const pct   = (value / avg) * 100;
  const dir   = value > 0.005 ? 'above' : value < -0.005 ? 'below' : 'equal';
  const sign  = value > 0 ? '+' : '';
  const label = `${sign}$${Math.abs(value).toFixed(2)}`;
  return { value: roundKm(value), pct: Math.round(pct * 10) / 10, label, dir };
}

/**
 * Get value at percentile p (0–100) from sorted or unsorted array
 * @param {number[]} arr
 * @param {number} p - 0 to 100
 * @returns {number}
 */
export function percentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ─── String Utils ──────────────────────────────────────────────────────────

/**
 * Create URL-safe slug from text
 * @param {string} text
 * @returns {string} "pemex-gasolinera-polanco"
 */
export function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// ─── Async Utils ───────────────────────────────────────────────────────────

/**
 * Debounce a function
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
export function debounce(fn, ms) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/**
 * Throttle a function
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
export function throttle(fn, ms) {
  let last = 0;
  return function(...args) {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      return fn.apply(this, args);
    }
  };
}

/**
 * Promise-based sleep
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── HTML Escaping ─────────────────────────────────────────────────────────

const _ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escape a string for safe use inside HTML (prevents XSS in innerHTML contexts).
 * @param {*} s
 * @returns {string}
 */
export function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => _ESC_MAP[c]);
}

// ─── CSV / Export ──────────────────────────────────────────────────────────

/**
 * Safely escape a single CSV cell value
 * @param {*} value
 * @returns {string}
 */
export function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Convert array of objects to CSV string
 * @param {Object[]} rows
 * @param {string[]} headers - column names matching object keys
 * @returns {string}
 */
export function arrayToCSV(rows, headers) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => csvEscape(row[h])).join(','));
  }
  return lines.join('\r\n');
}

/**
 * Trigger browser download of a CSV string
 * @param {string} filename
 * @param {string} csv
 */
export function downloadCSV(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  _triggerDownload(filename, blob);
}

/**
 * Trigger browser download of a JSON-serializable object
 * @param {string} filename
 * @param {Object} obj
 */
export function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  _triggerDownload(filename, blob);
}

/**
 * Trigger browser download of a ZIP file using JSZip
 * @param {string} filename
 * @param {Array<{name: string, content: string|Blob}>} files
 * @returns {Promise<void>}
 */
export async function downloadZIP(filename, files) {
  if (typeof JSZip === 'undefined') throw new Error('JSZip not loaded');
  const zip = new JSZip(); // eslint-disable-line no-undef
  for (const f of files) {
    zip.file(f.name, f.content);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  _triggerDownload(filename, blob);
}

function _triggerDownload(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
