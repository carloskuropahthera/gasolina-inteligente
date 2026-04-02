"""
storage/staging_zone.py — Staging table upsert and query operations.

Converts normalized StagingStation objects to ORM rows and back.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

import structlog
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from models.station import StagingStation
from normalize.brands import normalize_brand
from normalize.address import normalize_address, normalize_state, normalize_municipality, normalize_zip
from normalize.geo import compute_geohash, get_blocking_geohash, get_coordinate_precision
from normalize.text import normalize_name
from storage.schema import (
    StgBrandStation,
    StgCREStation,
    StgDENUEStation,
    StgOSMStation,
)
from storage.raw_zone import _record_hash

log = structlog.get_logger(__name__)

# Source → ORM class mapping
SOURCE_TABLE_MAP = {
    "cre":   StgCREStation,
    "osm":   StgOSMStation,
    "denue": StgDENUEStation,
    "brand": StgBrandStation,
}


# ═══════════════════════════════════════════════════════════
# NORMALIZATION PIPELINE
# (Converts a StagingStation with raw fields → adds norm_* fields)
# ═══════════════════════════════════════════════════════════

def normalize_staging_station(station: StagingStation) -> StagingStation:
    """
    Run all normalization functions on a StagingStation's raw fields.
    Populates all norm_* fields and geo fields in-place (returns new instance).
    """
    norm_data = station.model_dump()

    # Name normalization
    norm_data["norm_name"] = normalize_name(station.raw_name)

    # Brand normalization
    norm_data["norm_brand"] = normalize_brand(station.raw_brand)

    # Address normalization
    norm_data["norm_address"] = normalize_address(station.raw_address)

    # Geographic normalization
    norm_data["norm_municipality"] = normalize_municipality(station.raw_municipality)
    norm_data["norm_state"]        = normalize_state(station.raw_state)
    norm_data["norm_zip"]          = normalize_zip(station.raw_zip)

    # Geohash (requires valid coordinates)
    norm_data["geohash6"]        = get_blocking_geohash(station.lat, station.lng)
    norm_data["geohash7"]        = compute_geohash(station.lat, station.lng, precision=7)
    norm_data["coord_precision"] = get_coordinate_precision(station.lat, station.lng)

    # Content hash for delta detection
    raw_fields = {
        "raw_name":         station.raw_name,
        "raw_brand":        station.raw_brand,
        "raw_address":      station.raw_address,
        "raw_municipality": station.raw_municipality,
        "raw_state":        station.raw_state,
        "raw_zip":          station.raw_zip,
        "lat":              station.lat,
        "lng":              station.lng,
    }
    norm_data["content_hash"] = _record_hash(raw_fields)

    return StagingStation(**norm_data)


# ═══════════════════════════════════════════════════════════
# STAGING STATION → ORM DICT CONVERTER
# ═══════════════════════════════════════════════════════════

def _station_to_orm_dict(station: StagingStation) -> dict:
    """Convert a StagingStation to a dict suitable for ORM insertion."""
    base = {
        "id":               station.id,
        "source":           station.source,
        "raw_name":         station.raw_name,
        "raw_brand":        station.raw_brand,
        "raw_address":      station.raw_address,
        "raw_municipality": station.raw_municipality,
        "raw_state":        station.raw_state,
        "lat":              station.lat,
        "lng":              station.lng,
        "norm_name":        station.norm_name,
        "norm_brand":       station.norm_brand,
        "norm_address":     station.norm_address,
        "norm_municipality": station.norm_municipality,
        "norm_state":       station.norm_state,
        "geohash6":         station.geohash6,
        "geohash7":         station.geohash7,
        "coord_precision":  station.coord_precision,
        "content_hash":     station.content_hash,
        "fetched_at":       station.fetched_at,
        "batch_id":         station.batch_id,
    }

    # raw_zip / norm_zip not present in OSM table (no zip data in Overpass)
    if station.source != "osm":
        base["raw_zip"]  = station.raw_zip
        base["norm_zip"] = station.norm_zip

    # Source-specific fields
    if station.source == "cre":
        base["cre_place_id"] = station.cre_place_id
        base["cre_id"]       = station.cre_id
    elif station.source == "osm":
        base["osm_id"]   = station.osm_id
        base["osm_type"] = station.osm_type
        # Store tags as JSON string
        base["tags"] = None  # Tags are not on StagingStation model directly
    elif station.source == "denue":
        base["denue_id"] = station.denue_id
        base["scian_code"] = "46411"
    elif station.source == "brand":
        base["brand_source"] = station.brand_source
        base["external_id"]  = station.external_id

    return base


# ═══════════════════════════════════════════════════════════
# UPSERT OPERATIONS
# ═══════════════════════════════════════════════════════════

def upsert_staging(
    session: Session,
    stations: list[StagingStation],
    normalize: bool = True,
) -> tuple[int, int]:
    """
    Upsert a list of StagingStation records into the appropriate staging table.
    If normalize=True, runs the normalization pipeline first.

    Returns:
        (inserted_count, updated_count) tuple.
    """
    if not stations:
        return 0, 0

    if normalize:
        stations = [normalize_staging_station(s) for s in stations]

    # Group by source
    by_source: dict[str, list[StagingStation]] = {}
    for s in stations:
        by_source.setdefault(s.source, []).append(s)

    total_inserted = 0
    total_updated  = 0

    for source, source_stations in by_source.items():
        orm_class = SOURCE_TABLE_MAP.get(source)
        if orm_class is None:
            log.warning("upsert_staging_unknown_source", source=source)
            continue

        rows = [_station_to_orm_dict(s) for s in source_stations]

        # SQLite upsert in chunks to avoid "too many SQL variables" (limit ~999)
        # Each CRE row has ~24 columns → batch of 40 rows = ~960 variables
        BATCH_SIZE = 40
        for i in range(0, len(rows), BATCH_SIZE):
            chunk = rows[i : i + BATCH_SIZE]
            stmt = sqlite_insert(orm_class).values(chunk)
            stmt = stmt.on_conflict_do_update(
                index_elements=["id"],
                set_={
                    col: stmt.excluded[col]
                    for col in chunk[0].keys()
                    if col != "id"
                },
            )
            session.execute(stmt)
        # SQLite doesn't distinguish inserts vs updates in rowcount
        total_inserted += len(rows)

        log.info(
            "staging_upsert",
            source=source,
            rows=len(rows),
            table=orm_class.__tablename__,
        )

    session.flush()
    return total_inserted, total_updated


# ═══════════════════════════════════════════════════════════
# QUERY OPERATIONS
# ═══════════════════════════════════════════════════════════

def get_all_staging_records(session: Session) -> list[StagingStation]:
    """
    Retrieve all staging records from all source tables.
    Converts ORM rows back to StagingStation objects for use in blocking.
    """
    all_stations: list[StagingStation] = []

    for source, orm_class in SOURCE_TABLE_MAP.items():
        rows = session.query(orm_class).all()
        for row in rows:
            station = _orm_row_to_staging(row, source)
            all_stations.append(station)

    log.info("get_all_staging_records", total=len(all_stations))
    return all_stations


def get_staging_by_ids(
    session: Session,
    ids: list[str],
    source: Optional[str] = None,
) -> list[StagingStation]:
    """Retrieve staging records by their IDs."""
    tables = [SOURCE_TABLE_MAP[source]] if source else list(SOURCE_TABLE_MAP.values())
    results: list[StagingStation] = []

    for orm_class in tables:
        src = next(k for k, v in SOURCE_TABLE_MAP.items() if v == orm_class)
        rows = session.query(orm_class).filter(orm_class.id.in_(ids)).all()
        results.extend(_orm_row_to_staging(r, src) for r in rows)

    return results


def get_staging_batch(
    session: Session,
    batch_id: str,
    source: Optional[str] = None,
) -> list[StagingStation]:
    """Retrieve all staging records from a specific batch."""
    tables = {source: SOURCE_TABLE_MAP[source]} if source else SOURCE_TABLE_MAP
    results: list[StagingStation] = []

    for src, orm_class in tables.items():
        rows = session.query(orm_class).filter(orm_class.batch_id == batch_id).all()
        results.extend(_orm_row_to_staging(r, src) for r in rows)

    return results


def _orm_row_to_staging(row: object, source: str) -> StagingStation:
    """Convert an ORM row object to a StagingStation model."""
    d = {c.key: getattr(row, c.key) for c in row.__mapper__.columns}
    # Ensure required fields exist
    d.setdefault("source", source)
    d.setdefault("batch_id", "")
    return StagingStation(**{k: v for k, v in d.items() if k in StagingStation.model_fields})
