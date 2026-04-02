# Gasolina Inteligente — Data Pipeline

## Overview

Three-zone ETL pipeline: Raw → Staging → Curated → Export

```
CRE API ──┐
OSM API ───┼──→ Raw Zone → Staging Zone → Curated Zone → JSON Export → Frontend
DENUE API ─┘

Sources: publicacionexterna.azurewebsites.net (CRE), OpenStreetMap, INEGI DENUE
```

## Running the Pipeline

```bash
cd pipeline/
python -m venv venv && venv/Scripts/activate   # Windows
pip install -r requirements.txt

# Full seed (first time)
python scripts/seed.py --source cre            # Real CRE data
python scripts/seed.py --mock                  # Mock data for testing

# Daily refresh
python scripts/refresh.py --source cre_prices  # Prices only (fast)
python scripts/refresh.py --source all         # Everything

# Export for frontend
python scripts/export_for_app.py               # → data/stations_latest.json
```

## Data Zones

| Zone | Location | Contents |
|------|----------|----------|
| Raw | `pipeline/data/raw/` | Untouched API responses + Parquet archives |
| Staging | `pipeline/data/staging/` | Normalized, unmatched records |
| Curated | `pipeline/data/curated/` | Master station records post-matching |
| Export | `data/stations_latest.json` | Frontend-ready JSON |

## Station Matching

The pipeline uses a blocking + scoring approach to deduplicate stations across data sources:

1. **Blocking** (`match/blocking.py`) — Generate candidate pairs by address/brand similarity
2. **Scoring** (`match/scorer.py`) — Levenshtein + phonetic + geo distance
3. **Resolution** (`match/resolver.py`) — Auto-match (score > 0.85), review queue (0.6–0.85), reject (< 0.6)

## Scraper Schedule

The daily scraper runs at **6–8 AM Mexico City time** (America/Mexico_City) to capture CRE price data before it's overwritten. This historical price data is the platform's competitive advantage — CRE only exposes current prices, not history.

The scraper runs 4 times during the window (every 30 minutes). Deduplication prevents double-writes.

## Distance Matrix

Pre-computed neighbor pairs in `data/static/` enable O(1) anomaly detection lookups:

```bash
# Generate via Dev Panel (browser)
Ctrl+Shift+D → "Generate Distance Matrix"

# Or programmatically (after implementing)
python scripts/seed.py --generate-matrix
```

**Current status:** Matrix not yet generated (all counts = 0). Anomaly detection falls back to O(n²) haversine — correct but ~50–500ms slower per analysis pass.

## Quality Checks

Run QA after any pipeline operation:
```bash
python -c "from pipeline.quality.checks import run_checks; run_checks()"
```

Checks: completeness, coordinate validity, duplicate detection, price outliers.
