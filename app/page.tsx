'use client';

import dynamic from 'next/dynamic';
import { useState, useEffect, useCallback, useMemo } from 'react';
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
  const [allStations,  setAllStations]  = useState<Station[]>([]);
  const [filters,      setFilters]      = useState<AppFilters>(DEFAULT_FILTERS);
  const [viewMode,     setViewMode]     = useState<ViewMode>('map');
  const [selectedStation, setSelectedStation] = useState<Station | null>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [isLoading,    setIsLoading]    = useState(true);
  const [exportedAt,   setExportedAt]   = useState<string | null>(null);
  const [showFilters,  setShowFilters]  = useState(false);
  const [showReport,   setShowReport]   = useState(false);
  const [searchQuery,  setSearchQuery]  = useState('');
  const [hasShownHero, setHasShownHero] = useState(false);

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
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.city.toLowerCase().includes(q) ||
        s.state.toLowerCase().includes(q) ||
        s.brand.toLowerCase().includes(q)
      );
    }
    return result;
  }, [allStations, filters, searchQuery]);

  const stats = useMemo(() => computeStats(allStations), [allStations]);

  // ── Unique brands + states for filter UI ───────────────────────────────
  const brands = useMemo(() =>
    [...new Set(allStations.map(s => s.brand))].filter(Boolean).sort(),
    [allStations]
  );
  const states = useMemo(() =>
    [...new Set(allStations.map(s => s.state))].filter(Boolean).sort(),
    [allStations]
  );

  // ── Fuel type shortcut from PriceStats ─────────────────────────────────
  const setFuelType = (ft: FuelType) =>
    setFilters(f => ({ ...f, fuelType: ft }));

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
        userLocation={userLocation}
        onRequestLocation={requestLocation}
        exportedAt={exportedAt}
        totalShowing={displayed.length}
        totalAll={allStations.length}
        onToggleFilters={() => setShowFilters(v => !v)}
        filtersActive={
          filters.brands.length + filters.states.length +
          (filters.maxDistanceKm != null ? 1 : 0) +
          (filters.showAnomalies ? 1 : 0) +
          (filters.open24h ? 1 : 0)
        }
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

        {/* Filters sidebar (slide-in on mobile, fixed on desktop) */}
        {showFilters && (
          <div className="absolute inset-0 z-50 md:relative md:inset-auto md:z-auto
                          md:w-64 md:border-r md:border-white/5 md:flex-shrink-0">
            <Filters
              filters={filters}
              onChange={setFilters}
              brands={brands}
              states={states}
              onClose={() => setShowFilters(false)}
            />
          </div>
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

      {/* ── Floating Report Button (only visible when station selected) ── */}
      {selectedStation && !showReport && (
        <button
          onClick={() => setShowReport(true)}
          className="fixed bottom-6 right-4 z-40 flex items-center gap-2
                     bg-emerald-500 hover:bg-emerald-400 active:scale-95
                     text-black font-bold text-sm px-4 py-3 rounded-full
                     shadow-[0_4px_24px_rgba(0,230,118,0.4)] transition-all"
          aria-label="Reportar precio"
        >
          <span className="text-lg">+</span>
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
          onReport={() => { setShowReport(true); }}
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
            setShowReport(false);
          }}
        />
      )}
    </div>
  );
}
