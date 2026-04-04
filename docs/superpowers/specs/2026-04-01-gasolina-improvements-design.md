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

Wraps Nominatim (OpenStreetMap public API). No API key required.

```
geocode(query: string) → Promise<{ lat, lng, displayName } | null>
```

- Scoped to Mexico: `countrycodes=mx&limit=1`
- Debounced 400ms on the input side (caller's responsibility)
- 5s timeout, returns `null` on failure
- No caching at module level (Nominatim has its own)

**Privacy:** Query string sent to Nominatim public servers. No data stored. Tooltip informs user.

### 2.5 New Module: `modules/ui/location-bar.js`

Renders above the filters panel. Two modes:

**Mode A — GPS available:**
```
[📍 Using GPS]  [Change to address ▼]
```

**Mode B — GPS denied / no location:**
```
[🔍 Enter address, colonia, or zip...]  [📍 Use GPS]
```

Behavior:
- Address input: debounced 400ms → `geocoder.geocode()` → if result: `setState({ userLocation: {lat, lng} })`
- Shows `"📍 [display name]"` confirmation below input on success
- Shows `"No results found"` inline on failure
- Persists last address string and resolved `{lat, lng}` to `localStorage` key `gi_userLocation`
- On boot: if `gi_userLocation` in localStorage and no GPS, restores it silently

### 2.6 Integration Points

`location-bar.js` calls `setState({ userLocation })` — identical to what `modules/utils/geo.js` does on GPS success. No changes needed to:
- `filters.js` distance slider (already reads `state.userLocation`)
- `app.js` `addDistances()` call (already reads `state.userLocation`)
- Distance matrix / haversine fallback (already reads `state.userLocation`)

Only change to existing files:
- `app.js`: import and init `location-bar.js`, remove the "enable location" hint from filters (location-bar replaces it)
- `index.html`: add `<div id="location-bar">` above filters panel

### 2.7 Error Handling

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
- `docs/superpowers/specs/2026-04-01-gasolina-improvements-design.md` (this file)

### Modified files
- `.github/workflows/daily-refresh.yml` — fix paths, add PYTHONUTF8=1
- `app.js` — init location-bar, wire geocoder
- `index.html` — add location-bar container
- `modules/ui/filters.js` — remove "enable location" hint (location-bar owns this)
- UI modules — design system tokens applied
- CSS — design system implementation

### External services
- **Vercel** — static hosting, auto-deploy on push
- **Nominatim** — geocoding, no key, rate limit: 1 req/s (debounce handles this)

---

## Success Criteria

1. `https://gasolina-inteligente.vercel.app` serves the app publicly
2. GitHub Actions runs daily, commits updated JSON, Vercel redeploys automatically
3. User can type "Polanco CDMX" or "64000" and see cheapest nearby stations ranked by distance
4. GPS flow still works as before — location-bar degrades gracefully
5. UI design system applied consistently across map popup, price list, station card, filters
