"""
match/blocking.py — Candidate pair generation via blocking.

Reduces O(n²) matching to O(k) by only comparing records within the same
geographic or administrative "block".

Two blocking strategies:
  1. Geographic: same geohash-6 cell and all 8 adjacent cells (~1.2km radius)
  2. Administrative: same (norm_state, norm_municipality) pair

Records are only paired with records from DIFFERENT sources.
Pairs (A,B) and (B,A) are deduplicated.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Optional

import structlog

from models.match import BlockingReason, CandidatePair
from models.station import StagingStation
from normalize.geo import get_adjacent_geohashes

log = structlog.get_logger(__name__)


# ═══════════════════════════════════════════════════════════
# BLOCKING KEY BUILDERS
# ═══════════════════════════════════════════════════════════

def _geo_block_keys(station: StagingStation) -> list[str]:
    """
    Return all geohash-6 block keys this station belongs to.
    A station belongs to its own cell AND the 8 adjacent cells
    (to avoid missing pairs at cell boundaries).
    """
    if not station.geohash6:
        return []
    return get_adjacent_geohashes(station.geohash6)


def _admin_block_key(station: StagingStation) -> Optional[str]:
    """
    Return the administrative block key: "{norm_state}|{norm_municipality}".
    Returns None if either field is missing.
    """
    if station.norm_state and station.norm_municipality:
        return f"{station.norm_state}|{station.norm_municipality}"
    if station.norm_state:
        return f"{station.norm_state}|__unknown__"
    return None


# ═══════════════════════════════════════════════════════════
# PAIR GENERATION
# ═══════════════════════════════════════════════════════════

def _make_candidate(
    station_a: StagingStation,
    station_b: StagingStation,
    reason: BlockingReason,
) -> CandidatePair:
    """Create a CandidatePair with a new UUID."""
    return CandidatePair(
        candidate_id=str(uuid.uuid4()),
        station_a=station_a,
        station_b=station_b,
        blocking_reason=reason,
    )


def _generate_pairs_within_block(
    block: list[StagingStation],
    seen_pairs: set[frozenset[str]],
    reason: BlockingReason,
) -> list[CandidatePair]:
    """
    Generate all cross-source pairs within a block.
    Skips pairs from the same source.
    Skips pairs already seen (deduplication).
    """
    candidates: list[CandidatePair] = []

    for i, station_a in enumerate(block):
        for station_b in block[i + 1:]:
            # Only cross-source pairs
            if station_a.source == station_b.source:
                continue

            pair_key = frozenset([station_a.id, station_b.id])
            if pair_key in seen_pairs:
                continue

            seen_pairs.add(pair_key)
            candidates.append(_make_candidate(station_a, station_b, reason))

    return candidates


# ═══════════════════════════════════════════════════════════
# MAIN BLOCKING FUNCTION
# ═══════════════════════════════════════════════════════════

def generate_candidates(
    staging_records: list[StagingStation],
    max_candidates: int = 2_000_000,
) -> list[CandidatePair]:
    """
    Generate candidate pairs from a list of staging records using two blocking strategies.

    Args:
        staging_records: All staging records across all sources
        max_candidates: Safety limit — raises if exceeded (suggests blocking failure)

    Returns:
        List of CandidatePair, deduplicated across both blocking strategies.
    """
    log.info("blocking_start", total_records=len(staging_records))

    # Track seen pairs for deduplication
    seen_pairs: set[frozenset[str]] = set()
    all_candidates: list[CandidatePair] = []

    # ── Strategy 1: Geographic blocking (geohash-6) ────────────────────────────
    geo_blocks: dict[str, list[StagingStation]] = defaultdict(list)

    for station in staging_records:
        for block_key in _geo_block_keys(station):
            geo_blocks[block_key].append(station)

    geo_candidates: list[CandidatePair] = []
    for block_key, block in geo_blocks.items():
        if len(block) < 2:
            continue
        geo_candidates.extend(
            _generate_pairs_within_block(block, seen_pairs, BlockingReason.GEOHASH)
        )

    log.info(
        "blocking_geo_complete",
        geo_blocks=len(geo_blocks),
        geo_candidates=len(geo_candidates),
    )
    all_candidates.extend(geo_candidates)

    # ── Strategy 2: Administrative blocking (state + municipality) ─────────────
    admin_blocks: dict[str, list[StagingStation]] = defaultdict(list)

    for station in staging_records:
        key = _admin_block_key(station)
        if key:
            admin_blocks[key].append(station)

    admin_candidates: list[CandidatePair] = []
    for block_key, block in admin_blocks.items():
        if len(block) < 2:
            continue
        admin_candidates.extend(
            _generate_pairs_within_block(block, seen_pairs, BlockingReason.ADMIN)
        )

    log.info(
        "blocking_admin_complete",
        admin_blocks=len(admin_blocks),
        admin_candidates=len(admin_candidates),
    )
    all_candidates.extend(admin_candidates)

    total = len(all_candidates)
    log.info("blocking_complete", total_candidates=total)

    # Safety check: if blocking failed (too many pairs), something went wrong
    if total > max_candidates:
        raise RuntimeError(
            f"Blocking generated {total:,} candidate pairs, exceeding safety limit "
            f"of {max_candidates:,}. Check that norm_state and norm_municipality "
            f"are populated and that geohash-6 blocking is working correctly."
        )

    return all_candidates


# ═══════════════════════════════════════════════════════════
# TARGETED BLOCKING (for delta refresh)
# ═══════════════════════════════════════════════════════════

def generate_candidates_for_changed(
    changed_records: list[StagingStation],
    all_staging_records: list[StagingStation],
) -> list[CandidatePair]:
    """
    Generate candidate pairs ONLY involving at least one changed record.
    Used in delta refresh to avoid re-scoring unchanged pairs.

    Args:
        changed_records: Records that changed in this batch
        all_staging_records: Full staging dataset (for cross-source comparison)

    Returns:
        Candidate pairs where at least one record is in changed_records.
    """
    changed_ids = {r.id for r in changed_records}

    # Generate all candidates normally
    all_candidates = generate_candidates(all_staging_records)

    # Filter to only those involving a changed record
    filtered = [
        c for c in all_candidates
        if c.station_a.id in changed_ids or c.station_b.id in changed_ids
    ]

    log.info(
        "blocking_delta_filter",
        total_candidates=len(all_candidates),
        filtered_candidates=len(filtered),
        changed_records=len(changed_records),
    )
    return filtered
