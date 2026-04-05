'use client';
import { useState } from 'react';
import type { Station, FuelType } from '@/lib/types';
import { formatMXN, FUEL_LABELS } from '@/lib/utils';
import { useEffect } from 'react';

interface Props {
  station: Station;
  fuelType: FuelType;
  onClose: () => void;
  onSubmit: (report: PriceReport) => void;
}

export interface PriceReport {
  stationId: string;
  fuelType: FuelType;
  price: number;
  lat?: number;
  lng?: number;
  photo?: string;
}

const FUEL_OPTIONS: FuelType[] = ['regular', 'premium', 'diesel'];

export default function ReportModal({ station, fuelType, onClose, onSubmit }: Props) {
  const [selectedFuel, setSelectedFuel] = useState<FuelType>(fuelType);
  const [price, setPrice]               = useState('');
  const [locating, setLocating]         = useState(false);
  const [locLocked, setLocLocked]       = useState(false);
  const [userCoords, setUserCoords]     = useState<{ lat: number; lng: number } | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [submitted, setSubmitted]       = useState(false);
  const [error, setError]               = useState<string | null>(null);

  // Close on Escape
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  const lockGPS = () => {
    if (!navigator.geolocation) { setError('GPS no disponible'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      pos => {
        setUserCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocLocked(true);
        setLocating(false);
      },
      () => { setError('No se pudo obtener ubicación'); setLocating(false); }
    );
  };

  const handlePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setPhotoPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleSubmit = () => {
    const parsed = parseFloat(price);
    if (!price || isNaN(parsed) || parsed < 5 || parsed > 50) {
      setError('Ingresa un precio válido (entre $5 y $50)');
      return;
    }
    setError(null);
    onSubmit({
      stationId: station.id,
      fuelType: selectedFuel,
      price: parsed,
      lat: userCoords?.lat,
      lng: userCoords?.lng,
      photo: photoPreview ?? undefined,
    });
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
        onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        <div className="relative w-full max-w-md bg-[#13131f] rounded-t-2xl sm:rounded-2xl
                        border border-white/8 shadow-2xl slide-up p-8 text-center">
          <div className="text-5xl mb-4">✅</div>
          <h2 className="text-xl font-bold text-emerald-400 mb-2">¡Reporte enviado!</h2>
          <p className="text-sm text-zinc-400 mb-1">
            Gracias por reportar el precio en
          </p>
          <p className="text-sm font-semibold text-zinc-200 mb-4">{station.name}</p>
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500/10 border border-emerald-500/20">
            <span className="text-emerald-400 font-bold text-lg">{formatMXN(parseFloat(price))}</span>
            <span className="text-zinc-500 text-sm">{FUEL_LABELS[selectedFuel]}</span>
          </div>
          <p className="text-xs text-zinc-600 mt-4">
            +10 puntos · Tu reporte ayuda a la comunidad 🙌
          </p>
          <button
            onClick={onClose}
            className="mt-6 w-full py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20
                       text-emerald-400 font-medium hover:bg-emerald-500/20 transition-colors"
          >
            Cerrar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <div className="relative w-full max-w-md bg-[#13131f] rounded-t-2xl sm:rounded-2xl
                      border border-white/8 shadow-2xl slide-up max-h-[90vh] flex flex-col">

        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 sm:hidden">
          <div className="w-10 h-1 bg-white/20 rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-white/8 shrink-0">
          <div>
            <h2 className="font-bold text-zinc-100">Reportar precio</h2>
            <p className="text-xs text-zinc-500 mt-0.5 truncate max-w-64">{station.name}</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-xl leading-none">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

          {/* Fuel type */}
          <div>
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              Tipo de combustible
            </label>
            <div className="flex gap-2 mt-2">
              {FUEL_OPTIONS.map(ft => (
                <button
                  key={ft}
                  onClick={() => setSelectedFuel(ft)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-all
                    ${selectedFuel === ft
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                      : 'bg-white/3 border-white/8 text-zinc-400 hover:text-zinc-200'}`}
                >
                  {FUEL_LABELS[ft]}
                </button>
              ))}
            </div>
          </div>

          {/* Price input */}
          <div>
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              Precio por litro
            </label>
            <div className="relative mt-2">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 font-bold">$</span>
              <input
                type="number"
                step="0.01"
                min="5"
                max="50"
                placeholder="0.00"
                value={price}
                onChange={e => { setPrice(e.target.value); setError(null); }}
                className="w-full pl-7 pr-4 py-3 bg-white/5 border border-white/10 rounded-xl
                           text-zinc-100 text-lg font-bold tabular-nums placeholder:text-zinc-600
                           focus:outline-none focus:border-emerald-500/50"
              />
            </div>
            {station.prices?.[selectedFuel] != null && (
              <p className="text-xs text-zinc-600 mt-1">
                Precio CRE: {formatMXN(station.prices[selectedFuel])}
              </p>
            )}
          </div>

          {/* GPS lock */}
          <div>
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              Verificación de ubicación
            </label>
            <button
              onClick={lockGPS}
              disabled={locating || locLocked}
              className={`mt-2 w-full flex items-center justify-center gap-2 py-2.5 rounded-xl
                         border text-sm font-medium transition-all
                ${locLocked
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : 'bg-white/5 border-white/10 text-zinc-400 hover:bg-white/8'}`}
            >
              {locating ? (
                <><span className="animate-spin">⏳</span> Localizando…</>
              ) : locLocked ? (
                <>📍 Ubicación verificada</>
              ) : (
                <>📍 Verificar que estoy aquí (opcional)</>
              )}
            </button>
          </div>

          {/* Photo */}
          <div>
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              Foto del precio (opcional)
            </label>
            <div className="mt-2">
              {photoPreview ? (
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photoPreview} alt="Foto precio" className="w-full h-32 object-cover rounded-xl border border-white/10" />
                  <button
                    onClick={() => setPhotoPreview(null)}
                    className="absolute top-2 right-2 w-6 h-6 bg-black/60 rounded-full text-xs text-white flex items-center justify-center"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <label className="flex items-center justify-center gap-2 py-3 rounded-xl border border-dashed
                                  border-white/15 text-zinc-500 text-sm cursor-pointer hover:border-white/25
                                  hover:text-zinc-400 transition-colors">
                  📷 Agregar foto
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhoto} />
                </label>
              )}
            </div>
          </div>

          {/* Error */}
          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              ⚠️ {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-white/8 shrink-0">
          <button
            onClick={handleSubmit}
            className="w-full py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black
                       font-bold text-sm transition-colors"
          >
            Enviar reporte · +10 pts
          </button>
          <p className="text-center text-xs text-zinc-600 mt-2">
            Los reportes verificados con GPS y foto ganan puntos extra
          </p>
        </div>
      </div>
    </div>
  );
}
