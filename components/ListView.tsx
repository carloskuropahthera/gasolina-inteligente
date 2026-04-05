'use client';
import { useState, useMemo } from 'react';
import type { Station, FuelType, SortField, SortDir } from '@/lib/types';
import { formatMXN, formatDistance, getBrandColor } from '@/lib/utils';

interface Props {
  stations: Station[];
  fuelType: FuelType;
  userLocation: { lat: number; lng: number } | null;
  onSelectStation: (s: Station) => void;
}

const PAGE = 50;

export default function ListView({ stations, fuelType, onSelectStation }: Props) {
  const [sortField, setSortField] = useState<SortField>('price');
  const [sortDir,   setSortDir]   = useState<SortDir>('asc');
  const [page,      setPage]      = useState(1);

  const sorted = useMemo(() => {
    const withPrice = [...stations].sort((a, b) => {
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
    return withPrice;
  }, [stations, sortField, sortDir, fuelType]);

  const totalPages = Math.ceil(sorted.length / PAGE);
  const slice = sorted.slice((page - 1) * PAGE, page * PAGE);

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
    setPage(1);
  };

  const arrow = (f: SortField) => sortField === f ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

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
              <th className="text-right py-2 font-medium">Magna</th>
              <th className="text-right py-2 font-medium hidden sm:table-cell">Premium</th>
              <th className="text-right py-2 font-medium hidden sm:table-cell">Diésel</th>
              <th className="text-right pr-4 py-2 font-medium">Dist.</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((s, i) => {
              const rank = (page - 1) * PAGE + i + 1;
              const price = s.prices?.[fuelType];
              return (
                <tr
                  key={s.id}
                  onClick={() => onSelectStation(s)}
                  className="station-row border-b border-white/3 cursor-pointer transition-colors"
                >
                  <td className="pl-4 py-2.5 text-zinc-600 text-xs tabular-nums">{rank}</td>
                  <td className="pl-2 py-2.5">
                    <div className="flex items-center gap-2">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: getBrandColor(s.brand) }}
                      />
                      <div>
                        <div className="font-medium text-zinc-200 truncate max-w-[180px]">
                          {s.name}
                          {s._isAnomaly && <span className="ml-1 text-xs text-yellow-400">⚠️</span>}
                        </div>
                        <div className="text-xs text-zinc-500">{s.brand}</div>
                      </div>
                    </div>
                  </td>
                  <td className="py-2.5 text-zinc-400 text-xs hidden md:table-cell">
                    {s.city}<span className="text-zinc-600">, {s.state}</span>
                  </td>
                  <td className={`py-2.5 text-right font-bold tabular-nums
                    ${price != null ? 'text-emerald-300' : 'text-zinc-600'}`}>
                    {formatMXN(price)}
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
            })}
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
          <button disabled={page===1} onClick={() => setPage(p=>p-1)}
            className="px-3 py-1 text-xs rounded bg-white/5 disabled:opacity-30 hover:bg-white/10 transition-colors">
            ‹ Ant
          </button>
          <span className="text-xs text-zinc-500">{page} / {totalPages}</span>
          <button disabled={page===totalPages} onClick={() => setPage(p=>p+1)}
            className="px-3 py-1 text-xs rounded bg-white/5 disabled:opacity-30 hover:bg-white/10 transition-colors">
            Sig ›
          </button>
        </div>
      )}
    </div>
  );
}
