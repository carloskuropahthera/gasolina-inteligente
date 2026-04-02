// MODULE: fleet-optimizer
// PURPOSE: B2B fleet fuel optimization — route planning, monthly reports, abuse detection
// DEPENDS ON: savings-calculator, prices, geo
// STATUS: Phase 2 — route optimization requires real GPS data; abuse detection is live

import { getNearbyStations } from '../data/geo.js';
import { getCheapest }       from '../data/prices.js';
import { createLogger }      from '../utils/logger.js';

const log = createLogger('fleet-optimizer');

/**
 * Find the cheapest available fuel stops near each waypoint along a route.
 * Returns ranked options per waypoint; full route optimization requires
 * a routing API and is planned for Fleet Portal v1 (Q3 2026).
 *
 * @param {Object} route - { waypoints: [{lat, lng, label?}] }
 * @param {Merged[]} stations - full station dataset
 * @param {'regular'|'premium'|'diesel'} [fuelType='diesel']
 * @param {number} [radiusKm=10]
 * @returns {{ waypoints: Array<{label, lat, lng, cheapest: Merged|null, nearby: Merged[]}> }}
 */
export function findFuelStopsAlongRoute(route, stations, fuelType = 'diesel', radiusKm = 10) {
  if (!route?.waypoints?.length) return { waypoints: [] };

  const result = route.waypoints.map((wp, i) => {
    const nearby   = getNearbyStations(stations, wp.lat, wp.lng, radiusKm)
      .filter(s => s.hasData && s.prices?.[fuelType] != null)
      .sort((a, b) => a.prices[fuelType] - b.prices[fuelType]);

    const cheapest = nearby[0] ?? null;

    log.debug(`Waypoint ${i + 1}: ${nearby.length} stations within ${radiusKm}km`);
    return { label: wp.label ?? `Waypoint ${i + 1}`, lat: wp.lat, lng: wp.lng, cheapest, nearby: nearby.slice(0, 5) };
  });

  return { waypoints: result, fuelType, radiusKm };
}

/**
 * Detect potential fuel card abuse by comparing transaction prices to CRE-reported prices.
 * Flags transactions where the charged price significantly exceeds the CRE price for that station.
 *
 * @param {Object[]} transactions - [{ vehicleId, stationId, date, chargedPrice, liters }]
 * @param {Merged[]} stations - CRE station data
 * @param {number} [threshold=1.5] - MXN difference to flag as suspicious
 * @returns {Object[]} flagged transactions with risk scores
 */
export function detectFuelCardAbuse(transactions, stations, threshold = 1.5) {
  const stationMap = new Map(stations.map(s => [s.id, s]));
  const flagged    = [];

  for (const tx of transactions) {
    const station = stationMap.get(tx.stationId);
    if (!station?.hasData) continue;

    // Use whichever fuel type was transacted; fall back to regular
    const fuelType  = tx.fuelType ?? 'regular';
    const crePrice  = station.prices?.[fuelType];
    if (crePrice == null) continue;

    const delta = tx.chargedPrice - crePrice;
    if (delta > threshold) {
      const riskScore = Math.min(1.0, delta / (threshold * 3));
      flagged.push({
        ...tx,
        crePrice,
        delta:     Math.round(delta * 100) / 100,
        riskScore: Math.round(riskScore * 100) / 100,
        severity:  riskScore > 0.66 ? 'high' : riskScore > 0.33 ? 'medium' : 'low',
        totalOvercharge: Math.round(delta * (tx.liters ?? 0) * 100) / 100,
      });
    }
  }

  flagged.sort((a, b) => b.riskScore - a.riskScore);
  log.info(`Abuse detection: ${flagged.length} flagged of ${transactions.length} transactions`);
  return flagged;
}

/**
 * Summarize fleet fuel spend for a set of transactions.
 * Full monthly report generation (Power BI format) is implemented in power-bi-exporter.js.
 *
 * @param {Object[]} transactions - [{ vehicleId, stationId, chargedPrice, liters, date }]
 * @param {Merged[]} stations
 * @returns {Object} summary by vehicle and by station
 */
export function summarizeFleetSpend(transactions, stations) {
  const stationMap = new Map(stations.map(s => [s.id, s]));
  const byVehicle  = new Map();
  const byStation  = new Map();
  let totalPesos   = 0;
  let totalLiters  = 0;

  for (const tx of transactions) {
    const pesos  = (tx.chargedPrice ?? 0) * (tx.liters ?? 0);
    totalPesos  += pesos;
    totalLiters += tx.liters ?? 0;

    // By vehicle
    if (!byVehicle.has(tx.vehicleId)) byVehicle.set(tx.vehicleId, { pesos: 0, liters: 0, txCount: 0 });
    const veh = byVehicle.get(tx.vehicleId);
    veh.pesos   += pesos;
    veh.liters  += tx.liters ?? 0;
    veh.txCount += 1;

    // By station
    const st = stationMap.get(tx.stationId);
    const key = tx.stationId;
    if (!byStation.has(key)) byStation.set(key, { name: st?.name ?? tx.stationId, pesos: 0, liters: 0, txCount: 0 });
    const stEntry = byStation.get(key);
    stEntry.pesos   += pesos;
    stEntry.liters  += tx.liters ?? 0;
    stEntry.txCount += 1;
  }

  return {
    totalPesos:   Math.round(totalPesos * 100) / 100,
    totalLiters:  Math.round(totalLiters * 100) / 100,
    avgPricePerL: totalLiters > 0 ? Math.round(totalPesos / totalLiters * 100) / 100 : null,
    txCount:      transactions.length,
    byVehicle:    [...byVehicle.entries()].map(([id, v]) => ({ vehicleId: id, ...v }))
                    .sort((a, b) => b.pesos - a.pesos),
    byStation:    [...byStation.entries()].map(([id, s]) => ({ stationId: id, ...s }))
                    .sort((a, b) => b.pesos - a.pesos),
  };
}
