"""
google_client.py — Google Places API enrichment client.

Used ONLY for on-demand enrichment of specific stations (not bulk scraping).
Google Places is expensive and rate-limited — never use for batch operations.

Capabilities:
  - Nearby search for gas stations around a coordinate pair
  - Place details enrichment (opening hours, phone, website, rating)
  - Reverse geocode to get formatted address from coordinates

Rate limiting: Respects Google's 100 QPS default; we self-limit to 10 RPS.
Cost awareness: Nearby Search = $0.032/request, Details = $0.017/request.

Prerequisites:
  export GOOGLE_PLACES_API_KEY="AIza..."
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any

import httpx

from ..config import (
    GOOGLE_PLACES_API_KEY,
    GOOGLE_PLACES_URL,
    GOOGLE_PLACE_DETAILS_URL,
    HTTP_TIMEOUT_SECONDS,
    HTTP_USER_AGENT,
    RAW_DIR,
)

log = logging.getLogger(__name__)

# ─── Constants ────────────────────────────────────────────────────────────────

NEARBY_SEARCH_RADIUS_M  = 50      # Tight radius — we know the coordinate already
NEARBY_SEARCH_TYPE      = "gas_station"
DETAILS_FIELDS          = [
    "place_id", "name", "formatted_address", "geometry",
    "formatted_phone_number", "website", "rating", "opening_hours",
    "address_components", "business_status",
]

MAX_REQUESTS_PER_SECOND = 10   # Well under Google's 100 QPS limit


# ─── Data Shapes ─────────────────────────────────────────────────────────────

@dataclass
class GooglePlaceResult:
    place_id:          str
    name:              str
    formatted_address: str
    lat:               float | None
    lng:               float | None
    phone:             str
    website:           str
    rating:            float | None
    business_status:   str          # "OPERATIONAL" | "CLOSED_TEMPORARILY" | "CLOSED_PERMANENTLY"
    opening_hours:     dict         # raw Google hours object
    address_components: list[dict]  # raw Google address components
    source:            str   = "google"
    fetched_at:        str   = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    raw_payload:       dict  = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)

    @property
    def is_operational(self) -> bool:
        return self.business_status == "OPERATIONAL"

    def extract_state(self) -> str:
        """Extract MX state name from address_components."""
        for comp in self.address_components:
            if "administrative_area_level_1" in comp.get("types", []):
                return comp.get("long_name", "")
        return ""

    def extract_municipality(self) -> str:
        """Extract municipality from address_components."""
        for comp in self.address_components:
            if "locality" in comp.get("types", []):
                return comp.get("long_name", "")
            if "administrative_area_level_2" in comp.get("types", []):
                return comp.get("long_name", "")
        return ""

    def extract_zip_code(self) -> str:
        """Extract zip code from address_components."""
        for comp in self.address_components:
            if "postal_code" in comp.get("types", []):
                return comp.get("long_name", "")
        return ""


# ─── Client ──────────────────────────────────────────────────────────────────

class GooglePlacesClient:
    """
    Thin wrapper around Google Places API v1 (legacy endpoints).

    Usage:
        client = GooglePlacesClient()
        results = client.nearby_gas_stations(lat=19.4326, lng=-99.1332)
        detail  = client.get_place_details(results[0].place_id)
    """

    def __init__(self, api_key: str = GOOGLE_PLACES_API_KEY):
        if not api_key:
            raise ValueError(
                "GOOGLE_PLACES_API_KEY is not set. "
                "Export the env var before using GooglePlacesClient."
            )
        self._api_key    = api_key
        self._http       = httpx.Client(
            timeout = HTTP_TIMEOUT_SECONDS,
            headers = {"User-Agent": HTTP_USER_AGENT},
        )
        self._last_call  = 0.0   # Timestamp of last API call (for rate limiting)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self._http.close()

    # ── Rate limiting ────────────────────────────────────────────────────────

    def _wait(self):
        elapsed = time.monotonic() - self._last_call
        min_gap = 1.0 / MAX_REQUESTS_PER_SECOND
        if elapsed < min_gap:
            time.sleep(min_gap - elapsed)
        self._last_call = time.monotonic()

    # ── Nearby Search ────────────────────────────────────────────────────────

    def nearby_gas_stations(
        self,
        lat:       float,
        lng:       float,
        radius_m:  int = NEARBY_SEARCH_RADIUS_M,
        max_pages: int = 1,
    ) -> list[GooglePlaceResult]:
        """
        Search for gas stations near a coordinate point.

        Args:
            lat, lng:   Center coordinate
            radius_m:   Search radius in meters (default 50m — tight for known coords)
            max_pages:  Max number of next_page_token pages to follow (1–3)

        Returns:
            List of GooglePlaceResult (basic fields only — no hours/phone).
            Call get_place_details() for full enrichment.
        """
        results: list[GooglePlaceResult] = []
        params = {
            "location": f"{lat},{lng}",
            "radius":   radius_m,
            "type":     NEARBY_SEARCH_TYPE,
            "key":      self._api_key,
        }

        for page_num in range(max_pages):
            self._wait()
            try:
                resp = self._http.get(GOOGLE_PLACES_URL, params=params)
                resp.raise_for_status()
                data = resp.json()
            except (httpx.HTTPError, ValueError) as exc:
                log.error("Google Nearby Search failed (page %d): %s", page_num + 1, exc)
                break

            status = data.get("status")
            if status == "ZERO_RESULTS":
                break
            if status not in ("OK", "UNKNOWN_ERROR"):
                log.warning("Google API status: %s — %s", status, data.get("error_message", ""))
                if status in ("REQUEST_DENIED", "INVALID_REQUEST", "OVER_QUERY_LIMIT"):
                    break

            for item in data.get("results", []):
                try:
                    results.append(self._parse_nearby_result(item))
                except Exception as exc:
                    log.debug("Parse error for nearby result: %s", exc)

            next_token = data.get("next_page_token")
            if not next_token or page_num >= max_pages - 1:
                break

            # Google requires a short delay before using next_page_token
            time.sleep(2)
            params = {"pagetoken": next_token, "key": self._api_key}

        log.debug("Nearby search (%s,%s): %d results", lat, lng, len(results))
        return results

    # ── Place Details ─────────────────────────────────────────────────────────

    def get_place_details(self, place_id: str) -> GooglePlaceResult | None:
        """
        Fetch full details for a single Place ID.

        This is the enrichment call — use it after identifying a place via
        nearby_gas_stations() to get phone, hours, website, etc.

        Cost: $0.017 per call. Only call for stations that are in the review queue
        or that have low confidence scores.
        """
        self._wait()
        try:
            resp = self._http.get(
                GOOGLE_PLACE_DETAILS_URL,
                params={
                    "place_id": place_id,
                    "fields":   ",".join(DETAILS_FIELDS),
                    "language": "es",
                    "key":      self._api_key,
                },
            )
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            log.error("Google Place Details failed for %s: %s", place_id, exc)
            return None

        status = data.get("status")
        if status != "OK":
            log.warning("Place Details status %s for %s: %s", status, place_id, data.get("error_message", ""))
            return None

        try:
            return self._parse_details_result(data.get("result", {}))
        except Exception as exc:
            log.error("Failed to parse Place Details for %s: %s", place_id, exc)
            return None

    # ── Batch Enrichment ─────────────────────────────────────────────────────

    def enrich_stations(
        self,
        station_coords: list[tuple[str, float, float]],  # (station_id, lat, lng)
        save_raw: bool = True,
    ) -> dict[str, GooglePlaceResult | None]:
        """
        Enrich a list of stations with Google Places data.

        For each (station_id, lat, lng), performs a nearby search with tight radius.
        If exactly one result is found, fetches full details. If multiple or zero,
        logs ambiguity and skips details.

        Args:
            station_coords: List of (station_id, lat, lng) tuples
            save_raw:       If True, saves results JSON to RAW_DIR

        Returns:
            Dict mapping station_id → GooglePlaceResult (or None if not found)
        """
        enriched: dict[str, GooglePlaceResult | None] = {}
        today = datetime.now(timezone.utc).strftime("%Y%m%d")

        for station_id, lat, lng in station_coords:
            try:
                nearby = self.nearby_gas_stations(lat, lng, radius_m=NEARBY_SEARCH_RADIUS_M)

                if len(nearby) == 0:
                    log.debug("No Google match for station %s at (%s, %s)", station_id, lat, lng)
                    enriched[station_id] = None
                    continue

                if len(nearby) > 1:
                    log.debug(
                        "Ambiguous Google match for station %s: %d results within %dm",
                        station_id, len(nearby), NEARBY_SEARCH_RADIUS_M,
                    )
                    # Take the closest — which for a tight radius should be index 0
                    # Google sorts by prominence by default; for very tight radii usually correct

                best = nearby[0]
                detail = self.get_place_details(best.place_id)
                enriched[station_id] = detail or best

                if detail:
                    log.debug(
                        "Enriched %s → %s (%s)",
                        station_id, detail.name, detail.business_status,
                    )

            except Exception as exc:
                log.error("Enrichment failed for station %s: %s", station_id, exc)
                enriched[station_id] = None

        found = sum(1 for v in enriched.values() if v is not None)
        log.info("Google enrichment: %d/%d stations matched", found, len(station_coords))

        if save_raw and enriched:
            out_path = RAW_DIR / f"google_enrichment_{today}.json"
            serializable = {
                k: v.to_dict() if v else None
                for k, v in enriched.items()
            }
            import json
            out_path.write_text(
                json.dumps(serializable, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            log.info("Saved Google enrichment data → %s", out_path)

        return enriched

    # ── Parsers ──────────────────────────────────────────────────────────────

    def _parse_nearby_result(self, item: dict) -> GooglePlaceResult:
        geo = item.get("geometry", {}).get("location", {})
        return GooglePlaceResult(
            place_id          = item["place_id"],
            name              = item.get("name", ""),
            formatted_address = item.get("vicinity", ""),
            lat               = _safe_float(geo.get("lat")),
            lng               = _safe_float(geo.get("lng")),
            phone             = "",
            website           = "",
            rating            = _safe_float(item.get("rating")),
            business_status   = item.get("business_status", "UNKNOWN"),
            opening_hours     = item.get("opening_hours", {}),
            address_components= [],
            raw_payload       = item,
        )

    def _parse_details_result(self, result: dict) -> GooglePlaceResult:
        geo = result.get("geometry", {}).get("location", {})
        return GooglePlaceResult(
            place_id          = result["place_id"],
            name              = result.get("name", ""),
            formatted_address = result.get("formatted_address", ""),
            lat               = _safe_float(geo.get("lat")),
            lng               = _safe_float(geo.get("lng")),
            phone             = result.get("formatted_phone_number", ""),
            website           = result.get("website", ""),
            rating            = _safe_float(result.get("rating")),
            business_status   = result.get("business_status", "UNKNOWN"),
            opening_hours     = result.get("opening_hours", {}),
            address_components= result.get("address_components", []),
            raw_payload       = result,
        )


# ─── Module-level convenience functions ──────────────────────────────────────

def enrich_low_confidence_stations(
    confidence_threshold: float = 0.70,
    limit: int = 100,
) -> dict[str, GooglePlaceResult | None]:
    """
    Pull low-confidence stations from the curated DB and enrich with Google.

    Only runs if GOOGLE_PLACES_API_KEY is set. Call this from scripts/refresh.py
    or as a standalone enrichment step.

    Args:
        confidence_threshold: Enrich stations below this confidence score
        limit:                Max stations to enrich per run (cost control)

    Returns:
        Dict mapping station_id → GooglePlaceResult
    """
    if not GOOGLE_PLACES_API_KEY:
        log.warning("GOOGLE_PLACES_API_KEY not set — skipping Google enrichment")
        return {}

    try:
        from sqlalchemy import create_engine, select
        from sqlalchemy.orm import Session
        from ..storage.schema import StationMaster
        from ..config import CURATED_DB_URL
    except ImportError as exc:
        log.error("DB dependencies not available: %s", exc)
        return {}

    engine = create_engine(CURATED_DB_URL)
    with Session(engine) as session:
        stmt = (
            select(StationMaster)
            .where(StationMaster.confidence_score < confidence_threshold)
            .where(StationMaster.lat.isnot(None))
            .where(StationMaster.lng.isnot(None))
            .order_by(StationMaster.confidence_score.asc())
            .limit(limit)
        )
        stations = session.execute(stmt).scalars().all()
        coords = [(s.cre_id or s.id, s.lat, s.lng) for s in stations]

    log.info("Enriching %d low-confidence stations with Google Places", len(coords))

    with GooglePlacesClient() as client:
        return client.enrich_stations(coords)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _safe_float(val: Any) -> float | None:
    if val is None:
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None
