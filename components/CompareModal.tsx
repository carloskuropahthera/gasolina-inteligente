'use client';
import { useRef } from 'react';
import type { Station, FuelType } from '@/lib/types';
import { formatMXN, formatDistance, getBrandColor, FUEL_LABELS } from '@/lib/utils';
import { useFocusTrap } from '@/lib/useFocusTrap';

interface Props {
  stations: Station[];
  fuelType: FuelType;
  onClose: () => void;
  onSelectStation: (s: Station) => void;
}

const FUEL_TYPES: FuelType[] = ['regular', 'premium', 'diesel'];

export default function CompareModal({ stations, fuelType, onClose, onSelectStation }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true);

  const bestPrices: Partial<Record<FuelType, number>> = {};
  for (const ft of FUEL_TYPES) {
    const prices = stations.map(s => s.prices?.[ft]).filter((v): v is number => v != null);
    if (prices.length) bestPrices[ft] = Math.min(...prices);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Comparar estaciones"
        className="relative w-full max-w-2xl bg-[#13131f] rounded-t-2xl sm:rounded-2xl
                   border border-white/8 shadow-2xl slide-up max-h-[90vh] flex flex-col"
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 sm:hidden">
          <div className="w-10 h-1 bg-white/20 rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-white/8 shrink-0">
          <h2 className="font-bold text-zinc-100">Comparar estaciones</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-xl leading-none">✕</button>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto px-5 py-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-500 text-xs border-b border-white/5">
                <th className="text-left pb-2 font-medium">Atributo</th>
                {stations.map(s => (
                  <th key={s.id} className="text-center pb-2 font-medium px-2">
                    <div className="flex flex-col items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: getBrandColor(s.brand) }} />
                      <span className="truncate max-w-[100px] text-zinc-200">{s.name}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-white/3">
                <td className="py-2 text-zinc-500 text-xs">Marca</td>
                {stations.map(s => (
                  <td key={s.id} className="py-2 text-center text-xs text-zinc-300 px-2">{s.brand}</td>
                ))}
              </tr>
              <tr className="border-b border-white/3">
                <td className="py-2 text-zinc-500 text-xs">Ciudad</td>
                {stations.map(s => (
                  <td key={s.id} className="py-2 text-center text-xs text-zinc-400 px-2">{s.city}</td>
                ))}
              </tr>
              <tr className="border-b border-white/3">
                <td className="py-2 text-zinc-500 text-xs">Distancia</td>
                {stations.map(s => (
                  <td key={s.id} className="py-2 text-center text-xs text-zinc-400 px-2">{formatDistance(s.distanceKm)}</td>
                ))}
              </tr>
              {FUEL_TYPES.map(ft => (
                <tr key={ft} className={`border-b border-white/3 ${ft === fuelType ? 'bg-emerald-500/3' : ''}`}>
                  <td className={`py-2 text-xs ${ft === fuelType ? 'text-emerald-400 font-semibold' : 'text-zinc-500'}`}>
                    {FUEL_LABELS[ft]}
                  </td>
                  {stations.map(s => {
                    const price = s.prices?.[ft];
                    const isBest = price != null && bestPrices[ft] === price;
                    return (
                      <td key={s.id} className="py-2 text-center tabular-nums px-2">
                        {price != null ? (
                          <span className={`font-bold text-sm ${isBest ? 'text-emerald-400' : 'text-zinc-300'}`}>
                            {formatMXN(price)}
                            {isBest && <span className="ml-1 text-[10px] text-emerald-600">★</span>}
                          </span>
                        ) : (
                          <span className="text-zinc-700 text-xs">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr className="border-b border-white/3">
                <td className="py-2 text-zinc-500 text-xs">24h</td>
                {stations.map(s => (
                  <td key={s.id} className="py-2 text-center text-xs px-2">
                    {s.amenities ? (s.amenities.open24h ? '✅' : '❌') : '—'}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="py-2 text-zinc-500 text-xs">Tienda</td>
                {stations.map(s => (
                  <td key={s.id} className="py-2 text-center text-xs px-2">
                    {s.amenities ? (s.amenities.store ? '✅' : '❌') : '—'}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        {/* Actions */}
        <div className="px-5 py-3 border-t border-white/8 shrink-0 flex gap-2 overflow-x-auto">
          {stations.map(s => (
            <button
              key={s.id}
              onClick={() => { onSelectStation(s); onClose(); }}
              className="flex-1 min-w-[100px] py-2 rounded-lg bg-white/5 border border-white/8
                         text-xs text-zinc-300 hover:bg-white/8 transition-colors truncate px-2"
            >
              Ver {s.name.split(' ')[0]}… ↗
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
