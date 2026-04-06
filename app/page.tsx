'use client';

import dynamic from 'next/dynamic';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { Station, AppFilters, ViewMode, FuelType } from '@/lib/types';
import { filterStations, addDistances, computeStats, DEFAULT_FILTERS } from '@/lib/utils';
import TopBar      from '@/components/TopBar';
import PriceStats  from '@/components/PriceStats';
import ViewToggle  from '@/components/ViewToggle';
import Filters     from '@/components/Filters';
import ListView    from '@/components/ListView';
import StationModal from '@/components/StationModal';
import ReportModal from '@/components/ReportModal';

// Leaflet must be client-only — no SSR
const MapView = dynamic(() => import('@/components/MapView'), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center bg-[#0d0d1a]">
      <div className="text-center space-y-3">
        <div className="text-4xl animate-pulse">🗺️</div>
        <p className="text-zinc-400 text-sm">Cargando mapa…</p>
      </div>
    </div>
  ),
});

const RouteOptimizer = dynamic(() => import('@/components/RouteOptimizer'), { ssr: false });

export default function Home() {
  const [allStations,     setAllStations]     = useState<Station[]>([]);
  const [filters,         setFilters]         = useState<AppFilters>(DEFAULT_FILTERS);
  const [viewMode,        setViewMode]        = useState<ViewMode>('map');
  const [selectedStation, setSelectedStation] = useState<Station | null>(null);
  const [userLocation,    setUserLocation]    = useState<{ lat: number; lng: number } | null>(null);
  const [isLoading,       setIsLoading]       = useState(true);
  const [exportedAt,      setExportedAt]      = useState<string | null>(null);
  const [showFilters,     setShowFilters]     = useState(false);
  const [showReport,      setShowReport]      = useState(false);
  const [searchQuery,     setSearchQuery]     = useState('');
  const [debouncedQuery,  setDebouncedQuery]  = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // ── Search debounce ─────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // ── Keyboard shortcut: "/" focuses search ───────────────────────────────
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape') {
        setShowFilters(false);
        setSelectedStation(null);
      }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, []);

  // ── Fetch stations ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res  = await fetch('/api/stations');
        const data = await res.json();
        if (cancelled) return;
        setAllStations(data.stations ?? []);
        setExportedAt(data.meta?.exportedAt ?? null);
      } catch {
        // keep empty array
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // ── GPS location ────────────────────────────────────────────────────────
  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const loc = { lat: coords.latitude, lng: coords.longitude };
        setUserLocation(loc);
        setAllStations(prev => addDistances(prev, loc.lat, loc.lng));
      },
      () => { /* permission denied — silent */ },
      { timeout: 8000 }
    );
  }, []);

  // ── Filtered & searched stations ────────────────────────────────────────
  const displayed = useMemo(() => {
    let result = filterStations(allStations, filters);
    if (debouncedQuery.trim()) {
      const q = debouncedQuery.trim().toLowerCase();
      result = result.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.city.toLowerCase().includes(q) ||
        s.state.toLowerCase().includes(q) ||
        s.brand.toLowerCase().includes(q)
      );
    }
    return result;
  }, [allStations, filters, debouncedQuery]);

  const stats = useMemo(() => computeStats(allStations), [allStations]);

  // ── Unique brands + states for filter UI (exclude "OTRO" if it's 99%+ of data) ──
  const brands = useMemo(() => {
    const all = [...new Set(allStations.map(s => s.brand))].filter(Boolean).sort();
    // Only show brands if there's more than just "OTRO"
    return all.filter(b => b !== 'OTRO');
  }, [allStations]);

  const states = useMemo(() =>
    [...new Set(allStations.map(s => s.state))].filter(Boolean).sort(),
    [allStations]
  );

  // ── Fuel type shortcut from PriceStats ─────────────────────────────────
  const setFuelType = (ft: FuelType) =>
    setFilters(f => ({ ...f, fuelType: ft }));

  const filtersActive =
    filters.brands.length + filters.states.length +
    (filters.maxDistanceKm != null ? 1 : 0) +
    (filters.showAnomalies ? 1 : 0) +
    (filters.priceMin != null ? 1 : 0) +
    (filters.priceMax != null ? 1 : 0);

  // ── Loading skeleton ────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-[#09090f]">
        <div className="text-5xl animate-bounce">⛽</div>
        <p className="text-zinc-300 font-semibold text-lg">Gasolina Inteligente</p>
        <p className="text-zinc-500 text-sm">Cargando precios CRE…</p>
        <div className="w-48 h-1.5 bg-zinc-800 rounded-full overflow-hidden mt-2">
          <div className="h-full bg-emerald-500 rounded-full animate-pulse w-2/3" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[#09090f] text-zinc-100">

      {/* ── Top Bar ─────────────────────────────────────────────────── */}
      <TopBar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchRef={searchRef}
        userLocation={userLocation}
        onRequestLocation={requestLocation}
        exportedAt={exportedAt}
        totalShowing={displayed.length}
        totalAll={allStations.length}
        onToggleFilters={() => setShowFilters(v => !v)}
        filtersActive={filtersActive}
      />

      {/* ── National Stats Bar ──────────────────────────────────────── */}
      <PriceStats
        stats={stats}
        activeFuel={filters.fuelType}
        onSelectFuel={setFuelType}
        exportedAt={exportedAt}
      />

      {/* ── View Toggle ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5 bg-[#0d0d1a]">
        <ViewToggle current={viewMode} onChange={setViewMode} />
        <span className="text-xs text-zinc-500">
          {displayed.length.toLocaleString('es-MX')} estaciones
        </span>
      </div>

      {/* ── Main Content ────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden relative">

        {/* Filters sidebar — backdrop on mobile */}
        {showFilters && (
          <>
            {/* Mobile backdrop */}
            <div
              className="absolute inset-0 bg-black/50 z-40 md:hidden"
              onClick={() => setShowFilters(false)}
            />
            <div className="absolute inset-y-0 left-0 z-50 md:relative md:inset-auto md:z-auto
                            md:w-64 md:border-r md:border-white/5 md:flex-shrink-0">
              <Filters
                filters={filters}
                onChange={setFilters}
                brands={brands}
                states={states}
                onClose={() => setShowFilters(false)}
              />
            </div>
          </>
        )}

        {/* Main view */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {viewMode === 'map' && (
            <MapView
              stations={displayed}
              fuelType={filters.fuelType}
              userLocation={userLocation}
              selectedStation={selectedStation}
              onSelectStation={setSelectedStation}
              stats={stats}
            />
          )}
          {viewMode === 'list' && (
            <ListView
              stations={displayed}
              fuelType={filters.fuelType}
              userLocation={userLocation}
              onSelectStation={setSelectedStation}
            />
          )}
          {viewMode === 'route' && (
            <RouteOptimizer
              stations={displayed}
              fuelType={filters.fuelType}
              onSelectStation={setSelectedStation}
            />
          )}
        </div>
      </div>

      {/* ── Floating Report Button ───────────────────────────────────── */}
      {!showReport && !selectedStation && (
        <button
          onClick={() => {
            // If no station selected, switch to list so user can pick one
            if (viewMode === 'map') setViewMode('list');
          }}
          title="Selecciona una estación para reportar su precio"
          className="fixed bottom-6 right-4 z-40 flex items-center gap-2
                     bg-emerald-500/20 hover:bg-emerald-500/30 active:scale-95
                     border border-emerald-500/40 text-emerald-400
                     font-semibold text-sm px-4 py-3 rounded-full
                     shadow-lg transition-all"
          aria-label="Reportar precio"
        >
          <span className="text-base">+</span>
          <span className="hidden sm:inline">Reportar precio</span>
        </button>
      )}

      {/* ── Station Detail Modal ─────────────────────────────────────── */}
      {selectedStation && (
        <StationModal
          station={selectedStation}
          fuelType={filters.fuelType}
          stats={stats}
          onClose={() => setSelectedStation(null)}
          onReport={() => setShowReport(true)}
        />
      )}

      {/* ── Report Price Modal ───────────────────────────────────────── */}
      {showReport && selectedStation && (
        <ReportModal
          station={selectedStation}
          fuelType={filters.fuelType}
          onClose={() => setShowReport(false)}
          onSubmit={(report) => {
            // TODO: POST to /api/reports → write to Supabase
            console.log('Price report submitted:', report);
          }}
        />
      )}
    </div>
  );
}
