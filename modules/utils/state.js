// MODULE: state
// PURPOSE: Observable global state container — no framework, no DOM
// DEPENDS ON: nothing

let _state = {
  stations: [],
  prices: [],
  mergedData: [],
  filteredData: [],
  selectedStation: null,
  userLocation: null,
  distanceMatrixLoaded: false,
  distanceMatrixStats: null,
  filters: {
    brands: [],           // empty = all
    states: [],
    cities: [],
    fuelType: 'regular',
    maxDistanceKm: null,
    priceRange: null,
    showAnomaliesOnly: false,
    showMissingDataOnly: false,
  },
  searchQuery: '',
  anomalies: [],
  lastFetch: null,
  scrapeHistory: [],
  isLoading: false,
  loadingMessage: '',
  mockMode: false,
  error: null,
};

// Subscriber registry: Map<id, { key: string|'*', fn: Function }>
let _nextId = 1;
const _subs = new Map();

// Deep-frozen copy to prevent external mutation
function freeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  return Object.freeze(
    Array.isArray(obj)
      ? obj.map(freeze)
      : Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, freeze(v)]))
  );
}

/**
 * Get a frozen snapshot of the current state
 * @returns {Readonly<typeof _state>}
 */
export function getState() {
  return freeze({ ..._state });
}

/**
 * Merge a partial update into state and notify subscribers
 * @param {Partial<typeof _state>} partial
 */
export function setState(partial) {
  const prev = { ..._state };
  _state = { ..._state, ...partial };

  // Determine which top-level keys changed
  const changed = Object.keys(partial).filter(k => partial[k] !== prev[k]);

  for (const [, sub] of _subs) {
    if (sub.key === '*') {
      sub.fn(getState(), changed);
    } else if (changed.includes(sub.key)) {
      sub.fn(_state[sub.key], sub.key);
    }
  }
}

/**
 * Subscribe to changes on a specific top-level state key
 * @param {string} key - state key to watch
 * @param {Function} fn - called with (newValue, key) on change
 * @returns {number} subscription id (use to unsubscribe)
 */
export function subscribe(key, fn) {
  const id = _nextId++;
  _subs.set(id, { key, fn });
  return id;
}

/**
 * Subscribe to ALL state changes
 * @param {Function} fn - called with (fullState, changedKeys[]) on any change
 * @returns {number} subscription id
 */
export function subscribeAll(fn) {
  const id = _nextId++;
  _subs.set(id, { key: '*', fn });
  return id;
}

/**
 * Remove a subscription by id
 * @param {number} id
 */
export function unsubscribe(id) {
  _subs.delete(id);
}

/**
 * Reset state to defaults (useful for testing)
 */
export function resetState() {
  _state = {
    stations: [],
    prices: [],
    mergedData: [],
    filteredData: [],
    selectedStation: null,
    userLocation: null,
    distanceMatrixLoaded: false,
    distanceMatrixStats: null,
    filters: {
      brands: [],
      states: [],
      cities: [],
      fuelType: 'regular',
      maxDistanceKm: null,
      priceRange: null,
      showAnomaliesOnly: false,
      showMissingDataOnly: false,
    },
    searchQuery: '',
    anomalies: [],
    lastFetch: null,
    scrapeHistory: [],
    isLoading: false,
    loadingMessage: '',
    mockMode: false,
    error: null,
  };
}
