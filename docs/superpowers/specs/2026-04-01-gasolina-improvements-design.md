# Gasolina Inteligente — Improvements Design
**Date:** 2026-04-01
**Status:** Approved
**Approach:** Deploy + Automate → UI Redesign + Address Geocoding

---

## Overview

Three improvement streams delivered in two phases:

| Phase | Stream | Outcome |
|---|---|---|
| 1 | Deploy + Pipeline Automation | Live public URL, daily fresh data |
| 2 | UI Redesign + Address Geocoding | Visual polish, GPS-free location support |

---

## Phase 1 — Deploy + Pipeline Automation

### 1.1 GitHub Setup

The repo currently has no remote. Steps:
- Create GitHub repo `gasolina-inteligente` under carlosdiaz-3388's account
- Push all 5 existing commits
- The repo root IS the app root (not a monorepo) — this matters for workflow paths

### 1.2 GitHub Actions Workflow Fix

Current `daily-refresh.yml` has monorepo-style paths (`gasolina-inteligente/pipeline/...`) that are wrong for a standalone repo. All path prefixes must be stripped.

Key fixes:
- All `working-directory` references: `gasolina-inteligente/pipeline` → `pipeline`
- All file paths in copy step: `gasolina-inteligente/data/` → `data/`
- Add `PYTHONUTF8=1` env var to all Python steps (required for Windows-origin pipeline, prevents Rich spinner encoding crash on Linux CI too)
- Add `PYTHONPATH: .` env var to refresh step (already present — verify it stays)

### 1.3 Vercel Deployment

- Connect Vercel to the GitHub repo via the Vercel MCP `deploy_to_vercel`
- Framework: None (static site, no build step)
- Output directory: `.` (root — `index.html` is at root)
- `data/stations_latest.json` is a committed static asset — served by Vercel automatically
- Auto-deploy on every push to `main`

### 1.4 Data Freshness Loop

```
7:30 AM Mexico City
  → GitHub Actions runs daily-refresh.yml
  → Fetches CRE prices, exports stations_latest.json
  → Commits: "data: daily price refresh YYYY-MM-DD"
  → Push triggers Vercel auto-redeploy
  → Live app serves fresh data within ~60s
```

### 1.5 File Size Note

`stations_latest.json` is ~10MB. Vercel free tier has no static asset file size limit. No CDN configuration needed.

---

## Phase 2 — UI Redesign

### 2.1 Design System (via Stitch)

Create a design system with:
- **Color tokens:** Brand palette (dark background, fuel-type accent colors — green for cheapest, red for anomaly, amber for premium, teal for diesel)
- **Typography scale:** One font pairing — readable at data density
- **Component primitives:** Price chip, brand badge, anomaly badge, fuel-type tab, station card, filter section

### 2.2 UI Components to Redesign

| Component | Current problem | Fix |
|---|---|---|
| Map popup | Prices hard to scan, no brand emphasis | Brand badge top-right, price grid, cleaner CTA |
| Price list | Fuel type is a dropdown, anomaly badges small | Fuel type tabs pinned to toolbar, inline anomaly badges |
| Station card | Price table cramped | More whitespace, bolder prices, change indicators cleaner |
| Filters panel | All sections always visible, cramped mobile | Collapsible sections, sticky apply button on mobile |

### 2.3 Scope Boundary

- **Changes:** CSS, HTML template strings in UI modules, design tokens
- **No changes:** JS logic, state management, pipeline, data shape
- **No framework change:** Stays vanilla JS + CSS

---

## Phase 2 — Address Geocoding Feature

### 2.4 New Module: `modules/api/geocoder.js`

Two-stage pipeline: heuristic preprocessor → Nominatim. No external API calls beyond Nominatim (free).

**Stage 1 — Heuristic preprocessor:**
Strips Spanish filler words and extracts the geocodable core before hitting Nominatim.

```
normalize(raw: string) → string[]   // returns 1-3 candidate query strings
```

Rules applied in order:
1. Lowercase + trim
2. Strip filler: `"cerca de"`, `"junto al"`, `"por la"`, `"a un lado de"`, `"frente al"`, `"esquina con"`, etc.
3. Expand common abbreviations: `"cdmx"→"Ciudad de México"`, `"mty"→"Monterrey"`, `"gdl"→"Guadalajara"`, `"col."→"Colonia"`
4. If input is 5 digits → treat as CP, generate query `"CP {input}, México"`
5. Generate up to 3 candidates by progressively dropping words from the left (handles "Av. Reforma 250, Juárez, CDMX" → also tries "Juárez, CDMX")

**Stage 2 — Nominatim geocode:**
Each candidate → `countrycodes=mx&limit=3` Nominatim lookup → first successful result wins.

```
geocode(query: string) → Promise<{ lat, lng, displayName } | null>
suggest(query: string) → Promise<Array<{ label, lat, lng }>>  // for typeahead
```

- `suggest()`: preprocesses → geocodes all candidates → returns merged list (max 5) for dropdown
- Debounced 400ms on the input side (caller's responsibility)
- 5s total timeout, returns `null` on failure
- Session-level cache: same normalized query → same result (no redundant requests)

**Cost:** Zero. Nominatim is free, no API key required.

**Privacy:** Normalized query string sent to Nominatim public servers only. No data stored. Tooltip informs user.

### 2.5 New Module: `modules/ui/location-bar.js`

Renders above the filters panel. Two modes:

**Mode A — GPS available:**
```
[📍 Using GPS]  [Change to address ▼]
```

**Mode B — GPS denied / no location:**
```
[🔍 ¿Dónde estás? Colonia, dirección, CP...]  [📍 GPS]
```

Behavior:
- Address input: debounced 400ms → `geocoder.suggest()` → dropdown of up to 3 candidates appears
- User selects candidate (or presses Enter for top result) → `geocoder.geocode()` → `setState({ userLocation: {lat, lng} })`
- Shows `"📍 [display name]"` confirmation below input on success
- Shows `"No results found"` inline on failure (rare — Claude normalizes most inputs)
- Persists last address string and resolved `{lat, lng}` to `localStorage` key `gi_userLocation`
- On boot: if `gi_userLocation` in localStorage and no GPS, restores it silently
- Placeholder text examples cycle: "Polanco CDMX", "CP 64000", "cerca del OXXO en Tlalnepantla"

### 2.6 Integration Points

`location-bar.js` calls `setState({ userLocation })` — identical to what `modules/utils/geo.js` does on GPS success. No changes needed to:
- `filters.js` distance slider (already reads `state.userLocation`)
- `app.js` `addDistances()` call (already reads `state.userLocation`)
- Distance matrix / haversine fallback (already reads `state.userLocation`)

Only change to existing files:
- `app.js`: import and init `location-bar.js`, remove the "enable location" hint from filters (location-bar replaces it)
- `index.html`: add `<div id="location-bar">` above filters panel

### 2.7 Drop-a-Pin Feature

**What:** User clicks anywhere on the map → a draggable pin drops at that point → radius circle appears → side panel shows nearest + cheapest stations within that radius.

**Map behavior (changes to `modules/ui/map.js`):**
- `map.on('click', e)` → calls `setState({ userLocation: { lat: e.latlng.lat, lng: e.latlng.lng }, userLocationSource: 'pin' })`
- Renders a distinct draggable `L.marker` (different icon from station markers) at the pin location
- Drag end → same `setState` call with new position
- Renders `L.circle(userLocation, { radius: maxDistanceKm * 1000 })` — updates reactively when distance slider changes
- Pin is cleared if user switches back to GPS or address location

**Nearby results panel (new: `modules/ui/nearby-panel.js`):**
- Appears as a slide-up card at the bottom of the map when a pin is active
- Shows two columns: **Nearest 5** (sorted by distance) and **Cheapest 5** (sorted by price for selected fuel type) within the radius
- Each row: station name, distance, price — tappable to open station card
- "Clear pin" button dismisses the panel and removes the pin + circle

**Integration:** `userLocation` in state is already used by `addDistances()`, filters, and the price list sort — pin sets the same field, so all existing distance-aware features work automatically. No changes to filters, anomaly detector, or price list logic.

**Radius source:** Reads `state.filters.maxDistanceKm` — the existing distance slider. If no limit set (slider at max), defaults to 10km for the circle and panel.

### 2.8 Error Handling

| Scenario | Behavior |
|---|---|
| Nominatim timeout (>5s) | Show "Location lookup timed out — try again" |
| No results | Show "No results found for '[query]'" |
| Network offline | Show "Offline — using last known location" (if persisted) |
| GPS denied + no address + no persisted | Filters panel shows distance slider disabled as before |

---

## File Inventory

### New files
- `modules/api/geocoder.js`
- `modules/ui/location-bar.js`
- `modules/ui/nearby-panel.js`
- `docs/superpowers/specs/2026-04-01-gasolina-improvements-design.md` (this file)

### Modified files
- `.github/workflows/daily-refresh.yml` — fix paths, add PYTHONUTF8=1
- `app.js` — init location-bar, wire geocoder
- `index.html` — add location-bar container
- `modules/ui/filters.js` — remove "enable location" hint (location-bar owns this)
- `modules/ui/map.js` — add click handler, draggable pin marker, radius circle
- UI modules — design system tokens applied
- CSS — design system implementation

### External services
- **Vercel** — static hosting, auto-deploy on push
- **Nominatim** — geocoding, no key, rate limit: 1 req/s (debounce handles this)

---

## Success Criteria

1. `https://gasolina-inteligente.vercel.app` serves the app publicly
2. GitHub Actions runs daily, commits updated JSON, Vercel redeploys automatically
3. User types fuzzy Spanish input ("cerca del oxxo en polanco", "CP 64000") → heuristic normalizer → Nominatim geocodes → typeahead shows candidates → nearest stations ranked by distance
4. User can click anywhere on the map to drop a draggable pin — radius circle appears, nearby panel shows nearest 5 + cheapest 5
4. GPS flow still works as before — location-bar degrades gracefully
5. UI design system applied consistently across map popup, price list, station card, filters
