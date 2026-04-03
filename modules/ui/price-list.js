// MODULE: price-list
// PURPOSE: Sortable price table with color coding, anomaly badges, pagination, export
// DEPENDS ON: prices, stations, helpers, state, logger

import { getStats, buildNationalSummary, getCheapest } from '../data/prices.js';
import { getBrandColor } from '../data/stations.js';
import { setState, getState, subscribe } from '../utils/state.js';
import { formatPriceMXN, formatDistance, arrayToCSV, downloadCSV, priceDelta, esc } from '../utils/helpers.js';
import { applyFilters } from './filters.js';
import { createLogger }    from '../utils/logger.js';

const log = createLogger('price-list');

const PAGE_SIZE  = 25;
let _currentPage = 1;
let _sortKey     = 'regular';
let _sortDir     = 'asc';
let _viewMode    = 'table'; // 'table' | 'card'
let _container   = null;

/**
 * Initialize the price list in a container element.
 * @param {string} containerId
 */
export function initPriceList(containerId) {
  _container = document.getElementById(containerId);
  if (!_container) { log.error(`Container #${containerId} not found`); return; }

  subscribe('filteredData', () => renderPriceList());
  subscribe('selectedStation', () => highlightSelectedRow());
  subscribe('filters', () => {
    _currentPage = 1;
    renderPriceList();
  });

  renderPriceList();
  log.info('Price list initialized');
}

// ─── Render ───────────────────────────────────────────────────────────────

function renderPriceList() {
  if (!_container) return;

  const state      = getState();
  const data       = state.filteredData;
  const fuelType   = state.filters.fuelType ?? 'regular';
  const summary    = buildNationalSummary(data);
  const anomalyIds = new Set(state.anomalies.map(a => a.stationId));

  // Price thresholds for color coding
  const stats  = getStats(data, fuelType);
  const greenThreshold = stats.p10;
  const redThreshold   = stats.p90;

  // Sort data
  const sorted = sortData(data, fuelType);

  // Empty state — no stations match the current filters
  if (sorted.length === 0) {
    // Suppress empty state while the initial data load is still in progress
    if (state.isLoading) return;
    _container.innerHTML = `
      ${renderSummaryBar(summary, fuelType, data)}
      ${renderLastUpdated(state.lastFetch)}
      ${renderEmptyState()}
    `;
    document.getElementById('btn-clear-filters-empty')?.addEventListener('click', () => {
      // Click the sidebar reset button if present; otherwise clear filter state directly
      const sidebarReset = document.getElementById('btn-reset-filters');
      if (sidebarReset) {
        sidebarReset.click();
      } else {
        setState({ filters: { fuelType: state.filters.fuelType ?? 'regular' } });
        applyFilters();
      }
    });
    return;
  }

  // Paginate
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  _currentPage     = Math.min(_currentPage, totalPages);
  const pageData   = sorted.slice((_currentPage - 1) * PAGE_SIZE, _currentPage * PAGE_SIZE);

  _container.innerHTML = `
    ${renderSummaryBar(summary, fuelType, data)}
    ${renderLastUpdated(state.lastFetch)}
    <div class="list-toolbar">
      <div class="list-count">Showing ${data.length} stations</div>
      <div class="list-actions">
        <button class="btn-sm" id="btn-view-toggle">${_viewMode === 'table' ? '⊞ Card View' : '≡ Table View'}</button>
        <button class="btn-sm btn-accent" id="btn-export-csv">⬇ Export CSV</button>
      </div>
    </div>
    ${_viewMode === 'table'
      ? renderTable(pageData, fuelType, greenThreshold, redThreshold, anomalyIds, stats)
      : renderCards(pageData, fuelType, greenThreshold, redThreshold, anomalyIds, stats)}
    ${renderPagination(totalPages)}
  `;

  attachListeners(sorted, fuelType, summary);
}

function renderEmptyState() {
  return `
    <div class="empty-state">
      <div class="empty-state-icon">🔍</div>
      <div class="empty-state-title">No stations found</div>
      <div class="empty-state-sub">Try adjusting your filters</div>
      <button class="btn-sm btn-accent" id="btn-clear-filters-empty">Clear filters</button>
    </div>`;
}

function renderSummaryBar(summary, fuelType, data) {
  const cheap = getCheapest(data, fuelType, 1)[0];
  return `
    <div class="summary-bar">
      <div class="summary-fuel">
        <span class="summary-label">Regular</span>
        <span class="summary-price">${formatPriceMXN(summary.regular?.avg)}</span>
        <span class="summary-sub">avg</span>
      </div>
      <div class="summary-fuel">
        <span class="summary-label">Premium</span>
        <span class="summary-price">${formatPriceMXN(summary.premium?.avg)}</span>
        <span class="summary-sub">avg</span>
      </div>
      <div class="summary-fuel">
        <span class="summary-label">Diesel</span>
        <span class="summary-price">${formatPriceMXN(summary.diesel?.avg)}</span>
        <span class="summary-sub">avg</span>
      </div>
      ${cheap ? `<div class="summary-cheap">
        Cheapest today: <strong>${formatPriceMXN(cheap.prices?.[fuelType])}</strong>
        — ${esc(cheap.name)}, ${esc(cheap.city)}
      </div>` : ''}
    </div>`;
}

function getDataFreshnessStatus(exportedAt) {
  if (!exportedAt) return { label: 'Unknown', class: 'stale' };
  const age   = Date.now() - new Date(exportedAt).getTime();
  const hours = age / (1000 * 60 * 60);
  if (hours < 12) return { label: 'Fresh',        class: 'fresh'  };
  if (hours < 24) return { label: 'Updated today', class: 'recent' };
  if (hours < 48) return { label: 'Yesterday',     class: 'aging'  };
  return { label: `${Math.floor(hours / 24)}d old`, class: 'stale' };
}

function renderLastUpdated(lastFetch) {
  if (!lastFetch) return '';
  try {
    const date      = new Date(lastFetch);
    const formatted = date.toLocaleString('es-MX', {
      timeZone: 'America/Mexico_City',
      year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
      hour12: true,
    });
    const freshness = getDataFreshnessStatus(lastFetch);
    const warning   = freshness.class === 'stale' ? ' ⚠️' : '';
    return `<div class="last-updated">
      Last updated: ${formatted} CST
      <span class="freshness-badge freshness-${freshness.class}">
        <span class="freshness-dot"></span>${freshness.label}${warning}
      </span>
    </div>`;
  } catch {
    return `<div class="last-updated">Last updated: ${lastFetch}</div>`;
  }
}

function renderTable(rows, fuelType, greenThreshold, redThreshold, anomalyIds, stats) {
  const th = (key, label) => {
    const active = _sortKey === key;
    const arrow  = active ? (_sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    const ariaSort = active ? (_sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th class="sortable${active ? ' sort-active' : ''}" data-sort="${key}" role="columnheader" aria-sort="${ariaSort}" tabindex="0">${label}${arrow}</th>`;
  };

  const bodyRows = rows.map((s, i) => {
    const isSelected = getState().selectedStation?.id === s.id;
    const isAnomaly  = anomalyIds.has(s.id);

    const priceCell = (ft) => {
      const val    = s.prices?.[ft];
      if (!s.hasData || val == null) return `<td class="price-cell">—</td>`;
      const delta  = priceDelta(val, stats.avg);
      const cls    = val <= greenThreshold ? 'price-cheap'
                   : val >= redThreshold   ? 'price-expensive' : '';
      return `<td class="price-cell ${cls}">
        ${formatPriceMXN(val)}
        <span class="price-delta ${delta.dir}">${delta.label}</span>
      </td>`;
    };

    return `<tr class="list-row${isSelected ? ' row-selected' : ''}${isAnomaly ? ' row-anomaly' : ''}"
              data-id="${s.id}" data-idx="${i}"
              tabindex="0"
              role="row"
              aria-selected="${isSelected ? 'true' : 'false'}"
              aria-label="${esc(s.name)}, ${esc(s.brand)}, ${esc(s.city)}, ${esc(s.state)}">
      <td class="row-num">${(_currentPage-1)*PAGE_SIZE + i + 1}</td>
      <td class="row-name">${isAnomaly ? '<span class="anomaly-icon" title="Anomaly detected">⚠️</span>' : ''}${esc(s.name)}</td>
      <td><span class="brand-dot" style="background:${getBrandColor(s.brand)}"></span>${esc(s.brand)}</td>
      <td>${esc(s.city)}</td>
      <td>${esc(s.state)}</td>
      ${priceCell('regular')}
      ${priceCell('premium')}
      ${priceCell('diesel')}
      <td>${s.distanceKm != null ? formatDistance(s.distanceKm) : '—'}</td>
    </tr>`;
  }).join('');

  return `
    <div class="table-wrap">
      <table class="price-table" role="grid" aria-label="Gas station price list">
        <thead role="rowgroup"><tr role="row">
          ${th('name','Station')}${th('brand','Brand')}
          ${th('city','City')}${th('state','State')}
          ${th('regular','Regular')}${th('premium','Premium')}${th('diesel','Diesel')}
          ${th('distanceKm','Dist.')}
        </tr></thead>
        <tbody role="rowgroup">${bodyRows}</tbody>
      </table>
    </div>`;
}

function renderCards(rows, fuelType, greenThreshold, redThreshold, anomalyIds, stats) {
  return `<div class="card-grid">` + rows.map(s => {
    const price     = s.prices?.[fuelType];
    const cls       = price != null && price <= greenThreshold ? 'card-cheap'
                    : price != null && price >= redThreshold   ? 'card-expensive' : '';
    const isAnomaly = anomalyIds.has(s.id);
    return `
      <div class="station-card-mini ${cls}${isAnomaly ? ' card-anomaly' : ''}" data-id="${s.id}">
        <div class="card-mini-header">
          <span class="brand-badge-sm" style="background:${getBrandColor(s.brand)}">${esc(s.brand)}</span>
          ${isAnomaly ? '<span class="anomaly-icon">⚠️</span>' : ''}
        </div>
        <div class="card-mini-name">${esc(s.name)}</div>
        <div class="card-mini-city">${esc(s.city)}, ${esc(s.state)}</div>
        <div class="card-mini-price">${formatPriceMXN(price)}</div>
        ${s.distanceKm != null ? `<div class="card-mini-dist">${formatDistance(s.distanceKm)}</div>` : ''}
      </div>`;
  }).join('') + `</div>`;
}

function renderPagination(totalPages) {
  if (totalPages <= 1) return '';
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  return `
    <div class="pagination">
      <button class="page-btn" data-page="${_currentPage - 1}" ${_currentPage === 1 ? 'disabled' : ''}>‹</button>
      ${pages.map(p => `<button class="page-btn${p === _currentPage ? ' active' : ''}" data-page="${p}">${p}</button>`).join('')}
      <button class="page-btn" data-page="${_currentPage + 1}" ${_currentPage === totalPages ? 'disabled' : ''}>›</button>
    </div>`;
}

// ─── Events ───────────────────────────────────────────────────────────────

function attachListeners(sorted, fuelType, summary) {
  // Sort headers
  _container.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (_sortKey === key) _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
      else { _sortKey = key; _sortDir = 'asc'; }
      _currentPage = 1;
      renderPriceList();
    });
  });

  // Row click → select station
  _container.querySelectorAll('.list-row,.station-card-mini').forEach(row => {
    row.addEventListener('click', () => {
      const id      = row.dataset.id;
      const station = getState().mergedData.find(s => s.id === id);
      if (station) setState({ selectedStation: station });
    });
    // Keyboard navigation: Enter or Space activates the focused row
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const id      = row.dataset.id;
        const station = getState().mergedData.find(s => s.id === id);
        if (station) setState({ selectedStation: station });
      }
    });
  });

  // Sort headers: also support keyboard activation
  _container.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        th.click();
      }
    });
  });

  // Pagination
  _container.querySelectorAll('.page-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = parseInt(btn.dataset.page, 10);
      if (p >= 1) { _currentPage = p; renderPriceList(); }
    });
  });

  // View toggle
  document.getElementById('btn-view-toggle')?.addEventListener('click', () => {
    _viewMode = _viewMode === 'table' ? 'card' : 'table';
    _currentPage = 1;
    renderPriceList();
  });

  // CSV export — exports the currently filtered+sorted view (all pages, not just current)
  document.getElementById('btn-export-csv')?.addEventListener('click', () => exportCSV(sorted, fuelType, summary));
}

function sortData(data, fuelType) {
  return [...data].sort((a, b) => {
    let av, bv;
    if (['regular', 'premium', 'diesel'].includes(_sortKey)) {
      av = a.prices?.[_sortKey] ?? Infinity;
      bv = b.prices?.[_sortKey] ?? Infinity;
    } else {
      av = a[_sortKey] ?? '';
      bv = b[_sortKey] ?? '';
    }
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return _sortDir === 'asc' ? cmp : -cmp;
  });
}

function highlightSelectedRow() {
  const selectedId = getState().selectedStation?.id;
  _container?.querySelectorAll('.list-row,.station-card-mini').forEach(row => {
    const isSelected = row.dataset.id === selectedId;
    row.classList.toggle('row-selected', isSelected);
    row.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  });
}

function exportCSV(data, fuelType = 'regular') {
  if (!data.length) {
    log.warn('CSV export: no data to export');
    return;
  }

  // Snapshot the anomaly set at export time from authoritative state —
  // _isAnomaly is a transient field set during loadData and may not survive
  // filter/sort transforms, so we read from state.anomalies instead.
  const anomalyIds = new Set(getState().anomalies.map(a => a.stationId));

  const COLS = ['id','name','brand','address','city','state','zipCode',
                'lat','lng','regular','premium','diesel','updatedAt','distanceKm','hasData','isAnomaly'];

  const rows = data.map(s => ({
    id:         s.id,
    name:       s.name,
    brand:      s.brand,
    address:    s.address,
    city:       s.city,
    state:      s.state,
    zipCode:    s.zipCode,
    lat:        s.lat,
    lng:        s.lng,
    regular:    s.prices?.regular ?? '',
    premium:    s.prices?.premium ?? '',
    diesel:     s.prices?.diesel  ?? '',
    updatedAt:  s.prices?.updatedAt ?? '',
    distanceKm: s.distanceKm ?? '',
    hasData:    s.hasData ? 'Y' : 'N',
    isAnomaly:  anomalyIds.has(s.id) ? 'Y' : 'N',
  }));

  const filters  = getState().filters;
  const activeFilters = [
    filters.brands?.length   ? `brand=${filters.brands.join('+')}` : null,
    filters.states?.length   ? `state=${filters.states.join('+')}` : null,
    filters.cities?.length   ? `city=${filters.cities.join('+')}` : null,
    filters.maxDistanceKm    ? `dist=${filters.maxDistanceKm}km` : null,
  ].filter(Boolean).join('_') || 'all';

  const date = new Date().toISOString().slice(0, 10);
  const filename = `gasolina_${activeFilters}_${date}.csv`;

  const csv = arrayToCSV(rows, COLS);
  downloadCSV(filename, csv);
  log.info(`Exported ${rows.length} rows as CSV (filter: ${activeFilters})`);
}
