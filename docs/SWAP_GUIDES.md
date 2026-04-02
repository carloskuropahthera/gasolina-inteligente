# Swap Guides — Gasolina Inteligente

Step-by-step guides for every planned upgrade path.

---

## 1. Swap localStorage for Supabase

**Time estimate:** ~4 hours
**File to create:** `modules/storage/supabase-driver.js`

### Step 1 — Create the Supabase tables

```sql
CREATE TABLE snapshots (
  date DATE PRIMARY KEY,
  data JSONB NOT NULL,
  station_count INTEGER,
  fetched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE stations_cache (
  id TEXT PRIMARY KEY DEFAULT 'latest',
  data JSONB NOT NULL,
  saved_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Step 2 — Implement the driver

```javascript
// modules/storage/supabase-driver.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const supabase = createClient(YOUR_SUPABASE_URL, YOUR_ANON_KEY)

export const supabaseDriver = {
  async saveSnapshot(date, data) {
    const { error } = await supabase.from('snapshots')
      .upsert({ date, data, station_count: data.stationCount, fetched_at: data.fetchedAt })
    return { success: !error, error: error?.message }
  },
  async getSnapshot(date) {
    const { data, error } = await supabase.from('snapshots')
      .select('data').eq('date', date).single()
    return data?.data ?? null
  },
  async getLatestSnapshot() {
    const { data } = await supabase.from('snapshots')
      .select('data').order('date', { ascending: false }).limit(1).single()
    return data?.data ?? null
  },
  async listSnapshots() {
    const { data } = await supabase.from('snapshots')
      .select('date').order('date', { ascending: false })
    return data?.map(r => r.date) ?? []
  },
  async deleteSnapshot(date) {
    const { error } = await supabase.from('snapshots').delete().eq('date', date)
    return { success: !error }
  },
  async saveStations(stations) {
    const { error } = await supabase.from('stations_cache')
      .upsert({ id: 'latest', data: stations, saved_at: new Date().toISOString() })
    return { success: !error }
  },
  async getStations() {
    const { data } = await supabase.from('stations_cache')
      .select('data').eq('id', 'latest').single()
    return data?.data ?? null
  },
  async getStorageStats() {
    const { data } = await supabase.from('snapshots')
      .select('date').order('date', { ascending: false })
    const dates = data?.map(r => r.date) ?? []
    return {
      snapshotCount: dates.length,
      oldestSnapshot: dates.at(-1) ?? null,
      newestSnapshot: dates[0] ?? null,
      totalSizeKB: 0,      // query pg_size for accurate measurement
      usedPercent: 0,
      estimatedDaysLeft: 9999,
    }
  },
  async clearOldSnapshots(keepDays) {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - keepDays)
    const { data, error } = await supabase.from('snapshots')
      .delete().lt('date', cutoff.toISOString().slice(0,10)).select('date')
    return { deleted: data?.length ?? 0 }
  },
  async exportSnapshot(date) {
    const snap = await this.getSnapshot(date)
    if (!snap) throw new Error(`No snapshot for ${date}`)
    const { downloadJSON } = await import('../utils/helpers.js')
    downloadJSON(`prices_${date}.json`, snap)
  },
  async exportAllSnapshots() {
    const dates = await this.listSnapshots()
    const files = []
    for (const date of dates) {
      const snap = await this.getSnapshot(date)
      if (snap) files.push({ name: `prices_${date}.json`, content: JSON.stringify(snap, null, 2) })
    }
    const { downloadZIP, todayISO } = await import('../utils/helpers.js')
    await downloadZIP(`gasolina_snapshots_${todayISO()}.zip`, files)
  },
  async importSnapshotFile(file) {
    return new Promise(resolve => {
      const reader = new FileReader()
      reader.onload = async e => {
        try {
          const data = JSON.parse(e.target.result)
          if (!data.date) return resolve({ success: false, error: 'Missing date field' })
          await this.saveSnapshot(data.date, data)
          resolve({ success: true, date: data.date })
        } catch (err) {
          resolve({ success: false, error: err.message })
        }
      }
      reader.readAsText(file)
    })
  },
  async saveMeta(key, value) {
    await supabase.from('app_meta')
      .upsert({ key, value, updated_at: new Date().toISOString() })
  },
  async getMeta(key) {
    const { data } = await supabase.from('app_meta')
      .select('value').eq('key', key).single()
    return data?.value ?? null
  },
}
```

### Step 3 — Register the new driver in app.js

```javascript
// In app.js, replace:
import { localDriver } from './modules/storage/local-driver.js'
setDriver(localDriver)

// With:
import { supabaseDriver } from './modules/storage/supabase-driver.js'
setDriver(supabaseDriver)
```

Done. All 13 interface methods are implemented. The rest of the app is unchanged.

---

## 2. Add React Native (Mobile App)

**Time estimate:** 1–2 days
**Files that copy unchanged (zero modification):**

```
modules/utils/logger.js          ← createLogger works in RN
modules/utils/helpers.js         ← pure functions, no DOM
modules/utils/state.js           ← swap subscribe for useState/useReducer
modules/api/cache.js             ← pure in-memory
modules/api/cre-client.js        ← fetch() works in RN
modules/storage/storage-interface.js  ← interface never changes
modules/precompute/distance-generator.js  ← no DOM
modules/precompute/matrix-loader.js       ← swap fetch() for RNFS
modules/scraper/daily-scraper.js  ← swap setInterval for BackgroundFetch
modules/analytics/anomaly-detector.js  ← pure math
modules/analytics/price-trends.js      ← pure math
modules/analytics/savings-calculator.js ← pure math
modules/data/geo.js              ← replace getUserLocation with RN Geolocation
modules/data/stations.js         ← pure functions
modules/data/prices.js           ← pure functions
```

**Files that need React Native rewrites (UI only):**
```
modules/ui/map.js                ← use react-native-maps
modules/ui/price-list.js         ← use FlatList
modules/ui/station-card.js       ← use BottomSheet
modules/ui/filters.js            ← use Modal + Switch
modules/ui/anomaly-panel.js      ← use Modal
modules/ui/scraper-panel.js      ← use Modal
modules/ui/search.js             ← use TextInput + FlatList
modules/ui/dev-panel.js          ← use __DEV__ Modal
```

**state.js swap:** Replace `setState`/`subscribe` with a Zustand store or React Context. The shape is identical — just change the implementation.

---

## 3. Add a New Analytics Module

Template for adding analytics (e.g., a competitor price tracker):

```javascript
// modules/analytics/competitor-tracker.js
// MODULE: competitor-tracker
// PURPOSE: Track price gaps between brands in the same area
// DEPENDS ON: geo, prices, logger

import { getNearbyById }  from '../data/geo.js'
import { getStats }       from '../data/prices.js'
import { createLogger }   from '../utils/logger.js'

const log = createLogger('competitor-tracker')

/**
 * @param {Merged[]} mergedData
 * @param {string} brand - e.g. "PEMEX"
 * @param {'regular'|'premium'|'diesel'} fuelType
 * @returns {Array<{station, gapVsAvg, gapVsCheapestNearby}>}
 */
export function trackBrandGaps(mergedData, brand, fuelType) {
  // implement here
}
```

Then in `app.js`, call it after `detectAnomalies()` and add results to state.

---

## 4. Add a New UI Panel

Template for adding a panel (e.g., a price trends panel):

```javascript
// modules/ui/trends-panel.js
// MODULE: trends-panel
// PURPOSE: Historical price trend charts
// DEPENDS ON: price-trends, state, logger

import { getDailyNationalAvg } from '../analytics/price-trends.js'
import { getState }            from '../utils/state.js'

let _panel = null

export function initTrendsPanel(panelId) {
  _panel = document.getElementById(panelId)
}

export function toggleTrendsPanel() {
  _panel?.classList.toggle('open')
  if (_panel?.classList.contains('open')) renderPanel()
}

async function renderPanel() {
  const data = await getDailyNationalAvg(30)
  _panel.innerHTML = `<div class="panel-inner"><!-- Chart.js chart here --></div>`
}
```

In `index.html`: add `<div id="trends-panel" class="slide-panel"></div>`
In `app.js`: import and call `initTrendsPanel('trends-panel')`
In header: add a button that calls `toggleTrendsPanel()`

---

## 5. Export Data to Power BI

The distance matrix CSVs are already Power BI-compatible:
```
ID_A, ID_B, CRE_ID_A, CRE_ID_B, haversine_km, manhattan_approx_km
```

For price history, use the **Export CSV** button in the price list panel. The format includes:
```
id, name, brand, address, city, state, zipCode, lat, lng,
regular, premium, diesel, updatedAt, distanceKm, hasData
```

For VIPER-compatible anomaly export: use the **Export CSV** button in the anomaly panel.

For full historical export: Dev Panel → Storage → Export All Snapshots → ZIP of daily JSONs.

Power BI import steps:
1. `Get Data → Text/CSV`
2. Select the exported file
3. Set `date` column type to `Date`, price columns to `Decimal Number`
4. Use `lat`/`lng` columns with the built-in Map visual (ArcGIS or Bing)

---

## 6. Add Real-Time Price Alerts (Webhook)

When the daily scraper detects an anomaly, POST to a webhook:

```javascript
// In daily-scraper.js, after detectAnomalies():
if (anomalies.some(a => a.severity === 'severe')) {
  await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'severe_anomaly', anomalies, date: today })
  })
}
```

Connect to:
- **Slack**: Incoming Webhooks
- **WhatsApp**: Twilio or Meta Cloud API (see `whatsapp-formatter.js`)
- **Email**: Resend or SendGrid
- **PagerDuty**: for fleet operations 24/7 alerts
