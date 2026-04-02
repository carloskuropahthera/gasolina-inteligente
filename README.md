# Gasolina Inteligente — Beta v1

Gas price intelligence platform for Mexico using live CRE government data.

## How to Run

Open `index.html` in any modern browser. That's it. No build step, no server required.

```
gasolina-inteligente/
└── index.html   ← double-click to open
```

For the best experience, serve over a local HTTP server to avoid CORS restrictions on file:// protocol:

```bash
# Python 3
python -m http.server 8080
# Then open: http://localhost:8080
```

## The Data Sources

Two public CRE (Comisión Reguladora de Energía) government APIs. No authentication required.

| API | URL | Cadence |
|-----|-----|---------|
| Places | `publicacionexterna.azurewebsites.net/publicaciones/places` | Fetch once, cache 24h |
| Prices | `publicacionexterna.azurewebsites.net/publicaciones/prices` | Daily — data overwrites each day |

**Important:** Both APIs work perfectly from Node.js and server-side scripts. The CORS proxy waterfall (`modules/api/fetch-strategy.js`) only exists for browser-direct access.

## Why the Daily Scraper Matters

> Every day we don't save prices, that data is permanently gone.

The CRE Prices API overwrites itself every day — there is no archive, no history endpoint. The daily scraper (`modules/scraper/daily-scraper.js`) auto-runs between 6–8 AM Mexico City time when the browser tab is open.

**Historical price data is our proprietary competitive asset.** After 90 days of collection:
- Price trend analysis across states and brands
- Seasonal pattern detection (holiday premiums on highway corridors)
- Anomaly detection calibrated to local neighborhood history
- Predictive pricing for fleet planning

No competitor can replicate this data retroactively.

## Mock Mode for Offline Development

Open the Dev Panel (`Ctrl+Shift+D` → Mock tab) and click **Mock Data**.

The mock dataset has 100 stations across Mexico (CDMX, Guadalajara, Monterrey, Tijuana, Puebla, highway corridors) with three anomalous stations baked in for testing the anomaly detector.

The ⚠️ MOCK MODE banner appears in the header when active. Mock mode persists across page reloads.

## The Distance Matrix

Pre-computed haversine + manhattan distances between all station pairs. Eliminates real-time O(n²) calculations for "nearby stations" queries.

**To generate:**
1. Open Dev Panel → Matrix tab
2. Click `[Generate 5km Matrix]` — ~30 seconds for 12,000 stations
3. Browser downloads `stations_within_5km.csv`
4. Move the file to `data/static/stations_within_5km.csv`
5. Reload the app — matrix loads automatically, O(1) lookups enabled

The matrix format matches the **Valero VIPER** system:
```
ID_A, ID_B, CRE_ID_A, CRE_ID_B, haversine_km, manhattan_approx_km
```

Manhattan distance gives a road-distance proxy without routing APIs — better than haversine for grid cities (CDMX, Monterrey, Guadalajara).

## Module Map

```
gasolina-inteligente/
│
├── index.html                         ← single entry point
├── app.js                             ← startup sequence + module wiring
├── style.css                          ← dark theme, CSS variables, mobile-first
│
├── modules/
│   ├── utils/
│   │   ├── logger.js                  ← color-coded leveled logger, 1000-entry history
│   │   ├── helpers.js                 ← pure utility functions (formatting, CSV, dates)
│   │   └── state.js                   ← observable state container (no framework)
│   │
│   ├── api/
│   │   ├── fetch-strategy.js          ← CORS proxy waterfall (4 proxies, cached)
│   │   ├── cache.js                   ← in-memory TTL cache with stats
│   │   └── cre-client.js              ← ONLY file that calls CRE APIs + 100-station mock
│   │
│   ├── storage/
│   │   ├── storage-interface.js       ← abstract contract (never changes)
│   │   ├── local-driver.js            ← localStorage implementation
│   │   └── README.md                  ← Supabase/SQLite swap guide
│   │
│   ├── precompute/
│   │   ├── distance-generator.js      ← grid-cell spatial index, haversine + manhattan
│   │   └── matrix-loader.js           ← CSV loader, O(1) index, getNearby()
│   │
│   ├── scraper/
│   │   └── daily-scraper.js           ← 6–8 AM auto-scrape, history, force mode
│   │
│   ├── analytics/
│   │   ├── anomaly-detector.js        ← Z-score + IQR spatial detection (VIPER-inspired)
│   │   ├── price-trends.js            ← moving averages, trend direction, volatility
│   │   ├── savings-calculator.js      ← fill/fleet savings, route comparison
│   │   ├── fleet-optimizer.js         ← STUB: route optimization, abuse detection
│   │   └── price-predictor.js         ← STUB: ML prediction, seasonal alerts
│   │
│   ├── data/
│   │   ├── geo.js                     ← haversine, manhattan, user location
│   │   ├── stations.js                ← filtering, brand colors, lookups
│   │   └── prices.js                  ← stats, history, merge, aggregations
│   │
│   ├── ui/
│   │   ├── map.js                     ← Leaflet, marker clustering, heatmap
│   │   ├── price-list.js              ← sortable table + card view, pagination, export
│   │   ├── station-card.js            ← detail drawer with Chart.js history
│   │   ├── anomaly-panel.js           ← severity dashboard, VIPER export
│   │   ├── scraper-panel.js           ← status, history, storage management
│   │   ├── filters.js                 ← fuel tabs, brand/state/city, sliders, URL hash
│   │   ├── search.js                  ← real-time search, keyboard nav
│   │   └── dev-panel.js               ← 6-tab developer tools (Ctrl+Shift+D)
│   │
│   └── integrations/
│       ├── whatsapp-formatter.js      ← STUB: WhatsApp message formatting
│       └── power-bi-exporter.js       ← STUB: Power BI / VIPER CSV export
│
├── data/
│   ├── static/
│   │   ├── stations_within_5km.csv    ← generate via Dev Panel → Matrix tab
│   │   ├── stations_within_20km.csv
│   │   ├── stations_within_50km.csv
│   │   └── distance_matrix_summary.json
│   └── snapshots/                     ← daily price JSON snapshots (auto-downloaded)
│
└── docs/
    ├── ARCHITECTURE.md
    └── SWAP_GUIDES.md
```

## What's Next

| Feature | Module | Status |
|---------|--------|--------|
| React Native mobile app | All `modules/utils/`, `modules/data/`, `modules/analytics/` | Copy unchanged |
| Supabase real database | `modules/storage/` | 3-step swap (see SWAP_GUIDES.md) |
| B2B Fleet Portal | `modules/analytics/fleet-optimizer.js` | Stub ready |
| WhatsApp price alerts | `modules/integrations/whatsapp-formatter.js` | Stub ready |
| ML price prediction | `modules/analytics/price-predictor.js` | Needs 90 days of data |
| Power BI integration | `modules/integrations/power-bi-exporter.js` | Stub ready |
| OXXO Gas price alerts | Extend `anomaly-detector.js` | — |
| Fraud detection API | `fleet-optimizer.detectFuelCardAbuse()` | Stub ready |
