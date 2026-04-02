"""
sources/osm_client.py — OpenStreetMap Overpass API client.

Fetches all amenity=fuel nodes and ways within the Mexico bounding box.
No authentication required.
Rate-limited to 2 requests per minute (Overpass API courtesy limit).
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
import structlog
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from config import (
    HTTP_RETRY_ATTEMPTS,
    HTTP_RETRY_WAIT_MAX,
    HTTP_RETRY_WAIT_MIN,
    HTTP_TIMEOUT_SECONDS,
    HTTP_USER_AGENT,
    MEXICO_BBOX_OVERPASS,
    OSM_OVERPASS_URL,
    OSM_OVERPASS_URL_FALLBACK,
    OSM_REQUESTS_PER_MINUTE,
    RAW_DIR,
)
from models.station import RawOSMStation

log = structlog.get_logger(__name__)

# Minimum seconds between requests (2 req/min → 30s apart)
_MIN_INTERVAL_SECONDS = 60.0 / OSM_REQUESTS_PER_MINUTE
_last_request_time: float = 0.0


# ═══════════════════════════════════════════════════════════
# OVERPASS QL QUERY
# ═══════════════════════════════════════════════════════════

def _build_overpass_query(bbox: str) -> str:
    """
    Build an Overpass QL query to fetch all amenity=fuel
    nodes and ways within the given bounding box.

    bbox format: "south,west,north,east"
    """
    return f"""
[out:json][timeout:120];
(
  node["amenity"="fuel"]({bbox});
  way["amenity"="fuel"]({bbox});
);
out body center;
>;
out skel qt;
""".strip()


# ═══════════════════════════════════════════════════════════
# RESPONSE PARSER
# ═══════════════════════════════════════════════════════════

def _extract_tags(element: dict[str, Any]) -> dict[str, str]:
    """Extract the tags dict from an OSM element, returning empty dict if absent."""
    return {str(k): str(v) for k, v in element.get("tags", {}).items()}


def _parse_osm_element(element: dict[str, Any]) -> Optional[RawOSMStation]:
    """
    Convert a single OSM JSON element (node or way) to a RawOSMStation.
    Ways carry a 'center' dict for lat/lng instead of top-level lat/lon.
    Returns None if the element lacks sufficient data to be useful.
    """
    tags = _extract_tags(element)
    elem_type = element.get("type", "node")
    osm_id = str(element.get("id", ""))

    # Extract coordinates
    lat: Optional[float] = None
    lng: Optional[float] = None

    if elem_type == "node":
        lat = element.get("lat")
        lng = element.get("lon")
    elif elem_type == "way":
        center = element.get("center", {})
        lat = center.get("lat")
        lng = center.get("lon")

    # We need at least an OSM ID to make this useful
    if not osm_id:
        return None

    # Extract address components from tags
    addr_street     = tags.get("addr:street") or tags.get("addr:housenumber")
    addr_housenumber = tags.get("addr:housenumber")
    addr_suburb     = tags.get("addr:suburb") or tags.get("addr:colony")
    addr_city       = (
        tags.get("addr:city")
        or tags.get("addr:municipality")
        or tags.get("addr:place")
    )
    addr_state      = tags.get("addr:state") or tags.get("addr:province")
    addr_postcode   = tags.get("addr:postcode") or tags.get("postal_code")

    # Build street address string if components available
    full_addr: Optional[str] = None
    if addr_street and addr_housenumber:
        full_addr = f"{addr_street} {addr_housenumber}"
    elif addr_street:
        full_addr = addr_street

    return RawOSMStation(
        osm_id=osm_id,
        osm_type=elem_type,
        name=tags.get("name") or tags.get("name:es"),
        brand=(
            tags.get("brand")
            or tags.get("operator")
            or tags.get("network")
        ),
        brand_wikidata=tags.get("brand:wikidata"),
        operator=tags.get("operator"),
        ref_mx_cre=tags.get("ref:MX:CRE") or tags.get("ref:cre"),
        addr_street=full_addr,
        addr_housenumber=addr_housenumber,
        addr_suburb=addr_suburb,
        addr_city=addr_city,
        addr_state=addr_state,
        addr_postcode=addr_postcode,
        lat=lat,
        lng=lng,
        tags=tags,
    )


def _parse_overpass_response(data: dict[str, Any]) -> list[RawOSMStation]:
    """Parse the full Overpass JSON response into a list of RawOSMStation."""
    elements = data.get("elements", [])
    stations: list[RawOSMStation] = []
    skipped = 0

    for element in elements:
        tags = _extract_tags(element)
        # Only process elements explicitly tagged as fuel stations
        if tags.get("amenity") != "fuel":
            continue

        station = _parse_osm_element(element)
        if station is not None:
            stations.append(station)
        else:
            skipped += 1

    log.info(
        "osm_parse_complete",
        elements_total=len(elements),
        stations_parsed=len(stations),
        skipped=skipped,
    )
    return stations


# ═══════════════════════════════════════════════════════════
# RATE LIMITER
# ═══════════════════════════════════════════════════════════

def _rate_limit() -> None:
    """Block until it is safe to make another Overpass request."""
    global _last_request_time
    elapsed = time.time() - _last_request_time
    if elapsed < _MIN_INTERVAL_SECONDS:
        wait_time = _MIN_INTERVAL_SECONDS - elapsed
        log.debug("osm_rate_limit_wait", wait_seconds=round(wait_time, 1))
        time.sleep(wait_time)
    _last_request_time = time.time()


# ═══════════════════════════════════════════════════════════
# HTTP RETRY
# ═══════════════════════════════════════════════════════════

def _retry_osm():
    return retry(
        stop=stop_after_attempt(HTTP_RETRY_ATTEMPTS),
        wait=wait_exponential(multiplier=2, min=30, max=120),
        retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException)),
        reraise=True,
    )


# ═══════════════════════════════════════════════════════════
# OSM CLIENT
# ═══════════════════════════════════════════════════════════

class OSMClient:
    """
    Client for the OpenStreetMap Overpass API.
    Fetches all amenity=fuel stations within Mexico.
    """

    def __init__(self, primary_url: str = OSM_OVERPASS_URL) -> None:
        self._primary_url = primary_url
        self._fallback_url = OSM_OVERPASS_URL_FALLBACK
        self._consecutive_failures = 0

    @_retry_osm()
    def _post(self, url: str, query: str) -> dict[str, Any]:
        _rate_limit()
        with httpx.Client(
            timeout=180.0,  # Overpass queries can be slow for large areas
            headers={"User-Agent": HTTP_USER_AGENT},
            follow_redirects=True,
        ) as client:
            response = client.post(url, data={"data": query})
            response.raise_for_status()
            return response.json()

    def fetch_fuel_stations(self, bbox: str = MEXICO_BBOX_OVERPASS) -> list[RawOSMStation]:
        """
        Fetch all amenity=fuel stations within the given bounding box.
        bbox: "south,west,north,east"
        Returns list of RawOSMStation.
        """
        query = _build_overpass_query(bbox)
        log.info("osm_fetch_start", bbox=bbox, url=self._primary_url)
        start = time.time()

        try:
            data = self._post(self._primary_url, query)
        except Exception as e:
            log.warning("osm_primary_failed_trying_fallback", error=str(e))
            try:
                data = self._post(self._fallback_url, query)
            except Exception as e2:
                self._consecutive_failures += 1
                log.error("osm_both_servers_failed", error=str(e2))
                raise

        stations = _parse_overpass_response(data)
        self._consecutive_failures = 0

        log.info(
            "osm_fetch_complete",
            stations=len(stations),
            duration_s=round(time.time() - start, 2),
        )
        return stations

    def fetch_and_save(self, batch_id: str) -> tuple[list[RawOSMStation], Path]:
        """Fetch OSM stations and save raw parquet. Returns (stations, path)."""
        stations = self.fetch_fuel_stations()
        raw_dicts = [s.model_dump() for s in stations]

        import pandas as pd
        date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
        filename = f"osm_fuel_{date_str}_{batch_id[:8]}.parquet"
        path = RAW_DIR / filename
        pd.DataFrame(raw_dicts).to_parquet(path, index=False, compression="snappy")
        log.info("osm_raw_saved", path=str(path), rows=len(raw_dicts))
        return stations, path

    def fetch_state_bbox(self, state_bbox: dict[str, float]) -> list[RawOSMStation]:
        """
        Fetch stations within a specific state bounding box.
        Useful for incremental or targeted updates.

        state_bbox: {"south": float, "west": float, "north": float, "east": float}
        """
        bbox = (
            f"{state_bbox['south']},{state_bbox['west']},"
            f"{state_bbox['north']},{state_bbox['east']}"
        )
        return self.fetch_fuel_stations(bbox=bbox)


# ═══════════════════════════════════════════════════════════
# STATE BOUNDING BOXES (for incremental/targeted updates)
# ═══════════════════════════════════════════════════════════

MEXICO_STATE_BBOXES: dict[str, dict[str, float]] = {
    "CIUDAD DE MEXICO":  {"south": 19.05, "west": -99.37, "north": 19.60, "east": -98.94},
    "JALISCO":           {"south": 18.92, "west": -105.75, "north": 22.75, "east": -101.52},
    "NUEVO LEON":        {"south": 23.17, "west": -101.26, "north": 27.79, "east": -98.41},
    "ESTADO DE MEXICO":  {"south": 18.69, "west": -100.61, "north": 20.29, "east": -98.60},
    "PUEBLA":            {"south": 17.87, "west": -98.79, "north": 20.84, "east": -96.73},
}


# ═══════════════════════════════════════════════════════════
# MOCK DATA
# ═══════════════════════════════════════════════════════════

def mock_osm_stations(n: int = 20) -> list[RawOSMStation]:
    """Generate synthetic OSM station records for testing."""
    from faker import Faker
    import random
    fake = Faker("es_MX")

    brands = ["Pemex", "OXXO Gas", "Shell", "BP", "Hidrosina", "G500"]
    states = ["Jalisco", "Ciudad de Mexico", "Nuevo León", "Puebla"]

    stations = []
    for i in range(n):
        brand = brands[i % len(brands)]
        state = states[i % len(states)]
        osm_id = str(1000000 + i)

        stations.append(RawOSMStation(
            osm_id=osm_id,
            osm_type="node",
            name=f"Gasolinera {fake.last_name()} {random.choice(['Norte', 'Sur', 'Centro'])}",
            brand=brand,
            addr_city=fake.city(),
            addr_state=state,
            addr_postcode=str(fake.postcode()),
            lat=round(random.uniform(19.0, 21.0), 6),
            lng=round(random.uniform(-100.0, -98.0), 6),
            tags={"amenity": "fuel", "brand": brand, "name": f"Gasolinera {fake.last_name()}"},
        ))
    return stations
