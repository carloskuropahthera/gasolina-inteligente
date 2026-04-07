'use client';
// IndexedDB stale-while-revalidate cache for station data.
// Serves cached data instantly on load, then refreshes in background.
// CRE data refreshes every 4h — TTL matches this cadence.

import { useEffect, useState, useCallback } from 'react';
import type { Station, StationPrices, FuelType } from './types';

const DB_NAME   = 'gasolina-inteligente';
const DB_VER    = 2;  // bumped: adds 'price-history' store
const STORE     = 'stations-cache';
const HIST_STORE = 'price-history';  // key = YYYY-MM-DD, value = Record<stationId, StationPrices>
const CACHE_KEY = 'latest';
const SNAP_KEY  = 'price-snapshot';
const TTL_MS    = 4 * 60 * 60 * 1000; // 4 hours
const MAX_HIST  = 7; // rolling 7-day window

interface CacheEntry {
  stations: Station[];
  exportedAt: string | null;
  savedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      // Migrate v1 → v2: create price-history store if it doesn't exist
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
      if (!db.objectStoreNames.contains(HIST_STORE)) {
        db.createObjectStore(HIST_STORE);
      }
      void e; // suppress unused warning
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function readCache(): Promise<CacheEntry | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(CACHE_KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => reject(req.error);
    });
  } catch { return null; }
}

async function readSnapshot(): Promise<Record<string, StationPrices> | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(SNAP_KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => reject(req.error);
    });
  } catch { return null; }
}

async function writeCache(entry: CacheEntry, prevStations: Station[]): Promise<void> {
  try {
    const db = await openDB();
    // Save previous prices as snapshot before overwriting
    if (prevStations.length > 0) {
      const snapshot: Record<string, StationPrices> = {};
      for (const s of prevStations) {
        if (s.prices) snapshot[s.id] = s.prices;
      }
      await new Promise<void>((resolve, reject) => {
        const tx  = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).put(snapshot, SNAP_KEY);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
      });
    }
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).put(entry, CACHE_KEY);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  } catch { /* silently skip cache write failures */ }
}

async function writePriceHistory(stations: Station[]): Promise<void> {
  try {
    const db    = await openDB();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Build today's snapshot
    const todayPrices: Record<string, StationPrices> = {};
    for (const s of stations) {
      if (s.prices) todayPrices[s.id] = s.prices;
    }

    // Read existing dates to enforce MAX_HIST rolling window
    const allKeys: string[] = await new Promise((resolve, reject) => {
      const tx  = db.transaction(HIST_STORE, 'readonly');
      const req = tx.objectStore(HIST_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result as string[]);
      req.onerror   = () => reject(req.error);
    });

    const toDelete = allKeys
      .filter(k => k !== today)
      .sort()
      .slice(0, Math.max(0, allKeys.length - MAX_HIST + 1));

    const tx = db.transaction(HIST_STORE, 'readwrite');
    const store = tx.objectStore(HIST_STORE);
    for (const key of toDelete) store.delete(key);
    store.put(todayPrices, today);
  } catch { /* ignore */ }
}

export async function getPriceHistory(
  stationId: string,
  fuelType: FuelType,
): Promise<{ date: string; price: number }[]> {
  try {
    const db = await openDB();
    const allKeys: string[] = await new Promise((resolve, reject) => {
      const tx  = db.transaction(HIST_STORE, 'readonly');
      const req = tx.objectStore(HIST_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result as string[]);
      req.onerror   = () => reject(req.error);
    });

    const entries: { date: string; price: number }[] = [];
    for (const date of allKeys.sort()) {
      const snapshot: Record<string, StationPrices> = await new Promise((resolve, reject) => {
        const tx  = db.transaction(HIST_STORE, 'readonly');
        const req = tx.objectStore(HIST_STORE).get(date);
        req.onsuccess = () => resolve(req.result ?? {});
        req.onerror   = () => reject(req.error);
      });
      const price = snapshot[stationId]?.[fuelType];
      if (price != null) entries.push({ date, price });
    }
    return entries;
  } catch { return []; }
}

async function fetchFresh(): Promise<{ stations: Station[]; exportedAt: string | null }> {
  const res  = await fetch('/api/stations');
  const data = await res.json();
  return { stations: data.stations ?? [], exportedAt: data.meta?.exportedAt ?? null };
}

export type LoadingPhase = 'cache' | 'network' | null;

export interface StationsCacheResult {
  stations: Station[];
  exportedAt: string | null;
  isLoading: boolean;
  cacheAgeMs: number | null;
  loadingPhase: LoadingPhase;
  prevPrices: Record<string, StationPrices> | null;
  refresh: () => Promise<void>;
}

export function useStationsCache(): StationsCacheResult {
  const [stations,     setStations]     = useState<Station[]>([]);
  const [exportedAt,   setExportedAt]   = useState<string | null>(null);
  const [isLoading,    setIsLoading]    = useState(true);
  const [cacheAgeMs,   setCacheAgeMs]   = useState<number | null>(null);
  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase>('cache');
  const [prevPrices,   setPrevPrices]   = useState<Record<string, StationPrices> | null>(null);

  const applyData = (s: Station[], ea: string | null, ageMs: number | null) => {
    setStations(s);
    setExportedAt(ea);
    setCacheAgeMs(ageMs);
  };

  const refresh = useCallback(async () => {
    setLoadingPhase('network');
    try {
      const prevSnapshot = await readSnapshot();
      if (prevSnapshot) setPrevPrices(prevSnapshot);
      const fresh = await fetchFresh();
      await writeCache({ ...fresh, savedAt: Date.now() }, stations);
      await writePriceHistory(fresh.stations);
      applyData(fresh.stations, fresh.exportedAt, null);
    } catch { /* network error — keep stale data */ }
    finally { setLoadingPhase(null); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingPhase('cache');
      const cached = await readCache();
      if (cached && !cancelled) {
        const ageMs = Date.now() - cached.savedAt;
        applyData(cached.stations, cached.exportedAt, ageMs);
        setIsLoading(false);
        setLoadingPhase(null);

        const snap = await readSnapshot();
        if (snap && !cancelled) setPrevPrices(snap);

        const shouldRefresh = ageMs > TTL_MS;
        if (shouldRefresh) {
          refresh();
        } else {
          setTimeout(() => { if (!cancelled) refresh(); }, 2000);
        }
        return;
      }

      setLoadingPhase('network');
      try {
        const fresh = await fetchFresh();
        if (!cancelled) {
          await writeCache({ ...fresh, savedAt: Date.now() }, []);
          await writePriceHistory(fresh.stations);
          applyData(fresh.stations, fresh.exportedAt, null);
        }
      } catch { /* keep empty */ } finally {
        if (!cancelled) { setIsLoading(false); setLoadingPhase(null); }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [refresh]);

  return { stations, exportedAt, isLoading, cacheAgeMs, loadingPhase, prevPrices, refresh };
}
