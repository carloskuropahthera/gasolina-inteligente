'use client';
import { useState } from 'react';
import type { AppFilters } from '@/lib/types';
import { DEFAULT_FILTERS } from '@/lib/utils';
import { useFilterPresets } from '@/lib/useFilterPresets';

interface Props {
  filters: AppFilters;
  onChange: (f: AppFilters) => void;
  brands: string[];
  states: string[];
  onClose: () => void;
  open24hCount?: number;
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-emerald-500/20 text-emerald-300 rounded-sm">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export default function Filters({ filters, onChange, brands, states, onClose, open24hCount = 0 }: Props) {
  const set = (patch: Partial<AppFilters>) => onChange({ ...filters, ...patch });

  const toggle = (field: 'brands' | 'states', val: string) => {
    const arr = filters[field];
    set({ [field]: arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val] });
  };

  const [brandSearch, setBrandSearch] = useState('');
  const [stateSearch, setStateSearch] = useState('');
  const [presetName,  setPresetName]  = useState('');
  const [showPresetInput, setShowPresetInput] = useState(false);

  const { presets, savePreset, deletePreset } = useFilterPresets();

  const filteredBrands = brands.filter(b => b.toLowerCase().includes(brandSearch.toLowerCase()));
  const filteredStates = states.filter(s => s.toLowerCase().includes(stateSearch.toLowerCase()));

  const inputCls = 'w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-1 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50 mb-2';

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

        {/* Filter presets (#14) */}
        {presets.length > 0 && (
          <section>
            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
              Presets guardados
            </label>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {presets.map(p => (
                <div key={p.name} className="flex items-center gap-0.5">
                  <button
                    onClick={() => onChange(p.filters)}
                    className="px-2.5 py-1 rounded-full text-xs bg-zinc-800 border border-white/8
                               text-zinc-300 hover:border-emerald-500/30 hover:text-emerald-300 transition-colors"
                  >
                    {p.name}
                  </button>
                  <button
                    onClick={() => deletePreset(p.name)}
                    className="text-[10px] text-zinc-700 hover:text-red-400 transition-colors px-0.5"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

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

        {/* States (#12) */}
        {states.length > 0 && (
          <section>
            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
              Estado
            </label>
            <div className="mt-2">
              <input
                type="text"
                placeholder="Buscar estado…"
                value={stateSearch}
                onChange={e => setStateSearch(e.target.value)}
                className={inputCls}
              />
              <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
                {filteredStates.map(s => (
                  <label key={s} className="flex items-center gap-2 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={filters.states.includes(s)}
                      onChange={() => toggle('states', s)}
                      className="w-4 h-4 rounded border-white/20 bg-white/5 accent-emerald-500"
                    />
                    <span className="text-zinc-400 group-hover:text-zinc-200 transition-colors text-xs truncate">
                      <Highlight text={s} query={stateSearch} />
                    </span>
                  </label>
                ))}
                {filteredStates.length === 0 && (
                  <p className="text-xs text-zinc-600 py-1">Sin coincidencias</p>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Brands (#12) */}
        {brands.length > 0 && (
          <section>
            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
              Marca
            </label>
            <div className="mt-2">
              <input
                type="text"
                placeholder="Buscar marca…"
                value={brandSearch}
                onChange={e => setBrandSearch(e.target.value)}
                className={inputCls}
              />
              <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
                {filteredBrands.map(b => (
                  <label key={b} className="flex items-center gap-2 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={filters.brands.includes(b)}
                      onChange={() => toggle('brands', b)}
                      className="w-4 h-4 rounded border-white/20 bg-white/5 accent-emerald-500"
                    />
                    <span className="text-zinc-400 group-hover:text-zinc-200 transition-colors text-xs truncate">
                      <Highlight text={b} query={brandSearch} />
                    </span>
                  </label>
                ))}
                {filteredBrands.length === 0 && (
                  <p className="text-xs text-zinc-600 py-1">Sin coincidencias</p>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Save preset (#14) */}
        <section>
          {showPresetInput ? (
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Nombre del preset"
                value={presetName}
                onChange={e => setPresetName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && presetName.trim()) {
                    savePreset(presetName.trim(), filters);
                    setPresetName('');
                    setShowPresetInput(false);
                  }
                }}
                autoFocus
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1
                           text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50"
              />
              <button
                onClick={() => {
                  if (presetName.trim()) {
                    savePreset(presetName.trim(), filters);
                    setPresetName('');
                    setShowPresetInput(false);
                  }
                }}
                className="px-2 py-1 text-xs rounded-lg bg-emerald-500/15 border border-emerald-500/30
                           text-emerald-400 hover:bg-emerald-500/25 transition-colors"
              >
                Guardar
              </button>
              <button
                onClick={() => { setShowPresetInput(false); setPresetName(''); }}
                className="text-zinc-600 hover:text-zinc-400 text-xs"
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowPresetInput(true)}
              className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              + Guardar filtros como preset
            </button>
          )}
        </section>
      </div>
    </div>
  );
}
