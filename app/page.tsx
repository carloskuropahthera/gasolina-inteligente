'use client';

import dynamic from 'next/dynamic';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { Station, AppFilters, ViewMode, FuelType } from '@/lib/types';
import { filterStations, addDistances, computeStats, DEFAULT_FILTERS, timeAgo, FUEL_LABELS, formatMXN } from '@/lib/utils';
import { useStationsCache } from '@/lib/useStationsCache';
import { useFavorites } from '@/lib/useFavorites';
import { usePriceAlerts } from '@/lib/usePriceAlerts';
import { useReports } from '@/lib/useReports';
import { useOnlineStatus } from '@/lib/useOnlineStatus';
import { useUserStats } from '@/lib/useUserStats';
import ErrorBoundary from '@/components/ErrorBoundary';
import TopBar      from '@/components/TopBar';
import PriceStats  from '@/components/PriceStats';
import ViewToggle  from '@/components/ViewToggle';
import Filters     from '@/components/Filters';
import ListView    from '@/components/ListView';
import StationModal from '@/components/StationModal';
import ReportModal from '@/components/ReportModal';
import FilterChips from '@/components/FilterChips';
import CompareModal from '@/components/CompareModal';

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
  const { stations: fetchedStations, exportedAt, isLoading, cacheAgeMs, loadingPhase, prevPrices, refresh } = useStationsCache();
  const { favorites, toggle: toggleFav } = useFavorites();
  const { alerts } = usePriceAlerts();
  const { addReport } = useReports();
  const isOnline = useOnlineStatus();
  const { stats: userStats, addPoints } = useUserStats();

  const [allStations,     setAllStations]     = useState<Station[]>([]);
  const [filters,         setFilters]         = useState<AppFilters>(DEFAULT_FILTERS);
  const [viewMode,        setViewMode]        = useState<ViewMode>('map');
  const [selectedStation, setSelectedStation] = useState<Station | null>(null);
  const [userLocation,    setUserLocation]    = useState<{ lat: number; lng: number } | null>(null);
  const [locationError,   setLocationError]   = useState<string | null>(null);
  const [showFilters,     setShowFilters]     = useState(false);
  const [showReport,      setShowReport]      = useState(false);
  const [searchQuery,     setSearchQuery]     = useState('');
  const [debouncedQuery,  setDebouncedQuery]  = useState('');
  const [isRefreshing,    setIsRefreshing]    = useState(false);
  const [routeCoords,     setRouteCoords]     = useState<[number, number][] | null>(null);
  const [triggeredAlerts, setTriggeredAlerts] = useState<typeof alerts>([]);
  const [recentSearches,  setRecentSearches]  = useState<string[]>([]);
  const [pointsToast,     setPointsToast]     = useState<string | null>(null);
  const [compareIds,      setCompareIds]      = useState<Set<string>>(new Set());
  const [showCompare,     setShowCompare]     = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Sync IndexedDB cache results into allStations
  useEffect(() => {
    if (fetchedStations.length > 0) setAllStations(fetchedStations);
  }, [fetchedStations]);

  // ── Read URL params on mount (#17) ────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const fuel = params.get('fuel');
    const view = params.get('view');
    if (fuel && ['regular', 'premium', 'diesel'].includes(fuel)) {
      setFilters(f => ({ ...f, fuelType: fuel as FuelType }));
    }
    if (view && ['map', 'list', 'route'].includes(view)) {
      setViewMode(view as ViewMode);
    }
    // Deep-link to station via hash
    const hash = window.location.hash;
    const stationMatch = hash.match(/^#station=(.+)$/);
    if (stationMatch) {
      const id = decodeURIComponent(stationMatch[1]);
      // will be handled once allStations loads
      sessionStorage.setItem('gi_open_station', id);
    }
  }, []);

  // ── Auto-open station from deep link once data loads ───────────────────
  useEffect(() => {
    const id = sessionStorage.getItem('gi_open_station');
    if (!id || !allStations.length) return;
    const s = allStations.find(st => st.id === id);
    if (s) { setSelectedStation(s); sessionStorage.removeItem('gi_open_station'); }
  }, [allStations]);

  // ── Push URL state changes (#17) ──────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams();
    if (filters.fuelType !== 'regular') params.set('fuel', filters.fuelType);
    if (viewMode !== 'map') params.set('view', viewMode);
    const qs = params.toString();
    history.replaceState(null, '', qs ? `?${qs}` : '/');
  }, [filters.fuelType, viewMode]);

  // ── Search debounce ────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // ── Load recent searches from localStorage (#5) ────────────────────────
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('gi_recent_searches') ?? '[]') as string[];
      setRecentSearches(saved.slice(0, 5));
    } catch { /* ignore */ }
  }, []);

  // ── Save recent searches when a query yields results (#5) ─────────────
  useEffect(() => {
    if (!debouncedQuery.trim() || displayed.length === 0) return;
    const t = setTimeout(() => {
      setRecentSearches(prev => {
        const next = [debouncedQuery, ...prev.filter(q => q !== debouncedQuery)].slice(0, 5);
        try { localStorage.setItem('gi_recent_searches', JSON.stringify(next)); } catch { /* ignore */ }
        return next;
      });
    }, 1000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  // ── Keyboard shortcut: "/" focuses search ──────────────────────────────
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

  // ── GPS location (#4) ──────────────────────────────────────────────────
  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationError('Geolocalización no disponible');
      return;
    }
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const loc = { lat: coords.latitude, lng: coords.longitude };
        setUserLocation(loc);
        setLocationError(null);
        setAllStations(prev => addDistances(prev, loc.lat, loc.lng));
      },
      (err) => {
        const msgs: Record<number, string> = {
          1: 'Permiso denegado',
          2: 'Posición no disponible',
          3: 'Tiempo de espera agotado',
        };
        setLocationError(msgs[err.code] ?? 'Error de ubicación');
      },
      { timeout: 8000 }
    );
  }, []);

  // ── Manual refresh (#5) ────────────────────────────────────────────────
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refresh();
    setIsRefreshing(false);
  }, [refresh]);

  // ── Filtered & searched stations ───────────────────────────────────────
  const displayed = useMemo(() => {
    let result = filterStations(allStations, filters);
    if (debouncedQuery.trim()) {
      const q = debouncedQuery.trim().toLowerCase();
      result = result.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.city.toLowerCase().includes(q) ||
        s.state.toLowerCase().includes(q) ||
        s.brand.toLowerCase().includes(q) ||
        (s.address?.toLowerCase().includes(q) ?? false) ||
        (s.zipCode?.includes(q) ?? false)
      );
    }
    return result;
  }, [allStations, filters, debouncedQuery]);

  const stats = useMemo(() => computeStats(allStations), [allStations]);

  // ── Nearby cheaper alternatives for StationModal (#9) ────────────────
  const nearbyAlternatives = useMemo(() => {
    if (!selectedStation) return [];
    const ft = filters.fuelType;
    const selectedPrice = selectedStation.prices?.[ft];
    if (selectedPrice == null) return [];
    return allStations
      .filter(s =>
        s.id !== selectedStation.id &&
        s.prices?.[ft] != null &&
        s.prices[ft]! < selectedPrice &&
        !s._isAnomaly &&
        s.lat && s.lng &&
        Math.sqrt(
          (s.lat - selectedStation.lat) ** 2 + (s.lng - selectedStation.lng) ** 2
        ) < 0.028 // ~3km in degrees
      )
      .sort((a, b) => a.prices![ft]! - b.prices![ft]!)
      .slice(0, 3);
  }, [selectedStation, allStations, filters.fuelType]);

  // ── Cheapest near user (≤5km) after GPS grant (#14) ───────────────────
  const nearestCheapest = useMemo(() => {
    if (!userLocation) return null;
    const ft = filters.fuelType;
    const nearby = displayed.filter(s => s.distanceKm != null && s.distanceKm <= 5 && s.prices?.[ft] != null && !s._isAnomaly);
    if (!nearby.length) return null;
    return nearby.sort((a, b) => a.prices![ft]! - b.prices![ft]!)[0];
  }, [displayed, userLocation, filters.fuelType]);

  // ── Live price alert checking (#7) ────────────────────────────────────
  useEffect(() => {
    if (!alerts.length || !allStations.length) return;
    const triggered = alerts.filter(alert => {
      const station = allStations.find(s => s.id === alert.stationId);
      const price = station?.prices?.[alert.fuelType];
      return price != null && price < alert.threshold;
    });
    setTriggeredAlerts(triggered);
  }, [allStations, alerts]);

  // ── Unique brands + states for filter UI ──────────────────────────────
  const brands = useMemo(() => {
    const all = [...new Set(allStations.map(s => s.brand))].filter(Boolean).sort();
    return all.filter(b => b !== 'OTRO');
  }, [allStations]);

  const states = useMemo(() =>
    [...new Set(allStations.map(s => s.state))].filter(Boolean).sort(),
    [allStations]
  );

  const open24hCount = useMemo(() =>
    allStations.filter(s => s.amenities?.open24h).length,
    [allStations]
  );

  // ── Fuel type shortcut from PriceStats ────────────────────────────────
  const setFuelType = (ft: FuelType) =>
    setFilters(f => ({ ...f, fuelType: ft }));

  const filtersActive =
    filters.brands.length + filters.states.length +
    (filters.maxDistanceKm != null ? 1 : 0) +
    (filters.showAnomalies ? 1 : 0) +
    (filters.priceMin != null ? 1 : 0) +
    (filters.priceMax != null ? 1 : 0) +
    (filters.showOnlyWithData ? 1 : 0);

  // ── Loading skeleton (#19) ────────────────────────────────────────────
  if (isLoading) {
    const phaseMsg = loadingPhase === 'cache' ? 'Leyendo caché…' : `Descargando ${allStations.length ? allStations.length.toLocaleString('es-MX') : '14,638'} estaciones…`;
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-[#09090f]">
        <div className="text-5xl animate-bounce">⛽</div>
        <p className="text-zinc-300 font-semibold text-lg">Gasolina Inteligente</p>
        <p className="text-zinc-500 text-sm">{phaseMsg}</p>
        <div className="w-48 h-1.5 bg-zinc-800 rounded-full overflow-hidden mt-2">
          <div className="h-full bg-emerald-500 rounded-full shimmer" />
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
        locationError={locationError}
        exportedAt={exportedAt}
        totalShowing={displayed.length}
        totalAll={allStations.length}
        onToggleFilters={() => setShowFilters(v => !v)}
        filtersActive={filtersActive}
        onRefresh={handleRefresh}
        isRefreshing={isRefreshing}
        recentSearches={recentSearches}
        onSelectRecent={setSearchQuery}
        pointsBadge={userStats.points > 0 ? `⛽ ${userStats.points} pts` : null}
      />

      {/* ── National Stats Bar ──────────────────────────────────────── */}
      <PriceStats
        stats={stats}
        activeFuel={filters.fuelType}
        onSelectFuel={setFuelType}
        exportedAt={exportedAt}
        nearestCheapest={nearestCheapest}
        onSelectStation={setSelectedStation}
      />

      {/* ── Active filter chips (#3) ─────────────────────────────────── */}
      <FilterChips filters={filters} onChange={setFilters} />

      {/* ── View Toggle ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5 bg-[#0d0d1a]">
        <ViewToggle current={viewMode} onChange={setViewMode} />
        <span className="text-xs text-zinc-500">
          {displayed.length.toLocaleString('es-MX')} estaciones
        </span>
      </div>

      {/* ── Offline banner (#11) ─────────────────────────────────────── */}
      {!isOnline && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/20 shrink-0">
          <span className="text-amber-400 text-xs">📴 Sin conexión — mostrando datos en caché</span>
        </div>
      )}

      {/* ── Stale cache banner ───────────────────────────────────────── */}
      {cacheAgeMs != null && cacheAgeMs > 4 * 60 * 60 * 1000 && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-500/10 border-b border-yellow-500/20 shrink-0">
          <span className="text-yellow-400 text-xs">⚠️ Datos guardados hace {timeAgo(new Date(Date.now() - cacheAgeMs).toISOString())} — actualizando…</span>
        </div>
      )}

      {/* ── Triggered price alerts (#7) ──────────────────────────────── */}
      {triggeredAlerts.map(alert => {
        const station = allStations.find(s => s.id === alert.stationId);
        const price = station?.prices?.[alert.fuelType];
        return (
          <div key={`${alert.stationId}-${alert.fuelType}`}
               className="flex items-center justify-between px-3 py-1.5 bg-emerald-500/10 border-b border-emerald-500/20 shrink-0">
            <span className="text-emerald-400 text-xs">
              🔔 {alert.stationName} — {FUEL_LABELS[alert.fuelType]} {price != null ? formatMXN(price) : ''} (alerta: &lt;{formatMXN(alert.threshold)})
            </span>
            <button
              onClick={() => setTriggeredAlerts(prev => prev.filter(a => !(a.stationId === alert.stationId && a.fuelType === alert.fuelType)))}
              className="text-zinc-500 hover:text-zinc-300 text-xs ml-2"
            >✕</button>
          </div>
        );
      })}

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
                open24hCount={open24hCount}
              />
            </div>
          </>
        )}

        {/* Main view */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {viewMode === 'map' && (
            <ErrorBoundary>
              <MapView
                stations={displayed}
                fuelType={filters.fuelType}
                userLocation={userLocation}
                selectedStation={selectedStation}
                onSelectStation={setSelectedStation}
                stats={stats}
                routeCoords={routeCoords}
              />
            </ErrorBoundary>
          )}
          {viewMode === 'list' && (
            <ErrorBoundary>
              <ListView
                stations={displayed}
                fuelType={filters.fuelType}
                userLocation={userLocation}
                onSelectStation={setSelectedStation}
                favorites={favorites}
                onToggleFavorite={toggleFav}
                prevPrices={prevPrices}
                compareIds={compareIds}
                onToggleCompare={id => setCompareIds(prev => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id); else if (next.size < 3) next.add(id);
                  return next;
                })}
                onCompare={() => setShowCompare(true)}
              />
            </ErrorBoundary>
          )}
          {viewMode === 'route' && (
            <ErrorBoundary>
              <RouteOptimizer
                stations={displayed}
                fuelType={filters.fuelType}
                onSelectStation={setSelectedStation}
                onRouteComputed={coords => { setRouteCoords(coords); setViewMode('map'); }}
              />
            </ErrorBoundary>
          )}
        </div>
      </div>

      {/* ── Floating Report Button ───────────────────────────────────── */}
      {!showReport && !selectedStation && (
        <button
          onClick={() => {
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
          prevPrices={prevPrices}
          nearbyAlternatives={nearbyAlternatives}
          onSelectStation={setSelectedStation}
        />
      )}

      {/* ── Compare Modal (#18) ─────────────────────────────────────── */}
      {showCompare && compareIds.size >= 2 && (
        <CompareModal
          stations={allStations.filter(s => compareIds.has(s.id))}
          fuelType={filters.fuelType}
          onClose={() => { setShowCompare(false); setCompareIds(new Set()); }}
          onSelectStation={s => { setSelectedStation(s); setShowCompare(false); setCompareIds(new Set()); }}
        />
      )}

      {/* ── Points toast (#19) ──────────────────────────────────────── */}
      {pointsToast && (
        <div className="fixed bottom-20 right-4 z-50 slide-up px-4 py-2 rounded-xl
                        bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 font-semibold text-sm shadow-lg">
          {pointsToast}
        </div>
      )}

      {/* ── Report Price Modal ───────────────────────────────────────── */}
      {showReport && selectedStation && (
        <ReportModal
          station={selectedStation}
          fuelType={filters.fuelType}
          onClose={() => setShowReport(false)}
          onSubmit={(report) => {
            addReport({
              stationId: report.stationId,
              fuelType: report.fuelType,
              price: report.price,
              lat: report.lat ?? 0,
              lng: report.lng ?? 0,
              photoUrl: report.photo,
              reportedAt: new Date().toISOString(),
            });
            addPoints(10);
            setPointsToast('+10 pts 🎉');
            setTimeout(() => setPointsToast(null), 2500);
            setShowReport(false);
          }}
        />
      )}
    </div>
  );
}
