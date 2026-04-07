'use client';
import type { AppFilters } from '@/lib/types';
import { DEFAULT_FILTERS, FUEL_LABELS, formatMXN } from '@/lib/utils';

interface Props {
  filters: AppFilters;
  onChange: (f: AppFilters) => void;
}

export default function FilterChips({ filters, onChange }: Props) {
  const set = (patch: Partial<AppFilters>) => onChange({ ...filters, ...patch });

  const chips: { label: string; clear: () => void }[] = [];

  if (filters.brands.length === 1)
    chips.push({ label: `Marca: ${filters.brands[0]}`, clear: () => set({ brands: [] }) });
  else if (filters.brands.length > 1)
    chips.push({ label: `${filters.brands.length} marcas`, clear: () => set({ brands: [] }) });

  if (filters.states.length === 1)
    chips.push({ label: `Estado: ${filters.states[0]}`, clear: () => set({ states: [] }) });
  else if (filters.states.length > 1)
    chips.push({ label: `${filters.states.length} estados`, clear: () => set({ states: [] }) });

  if (filters.maxDistanceKm != null)
    chips.push({ label: `≤ ${filters.maxDistanceKm} km`, clear: () => set({ maxDistanceKm: null }) });

  if (filters.priceMin != null || filters.priceMax != null) {
    const min = filters.priceMin != null ? formatMXN(filters.priceMin) : '—';
    const max = filters.priceMax != null ? formatMXN(filters.priceMax) : '—';
    chips.push({ label: `${min} – ${max}`, clear: () => set({ priceMin: null, priceMax: null }) });
  }

  if (filters.open24h)
    chips.push({ label: 'Abierta 24h', clear: () => set({ open24h: false }) });

  if (filters.showAnomalies)
    chips.push({ label: 'Solo anomalías', clear: () => set({ showAnomalies: false }) });

  if (filters.showOnlyWithData)
    chips.push({ label: 'Con precio', clear: () => set({ showOnlyWithData: false }) });

  if (filters.fuelType !== DEFAULT_FILTERS.fuelType)
    chips.push({ label: FUEL_LABELS[filters.fuelType], clear: () => set({ fuelType: DEFAULT_FILTERS.fuelType }) });

  if (!chips.length) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 bg-[#0d0d1a] overflow-x-auto shrink-0 scrollbar-none">
      {chips.map(chip => (
        <button
          key={chip.label}
          onClick={chip.clear}
          className="flex items-center gap-1 shrink-0 px-2 py-0.5 rounded-full text-[11px]
                     bg-emerald-500/10 border border-emerald-500/25 text-emerald-400
                     hover:bg-emerald-500/20 transition-colors"
        >
          {chip.label} <span className="text-emerald-600 ml-0.5">×</span>
        </button>
      ))}
      {chips.length >= 2 && (
        <button
          onClick={() => onChange(DEFAULT_FILTERS)}
          className="shrink-0 text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors ml-1"
        >
          Limpiar todo
        </button>
      )}
    </div>
  );
}
