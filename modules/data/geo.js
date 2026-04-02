// MODULE: geo
// PURPOSE: Geospatial calculations — haversine, manhattan, user location, nearby queries
// DEPENDS ON: matrix-loader, logger

import { getNearby as matrixGetNearby, isLoaded } from '../precompute/matrix-loader.js';
import { createLogger }                            from '../utils/logger.js';

const log = createLogger('geo');

export const MEXICO_CENTER = { lat: 23.6345, lng: -102.5528 };

export const CITY_CENTERS = {
  cdmx:         { lat: 19.4326, lng: -99.1332,  label: 'Ciudad de México' },
  guadalajara:  { lat: 20.6597, lng: -103.3496, label: 'Guadalajara' },
  monterrey:    { lat: 25.6866, lng: -100.3161, label: 'Monterrey' },
  tijuana:      { lat: 32.5027, lng: -117.0031, label: 'Tijuana' },
  puebla:       { lat: 19.0414, lng: -98.2063,  label: 'Puebla' },
};

/**
 * Haversine great-circle distance between two points
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} distance in km
 */
export function haversine(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat/2)**2 +
               Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/**
 * Manhattan road-distance proxy (no routing API needed)
 * Accounts for longitude compression at Mexico's latitude.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} approximate road distance in km
 */
export function manhattan(lat1, lng1, lat2, lng2) {
  const avgLat   = (lat1 + lat2) / 2;
  const kmPerLat = 111.32;
  const kmPerLng = 111.32 * Math.cos(avgLat * Math.PI / 180);
  return Math.abs(lat1 - lat2) * kmPerLat + Math.abs(lng1 - lng2) * kmPerLng;
}

/**
 * Add distanceKm and manhattanKm fields to each station based on user location
 * @param {Merged[]} stations
 * @param {number} userLat
 * @param {number} userLng
 * @returns {Merged[]}
 */
export function addDistances(stations, userLat, userLng) {
  return stations.map(s => ({
    ...s,
    distanceKm:  Math.round(haversine(userLat, userLng, s.lat, s.lng) * 100) / 100,
    manhattanKm: Math.round(manhattan(userLat, userLng, s.lat, s.lng) * 100) / 100,
  }));
}

/**
 * Get nearby stations, sorted by distance.
 * Uses pre-computed matrix if available; falls back to real-time haversine.
 * @param {Merged[]} stations
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusKm
 * @returns {Merged[]} sorted by distanceKm ascending
 */
export function getNearbyStations(stations, lat, lng, radiusKm) {
  if (isLoaded(5) && radiusKm <= 5) {
    // Matrix lookup is O(1) but we need the full Merged objects, not just IDs
    // Use haversine for accurate filtering since matrix isn't indexed by coord
    log.debug('getNearbyStations: using real-time (matrix indexed by stationId not coord)');
  }

  return stations
    .map(s => ({
      ...s,
      distanceKm:  Math.round(haversine(lat, lng, s.lat, s.lng) * 100) / 100,
      manhattanKm: Math.round(manhattan(lat, lng, s.lat, s.lng) * 100) / 100,
    }))
    .filter(s => s.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/**
 * Get neighbors for a specific station using the pre-computed matrix (O(1)).
 * Falls back to real-time haversine if matrix not loaded.
 * @param {string} stationId
 * @param {Merged[]} allStations - needed for fallback
 * @param {number} [radiusKm=10]
 * @returns {{ stationId: string, distanceKm: number, manhattanKm: number }[]}
 */
export function getNearbyById(stationId, allStations, radiusKm = 10) {
  // Try matrix first (use 5km, 20km, 50km depending on radius)
  const matrixRadius = radiusKm <= 5 ? 5 : radiusKm <= 20 ? 20 : 50;

  if (isLoaded(matrixRadius)) {
    const neighbors = matrixGetNearby(stationId, matrixRadius);
    return neighbors.filter(n => n.distanceKm <= radiusKm);
  }

  // Fallback: real-time haversine
  const target = allStations.find(s => s.id === stationId);
  if (!target) return [];

  return allStations
    .filter(s => s.id !== stationId)
    .map(s => ({
      stationId:   s.id,
      distanceKm:  Math.round(haversine(target.lat, target.lng, s.lat, s.lng) * 100) / 100,
      manhattanKm: Math.round(manhattan(target.lat, target.lng, s.lat, s.lng) * 100) / 100,
    }))
    .filter(n => n.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/**
 * Request the user's current GPS location.
 * Returns null if permission denied or times out.
 * @returns {Promise<{lat: number, lng: number}|null>}
 */
export function getUserLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      log.warn('Geolocation not supported');
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      log.warn('Geolocation timed out after 10s');
      resolve(null);
    }, 10000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        log.info('User location obtained', loc);
        resolve(loc);
      },
      (err) => {
        clearTimeout(timer);
        log.warn(`Geolocation denied/error: ${err.message}`);
        resolve(null);
      },
      { timeout: 10000, maximumAge: 60000 }
    );
  });
}
