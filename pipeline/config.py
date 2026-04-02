"""
config.py — All constants, thresholds, paths, and settings for the Gasolina Inteligente pipeline.

This is the single source of truth for all configuration.
No magic numbers or strings anywhere else in the codebase.
"""

from __future__ import annotations

import os
from collections import namedtuple
from datetime import timedelta
from pathlib import Path

# ═══════════════════════════════════════════════════════════
# BASE PATHS
# ═══════════════════════════════════════════════════════════

# Root of the pipeline package (this file's directory)
PIPELINE_DIR = Path(__file__).parent.resolve()

# Root of the JS app (one level up from pipeline/)
APP_ROOT_DIR = PIPELINE_DIR.parent

# Frontend static data dir — this is where app.js reads stations_latest.json from
APP_DATA_DIR = APP_ROOT_DIR / "data"

# Data directories
DATA_DIR     = PIPELINE_DIR / "data"
RAW_DIR      = DATA_DIR / "raw"
STAGING_DIR  = DATA_DIR / "staging"
CURATED_DIR  = DATA_DIR / "curated"
EXPORTS_DIR  = CURATED_DIR / "exports"
FAILED_DIR   = STAGING_DIR / "failed"

# Create directories if they don't exist
for _d in [RAW_DIR, STAGING_DIR, CURATED_DIR, EXPORTS_DIR, FAILED_DIR]:
    _d.mkdir(parents=True, exist_ok=True)

# Database file paths
STAGING_DB_PATH = STAGING_DIR / "gasolina_staging.db"
CURATED_DB_PATH = CURATED_DIR / "gasolina_master.db"

# SQLite connection URLs (SQLAlchemy format)
STAGING_DB_URL = f"sqlite:///{STAGING_DB_PATH}"
CURATED_DB_URL = f"sqlite:///{CURATED_DB_PATH}"

# ═══════════════════════════════════════════════════════════
# API URLS
# ═══════════════════════════════════════════════════════════

# CRE (Comisión Reguladora de Energía) — public, no auth required
CRE_BASE_URL    = "https://publicacionexterna.azurewebsites.net/publicaciones"
CRE_PLACES_URL  = f"{CRE_BASE_URL}/places"
CRE_PRICES_URL  = f"{CRE_BASE_URL}/prices"

# OSM Overpass API — public, no auth required
OSM_OVERPASS_URL         = "https://overpass-api.de/api/interpreter"
OSM_OVERPASS_URL_FALLBACK = "https://lz4.overpass-api.de/api/interpreter"

# INEGI DENUE (Directorio Estadístico Nacional de Unidades Económicas)
DENUE_BASE_URL       = "https://www.inegi.org.mx/app/descargadenue/"
DENUE_API_URL        = "https://www.inegi.org.mx/app/api/denue/v1/consulta"
DENUE_BULK_CSV_URL   = "https://www.inegi.org.mx/contenidos/masiva/denue/denue_csv.zip"
# SCIAN code for gas stations (Expendio de gasolina y demás combustibles para vehículos)
DENUE_SCIAN_GAS      = "46411"

# Brand locator pages
PEMEX_LOCATOR_URL    = "https://www.pemex.com/servicios/servicio-al-cliente/Paginas/estaciones-de-servicio.aspx"
OXXOGAS_LOCATOR_URL  = "https://www.oxxogas.com/estaciones"
SHELL_LOCATOR_URL    = "https://www.shell.com.mx/motorists/shell-station-locator.html"
BP_LOCATOR_URL       = "https://www.bpmexico.com.mx/estaciones"

# OpenCage Geocoding (free tier: 2500/day, no key for low volume)
OPENCAGE_URL         = "https://api.opencagedata.com/geocode/v1/json"

# Google Places API
GOOGLE_PLACES_URL    = "https://maps.googleapis.com/maps/api/place/nearbysearch/json"
GOOGLE_PLACE_DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json"

# ═══════════════════════════════════════════════════════════
# API KEYS (loaded from environment variables — never hardcode)
# ═══════════════════════════════════════════════════════════

GOOGLE_PLACES_API_KEY = os.environ.get("GOOGLE_PLACES_API_KEY", "")
OPENCAGE_API_KEY      = os.environ.get("OPENCAGE_API_KEY", "")

def require_api_key(key_name: str, key_value: str, feature: str) -> str:
    """
    Raise a clear error if a required API key is missing.
    Call this at the start of any function that uses optional keys,
    so the error surfaces immediately rather than as a cryptic 403.

    Usage:
        key = require_api_key("GOOGLE_PLACES_API_KEY", GOOGLE_PLACES_API_KEY, "Google Places enrichment")
    """
    if not key_value:
        raise EnvironmentError(
            f"{key_name} is not set. {feature} requires this key.\n"
            f"Set it with: export {key_name}='your_key_here'\n"
            f"Or add it to your .env file (do NOT commit to git)."
        )
    return key_value

# ═══════════════════════════════════════════════════════════
# MEXICO GEOGRAPHIC BOUNDS
# ═══════════════════════════════════════════════════════════

MexicoBounds = namedtuple("MexicoBounds", ["lat_min", "lat_max", "lng_min", "lng_max"])

MEXICO_BOUNDS = MexicoBounds(
    lat_min = 14.5328,   # Chiapas — southernmost point
    lat_max = 32.7186,   # Baja California — northernmost point
    lng_min = -118.5978, # Baja California — westernmost point
    lng_max = -86.7104,  # Quintana Roo — easternmost point
)

# Bounding box as string for OSM Overpass query (south, west, north, east)
MEXICO_BBOX_OVERPASS = (
    f"{MEXICO_BOUNDS.lat_min},{MEXICO_BOUNDS.lng_min},"
    f"{MEXICO_BOUNDS.lat_max},{MEXICO_BOUNDS.lng_max}"
)

# ═══════════════════════════════════════════════════════════
# MATCH THRESHOLDS
# ═══════════════════════════════════════════════════════════

AUTO_MATCH_THRESHOLD  = 0.85   # composite ≥ this → auto_match
REVIEW_MIN_THRESHOLD  = 0.65   # composite ≥ this → review_queue (below → reject)
REJECT_THRESHOLD      = 0.65   # composite < this → rejected

# ═══════════════════════════════════════════════════════════
# SCORE WEIGHTS (must sum to 1.0)
# ═══════════════════════════════════════════════════════════

NAME_WEIGHT        = 0.25
GEO_WEIGHT         = 0.35
BRAND_WEIGHT       = 0.20
ADDRESS_WEIGHT     = 0.15
SOURCE_REL_WEIGHT  = 0.05

assert abs(NAME_WEIGHT + GEO_WEIGHT + BRAND_WEIGHT + ADDRESS_WEIGHT + SOURCE_REL_WEIGHT - 1.0) < 1e-9, \
    "Score weights must sum to exactly 1.0"

# ═══════════════════════════════════════════════════════════
# SOURCE RELIABILITY SCORES
# ═══════════════════════════════════════════════════════════

SOURCE_RELIABILITY: dict[str, float] = {
    "cre":    1.00,  # Government regulator — highest authority
    "denue":  0.90,  # Government business registry
    "brand":  0.85,  # Official brand locator pages
    "osm":    0.75,  # Community-maintained
    "google": 0.70,  # Consumer-oriented, no permit data
}

# Source priority for tie-breaking (lower number = higher priority)
SOURCE_PRIORITY: dict[str, int] = {
    "cre":    1,
    "denue":  2,
    "brand":  3,
    "osm":    4,
    "google": 5,
}

# ═══════════════════════════════════════════════════════════
# CONFIDENCE SCORE ADJUSTMENTS
# ═══════════════════════════════════════════════════════════

CONFIDENCE_BONUS_PL_NUMBER    =  0.10  # Has PL number linked from CRE
CONFIDENCE_BONUS_3_SOURCES    =  0.05  # Confirmed by 3+ independent sources
CONFIDENCE_BONUS_GEO_VALID    =  0.03  # Coordinates within municipality polygon
CONFIDENCE_PENALTY_STALE_30   = -0.05  # last_confirmed_at 30–90 days ago
CONFIDENCE_PENALTY_STALE_90   = -0.10  # last_confirmed_at > 90 days ago
CONFIDENCE_PENALTY_NAME_DRIFT = -0.05  # name_drift_flag is set
CONFIDENCE_PENALTY_REVIEW     = -0.05  # review_flag is set

# ═══════════════════════════════════════════════════════════
# GEO SCORING PARAMETERS
# ═══════════════════════════════════════════════════════════

GEO_CLOSE_THRESHOLD_M    = 500.0   # ≤ 500m → linear decay from 1.0 to 0.0
GEO_FAR_THRESHOLD_M      = 1000.0  # > 1000m → score = 0.0
GEO_NEUTRAL_SCORE        = 0.3     # Score when one or both records have no coordinates
GEO_NAME_DRIFT_THRESHOLD = 200.0   # Flag if coordinates change > 200m between refreshes

# Geohash precision levels
GEOHASH_BLOCKING_PRECISION = 6   # ~1.2km × 0.6km cells for blocking
GEOHASH_STORAGE_PRECISION  = 7   # ~150m × 150m for spatial lookup

# ═══════════════════════════════════════════════════════════
# REFRESH FREQUENCIES
# ═══════════════════════════════════════════════════════════

REFRESH_FREQUENCIES: dict[str, timedelta] = {
    "cre_prices": timedelta(days=1),   # Daily — prices change every day
    "cre_places": timedelta(weeks=1),  # Weekly — station roster rarely changes
    "osm":        timedelta(weeks=1),  # Weekly — community edits accumulate
    "denue":      timedelta(days=30),  # Monthly — INEGI publishes quarterly
    "brand":      timedelta(weeks=1),  # Weekly — brand locator pages
    "google":     None,                # On-demand only — never bulk
}

# ═══════════════════════════════════════════════════════════
# DELTA DETECTION
# ═══════════════════════════════════════════════════════════

# Fields to EXCLUDE from content hash (these changing should NOT trigger re-processing)
DELTA_EXCLUDE_FIELDS = {"fetched_at", "batch_id", "content_hash"}

# ═══════════════════════════════════════════════════════════
# QUALITY CHECK THRESHOLDS
# ═══════════════════════════════════════════════════════════

QA_DUPLICATE_PL_GEO_THRESHOLD_M     = 5000.0  # QA-02: same PL, stations > 5km apart
QA_STALE_ACTIVE_DAYS                = 90       # QA-06: no refresh in this many days
QA_LOW_CONFIDENCE_THRESHOLD         = 0.50     # QA-09: confidence below this
QA_ORPHAN_STAGING_DAYS              = 14       # QA-10: staging records older than this
QA_NAME_DRIFT_TOKEN_OVERLAP_MIN     = 0.40     # QA-08: minimum token overlap to avoid drift flag
QA_COORDINATE_PRECISION_DECIMAL_MIN = 4        # Minimum decimal places for "high precision" coords

# ═══════════════════════════════════════════════════════════
# HTTP CLIENT SETTINGS
# ═══════════════════════════════════════════════════════════

HTTP_TIMEOUT_SECONDS  = 30.0
HTTP_RETRY_ATTEMPTS   = 3
HTTP_RETRY_WAIT_MIN   = 4      # seconds
HTTP_RETRY_WAIT_MAX   = 60     # seconds
HTTP_USER_AGENT       = "GasolinaInteligente/1.0 Pipeline (+https://github.com/example/gasolina-inteligente)"

# Rate limiting
OSM_REQUESTS_PER_MINUTE  = 2   # Overpass API courtesy limit
BRAND_REQUESTS_PER_SECOND = 0.5  # 1 request per 2 seconds for brand scrapers

# Circuit breaker
CIRCUIT_BREAKER_MAX_FAILURES = 5  # Skip source after this many consecutive failures

# ═══════════════════════════════════════════════════════════
# EXPORT SETTINGS
# ═══════════════════════════════════════════════════════════

EXPORT_JSON_FILENAME_TEMPLATE  = "stations_{date}.json"
EXPORT_CSV_FILENAME_TEMPLATE   = "stations_{date}.csv"
EXPORT_LATEST_JSON             = EXPORTS_DIR / "stations_latest.json"
EXPORT_LATEST_CSV              = EXPORTS_DIR / "stations_latest.csv"

# ═══════════════════════════════════════════════════════════
# LOGGING
# ═══════════════════════════════════════════════════════════

LOG_LEVEL       = os.environ.get("LOG_LEVEL", "INFO")
LOG_FORMAT      = "%(asctime)s %(levelname)s %(name)s %(message)s"
LOG_DATE_FORMAT = "%Y-%m-%dT%H:%M:%S"

# ═══════════════════════════════════════════════════════════
# MOCK / TEST MODE
# ═══════════════════════════════════════════════════════════

MOCK_MODE = os.environ.get("GI_MOCK", "false").lower() == "true"

# Number of mock stations to generate in test mode
MOCK_STATION_COUNT = 100
