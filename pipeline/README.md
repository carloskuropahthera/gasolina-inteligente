# Gasolina Inteligente — Data Pipeline

Production-grade Python pipeline for building and maintaining a Mexico Gas Station Master Dataset.

## Quick Start

```bash
# 1. Set up environment
cd pipeline/
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS/Linux

pip install -r requirements.txt
playwright install chromium

# 2. First run (mock mode — no API calls)
python scripts/seed.py --mock

# 3. First real run (CRE only — fastest)
python scripts/seed.py --source cre

# 4. Full seed (all sources)
python scripts/seed.py --source all
```

## Daily Operations

```bash
# Refresh CRE prices (run daily via cron)
python scripts/refresh.py --source cre_prices

# Full weekly refresh
python scripts/refresh.py --source all

# Export for JS app
python scripts/export_for_app.py
```

## Architecture

See `../docs/DATA_PIPELINE_ARCHITECTURE.md` for the full architecture document.

## Module Overview

| Module | Purpose |
|--------|---------|
| `config.py` | All constants, thresholds, paths |
| `models/` | Pydantic v2 data models |
| `sources/` | API clients (CRE, OSM, DENUE, brand scrapers) |
| `normalize/` | Text, brand, address, geo normalization |
| `match/` | Blocking, scoring, resolution, explanation |
| `storage/` | SQLAlchemy schemas, raw/staging/curated zone ops |
| `quality/` | 10 QA rules + reporter |
| `orchestration/` | Pipeline DAG + cron schedule |
| `scripts/` | CLI entry points |

## Data Flow

```
CRE API → raw/cre_places_YYYYMMDD.parquet
OSM API → raw/osm_fuel_YYYYMMDD.parquet
DENUE   → raw/denue_gasolineras_YYYYMMDD.parquet
                    ↓
              normalize/
                    ↓
         data/staging/gasolina_staging.db
            (stg_cre, stg_osm, stg_denue)
                    ↓
           blocking + scoring
                    ↓
         data/curated/gasolina_master.db
              (station_master)
                    ↓
    data/curated/exports/stations_latest.json
              (JS app reads this)
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_PLACES_API_KEY` | No (optional) | Google Places API key for review queue enrichment |
| `OPENCAGE_API_KEY` | No (optional) | OpenCage geocoding key |
| `GI_MOCK` | No | Set to `true` to enable mock mode globally |
| `LOG_LEVEL` | No | Logging level (default: INFO) |
