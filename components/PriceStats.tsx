'use client';
import type { NationalStats, FuelType, Station } from '@/lib/types';
import { formatMXN, formatDistance, FUEL_LABELS } from '@/lib/utils';

interface Props {
  stats: NationalStats;
  activeFuel: FuelType;
  onSelectFuel: (ft: FuelType) => void;
  exportedAt: string | null;
  nearestCheapest?: Station | null;
  onSelectStation?: (s: Station) => void;
}

const FUELS: FuelType[] = ['regular', 'premium', 'diesel'];

export default function PriceStats({ stats, activeFuel, onSelectFuel, nearestCheapest, onSelectStation }: Props) {
  const cheapestStation = stats.cheapestByFuel[activeFuel];

  return (
    <div className="flex items-stretch gap-0 border-b border-white/5 bg-[#0d0d1a] shrink-0 overflow-x-auto">
      {FUELS.map(ft => {
        const s = stats[ft];
        const active = ft === activeFuel;
        return (
          <button
            key={ft}
            onClick={() => onSelectFuel(ft)}
            className={`flex flex-col items-center px-4 py-2 transition-all border-b-2 shrink-0
              ${active
                ? 'border-emerald-500 bg-emerald-500/5 text-emerald-300'
                : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-white/3'}`}
          >
            <span className="text-[10px] uppercase tracking-wider font-medium opacity-70">
              {FUEL_LABELS[ft]}
            </span>
            <span className={`text-base font-bold tabular-nums ${active ? 'text-emerald-300' : 'text-zinc-200'}`}>
              {s.count ? formatMXN(s.avg) : '—'}
            </span>
            {s.count > 0 && (
              <span className="text-[9px] text-zinc-700 tabular-nums">
                {formatMXN(s.min)} – {formatMXN(s.max)}
              </span>
            )}
          </button>
        );
      })}

      {/* Cheapest today (respects active fuel tab) */}
      {cheapestStation?.prices?.[activeFuel] != null && (
        <div className="flex flex-col items-start px-4 py-2 ml-auto shrink-0 border-l border-white/5">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Más barata hoy</span>
          <span className="text-sm font-bold text-emerald-400">
            {formatMXN(cheapestStation.prices[activeFuel])}
          </span>
          <span className="text-[10px] text-zinc-500 truncate max-w-32">
            {cheapestStation.name}
          </span>
        </div>
      )}

      {/* Nearest cheapest after GPS grant */}
      {nearestCheapest?.prices?.[activeFuel] != null && (
        <button
          onClick={() => onSelectStation?.(nearestCheapest)}
          className="flex flex-col items-start px-4 py-2 shrink-0 border-l border-white/5
                     hover:bg-emerald-500/5 transition-colors"
        >
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider">📍 Más barata cerca</span>
          <span className="text-sm font-bold text-emerald-400">
            {formatMXN(nearestCheapest.prices[activeFuel])}
          </span>
          <span className="text-[10px] text-zinc-500 truncate max-w-32">
            {nearestCheapest.distanceKm != null ? formatDistance(nearestCheapest.distanceKm) + ' · ' : ''}
            {nearestCheapest.name}
          </span>
        </button>
      )}

      {/* Trust badge */}
      <div className="flex items-center gap-1 px-3 py-2 shrink-0 border-l border-white/5">
        <span className="badge-pill bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          🏛️ CRE
        </span>
      </div>
    </div>
  );
}
