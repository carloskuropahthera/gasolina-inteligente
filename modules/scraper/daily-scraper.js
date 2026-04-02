// MODULE: daily-scraper
// PURPOSE: Automated daily CRE price capture with scheduling, history, and auto-download
// DEPENDS ON: cre-client, storage-interface, logger, helpers, state

import { fetchAll }          from '../api/cre-client.js';
import * as storage          from '../storage/storage-interface.js';
import { createLogger }      from '../utils/logger.js';
import { todayISO, downloadJSON } from '../utils/helpers.js';
import { setState, getState } from '../utils/state.js';

const log = createLogger('daily-scraper');

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // check every 30 min
const SCRAPE_HOUR_START = 6;               // 6:00 AM Mexico City
const SCRAPE_HOUR_END   = 8;               // 8:00 AM Mexico City
const MEXICO_TZ         = 'America/Mexico_City';
const MAX_HISTORY       = 30;

let _checkInterval   = null;
let _isRunning       = false;
let _scrapeHistory   = [];

// ─── Time Helpers ─────────────────────────────────────────────────────────

function nowMexicoHour() {
  return parseInt(
    new Date().toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: MEXICO_TZ }),
    10
  );
}

function nextScheduledTime() {
  const now      = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  // Format as "06:00 AM Mexico City"
  const t = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(),
                     SCRAPE_HOUR_START, 0, 0);
  return t.toISOString();
}

// ─── Core Scrape ──────────────────────────────────────────────────────────

/**
 * Run a price scrape. Fetches from CRE, saves snapshot, downloads JSON.
 * @param {boolean} [force=false] - Run even if today already scraped
 * @returns {Promise<{success: boolean, date?: string, stationCount?: number, durationMs?: number, error?: string}>}
 */
export async function runScrape(force = false) {
  if (_isRunning) {
    log.warn('Scrape already in progress');
    return { success: false, error: 'Scrape already running' };
  }

  const today    = todayISO();
  const existing = await storage.getSnapshot(today);

  if (existing && !force) {
    log.info(`Today (${today}) already scraped — skipping. Use force=true to override.`);
    return { success: true, date: today, skipped: true, stationCount: existing.stationCount };
  }

  _isRunning = true;
  setState({ isLoading: true, loadingMessage: 'Fetching live prices from CRE…' });
  const start = Date.now();

  try {
    const useMock   = getState().mockMode;
    const result    = await fetchAll(useMock);

    if (!result.success) throw new Error(result.error ?? 'fetchAll failed');

    const snapshot = {
      date:         today,
      fetchedAt:    new Date().toISOString(),
      stationCount: result.data.length,
      source:       result.meta.source,
      stations:     result.data,
    };

    // Save to storage
    await storage.saveSnapshot(today, snapshot);

    // Auto-download JSON to data/snapshots/
    downloadJSON(`prices_${today}.json`, snapshot);

    const durationMs = Date.now() - start;
    const record = {
      date:         today,
      time:         new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: MEXICO_TZ }),
      stationCount: snapshot.stationCount,
      durationMs,
      status:       'success',
      source:       snapshot.source,
    };

    addHistoryRecord(record);
    updateScraperState();

    log.info(`Scrape complete: ${snapshot.stationCount} stations in ${durationMs}ms`);
    return { success: true, date: today, stationCount: snapshot.stationCount, durationMs };

  } catch (err) {
    const durationMs = Date.now() - start;
    log.error('Scrape failed', err);

    const record = {
      date:         today,
      time:         new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: MEXICO_TZ }),
      stationCount: 0,
      durationMs,
      status:       'error',
      error:        err.message,
      source:       'api',
    };
    addHistoryRecord(record);
    return { success: false, error: err.message, durationMs };
  } finally {
    _isRunning = false;
    setState({ isLoading: false, loadingMessage: '' });
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────

/**
 * Initialize the scraper — starts the 30-minute background check loop
 */
export async function initScraper() {
  // Load existing history from storage
  const saved = await storage.getMeta('scrapeHistory');
  if (Array.isArray(saved)) {
    _scrapeHistory = saved.slice(-MAX_HISTORY);
  }

  // Check immediately on init
  await schedulerTick();

  // Then check every 30 minutes
  if (_checkInterval) clearInterval(_checkInterval);
  _checkInterval = setInterval(schedulerTick, CHECK_INTERVAL_MS);

  log.info('Scraper initialized — checking every 30 minutes');
  updateScraperState();
}

async function schedulerTick() {
  const hour    = nowMexicoHour();
  const inWindow = hour >= SCRAPE_HOUR_START && hour < SCRAPE_HOUR_END;

  if (inWindow) {
    const today    = todayISO();
    const existing = await storage.getSnapshot(today);
    if (!existing) {
      log.info(`Auto-scrape triggered at ${hour}:xx Mexico City`);
      await runScrape();
    }
  }
}

// ─── Status ───────────────────────────────────────────────────────────────

/**
 * Get current scraper status
 * @returns {Promise<Object>}
 */
export async function getStatus() {
  const today     = todayISO();
  const snapshots = await storage.listSnapshots();
  const todaySnap = await storage.getSnapshot(today);

  const lastRecord  = _scrapeHistory.at(-1);
  const missedDays  = countConsecutiveMissed(snapshots);

  return {
    lastScrapeDate:         lastRecord?.date ?? null,
    lastScrapeTime:         lastRecord?.time ?? null,
    lastScrapeCount:        lastRecord?.stationCount ?? null,
    nextScheduledTime:      nextScheduledTime(),
    totalSnapshots:         snapshots.length,
    isRunning:              _isRunning,
    todayScraped:           !!todaySnap,
    consecutiveDaysMissed:  missedDays,
  };
}

/**
 * Get scrape history (last 30 records)
 * @returns {Array}
 */
export function getScrapeHistory() {
  return [..._scrapeHistory];
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function addHistoryRecord(record) {
  _scrapeHistory.push(record);
  if (_scrapeHistory.length > MAX_HISTORY) {
    _scrapeHistory = _scrapeHistory.slice(-MAX_HISTORY);
  }
  storage.saveMeta('scrapeHistory', _scrapeHistory).catch(() => {});
}

function updateScraperState() {
  setState({ scrapeHistory: [..._scrapeHistory] });
}

function countConsecutiveMissed(snapshotDates) {
  let missed = 0;
  let d      = new Date();
  d.setDate(d.getDate() - 1); // start from yesterday

  while (missed < 30) {
    const iso = d.toISOString().slice(0, 10);
    if (snapshotDates.includes(iso)) break;
    missed++;
    d.setDate(d.getDate() - 1);
  }
  return missed;
}

/** Stop the scheduler (cleanup) */
export function stopScraper() {
  if (_checkInterval) {
    clearInterval(_checkInterval);
    _checkInterval = null;
  }
}
