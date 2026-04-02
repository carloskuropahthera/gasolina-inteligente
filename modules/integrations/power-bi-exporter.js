// MODULE: power-bi-exporter
// PURPOSE: Export price and station data in Power BI-optimized CSV format
// DEPENDS ON: helpers, storage-interface

import { arrayToCSV, downloadCSV, todayISO } from '../utils/helpers.js';
import * as storage from '../storage/storage-interface.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('power-bi-exporter');

// Region mapping — aggregates states into 6 CRE administrative regions
const STATE_TO_REGION = {
  'Baja California':       'Noroeste',
  'Baja California Sur':   'Noroeste',
  'Sonora':                'Noroeste',
  'Sinaloa':               'Noroeste',
  'Chihuahua':             'Norte',
  'Coahuila':              'Norte',
  'Durango':               'Norte',
  'Zacatecas':             'Norte',
  'Nuevo León':            'Noreste',
  'Tamaulipas':            'Noreste',
  'San Luis Potosí':       'Centro-Norte',
  'Aguascalientes':        'Centro-Norte',
  'Jalisco':               'Centro-Occidente',
  'Colima':                'Centro-Occidente',
  'Nayarit':               'Centro-Occidente',
  'Michoacán':             'Centro-Occidente',
  'Guanajuato':            'Centro',
  'Querétaro':             'Centro',
  'Hidalgo':               'Centro',
  'Ciudad de México':      'Centro',
  'Estado de México':      'Centro',
  'Morelos':               'Centro',
  'Tlaxcala':              'Centro',
  'Puebla':                'Centro-Sur',
  'Guerrero':              'Centro-Sur',
  'Oaxaca':                'Sur-Sureste',
  'Chiapas':               'Sur-Sureste',
  'Veracruz':              'Sur-Sureste',
  'Tabasco':               'Sur-Sureste',
  'Campeche':              'Sur-Sureste',
  'Yucatán':               'Sur-Sureste',
  'Quintana Roo':          'Sur-Sureste',
};

const COLS_STATIONS = [
  'report_date','station_id','name','brand','address',
  'municipality','state','region','zip_code',
  'latitude','longitude','has_data',
  'regular_price','premium_price','diesel_price','data_source',
];

const COLS_HISTORY = [
  'date','station_id','name','brand','city','state','region',
  'fuel_type','price_mxn','national_avg','delta_from_avg','is_anomaly','anomaly_zscore',
];

const COLS_ANOMALY = [
  'detection_date','site_id','site_name','brand','city','state','region',
  'product','price','local_avg','z_score','deviation_pct',
  'direction','severity','neighbor_count',
];

/**
 * Export station metadata as a Power BI-ready CSV.
 * Columns are typed for Power BI auto-detection (no currency symbols, ISO dates).
 *
 * @param {Merged[]} data
 * @returns {void} triggers browser download
 */
export function exportStationsCSV(data) {
  const date = todayISO();
  const rows = data.map(s => ({
    report_date:    date,
    station_id:     s.id,
    name:           s.name,
    brand:          s.brand,
    address:        s.address,
    municipality:   s.city,
    state:          s.state,
    region:         STATE_TO_REGION[s.state] ?? 'Otro',
    zip_code:       s.zipCode ?? '',
    latitude:       s.lat ?? '',
    longitude:      s.lng ?? '',
    has_data:       s.hasData ? 1 : 0,
    regular_price:  s.prices?.regular  ?? '',
    premium_price:  s.prices?.premium  ?? '',
    diesel_price:   s.prices?.diesel   ?? '',
    data_source:    s.primary_source   ?? 'CRE',
  }));

  const csv      = arrayToCSV(rows, COLS_STATIONS);
  const filename = `gasolina_stations_${date}.csv`;
  downloadCSV(filename, csv);
  log.info(`Exported ${rows.length} stations → ${filename}`);
}

/**
 * Export full price history as a time-series CSV for Power BI trend visuals.
 * One row per station per day per fuel type (tall format — best for Power BI).
 *
 * @param {number} [days=90] - how many snapshots to include
 * @returns {Promise<void>} triggers browser download
 */
export async function exportPriceHistoryCSV(days = 90) {
  const dates   = await storage.listSnapshots();
  const recent  = dates.slice(0, days);

  if (recent.length === 0) {
    log.warn('exportPriceHistoryCSV: no snapshots found');
    return;
  }

  const rows = [];
  const FUEL_TYPES = ['regular', 'premium', 'diesel'];

  for (const date of recent) {
    const snap = await storage.getSnapshot(date);
    if (!snap?.stations) continue;

    const withData    = snap.stations.filter(s => s.hasData && s.prices);
    const anomalyIds  = new Set((snap.anomalies ?? []).map(a => a.stationId));
    const anomalyMap  = new Map((snap.anomalies ?? []).map(a => [a.stationId, a]));

    for (const ft of FUEL_TYPES) {
      const prices = withData.map(s => s.prices?.[ft]).filter(v => v != null);
      const natAvg = prices.length > 0
        ? Math.round(prices.reduce((s, v) => s + v, 0) / prices.length * 100) / 100
        : null;

      for (const s of withData) {
        const price = s.prices?.[ft];
        if (price == null) continue;

        const anomaly = anomalyMap.get(s.id);
        rows.push({
          date,
          station_id:     s.id,
          name:           s.name,
          brand:          s.brand,
          city:           s.city,
          state:          s.state,
          region:         STATE_TO_REGION[s.state] ?? 'Otro',
          fuel_type:      ft,
          price_mxn:      price,
          national_avg:   natAvg ?? '',
          delta_from_avg: natAvg != null ? Math.round((price - natAvg) * 100) / 100 : '',
          is_anomaly:     anomalyIds.has(s.id) ? 1 : 0,
          anomaly_zscore: anomaly?.zScore ?? '',
        });
      }
    }
  }

  const csv      = arrayToCSV(rows, COLS_HISTORY);
  const filename = `gasolina_history_${recent[recent.length - 1]}_to_${recent[0]}.csv`;
  downloadCSV(filename, csv);
  log.info(`Exported ${rows.length} history rows (${recent.length} days) → ${filename}`);
}

/**
 * Export anomaly detections in VIPER-compatible format.
 * Column names match the Valero VIPER system's anomaly export schema.
 *
 * @param {Anomaly[]} anomalies
 * @returns {void} triggers browser download
 */
export function exportAnomalyCSV(anomalies) {
  const date = todayISO();
  const rows = anomalies.map(a => ({
    detection_date: date,
    site_id:        a.stationId,
    site_name:      a.name,
    brand:          a.brand,
    city:           a.city,
    state:          a.state,
    region:         STATE_TO_REGION[a.state] ?? 'Otro',
    product:        a.fuelType,
    price:          a.price,
    local_avg:      a.localAvg,
    z_score:        a.zScore,
    deviation_pct:  a.localAvg > 0
                      ? Math.round(((a.price - a.localAvg) / a.localAvg) * 100 * 10) / 10
                      : '',
    direction:      a.direction,
    severity:       a.severity,
    neighbor_count: a.nearbyCount,
  }));

  const csv      = arrayToCSV(rows, COLS_ANOMALY);
  const filename = `gasolina_anomalies_${date}.csv`;
  downloadCSV(filename, csv);
  log.info(`Exported ${rows.length} anomalies → ${filename}`);
}
