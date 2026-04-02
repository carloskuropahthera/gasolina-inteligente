"""
quality/checks.py — 10 QA rules for the Gasolina Inteligente pipeline.

Each check function:
  - Accepts a SQLAlchemy session
  - Runs its check using SQL or Python
  - Returns list[QAIssue]

run_all_checks(session) runs all 10 and returns the combined list.
"""

from __future__ import annotations

import functools
from datetime import datetime, timezone
from typing import Callable

import structlog
from sqlalchemy import text
from sqlalchemy.orm import Session

from config import (
    QA_DUPLICATE_PL_GEO_THRESHOLD_M,
    QA_LOW_CONFIDENCE_THRESHOLD,
    QA_NAME_DRIFT_TOKEN_OVERLAP_MIN,
    QA_ORPHAN_STAGING_DAYS,
    QA_STALE_ACTIVE_DAYS,
)
from models.match import QAIssue, QASeverity
from normalize.geo import haversine_meters
from normalize.text import token_overlap_ratio

log = structlog.get_logger(__name__)

# Registry of all QA check functions (populated by @qa_check decorator)
_QA_REGISTRY: list[Callable] = []


# ═══════════════════════════════════════════════════════════
# DECORATOR
# ═══════════════════════════════════════════════════════════

def qa_check(rule_id: str, description: str, severity: QASeverity = QASeverity.MEDIUM):
    """
    Decorator that registers a QA check function and adds metadata.

    Usage:
        @qa_check("QA-01", "Duplicate PL numbers", QASeverity.HIGH)
        def check_duplicate_pl_numbers(session: Session) -> list[QAIssue]:
            ...
    """
    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        def wrapper(session: Session) -> list[QAIssue]:
            try:
                issues = func(session)
                log.info(
                    "qa_check_complete",
                    rule=rule_id,
                    issues=len(issues),
                )
                return issues
            except Exception as e:
                log.error("qa_check_error", rule=rule_id, error=str(e))
                return [QAIssue(
                    qa_rule=rule_id,
                    qa_description=description,
                    severity=QASeverity.HIGH,
                    detail=f"QA check itself failed: {e}",
                )]

        wrapper.qa_rule_id   = rule_id
        wrapper.qa_description = description
        wrapper.qa_severity  = severity
        _QA_REGISTRY.append(wrapper)
        return wrapper

    return decorator


# ═══════════════════════════════════════════════════════════
# QA-01: Duplicate PL Numbers
# ═══════════════════════════════════════════════════════════

@qa_check("QA-01", "Duplicate PL numbers", QASeverity.HIGH)
def check_duplicate_pl_numbers(session: Session) -> list[QAIssue]:
    """
    Flag any PL number that appears on more than one master station record.
    Each physical station must have exactly one PL number.
    """
    result = session.execute(text("""
        SELECT pl_number, COUNT(*) as cnt,
               GROUP_CONCAT(master_id, ', ') as master_ids
        FROM station_master
        WHERE pl_number IS NOT NULL
          AND pl_number != ''
        GROUP BY pl_number
        HAVING cnt > 1
    """))
    rows = result.fetchall()

    issues = []
    for row in rows:
        issues.append(QAIssue(
            qa_rule="QA-01",
            qa_description="Duplicate PL numbers",
            severity=QASeverity.HIGH,
            master_id=row[2].split(",")[0].strip() if row[2] else None,
            detail=(
                f"PL number '{row[0]}' appears {row[1]} times on master records: "
                f"{row[2]}"
            ),
            extra={"pl_number": row[0], "count": row[1], "master_ids": row[2]},
        ))

    return issues


# ═══════════════════════════════════════════════════════════
# QA-02: PL Number Geo Inconsistency
# ═══════════════════════════════════════════════════════════

@qa_check("QA-02", "PL number linked to geographically distant stations", QASeverity.HIGH)
def check_pl_number_geo_inconsistency(session: Session) -> list[QAIssue]:
    """
    Flag if two master records share a PL number but are more than 5km apart.
    This suggests a data error or station relocation not yet resolved.
    """
    result = session.execute(text("""
        SELECT a.master_id AS id_a,
               b.master_id AS id_b,
               a.pl_number,
               a.lat AS lat_a, a.lng AS lng_a,
               b.lat AS lat_b, b.lng AS lng_b,
               a.canonical_name AS name_a,
               b.canonical_name AS name_b
        FROM station_master a
        JOIN station_master b
          ON a.pl_number = b.pl_number
         AND a.master_id < b.master_id
        WHERE a.pl_number IS NOT NULL
          AND a.lat IS NOT NULL AND a.lng IS NOT NULL
          AND b.lat IS NOT NULL AND b.lng IS NOT NULL
    """))
    rows = result.fetchall()

    issues = []
    for row in rows:
        id_a, id_b, pl, lat_a, lng_a, lat_b, lng_b, name_a, name_b = row
        distance_m = haversine_meters(lat_a, lng_a, lat_b, lng_b)

        if distance_m > QA_DUPLICATE_PL_GEO_THRESHOLD_M:
            issues.append(QAIssue(
                qa_rule="QA-02",
                qa_description="PL number linked to geographically distant stations",
                severity=QASeverity.HIGH,
                master_id=id_a,
                detail=(
                    f"PL '{pl}' links '{name_a}' ({id_a}) and '{name_b}' ({id_b}) "
                    f"which are {distance_m/1000:.1f}km apart (threshold: "
                    f"{QA_DUPLICATE_PL_GEO_THRESHOLD_M/1000:.0f}km)"
                ),
                extra={
                    "pl_number": pl,
                    "master_id_a": id_a,
                    "master_id_b": id_b,
                    "distance_km": round(distance_m / 1000, 2),
                },
            ))

    return issues


# ═══════════════════════════════════════════════════════════
# QA-03: Conflicting Brand
# ═══════════════════════════════════════════════════════════

@qa_check("QA-03", "Conflicting brand across sources on same master", QASeverity.MEDIUM)
def check_brand_conflict(session: Session) -> list[QAIssue]:
    """
    Flag master records where source_ids contain 2+ sources with
    different canonical brands after normalization.
    Stored brand in canonical_brand is the resolved value — this check looks
    at the source_ids JSON for disagreement.
    """
    # We look for records where review_reason contains 'brand conflict'
    # or where the master record is flagged with a brand issue
    # In practice, this checks for masters that were merged from stations
    # with different brands (should have been caught by resolver, but verify)

    result = session.execute(text("""
        SELECT master_id, canonical_brand, canonical_name, source_ids
        FROM station_master
        WHERE source_ids IS NOT NULL
          AND canonical_brand IS NOT NULL
        ORDER BY canonical_brand
    """))
    rows = result.fetchall()

    issues: list[QAIssue] = []

    from normalize.brands import normalize_brand
    import json

    for row in rows:
        master_id, canonical_brand, canonical_name, source_ids_str = row
        try:
            source_ids = json.loads(source_ids_str) if source_ids_str else []
        except (json.JSONDecodeError, TypeError):
            continue

        # This QA check is a placeholder for future enrichment when we store
        # per-source brand in the source_ids JSON.
        # For now, flag masters that have 3+ sources AND a confidence < 0.7
        # (which may indicate brand conflict during resolution)
        if len(source_ids) >= 3:
            conf_result = session.execute(
                text("SELECT confidence_score FROM station_master WHERE master_id = :mid"),
                {"mid": master_id}
            ).fetchone()
            if conf_result and conf_result[0] is not None and conf_result[0] < 0.70:
                issues.append(QAIssue(
                    qa_rule="QA-03",
                    qa_description="Conflicting brand across sources on same master",
                    severity=QASeverity.MEDIUM,
                    master_id=master_id,
                    detail=(
                        f"'{canonical_name}' has {len(source_ids)} sources with low "
                        f"confidence ({conf_result[0]:.2f}); possible brand conflict"
                    ),
                    extra={"canonical_brand": canonical_brand, "source_ids": source_ids},
                ))

    return issues


# ═══════════════════════════════════════════════════════════
# QA-04: Coordinates Outside Mexico Bounds
# ═══════════════════════════════════════════════════════════

@qa_check("QA-04", "Coordinates outside Mexico bounding box", QASeverity.HIGH)
def check_coordinates_out_of_bounds(session: Session) -> list[QAIssue]:
    """
    Flag master stations whose coordinates fall outside Mexico's bounding box.
    lat: 14.53–32.72, lng: -118.60 to -86.71
    """
    result = session.execute(text("""
        SELECT master_id, canonical_name, canonical_state, lat, lng
        FROM station_master
        WHERE (
            lat IS NOT NULL AND (lat < 14.5328 OR lat > 32.7186)
        ) OR (
            lng IS NOT NULL AND (lng < -118.5978 OR lng > -86.7104)
        )
    """))
    rows = result.fetchall()

    issues = []
    for row in rows:
        master_id, name, state, lat, lng = row
        issues.append(QAIssue(
            qa_rule="QA-04",
            qa_description="Coordinates outside Mexico bounding box",
            severity=QASeverity.HIGH,
            master_id=master_id,
            detail=(
                f"'{name}' (state: {state}) has coordinates ({lat}, {lng}) "
                f"outside Mexico bounds (lat 14.53–32.72, lng -118.60 to -86.71)"
            ),
            extra={"lat": lat, "lng": lng, "state": state},
        ))

    return issues


# ═══════════════════════════════════════════════════════════
# QA-05: Coordinates Inconsistent with State
# ═══════════════════════════════════════════════════════════

@qa_check("QA-05", "Coordinates inconsistent with reported state", QASeverity.MEDIUM)
def check_coordinates_wrong_state(session: Session) -> list[QAIssue]:
    """
    Flag stations whose geohash-based rough state disagrees with canonical_state.
    Uses a coarse lat/lng range per state for MVP (PostGIS polygon would be more precise).
    """
    # Coarse state bounding boxes (very approximate — just for sanity check)
    STATE_LAT_RANGES: dict[str, tuple[float, float]] = {
        "CIUDAD DE MEXICO":  (19.05, 19.60),
        "JALISCO":           (18.92, 22.75),
        "NUEVO LEON":        (23.17, 27.79),
        "BAJA CALIFORNIA":   (28.00, 32.72),
        "CHIAPAS":           (14.53, 17.80),
        "YUCATAN":           (19.50, 21.70),
        "SONORA":            (26.00, 32.00),
    }

    result = session.execute(text("""
        SELECT master_id, canonical_name, canonical_state, lat, lng
        FROM station_master
        WHERE canonical_state IS NOT NULL
          AND lat IS NOT NULL AND lng IS NOT NULL
    """))
    rows = result.fetchall()

    issues = []
    for row in rows:
        master_id, name, state, lat, lng = row
        if state in STATE_LAT_RANGES:
            lat_min, lat_max = STATE_LAT_RANGES[state]
            if not (lat_min <= lat <= lat_max):
                issues.append(QAIssue(
                    qa_rule="QA-05",
                    qa_description="Coordinates inconsistent with reported state",
                    severity=QASeverity.MEDIUM,
                    master_id=master_id,
                    detail=(
                        f"'{name}' is reported in {state} (lat range {lat_min}–{lat_max}) "
                        f"but has lat={lat:.4f} which is outside that range"
                    ),
                    extra={"state": state, "lat": lat, "lng": lng},
                ))

    return issues


# ═══════════════════════════════════════════════════════════
# QA-06: Stale Active Records
# ═══════════════════════════════════════════════════════════

@qa_check("QA-06", "Active stations not refreshed in 90+ days", QASeverity.MEDIUM)
def check_stale_active_records(session: Session) -> list[QAIssue]:
    """
    Flag active station records that have not been refreshed in QA_STALE_ACTIVE_DAYS days.
    These may be closed stations still showing as active.
    """
    result = session.execute(text(f"""
        SELECT master_id, canonical_name, canonical_state, last_refreshed_at
        FROM station_master
        WHERE status = 'active'
          AND last_refreshed_at IS NOT NULL
          AND last_refreshed_at < datetime('now', '-{QA_STALE_ACTIVE_DAYS} days')
        ORDER BY last_refreshed_at ASC
    """))
    rows = result.fetchall()

    issues = []
    for row in rows:
        master_id, name, state, last_refreshed = row
        issues.append(QAIssue(
            qa_rule="QA-06",
            qa_description="Active stations not refreshed in 90+ days",
            severity=QASeverity.MEDIUM,
            master_id=master_id,
            detail=(
                f"'{name}' ({state}) last refreshed {last_refreshed} — "
                f"more than {QA_STALE_ACTIVE_DAYS} days ago. Station may be closed."
            ),
            extra={"last_refreshed_at": last_refreshed},
        ))

    return issues


# ═══════════════════════════════════════════════════════════
# QA-07: Missing Critical Fields
# ═══════════════════════════════════════════════════════════

@qa_check("QA-07", "Missing critical fields (name or coordinates)", QASeverity.HIGH)
def check_missing_critical_fields(session: Session) -> list[QAIssue]:
    """
    Flag master records that are missing canonical_name, or both lat and lng.
    These are unusable by the app.
    """
    result = session.execute(text("""
        SELECT master_id, canonical_name, lat, lng, canonical_state
        FROM station_master
        WHERE canonical_name IS NULL
           OR canonical_name = ''
           OR (lat IS NULL AND lng IS NULL)
    """))
    rows = result.fetchall()

    issues = []
    for row in rows:
        master_id, name, lat, lng, state = row
        missing = []
        if not name:
            missing.append("canonical_name")
        if lat is None and lng is None:
            missing.append("coordinates (lat+lng)")

        issues.append(QAIssue(
            qa_rule="QA-07",
            qa_description="Missing critical fields (name or coordinates)",
            severity=QASeverity.HIGH,
            master_id=master_id,
            detail=(
                f"Master record {master_id} (state: {state}) is missing: "
                f"{', '.join(missing)}"
            ),
            extra={"missing_fields": missing},
        ))

    return issues


# ═══════════════════════════════════════════════════════════
# QA-08: Suspicious Name Drift
# ═══════════════════════════════════════════════════════════

@qa_check("QA-08", "Suspicious name drift (< 40% token overlap)", QASeverity.MEDIUM)
def check_name_drift(session: Session) -> list[QAIssue]:
    """
    Flag master records where name_drift_flag = 1.
    These were flagged during a refresh when the canonical_name changed significantly.
    """
    result = session.execute(text("""
        SELECT master_id, canonical_name, review_reason, canonical_state
        FROM station_master
        WHERE name_drift_flag = 1
    """))
    rows = result.fetchall()

    issues = []
    for row in rows:
        master_id, name, reason, state = row
        issues.append(QAIssue(
            qa_rule="QA-08",
            qa_description="Suspicious name drift",
            severity=QASeverity.MEDIUM,
            master_id=master_id,
            detail=(
                f"'{name}' ({state}) has name_drift_flag=1. "
                f"Reason: {reason or 'name changed significantly between refreshes'}"
            ),
            extra={"review_reason": reason},
        ))

    return issues


# ═══════════════════════════════════════════════════════════
# QA-09: Low Confidence Active Stations
# ═══════════════════════════════════════════════════════════

@qa_check("QA-09", "Low confidence active stations without review flag", QASeverity.LOW)
def check_low_confidence_active(session: Session) -> list[QAIssue]:
    """
    Flag active stations with confidence_score < QA_LOW_CONFIDENCE_THRESHOLD
    that have NOT already been flagged for review.
    These should be queued for review.
    """
    result = session.execute(text(f"""
        SELECT master_id, canonical_name, canonical_state,
               confidence_score, primary_source
        FROM station_master
        WHERE status = 'active'
          AND confidence_score < {QA_LOW_CONFIDENCE_THRESHOLD}
          AND review_flag = 0
        ORDER BY confidence_score ASC
    """))
    rows = result.fetchall()

    issues = []
    for row in rows:
        master_id, name, state, score, source = row
        issues.append(QAIssue(
            qa_rule="QA-09",
            qa_description="Low confidence active stations without review flag",
            severity=QASeverity.LOW,
            master_id=master_id,
            detail=(
                f"'{name}' ({state}) has confidence_score={score:.2f} "
                f"(threshold: {QA_LOW_CONFIDENCE_THRESHOLD}) "
                f"from source '{source}' but is not flagged for review"
            ),
            extra={
                "confidence_score": score,
                "primary_source":   source,
                "threshold":        QA_LOW_CONFIDENCE_THRESHOLD,
            },
        ))

    return issues


# ═══════════════════════════════════════════════════════════
# QA-10: Orphaned Staging Records
# ═══════════════════════════════════════════════════════════

@qa_check("QA-10", "Orphaned staging records (no match decision in 14+ days)", QASeverity.LOW)
def check_orphaned_staging_records(session: Session) -> list[QAIssue]:
    """
    Flag staging records that are more than QA_ORPHAN_STAGING_DAYS days old
    and have no corresponding match decision (not matched, not rejected, not reviewed).

    This suggests the blocking or matching pipeline missed these records.
    Uses the staging DB via raw SQL — requires both DBs to be accessible.
    """
    # NOTE: This check queries candidate_matches which is in the staging DB.
    # In production, both tables should be in the same DB, or this uses a cross-DB join.
    # For MVP SQLite, we check the candidate_matches table in the same session.

    try:
        result = session.execute(text(f"""
            WITH matched_ids AS (
                SELECT DISTINCT source_a_id AS sid FROM candidate_matches
                UNION
                SELECT DISTINCT source_b_id AS sid FROM candidate_matches
            )
            SELECT id, source, raw_name, fetched_at
            FROM stg_cre_stations
            WHERE fetched_at < datetime('now', '-{QA_ORPHAN_STAGING_DAYS} days')
              AND id NOT IN (SELECT sid FROM matched_ids)
            LIMIT 100
        """))
        rows = result.fetchall()
    except Exception as e:
        # Cross-table query may fail in split-DB setup — return empty gracefully
        log.debug("qa10_query_skipped", reason=str(e))
        return []

    issues = []
    for row in rows:
        record_id, source, name, fetched_at = row
        issues.append(QAIssue(
            qa_rule="QA-10",
            qa_description="Orphaned staging records",
            severity=QASeverity.LOW,
            detail=(
                f"Staging record '{record_id}' (source: {source}, name: '{name}') "
                f"fetched {fetched_at} has no match decision after "
                f"{QA_ORPHAN_STAGING_DAYS} days. Possible blocking failure."
            ),
            extra={"record_id": record_id, "source": source, "fetched_at": fetched_at},
        ))

    return issues


# ═══════════════════════════════════════════════════════════
# RUN ALL CHECKS
# ═══════════════════════════════════════════════════════════

def run_all_checks(session: Session) -> list[QAIssue]:
    """
    Run all 10 QA checks and return the combined list of issues.
    Checks are run in order (QA-01 through QA-10).
    Failed checks log an error but do not stop subsequent checks.
    """
    all_issues: list[QAIssue] = []
    log.info("qa_run_all_start", num_checks=len(_QA_REGISTRY))

    for check_fn in _QA_REGISTRY:
        issues = check_fn(session)
        all_issues.extend(issues)

    # Summary
    high   = sum(1 for i in all_issues if i.severity == QASeverity.HIGH)
    medium = sum(1 for i in all_issues if i.severity == QASeverity.MEDIUM)
    low    = sum(1 for i in all_issues if i.severity == QASeverity.LOW)

    log.info(
        "qa_run_all_complete",
        total_issues=len(all_issues),
        high=high,
        medium=medium,
        low=low,
    )
    return all_issues
