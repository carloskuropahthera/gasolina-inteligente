'use client';
import type { ViewMode } from '@/lib/types';

const TABS: { id: ViewMode; label: string; icon: string }[] = [
  { id: 'map',   label: 'Mapa',  icon: '🗺️' },
  { id: 'list',  label: 'Lista', icon: '☰'  },
  { id: 'route', label: 'Ruta',  icon: '🛣️' },
];

export default function ViewToggle({
  current, onChange,
}: { current: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="flex gap-1 bg-white/5 p-0.5 rounded-lg">
      {TABS.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all
            ${current === t.id
              ? 'bg-emerald-500 text-black shadow'
              : 'text-zinc-400 hover:text-zinc-200'}`}
        >
          <span>{t.icon}</span>
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  );
}
