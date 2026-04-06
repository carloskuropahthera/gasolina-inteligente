// Vercel Cron Job — runs every 4 hours to pull fresh CRE prices
// from the official Azure XML feed (same cadence as CRE's own refresh).
//
// Schedule set in vercel.json:
//   "crons": [{ "path": "/api/cron/refresh", "schedule": "0 */4 * * *" }]
//
// The CRE XML endpoints:
//   Places: https://publicacionexterna.azurewebsites.net/publicaciones/places
//   Prices: https://publicacionexterna.azurewebsites.net/publicaciones/prices
//
// For now this route returns the parsed data as JSON.
// Production upgrade: write results to Supabase → /api/stations reads from DB.

import { NextResponse } from 'next/server';

const CRE_PRICES_URL = 'https://publicacionexterna.azurewebsites.net/publicaciones/prices';
const CRE_PLACES_URL = 'https://publicacionexterna.azurewebsites.net/publicaciones/places';

// Simple XML text parser — no dependencies needed for this flat structure
function parseXMLRecords(xml: string, tagName: string): Record<string, string>[] {
  const records: Record<string, string>[] = [];
  const blockRe = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'g');
  const fieldRe = /<([a-zA-Z_][a-zA-Z0-9_]*)(?:[^>]*)?>([^<]*)<\/\1>/g;

  let blockMatch;
  while ((blockMatch = blockRe.exec(xml)) !== null) {
    const block: Record<string, string> = {};
    let fieldMatch;
    fieldRe.lastIndex = 0;
    while ((fieldMatch = fieldRe.exec(blockMatch[1])) !== null) {
      block[fieldMatch[1]] = fieldMatch[2].trim();
    }
    records.push(block);
  }
  return records;
}

export async function GET(req: Request) {
  // Verify this is called by Vercel Cron (or allow in dev)
  const authHeader = req.headers.get('authorization');
  if (process.env.NODE_ENV === 'production' && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const [pricesRes, placesRes] = await Promise.all([
      fetch(CRE_PRICES_URL, { signal: controller.signal, next: { revalidate: 0 } }),
      fetch(CRE_PLACES_URL, { signal: controller.signal, next: { revalidate: 0 } }),
    ]);
    clearTimeout(timeout);

    if (!pricesRes.ok || !placesRes.ok) {
      return NextResponse.json({ error: 'CRE fetch failed' }, { status: 502 });
    }

    const [pricesXml, placesXml] = await Promise.all([
      pricesRes.text(),
      placesRes.text(),
    ]);

    const prices = parseXMLRecords(pricesXml, 'place');
    const places = parseXMLRecords(placesXml, 'place');

    // Index prices by CRE id
    const priceMap: Record<string, Record<string, string>> = {};
    for (const p of prices) {
      if (p.place_id) priceMap[p.place_id] = p;
    }

    // Merge places + prices
    const now = new Date().toISOString();
    const stations = places
      .map(place => {
        const id = place.place_id ?? place.id ?? '';
        const p  = priceMap[id] ?? {};
        return {
          id:      `cre_${id}`,
          name:    place.name ?? '',
          brand:   place.cre_id ?? 'OTRO',
          address: place.address ?? '',
          city:    place.municipality ?? '',
          state:   place.state ?? '',
          lat:     parseFloat(place.latitude  ?? '0'),
          lng:     parseFloat(place.longitude ?? '0'),
          hasData: !!(p.regular || p.premium || p.diesel),
          prices: {
            regular: p.regular  ? parseFloat(p.regular)  : null,
            premium: p.premium  ? parseFloat(p.premium)  : null,
            diesel:  p.diesel   ? parseFloat(p.diesel)   : null,
            updatedAt: now,
          },
        };
      })
      .filter(s => s.lat && s.lng);

    // TODO: write to Supabase here
    // await supabase.from('stations').upsert(stations, { onConflict: 'id' });

    return NextResponse.json({
      ok: true,
      count: stations.length,
      refreshedAt: now,
      // Return sample for debugging (remove in production)
      sample: stations.slice(0, 3),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
