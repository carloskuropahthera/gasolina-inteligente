"""
normalize/geo.py — Geo coordinate validation, scoring, and geohash utilities.

Mexico bounding box: lat 14.53–32.72, lng -118.60 to -86.71
"""

from __future__ import annotations

import math
from typing import Optional

import geohash2
import structlog

from config import (
    GEOHASH_BLOCKING_PRECISION,
    GEOHASH_STORAGE_PRECISION,
    GEO_CLOSE_THRESHOLD_M,
    GEO_FAR_THRESHOLD_M,
    GEO_NAME_DRIFT_THRESHOLD,
    GEO_NEUTRAL_SCORE,
    MEXICO_BOUNDS,
)

log = structlog.get_logger(__name__)

# Earth radius in kilometers
_EARTH_RADIUS_KM = 6371.0


# ═══════════════════════════════════════════════════════════
# COORDINATE VALIDATION
# ═══════════════════════════════════════════════════════════

def validate_coordinates(lat: Optional[float], lng: Optional[float]) -> bool:
    """
    Return True if coordinates are within Mexico's bounding box.
    Returns False for None, 0.0/0.0, or out-of-bounds values.
    """
    if lat is None or lng is None:
        return False
    if lat == 0.0 and lng == 0.0:
        return False
    return (
        MEXICO_BOUNDS.lat_min <= lat <= MEXICO_BOUNDS.lat_max
        and MEXICO_BOUNDS.lng_min <= lng <= MEXICO_BOUNDS.lng_max
    )


def get_coordinate_precision(lat: Optional[float], lng: Optional[float]) -> str:
    """
    Estimate coordinate precision based on decimal places.

    Returns:
      "none"   — no coordinates
      "low"    — ≤ 2 decimal places (municipality centroid level, ~km accuracy)
      "medium" — 3 decimal places (~100m accuracy)
      "high"   — ≥ 4 decimal places (~10m or better accuracy)
    """
    if lat is None or lng is None:
        return "none"

    def decimal_places(f: float) -> int:
        s = f"{f:.10f}".rstrip("0")
        if "." not in s:
            return 0
        return len(s.split(".")[1])

    lat_dp = decimal_places(lat)
    lng_dp = decimal_places(lng)
    min_dp = min(lat_dp, lng_dp)

    if min_dp <= 2:
        return "low"
    elif min_dp == 3:
        return "medium"
    else:
        return "high"


# ═══════════════════════════════════════════════════════════
# HAVERSINE DISTANCE
# ═══════════════════════════════════════════════════════════

def haversine_meters(
    lat1: float, lng1: float,
    lat2: float, lng2: float,
) -> float:
    """
    Calculate the great-circle distance between two points in meters.
    Uses the haversine formula.

    Args:
        lat1, lng1: Coordinates of point A (degrees)
        lat2, lng2: Coordinates of point B (degrees)

    Returns:
        Distance in meters (float)
    """
    # Convert degrees to radians
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lam = math.radians(lng2 - lng1)

    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lam / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    return _EARTH_RADIUS_KM * c * 1000.0  # Convert km → meters


# ═══════════════════════════════════════════════════════════
# GEO SCORING
# ═══════════════════════════════════════════════════════════

def score_geo_proximity(
    lat1: Optional[float], lng1: Optional[float],
    lat2: Optional[float], lng2: Optional[float],
) -> tuple[float, Optional[float]]:
    """
    Score the geographic proximity of two station locations.

    Formula:
      distance ≤ 500m:  score = 1.0 - (distance / 500)
      500 < distance ≤ 1000m: score = 0.5 - ((distance - 500) / 500)
      distance > 1000m: score = 0.0
      one or both missing: score = 0.3 (neutral)

    Returns:
        (geo_score: float [0.0, 1.0], distance_meters: Optional[float])
    """
    if (lat1 is None or lng1 is None or lat2 is None or lng2 is None
            or not validate_coordinates(lat1, lng1)
            or not validate_coordinates(lat2, lng2)):
        return GEO_NEUTRAL_SCORE, None

    distance = haversine_meters(lat1, lng1, lat2, lng2)

    if distance <= GEO_CLOSE_THRESHOLD_M:
        score = max(0.0, 1.0 - distance / GEO_CLOSE_THRESHOLD_M)
    elif distance <= GEO_FAR_THRESHOLD_M:
        score = max(0.0, 0.5 - (distance - GEO_CLOSE_THRESHOLD_M) / GEO_CLOSE_THRESHOLD_M)
    else:
        score = 0.0

    return round(score, 4), round(distance, 1)


def is_coordinate_drift(
    lat_old: Optional[float], lng_old: Optional[float],
    lat_new: Optional[float], lng_new: Optional[float],
) -> bool:
    """
    Return True if coordinates changed by more than GEO_NAME_DRIFT_THRESHOLD meters.
    Used to flag potentially moved stations.
    """
    if not all([lat_old, lng_old, lat_new, lng_new]):
        return False
    distance = haversine_meters(lat_old, lng_old, lat_new, lng_new)
    return distance > GEO_NAME_DRIFT_THRESHOLD


# ═══════════════════════════════════════════════════════════
# GEOHASH UTILITIES
# ═══════════════════════════════════════════════════════════

def compute_geohash(
    lat: Optional[float],
    lng: Optional[float],
    precision: int = GEOHASH_STORAGE_PRECISION,
) -> Optional[str]:
    """
    Compute the geohash for a coordinate pair.
    Returns None if coordinates are invalid.

    Precision sizes (approximate):
      5 → ~5km × 5km
      6 → ~1.2km × 0.6km
      7 → ~150m × 150m
      8 → ~40m × 20m
    """
    if not validate_coordinates(lat, lng):
        return None
    try:
        return geohash2.encode(lat, lng, precision=precision)
    except Exception as e:
        log.debug("geohash_compute_error", lat=lat, lng=lng, error=str(e))
        return None


def get_blocking_geohash(
    lat: Optional[float],
    lng: Optional[float],
) -> Optional[str]:
    """
    Returns a precision-6 geohash for use as a blocking key.
    Precision 6 ≈ 1.2km × 0.6km — stations within this cell are candidates.
    """
    return compute_geohash(lat, lng, precision=GEOHASH_BLOCKING_PRECISION)


def get_adjacent_geohashes(geohash: str) -> list[str]:
    """
    Return the geohash and all 8 adjacent cells.
    Used by the blocking step to avoid missed matches at cell boundaries.

    Returns 9 geohashes (center + 8 neighbors).
    """
    try:
        neighbors = geohash2.neighbors(geohash)
        return [geohash] + list(neighbors.values())
    except Exception:
        return [geohash]


# ═══════════════════════════════════════════════════════════
# COORDINATE SNAPPING
# ═══════════════════════════════════════════════════════════

def snap_to_nearest_valid(
    lat: Optional[float],
    lng: Optional[float],
    candidates: list[tuple[float, float]],
) -> tuple[Optional[float], Optional[float]]:
    """
    If a record has invalid or missing coordinates, attempt to snap it to
    the nearest valid coordinate from a list of candidate positions.

    Typical use: a DENUE record with municipality-centroid coordinates
    gets snapped to the nearest CRE or OSM coordinate for the same station.

    Args:
        lat, lng: The current (possibly invalid) coordinates
        candidates: List of (lat, lng) tuples of known-good coordinates

    Returns:
        (lat, lng) of the nearest valid candidate, or (lat, lng) unchanged
        if no better option is found.
    """
    if not candidates:
        return lat, lng

    # If current coords are valid, only snap if a candidate is very close (< 100m)
    if validate_coordinates(lat, lng):
        best_dist = float("inf")
        best_candidate = (lat, lng)
        for cand_lat, cand_lng in candidates:
            if validate_coordinates(cand_lat, cand_lng):
                dist = haversine_meters(lat, lng, cand_lat, cand_lng)
                if dist < best_dist:
                    best_dist = dist
                    best_candidate = (cand_lat, cand_lng)
        # Only snap if candidate is within 100m (don't move valid coords far)
        if best_dist < 100.0:
            return best_candidate
        return lat, lng

    # Current coords invalid — use nearest valid candidate
    valid_candidates = [
        (cand_lat, cand_lng)
        for cand_lat, cand_lng in candidates
        if validate_coordinates(cand_lat, cand_lng)
    ]
    if not valid_candidates:
        return lat, lng

    # Return the first valid candidate (no reference point to compute distance from)
    return valid_candidates[0]
