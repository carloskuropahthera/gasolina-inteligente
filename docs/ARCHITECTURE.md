# Architecture — Gasolina Inteligente Beta v1

## Module Dependency Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         index.html + app.js                         │
│                    (startup sequence, module wiring)                │
└───────────┬──────────────────────────────────────────┬─────────────┘
            │                                          │
    ┌───────▼────────┐                       ┌────────▼────────┐
    │   UI Modules   │                       │  Core Modules   │
    │  map.js        │                       │  cre-client.js  │
    │  price-list.js │◄──── state.js ───────►│  daily-scraper  │
    │  station-card  │                       │  anomaly-detect │
    │  filters.js    │                       │  price-trends   │
    │  anomaly-panel │                       │  savings-calc   │
    │  scraper-panel │                       └────────┬────────┘
    │  dev-panel.js  │                                │
    └───────┬────────┘                       ┌────────▼────────┐
            │                               │  Data Modules   │
            │                               │  stations.js    │
            └───────────────────────────────►  prices.js      │
                                            │  geo.js         │
                                            └────────┬────────┘
                                                     │
                                            ┌────────▼────────┐
                                            │  Infrastructure │
                                            │  fetch-strategy │
                                            │  cache.js       │
                                            │  storage/       │
                                            │  matrix-loader  │
                                            │  logger.js      │
                                            │  helpers.js     │
                                            │  state.js       │
                                            └─────────────────┘
```

## Data Flow

```
CRE API (Places)         CRE API (Prices)
      │                        │
      ▼                        ▼
fetch-strategy.js ──── CORS proxy waterfall
      │                        │
      ▼                        ▼
cre-client.js ──── normalize ──── merge by stationId
      │
      ▼
 Merged[] ──── addDistances(userLoc) ──── matrix-loader.getNearby()
      │
      ├──── detectAnomalies() ──── Anomaly[]
      │          │
      │          └──── mark _isAnomaly on Merged
      │
      ├──── setState({ mergedData, anomalies })
      │
      ├──── filters.js ──── filterStations() ──── setState({ filteredData })
      │
      ├──► map.js ──── renderStations() ──── Leaflet markers
      │
      └──► price-list.js ──── renderPriceList() ──── HTML table
                │
                └──► station-card.js ──── getPriceHistory() ──── Chart.js
```

## Data Shapes Reference

```javascript
// Station — from Places API, normalized
{
  id:       "MX001",           // internal ID
  creId:    "CRE-01001",       // CRE government ID
  name:     "Gasolinera Polanco Norte",
  brand:    "PEMEX",
  address:  "Av. Presidente Masaryk 123",
  city:     "Miguel Hidalgo",
  state:    "Ciudad de México",
  zipCode:  "11560",
  lat:      19.4326,
  lng:      -99.1967
}

// Price — from Prices API, normalized
{
  stationId: "MX001",
  regular:   22.70,            // MXN per liter, float
  premium:   24.80,
  diesel:    23.10,
  updatedAt: "2026-03-16T06:00:00.000Z"  // ISO 8601
}

// Merged — Station + Price, ready for UI
{
  ...Station,
  prices: Price | null,
  hasData: true,               // false if no price reported
  distanceKm: 2.3,             // added if userLocation known
  manhattanKm: 2.8,
  _isAnomaly: false            // tagged by anomaly-detector
}

// Snapshot — saved by daily-scraper, stored via storage-interface
{
  date:         "2026-03-16",
  fetchedAt:    "2026-03-16T06:42:31.000Z",
  stationCount: 12847,
  source:       "api",         // "api" | "mock"
  stations:     Merged[]
}

// Anomaly — output of anomaly-detector
{
  stationId:   "MX007",
  name:        "PEMEX Condesa Central",
  brand:       "PEMEX",
  city:        "Cuauhtémoc",
  state:       "Ciudad de México",
  fuelType:    "premium",
  price:       28.30,
  localAvg:    24.75,
  zScore:      3.4,
  direction:   "high",         // "high" | "low"
  nearbyCount: 8,
  severity:    "severe"        // "mild" | "moderate" | "severe"
}
```

## Key Design Decisions

### 1. No Build Step
`index.html` + ES modules — open in browser. Zero npm, zero webpack. This lowers the barrier for the ops team to use the tool and makes deployment trivial (any static file host).

### 2. Driver Pattern for Storage
`storage-interface.js` is a stable contract. `local-driver.js` is the current implementation. Swapping to Supabase requires only changing 2 lines in `app.js`. The interface never changes.

### 3. Pre-computed Distance Matrix
Mexico has ~12,000 CRE-registered stations. Real-time haversine between all pairs = 144M calculations per query. The grid-cell spatial index reduces this to ~500K on first run, then zero on subsequent queries (O(1) matrix lookup).

### 4. Logic/UI Separation (Mobile-Ready Rule)
All modules in `utils/`, `api/`, `storage/`, `scraper/`, `analytics/`, `data/` have zero DOM references. They work identically in React Native. The UI modules in `ui/` are the only browser-specific code.

### 5. Observable State (No Framework)
`state.js` is a 60-line observable container. `subscribe(key, fn)` watches a single state key. `subscribeAll(fn)` watches everything. No Redux, no Context, no Vuex. Copies directly to React Native with `useState` as a drop-in replacement.

## Startup Sequence (app.js)

```
1.  setDriver(localDriver)           storage ready
2.  initMap, initPriceList, initFilters, etc.   DOM shells ready
3.  wireHeaderButtons, wireStateSubscriptions   event wiring
4.  fetchAll(mockMode)               load stations + prices
5.  detectAnomalies(mergedData)      tag _isAnomaly on stations
6.  setState({ mergedData, anomalies })
7.  loadMatrix(5km)                  O(1) nearby lookups if CSV exists
8.  getUserLocation()                non-blocking, re-merges with distances
9.  parseURLHash()                   restore filter state from URL
10. applyFilters()                   set filteredData → triggers map render
11. initScraper()                    start 30-min scheduler
12. checkScrapeStatus()              prompt if today not yet scraped
```
