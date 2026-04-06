'use client';
import type { Station, FuelType, NationalStats } from '@/lib/types';
import { formatMXN, formatDistance, getBrandColor, timeAgo, FUEL_LABELS } from '@/lib/utils';
import { useEffect } from 'react';

interface Props {
  station: Station;
  fuelType: FuelType;
  stats: NationalStats;
  onClose: () => void;
  onReport: () => void;
}

export default function StationModal({ station, fuelType, stats, onClose, onReport }: Props) {
  // Close on Escape
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  const p = station.prices;
  const brandColor = getBrandColor(station.brand);
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${station.lat},${station.lng}`;
  const shareUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}#station=${encodeURIComponent(station.id)}`;

  const vs = (price: number | null | undefined, avg: number) => {
    if (price == null || !avg) return null;
    const delta = price - avg;
    if (Math.abs(delta) < 0.01) return null;
    return { delta, isHigh: delta > 0 };
  };

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(shareUrl); } catch { /* denied */ }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Panel */}
      <div className="relative w-full max-w-lg bg-[#13131f] rounded-t-2xl sm:rounded-2xl
                      border border-white/8 shadow-2xl slide-up max-h-[90vh] flex flex-col">

        {/* Drag handle (mobile) */}
        <div className="flex justify-center pt-3 pb-1 sm:hidden">
          <div className="w-10 h-1 bg-white/20 rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-white/8 shrink-0"
             style={{ borderLeftColor: brandColor, borderLeftWidth: 4 }}>
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-lg text-zinc-100 leading-tight">{station.name}</h2>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-xs px-2 py-0.5 rounded-full font-semibold text-white"
                    style={{ background: brandColor }}>
                {station.brand}
              </span>
              {station._isAnomaly && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">
                  ⚠️ Precio anómalo
                </span>
              )}
              {p?.updatedAt && (
                <span className="text-xs text-zinc-500">CRE {timeAgo(p.updatedAt)}</span>
              )}
            </div>
          </div>
          <button onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 transition-colors text-xl leading-none shrink-0 mt-1">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

          {/* Address */}
          <div className="text-sm text-zinc-400">
            📍 {station.address}, {station.city}, {station.state}
            {station.distanceKm != null && (
              <span className="ml-2 text-zinc-500">· {formatDistance(station.distanceKm)}</span>
            )}
            <a href={mapsUrl} target="_blank" rel="noopener"
               className="ml-2 text-emerald-400 hover:text-emerald-300 transition-colors text-xs">
              Abrir Maps ↗
            </a>
          </div>

          {/* Prices */}
          <div>
            <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
              Precios oficiales CRE
            </h3>
            <div className="grid grid-cols-3 gap-3">
              {(['regular','premium','diesel'] as FuelType[]).map(ft => {
                const price = p?.[ft];
                const cmp   = vs(price, stats[ft].avg);
                return (
                  <div key={ft} className={`rounded-xl p-3 border text-center transition-all
                    ${ft === fuelType
                      ? 'border-emerald-500/40 bg-emerald-500/5'
                      : 'border-white/8 bg-white/3'}`}>
                    <div className="text-[10px] text-zinc-500 mb-1">{FUEL_LABELS[ft]}</div>
                    <div className={`text-lg font-bold tabular-nums
                      ${price != null ? (ft === fuelType ? 'text-emerald-300' : 'text-zinc-200') : 'text-zinc-600'}`}>
                      {formatMXN(price)}
                    </div>
                    {cmp && (
                      <div className={`text-[10px] mt-0.5 ${cmp.isHigh ? 'text-red-400' : 'text-emerald-400'}`}>
                        {cmp.isHigh ? '▲' : '▼'} ${Math.abs(cmp.delta).toFixed(2)} vs prom.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Community prices */}
          <div className="rounded-xl border border-white/8 bg-white/2 p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                Precio reportado por usuarios
              </h3>
              <span className="badge-pill bg-blue-500/10 text-blue-400 border border-blue-500/20 text-[10px]">
                Próximamente
              </span>
            </div>
            <p className="text-xs text-zinc-500 mb-3">
              ¿Ves un precio diferente al de la CRE? Repórtalo y ayuda a la comunidad.
            </p>
            <button onClick={onReport}
              className="w-full py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20
                         text-emerald-400 text-sm font-medium hover:bg-emerald-500/20 transition-colors">
              + Reportar precio · +10 pts
            </button>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <button onClick={copyLink}
              className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg
                         bg-white/5 hover:bg-white/8 border border-white/8 text-sm text-zinc-300 transition-colors">
              🔗 Compartir
            </button>
            <a href={`https://wa.me/?text=${encodeURIComponent(
              `⛽ ${station.name}\n📍 ${station.address}, ${station.city}\n💰 Magna: ${formatMXN(p?.regular)}\n🔗 ${shareUrl}`
            )}`} target="_blank" rel="noopener"
              className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg
                         bg-white/5 hover:bg-green-500/10 border border-white/8 text-sm text-zinc-300
                         hover:border-green-500/30 hover:text-green-400 transition-colors">
              💬 WhatsApp
            </a>
            <a href="https://repeco.profeco.gob.mx/" target="_blank" rel="noopener"
              className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg
                         bg-white/5 hover:bg-orange-500/10 border border-white/8 text-sm text-zinc-300
                         hover:border-orange-500/30 hover:text-orange-400 transition-colors">
              🏛️ Profeco
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
