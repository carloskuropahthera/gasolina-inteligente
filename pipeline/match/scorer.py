"""
match/scorer.py — Multi-dimensional match scoring for candidate pairs.

Five scoring dimensions:
  1. name_score    (weight 0.25) — fuzzy name similarity
  2. geo_score     (weight 0.35) — geographic proximity
  3. brand_score   (weight 0.20) — canonical brand match
  4. address_score (weight 0.15) — normalized address similarity
  5. source_rel    (weight 0.05) — average source reliability

composite = sum(score_i × weight_i)
"""

from __future__ import annotations

from typing import Optional

from rapidfuzz import fuzz

from config import (
    ADDRESS_WEIGHT,
    BRAND_WEIGHT,
    GEO_WEIGHT,
    NAME_WEIGHT,
    SOURCE_RELIABILITY,
    SOURCE_REL_WEIGHT,
)
from models.match import CandidatePair, MatchScores
from models.station import StagingStation
from normalize.brands import brand_match_score
from normalize.geo import score_geo_proximity
from normalize.text import normalize_for_comparison


# ═══════════════════════════════════════════════════════════
# INDIVIDUAL DIMENSION SCORERS
# ═══════════════════════════════════════════════════════════

def score_name(
    name_a: Optional[str],
    name_b: Optional[str],
) -> float:
    """
    Score name similarity using rapidfuzz.

    Uses the maximum of:
      - token_sort_ratio: order-invariant full token match
      - partial_ratio: substring match (catches "PEMEX POLANCO" vs "GASOLINERA POLANCO")

    Both are normalized 0–100 by rapidfuzz; we divide by 100 to get 0.0–1.0.
    Returns 0.3 (neutral) if either name is None.
    """
    if not name_a or not name_b:
        return 0.3  # Neutral — not disqualifying

    norm_a = normalize_for_comparison(name_a) or name_a.upper()
    norm_b = normalize_for_comparison(name_b) or name_b.upper()

    token_sort = fuzz.token_sort_ratio(norm_a, norm_b)
    partial     = fuzz.partial_ratio(norm_a, norm_b)
    token_set   = fuzz.token_set_ratio(norm_a, norm_b)

    best = max(token_sort, partial, token_set)
    return round(best / 100.0, 4)


def score_geo(
    lat1: Optional[float], lng1: Optional[float],
    lat2: Optional[float], lng2: Optional[float],
) -> tuple[float, Optional[float]]:
    """
    Score geographic proximity.
    Returns (geo_score, distance_meters).
    See normalize/geo.py for the scoring formula.
    """
    return score_geo_proximity(lat1, lng1, lat2, lng2)


def score_brand(
    raw_brand_a: Optional[str],
    raw_brand_b: Optional[str],
) -> float:
    """
    Score brand similarity.

    1.0  — both resolve to same canonical brand
    0.5  — one or both brands are None/unknown (neutral)
    0.3  — one has a brand, other doesn't
    0.0  — different canonical brands (near-disqualifying)
    """
    return brand_match_score(raw_brand_a, raw_brand_b)


def score_address(
    addr_a: Optional[str],
    addr_b: Optional[str],
) -> float:
    """
    Score address similarity using token sort ratio on normalized addresses.
    Returns 0.3 (neutral) if either address is None.
    """
    if not addr_a or not addr_b:
        return 0.3

    # Use token_sort_ratio — Mexican addresses frequently differ in word order
    token_sort = fuzz.token_sort_ratio(addr_a.upper(), addr_b.upper())
    partial     = fuzz.partial_ratio(addr_a.upper(), addr_b.upper())
    best = max(token_sort, partial)
    return round(best / 100.0, 4)


def score_source_reliability(
    source_a: str,
    source_b: str,
) -> float:
    """
    Score based on average reliability of the two sources.
    Higher = both are reliable government sources.
    """
    rel_a = SOURCE_RELIABILITY.get(source_a, 0.5)
    rel_b = SOURCE_RELIABILITY.get(source_b, 0.5)
    return round((rel_a + rel_b) / 2.0, 4)


# ═══════════════════════════════════════════════════════════
# COMPOSITE SCORER
# ═══════════════════════════════════════════════════════════

def compute_composite(
    name_score:               float,
    geo_score:                float,
    brand_score:              float,
    address_score:            float,
    source_reliability_score: float,
) -> float:
    """
    Compute the weighted composite score.
    All weights must sum to 1.0 (enforced in config.py).
    """
    composite = (
        name_score               * NAME_WEIGHT +
        geo_score                * GEO_WEIGHT +
        brand_score              * BRAND_WEIGHT +
        address_score            * ADDRESS_WEIGHT +
        source_reliability_score * SOURCE_REL_WEIGHT
    )
    return round(max(0.0, min(1.0, composite)), 4)


def score_candidate(pair: CandidatePair) -> MatchScores:
    """
    Score a CandidatePair on all 5 dimensions and compute composite.

    Args:
        pair: A CandidatePair with station_a and station_b

    Returns:
        MatchScores with all dimension scores and composite.
    """
    a: StagingStation = pair.station_a
    b: StagingStation = pair.station_b

    # 1. Name score — use norm_name if available, fall back to raw_name
    name_a = a.norm_name or a.raw_name
    name_b = b.norm_name or b.raw_name
    name_sc = score_name(name_a, name_b)

    # 2. Geo score
    geo_sc, distance_m = score_geo(a.lat, a.lng, b.lat, b.lng)

    # 3. Brand score — use norm_brand if available
    brand_a = a.norm_brand or a.raw_brand
    brand_b = b.norm_brand or b.raw_brand
    brand_sc = score_brand(brand_a, brand_b)

    # 4. Address score — use norm_address if available
    addr_a = a.norm_address or a.raw_address
    addr_b = b.norm_address or b.raw_address
    addr_sc = score_address(addr_a, addr_b)

    # 5. Source reliability score
    src_sc = score_source_reliability(a.source, b.source)

    # Composite
    composite = compute_composite(name_sc, geo_sc, brand_sc, addr_sc, src_sc)

    return MatchScores(
        candidate_id=pair.candidate_id,
        name_score=name_sc,
        geo_score=geo_sc,
        brand_score=brand_sc,
        address_score=addr_sc,
        source_reliability_score=src_sc,
        composite_score=composite,
        distance_meters=distance_m,
    )


def score_all(pairs: list[CandidatePair]) -> list[MatchScores]:
    """Score all candidate pairs. Returns list of MatchScores sorted by composite desc."""
    scored = [score_candidate(pair) for pair in pairs]
    scored.sort(key=lambda s: s.composite_score, reverse=True)
    return scored
