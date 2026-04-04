// MODULE: freshness
// PURPOSE: Classify how fresh a station's price data is

/**
 * @param {string|null} lastUpdated  ISO date string or null
 * @returns {'today'|'recent'|'ok'|'stale'|'unknown'}
 */
export function getFreshness(lastUpdated) {
  if (!lastUpdated) return 'unknown';
  const days = (Date.now() - new Date(lastUpdated).getTime()) / 86_400_000;
  if (days < 1)  return 'today';
  if (days < 7)  return 'recent';
  if (days < 80) return 'ok';
  return 'stale';
}

/**
 * @param {'today'|'recent'|'ok'|'stale'|'unknown'} status
 * @returns {{ label: string, color: string, icon: string }}
 */
export function freshnessLabel(status) {
  return {
    today:   { label: 'Verificado hoy',                    color: '#00FF88', icon: '✅' },
    recent:  { label: 'Reciente (< 7d)',                   color: '#4fc3f7', icon: '🔵' },
    ok:      { label: 'Datos oficiales',                   color: '#AAAAAA', icon: '📋' },
    stale:   { label: 'Datos desactualizados (80+ días)',  color: '#FF8C00', icon: '⚠️' },
    unknown: { label: 'Sin fecha',                         color: '#666680', icon: '❓' },
  }[status] ?? { label: 'Desconocido', color: '#666680', icon: '❓' };
}
