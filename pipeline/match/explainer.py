"""
match/explainer.py — Human-readable match explanation generator.

Produces explanations suitable for:
  - Review queue UI (why was this pair flagged?)
  - Debugging (why did this pair auto-match?)
  - Audit trail (what logic led to this decision?)
"""

from __future__ import annotations

import json
from typing import Optional

from models.match import CandidatePair, MatchExplanation, MatchScores, DecisionType
from match.resolver import classify_decision, get_decision_reason
from config import NAME_WEIGHT, GEO_WEIGHT, BRAND_WEIGHT, ADDRESS_WEIGHT, SOURCE_REL_WEIGHT
from normalize.brands import normalize_brand
from normalize.text import normalize_for_comparison


# ═══════════════════════════════════════════════════════════
# DIMENSION EXPLANATION GENERATORS
# ═══════════════════════════════════════════════════════════

def explain_name_score(
    name_a: Optional[str],
    name_b: Optional[str],
    score: float,
) -> str:
    """Generate a human-readable explanation of the name score."""
    if name_a is None or name_b is None:
        return f"Name score: {score:.2f} — one or both names missing; using neutral score"

    norm_a = normalize_for_comparison(name_a) or name_a
    norm_b = normalize_for_comparison(name_b) or name_b

    pct = round(score * 100)
    if score >= 0.90:
        quality = "Very high — names are nearly identical after normalization"
    elif score >= 0.75:
        quality = "High — strong token overlap after normalization"
    elif score >= 0.60:
        quality = "Moderate — partial match; likely same station with different name format"
    elif score >= 0.40:
        quality = "Low — weak overlap; could be coincidental"
    else:
        quality = "Very low — names differ significantly"

    return (
        f"Name score: {score:.2f} (token_sort_ratio {pct}) — "
        f"'{norm_a}' vs '{norm_b}' — {quality}"
    )


def explain_geo_score(
    lat1: Optional[float], lng1: Optional[float],
    lat2: Optional[float], lng2: Optional[float],
    distance_m: Optional[float],
    score: float,
) -> str:
    """Generate a human-readable explanation of the geo score."""
    if lat1 is None or lat2 is None or distance_m is None:
        return (
            f"Geo score: {score:.2f} — one or both records have no coordinates; "
            f"using neutral score (neither confirming nor disqualifying)"
        )

    if score >= 0.90:
        proximity = "same location (within GPS margin of error)"
    elif score >= 0.70:
        proximity = "very close — likely same physical station"
    elif score >= 0.50:
        proximity = "nearby — possibly same station or adjacent property"
    elif score >= 0.20:
        proximity = "moderately distant — different locations possible"
    else:
        proximity = "far apart — likely different stations"

    return (
        f"Geo score: {score:.2f} — {distance_m:.1f}m apart — "
        f"{proximity} "
        f"({lat1:.4f},{lng1:.4f}) vs ({lat2:.4f},{lng2:.4f})"
    )


def explain_brand_score(
    raw_brand_a: Optional[str],
    raw_brand_b: Optional[str],
    score: float,
) -> str:
    """Generate a human-readable explanation of the brand score."""
    if raw_brand_a is None and raw_brand_b is None:
        return f"Brand score: {score:.2f} — neither record has a brand; using neutral score"

    canon_a = normalize_brand(raw_brand_a)
    canon_b = normalize_brand(raw_brand_b)

    if canon_a is None and canon_b is None:
        return (
            f"Brand score: {score:.2f} — "
            f"'{raw_brand_a}' and '{raw_brand_b}' both unrecognized after normalization; neutral"
        )

    if canon_a == canon_b and canon_a is not None:
        return (
            f"Brand score: {score:.2f} — "
            f"both normalize to '{canon_a}' "
            f"(raw: '{raw_brand_a}' and '{raw_brand_b}') — full brand match"
        )

    if canon_a != canon_b and canon_a is not None and canon_b is not None:
        return (
            f"Brand score: {score:.2f} — "
            f"different canonical brands: '{canon_a}' vs '{canon_b}' — strong mismatch signal"
        )

    known = canon_a or canon_b
    unknown_raw = raw_brand_b if canon_a else raw_brand_a
    return (
        f"Brand score: {score:.2f} — "
        f"one record has brand '{known}', other has unrecognized '{unknown_raw}' — partial credit"
    )


def explain_address_score(
    addr_a: Optional[str],
    addr_b: Optional[str],
    score: float,
) -> str:
    """Generate a human-readable explanation of the address score."""
    if addr_a is None or addr_b is None:
        return f"Address score: {score:.2f} — one or both addresses missing; using neutral score"

    pct = round(score * 100)
    if score >= 0.85:
        quality = "Strong match — addresses are nearly identical after normalization"
    elif score >= 0.65:
        quality = "Good match — addresses share most tokens"
    elif score >= 0.45:
        quality = "Moderate — partial match; format differences likely"
    else:
        quality = "Weak match — addresses differ significantly"

    return (
        f"Address score: {score:.2f} (token_sort_ratio {pct}) — "
        f"'{addr_a[:60]}' vs '{addr_b[:60]}' — {quality}"
    )


# ═══════════════════════════════════════════════════════════
# MAIN EXPLANATION BUILDER
# ═══════════════════════════════════════════════════════════

def explain_match(
    pair: CandidatePair,
    scores: MatchScores,
) -> MatchExplanation:
    """
    Generate a complete MatchExplanation for a scored candidate pair.

    Args:
        pair: The CandidatePair (contains both stations)
        scores: The MatchScores computed by scorer.score_candidate()

    Returns:
        MatchExplanation with per-dimension prose and full context.
    """
    a = pair.station_a
    b = pair.station_b

    decision = classify_decision(scores.composite_score)
    reason   = get_decision_reason(decision, scores.composite_score)

    name_a = a.norm_name or a.raw_name
    name_b = b.norm_name or b.raw_name
    addr_a = a.norm_address or a.raw_address
    addr_b = b.norm_address or b.raw_address
    brand_a = a.norm_brand or a.raw_brand
    brand_b = b.norm_brand or b.raw_brand

    return MatchExplanation(
        candidate_id=pair.candidate_id,
        source_a_type=a.source,
        source_a_id=a.id,
        source_a_name=name_a,
        source_a_address=addr_a,
        source_a_lat=a.lat,
        source_a_lng=a.lng,
        source_b_type=b.source,
        source_b_id=b.id,
        source_b_name=name_b,
        source_b_address=addr_b,
        source_b_lat=b.lat,
        source_b_lng=b.lng,
        name_score=scores.name_score,
        geo_score=scores.geo_score,
        brand_score=scores.brand_score,
        address_score=scores.address_score,
        source_reliability_score=scores.source_reliability_score,
        composite_score=scores.composite_score,
        distance_meters=scores.distance_meters,
        weights={
            "name":       NAME_WEIGHT,
            "geo":        GEO_WEIGHT,
            "brand":      BRAND_WEIGHT,
            "address":    ADDRESS_WEIGHT,
            "source_rel": SOURCE_REL_WEIGHT,
        },
        name_explanation=explain_name_score(name_a, name_b, scores.name_score),
        geo_explanation=explain_geo_score(
            a.lat, a.lng, b.lat, b.lng, scores.distance_meters, scores.geo_score
        ),
        brand_explanation=explain_brand_score(brand_a, brand_b, scores.brand_score),
        address_explanation=explain_address_score(addr_a, addr_b, scores.address_score),
        decision=decision.value,
        decision_reason=reason,
    )


def to_json(explanation: MatchExplanation) -> str:
    """Serialize a MatchExplanation to a compact JSON string for DB storage."""
    return json.dumps(explanation.model_dump(), ensure_ascii=False, separators=(",", ":"))


def explain_all(
    pairs_by_id: dict[str, CandidatePair],
    scores_list: list[MatchScores],
) -> list[MatchExplanation]:
    """
    Generate explanations for a batch of scored candidates.

    Args:
        pairs_by_id: dict of candidate_id → CandidatePair
        scores_list: list of MatchScores

    Returns:
        List of MatchExplanation, one per scored candidate.
    """
    explanations: list[MatchExplanation] = []
    for scores in scores_list:
        pair = pairs_by_id.get(scores.candidate_id)
        if pair:
            explanations.append(explain_match(pair, scores))
    return explanations
