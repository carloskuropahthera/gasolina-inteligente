'use client';
import { useRef } from 'react';
import { timeAgo } from '@/lib/utils';

interface Props {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  userLocation: { lat: number; lng: number } | null;
  onRequestLocation: () => void;
  exportedAt: string | null;
  totalShowing: number;
  totalAll: number;
  onToggleFilters: () => void;
  filtersActive: number;
}

export default function TopBar({
  searchQuery, onSearchChange,
  userLocation, onRequestLocation,
  exportedAt,
  onToggleFilters, filtersActive,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <header className="flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-[#0d0d1a] z-30 shrink-0">
      {/* Logo */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-xl">⛽</span>
        <span className="font-bold text-sm hidden sm:block">
          <span className="text-emerald-400">Gasolina</span>
          <span className="text-zinc-300"> Inteligente</span>
        </span>
      </div>

      {/* Search */}
      <div className="flex-1 relative max-w-md">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 text-sm">🔍</span>
        <input
          ref={inputRef}
          type="search"
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Ciudad, marca, estado…"
          className="w-full bg-white/5 border border-white/8 rounded-lg
                     pl-8 pr-3 py-1.5 text-sm text-zinc-200
                     placeholder:text-zinc-600 focus:outline-none
                     focus:border-emerald-500/50 focus:bg-white/8 transition-colors"
        />
      </div>

      {/* Data freshness */}
      {exportedAt && (
        <span className="hidden md:flex items-center gap-1 text-xs text-zinc-500 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          CRE {timeAgo(exportedAt)}
        </span>
      )}

      {/* GPS */}
      <button
        onClick={onRequestLocation}
        title={userLocation ? 'Ubicación activa' : 'Activar ubicación'}
        className={`p-1.5 rounded-lg transition-colors shrink-0
          ${userLocation ? 'text-emerald-400 bg-emerald-500/10' : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'}`}
      >
        📍
      </button>

      {/* Filters */}
      <button
        onClick={onToggleFilters}
        className="relative p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors shrink-0"
        aria-label="Filtros"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/>
          <line x1="11" y1="18" x2="13" y2="18"/>
        </svg>
        {filtersActive > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-emerald-500 text-black
                           text-[10px] font-bold rounded-full flex items-center justify-center">
            {filtersActive}
          </span>
        )}
      </button>
    </header>
  );
}
