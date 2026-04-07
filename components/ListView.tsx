'use client';
import { useState, useMemo, useCallback } from 'react';
import type { Station, FuelType, SortField, SortDir, StationPrices } from '@/lib/types';
import { formatMXN, formatDistance, getBrandColor, FUEL_LABELS, priceTrend } from '@/lib/utils';

interface Props {
  stations: Station[];
  fuelType: FuelType;
  userLocation: { lat: number; lng: number } | null;
  onSelectStation: (s: Station) => void;
  favorites?: Set<string>;
  onToggleFavorite?: (id: string) => void;
  prevPrices?: Record<string, StationPrices> | null;
}

const PAGE = 50;

export default function ListView({
  stations, fuelType, onSelectStation,
  favorites = new Set(), onToggleFavorite,
  prevPrices,
}: Props) {
  const [sortField, setSortField] = useState<SortField>('price');
  const [sortDir,   setSortDir]   = useState<SortDir>('asc');
  const [page,      setPage]      = useState(1);
  const [focusedIdx, setFocusedIdx] = useState<number>(-1);

  const sorted = useMemo(() => {
    return [...stations].sort((a, b) => {
      const pa = a.prices?.[fuelType] ?? Infinity;
      const pb = b.prices?.[fuelType] ?? Infinity;
      if (sortField === 'price')    return sortDir === 'asc' ? pa - pb : pb - pa;
      if (sortField === 'distance') {
        const da = a.distanceKm ?? Infinity;
        const db = b.distanceKm ?? Infinity;
        return sortDir === 'asc' ? da - db : db - da;
      }
      if (sortField === 'name')  return sortDir === 'asc'
        ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      if (sortField === 'city')  return sortDir === 'asc'
        ? a.city.localeCompare(b.city) : b.city.localeCompare(a.city);
      return 0;
    });
  }, [stations, sortField, sortDir, fuelType]);

  const favoriteStations = useMemo(
    () => sorted.filter(s => favorites.has(s.id)),
    [sorted, favorites]
  );

  const totalPages = Math.ceil(sorted.length / PAGE);
  const slice = sorted.slice((page - 1) * PAGE, page * PAGE);

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
    setPage(1);
    setFocusedIdx(-1);
  };

  const arrow = (f: SortField) => sortField === f ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const handleBodyKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIdx(i => Math.min(i + 1, slice.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && focusedIdx >= 0 && focusedIdx < slice.length) {
      onSelectStation(slice[focusedIdx]);
    }
  }, [focusedIdx, slice, onSelectStation]);

  const renderRow = (s: Station, rank: number | null, sliceIdx?: number) => {
    const price = s.prices?.[fuelType];
    const isFav = favorites.has(s.id);
    const trend = priceTrend(price, prevPrices?.[s.id]?.[fuelType]);
    const isFocused = sliceIdx != null && sliceIdx === focusedIdx;
    return (
      <tr
        key={s.id}
        onClick={() => { onSelectStation(s); setFocusedIdx(sliceIdx ?? -1); }}
        className={`station-row border-b border-white/3 cursor-pointer transition-colors
          ${!s.hasData ? 'opacity-50' : ''}
          ${isFocused ? 'ring-1 ring-inset ring-emerald-500/50 bg-emerald-500/5' : ''}`}
      >
        <td className="pl-4 py-2.5 text-zinc-600 text-xs tabular-nums">{rank ?? '★'}</td>
        <td className="pl-2 py-2.5">
          <div className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: getBrandColor(s.brand) }}
            />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-zinc-200 truncate max-w-[160px]">
                {s.name}
                {s._isAnomaly && <span className="ml-1 text-xs text-yellow-400">⚠️</span>}
              </div>
              <div className="text-xs text-zinc-500">{s.brand}</div>
            </div>
            {onToggleFavorite && (
              <button
                onClick={e => { e.stopPropagation(); onToggleFavorite(s.id); }}
                className={`text-sm shrink-0 transition-colors ${isFav ? 'text-yellow-400' : 'text-zinc-700 hover:text-zinc-400'}`}
                title={isFav ? 'Quitar favorito' : 'Agregar favorito'}
              >
                {isFav ? '★' : '☆'}
              </button>
            )}
          </div>
        </td>
        <td className="py-2.5 text-zinc-400 text-xs hidden md:table-cell">
          {s.city}<span className="text-zinc-600">{s.state ? `, ${s.state}` : ''}</span>
        </td>
        <td className={`py-2.5 text-right font-bold tabular-nums
          ${price != null ? 'text-emerald-300' : 'text-zinc-600'}`}>
          {formatMXN(price)}
          {trend && (
            <span className={`ml-1 text-[10px] font-normal
              ${trend === '▲' ? 'text-orange-400' : trend === '▼' ? 'text-blue-400' : 'text-zinc-600'}`}>
              {trend}
            </span>
          )}
        </td>
        <td className="py-2.5 text-right text-zinc-400 tabular-nums text-xs hidden sm:table-cell">
          {formatMXN(s.prices?.premium)}
        </td>
        <td className="py-2.5 text-right text-zinc-400 tabular-nums text-xs hidden sm:table-cell">
          {formatMXN(s.prices?.diesel)}
        </td>
        <td className="pr-4 py-2.5 text-right text-zinc-500 text-xs">
          {formatDistance(s.distanceKm)}
        </td>
      </tr>
    );
  };

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Controls */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-[#0d0d1a] shrink-0 text-xs">
        <span className="text-zinc-500">
          {sorted.length.toLocaleString('es-MX')} estaciones
        </span>
        <div className="flex gap-3 text-zinc-400">
          {([['price','Precio'],['distance','Distancia'],['name','Nombre'],['city','Ciudad']] as [SortField, string][]).map(([f, l]) => (
            <button key={f} onClick={() => toggleSort(f)}
              className={`hover:text-zinc-200 transition-colors ${sortField===f ? 'text-emerald-400 font-semibold' : ''}`}>
              {l}{arrow(f)}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-[#0d0d1a] z-10">
            <tr className="text-zinc-500 text-xs border-b border-white/5">
              <th className="text-left pl-4 py-2 font-medium">#</th>
              <th className="text-left pl-2 py-2 font-medium">Estación</th>
              <th className="text-left py-2 font-medium hidden md:table-cell">Ciudad</th>
              <th className="text-right py-2 font-medium">{FUEL_LABELS[fuelType]}</th>
              <th className="text-right py-2 font-medium hidden sm:table-cell">Premium</th>
              <th className="text-right py-2 font-medium hidden sm:table-cell">Diésel</th>
              <th className="text-right pr-4 py-2 font-medium">Dist.</th>
            </tr>
          </thead>
          <tbody
            tabIndex={0}
            onKeyDown={handleBodyKeyDown}
            className="focus:outline-none"
          >
            {/* Favorites section */}
            {favoriteStations.length > 0 && (
              <>
                <tr>
                  <td colSpan={7} className="px-4 pt-3 pb-1 text-[10px] text-yellow-400 font-semibold uppercase tracking-wider">
                    ★ Favoritas
                  </td>
                </tr>
                {favoriteStations.map(s => renderRow(s, null))}
                <tr>
                  <td colSpan={7} className="px-4 pt-3 pb-1 text-[10px] text-zinc-500 font-semibold uppercase tracking-wider border-t border-white/5">
                    Todas las estaciones
                  </td>
                </tr>
              </>
            )}
            {slice.map((s, i) => renderRow(s, (page - 1) * PAGE + i + 1, i))}
          </tbody>
        </table>

        {slice.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-600">
            <span className="text-4xl mb-3">🔍</span>
            <p>Sin estaciones con estos filtros</p>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 py-2 border-t border-white/5 bg-[#0d0d1a] shrink-0">
          <button disabled={page===1} onClick={() => { setPage(p=>p-1); setFocusedIdx(-1); }}
            className="px-3 py-1 text-xs rounded bg-white/5 disabled:opacity-30 hover:bg-white/10 transition-colors">
            ‹ Ant
          </button>
          <span className="text-xs text-zinc-500">{page} / {totalPages}</span>
          <button disabled={page===totalPages} onClick={() => { setPage(p=>p+1); setFocusedIdx(-1); }}
            className="px-3 py-1 text-xs rounded bg-white/5 disabled:opacity-30 hover:bg-white/10 transition-colors">
            Sig ›
          </button>
        </div>
      )}
    </div>
  );
}
