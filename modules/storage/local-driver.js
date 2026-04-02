// MODULE: local-driver
// PURPOSE: localStorage + file download implementation of the storage interface
// DEPENDS ON: storage-interface, helpers, logger

import { createLogger }                        from '../utils/logger.js';
import { downloadJSON, downloadZIP, todayISO } from '../utils/helpers.js';

const log = createLogger('local-driver');

const PREFIX         = 'gi_';
const SNAPSHOT_PFX   = `${PREFIX}snapshot_`;
const STATIONS_KEY   = `${PREFIX}stations`;
const META_PFX       = `${PREFIX}meta_`;
const MAX_DAYS        = 90;
const WARN_PERCENT    = 70;
const PURGE_PERCENT   = 80;

// ─── Helpers ──────────────────────────────────────────────────────────────

function snapshotKey(date) { return `${SNAPSHOT_PFX}${date}`; }

function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    log.error(`localStorage.setItem failed for ${key}`, e.message);
    return false;
  }
}

function lsGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function lsRemove(key) {
  localStorage.removeItem(key);
}

function getAllSnapshotKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(SNAPSHOT_PFX)) keys.push(k);
  }
  return keys.sort().reverse(); // newest first
}

function estimateSizeKB() {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PREFIX)) {
      total += (localStorage.getItem(key) || '').length * 2;
    }
  }
  return total / 1024;
}

// localStorage quota varies but ~5MB is safe assumption
const QUOTA_KB = 5 * 1024;

// Callback so the UI layer can show a toast when storage is getting full or auto-purged
let _onStorageWarning = null;
export function setStorageWarningCallback(fn) { _onStorageWarning = fn; }

async function checkAndAutoManage() {
  const used = estimateSizeKB();
  const pct  = (used / QUOTA_KB) * 100;

  if (pct >= PURGE_PERCENT) {
    const keys    = getAllSnapshotKeys();
    const count   = keys.filter(k => {
      const date = k.replace(SNAPSHOT_PFX, '');
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - MAX_DAYS);
      return date < cutoff.toISOString().slice(0, 10);
    }).length;
    log.warn(`localStorage at ${pct.toFixed(0)}% — auto-purging ${count} snapshots > ${MAX_DAYS} days`);
    if (_onStorageWarning) {
      _onStorageWarning({
        type: 'purge',
        usedPercent: Math.round(pct),
        deletingCount: count,
        keepDays: MAX_DAYS,
        message: `Almacenamiento al ${Math.round(pct)}% — eliminando ${count} snapshots de más de ${MAX_DAYS} días para liberar espacio.`,
      });
    }
    await clearOldSnapshots(MAX_DAYS);
  } else if (pct >= WARN_PERCENT) {
    log.warn(`localStorage at ${pct.toFixed(0)}% full — consider exporting old snapshots`);
    if (_onStorageWarning) {
      _onStorageWarning({
        type: 'warn',
        usedPercent: Math.round(pct),
        message: `Almacenamiento al ${Math.round(pct)}% — considera exportar snapshots antiguos.`,
      });
    }
  }
}

// ─── Snapshots ────────────────────────────────────────────────────────────

export async function saveSnapshot(date, data) {
  await checkAndAutoManage();
  const ok = lsSet(snapshotKey(date), data);
  if (ok) {
    log.info(`Snapshot saved: ${date} (${data.stationCount ?? '?'} stations)`);
    return { success: true };
  }
  return { success: false, error: 'localStorage write failed — storage may be full' };
}

export async function getSnapshot(date) {
  return lsGet(snapshotKey(date));
}

export async function getLatestSnapshot() {
  const keys = getAllSnapshotKeys();
  if (keys.length === 0) return null;
  return lsGet(keys[0]); // newest first
}

export async function listSnapshots() {
  return getAllSnapshotKeys().map(k => k.replace(SNAPSHOT_PFX, ''));
}

export async function deleteSnapshot(date) {
  lsRemove(snapshotKey(date));
  return { success: true };
}

// ─── Station Cache ─────────────────────────────────────────────────────────

export async function saveStations(data) {
  const ok = lsSet(STATIONS_KEY, { data, savedAt: new Date().toISOString() });
  return { success: ok };
}

export async function getStations() {
  const record = lsGet(STATIONS_KEY);
  return record?.data ?? null;
}

// ─── Storage Management ────────────────────────────────────────────────────

export async function getStorageStats() {
  const keys        = getAllSnapshotKeys();
  const dates       = keys.map(k => k.replace(SNAPSHOT_PFX, ''));
  const totalSizeKB = Math.round(estimateSizeKB() * 10) / 10;
  const usedPercent = Math.round((totalSizeKB / QUOTA_KB) * 100 * 10) / 10;

  // Estimate days left: avg KB per snapshot × remaining KB
  const avgKBPerDay = keys.length > 0
    ? totalSizeKB / keys.length
    : 500; // rough estimate
  const remainingKB       = Math.max(0, QUOTA_KB - totalSizeKB);
  const estimatedDaysLeft = Math.floor(remainingKB / avgKBPerDay);

  return {
    snapshotCount:    keys.length,
    oldestSnapshot:   dates.at(-1) ?? null,
    newestSnapshot:   dates[0] ?? null,
    totalSizeKB,
    usedPercent,
    estimatedDaysLeft,
  };
}

export async function clearOldSnapshots(keepDays = MAX_DAYS) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const keys = getAllSnapshotKeys();
  let deleted = 0;
  for (const key of keys) {
    const date = key.replace(SNAPSHOT_PFX, '');
    if (date < cutoffStr) {
      lsRemove(key);
      deleted++;
    }
  }
  if (deleted > 0) log.info(`Cleared ${deleted} snapshots older than ${keepDays} days`);
  return { deleted };
}

export async function exportSnapshot(date) {
  const snapshot = await getSnapshot(date);
  if (!snapshot) throw new Error(`No snapshot for ${date}`);
  downloadJSON(`prices_${date}.json`, snapshot);
}

export async function exportAllSnapshots() {
  const dates = await listSnapshots();
  const files = [];
  for (const date of dates) {
    const snap = await getSnapshot(date);
    if (snap) {
      files.push({
        name:    `prices_${date}.json`,
        content: JSON.stringify(snap, null, 2),
      });
    }
  }
  if (files.length === 0) throw new Error('No snapshots to export');
  await downloadZIP(`gasolina_snapshots_${todayISO()}.zip`, files);
}

export async function importSnapshotFile(file) {
  // Basic file extension check
  if (file.name && !file.name.endsWith('.json')) {
    return { success: false, error: `Expected a .json file, got: ${file.name}` };
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target.result);

        // Validate required fields
        if (!data.date || typeof data.date !== 'string') {
          return resolve({ success: false, error: 'Invalid snapshot: missing or invalid date field' });
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
          return resolve({ success: false, error: `Invalid snapshot date format: ${data.date}` });
        }
        if (!Array.isArray(data.stations)) {
          return resolve({ success: false, error: 'Invalid snapshot: stations must be an array' });
        }
        if (data.stations.length === 0) {
          return resolve({ success: false, error: 'Invalid snapshot: stations array is empty' });
        }
        // Spot-check first station has expected shape
        const s0 = data.stations[0];
        if (!s0.id && !s0.master_id) {
          return resolve({ success: false, error: 'Invalid snapshot: station records missing id field' });
        }

        await saveSnapshot(data.date, data);
        resolve({ success: true, date: data.date, count: data.stations.length });
      } catch (err) {
        resolve({ success: false, error: `Parse error: ${err.message}` });
      }
    };
    reader.onerror = () => resolve({ success: false, error: 'File read error' });
    reader.readAsText(file);
  });
}

// ─── Generic Metadata ──────────────────────────────────────────────────────

export async function saveMeta(key, value) {
  lsSet(`${META_PFX}${key}`, value);
}

export async function getMeta(key) {
  return lsGet(`${META_PFX}${key}`);
}

// ─── Driver export ─────────────────────────────────────────────────────────

export const localDriver = {
  setStorageWarningCallback,
  saveSnapshot, getSnapshot, getLatestSnapshot, listSnapshots, deleteSnapshot,
  saveStations, getStations,
  getStorageStats, clearOldSnapshots,
  exportSnapshot, exportAllSnapshots, importSnapshotFile,
  saveMeta, getMeta,
};
