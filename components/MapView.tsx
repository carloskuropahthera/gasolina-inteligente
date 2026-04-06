'use client';
import { useEffect, useRef, useState } from 'react';
import type L from 'leaflet';
import type { Station, FuelType, NationalStats } from '@/lib/types';
import { formatMXN, priceColor, getBrandColor, formatDistance, timeAgo } from '@/lib/utils';

// This component is always dynamically imported with ssr:false

interface Props {
  stations: Station[];
  fuelType: FuelType;
  userLocation: { lat: number; lng: number } | null;
  selectedStation: Station | null;
  onSelectStation: (s: Station) => void;
  stats: NationalStats;
}

const CHUNK_SIZE = 400;

export default function MapView({ stations, fuelType, userLocation, selectedStation, onSelectStation, stats }: Props) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const mapRef        = useRef<L.Map | null>(null);
  const markersRef    = useRef<ReturnType<typeof L.markerClusterGroup> | null>(null);
  const userPinRef    = useRef<L.Marker | null>(null);
  const lastZoneRef   = useRef<'dot' | 'label' | null>(null);
  const LRef          = useRef<typeof L | null>(null);
  const selectRef     = useRef(onSelectStation);
  const [loading, setLoading] = useState(true);

  // Keep selectRef current so popup onclick always has latest callback
  selectRef.current = onSelectStation;

  // ── Init map once ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    Promise.all([
      import('leaflet'),
      import('leaflet/dist/leaflet.css' as never),
      import('leaflet.markercluster/dist/leaflet.markercluster.js' as never),
      import('leaflet.markercluster/dist/MarkerCluster.css' as never),
      import('leaflet.markercluster/dist/MarkerCluster.Default.css' as never),
    ]).then(([Lmod]) => {
      const L = Lmod.default;
      LRef.current = L;

      // Expose select callback for popup "Ver detalles" onclick
      (window as typeof window & { _gi_select?: (id: string) => void })._gi_select = (id: string) => {
        const station = stations.find(s => s.id === id);
        if (station) selectRef.current(station);
      };

      const map = L.map(containerRef.current!, {
        center: [23.6345, -102.5528],
        zoom: 5,
        minZoom: 4,
        maxZoom: 18,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19,
      }).addTo(map);

      const markers = L.markerClusterGroup({
        maxClusterRadius: 50,
        disableClusteringAtZoom: 13,
        chunkedLoading: true,
        showCoverageOnHover: false,
        // Show min price in cluster bubble instead of marker count
        iconCreateFunction: (cluster) => {
          const children = cluster.getAllChildMarkers() as unknown as Array<{ _giStation?: Station }>;
          const prices = children
            .map(m => m._giStation?.prices?.[fuelType])
            .filter((v): v is number => v != null);
          const minPrice = prices.length ? Math.min(...prices) : null;
          const count = cluster.getChildCount();
          const label = minPrice != null ? `$${minPrice.toFixed(2)}` : `${count}`;
          return L.divIcon({
            html: `<div class="gi-cluster" data-count="${count}">${label}</div>`,
            className: '',
            iconSize: [56, 24],
            iconAnchor: [28, 12],
          });
        },
      } as L.MarkerClusterGroupOptions);
      map.addLayer(markers);
      markersRef.current = markers;
      mapRef.current = map;

      map.whenReady(() => setLoading(false));

      // Price labels on zoom threshold crossing
      map.on('zoomend', () => {
        const zoom = map.getZoom();
        const zone = zoom >= 13 ? 'label' : 'dot';
        if (zone === lastZoneRef.current) return;
        lastZoneRef.current = zone;
        const bounds = map.getBounds();
        markers.eachLayer((layer: unknown) => {
          const m = layer as { _giStation?: Station; setIcon?: (icon: unknown) => void; getLatLng?: () => { lat: number; lng: number } };
          if (!m._giStation || !m.setIcon || !m.getLatLng) return;
          if (!bounds.contains(m.getLatLng() as Parameters<typeof bounds.contains>[0])) return;
          const s = m._giStation;
          m.setIcon(makeIcon(L, s, fuelType, stats, zone === 'label'));
        });
      });
    });

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      markersRef.current = null;
      LRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Re-render markers when stations/fuelType change ───────────────────
  useEffect(() => {
    const L = LRef.current;
    const markers = markersRef.current;
    const map = mapRef.current;
    if (!L || !markers || !map) return;

    // Update _gi_select with fresh stations list
    (window as typeof window & { _gi_select?: (id: string) => void })._gi_select = (id: string) => {
      const station = stations.find(s => s.id === id);
      if (station) selectRef.current(station);
    };

    markers.clearLayers();
    lastZoneRef.current = null;
    const zoom = map.getZoom();
    const showLabels = zoom >= 13;

    // Build all marker objects first (sync, fast)
    const layers: ReturnType<typeof L.marker>[] = [];
    for (const station of stations) {
      if (!station.lat || !station.lng) continue;
      const icon = makeIcon(L, station, fuelType, stats, showLabels);
      const m = L.marker([station.lat, station.lng], { icon, title: station.name });
      m.bindPopup(() => buildPopup(station, fuelType), { maxWidth: 260 });
      m.on('click', () => selectRef.current(station));
      (m as unknown as { _giStation: Station })._giStation = station;
      layers.push(m);
    }

    // Add in chunks with rAF to avoid blocking the main thread
    let i = 0;
    function addChunk() {
      const end = Math.min(i + CHUNK_SIZE, layers.length);
      markers!.addLayers(layers.slice(i, end));
      i = end;
      if (i < layers.length) requestAnimationFrame(addChunk);
    }
    addChunk();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, fuelType, stats]);

  // ── User pin ─────────────────────────────────────────────────────────
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map) return;

    if (userPinRef.current) { map.removeLayer(userPinRef.current); userPinRef.current = null; }
    if (!userLocation) return;

    const icon = L.divIcon({
      html: '<div style="font-size:24px;line-height:1;filter:drop-shadow(0 2px 4px #0008)">📍</div>',
      className: '', iconSize: [32, 32], iconAnchor: [16, 28],
    });
    userPinRef.current = L.marker([userLocation.lat, userLocation.lng], { icon, zIndexOffset: 1000 }).addTo(map);
    map.setView([userLocation.lat, userLocation.lng], Math.max(mapRef.current?.getZoom() ?? 0, 12));
  }, [userLocation]);

  // ── Pan to selected station ───────────────────────────────────────────
  useEffect(() => {
    if (!selectedStation || !mapRef.current) return;
    mapRef.current.setView([selectedStation.lat, selectedStation.lng], Math.max(mapRef.current.getZoom(), 14), { animate: true });
  }, [selectedStation]);

  return (
    <div className="flex-1 w-full relative" style={{ minHeight: 0 }}>
      <div ref={containerRef} className="absolute inset-0" />

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0d0d1a] z-10">
          <div className="text-center space-y-3">
            <div className="text-4xl animate-pulse">🗺️</div>
            <p className="text-zinc-400 text-sm">Cargando mapa…</p>
          </div>
        </div>
      )}

      {/* Empty state overlay */}
      {!loading && stations.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0d0d1a]/80 z-10 pointer-events-none">
          <div className="text-center space-y-3 bg-[#13131f] border border-white/8 rounded-2xl p-8">
            <span className="text-4xl">🔍</span>
            <p className="text-zinc-300 font-semibold">Sin estaciones</p>
            <p className="text-zinc-500 text-sm">Ajusta los filtros para ver resultados</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function makeIcon(
  L: typeof import('leaflet'),
  station: Station,
  fuelType: FuelType,
  stats: NationalStats,
  showLabel: boolean,
) {
  const price = station.prices?.[fuelType];
  const color = price != null
    ? priceColor(price, stats[fuelType].min, stats[fuelType].max)
    : getBrandColor(station.brand);

  if (showLabel && price != null) {
    const html = `<div class="gi-price-pill" style="--pill-color:${color}">$${price.toFixed(2)}</div>`;
    return L.divIcon({ html, className: '', iconSize: [54, 20], iconAnchor: [27, 10] });
  }

  const size = station._isAnomaly ? 12 : 9;
  const border = station._isAnomaly ? '#FFD700' : 'rgba(255,255,255,0.4)';
  const html = `<div class="gi-dot" style="width:${size}px;height:${size}px;background:${color};border-color:${border}"></div>`;
  return L.divIcon({ html, className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function buildPopup(station: Station, fuelType: FuelType): string {
  const p = station.prices;
  const distStr = station.distanceKm != null ? `<div style="font-size:11px;color:#8888aa;margin-top:2px">📍 ${formatDistance(station.distanceKm)}</div>` : '';
  const freshStr = p?.updatedAt ? `<div style="font-size:10px;color:#666;margin-top:4px">CRE: ${timeAgo(p.updatedAt)}</div>` : '';
  const locationStr = station.city ? `${esc(station.brand)} · ${esc(station.city)}` : esc(station.brand);

  return `
    <div style="min-width:180px">
      <div style="font-weight:700;font-size:13px;margin-bottom:4px">${esc(station.name)}</div>
      <div style="font-size:11px;color:#8888aa">${locationStr}</div>
      ${distStr}
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        ${priceChip('Magna', p?.regular)}
        ${priceChip('Premium', p?.premium)}
        ${priceChip('Diésel', p?.diesel)}
      </div>
      ${freshStr}
      <div style="margin-top:8px;font-size:11px;color:#00e676;cursor:pointer;font-weight:600"
           onclick="window._gi_select?.('${esc(station.id)}')">
        Ver detalles →
      </div>
    </div>`;
}

function priceChip(label: string, val: number | null | undefined): string {
  if (val == null) return '';
  return `<span style="background:rgba(255,255,255,0.06);border-radius:4px;padding:2px 6px;font-size:11px">
    <span style="color:#8888aa">${label} </span><strong>${formatMXN(val)}</strong>
  </span>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
}
