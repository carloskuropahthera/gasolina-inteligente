"""
brand_scraper.py — Brand locator page scrapers for PEMEX, OXXO GAS, Shell MX, BP Mexico.

Uses httpx for HTML-based scrapes and falls back to Playwright for JS-rendered pages.
Each scraper returns a list of RawBrandStation dicts, normalized before returning.

Rate limiting: 1 request per 2 seconds (BRAND_REQUESTS_PER_SECOND = 0.5 in config).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import httpx

from ..config import (
    PEMEX_LOCATOR_URL,
    OXXOGAS_LOCATOR_URL,
    SHELL_LOCATOR_URL,
    BP_LOCATOR_URL,
    HTTP_TIMEOUT_SECONDS,
    HTTP_USER_AGENT,
    BRAND_REQUESTS_PER_SECOND,
    RAW_DIR,
)
from ..normalize.brands import normalize_brand
from ..normalize.text import normalize_name
from ..normalize.address import normalize_state

log = logging.getLogger(__name__)

# ─── Data Shape ──────────────────────────────────────────────────────────────

@dataclass
class RawBrandStation:
    brand:       str
    name:        str
    address:     str
    city:        str
    state:       str
    zip_code:    str
    lat:         float | None
    lng:         float | None
    phone:       str
    services:    list[str]   # e.g. ["regular", "premium", "diesel", "car_wash"]
    source:      str         # "pemex" | "oxxogas" | "shell" | "bp"
    source_url:  str
    fetched_at:  str         = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    batch_id:    str         = field(default_factory=lambda: str(uuid4()))
    raw_payload: dict        = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


# ─── HTTP Client ─────────────────────────────────────────────────────────────

def _make_client() -> httpx.Client:
    return httpx.Client(
        timeout=HTTP_TIMEOUT_SECONDS,
        headers={
            "User-Agent":      HTTP_USER_AGENT,
            "Accept":          "application/json, text/html, */*",
            "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
        },
        follow_redirects=True,
    )


def _rate_limit():
    """Block for the configured inter-request delay."""
    time.sleep(1.0 / BRAND_REQUESTS_PER_SECOND)


# ─── PEMEX Scraper ────────────────────────────────────────────────────────────
# PEMEX exposes a JSON API endpoint used by the station locator React app.
# The endpoint returns paginated GeoJSON features.

PEMEX_API_URL = "https://www.pemex.com/api/smp/estaciones"
PEMEX_PAGE_SIZE = 500


def scrape_pemex() -> list[RawBrandStation]:
    """
    Scrape PEMEX station locator API.
    Returns list of RawBrandStation with normalized fields.
    """
    results: list[RawBrandStation] = []
    page = 1

    with _make_client() as client:
        while True:
            try:
                _rate_limit()
                resp = client.get(
                    PEMEX_API_URL,
                    params={"page": page, "pageSize": PEMEX_PAGE_SIZE},
                )
                resp.raise_for_status()
                data = resp.json()
            except (httpx.HTTPError, json.JSONDecodeError, KeyError) as exc:
                log.warning("PEMEX page %d failed: %s", page, exc)
                break

            features = data.get("features") or data.get("estaciones") or []
            if not features:
                break

            for feat in features:
                try:
                    props = feat.get("properties") or feat
                    coords = feat.get("geometry", {}).get("coordinates")
                    lat = float(coords[1]) if coords and len(coords) >= 2 else None
                    lng = float(coords[0]) if coords and len(coords) >= 2 else None

                    station = RawBrandStation(
                        brand      = "PEMEX",
                        name       = normalize_name(props.get("nombre") or props.get("name") or ""),
                        address    = props.get("direccion") or props.get("address") or "",
                        city       = props.get("municipio") or props.get("ciudad") or "",
                        state      = normalize_state(props.get("estado") or props.get("state") or ""),
                        zip_code   = str(props.get("cp") or props.get("zipCode") or ""),
                        lat        = lat,
                        lng        = lng,
                        phone      = props.get("telefono") or props.get("phone") or "",
                        services   = _parse_pemex_services(props),
                        source     = "pemex",
                        source_url = PEMEX_API_URL,
                        raw_payload= props,
                    )
                    results.append(station)
                except Exception as exc:
                    log.debug("PEMEX feature parse error: %s", exc)
                    continue

            log.info("PEMEX page %d: %d stations (total so far: %d)", page, len(features), len(results))

            # Stop if we got a partial page
            if len(features) < PEMEX_PAGE_SIZE:
                break
            page += 1

    log.info("PEMEX scrape complete: %d stations", len(results))
    return results


def _parse_pemex_services(props: dict) -> list[str]:
    services = []
    service_map = {
        "gasolina_regular": "regular",
        "gasolina_premium": "premium",
        "diesel":           "diesel",
        "lavado":           "car_wash",
        "tienda":           "convenience_store",
        "abarrotes":        "convenience_store",
    }
    for key, label in service_map.items():
        val = props.get(key)
        if val and str(val).strip() not in ("", "0", "false", "False", "N"):
            if label not in services:
                services.append(label)
    return services


# ─── OXXO GAS Scraper ─────────────────────────────────────────────────────────
# OXXO GAS loads stations via a JSON API behind their React SPA.

OXXOGAS_API_URL = "https://www.oxxogas.com/api/estaciones"


def scrape_oxxogas() -> list[RawBrandStation]:
    """
    Scrape OXXO GAS station locator API.
    OXXO GAS uses a REST endpoint that returns all stations in one call.
    """
    results: list[RawBrandStation] = []

    with _make_client() as client:
        try:
            _rate_limit()
            resp = client.get(OXXOGAS_API_URL)
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            log.warning("OXXO GAS API failed, attempting fallback HTML scrape: %s", exc)
            return _scrape_oxxogas_html_fallback(client)

    stations_raw = data if isinstance(data, list) else data.get("estaciones") or data.get("data") or []

    for item in stations_raw:
        try:
            lat = _safe_float(item.get("latitud") or item.get("lat"))
            lng = _safe_float(item.get("longitud") or item.get("lng") or item.get("lon"))

            station = RawBrandStation(
                brand      = "OXXO GAS",
                name       = normalize_name(item.get("nombre") or item.get("name") or "OXXO GAS"),
                address    = item.get("direccion") or item.get("address") or "",
                city       = item.get("municipio") or item.get("ciudad") or "",
                state      = normalize_state(item.get("estado") or ""),
                zip_code   = str(item.get("cp") or ""),
                lat        = lat,
                lng        = lng,
                phone      = item.get("telefono") or "",
                services   = ["regular", "premium", "diesel"],  # All OXXO GAS carry all 3
                source     = "oxxogas",
                source_url = OXXOGAS_API_URL,
                raw_payload= item,
            )
            results.append(station)
        except Exception as exc:
            log.debug("OXXO GAS item parse error: %s", exc)
            continue

    log.info("OXXO GAS scrape complete: %d stations", len(results))
    return results


def _scrape_oxxogas_html_fallback(client: httpx.Client) -> list[RawBrandStation]:
    """
    Fallback: fetch OXXO GAS locator page and extract embedded JSON from window.__INITIAL_STATE__.
    """
    try:
        resp = client.get(OXXOGAS_LOCATOR_URL)
        resp.raise_for_status()
        html = resp.text

        # Look for embedded JSON in script tags
        match = re.search(r'window\.__INITIAL_STATE__\s*=\s*({.+?});\s*</script>', html, re.DOTALL)
        if not match:
            match = re.search(r'window\.__data__\s*=\s*({.+?});\s*</script>', html, re.DOTALL)

        if match:
            data = json.loads(match.group(1))
            stations = _extract_nested_list(data, ["estaciones", "stations", "items"])
            log.info("OXXO GAS HTML fallback: found %d stations in embedded JSON", len(stations))
            # Re-use same normalization logic
            results = []
            for item in stations:
                try:
                    results.append(RawBrandStation(
                        brand      = "OXXO GAS",
                        name       = normalize_name(item.get("nombre") or "OXXO GAS"),
                        address    = item.get("direccion") or "",
                        city       = item.get("municipio") or "",
                        state      = normalize_state(item.get("estado") or ""),
                        zip_code   = str(item.get("cp") or ""),
                        lat        = _safe_float(item.get("latitud")),
                        lng        = _safe_float(item.get("longitud")),
                        phone      = "",
                        services   = ["regular", "premium", "diesel"],
                        source     = "oxxogas",
                        source_url = OXXOGAS_LOCATOR_URL,
                        raw_payload= item,
                    ))
                except Exception:
                    continue
            return results
    except Exception as exc:
        log.error("OXXO GAS HTML fallback also failed: %s", exc)

    return []


# ─── Shell Mexico Scraper ─────────────────────────────────────────────────────
# Shell MX uses a Dealer Locator API (same platform as many Shell global sites).

SHELL_API_URL = "https://locator.shell.com/api/v1/dealers"
SHELL_COUNTRY_CODE = "MX"


def scrape_shell() -> list[RawBrandStation]:
    """
    Scrape Shell Mexico station locator API.
    Shell uses a global dealer locator endpoint filtered by country code.
    """
    results: list[RawBrandStation] = []

    with _make_client() as client:
        try:
            _rate_limit()
            resp = client.get(
                SHELL_API_URL,
                params={
                    "countryCode": SHELL_COUNTRY_CODE,
                    "type":        "FuelStation",
                    "pageSize":    2000,
                    "page":        1,
                },
            )
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            log.warning("Shell API failed, attempting HTML fallback: %s", exc)
            return _scrape_shell_html_fallback(client)

    items = data.get("results") or data.get("dealers") or data.get("data") or []

    for item in items:
        try:
            addr = item.get("address") or {}
            geo  = item.get("geoLocation") or item.get("geometry") or {}

            lat = _safe_float(geo.get("lat") or geo.get("latitude"))
            lng = _safe_float(geo.get("lng") or geo.get("longitude"))

            station = RawBrandStation(
                brand      = "SHELL",
                name       = normalize_name(item.get("name") or item.get("nombre") or "Shell"),
                address    = addr.get("streetAddress") or addr.get("street") or item.get("address") or "",
                city       = addr.get("city") or addr.get("municipality") or "",
                state      = normalize_state(addr.get("state") or addr.get("province") or ""),
                zip_code   = str(addr.get("postalCode") or addr.get("zipCode") or ""),
                lat        = lat,
                lng        = lng,
                phone      = item.get("phone") or item.get("telephone") or "",
                services   = _parse_shell_services(item),
                source     = "shell",
                source_url = SHELL_API_URL,
                raw_payload= item,
            )
            results.append(station)
        except Exception as exc:
            log.debug("Shell item parse error: %s", exc)
            continue

    log.info("Shell MX scrape complete: %d stations", len(results))
    return results


def _scrape_shell_html_fallback(client: httpx.Client) -> list[RawBrandStation]:
    """Extract GeoJSON or embedded station data from Shell MX locator page."""
    try:
        resp = client.get(SHELL_LOCATOR_URL)
        resp.raise_for_status()
        html = resp.text

        # Shell often embeds station data as GeoJSON in a script tag
        match = re.search(r'var\s+stationsData\s*=\s*({.+?});\s*\n', html, re.DOTALL)
        if match:
            data = json.loads(match.group(1))
            features = data.get("features") or []
            results = []
            for feat in features:
                props = feat.get("properties") or {}
                coords = (feat.get("geometry") or {}).get("coordinates") or []
                results.append(RawBrandStation(
                    brand      = "SHELL",
                    name       = normalize_name(props.get("name") or "Shell"),
                    address    = props.get("address") or "",
                    city       = props.get("city") or "",
                    state      = normalize_state(props.get("state") or ""),
                    zip_code   = str(props.get("zipCode") or ""),
                    lat        = float(coords[1]) if len(coords) >= 2 else None,
                    lng        = float(coords[0]) if len(coords) >= 2 else None,
                    phone      = "",
                    services   = ["regular", "premium", "diesel"],
                    source     = "shell",
                    source_url = SHELL_LOCATOR_URL,
                    raw_payload= props,
                ))
            log.info("Shell HTML fallback: %d stations", len(results))
            return results
    except Exception as exc:
        log.error("Shell HTML fallback failed: %s", exc)

    return []


def _parse_shell_services(item: dict) -> list[str]:
    services = ["regular", "premium", "diesel"]
    amenities = item.get("amenities") or item.get("services") or []
    if isinstance(amenities, list):
        if any("wash" in str(a).lower() for a in amenities):
            services.append("car_wash")
    return services


# ─── BP Mexico Scraper ────────────────────────────────────────────────────────
# BP Mexico brand is operated by Air Products and local franchises.
# Their site loads station data from an embedded JSON object.

BP_API_URL = "https://www.bpmexico.com.mx/api/estaciones"


def scrape_bp() -> list[RawBrandStation]:
    """
    Scrape BP Mexico station locator.
    BP Mexico has fewer stations (~200) so a single-page approach works.
    """
    results: list[RawBrandStation] = []

    with _make_client() as client:
        # Try JSON API first
        try:
            _rate_limit()
            resp = client.get(BP_API_URL)
            resp.raise_for_status()
            items = resp.json()
            if not isinstance(items, list):
                items = items.get("estaciones") or items.get("data") or []
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            log.info("BP API unavailable (%s), trying HTML", exc)
            items = _fetch_bp_from_html(client)

    for item in items:
        try:
            lat = _safe_float(item.get("lat") or item.get("latitud"))
            lng = _safe_float(item.get("lng") or item.get("longitud") or item.get("lon"))

            station = RawBrandStation(
                brand      = "BP",
                name       = normalize_name(item.get("nombre") or item.get("name") or "BP"),
                address    = item.get("direccion") or item.get("address") or "",
                city       = item.get("municipio") or item.get("ciudad") or "",
                state      = normalize_state(item.get("estado") or ""),
                zip_code   = str(item.get("cp") or ""),
                lat        = lat,
                lng        = lng,
                phone      = item.get("telefono") or "",
                services   = ["regular", "premium", "diesel"],
                source     = "bp",
                source_url = BP_API_URL,
                raw_payload= item,
            )
            results.append(station)
        except Exception as exc:
            log.debug("BP item parse error: %s", exc)
            continue

    log.info("BP MX scrape complete: %d stations", len(results))
    return results


def _fetch_bp_from_html(client: httpx.Client) -> list[dict]:
    """Fetch BP locator page and extract embedded station JSON."""
    try:
        resp = client.get(BP_LOCATOR_URL)
        resp.raise_for_status()
        html = resp.text

        # Look for JSON array or object assigned to a variable
        for pattern in [
            r'var\s+(?:estaciones|stations|mapData)\s*=\s*(\[.+?\]);\s*\n',
            r'"estaciones"\s*:\s*(\[.+?\])',
        ]:
            match = re.search(pattern, html, re.DOTALL)
            if match:
                return json.loads(match.group(1))
    except Exception as exc:
        log.error("BP HTML fallback failed: %s", exc)

    return []


# ─── Playwright Fallback (JS-rendered pages) ──────────────────────────────────

async def scrape_with_playwright(url: str, brand: str) -> list[dict]:
    """
    Async fallback using Playwright for fully JS-rendered locator pages.
    Intercepts network requests to capture the underlying API call.

    Usage: asyncio.run(scrape_with_playwright(PEMEX_LOCATOR_URL, "PEMEX"))

    Requires: pip install playwright && playwright install chromium
    """
    try:
        from playwright.async_api import async_playwright  # type: ignore
    except ImportError:
        log.error("Playwright not installed. Run: pip install playwright && playwright install chromium")
        return []

    captured: list[dict] = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        page    = await browser.new_page()

        async def intercept_response(response):
            if "estacion" in response.url.lower() or "station" in response.url.lower():
                if response.status == 200:
                    try:
                        body = await response.json()
                        if isinstance(body, list):
                            captured.extend(body)
                        elif isinstance(body, dict):
                            for key in ("estaciones", "stations", "features", "data", "results"):
                                if key in body:
                                    captured.extend(body[key])
                                    break
                        log.info("Playwright intercepted %d records from %s", len(captured), response.url)
                    except Exception:
                        pass

        page.on("response", intercept_response)

        try:
            await page.goto(url, wait_until="networkidle", timeout=30_000)
            await page.wait_for_timeout(3000)  # Wait for lazy loads
        except Exception as exc:
            log.warning("Playwright page load issue for %s: %s", brand, exc)
        finally:
            await browser.close()

    log.info("Playwright scrape for %s: %d raw records captured", brand, len(captured))
    return captured


# ─── Orchestrator ─────────────────────────────────────────────────────────────

def scrape_all_brands(
    include: list[str] | None = None,
    save_raw: bool = True,
) -> dict[str, list[RawBrandStation]]:
    """
    Run all brand scrapers and optionally save raw JSON to RAW_DIR.

    Args:
        include: Optional list of brands to scrape. If None, scrapes all.
                 Values: "pemex", "oxxogas", "shell", "bp"
        save_raw: If True, saves each brand's results to RAW_DIR/brand_<name>_<date>.json

    Returns:
        Dict mapping brand key → list of RawBrandStation
    """
    scrapers = {
        "pemex":   scrape_pemex,
        "oxxogas": scrape_oxxogas,
        "shell":   scrape_shell,
        "bp":      scrape_bp,
    }

    if include:
        scrapers = {k: v for k, v in scrapers.items() if k in include}

    results: dict[str, list[RawBrandStation]] = {}
    today = datetime.now(timezone.utc).strftime("%Y%m%d")

    for brand_key, scraper_fn in scrapers.items():
        log.info("Starting %s scraper…", brand_key)
        try:
            stations = scraper_fn()
            results[brand_key] = stations
            log.info("%s: %d stations scraped", brand_key, len(stations))

            if save_raw and stations:
                out_path = RAW_DIR / f"brand_{brand_key}_{today}.json"
                out_path.write_text(
                    json.dumps([s.to_dict() for s in stations], ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                log.info("Saved %s raw data → %s", brand_key, out_path)

        except Exception as exc:
            log.error("%s scraper failed: %s", brand_key, exc, exc_info=True)
            results[brand_key] = []

    total = sum(len(v) for v in results.values())
    log.info("Brand scrape complete: %d stations across %d brands", total, len(results))
    return results


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _safe_float(val: Any) -> float | None:
    if val is None:
        return None
    try:
        f = float(val)
        return f if f != 0.0 else None
    except (TypeError, ValueError):
        return None


def _extract_nested_list(data: dict, keys: list[str]) -> list:
    """Try a list of keys to find the first non-empty list in a nested dict."""
    for key in keys:
        val = data.get(key)
        if isinstance(val, list) and val:
            return val
        # One level of nesting
        for sub in data.values():
            if isinstance(sub, dict):
                val = sub.get(key)
                if isinstance(val, list) and val:
                    return val
    return []
