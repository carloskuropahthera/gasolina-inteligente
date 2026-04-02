"""
storage/schema.py — SQLAlchemy ORM table definitions for all pipeline tables.

Two declarative bases:
  - StagingBase: stg_* tables (in staging DB)
  - Base: all curated tables (in curated DB)
"""

from __future__ import annotations

from sqlalchemy import (
    Column,
    Float,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase


# ═══════════════════════════════════════════════════════════
# DECLARATIVE BASES
# ═══════════════════════════════════════════════════════════

class StagingBase(DeclarativeBase):
    """Base for all staging tables (lives in staging DB)."""
    pass


class Base(DeclarativeBase):
    """Base for all curated tables (lives in curated DB)."""
    pass


# ═══════════════════════════════════════════════════════════
# STAGING TABLES
# ═══════════════════════════════════════════════════════════

class StgCREStation(StagingBase):
    """Staging table for CRE Places API records."""
    __tablename__ = "stg_cre_stations"

    id                = Column(String, primary_key=True)
    source            = Column(String, default="cre")
    cre_place_id      = Column(String, nullable=True, index=True)
    cre_id            = Column(String, nullable=True, index=True)
    raw_name          = Column(Text, nullable=True)
    raw_brand         = Column(String, nullable=True)
    raw_address       = Column(Text, nullable=True)
    raw_municipality  = Column(String, nullable=True)
    raw_state         = Column(String, nullable=True)
    raw_zip           = Column(String, nullable=True)
    lat               = Column(Float, nullable=True)
    lng               = Column(Float, nullable=True)
    norm_name         = Column(Text, nullable=True)
    norm_brand        = Column(String, nullable=True)
    norm_address      = Column(Text, nullable=True)
    norm_municipality = Column(String, nullable=True)
    norm_state        = Column(String, nullable=True)
    norm_zip          = Column(String, nullable=True)
    geohash6          = Column(String, nullable=True, index=True)
    geohash7          = Column(String, nullable=True)
    coord_precision   = Column(String, nullable=True)
    content_hash      = Column(String, nullable=True)
    fetched_at        = Column(String, nullable=True)
    batch_id          = Column(String, nullable=True, index=True)

    __table_args__ = (
        Index("idx_stg_cre_state_mun", "norm_state", "norm_municipality"),
    )


class StgOSMStation(StagingBase):
    """Staging table for OpenStreetMap fuel station records."""
    __tablename__ = "stg_osm_stations"

    id                = Column(String, primary_key=True)
    source            = Column(String, default="osm")
    osm_id            = Column(String, nullable=True, index=True)
    osm_type          = Column(String, nullable=True)
    raw_name          = Column(Text, nullable=True)
    raw_brand         = Column(String, nullable=True)
    raw_address       = Column(Text, nullable=True)
    raw_municipality  = Column(String, nullable=True)
    raw_state         = Column(String, nullable=True)
    lat               = Column(Float, nullable=True)
    lng               = Column(Float, nullable=True)
    norm_name         = Column(Text, nullable=True)
    norm_brand        = Column(String, nullable=True)
    norm_address      = Column(Text, nullable=True)
    norm_municipality = Column(String, nullable=True)
    norm_state        = Column(String, nullable=True)
    tags              = Column(Text, nullable=True)    # JSON string
    geohash6          = Column(String, nullable=True, index=True)
    geohash7          = Column(String, nullable=True)
    coord_precision   = Column(String, nullable=True)
    content_hash      = Column(String, nullable=True)
    fetched_at        = Column(String, nullable=True)
    batch_id          = Column(String, nullable=True, index=True)

    __table_args__ = (
        Index("idx_stg_osm_state_mun", "norm_state", "norm_municipality"),
    )


class StgDENUEStation(StagingBase):
    """Staging table for INEGI DENUE records."""
    __tablename__ = "stg_denue_stations"

    id                = Column(String, primary_key=True)
    source            = Column(String, default="denue")
    denue_id          = Column(String, nullable=True, index=True)
    raw_name          = Column(Text, nullable=True)
    raw_brand         = Column(String, nullable=True)
    raw_address       = Column(Text, nullable=True)
    raw_municipality  = Column(String, nullable=True)
    raw_state         = Column(String, nullable=True)
    raw_zip           = Column(String, nullable=True)
    lat               = Column(Float, nullable=True)
    lng               = Column(Float, nullable=True)
    nom_estab         = Column(Text, nullable=True)
    raz_social        = Column(Text, nullable=True)
    norm_name         = Column(Text, nullable=True)
    norm_brand        = Column(String, nullable=True)
    norm_address      = Column(Text, nullable=True)
    norm_municipality = Column(String, nullable=True)
    norm_state        = Column(String, nullable=True)
    norm_zip          = Column(String, nullable=True)
    scian_code        = Column(String, nullable=True)
    geohash6          = Column(String, nullable=True, index=True)
    geohash7          = Column(String, nullable=True)
    coord_precision   = Column(String, nullable=True)
    content_hash      = Column(String, nullable=True)
    fetched_at        = Column(String, nullable=True)
    batch_id          = Column(String, nullable=True, index=True)

    __table_args__ = (
        Index("idx_stg_denue_state_mun", "norm_state", "norm_municipality"),
    )


class StgBrandStation(StagingBase):
    """Staging table for brand locator page records."""
    __tablename__ = "stg_brand_stations"

    id                = Column(String, primary_key=True)
    source            = Column(String, default="brand")
    brand_source      = Column(String, nullable=True)   # pemex | oxxo | shell | bp
    external_id       = Column(String, nullable=True)
    raw_name          = Column(Text, nullable=True)
    raw_brand         = Column(String, nullable=True)
    raw_address       = Column(Text, nullable=True)
    raw_municipality  = Column(String, nullable=True)
    raw_state         = Column(String, nullable=True)
    raw_zip           = Column(String, nullable=True)
    lat               = Column(Float, nullable=True)
    lng               = Column(Float, nullable=True)
    norm_name         = Column(Text, nullable=True)
    norm_brand        = Column(String, nullable=True)
    norm_address      = Column(Text, nullable=True)
    norm_municipality = Column(String, nullable=True)
    norm_state        = Column(String, nullable=True)
    norm_zip          = Column(String, nullable=True)
    geohash6          = Column(String, nullable=True, index=True)
    geohash7          = Column(String, nullable=True)
    coord_precision   = Column(String, nullable=True)
    content_hash      = Column(String, nullable=True)
    fetched_at        = Column(String, nullable=True)
    batch_id          = Column(String, nullable=True, index=True)

    __table_args__ = (
        Index("idx_stg_brand_state_mun", "norm_state", "norm_municipality"),
    )


class CandidateMatch(StagingBase):
    """Candidate pairs generated by the blocking step, with scores."""
    __tablename__ = "candidate_matches"

    candidate_id            = Column(String, primary_key=True)
    source_a_id             = Column(String, nullable=False, index=True)
    source_a_type           = Column(String, nullable=False)
    source_b_id             = Column(String, nullable=False, index=True)
    source_b_type           = Column(String, nullable=False)
    name_score              = Column(Float, nullable=True)
    geo_score               = Column(Float, nullable=True)
    brand_score             = Column(Float, nullable=True)
    address_score           = Column(Float, nullable=True)
    source_reliability_score = Column(Float, nullable=True)
    composite_score         = Column(Float, nullable=True, index=True)
    distance_meters         = Column(Float, nullable=True)
    explanation             = Column(Text, nullable=True)  # JSON string
    created_at              = Column(String, nullable=True)
    batch_id                = Column(String, nullable=True, index=True)


# ═══════════════════════════════════════════════════════════
# CURATED TABLES
# ═══════════════════════════════════════════════════════════

class StationMaster(Base):
    """Master station record — the canonical curated output of the pipeline."""
    __tablename__ = "station_master"

    master_id             = Column(String, primary_key=True)
    pl_number             = Column(String, nullable=True, index=True)
    canonical_name        = Column(Text, nullable=False)
    canonical_brand       = Column(String, nullable=True)
    canonical_address     = Column(Text, nullable=True)
    canonical_municipality = Column(String, nullable=True)
    canonical_state       = Column(String, nullable=True)
    canonical_zip         = Column(String, nullable=True)
    lat                   = Column(Float, nullable=True)
    lng                   = Column(Float, nullable=True)
    geohash               = Column(String, nullable=True)
    status                = Column(String, default="active")
    confidence_score      = Column(Float, nullable=True)
    primary_source        = Column(String, nullable=True)
    source_ids            = Column(Text, nullable=True)    # JSON array string
    cre_place_id          = Column(String, nullable=True)
    cre_id                = Column(String, nullable=True)
    denue_id              = Column(String, nullable=True)
    osm_id                = Column(String, nullable=True)
    first_seen_at         = Column(String, nullable=True)
    last_confirmed_at     = Column(String, nullable=True)
    last_refreshed_at     = Column(String, nullable=True)
    name_drift_flag       = Column(Integer, default=0)
    review_flag           = Column(Integer, default=0)
    review_reason         = Column(Text, nullable=True)
    created_at            = Column(String, nullable=True)
    updated_at            = Column(String, nullable=True)

    __table_args__ = (
        Index("idx_master_geo",        "geohash"),
        Index("idx_master_state",      "canonical_state"),
        Index("idx_master_brand",      "canonical_brand"),
        Index("idx_master_confidence", "confidence_score"),
        Index("idx_master_status",     "status"),
        Index("idx_master_review",     "review_flag"),
    )


class MatchDecisionORM(Base):
    """Records the outcome of each match decision (auto, manual, rejected)."""
    __tablename__ = "match_decisions"

    decision_id   = Column(String, primary_key=True)
    candidate_id  = Column(String, nullable=True, index=True)
    master_id     = Column(String, nullable=True, index=True)
    decision      = Column(String, nullable=False)
    decided_by    = Column(String, nullable=True)
    decided_at    = Column(String, nullable=True)
    notes         = Column(Text, nullable=True)
    composite_score = Column(Float, nullable=True)


class ReviewQueueORM(Base):
    """Human review queue for candidates in the 0.65–0.84 range."""
    __tablename__ = "review_queue"

    queue_id      = Column(String, primary_key=True)
    candidate_id  = Column(String, nullable=True, index=True)
    composite_score = Column(Float, nullable=True)
    priority      = Column(Integer, default=5)
    status        = Column(String, default="pending")
    assigned_to   = Column(String, nullable=True)
    created_at    = Column(String, nullable=True)
    resolved_at   = Column(String, nullable=True)

    __table_args__ = (
        Index("idx_review_status",   "status"),
        Index("idx_review_priority", "priority", "status"),
    )


class SourceRefreshAudit(Base):
    """Audit log for every pipeline run, per source."""
    __tablename__ = "source_refresh_audit"

    audit_id          = Column(String, primary_key=True)
    source            = Column(String, nullable=False, index=True)
    batch_id          = Column(String, nullable=False, index=True)
    run_at            = Column(String, nullable=True)
    records_fetched   = Column(Integer, nullable=True)
    records_new       = Column(Integer, nullable=True)
    records_updated   = Column(Integer, nullable=True)
    records_unchanged = Column(Integer, nullable=True)
    records_failed    = Column(Integer, nullable=True)
    duration_seconds  = Column(Float, nullable=True)
    status            = Column(String, nullable=True)  # success | partial | failed
    error_message     = Column(Text, nullable=True)

    __table_args__ = (
        Index("idx_audit_run_at", "run_at"),
    )
