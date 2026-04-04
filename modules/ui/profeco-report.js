// MODULE: profeco-report
// PURPOSE: Pre-fill and open Profeco REPECO complaint form for a station

const REPECO_URL = 'https://repeco.profeco.gob.mx/';

/**
 * Open Profeco REPECO and copy station info to clipboard for the user to paste.
 * @param {Object} station
 * @param {string} complaintType  'precio_diferente'|'litros_cortos'|'mala_atencion'
 * @returns {Promise<string>} the text copied to clipboard
 */
export async function openProfecoReport(station, complaintType = 'precio_diferente') {
  const labels = {
    precio_diferente: 'Precio diferente al anunciado',
    litros_cortos:    'Litros cortos / medida incorrecta',
    mala_atencion:    'Mala atención al cliente',
  };

  const text = [
    `Estación: ${station.name}`,
    `Marca: ${station.brand}`,
    `Dirección: ${station.address}, ${station.city}, ${station.state}`,
    `CRE ID: ${station.cre_id ?? station.id}`,
    `Motivo: ${labels[complaintType] ?? complaintType}`,
  ].join('\n');

  try {
    await navigator.clipboard.writeText(text);
  } catch { /* clipboard denied — data still shown in toast */ }

  window.open(REPECO_URL, '_blank', 'noopener');
  return text;
}

/**
 * Render the complaint button HTML for injection into the station card.
 * @param {string} stationId
 * @returns {string}
 */
export function renderReportButton(stationId) {
  return `
    <div class="profeco-section">
      <div class="profeco-label">¿Precio incorrecto?</div>
      <div class="profeco-btns">
        <button class="profeco-btn" data-station-id="${stationId}" data-type="precio_diferente">💸 Precio diferente</button>
        <button class="profeco-btn" data-station-id="${stationId}" data-type="litros_cortos">📏 Litros cortos</button>
      </div>
      <div class="profeco-note">Abre Profeco REPECO y copia los datos de la estación al portapapeles.</div>
    </div>`;
}
