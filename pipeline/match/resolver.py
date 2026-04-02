"""
match/resolver.py — Entity resolution: apply thresholds to scored candidates.

Decision logic:
  composite ≥ 0.85 → auto_match
  0.65 ≤ composite < 0.85 → review_queue
  composite < 0.65 → rejected

Tie-breaking priority: CRE > DENUE > OSM > brand > google
"""

from __future__ import annotations

import uuid
from typing import Optional

import structlog

from config import (
    AUTO_MATCH_THRESHOLD,
    REVIEW_MIN_THRESHOLD,
    SOURCE_PRIORITY,
)
from models.match import (
    BlockingReason,
    CandidatePair,
    DecisionType,
    MatchDecision,
    MatchScores,
    QASeverity,
    ReviewQueueItem,
)
from models.station import StagingStation

log = structlog.get_logger(__name__)


# ═══════════════════════════════════════════════════════════
# DECISION CLASSIFICATION
# ═══════════════════════════════════════════════════════════

def classify_decision(composite_score: float) -> DecisionType:
    """
    Classify a composite score into a decision type.
    """
    if composite_score >= AUTO_MATCH_THRESHOLD:
        return DecisionType.AUTO_MATCH
    elif composite_score >= REVIEW_MIN_THRESHOLD:
        return DecisionType.REVIEW_QUEUE
    else:
        return DecisionType.REJECTED


def get_decision_reason(decision: DecisionType, composite_score: float) -> str:
    """Generate a human-readable reason string for a decision."""
    if decision == DecisionType.AUTO_MATCH:
        return (
            f"composite_score {composite_score:.4f} meets auto-match threshold "
            f"(≥ {AUTO_MATCH_THRESHOLD})"
        )
    elif decision == DecisionType.REVIEW_QUEUE:
        return (
            f"composite_score {composite_score:.4f} is in review range "
            f"[{REVIEW_MIN_THRESHOLD}, {AUTO_MATCH_THRESHOLD})"
        )
    else:
        return (
            f"composite_score {composite_score:.4f} is below reject threshold "
            f"(< {REVIEW_MIN_THRESHOLD})"
        )


# ═══════════════════════════════════════════════════════════
# TIE-BREAKING
# ═══════════════════════════════════════════════════════════

def _source_priority(source: str) -> int:
    """Lower number = higher priority."""
    return SOURCE_PRIORITY.get(source, 99)


def _station_null_count(station: StagingStation) -> int:
    """Count number of key fields that are None — fewer nulls = better record."""
    fields = [
        station.norm_name, station.norm_brand, station.norm_address,
        station.norm_state, station.norm_municipality, station.lat, station.lng,
    ]
    return sum(1 for f in fields if f is None)


def _select_primary_station(
    station_a: StagingStation,
    station_b: StagingStation,
) -> StagingStation:
    """
    Choose the 'primary' (more authoritative) station from a matched pair.
    Used to determine which station's data anchors the master record.

    Tie-breaking order:
    1. Source priority (CRE > DENUE > OSM > brand > google)
    2. Has CRE IDs (pl_number linkage)
    3. Fewer null fields
    """
    pri_a = _source_priority(station_a.source)
    pri_b = _source_priority(station_b.source)

    if pri_a != pri_b:
        return station_a if pri_a < pri_b else station_b

    # Equal source priority: prefer the one with CRE IDs
    has_cre_a = station_a.cre_place_id is not None or station_a.cre_id is not None
    has_cre_b = station_b.cre_place_id is not None or station_b.cre_id is not None

    if has_cre_a and not has_cre_b:
        return station_a
    if has_cre_b and not has_cre_a:
        return station_b

    # Still tied: prefer fewer null fields
    nulls_a = _station_null_count(station_a)
    nulls_b = _station_null_count(station_b)
    return station_a if nulls_a <= nulls_b else station_b


# ═══════════════════════════════════════════════════════════
# MASTER RECORD BUILDER
# ═══════════════════════════════════════════════════════════

def _build_master_id() -> str:
    """Generate a master record UUID."""
    return f"gi-{uuid.uuid4().hex[:12]}"


# ═══════════════════════════════════════════════════════════
# REVIEW QUEUE ITEM BUILDER
# ═══════════════════════════════════════════════════════════

def build_review_queue_item(
    pair: CandidatePair,
    scores: MatchScores,
) -> ReviewQueueItem:
    """
    Build a ReviewQueueItem from a candidate pair and its scores.
    Priority is computed from composite score: lower score = higher priority review.
    """
    # Priority: 1–10, where lower composite score → higher priority (lower number)
    # composite 0.65 → priority 1 (most urgent — barely made it to review)
    # composite 0.84 → priority 8 (least urgent — almost auto-matched)
    score_range = AUTO_MATCH_THRESHOLD - REVIEW_MIN_THRESHOLD  # 0.20
    normalized = (scores.composite_score - REVIEW_MIN_THRESHOLD) / score_range
    priority = max(1, min(9, round(10 - normalized * 9)))

    a = pair.station_a
    b = pair.station_b

    return ReviewQueueItem(
        queue_id=str(uuid.uuid4()),
        candidate_id=pair.candidate_id,
        composite_score=scores.composite_score,
        priority=priority,
        source_a_type=a.source,
        source_a_id=a.id,
        source_a_name=a.norm_name or a.raw_name,
        source_a_address=a.norm_address or a.raw_address,
        source_a_municipality=a.norm_municipality or a.raw_municipality,
        source_a_state=a.norm_state or a.raw_state,
        source_a_lat=a.lat,
        source_a_lng=a.lng,
        source_b_type=b.source,
        source_b_id=b.id,
        source_b_name=b.norm_name or b.raw_name,
        source_b_address=b.norm_address or b.raw_address,
        source_b_municipality=b.norm_municipality or b.raw_municipality,
        source_b_state=b.norm_state or b.raw_state,
        source_b_lat=b.lat,
        source_b_lng=b.lng,
        distance_meters=scores.distance_meters,
        name_score=scores.name_score,
        geo_score=scores.geo_score,
        brand_score=scores.brand_score,
        address_score=scores.address_score,
        decision_recommendation="auto_match" if scores.composite_score >= AUTO_MATCH_THRESHOLD
                                 else "review" if scores.composite_score >= REVIEW_MIN_THRESHOLD
                                 else "reject",
        review_reason=get_decision_reason(classify_decision(scores.composite_score), scores.composite_score),
    )


# ═══════════════════════════════════════════════════════════
# RESOLUTION RESULTS CONTAINER
# ═══════════════════════════════════════════════════════════

class ResolutionResults:
    """Container for the outcome of a resolve() call."""

    def __init__(self) -> None:
        self.decisions:     list[MatchDecision]   = []
        self.review_items:  list[ReviewQueueItem] = []
        self.master_ids:    list[str]             = []   # New master IDs created

    @property
    def auto_matched(self) -> list[MatchDecision]:
        return [d for d in self.decisions if d.decision == DecisionType.AUTO_MATCH]

    @property
    def rejected(self) -> list[MatchDecision]:
        return [d for d in self.decisions if d.decision == DecisionType.REJECTED]

    def summary(self) -> dict:
        return {
            "total":        len(self.decisions),
            "auto_matched": len(self.auto_matched),
            "review_queue": len(self.review_items),
            "rejected":     len(self.rejected),
        }


# ═══════════════════════════════════════════════════════════
# MAIN RESOLVER
# ═══════════════════════════════════════════════════════════

def resolve(
    scored_candidates: list[MatchScores],
    pairs_by_candidate_id: Optional[dict[str, CandidatePair]] = None,
) -> ResolutionResults:
    """
    Apply resolution thresholds to a list of scored candidates.

    Args:
        scored_candidates: Output of scorer.score_all()
        pairs_by_candidate_id: Optional dict mapping candidate_id → CandidatePair
                                (needed for review queue item construction)

    Returns:
        ResolutionResults with decisions, review items, and new master IDs.
    """
    results = ResolutionResults()

    # Sort by composite score descending (highest confidence first)
    sorted_scores = sorted(
        scored_candidates,
        key=lambda s: s.composite_score,
        reverse=True,
    )

    # Track which staging IDs have already been matched to avoid double-matching
    matched_staging_ids: set[str] = set()

    for scores in sorted_scores:
        decision_type = classify_decision(scores.composite_score)

        if decision_type == DecisionType.AUTO_MATCH:
            # Get the pair to find source IDs
            pair = pairs_by_candidate_id.get(scores.candidate_id) if pairs_by_candidate_id else None

            # Check if either station has already been matched
            if pair:
                a_id = pair.station_a.id
                b_id = pair.station_b.id
                if a_id in matched_staging_ids or b_id in matched_staging_ids:
                    # Downgrade to review if either was already matched
                    decision_type = DecisionType.REVIEW_QUEUE

            if decision_type == DecisionType.AUTO_MATCH:
                master_id = _build_master_id()
                results.master_ids.append(master_id)

                if pair:
                    matched_staging_ids.add(pair.station_a.id)
                    matched_staging_ids.add(pair.station_b.id)

                decision = MatchDecision(
                    decision_id=str(uuid.uuid4()),
                    candidate_id=scores.candidate_id,
                    master_id=master_id,
                    decision=DecisionType.AUTO_MATCH,
                    decided_by="system",
                    notes=get_decision_reason(DecisionType.AUTO_MATCH, scores.composite_score),
                    composite_score=scores.composite_score,
                )
                results.decisions.append(decision)
                log.debug(
                    "auto_match",
                    candidate_id=scores.candidate_id,
                    master_id=master_id,
                    score=scores.composite_score,
                )
                continue

        if decision_type == DecisionType.REVIEW_QUEUE:
            decision = MatchDecision(
                decision_id=str(uuid.uuid4()),
                candidate_id=scores.candidate_id,
                master_id=None,
                decision=DecisionType.REVIEW_QUEUE,
                decided_by="system",
                notes=get_decision_reason(DecisionType.REVIEW_QUEUE, scores.composite_score),
                composite_score=scores.composite_score,
            )
            results.decisions.append(decision)

            if pairs_by_candidate_id and scores.candidate_id in pairs_by_candidate_id:
                pair = pairs_by_candidate_id[scores.candidate_id]
                review_item = build_review_queue_item(pair, scores)
                results.review_items.append(review_item)

        elif decision_type == DecisionType.REJECTED:
            decision = MatchDecision(
                decision_id=str(uuid.uuid4()),
                candidate_id=scores.candidate_id,
                master_id=None,
                decision=DecisionType.REJECTED,
                decided_by="system",
                notes=get_decision_reason(DecisionType.REJECTED, scores.composite_score),
                composite_score=scores.composite_score,
            )
            results.decisions.append(decision)

    log.info("resolution_complete", **results.summary())
    return results
