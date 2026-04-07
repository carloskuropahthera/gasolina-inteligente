'use client';
import { useState } from 'react';
import type { Station, FuelType } from '@/lib/types';
import { formatMXN, formatDistance, haversine, FUEL_LABELS } from '@/lib/utils';

interface Props {
  stations: Station[];
  fuelType: FuelType;
  onSelectStation: (s: Station) => void;
  onRouteComputed?: (coords: [number, number][]) => void;
}

interface RouteStation extends Station {
  snapDistKm: number;
}

interface RouteResult {
  stations: RouteStation[];
  allStations: RouteStation[];   // untruncated list
  totalDistKm: number;
  estimatedSavingsMXN: number;
}

const OSRM      = 'https://router.project-osrm.org/route/v1/driving';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const SAMPLE_STEP = 8;

const SNAP_OPTIONS = [2, 5, 10, 20] as const;
const TOP_N = 5;

async function geocode(query: string): Promise<{ lat: number; lng: number } | null> {
  const params = new URLSearchParams({ q: query, format: 'json', limit: '1', countrycodes: 'mx' });
  const res = await fetch(`${NOMINATIM}?${params}`, { headers: { 'Accept-Language': 'es' } });
  if (!res.ok) return null;
  const data = await res.json() as Array<{ lat: string; lon: string }>;
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

async function getRoute(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const res = await fetch(`${OSRM}/${coords}?overview=full&geometries=geojson`);
  if (!res.ok) throw new Error('OSRM error');
  const data = await res.json() as {
    routes: Array<{ distance: number; geometry: { coordinates: Array<[number, number]> } }>;
  };
  if (!data.routes?.length) throw new Error('No route found');
  return data.routes[0];
}

function stationsAlongRoute(
  coords: Array<[number, number]>,
  stations: Station[],
  fuelType: FuelType,
  snapKm: number,
): RouteStation[] {
  const sampled = coords.filter((_, i) => i % SAMPLE_STEP === 0);
  const seen = new Set<string>();
  const result: RouteStation[] = [];

  for (const s of stations) {
    if (!s.lat || !s.lng || s.prices?.[fuelType] == null) continue;
    let minDist = Infinity;
    for (const [lng, lat] of sampled) {
      const d = haversine(lat, lng, s.lat, s.lng);
      if (d < minDist) minDist = d;
    }
    if (minDist <= snapKm && !seen.has(s.id)) {
      seen.add(s.id);
      result.push({ ...s, snapDistKm: minDist });
    }
  }

  return result.sort((a, b) => (a.prices![fuelType]! - b.prices![fuelType]!));
}

export default function RouteOptimizer({ stations, fuelType, onSelectStation, onRouteComputed }: Props) {
  const [origin,      setOrigin]      = useState('');
  const [destination, setDest]        = useState('');
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [result,      setResult]      = useState<RouteResult | null>(null);
  const [snapKm,      setSnapKm]      = useState<number>(5);
  const [showSnapOpts,setShowSnap]    = useState(false);
  const [showAll,     setShowAll]     = useState(false);

  const handleSearch = async () => {
    if (!origin.trim() || !destination.trim()) {
      setError('Ingresa origen y destino');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setShowAll(false);

    try {
      const [fromCoord, toCoord] = await Promise.all([
        geocode(origin),
        geocode(destination),
      ]);

      if (!fromCoord) throw new Error(`No se encontró "${origin}"`);
      if (!toCoord)   throw new Error(`No se encontró "${destination}"`);

      const route = await getRoute(fromCoord, toCoord);
      const coords = route.geometry.coordinates as Array<[number, number]>;
      const totalDistKm = route.distance / 1000;

      const allAlong = stationsAlongRoute(coords, stations, fuelType, snapKm);
      onRouteComputed?.(coords);

      const prices = allAlong.map(s => s.prices![fuelType]!);
      const cheapestPrice = prices.length ? Math.min(...prices) : 0;
      const avgPrice = prices.length ? prices.reduce((a, b) => a + b) / prices.length : cheapestPrice;
      const estimatedSavingsMXN = prices.length >= 2 ? (avgPrice - cheapestPrice) * 50 : 0;

      setResult({ stations: allAlong.slice(0, TOP_N), allStations: allAlong, totalDistKm, estimatedSavingsMXN });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  };

  const resetResults = () => {
    setResult(null);
    setOrigin('');
    setDest('');
    setError(null);
    setShowAll(false);
    onRouteComputed?.([]);
  };

  const useCurrentLocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(pos => {
      setOrigin(`${pos.coords.latitude.toFixed(5)},${pos.coords.longitude.toFixed(5)}`);
    });
  };

  const displayedStations = result
    ? (showAll ? result.allStations : result.stations)
    : [];

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Inputs */}
      <div className="rounded-2xl border border-white/8 bg-[#13131f] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-300">Optimizador de ruta</h2>
          {result && (
            <button
              onClick={resetResults}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              ⊗ Limpiar
            </button>
          )}
        </div>
        <p className="text-xs text-zinc-500">
          Encuentra las estaciones más baratas de {FUEL_LABELS[fuelType]} a lo largo de tu camino.
        </p>

        <div className="space-y-2">
          <div className="relative">
            <input
              type="text"
              placeholder="Origen (ej: Ciudad de México, CDMX)"
              value={origin}
              onChange={e => setOrigin(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="w-full pl-3 pr-10 py-2.5 bg-white/5 border border-white/10 rounded-xl
                         text-sm text-zinc-200 placeholder:text-zinc-600
                         focus:outline-none focus:border-emerald-500/40"
            />
            <button
              onClick={useCurrentLocation}
              title="Usar mi ubicación"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-emerald-400 transition-colors"
            >
              📍
            </button>
          </div>
          <input
            type="text"
            placeholder="Destino (ej: Guadalajara, Jalisco)"
            value={destination}
            onChange={e => setDest(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-xl
                       text-sm text-zinc-200 placeholder:text-zinc-600
                       focus:outline-none focus:border-emerald-500/40"
          />
        </div>

        {/* Snap radius control */}
        <div>
          <button
            onClick={() => setShowSnap(v => !v)}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            ⚙ Radio de búsqueda: {snapKm} km {showSnapOpts ? '▲' : '▼'}
          </button>
          {showSnapOpts && (
            <div className="flex gap-2 mt-2 flex-wrap">
              {SNAP_OPTIONS.map(km => (
                <button
                  key={km}
                  onClick={() => { setSnapKm(km); setShowSnap(false); }}
                  className={`px-3 py-1 rounded-full text-xs border transition-all
                    ${snapKm === km
                      ? 'bg-emerald-500 text-black border-emerald-500'
                      : 'border-white/10 text-zinc-400 hover:border-white/20'}`}
                >
                  {km} km
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={handleSearch}
          disabled={loading}
          className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50
                     text-black font-bold text-sm transition-colors"
        >
          {loading ? 'Calculando ruta…' : 'Buscar gasolineras en ruta'}
        </button>

        {error && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            ⚠️ {error}
          </p>
        )}
      </div>

      {/* Results */}
      {result && (
        <div className="space-y-3">
          {/* Summary */}
          <div className="rounded-2xl border border-white/8 bg-[#13131f] p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-zinc-500">Distancia total</p>
                <p className="text-lg font-bold text-zinc-100">{formatDistance(result.totalDistKm)}</p>
              </div>
              {result.estimatedSavingsMXN > 0 && (
                <div className="text-right">
                  <p className="text-xs text-zinc-500">Ahorro potencial (50L)</p>
                  <p className="text-lg font-bold text-emerald-400">
                    {formatMXN(result.estimatedSavingsMXN)}
                  </p>
                </div>
              )}
            </div>
          </div>

          {result.allStations.length === 0 ? (
            <div className="rounded-2xl border border-white/8 bg-[#13131f] p-8 text-center">
              <span className="text-3xl">🔍</span>
              <p className="text-sm text-zinc-500 mt-2">
                No se encontraron estaciones con precio de {FUEL_LABELS[fuelType]} en esta ruta.
              </p>
            </div>
          ) : (
            <>
              <p className="text-xs text-zinc-500 px-1">
                {displayedStations.length} de {result.allStations.length} estacion{result.allStations.length !== 1 ? 'es' : ''} más barata{result.allStations.length !== 1 ? 's' : ''} en ruta
              </p>
              {displayedStations.map((s, i) => {
                const price = s.prices?.[fuelType];
                return (
                  <button
                    key={s.id}
                    onClick={() => onSelectStation(s)}
                    className="w-full rounded-2xl border border-white/8 bg-[#13131f] p-4 text-left
                               hover:border-emerald-500/30 hover:bg-emerald-500/3 transition-all"
                  >
                    <div className="flex items-start gap-3">
                      <span className="w-6 h-6 rounded-full bg-emerald-500/15 text-emerald-400 text-xs
                                       font-bold flex items-center justify-center shrink-0">
                        {i + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-zinc-100 truncate">{s.name}</p>
                        <p className="text-xs text-zinc-500 mt-0.5">{s.brand} · {s.city}, {s.state}</p>
                        <p className="text-xs text-zinc-600 mt-0.5">
                          {formatDistance(s.snapDistKm)} de la ruta
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-lg font-bold text-emerald-300 tabular-nums">
                          {formatMXN(price)}
                        </p>
                        <p className="text-[10px] text-zinc-500">{FUEL_LABELS[fuelType]}</p>
                      </div>
                    </div>
                  </button>
                );
              })}

              {/* Show more button */}
              {!showAll && result.allStations.length > TOP_N && (
                <button
                  onClick={() => setShowAll(true)}
                  className="w-full py-2 rounded-xl border border-white/8 text-zinc-500 text-sm
                             hover:border-white/15 hover:text-zinc-300 transition-colors"
                >
                  Ver más ({result.allStations.length - TOP_N} estaciones)
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Empty state */}
      {!result && !loading && (
        <div className="rounded-2xl border border-dashed border-white/8 p-8 text-center">
          <span className="text-4xl">🗺️</span>
          <p className="text-sm text-zinc-500 mt-3">
            Ingresa tu ruta para encontrar las mejores gasolineras en el camino
          </p>
          <p className="text-xs text-zinc-600 mt-1">
            Powered by OpenStreetMap · Sin costo
          </p>
        </div>
      )}
    </div>
  );
}
