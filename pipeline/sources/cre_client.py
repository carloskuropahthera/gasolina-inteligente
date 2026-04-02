"""
sources/cre_client.py — CRE (Comisión Reguladora de Energía) API client.

Fetches:
  - Places API: station identity, legal name, address, coordinates, CRE permit IDs
  - Prices API: daily fuel prices per station

No authentication required. May return XML or JSON depending on request headers.
"""

from __future__ import annotations

import json
import time
import xml.etree.ElementTree as ET
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
    CRE_PLACES_URL,
    CRE_PRICES_URL,
    HTTP_RETRY_ATTEMPTS,
    HTTP_RETRY_WAIT_MAX,
    HTTP_RETRY_WAIT_MIN,
    HTTP_TIMEOUT_SECONDS,
    HTTP_USER_AGENT,
    RAW_DIR,
)
from models.station import RawCREStation, StationPrice

log = structlog.get_logger(__name__)


# ═══════════════════════════════════════════════════════════
# HTTP CLIENT FACTORY
# ═══════════════════════════════════════════════════════════

def _make_client() -> httpx.Client:
    return httpx.Client(
        timeout=HTTP_TIMEOUT_SECONDS,
        headers={
            "User-Agent": HTTP_USER_AGENT,
            "Accept": "application/json, application/xml, */*",
        },
        follow_redirects=True,
    )


# ═══════════════════════════════════════════════════════════
# RETRY DECORATOR
# ═══════════════════════════════════════════════════════════

class RateLimitError(Exception):
    """Raised when CRE API returns HTTP 429 Too Many Requests."""
    def __init__(self, retry_after: int = 60):
        self.retry_after = retry_after
        super().__init__(f"CRE API rate limited — retry after {retry_after}s")


def _retry_http():
    return retry(
        stop=stop_after_attempt(HTTP_RETRY_ATTEMPTS),
        wait=wait_exponential(
            multiplier=1,
            min=HTTP_RETRY_WAIT_MIN,
            max=HTTP_RETRY_WAIT_MAX,
        ),
        retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException, RateLimitError)),
        reraise=True,
    )


# ═══════════════════════════════════════════════════════════
# RESPONSE PARSERS
# ═══════════════════════════════════════════════════════════

def _parse_json_places(data: list[dict] | dict) -> list[dict[str, Any]]:
    """Parse JSON response from CRE Places API."""
    if isinstance(data, dict):
        # Some responses wrap the list under a key
        for key in ("places", "Place", "Gasolineras", "result", "data"):
            if key in data:
                data = data[key]
                break
    if not isinstance(data, list):
        return []
    return data


def _parse_xml_places(xml_text: str) -> list[dict[str, Any]]:
    """
    Parse XML response from CRE Places API.

    The live CRE API returns this structure:
        <places>
          <place place_id="2039">
            <name>ESTACION HIPODROMO, S.A. DE C.V.</name>
            <cre_id>PL/658/EXP/ES/2015</cre_id>
            <location>
              <x>-116.9214</x>
              <y>32.47641</y>
            </location>
          </place>
          ...
        </places>

    Key quirks handled:
      - place_id is an XML *attribute*, not a child element
      - x/y coordinates are grandchildren nested under <location>
    """
    stations: list[dict[str, Any]] = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        log.error("cre_xml_parse_error", error=str(e))
        return []

    # Support <places><place>, <Places><Place>, <ArrayOfPlace><Place>, etc.
    elements = (
        root.findall(".//place")
        or root.findall(".//Place")
        or list(root)
    )

    for el in elements:
        record: dict[str, Any] = {}

        # 1. Grab XML attributes (e.g. place_id="2039")
        for attr_key, attr_val in el.attrib.items():
            tag = attr_key.split("}")[-1].lower()  # strip namespace if any
            record[tag] = attr_val

        # 2. Grab direct child elements
        for child in el:
            tag = child.tag.split("}")[-1].lower()

            if len(child):
                # Has sub-children (e.g. <location><x>…</x><y>…</y></location>)
                for grandchild in child:
                    gtag = grandchild.tag.split("}")[-1].lower()
                    record[gtag] = grandchild.text
            else:
                record[tag] = child.text

        if record:
            stations.append(record)

    log.debug("cre_xml_places_parsed", count=len(stations))
    return stations


def _normalize_places_record(raw: dict[str, Any]) -> dict[str, Any]:
    """
    Normalize a raw record dict to the expected field names
    regardless of whether it came from JSON or XML.
    """
    # Build a lowercase key lookup
    lc: dict[str, Any] = {k.lower(): v for k, v in raw.items()}

    def get(*keys: str) -> Optional[str]:
        for k in keys:
            v = lc.get(k)
            if v is not None and str(v).strip():
                return str(v).strip()
        return None

    def get_float(*keys: str) -> Optional[float]:
        for k in keys:
            v = lc.get(k)
            if v is not None:
                try:
                    f = float(str(v).replace(",", "."))
                    return f if f != 0.0 else None
                except (TypeError, ValueError):
                    continue
        return None

    return {
        "place_id":    get("place_id", "placeid", "id_place", "id"),
        "cre_id":      get("cre_id", "creid", "id_estacion", "estacion_id"),
        "nombre":      get("nombre", "name", "nombre_estacion", "nom_estab"),
        "razon_social": get("razon_social", "razonsocial", "razon", "legal_name"),
        "marca":       get("marca", "brand", "franquicia"),
        "domicilio":   get("domicilio", "address", "direccion", "calle"),
        "municipio":   get("municipio", "municipality", "ciudad"),
        "estado":      get("estado", "state", "entidad"),
        "cp":          get("cp", "postal_code", "codigo_postal", "zip"),
        "latitud":     get_float("latitud", "lat", "latitude", "y"),
        "longitud":    get_float("longitud", "lon", "lng", "longitude", "x"),
    }


def _parse_json_prices(data: list[dict] | dict) -> list[dict[str, Any]]:
    """Parse JSON response from CRE Prices API."""
    if isinstance(data, dict):
        for key in ("prices", "Prices", "result", "data", "precios"):
            if key in data:
                data = data[key]
                break
    if not isinstance(data, list):
        return []
    return data


def _parse_xml_prices(xml_text: str) -> list[dict[str, Any]]:
    """
    Parse the CRE Prices API XML response.

    Structure (each place_id can appear multiple times, once per fuel type):
        <places>
          <place place_id="11703">
            <gas_price type="regular">22.95</gas_price>
            <gas_price type="premium">25.54</gas_price>
          </place>
          <place place_id="11702">
            <gas_price type="premium">28.5</gas_price>
          </place>
          <place place_id="11702">
            <gas_price type="regular">24.7</gas_price>
            <gas_price type="diesel">29.95</gas_price>
          </place>
          ...
        </places>

    Returns one record per place_id with all fuel types merged.
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        log.error("cre_xml_prices_parse_error", error=str(e))
        return []

    # Aggregate by place_id (same id can appear on multiple <place> elements)
    merged: dict[str, dict[str, Any]] = {}

    for el in root.findall(".//place") or root.findall(".//Place") or list(root):
        place_id = el.attrib.get("place_id") or el.attrib.get("Place_id")
        if not place_id:
            continue

        rec = merged.setdefault(place_id, {"place_id": place_id})

        for child in el:
            tag = child.tag.split("}")[-1].lower()
            if tag == "gas_price":
                fuel_type = (child.attrib.get("type") or "").lower().strip()
                value = child.text
                if fuel_type in ("regular", "magna"):
                    rec["gasolina_regular"] = value
                elif fuel_type == "premium":
                    rec["gasolina_premium"] = value
                elif fuel_type == "diesel":
                    rec["diesel"] = value
            else:
                rec[tag] = child.text

    result = list(merged.values())
    log.debug("cre_xml_prices_parsed", count=len(result))
    return result


def _normalize_prices_record(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize raw price record field names."""
    lc: dict[str, Any] = {k.lower(): v for k, v in raw.items()}

    def get(*keys: str) -> Optional[str]:
        for k in keys:
            v = lc.get(k)
            if v is not None and str(v).strip():
                return str(v).strip()
        return None

    def get_float(*keys: str) -> Optional[float]:
        for k in keys:
            v = lc.get(k)
            if v is not None and str(v).strip():
                try:
                    return float(str(v).replace(",", "."))
                except (TypeError, ValueError):
                    continue
        return None

    return {
        "cre_id":            get("cre_id", "creid", "id_estacion", "id"),
        "place_id":          get("place_id", "placeid"),
        "gasolina_regular":  get_float("gasolina_regular", "regular", "magna", "precio_regular"),
        "gasolina_premium":  get_float("gasolina_premium", "premium", "precio_premium"),
        "diesel":            get_float("diesel", "precio_diesel"),
    }


# ═══════════════════════════════════════════════════════════
# RAW ZONE WRITER
# ═══════════════════════════════════════════════════════════

def save_raw_parquet(data: list[dict[str, Any]], source_name: str, batch_id: str) -> Path:
    """
    Save raw records to a dated Parquet file in RAW_DIR.
    Returns the path to the written file.
    """
    import pandas as pd

    date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    filename = f"{source_name}_{date_str}_{batch_id[:8]}.parquet"
    path = RAW_DIR / filename

    if not data:
        log.warning("save_raw_parquet_empty", source=source_name, batch_id=batch_id)
        return path

    df = pd.DataFrame(data)
    df.to_parquet(path, index=False, compression="snappy")
    log.info("raw_parquet_saved", path=str(path), rows=len(df), source=source_name)
    return path


# ═══════════════════════════════════════════════════════════
# CRE CLIENT
# ═══════════════════════════════════════════════════════════

class CREClient:
    """
    Client for the CRE public API.
    Handles both JSON and XML responses.
    No authentication required.
    """

    def __init__(self) -> None:
        self._consecutive_failures = 0

    @_retry_http()
    def _get(self, url: str, params: Optional[dict] = None) -> httpx.Response:
        with _make_client() as client:
            response = client.get(url, params=params)
            if response.status_code == 429:
                retry_after = int(response.headers.get("Retry-After", 60))
                log.warning("cre_rate_limited", retry_after=retry_after, url=url)
                time.sleep(retry_after)
                raise RateLimitError(retry_after)
            response.raise_for_status()
            return response

    def _parse_response(self, response: httpx.Response) -> list[dict[str, Any]]:
        """
        Auto-detect JSON vs XML and parse accordingly.
        Returns a list of raw record dicts.
        """
        content_type = response.headers.get("content-type", "").lower()
        # Strip BOM (\ufeff) — CRE API returns UTF-8 XML with a BOM prepended,
        # which causes startswith("<") to fail and json() to raise.
        text = response.text.strip().lstrip('\ufeff')

        if "xml" in content_type or text.startswith("<"):
            log.debug("cre_response_xml", bytes=len(text))
            return _parse_xml_places(text)

        try:
            parsed = response.json()
            return _parse_json_places(parsed)
        except (json.JSONDecodeError, ValueError):
            # Try XML as fallback
            if text.startswith("<"):
                return _parse_xml_places(text)
            log.error("cre_parse_failed", content_type=content_type, preview=text[:200])
            return []

    def fetch_places(self) -> list[RawCREStation]:
        """
        Fetch all station records from the CRE Places API.
        Returns a list of RawCREStation models.
        """
        log.info("cre_fetch_places_start", url=CRE_PLACES_URL)
        start = time.time()

        try:
            response = self._get(CRE_PLACES_URL)
            raw_records = self._parse_response(response)
            normalized = [_normalize_places_record(r) for r in raw_records]
            stations = []
            failed = 0
            for rec in normalized:
                try:
                    stations.append(RawCREStation(**rec))
                except Exception as e:
                    failed += 1
                    log.debug("cre_station_parse_skip", error=str(e), record=str(rec)[:100])

            self._consecutive_failures = 0
            log.info(
                "cre_fetch_places_complete",
                total=len(raw_records),
                parsed=len(stations),
                failed=failed,
                duration_s=round(time.time() - start, 2),
            )
            return stations

        except Exception as e:
            self._consecutive_failures += 1
            log.error(
                "cre_fetch_places_error",
                error=str(e),
                consecutive_failures=self._consecutive_failures,
            )
            raise

    def fetch_prices(self) -> list[StationPrice]:
        """
        Fetch all current fuel prices from the CRE Prices API.
        Returns a list of StationPrice models.
        """
        log.info("cre_fetch_prices_start", url=CRE_PRICES_URL)
        start = time.time()

        try:
            response = self._get(CRE_PRICES_URL)
            content_type = response.headers.get("content-type", "").lower()
            # Strip BOM (\ufeff) — same issue as Places API
            text = response.text.strip().lstrip('\ufeff')

            if "xml" in content_type or text.startswith("<"):
                raw_records = _parse_xml_prices(text)
            else:
                try:
                    raw_records = _parse_json_prices(response.json())
                except (json.JSONDecodeError, ValueError):
                    raw_records = []

            prices = []
            failed = 0
            for rec in raw_records:
                try:
                    normalized = _normalize_prices_record(rec)
                    prices.append(StationPrice(**normalized))
                except Exception as e:
                    failed += 1
                    log.debug("cre_price_parse_skip", error=str(e))

            self._consecutive_failures = 0
            log.info(
                "cre_fetch_prices_complete",
                total=len(raw_records),
                parsed=len(prices),
                failed=failed,
                duration_s=round(time.time() - start, 2),
            )
            return prices

        except Exception as e:
            self._consecutive_failures += 1
            log.error("cre_fetch_prices_error", error=str(e))
            raise

    def fetch_and_save_places(self, batch_id: str) -> tuple[list[RawCREStation], Path]:
        """Fetch places and save raw parquet. Returns (stations, parquet_path)."""
        stations = self.fetch_places()
        raw_dicts = [s.model_dump() for s in stations]
        path = save_raw_parquet(raw_dicts, "cre_places", batch_id)
        return stations, path

    def fetch_and_save_prices(self, batch_id: str) -> tuple[list[StationPrice], Path]:
        """Fetch prices and save raw parquet. Returns (prices, parquet_path)."""
        prices = self.fetch_prices()
        raw_dicts = [p.model_dump() for p in prices]
        path = save_raw_parquet(raw_dicts, "cre_prices", batch_id)
        return prices, path


# ═══════════════════════════════════════════════════════════
# MOCK DATA FOR TESTING
# ═══════════════════════════════════════════════════════════

def mock_cre_stations(n: int = 20) -> list[RawCREStation]:
    """Generate synthetic CRE station records for testing."""
    from faker import Faker
    fake = Faker("es_MX")

    brands = ["PEMEX", "OXXO GAS", "SHELL", "BP", "HIDROSINA", "G500", "TOTALENERGIES"]
    states = [
        "CIUDAD DE MEXICO", "JALISCO", "NUEVO LEON", "ESTADO DE MEXICO",
        "PUEBLA", "GUANAJUATO", "CHIHUAHUA"
    ]

    stations = []
    for i in range(n):
        brand = brands[i % len(brands)]
        state = states[i % len(states)]
        stations.append(RawCREStation(
            place_id=f"MX{i:05d}",
            cre_id=f"ES-01-{state[:3]}-{i:05d}",
            nombre=f"GASOLINERA {fake.last_name().upper()} {fake.random_element(['NORTE', 'SUR', 'CENTRO', 'ORIENTE'])}",
            razon_social=f"COMBUSTIBLES {fake.last_name().upper()} S.A. DE C.V.",
            marca=brand,
            domicilio=f"AV. {fake.street_name().upper()} {fake.building_number()}",
            municipio=fake.city().upper(),
            estado=state,
            cp=str(fake.postcode()),
            latitud=float(fake.latitude()),
            longitud=float(fake.longitude()),
        ))
    return stations


def mock_cre_prices(stations: list[RawCREStation]) -> list[StationPrice]:
    """Generate synthetic price records matching a list of stations."""
    import random
    prices = []
    for s in stations:
        prices.append(StationPrice(
            cre_id=s.cre_id,
            place_id=s.place_id,
            gasolina_regular=round(random.uniform(21.0, 24.0), 2),
            gasolina_premium=round(random.uniform(23.0, 26.0), 2),
            diesel=round(random.uniform(22.0, 25.0), 2),
        ))
    return prices
