'use client';
import type { AppFilters } from '@/lib/types';
import { DEFAULT_FILTERS } from '@/lib/utils';

interface Props {
  filters: AppFilters;
  onChange: (f: AppFilters) => void;
  brands: string[];
  states: string[];
  onClose: () => void;
  open24hCount?: number;
}

export default function Filters({ filters, onChange, brands, states, onClose, open24hCount = 0 }: Props) {
  const set = (patch: Partial<AppFilters>) => onChange({ ...filters, ...patch });

  const toggle = (field: 'brands' | 'states', val: string) => {
    const arr = filters[field];
    set({ [field]: arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val] });
  };

  return (
    <div className="h-full flex flex-col bg-[#0d0d1a] border-r border-white/5 w-72 z-50">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 shrink-0">
        <span className="font-semibold text-sm">Filtros</span>
        <div className="flex gap-2">
          <button
            onClick={() => onChange(DEFAULT_FILTERS)}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Limpiar
          </button>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5 text-sm">

        {/* Distance */}
        <section>
          <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Distancia máxima
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            {[null, 5, 10, 25, 50].map(d => (
              <button
                key={d ?? 'all'}
                onClick={() => set({ maxDistanceKm: d })}
                className={`px-3 py-1 rounded-full text-xs border transition-all
                  ${filters.maxDistanceKm === d
                    ? 'bg-emerald-500 text-black border-emerald-500'
                    : 'border-white/10 text-zinc-400 hover:border-white/20'}`}
              >
                {d == null ? 'Todo' : `${d} km`}
              </button>
            ))}
          </div>
        </section>

        {/* Price range */}
        <section>
          <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Rango de precio
          </label>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="number" step="0.01" placeholder="Mín"
              value={filters.priceMin ?? ''}
              onChange={e => set({ priceMin: e.target.value ? parseFloat(e.target.value) : null })}
              className="w-24 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5
                         text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50"
            />
            <span className="text-zinc-600">—</span>
            <input
              type="number" step="0.01" placeholder="Máx"
              value={filters.priceMax ?? ''}
              onChange={e => set({ priceMax: e.target.value ? parseFloat(e.target.value) : null })}
              className="w-24 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5
                         text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50"
            />
          </div>
        </section>

        {/* Extras */}
        <section>
          <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Extras
          </label>
          <div className="mt-2 space-y-2">
            <label className="flex items-center gap-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={!!filters.showAnomalies}
                onChange={e => set({ showAnomalies: e.target.checked })}
                className="w-4 h-4 rounded border-white/20 bg-white/5 accent-emerald-500"
              />
              <span className="text-zinc-300 group-hover:text-zinc-100 transition-colors">
                ⚠️ Solo anomalías
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={!!filters.open24h}
                onChange={e => set({ open24h: e.target.checked })}
                className="w-4 h-4 rounded border-white/20 bg-white/5 accent-emerald-500"
              />
              <span className="text-zinc-300 group-hover:text-zinc-100 transition-colors">
                🕐 Abierto 24h
                {open24hCount === 0 && <span className="text-[10px] text-zinc-600 ml-1">(sin datos)</span>}
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={!!filters.showOnlyWithData}
                onChange={e => set({ showOnlyWithData: e.target.checked })}
                className="w-4 h-4 rounded border-white/20 bg-white/5 accent-emerald-500"
              />
              <span className="text-zinc-300 group-hover:text-zinc-100 transition-colors">
                💰 Solo con precio
              </span>
            </label>
          </div>
        </section>

        {/* States */}
        {states.length > 0 && (
          <section>
            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
              Estado
            </label>
            <div className="mt-2 max-h-40 overflow-y-auto space-y-1 pr-1">
              {states.map(s => (
                <label key={s} className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={filters.states.includes(s)}
                    onChange={() => toggle('states', s)}
                    className="w-4 h-4 rounded border-white/20 bg-white/5 accent-emerald-500"
                  />
                  <span className="text-zinc-400 group-hover:text-zinc-200 transition-colors text-xs truncate">
                    {s}
                  </span>
                </label>
              ))}
            </div>
          </section>
        )}

        {/* Brands */}
        {brands.length > 0 && (
          <section>
            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
              Marca
            </label>
            <div className="mt-2 max-h-40 overflow-y-auto space-y-1 pr-1">
              {brands.map(b => (
                <label key={b} className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={filters.brands.includes(b)}
                    onChange={() => toggle('brands', b)}
                    className="w-4 h-4 rounded border-white/20 bg-white/5 accent-emerald-500"
                  />
                  <span className="text-zinc-400 group-hover:text-zinc-200 transition-colors text-xs truncate">
                    {b}
                  </span>
                </label>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
