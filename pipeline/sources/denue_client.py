"""
sources/denue_client.py — INEGI DENUE bulk CSV client.

Downloads the DENUE bulk dataset and filters for SCIAN code 46411
(Expendio de gasolina y demás combustibles para vehículos automotores
 que no combinan esta actividad con servicio de reparación).

DENUE is published under Licencia de Libre Uso MX (open data).
Attribution: "Fuente: INEGI, Directorio Estadístico Nacional de Unidades Económicas"

The bulk CSV is a ZIP archive containing one or more CSV files.
"""

from __future__ import annotations

import csv
import io
import time
import zipfile
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
    DENUE_BULK_CSV_URL,
    DENUE_SCIAN_GAS,
    HTTP_RETRY_ATTEMPTS,
    HTTP_RETRY_WAIT_MAX,
    HTTP_RETRY_WAIT_MIN,
    HTTP_TIMEOUT_SECONDS,
    HTTP_USER_AGENT,
    RAW_DIR,
    STAGING_DIR,
)
from models.station import RawDENUEStation

log = structlog.get_logger(__name__)

# Cached local path for the bulk CSV zip (avoid re-downloading same day)
_LOCAL_ZIP_PATH = STAGING_DIR / "denue_bulk_latest.zip"


# ═══════════════════════════════════════════════════════════
# COLUMN MAPPINGS
# ═══════════════════════════════════════════════════════════

# DENUE CSV columns that map to RawDENUEStation fields
# The CSV uses specific Spanish column names that vary slightly across versions
COLUMN_ALIASES: dict[str, list[str]] = {
    "denue_id":   ["id", "clee", "id_estab"],
    "nom_estab":  ["nom_estab", "nombre_establecimiento"],
    "raz_social": ["raz_social", "razon_social"],
    "nombre_act": ["nombre_act", "actividad"],
    "per_ocu":    ["per_ocu", "per_ocu_label", "personal_ocupado"],
    "telefono":   ["telefono", "tel"],
    "correoelec": ["correoelec", "email", "correo"],
    "tipo_vial":  ["tipo_vial", "tipo_vialidad"],
    "nom_vial":   ["nom_vial", "nombre_vialidad", "calle"],
    "tipo_v_e_1": ["tipo_v_e_1"],
    "nom_v_e_1":  ["nom_v_e_1"],
    "numero_ext": ["numero_ext", "num_ext"],
    "letra_ext":  ["letra_ext"],
    "tipo_asent": ["tipo_asent", "tipo_asentamiento"],
    "nomb_asent": ["nomb_asent", "nombre_asentamiento", "colonia"],
    "cod_postal": ["cod_postal", "cp"],
    "cve_ent":    ["cve_ent", "id_entidad_federativa"],
    "entidad":    ["entidad", "estado", "entidad_federativa"],
    "cve_mun":    ["cve_mun", "id_municipio"],
    "municipio":  ["municipio", "ciudad"],
    "localidad":  ["localidad", "nombre_localidad"],
    "latitud":    ["latitud", "lat"],
    "longitud":   ["longitud", "lon", "lng", "longitud"],
    "fecha_alta": ["fecha_alta"],
    "codigo_act": ["codigo_act", "scian", "codigo_scian"],
}


def _build_column_map(header: list[str]) -> dict[str, str]:
    """
    Given the actual CSV header row, build a mapping from
    our canonical field name → actual CSV column name.
    """
    header_lower = {col.lower().strip(): col for col in header}
    column_map: dict[str, str] = {}

    for canonical, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            if alias.lower() in header_lower:
                column_map[canonical] = header_lower[alias.lower()]
                break

    return column_map


def _row_to_dict(row: dict[str, str], column_map: dict[str, str]) -> dict[str, Any]:
    """Convert a CSV row dict to a RawDENUEStation-compatible dict using column_map."""
    result: dict[str, Any] = {}
    for canonical, csv_col in column_map.items():
        val = row.get(csv_col, "").strip()
        result[canonical] = val if val else None
    return result


# ═══════════════════════════════════════════════════════════
# ZIP / CSV PARSING
# ═══════════════════════════════════════════════════════════

def _parse_denue_zip(zip_bytes: bytes, scian_code: str = DENUE_SCIAN_GAS) -> list[RawDENUEStation]:
    """
    Parse a DENUE bulk ZIP archive.
    Filters records where codigo_act starts with scian_code.
    Returns list of RawDENUEStation.
    """
    stations: list[RawDENUEStation] = []
    total_rows = 0
    matched_rows = 0
    parse_errors = 0

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        csv_files = [name for name in zf.namelist() if name.lower().endswith(".csv")]
        log.info("denue_zip_contents", csv_files=csv_files)

        for csv_filename in csv_files:
            log.info("denue_parsing_csv", filename=csv_filename)

            with zf.open(csv_filename) as f:
                # DENUE CSVs are typically encoded in UTF-8 or Latin-1
                try:
                    content = f.read().decode("utf-8-sig")
                except UnicodeDecodeError:
                    f.seek(0)
                    content = f.read().decode("latin-1")

            reader = csv.DictReader(io.StringIO(content))
            if reader.fieldnames is None:
                log.warning("denue_csv_no_header", filename=csv_filename)
                continue

            header = list(reader.fieldnames)
            column_map = _build_column_map(header)
            log.debug("denue_column_map", mapped_fields=len(column_map), filename=csv_filename)

            if "codigo_act" not in column_map:
                log.warning("denue_no_scian_column", filename=csv_filename, header=header[:10])

            for row in reader:
                total_rows += 1

                # Filter by SCIAN code
                if "codigo_act" in column_map:
                    raw_code = row.get(column_map["codigo_act"], "").strip()
                    if not raw_code.startswith(scian_code):
                        continue

                matched_rows += 1
                record_dict = _row_to_dict(row, column_map)

                try:
                    station = RawDENUEStation(**record_dict)
                    stations.append(station)
                except Exception as e:
                    parse_errors += 1
                    log.debug("denue_record_parse_error", error=str(e))

    log.info(
        "denue_parse_complete",
        total_rows=total_rows,
        matched_rows=matched_rows,
        parsed_stations=len(stations),
        parse_errors=parse_errors,
    )
    return stations


# ═══════════════════════════════════════════════════════════
# HTTP CLIENT
# ═══════════════════════════════════════════════════════════

@retry(
    stop=stop_after_attempt(HTTP_RETRY_ATTEMPTS),
    wait=wait_exponential(multiplier=1, min=HTTP_RETRY_WAIT_MIN, max=HTTP_RETRY_WAIT_MAX),
    retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException)),
    reraise=True,
)
def _download_zip(url: str) -> bytes:
    """Download a ZIP file with streaming to handle large files."""
    log.info("denue_download_start", url=url)
    start = time.time()

    with httpx.Client(
        timeout=600.0,  # DENUE bulk file can be hundreds of MB
        headers={"User-Agent": HTTP_USER_AGENT},
        follow_redirects=True,
    ) as client:
        chunks: list[bytes] = []
        total_bytes = 0

        with client.stream("GET", url) as response:
            response.raise_for_status()
            for chunk in response.iter_bytes(chunk_size=1024 * 1024):
                chunks.append(chunk)
                total_bytes += len(chunk)

        content = b"".join(chunks)

    log.info(
        "denue_download_complete",
        bytes=total_bytes,
        mb=round(total_bytes / 1024 / 1024, 1),
        duration_s=round(time.time() - start, 2),
    )
    return content


# ═══════════════════════════════════════════════════════════
# DENUE CLIENT
# ═══════════════════════════════════════════════════════════

class DENUEClient:
    """
    Client for INEGI DENUE bulk CSV download.
    Filters to SCIAN code 46411 (gas stations).
    """

    def __init__(self, bulk_url: str = DENUE_BULK_CSV_URL) -> None:
        self._bulk_url = bulk_url
        self._consecutive_failures = 0

    def download_bulk(self, force: bool = False) -> bytes:
        """
        Download the DENUE bulk ZIP.
        Uses cached local copy if available and force=False.
        """
        if not force and _LOCAL_ZIP_PATH.exists():
            age_hours = (time.time() - _LOCAL_ZIP_PATH.stat().st_mtime) / 3600
            if age_hours < 720:  # 30 days
                log.info("denue_using_cached_zip", age_hours=round(age_hours, 1))
                return _LOCAL_ZIP_PATH.read_bytes()

        zip_bytes = _download_zip(self._bulk_url)
        _LOCAL_ZIP_PATH.write_bytes(zip_bytes)
        log.info("denue_zip_cached", path=str(_LOCAL_ZIP_PATH))
        return zip_bytes

    def fetch_gas_stations(self, force_download: bool = False) -> list[RawDENUEStation]:
        """
        Download DENUE bulk data and filter for gas stations (SCIAN 46411).
        Returns list of RawDENUEStation.
        """
        log.info("denue_fetch_start", scian=DENUE_SCIAN_GAS)
        start = time.time()

        try:
            zip_bytes = self.download_bulk(force=force_download)
            stations = _parse_denue_zip(zip_bytes, scian_code=DENUE_SCIAN_GAS)
            self._consecutive_failures = 0
            log.info(
                "denue_fetch_complete",
                stations=len(stations),
                duration_s=round(time.time() - start, 2),
            )
            return stations

        except Exception as e:
            self._consecutive_failures += 1
            log.error("denue_fetch_error", error=str(e), consecutive_failures=self._consecutive_failures)
            raise

    def fetch_and_save(self, batch_id: str) -> tuple[list[RawDENUEStation], Path]:
        """Fetch DENUE stations and save raw parquet. Returns (stations, path)."""
        import pandas as pd

        stations = self.fetch_gas_stations()
        raw_dicts = [s.model_dump() for s in stations]

        date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
        filename = f"denue_gasolineras_{date_str}_{batch_id[:8]}.parquet"
        path = RAW_DIR / filename
        pd.DataFrame(raw_dicts).to_parquet(path, index=False, compression="snappy")
        log.info("denue_raw_saved", path=str(path), rows=len(raw_dicts))
        return stations, path

    def load_from_local_csv(self, csv_path: Path) -> list[RawDENUEStation]:
        """
        Load from a manually downloaded DENUE CSV (for when bulk URL requires
        manual browser download due to captcha/session).
        """
        log.info("denue_load_local_csv", path=str(csv_path))
        csv_path_obj = Path(csv_path)

        if csv_path_obj.suffix.lower() == ".zip":
            zip_bytes = csv_path_obj.read_bytes()
            return _parse_denue_zip(zip_bytes)
        elif csv_path_obj.suffix.lower() == ".csv":
            # Wrap in a fake zip structure
            content_bytes = csv_path_obj.read_bytes()
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as zf:
                zf.writestr(csv_path_obj.name, content_bytes)
            return _parse_denue_zip(buf.getvalue())
        else:
            raise ValueError(f"Unsupported file type: {csv_path_obj.suffix}")


# ═══════════════════════════════════════════════════════════
# MOCK DATA
# ═══════════════════════════════════════════════════════════

def mock_denue_stations(n: int = 20) -> list[RawDENUEStation]:
    """Generate synthetic DENUE station records for testing."""
    from faker import Faker
    import random
    fake = Faker("es_MX")

    states = [
        ("09", "CIUDAD DE MEXICO"),
        ("14", "JALISCO"),
        ("19", "NUEVO LEON"),
        ("15", "ESTADO DE MEXICO"),
    ]

    stations = []
    for i in range(n):
        cve_ent, entidad = states[i % len(states)]
        stations.append(RawDENUEStation(
            denue_id=f"{i:08d}",
            nom_estab=f"ESTACION DE SERVICIO {fake.last_name().upper()}",
            raz_social=f"GASOLINERA {fake.last_name().upper()} S.A. DE C.V.",
            nombre_act="Expendio de gasolina y demás combustibles para vehículos",
            tipo_vial="CALLE",
            nom_vial=fake.street_name().upper(),
            numero_ext=str(random.randint(1, 999)),
            tipo_asent="COLONIA",
            nomb_asent=fake.last_name().upper(),
            cod_postal=str(fake.postcode()),
            cve_ent=cve_ent,
            entidad=entidad,
            municipio=fake.city().upper(),
            latitud=round(random.uniform(19.0, 21.0), 6),
            longitud=round(random.uniform(-100.0, -98.0), 6),
            codigo_act=DENUE_SCIAN_GAS,
        ))
    return stations
