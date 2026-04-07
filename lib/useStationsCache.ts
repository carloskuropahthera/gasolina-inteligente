'use client';
// IndexedDB stale-while-revalidate cache for station data.
// Serves cached data instantly on load, then refreshes in background.
// CRE data refreshes every 4h — TTL matches this cadence.

import { useEffect, useState, useCallback } from 'react';
import type { Station, StationPrices } from './types';

const DB_NAME  = 'gasolina-inteligente';
const DB_VER   = 1;
const STORE    = 'stations-cache';
const CACHE_KEY = 'latest';
const SNAP_KEY  = 'price-snapshot';
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
  cacheAgeMs: number | null; // ms since last cache write, null if fresh fetch
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
      applyData(fresh.stations, fresh.exportedAt, null);
    } catch { /* network error — keep stale data */ }
    finally { setLoadingPhase(null); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // 1. Serve from IndexedDB instantly (stale-while-revalidate)
      setLoadingPhase('cache');
      const cached = await readCache();
      if (cached && !cancelled) {
        const ageMs = Date.now() - cached.savedAt;
        applyData(cached.stations, cached.exportedAt, ageMs);
        setIsLoading(false);
        setLoadingPhase(null);

        // Load prev prices snapshot for trend arrows
        const snap = await readSnapshot();
        if (snap && !cancelled) setPrevPrices(snap);

        // 2. Background refresh if stale (> TTL) or always after 1s
        const shouldRefresh = ageMs > TTL_MS;
        if (shouldRefresh) {
          refresh();
        } else {
          setTimeout(() => { if (!cancelled) refresh(); }, 2000);
        }
        return;
      }

      // 3. No cache — fetch fresh and show loading state
      setLoadingPhase('network');
      try {
        const fresh = await fetchFresh();
        if (!cancelled) {
          await writeCache({ ...fresh, savedAt: Date.now() }, []);
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
