"""
storage/curated_zone.py — Master table upsert logic and curated zone operations.

Converts MatchDecision results into MasterStation records.
Computes final confidence scores with bonuses and penalties.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Optional

import structlog
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from config import (
    CONFIDENCE_BONUS_3_SOURCES,
    CONFIDENCE_BONUS_PL_NUMBER,
    CONFIDENCE_PENALTY_NAME_DRIFT,
    CONFIDENCE_PENALTY_REVIEW,
    CONFIDENCE_PENALTY_STALE_30,
    CONFIDENCE_PENALTY_STALE_90,
)
from models.match import MatchDecision, DecisionType, ReviewQueueItem
from models.station import MasterStation, SourceRef
from normalize.geo import compute_geohash
from storage.schema import (
    MatchDecisionORM,
    ReviewQueueORM,
    SourceRefreshAudit,
    StationMaster,
)

log = structlog.get_logger(__name__)


# ═══════════════════════════════════════════════════════════
# CONFIDENCE SCORE COMPUTATION
# ═══════════════════════════════════════════════════════════

def compute_master_confidence(
    base_score: float,
    pl_number: Optional[str],
    source_count: int,
    last_confirmed_at: Optional[str],
    name_drift_flag: int,
    review_flag: int,
    has_valid_coords: bool = False,
) -> float:
    """
    Compute the final confidence score for a master station record.

    Args:
        base_score: The composite match score (0.0–1.0)
        pl_number: CRE permit number (None if not linked)
        source_count: Number of independent sources confirming this station
        last_confirmed_at: ISO timestamp of last confirmation
        name_drift_flag: 1 if name changed significantly
        review_flag: 1 if station needs human review
        has_valid_coords: True if coordinates are validated

    Returns:
        Final confidence score clamped to [0.0, 1.0]
    """
    score = base_score

    # Bonuses
    if pl_number:
        score += CONFIDENCE_BONUS_PL_NUMBER

    if source_count >= 3:
        score += CONFIDENCE_BONUS_3_SOURCES

    if has_valid_coords:
        score += 0.03  # CONFIDENCE_BONUS_GEO_VALID

    # Staleness penalties
    if last_confirmed_at:
        try:
            confirmed_dt = datetime.fromisoformat(last_confirmed_at.replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            age_days = (now - confirmed_dt).days
            if age_days > 90:
                score += CONFIDENCE_PENALTY_STALE_90
            elif age_days > 30:
                score += CONFIDENCE_PENALTY_STALE_30
        except (ValueError, TypeError):
            pass

    # Flag penalties
    if name_drift_flag:
        score += CONFIDENCE_PENALTY_NAME_DRIFT

    if review_flag:
        score += CONFIDENCE_PENALTY_REVIEW

    return round(max(0.0, min(1.0, score)), 4)


# ═══════════════════════════════════════════════════════════
# MASTER STATION BUILDER
# ═══════════════════════════════════════════════════════════

def build_master_from_pair(
    master_id: str,
    station_a_dict: dict,
    station_b_dict: dict,
    base_score: float,
) -> MasterStation:
    """
    Build a MasterStation from two matched staging station dicts.
    Uses source priority rules to determine which fields to prefer.
    """
    now = datetime.now(timezone.utc).isoformat()

    # Determine source priority (lower = more authoritative)
    from config import SOURCE_PRIORITY
    pri_a = SOURCE_PRIORITY.get(station_a_dict.get("source", ""), 99)
    pri_b = SOURCE_PRIORITY.get(station_b_dict.get("source", ""), 99)
    primary, secondary = (station_a_dict, station_b_dict) if pri_a <= pri_b else (station_b_dict, station_a_dict)

    def prefer(field: str) -> Optional[str]:
        """Return field from primary source, falling back to secondary."""
        return primary.get(field) or secondary.get(field)

    # Build source_ids list
    source_ids = []
    for s in [station_a_dict, station_b_dict]:
        source = s.get("source", "unknown")
        sid = s.get("id", "")
        if source and sid:
            source_ids.append(SourceRef(source=source, id=sid))

    # Extract CRE-specific fields
    cre_place_id = (station_a_dict.get("cre_place_id") or station_b_dict.get("cre_place_id"))
    cre_id       = (station_a_dict.get("cre_id")       or station_b_dict.get("cre_id"))
    denue_id     = (station_a_dict.get("denue_id")      or station_b_dict.get("denue_id"))
    osm_id       = (station_a_dict.get("osm_id")        or station_b_dict.get("osm_id"))

    # PL number mapping: CRE cre_id field contains the permit licence number
    # (format: PL/NNNN/EXP/ES/YYYY or numeric string from the places XML place_id).
    # Research notes (2026-03-31):
    #   - The /places XML returns place_id (numeric) and cre_id (PL/... format).
    #   - cre_id matches the official CRE permit registry format when present.
    #   - place_id is an internal CRE system ID, NOT the public permit number.
    #   - When cre_id starts with "PL/", it is a validated permit number.
    #   - Otherwise (numeric-only), it is an unverified internal ID — stored but
    #     flagged so QA-01 doesn't falsely count it as a duplicate permit.
    raw_pl = cre_id or ""
    if raw_pl.upper().startswith("PL/"):
        pl_number = raw_pl  # confirmed PL permit format
    elif raw_pl and raw_pl.isdigit():
        pl_number = f"CRE-{raw_pl}"  # internal ID — prefixed to distinguish from real PL numbers
    else:
        pl_number = None

    canonical_name = prefer("norm_name") or prefer("raw_name") or "UNKNOWN"
    lat = prefer("lat")
    lng = prefer("lng")

    confidence = compute_master_confidence(
        base_score=base_score,
        pl_number=pl_number,
        source_count=len(source_ids),
        last_confirmed_at=now,
        name_drift_flag=0,
        review_flag=0,
        has_valid_coords=(lat is not None and lng is not None),
    )

    return MasterStation(
        master_id=master_id,
        pl_number=pl_number,
        canonical_name=canonical_name,
        canonical_brand=prefer("norm_brand") or prefer("raw_brand"),
        canonical_address=prefer("norm_address") or prefer("raw_address"),
        canonical_municipality=prefer("norm_municipality") or prefer("raw_municipality"),
        canonical_state=prefer("norm_state") or prefer("raw_state"),
        canonical_zip=prefer("norm_zip") or prefer("raw_zip"),
        lat=float(lat) if lat is not None else None,
        lng=float(lng) if lng is not None else None,
        geohash=compute_geohash(lat, lng) if lat and lng else None,
        status="active",
        confidence_score=confidence,
        primary_source=primary.get("source", "unknown"),
        source_ids=source_ids,
        cre_place_id=cre_place_id,
        cre_id=cre_id,
        denue_id=denue_id,
        osm_id=osm_id,
        first_seen_at=now,
        last_confirmed_at=now,
        last_refreshed_at=now,
        name_drift_flag=0,
        review_flag=0,
        created_at=now,
        updated_at=now,
    )


# ═══════════════════════════════════════════════════════════
# SINGLE-SOURCE MASTER BUILDER (CRE as sole source)
# ═══════════════════════════════════════════════════════════

def build_master_from_single(station_dict: dict, master_id: Optional[str] = None) -> MasterStation:
    """
    Build a MasterStation from a single CRE staging record (no cross-source match required).
    CRE is the authoritative source (reliability=1.0), so single-source CRE stations
    are valid master records with a base confidence of 0.75 (source_reliability).
    """
    now = datetime.now(timezone.utc).isoformat()
    mid = master_id or str(uuid.uuid4())

    source = station_dict.get("source", "cre")
    cre_id = station_dict.get("cre_id")
    lat    = station_dict.get("lat")
    lng    = station_dict.get("lng")

    from config import SOURCE_RELIABILITY
    base_score = SOURCE_RELIABILITY.get(source, 0.5)

    confidence = compute_master_confidence(
        base_score=base_score,
        pl_number=cre_id,
        source_count=1,
        last_confirmed_at=now,
        name_drift_flag=0,
        review_flag=0,
        has_valid_coords=(lat is not None and lng is not None),
    )

    return MasterStation(
        master_id=mid,
        pl_number=cre_id,
        canonical_name=station_dict.get("norm_name") or station_dict.get("raw_name") or "UNKNOWN",
        canonical_brand=station_dict.get("norm_brand") or station_dict.get("raw_brand"),
        canonical_address=station_dict.get("norm_address") or station_dict.get("raw_address"),
        canonical_municipality=station_dict.get("norm_municipality") or station_dict.get("raw_municipality"),
        canonical_state=station_dict.get("norm_state") or station_dict.get("raw_state"),
        canonical_zip=station_dict.get("norm_zip") or station_dict.get("raw_zip"),
        lat=float(lat) if lat is not None else None,
        lng=float(lng) if lng is not None else None,
        geohash=compute_geohash(lat, lng) if lat and lng else None,
        status="active",
        confidence_score=confidence,
        primary_source=source,
        source_ids=[SourceRef(source=source, id=station_dict.get("id", ""))],
        cre_place_id=station_dict.get("cre_place_id"),
        cre_id=cre_id,
        denue_id=station_dict.get("denue_id"),
        osm_id=station_dict.get("osm_id"),
        first_seen_at=now,
        last_confirmed_at=now,
        last_refreshed_at=now,
        name_drift_flag=0,
        review_flag=0,
        created_at=now,
        updated_at=now,
    )


# ═══════════════════════════════════════════════════════════
# UPSERT MASTER STATION
# ═══════════════════════════════════════════════════════════

def upsert_master(session: Session, stations: list[MasterStation]) -> int:
    """
    Upsert MasterStation records into station_master table.
    Returns count of records processed.
    """
    if not stations:
        return 0

    rows = []
    for s in stations:
        rows.append({
            "master_id":              s.master_id,
            "pl_number":              s.pl_number,
            "canonical_name":         s.canonical_name,
            "canonical_brand":        s.canonical_brand,
            "canonical_address":      s.canonical_address,
            "canonical_municipality": s.canonical_municipality,
            "canonical_state":        s.canonical_state,
            "canonical_zip":          s.canonical_zip,
            "lat":                    s.lat,
            "lng":                    s.lng,
            "geohash":                s.geohash,
            "status":                 s.status,
            "confidence_score":       s.confidence_score,
            "primary_source":         s.primary_source,
            "source_ids":             json.dumps([r.model_dump() for r in s.source_ids]),
            "cre_place_id":           s.cre_place_id,
            "cre_id":                 s.cre_id,
            "denue_id":               s.denue_id,
            "osm_id":                 s.osm_id,
            "first_seen_at":          s.first_seen_at,
            "last_confirmed_at":      s.last_confirmed_at,
            "last_refreshed_at":      s.last_refreshed_at,
            "name_drift_flag":        s.name_drift_flag,
            "review_flag":            s.review_flag,
            "review_reason":          s.review_reason,
            "created_at":             s.created_at,
            "updated_at":             s.updated_at,
        })

    # Batch to avoid SQLite "too many SQL variables" (limit ~999)
    # Each master row has ~27 columns → batch of 36 rows = ~972 variables
    BATCH_SIZE = 36
    for i in range(0, len(rows), BATCH_SIZE):
        chunk = rows[i : i + BATCH_SIZE]
        stmt = sqlite_insert(StationMaster).values(chunk)
        stmt = stmt.on_conflict_do_update(
            index_elements=["master_id"],
            set_={
                "canonical_name":         stmt.excluded.canonical_name,
                "canonical_brand":        stmt.excluded.canonical_brand,
                "canonical_address":      stmt.excluded.canonical_address,
                "canonical_municipality": stmt.excluded.canonical_municipality,
                "canonical_state":        stmt.excluded.canonical_state,
                "canonical_zip":          stmt.excluded.canonical_zip,
                "lat":                    stmt.excluded.lat,
                "lng":                    stmt.excluded.lng,
                "geohash":                stmt.excluded.geohash,
                "confidence_score":       stmt.excluded.confidence_score,
                "source_ids":             stmt.excluded.source_ids,
                "last_confirmed_at":      stmt.excluded.last_confirmed_at,
                "last_refreshed_at":      stmt.excluded.last_refreshed_at,
                "updated_at":             stmt.excluded.updated_at,
            },
        )
        session.execute(stmt)
    session.flush()
    log.info("master_upsert", count=len(rows))
    return len(rows)


# ═══════════════════════════════════════════════════════════
# WRITE MATCH DECISIONS
# ═══════════════════════════════════════════════════════════

def write_match_decisions(session: Session, decisions: list[MatchDecision]) -> None:
    """Write match decision records to the match_decisions table."""
    if not decisions:
        return

    rows = [
        {
            "decision_id":    d.decision_id,
            "candidate_id":   d.candidate_id,
            "master_id":      d.master_id,
            "decision":       d.decision.value,
            "decided_by":     d.decided_by,
            "decided_at":     d.decided_at,
            "notes":          d.notes,
            "composite_score": d.composite_score,
        }
        for d in decisions
    ]

    stmt = sqlite_insert(MatchDecisionORM).values(rows)
    stmt = stmt.on_conflict_do_nothing(index_elements=["decision_id"])
    session.execute(stmt)
    session.flush()
    log.info("match_decisions_written", count=len(rows))


def write_review_items(session: Session, items: list[ReviewQueueItem]) -> None:
    """Write review queue items to the review_queue table."""
    if not items:
        return

    rows = [
        {
            "queue_id":      item.queue_id,
            "candidate_id":  item.candidate_id,
            "composite_score": item.composite_score,
            "priority":      item.priority,
            "status":        item.status,
            "assigned_to":   item.assigned_to,
            "created_at":    item.created_at,
            "resolved_at":   item.resolved_at,
        }
        for item in items
    ]

    stmt = sqlite_insert(ReviewQueueORM).values(rows)
    stmt = stmt.on_conflict_do_nothing(index_elements=["queue_id"])
    session.execute(stmt)
    session.flush()
    log.info("review_items_written", count=len(rows))


# ═══════════════════════════════════════════════════════════
# AUDIT LOGGING
# ═══════════════════════════════════════════════════════════

def write_audit(
    session: Session,
    source: str,
    batch_id: str,
    records_fetched: int = 0,
    records_new: int = 0,
    records_updated: int = 0,
    records_unchanged: int = 0,
    records_failed: int = 0,
    duration_seconds: float = 0.0,
    status: str = "success",
    error_message: Optional[str] = None,
) -> None:
    """Write a source_refresh_audit record."""
    now = datetime.now(timezone.utc).isoformat()
    row = {
        "audit_id":          str(uuid.uuid4()),
        "source":            source,
        "batch_id":          batch_id,
        "run_at":            now,
        "records_fetched":   records_fetched,
        "records_new":       records_new,
        "records_updated":   records_updated,
        "records_unchanged": records_unchanged,
        "records_failed":    records_failed,
        "duration_seconds":  round(duration_seconds, 3),
        "status":            status,
        "error_message":     error_message,
    }
    session.execute(sqlite_insert(SourceRefreshAudit).values([row]))
    session.flush()
    log.info(
        "audit_written",
        source=source,
        batch_id=batch_id,
        status=status,
        records_fetched=records_fetched,
        duration_s=round(duration_seconds, 2),
    )


# ═══════════════════════════════════════════════════════════
# QUERIES
# ═══════════════════════════════════════════════════════════

def get_all_master_stations(session: Session) -> list[dict]:
    """Retrieve all active master stations as plain dicts."""
    rows = session.query(StationMaster).filter(StationMaster.status == "active").all()
    return [
        {c.key: getattr(row, c.key) for c in row.__mapper__.columns}
        for row in rows
    ]


def get_review_queue(session: Session, status: str = "pending") -> list[dict]:
    """Retrieve review queue items with a given status."""
    rows = (
        session.query(ReviewQueueORM)
        .filter(ReviewQueueORM.status == status)
        .order_by(ReviewQueueORM.priority.asc())
        .all()
    )
    return [
        {c.key: getattr(row, c.key) for c in row.__mapper__.columns}
        for row in rows
    ]
