import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';
import type { Station, FuelType } from '@/lib/types';

function detectAnomalies(stations: Station[], fuelKey: FuelType): void {
  const prices = stations
    .filter(s => s.prices?.[fuelKey] != null)
    .map(s => s.prices![fuelKey]!);
  if (prices.length <= 10) return;
  const mean     = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((a, b) => a + (b - mean) ** 2, 0) / prices.length;
  const stddev   = Math.sqrt(variance);
  const threshold = 3 * stddev;
  for (const s of stations) {
    const price = s.prices?.[fuelKey];
    if (price != null && Math.abs(price - mean) > threshold) {
      s._isAnomaly = true;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// DATA SOURCE
// This API route reads the static JSON produced by the Python pipeline
// (pipeline/scripts/export_for_app.py), which GitHub Actions runs daily.
//
// TO SWAP IN REAL-TIME CRE DATA:
//   1. Create a Vercel Cron Job (vercel.json → "crons") that calls
//      POST /api/stations/refresh every 30min
//   2. In the refresh route: fetch from
//      https://datos.gob.mx/busca/api/3/action/package_show?id=estaciones-de-servicio-gasolineras-y-precios-finales-de-gasolinas-y-diesel
//      or the CRE XML feed at https://publicacionexterna.azurewebsites.net/publicaciones/prices
//   3. Write parsed results to Supabase (table: stations, table: prices)
//   4. This route: SELECT from Supabase instead of reading a file
// ──────────────────────────────────────────────────────────────────────────────

function normalizeStation(raw: Record<string, unknown>): Station {
  const rawPrices = raw.prices as Record<string, unknown> | null;
  const prices = rawPrices ? {
    regular:   (rawPrices.regular   ?? rawPrices.gasolina_regular  ?? null) as number | null,
    premium:   (rawPrices.premium   ?? rawPrices.gasolina_premium  ?? null) as number | null,
    diesel:    (rawPrices.diesel    ?? null) as number | null,
    updatedAt: (rawPrices.updatedAt ?? rawPrices.updated_at        ?? null) as string | null,
  } : null;

  const hasData = (raw.hasData as boolean | undefined) ??
    (prices != null && (prices.regular != null || prices.premium != null || prices.diesel != null));

  return {
    id:      String(raw.id      ?? raw.master_id          ?? ''),
    name:    (raw.name    ?? raw.canonical_name            ?? '') as string,
    brand:   (raw.brand   ?? raw.canonical_brand           ?? 'OTRO') as string,
    address: (raw.address ?? raw.canonical_address         ?? '') as string,
    city:    (raw.city    ?? raw.canonical_municipality    ?? '') as string,
    state:   (raw.state   ?? raw.canonical_state           ?? '') as string,
    zipCode: (raw.zipCode ?? raw.canonical_zip             ?? '') as string,
    lat:     parseFloat(String(raw.lat ?? 0)),
    lng:     parseFloat(String(raw.lng ?? 0)),
    prices,
    hasData,
    updatedAt: (rawPrices?.updatedAt ?? rawPrices?.updated_at ?? null) as string | null,
  };
}

export async function GET() {
  try {
    const filePath = path.join(process.cwd(), 'data', 'stations_latest.json');
    const content  = await readFile(filePath, 'utf-8');
    const json     = JSON.parse(content);

    const raw: unknown[] = json.stations ?? json.data ?? (Array.isArray(json) ? json : []);
    const stations: Station[] = (raw as Record<string, unknown>[])
      .map(normalizeStation)
      .filter(s => s.id && s.lat && s.lng);

    // Anomaly detection: flag stations where any fuel price deviates > 3 stddev from mean
    detectAnomalies(stations, 'regular');
    detectAnomalies(stations, 'premium');
    detectAnomalies(stations, 'diesel');

    return NextResponse.json(
      {
        stations,
        meta: {
          total:      stations.length,
          exportedAt: json.exported_at ?? null,
          source:     'pipeline', // 'supabase' once backend is live
        },
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        },
      }
    );
  } catch {
    // Return empty dataset gracefully — the frontend shows a helpful empty state
    return NextResponse.json(
      { stations: [], meta: { total: 0, exportedAt: null, source: 'empty' } },
      { status: 200 }
    );
  }
}
