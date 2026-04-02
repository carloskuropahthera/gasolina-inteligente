// MODULE: station-card
// PURPOSE: Station detail drawer/side panel with price history charts and savings
// DEPENDS ON: prices, geo, savings-calculator, state, helpers, logger

import { getPriceHistory, getStats, getCheapest } from '../data/prices.js';
import { getNearbyById }            from '../data/geo.js';
import { getBrandColor }            from '../data/stations.js';
import { calculateFillSavings }     from '../analytics/savings-calculator.js';
import { getState, subscribe, setState } from '../utils/state.js';
import { formatPriceMXN, formatDistance, esc } from '../utils/helpers.js';
import { createLogger }             from '../utils/logger.js';

const log = createLogger('station-card');

let _drawer  = null;
let _chart   = null;

/**
 * Initialize the station card drawer
 * @param {string} drawerId - container element id
 */
export function initStationCard(drawerId) {
  _drawer = document.getElementById(drawerId);
  if (!_drawer) { log.error(`Drawer #${drawerId} not found`); return; }

  subscribe('selectedStation', async (station) => {
    if (station) await openCard(station);
    else closeCard();
  });

  // Close on backdrop click
  _drawer.addEventListener('click', (e) => {
    if (e.target === _drawer) closeCard();
  });

  log.info('Station card initialized');
}

async function openCard(station) {
  if (!_drawer) return;

  const state   = getState();
  const ft      = state.filters.fuelType ?? 'regular';
  const allData = state.mergedData;

  // Load price history
  const history = await getPriceHistory(station.id, ft, 30);

  // Get nearby stations
  const nearbyRefs = getNearbyById(station.id, allData, 5);
  const nearby     = nearbyRefs
    .map(ref => allData.find(s => s.id === ref.stationId))
    .filter(Boolean)
    .slice(0, 5);

  // National stats for comparison
  const stats = getStats(allData, ft);

  // Anomaly info
  const anomaly = state.anomalies.find(a => a.stationId === station.id);

  // Savings calculation
  const cheapestNearby = getCheapest(nearby.filter(s => s.hasData), ft, 1)[0];
  const mostExpNearby  = [...nearby].filter(s => s.hasData && s.prices?.[ft] != null)
                         .sort((a, b) => b.prices[ft] - a.prices[ft])[0];

  _drawer.classList.add('open');
  _drawer.innerHTML = buildCardHTML(station, ft, history, nearby, stats, anomaly, cheapestNearby, mostExpNearby, allData);

  attachCardListeners(station);
  if (history.length >= 2) {
    renderChart(station, ft, history);
  }

  log.info(`Station card opened: ${station.name}`);
}

function closeCard() {
  _drawer?.classList.remove('open');
  if (_chart) { _chart.destroy(); _chart = null; }
  setState({ selectedStation: null });
}

// ─── HTML Builder ─────────────────────────────────────────────────────────

function buildCardHTML(station, ft, history, nearby, stats, anomaly, cheapestNearby, mostExpNearby, allData) {
  const p     = station.prices;
  const color = getBrandColor(station.brand);
  const mapsUrl = `https://www.google.com/maps?q=${station.lat},${station.lng}`;

  const priceRow = (label, val, prevVal) => {
    if (val == null) return `<tr><td>${label}</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`;
    const change = prevVal != null ? val - prevVal : null;
    const vsLocal  = stats.avg ? (val - stats.avg).toFixed(2) : '—';
    const vsLocal$ = stats.avg ? (val > stats.avg ? `▲$${Math.abs(val-stats.avg).toFixed(2)}` : `▼$${Math.abs(val-stats.avg).toFixed(2)}`) : '—';
    const chg      = change == null ? '—' : change === 0 ? '—' : change > 0 ? `▲$${Math.abs(change).toFixed(2)}` : `▼$${Math.abs(change).toFixed(2)}`;
    return `
      <tr>
        <td>${label}</td>
        <td>${formatPriceMXN(val)}</td>
        <td>${prevVal != null ? formatPriceMXN(prevVal) : '—'}</td>
        <td class="${change != null && change > 0 ? 'price-hi' : change != null && change < 0 ? 'price-lo' : ''}">${chg}</td>
        <td class="${stats.avg != null ? (val > stats.avg ? 'price-hi' : 'price-lo') : ''}">${vsLocal$}</td>
      </tr>`;
  };

  const anomalyBanner = anomaly ? `
    <div class="anomaly-banner">
      ⚠️ This station's <strong>${anomaly.fuelType}</strong> price is
      <strong>${Math.abs(anomaly.zScore).toFixed(1)} standard deviations</strong>
      ${anomaly.direction === 'high' ? 'above' : 'below'} its
      10km neighborhood average of <strong>${formatPriceMXN(anomaly.localAvg)}</strong>
      <span class="severity-badge severity-${anomaly.severity}">${anomaly.severity.toUpperCase()}</span>
    </div>` : '';

  const savingsBanner = mostExpNearby && p?.[ft] != null
    ? (() => {
        const savings = calculateFillSavings(p[ft], mostExpNearby.prices[ft], 40);
        return savings.savedPesos > 0.5
          ? `<div class="savings-banner">
               💰 Filling 40L here saves
               <strong>${formatPriceMXN(savings.savedPesos)}</strong>
               vs the most expensive nearby option
             </div>`
          : '';
      })()
    : '';

  const historyInfo = history.length === 0
    ? `<div class="chart-empty-state">
         <div class="chart-empty-icon">📊</div>
         <div class="chart-empty-msg">No history data yet</div>
         <div class="chart-empty-sub">Price history will appear once the scraper has run at least twice for this station.</div>
       </div>`
    : history.length < 2
    ? `<p class="chart-building">
         📊 Building history — scraper has captured ${history.length} data point so far.
         Charts require at least 2 points.
       </p>`
    : history.length < 7
    ? `<canvas id="station-chart" style="width:100%;height:200px"></canvas>
       <p class="chart-building muted" style="font-size:0.8em;margin-top:4px">
         📊 ${history.length} day(s) of history — full trend visible after 7 days.
       </p>`
    : `<canvas id="station-chart" style="width:100%;height:200px"></canvas>`;

  const nearbyList = nearby.length === 0 ? '<p class="muted">No nearby stations in matrix</p>'
    : `<div class="nearby-list">
        ${nearby.map(s => `
          <div class="nearby-row" data-id="${esc(s.id)}">
            <span class="brand-dot" style="background:${getBrandColor(s.brand)}"></span>
            <span class="nearby-name">${esc(s.name)}</span>
            <span class="nearby-price">${s.hasData && s.prices?.[ft] != null ? formatPriceMXN(s.prices[ft]) : '—'}</span>
          </div>`).join('')}
      </div>`;

  return `
    <div class="card-inner">
      <div class="card-header" style="border-left:4px solid ${color}">
        <div>
          <h2 class="card-title">${esc(station.name)}</h2>
          <span class="brand-badge" style="background:${color}">${esc(station.brand)}</span>
        </div>
        <button class="card-close" id="card-close-btn">✕</button>
      </div>

      <div class="card-body">
        <div class="card-address">
          📍 ${esc(station.address)}, ${esc(station.city)}, ${esc(station.state)}
          <a href="${mapsUrl}" target="_blank" class="maps-link">Open in Maps ↗</a>
        </div>

        ${station.distanceKm != null ? `
          <div class="card-distance">
            Distance: ${formatDistance(station.distanceKm)} straight-line /
            ~${formatDistance(station.manhattanKm)} road estimate
          </div>` : ''}

        ${anomalyBanner}
        ${savingsBanner}

        <h3 class="section-title">Price Comparison</h3>
        <table class="detail-table">
          <thead><tr><th>Fuel</th><th>Today</th><th>Yesterday</th><th>Change</th><th>vs National</th></tr></thead>
          <tbody>
            ${priceRow('Regular', p?.regular, null)}
            ${priceRow('Premium', p?.premium, null)}
            ${priceRow('Diesel',  p?.diesel,  null)}
          </tbody>
        </table>

        <h3 class="section-title">Price History</h3>
        ${historyInfo}

        <h3 class="section-title">Neighborhood Comparison</h3>
        <div class="nbh-radius-row">
          <label class="nbh-radius-label">
            Radius: <span id="nbh-radius-val">5</span> km
          </label>
          <input type="range" id="nbh-radius-slider" min="1" max="8" step="1" value="5">
        </div>
        <div id="nbh-stats-container">
          ${buildNeighborhoodStats(station, ft, allData, 5)}
        </div>

        <h3 class="section-title">Nearby Stations (5km)</h3>
        ${nearbyList}
      </div>
    </div>`;
}

// ─── Neighborhood Stats ───────────────────────────────────────────────────

function buildNeighborhoodStats(station, ft, allData, radiusKm) {
  const nearbyRefs = getNearbyById(station.id, allData, radiusKm);
  const nearby = nearbyRefs
    .map(ref => allData.find(s => s.id === ref.stationId))
    .filter(s => s?.hasData && s.prices?.[ft] != null && s.id !== station.id);

  const thisPrice = station.prices?.[ft];

  if (nearby.length === 0) {
    return `<p class="muted nbh-empty">No nearby stations with ${ft} price data within ${radiusKm}km</p>`;
  }

  const prices  = nearby.map(s => s.prices[ft]).sort((a, b) => a - b);
  const min     = prices[0];
  const max     = prices[prices.length - 1];
  const avg     = Math.round(prices.reduce((s, v) => s + v, 0) / prices.length * 100) / 100;
  const cheapSt = nearby.find(s => s.prices[ft] === min);
  const pricySt = nearby.find(s => s.prices[ft] === max);

  let rankHTML = '';
  if (thisPrice != null) {
    const allPrices = [...prices, thisPrice].sort((a, b) => a - b);
    const rank      = allPrices.indexOf(thisPrice) + 1;
    const total     = allPrices.length;
    const position  = max !== min ? (thisPrice - min) / (max - min) : 0.5;
    const rankClass = position <= 0.33 ? 'nbh-rank-cheap'
                    : position <= 0.67 ? 'nbh-rank-mid' : 'nbh-rank-expensive';
    const pct       = Math.round(position * 100);

    rankHTML = `
      <div class="nbh-rank ${rankClass}">
        This station: <strong>${formatPriceMXN(thisPrice)}</strong> —
        <strong>#${rank} of ${total}</strong> within ${radiusKm}km
      </div>
      <div class="nbh-bar-wrap">
        <div class="nbh-bar-track">
          <div class="nbh-bar-fill" style="width:${pct}%"></div>
          <div class="nbh-bar-marker" style="left:${pct}%"></div>
        </div>
        <div class="nbh-bar-labels">
          <span>${formatPriceMXN(min)}</span>
          <span class="nbh-bar-mid">avg ${formatPriceMXN(avg)}</span>
          <span>${formatPriceMXN(max)}</span>
        </div>
      </div>`;
  }

  return `
    <div class="nbh-stats-grid">
      <div class="nbh-stat nbh-stat-cheap">
        <div class="nbh-stat-label">Cheapest nearby</div>
        <div class="nbh-stat-price">${formatPriceMXN(min)}</div>
        <div class="nbh-stat-name">${esc(cheapSt?.name ?? '')}</div>
      </div>
      <div class="nbh-stat nbh-stat-avg">
        <div class="nbh-stat-label">Average</div>
        <div class="nbh-stat-price">${formatPriceMXN(avg)}</div>
        <div class="nbh-stat-name">${nearby.length} stations</div>
      </div>
      <div class="nbh-stat nbh-stat-pricey">
        <div class="nbh-stat-label">Priciest nearby</div>
        <div class="nbh-stat-price">${formatPriceMXN(max)}</div>
        <div class="nbh-stat-name">${esc(pricySt?.name ?? '')}</div>
      </div>
    </div>
    ${rankHTML}`;
}

// ─── Chart ────────────────────────────────────────────────────────────────

function renderChart(station, ft, history) {
  const canvas = document.getElementById('station-chart');
  if (!canvas || typeof Chart === 'undefined') return; // eslint-disable-line no-undef

  if (_chart) { _chart.destroy(); _chart = null; }

  const labels = history.map(h => h.date.slice(5));   // MM-DD
  const prices = history.map(h => h.price);

  // 7-day moving average
  const ma7 = prices.map((_, i) => {
    const slice = prices.slice(Math.max(0, i - 6), i + 1);
    return Math.round(slice.reduce((s, v) => s + v, 0) / slice.length * 100) / 100;
  });

  const COLOR = { regular: '#4A9EFF', premium: '#B57BFF', diesel: '#FFD700' };

  _chart = new Chart(canvas, { // eslint-disable-line no-undef
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `${ft.charAt(0).toUpperCase() + ft.slice(1)} $/L`,
          data: prices,
          borderColor: COLOR[ft] ?? '#4A9EFF',
          backgroundColor: (COLOR[ft] ?? '#4A9EFF') + '22',
          tension: 0.3,
          pointRadius: 3,
          fill: true,
        },
        {
          label: '7-day MA',
          data: ma7,
          borderColor: '#888888',
          borderDash: [5, 5],
          tension: 0.3,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#EEEEEE' } } },
      scales: {
        x: { ticks: { color: '#AAAAAA' }, grid: { color: '#2A2A4A' } },
        y: {
          ticks: { color: '#AAAAAA', callback: v => `$${v.toFixed(2)}` },
          grid: { color: '#2A2A4A' },
        },
      },
    },
  });
}

// ─── Events ───────────────────────────────────────────────────────────────

function attachCardListeners(station) {
  document.getElementById('card-close-btn')?.addEventListener('click', closeCard);

  _drawer.querySelectorAll('.nearby-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      const s  = getState().mergedData.find(st => st.id === id);
      if (s) setState({ selectedStation: s });
    });
  });

  // Neighborhood radius slider
  const slider = document.getElementById('nbh-radius-slider');
  const valEl  = document.getElementById('nbh-radius-val');
  const statsEl = document.getElementById('nbh-stats-container');
  if (slider && valEl && statsEl) {
    slider.addEventListener('input', () => {
      valEl.textContent = slider.value;
    });
    slider.addEventListener('change', () => {
      const radius = parseInt(slider.value, 10);
      const ft     = getState().filters.fuelType ?? 'regular';
      statsEl.innerHTML = buildNeighborhoodStats(station, ft, getState().mergedData, radius);
    });
  }
}
