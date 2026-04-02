// MODULE: whatsapp-formatter
// PURPOSE: Format price data as WhatsApp-ready text messages
// DEPENDS ON: helpers
// NOTE: Pure text formatting — no Twilio/API required here.
//       Messages are ready to send via any WhatsApp API (Twilio, Meta Cloud, etc.)

import { formatPriceMXN, formatDistance } from '../utils/helpers.js';

const MAX_CHARS   = 1600; // WhatsApp message character limit
const MAPS_BASE   = 'https://maps.google.com/?q=';

/**
 * Format a list of nearby cheap stations as a WhatsApp message.
 *
 * @param {Merged[]} stations - sorted by price ascending (already filtered + nearby)
 * @param {{ lat: number, lng: number }} [userLoc]
 * @param {'regular'|'premium'|'diesel'} [fuelType='regular']
 * @returns {string} WhatsApp-ready message (≤1600 chars)
 */
export function formatNearbyMessage(stations, userLoc, fuelType = 'regular') {
  const withPrices = stations.filter(s => s.hasData && s.prices?.[fuelType] != null);
  if (withPrices.length === 0) return '⛽ No encontré gasolineras con datos de precio cerca de ti.';

  const top    = withPrices.slice(0, 5);
  const ftLabel = { regular: 'Regular', premium: 'Premium', diesel: 'Diesel' }[fuelType] ?? fuelType;
  const date   = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', timeZone: 'America/Mexico_City' });

  const lines = [
    `⛽ *${top.length} gasolineras más baratas — ${ftLabel}*`,
    `_Actualizado ${date}_`,
    '',
  ];

  for (let i = 0; i < top.length; i++) {
    const s       = top[i];
    const price   = formatPriceMXN(s.prices[fuelType]);
    const distStr = s.distanceKm != null ? ` (${formatDistance(s.distanceKm)})` : '';
    const mapsUrl = `${MAPS_BASE}${s.lat},${s.lng}`;
    const anomaly = s._isAnomaly ? ' ⚠️' : '';

    lines.push(`*${i + 1}. ${s.name}*${anomaly}`);
    lines.push(`   ${price}/L${distStr} — ${s.city}`);
    lines.push(`   📍 ${mapsUrl}`);
    lines.push('');
  }

  if (withPrices.length > 5) {
    lines.push(`_...y ${withPrices.length - 5} más. Consulta gasolina-inteligente.mx_`);
  }

  return _truncate(lines.join('\n'));
}

/**
 * Format a price change alert for a subscribed station.
 *
 * @param {Merged} station
 * @param {{ prev: number, current: number, fuelType: string }} change
 * @returns {string} WhatsApp alert message
 */
export function formatPriceAlert(station, change) {
  const { prev, current, fuelType = 'regular' } = change;
  const delta     = current - prev;
  const absDelta  = Math.abs(delta).toFixed(2);
  const direction = delta > 0 ? 'subió' : 'bajó';
  const arrow     = delta > 0 ? '⬆️' : '⬇️';
  const ftLabel   = { regular: 'Regular', premium: 'Premium', diesel: 'Diesel' }[fuelType] ?? fuelType;
  const mapsUrl   = `${MAPS_BASE}${station.lat},${station.lng}`;
  const date      = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', timeZone: 'America/Mexico_City' });

  const lines = [
    `🔔 *Alerta de precio* — ${station.name}`,
    `_${station.city}, ${station.state} • ${date}_`,
    '',
    `*${ftLabel}:* ${formatPriceMXN(prev)} → ${formatPriceMXN(current)} (${direction} $${absDelta}) ${arrow}`,
    '',
    `📍 ${mapsUrl}`,
  ];

  if (station._isAnomaly) {
    lines.splice(3, 0, '⚠️ _Este precio está fuera del rango habitual_');
  }

  return _truncate(lines.join('\n'));
}

/**
 * Format a weekly price summary digest.
 *
 * @param {Object} summary - buildNationalSummary() output
 * @param {{ city: string, avg: number }|null} [cheapestCity]
 * @param {{ city: string, avg: number }|null} [prevSummary] - last week's summary for delta
 * @returns {string} digest message
 */
export function formatWeeklySummary(summary, cheapestCity = null, prevSummary = null) {
  const week  = _weekNumber(new Date());
  const year  = new Date().getFullYear();

  const delta = (current, prev, key) => {
    if (!prev || prev[key]?.avg == null || current[key]?.avg == null) return '';
    const d    = current[key].avg - prev[key].avg;
    const sign = d > 0 ? '▲' : d < 0 ? '▼' : '=';
    return ` (${sign}$${Math.abs(d).toFixed(2)} vs semana pasada)`;
  };

  const lines = [
    `📊 *Resumen semanal de combustible*`,
    `_Semana ${week}, ${year}_`,
    '',
    `*Promedios nacionales:*`,
    `Regular:  ${formatPriceMXN(summary.regular?.avg)}${delta(summary, prevSummary, 'regular')}`,
    `Premium:  ${formatPriceMXN(summary.premium?.avg)}${delta(summary, prevSummary, 'premium')}`,
    `Diesel:   ${formatPriceMXN(summary.diesel?.avg)}${delta(summary, prevSummary, 'diesel')}`,
    '',
  ];

  if (cheapestCity) {
    lines.push(`🏆 *Ciudad más barata:* ${cheapestCity.city} — ${formatPriceMXN(cheapestCity.avg)}`);
    lines.push('');
  }

  lines.push(`_${summary.stationsWithData} de ${summary.totalStations} gasolineras con datos (${summary.coveragePct}%)_`);
  lines.push('');
  lines.push('⛽ gasolina-inteligente.mx');

  return _truncate(lines.join('\n'));
}

// ─── Internal ─────────────────────────────────────────────────────────────

function _truncate(msg) {
  if (msg.length <= MAX_CHARS) return msg;
  return msg.slice(0, MAX_CHARS - 4) + '…';
}

function _weekNumber(date) {
  const d   = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}
