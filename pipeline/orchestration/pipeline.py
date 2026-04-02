"""
orchestration/pipeline.py — Full pipeline DAG definition.

Orchestrates: fetch → normalize → block → score → resolve → export → audit

Can be run directly or called from scripts/seed.py and scripts/refresh.py.
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone
from typing import Optional

import structlog

from config import MOCK_MODE
from models.station import StagingStation

log = structlog.get_logger(__name__)


# ═══════════════════════════════════════════════════════════
# BATCH ID
# ═══════════════════════════════════════════════════════════

def generate_batch_id() -> str:
    """Generate a unique pipeline batch identifier."""
    date = datetime.now(timezone.utc).strftime("%Y%m%d%H%M")
    short_uuid = uuid.uuid4().hex[:8]
    return f"batch-{date}-{short_uuid}"


# ═══════════════════════════════════════════════════════════
# PIPELINE STEPS
# ═══════════════════════════════════════════════════════════

def step_fetch_cre(batch_id: str, mock: bool = False):
    """Fetch CRE Places + Prices data."""
    if mock:
        from sources.cre_client import mock_cre_stations, mock_cre_prices
        stations = mock_cre_stations(n=50)
        prices   = mock_cre_prices(stations)
        log.info("step_fetch_cre_mock", stations=len(stations), prices=len(prices))
        return stations, prices

    from sources.cre_client import CREClient
    client   = CREClient()
    stations = client.fetch_places()
    prices   = client.fetch_prices()

    # Save raw
    from storage.raw_zone import write_parquet
    import pandas as pd
    write_parquet(pd.DataFrame([s.model_dump() for s in stations]), "cre_places", batch_id)
    write_parquet(pd.DataFrame([p.model_dump() for p in prices]), "cre_prices", batch_id)

    return stations, prices


def step_fetch_osm(batch_id: str, mock: bool = False):
    """Fetch OSM fuel station data."""
    if mock:
        from sources.osm_client import mock_osm_stations
        stations = mock_osm_stations(n=40)
        log.info("step_fetch_osm_mock", stations=len(stations))
        return stations

    from sources.osm_client import OSMClient
    client, path = OSMClient(), None
    stations, path = client.fetch_and_save(batch_id)
    return stations


def step_fetch_denue(batch_id: str, mock: bool = False):
    """Fetch INEGI DENUE data."""
    if mock:
        from sources.denue_client import mock_denue_stations
        stations = mock_denue_stations(n=30)
        log.info("step_fetch_denue_mock", stations=len(stations))
        return stations

    from sources.denue_client import DENUEClient
    client = DENUEClient()
    stations, _ = client.fetch_and_save(batch_id)
    return stations


def step_convert_to_staging(
    cre_stations,
    osm_stations,
    denue_stations,
    batch_id: str,
) -> list[StagingStation]:
    """Convert raw source models to StagingStation objects."""
    from models.station import StagingStation

    staging: list[StagingStation] = []

    # CRE stations
    for s in cre_stations:
        staging.append(StagingStation(
            id=f"cre_{s.place_id or s.cre_id}",
            source="cre",
            batch_id=batch_id,
            cre_place_id=s.place_id,
            cre_id=s.cre_id,
            raw_name=s.nombre or s.razon_social,
            raw_brand=s.marca,
            raw_address=s.domicilio,
            raw_municipality=s.municipio,
            raw_state=s.estado,
            raw_zip=s.cp,
            lat=s.latitud,
            lng=s.longitud,
        ))

    # OSM stations
    for s in osm_stations:
        staging.append(StagingStation(
            id=f"osm_{s.osm_type}_{s.osm_id}",
            source="osm",
            batch_id=batch_id,
            osm_id=s.osm_id,
            osm_type=s.osm_type,
            raw_name=s.name,
            raw_brand=s.brand or s.operator,
            raw_address=s.addr_street,
            raw_municipality=s.addr_city,
            raw_state=s.addr_state,
            raw_zip=s.addr_postcode,
            lat=s.lat,
            lng=s.lng,
        ))

    # DENUE stations
    for s in denue_stations:
        staging.append(StagingStation(
            id=f"denue_{s.denue_id}",
            source="denue",
            batch_id=batch_id,
            denue_id=s.denue_id,
            raw_name=s.nom_estab or s.raz_social,
            raw_brand=None,
            raw_address=s.full_address if hasattr(s, "full_address") else None,
            raw_municipality=s.municipio,
            raw_state=s.entidad,
            raw_zip=s.cod_postal,
            lat=s.latitud,
            lng=s.longitud,
        ))

    log.info("step_convert_staging", total=len(staging))
    return staging


def step_normalize(staging: list[StagingStation]) -> list[StagingStation]:
    """Run normalization pipeline on all staging records."""
    from storage.staging_zone import normalize_staging_station
    normalized = [normalize_staging_station(s) for s in staging]
    log.info("step_normalize_complete", records=len(normalized))
    return normalized


def step_upsert_staging(staging: list[StagingStation]) -> None:
    """Upsert normalized staging records into staging DB."""
    from storage.db import staging_session
    from storage.staging_zone import upsert_staging

    with staging_session() as session:
        inserted, updated = upsert_staging(session, staging, normalize=False)
    log.info("step_upsert_staging", inserted=inserted, updated=updated)


def step_block_and_score(staging: list[StagingStation]):
    """Generate candidate pairs, score them, and build explanation."""
    from match.blocking import generate_candidates
    from match.scorer import score_all
    from match.explainer import explain_all

    log.info("step_block_start", records=len(staging))
    pairs = generate_candidates(staging)

    pairs_by_id = {p.candidate_id: p for p in pairs}

    log.info("step_score_start", candidates=len(pairs))
    scored = score_all(pairs)

    explanations = explain_all(pairs_by_id, scored)
    log.info("step_explain_complete", explanations=len(explanations))

    return pairs_by_id, scored, explanations


def step_resolve(scored, pairs_by_id):
    """Apply resolution thresholds and produce decisions."""
    from match.resolver import resolve
    results = resolve(scored, pairs_by_id)
    log.info("step_resolve_complete", **results.summary())
    return results


def step_write_decisions(results, explanations_by_candidate_id: dict) -> None:
    """Write match decisions, review items, and explanation JSON to storage."""
    from match.explainer import to_json
    from storage.db import curated_session, staging_session
    from storage.curated_zone import write_match_decisions, write_review_items
    from storage.schema import CandidateMatch

    # Write match decisions to curated DB
    with curated_session() as session:
        write_match_decisions(session, results.decisions)
        write_review_items(session, results.review_items)

    # Update candidate_matches with explanation JSON (in staging DB)
    from storage.db import staging_session
    with staging_session() as session:
        for explanation in explanations_by_candidate_id.values():
            session.execute(
                __import__("sqlalchemy").text(
                    "UPDATE candidate_matches SET explanation = :exp "
                    "WHERE candidate_id = :cid"
                ),
                {"exp": to_json(explanation), "cid": explanation.candidate_id},
            )

    log.info("step_write_decisions_complete", decisions=len(results.decisions))


def step_build_master_records(results, pairs_by_id) -> list:
    """Build MasterStation records for all auto-matched pairs."""
    from storage.curated_zone import build_master_from_pair
    from models.match import DecisionType

    master_stations = []
    for decision in results.decisions:
        if decision.decision != DecisionType.AUTO_MATCH:
            continue
        if decision.master_id is None:
            continue

        pair = pairs_by_id.get(decision.candidate_id)
        if pair is None:
            continue

        station = build_master_from_pair(
            master_id=decision.master_id,
            station_a_dict=pair.station_a.model_dump(),
            station_b_dict=pair.station_b.model_dump(),
            base_score=decision.composite_score,
        )
        master_stations.append(station)

    log.info("step_build_master", count=len(master_stations))
    return master_stations


def step_promote_unmatched_cre(
    staging: list[StagingStation],
    results,
    pairs_by_id: dict,
) -> list:
    """
    Promote CRE staging records that have no auto_match to master as single-source records.

    After entity resolution, any CRE station that didn't participate in an AUTO_MATCH
    should still appear in master — CRE is authoritative and doesn't need a counterpart.
    """
    from storage.curated_zone import build_master_from_single
    from models.match import DecisionType

    # Collect all station IDs that were matched
    matched_ids: set[str] = set()
    for decision in results.decisions:
        if decision.decision != DecisionType.AUTO_MATCH:
            continue
        pair = pairs_by_id.get(decision.candidate_id)
        if pair:
            matched_ids.add(pair.station_a.id)
            matched_ids.add(pair.station_b.id)

    unmatched_cre = [s for s in staging if s.source == "cre" and s.id not in matched_ids]

    master_stations = []
    for s in unmatched_cre:
        import uuid as _uuid
        master_id = f"master_cre_{s.cre_id or _uuid.uuid4().hex[:8]}"
        station = build_master_from_single(s.model_dump(), master_id=master_id)
        master_stations.append(station)

    log.info("step_promote_unmatched_cre", count=len(master_stations))
    return master_stations


def step_upsert_master(master_stations) -> None:
    """Upsert master station records into curated DB."""
    from storage.db import curated_session
    from storage.curated_zone import upsert_master

    with curated_session() as session:
        count = upsert_master(session, master_stations)
    log.info("step_upsert_master", count=count)


def step_run_qa() -> list:
    """Run all QA checks against the curated DB."""
    from storage.db import curated_session
    from quality.checks import run_all_checks

    with curated_session() as session:
        issues = run_all_checks(session)

    log.info("step_qa_complete", issues=len(issues))
    return issues


def step_export(batch_id: str) -> None:
    """Export master data for JS app."""
    try:
        from scripts.export_for_app import run_export
        run_export(batch_id=batch_id)
    except Exception as e:
        log.warning("step_export_failed", error=str(e))


def step_write_audit(
    session,
    source: str,
    batch_id: str,
    records_fetched: int,
    records_new: int,
    duration_seconds: float,
    status: str,
    error_message: Optional[str] = None,
) -> None:
    """Write a source_refresh_audit record."""
    from storage.curated_zone import write_audit
    write_audit(
        session=session,
        source=source,
        batch_id=batch_id,
        records_fetched=records_fetched,
        records_new=records_new,
        duration_seconds=duration_seconds,
        status=status,
        error_message=error_message,
    )


# ═══════════════════════════════════════════════════════════
# FULL PIPELINE
# ═══════════════════════════════════════════════════════════

def run_full_pipeline(mock: bool = MOCK_MODE) -> dict:
    """
    Run the complete pipeline: fetch → normalize → block → score → resolve → export.

    Args:
        mock: If True, uses synthetic test data instead of real API calls.

    Returns:
        Summary dict with counts and batch_id.
    """
    batch_id  = generate_batch_id()
    start     = time.time()

    log.info("pipeline_start", batch_id=batch_id, mock=mock)

    try:
        # 1. Fetch
        cre_stations, cre_prices = step_fetch_cre(batch_id, mock=mock)
        osm_stations             = step_fetch_osm(batch_id, mock=mock)
        denue_stations           = step_fetch_denue(batch_id, mock=mock)

        # 2. Convert to unified staging model
        staging = step_convert_to_staging(
            cre_stations, osm_stations, denue_stations, batch_id
        )

        # 3. Normalize
        staging = step_normalize(staging)

        # 4. Upsert to staging DB
        step_upsert_staging(staging)

        # 5. Block + Score + Explain
        pairs_by_id, scored, explanations = step_block_and_score(staging)
        explanations_by_cid = {e.candidate_id: e for e in explanations}

        # 6. Resolve
        results = step_resolve(scored, pairs_by_id)

        # 7. Write decisions
        step_write_decisions(results, explanations_by_cid)

        # 8. Build master records (cross-source matches + unmatched CRE)
        master_stations = step_build_master_records(results, pairs_by_id)
        master_stations += step_promote_unmatched_cre(staging, results, pairs_by_id)

        # 9. Upsert master
        step_upsert_master(master_stations)

        # 10. QA
        qa_issues = step_run_qa()

        # 11. Export
        step_export(batch_id)

        duration = time.time() - start
        summary = {
            "batch_id":        batch_id,
            "status":          "success",
            "duration_seconds": round(duration, 2),
            "staging_records": len(staging),
            "candidates":      len(pairs_by_id),
            "auto_matched":    len(results.auto_matched),
            "review_queue":    len(results.review_items),
            "rejected":        len(results.rejected),
            "master_records":  len(master_stations),
            "qa_issues":       len(qa_issues),
        }

        log.info("pipeline_complete", **summary)

        # Write audit
        from storage.db import curated_session
        with curated_session() as session:
            step_write_audit(
                session=session,
                source="full_pipeline",
                batch_id=batch_id,
                records_fetched=len(staging),
                records_new=len(master_stations),
                duration_seconds=duration,
                status="success",
            )

        return summary

    except Exception as e:
        duration = time.time() - start
        log.error("pipeline_failed", batch_id=batch_id, error=str(e), duration_s=round(duration, 2))

        try:
            from storage.db import curated_session
            with curated_session() as session:
                step_write_audit(
                    session=session,
                    source="full_pipeline",
                    batch_id=batch_id,
                    records_fetched=0,
                    records_new=0,
                    duration_seconds=duration,
                    status="failed",
                    error_message=str(e),
                )
        except Exception:
            pass  # Don't raise if audit write fails

        raise
