# Storage Module — Swap Guide

The storage system uses a driver pattern. The interface (`storage-interface.js`) never changes.
The implementation (`local-driver.js`) can be swapped for any persistence backend.

## Current Driver: localStorage

Key format:
- `gi_snapshot_YYYY-MM-DD` — daily price snapshots
- `gi_stations` — cached station list from Places API
- `gi_meta_{key}` — generic metadata

**Limits:** ~5MB per origin. Auto-purges snapshots > 90 days at 80% full.

---

## Swap to Supabase (3 steps)

1. Create a `supabase-driver.js` implementing the same interface as `local-driver.js`.

   ```js
   // modules/storage/supabase-driver.js
   import { createClient } from '@supabase/supabase-js'
   const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

   export const supabaseDriver = {
     async saveSnapshot(date, data) {
       const { error } = await supabase.from('snapshots').upsert({ date, data })
       return { success: !error, error: error?.message }
     },
     // ... implement all interface methods
   }
   ```

2. In `app.js`, swap the driver registration:
   ```js
   // Before:
   import { localDriver } from './modules/storage/local-driver.js'
   setDriver(localDriver)

   // After:
   import { supabaseDriver } from './modules/storage/supabase-driver.js'
   setDriver(supabaseDriver)
   ```

3. Remove the localStorage import. Done.

---

## Swap to SQLite (Node.js / Electron)

Use `better-sqlite3` and implement the same interface. All snapshot data is plain JSON,
so SQLite stores it as JSON columns or serialized TEXT.

---

## Swap to IndexedDB (large datasets)

IndexedDB handles much larger data than localStorage. Use `idb` (tiny wrapper library).
The driver pattern is identical — just swap the implementation.

---

## Required Interface Methods

Every driver must implement all 13 methods from `storage-interface.js`:

| Method | Description |
|--------|-------------|
| `saveSnapshot(date, data)` | Persist a Snapshot |
| `getSnapshot(date)` | Retrieve by date |
| `getLatestSnapshot()` | Newest snapshot |
| `listSnapshots()` | All dates, newest first |
| `deleteSnapshot(date)` | Remove one snapshot |
| `saveStations(data)` | Cache station list |
| `getStations()` | Retrieve cached stations |
| `getStorageStats()` | Usage metrics |
| `clearOldSnapshots(keepDays)` | Purge old data |
| `exportSnapshot(date)` | Download as JSON |
| `exportAllSnapshots()` | Download all as ZIP |
| `importSnapshotFile(file)` | Import from file |
| `saveMeta(key, value)` | Key/value storage |
| `getMeta(key)` | Retrieve metadata |
