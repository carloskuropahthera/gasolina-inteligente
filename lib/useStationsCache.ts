'use client';
// IndexedDB stale-while-revalidate cache for station data.
// Serves cached data instantly on load, then refreshes in background.
// CRE data refreshes every 4h — TTL matches this cadence.

import { useEffect, useState, useCallback } from 'react';
import type { Station } from './types';

const DB_NAME  = 'gasolina-inteligente';
const DB_VER   = 1;
const STORE    = 'stations-cache';
const CACHE_KEY = 'latest';
const TTL_MS   = 4 * 60 * 60 * 1000; // 4 hours

interface CacheEntry {
  stations: Station[];
  exportedAt: string | null;
  savedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
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

async function writeCache(entry: CacheEntry): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).put(entry, CACHE_KEY);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  } catch { /* silently skip cache write failures */ }
}

async function fetchFresh(): Promise<{ stations: Station[]; exportedAt: string | null }> {
  const res  = await fetch('/api/stations');
  const data = await res.json();
  return { stations: data.stations ?? [], exportedAt: data.meta?.exportedAt ?? null };
}

export interface StationsCacheResult {
  stations: Station[];
  exportedAt: string | null;
  isLoading: boolean;
  cacheAgeMs: number | null; // ms since last cache write, null if fresh fetch
  refresh: () => Promise<void>;
}

export function useStationsCache(): StationsCacheResult {
  const [stations,   setStations]   = useState<Station[]>([]);
  const [exportedAt, setExportedAt] = useState<string | null>(null);
  const [isLoading,  setIsLoading]  = useState(true);
  const [cacheAgeMs, setCacheAgeMs] = useState<number | null>(null);

  const applyData = (s: Station[], ea: string | null, ageMs: number | null) => {
    setStations(s);
    setExportedAt(ea);
    setCacheAgeMs(ageMs);
  };

  const refresh = useCallback(async () => {
    try {
      const fresh = await fetchFresh();
      await writeCache({ ...fresh, savedAt: Date.now() });
      applyData(fresh.stations, fresh.exportedAt, null);
    } catch { /* network error — keep stale data */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // 1. Serve from IndexedDB instantly (stale-while-revalidate)
      const cached = await readCache();
      if (cached && !cancelled) {
        const ageMs = Date.now() - cached.savedAt;
        applyData(cached.stations, cached.exportedAt, ageMs);
        setIsLoading(false);

        // 2. Background refresh if stale (> TTL) or always after 1s
        const shouldRefresh = ageMs > TTL_MS;
        if (shouldRefresh) {
          refresh();
        } else {
          // Still refresh silently in background after a short delay
          setTimeout(() => { if (!cancelled) refresh(); }, 2000);
        }
        return;
      }

      // 3. No cache — fetch fresh and show loading state
      try {
        const fresh = await fetchFresh();
        if (!cancelled) {
          await writeCache({ ...fresh, savedAt: Date.now() });
          applyData(fresh.stations, fresh.exportedAt, null);
        }
      } catch { /* keep empty */ } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [refresh]);

  return { stations, exportedAt, isLoading, cacheAgeMs, refresh };
}
