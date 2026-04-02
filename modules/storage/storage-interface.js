// MODULE: storage-interface
// PURPOSE: Abstract contract for all persistence operations — never changes, drivers swap under it
// DEPENDS ON: nothing

/**
 * @typedef {Object} StorageDriver
 *
 * All methods return Promises. The active driver is set at app startup.
 * To swap to Supabase or SQLite, implement this interface in a new driver
 * file and pass it to setDriver(). See storage/README.md for guides.
 */

let _driver = null;

/**
 * Register the active storage driver
 * @param {StorageDriver} driver
 */
export function setDriver(driver) {
  _driver = driver;
}

/** @returns {StorageDriver} */
function d() {
  if (!_driver) throw new Error('No storage driver registered. Call setDriver() first.');
  return _driver;
}

// ─── Snapshots ────────────────────────────────────────────────────────────

/**
 * Save a daily price snapshot
 * @param {string} date - ISO date "2026-03-11"
 * @param {Snapshot} data
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export function saveSnapshot(date, data)    { return d().saveSnapshot(date, data); }

/**
 * Retrieve a snapshot by date
 * @param {string} date
 * @returns {Promise<Snapshot|null>}
 */
export function getSnapshot(date)           { return d().getSnapshot(date); }

/**
 * Get the most recently saved snapshot
 * @returns {Promise<Snapshot|null>}
 */
export function getLatestSnapshot()         { return d().getLatestSnapshot(); }

/**
 * List all available snapshot dates, newest first
 * @returns {Promise<string[]>}
 */
export function listSnapshots()             { return d().listSnapshots(); }

/**
 * Delete a snapshot by date
 * @param {string} date
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export function deleteSnapshot(date)        { return d().deleteSnapshot(date); }

// ─── Station Cache ─────────────────────────────────────────────────────────

/**
 * Persist station list (fetched from Places API)
 * @param {Station[]} data
 * @returns {Promise<{success: boolean}>}
 */
export function saveStations(data)          { return d().saveStations(data); }

/**
 * Retrieve persisted station list
 * @returns {Promise<Station[]|null>}
 */
export function getStations()               { return d().getStations(); }

// ─── Storage Management ────────────────────────────────────────────────────

/**
 * Get storage usage statistics
 * @returns {Promise<{snapshotCount: number, oldestSnapshot: string|null,
 *   newestSnapshot: string|null, totalSizeKB: number,
 *   usedPercent: number, estimatedDaysLeft: number}>}
 */
export function getStorageStats()           { return d().getStorageStats(); }

/**
 * Delete snapshots older than keepDays
 * @param {number} keepDays
 * @returns {Promise<{deleted: number}>}
 */
export function clearOldSnapshots(keepDays) { return d().clearOldSnapshots(keepDays); }

/**
 * Trigger browser download of a specific snapshot as JSON
 * @param {string} date
 * @returns {Promise<void>}
 */
export function exportSnapshot(date)        { return d().exportSnapshot(date); }

/**
 * Trigger browser download of all snapshots as a ZIP
 * @returns {Promise<void>}
 */
export function exportAllSnapshots()        { return d().exportAllSnapshots(); }

/**
 * Read a JSON file from disk and import it as a snapshot
 * @param {File} file - Browser File object
 * @returns {Promise<{success: boolean, date?: string, error?: string}>}
 */
export function importSnapshotFile(file)    { return d().importSnapshotFile(file); }

// ─── Generic Metadata ──────────────────────────────────────────────────────

/**
 * Store a key/value pair (serialized to JSON)
 * @param {string} key
 * @param {*} value
 * @returns {Promise<void>}
 */
export function saveMeta(key, value)        { return d().saveMeta(key, value); }

/**
 * Retrieve a stored key/value pair
 * @param {string} key
 * @returns {Promise<*>}
 */
export function getMeta(key)                { return d().getMeta(key); }
