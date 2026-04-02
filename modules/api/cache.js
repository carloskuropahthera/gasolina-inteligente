// MODULE: cache
// PURPOSE: In-memory TTL cache with hit/miss stats for API responses
// DEPENDS ON: nothing

/**
 * Create a TTL cache instance
 * @param {number} ttlMinutes - Default TTL in minutes
 * @returns {{ set, get, has, invalidate, clear, getStats }}
 */
export function createCache(ttlMinutes = 60) {
  const store = new Map(); // key → { value, expiresAt, createdAt, sizeBytes }
  let hits   = 0;
  let misses = 0;

  function estimateSize(value) {
    try {
      return JSON.stringify(value).length * 2; // rough bytes (UTF-16)
    } catch {
      return 0;
    }
  }

  /**
   * Store a value in the cache
   * @param {string} key
   * @param {*} value
   * @param {number} [ttlOverrideMinutes] - Override default TTL
   */
  function set(key, value, ttlOverrideMinutes) {
    const ttl = (ttlOverrideMinutes ?? ttlMinutes) * 60 * 1000;
    store.set(key, {
      value,
      expiresAt: Date.now() + ttl,
      createdAt: Date.now(),
      sizeBytes: estimateSize(value),
    });
  }

  /**
   * Retrieve a value if it exists and hasn't expired
   * @param {string} key
   * @returns {*} value or undefined
   */
  function get(key) {
    const entry = store.get(key);
    if (!entry) { misses++; return undefined; }
    if (Date.now() > entry.expiresAt) {
      store.delete(key);
      misses++;
      return undefined;
    }
    hits++;
    return entry.value;
  }

  /**
   * Check if a valid (non-expired) entry exists
   * @param {string} key
   * @returns {boolean}
   */
  function has(key) {
    const entry = store.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) { store.delete(key); return false; }
    return true;
  }

  /**
   * Remove a specific key
   * @param {string} key
   */
  function invalidate(key) {
    store.delete(key);
  }

  /** Remove all entries */
  function clear() {
    store.clear();
    hits   = 0;
    misses = 0;
  }

  /**
   * Get cache statistics
   * @returns {{ hits: number, misses: number, hitRate: number, entries: number, sizeKB: number }}
   */
  function getStats() {
    // Purge expired entries before reporting
    const now = Date.now();
    for (const [k, v] of store) {
      if (now > v.expiresAt) store.delete(k);
    }
    const total   = hits + misses;
    const sizeKB  = [...store.values()].reduce((s, e) => s + e.sizeBytes, 0) / 1024;
    return {
      hits,
      misses,
      hitRate: total === 0 ? 0 : Math.round((hits / total) * 100),
      entries: store.size,
      sizeKB:  Math.round(sizeKB * 10) / 10,
    };
  }

  return { set, get, has, invalidate, clear, getStats };
}
