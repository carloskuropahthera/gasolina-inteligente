"""
models/station.py — Pydantic v2 models for all pipeline stages.

Raw models: exactly what comes from each source API/CSV.
StagingStation: normalized representation shared across all sources.
MasterStation: the canonical curated record in station_master table.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

# ─────────────────────────────────────────────────────────────────
# Mexico bounding box (duplicated here for model independence from config)
# ─────────────────────────────────────────────────────────────────
_LAT_MIN = 14.5328
_LAT_MAX = 32.7186
_LNG_MIN = -118.5978
_LNG_MAX = -86.7104


def _validate_lat(v: Optional[float]) -> Optional[float]:
    if v is None:
        return None
    if v == 0.0:
        return None  # 0.0 is a common API placeholder for "no data"
    if not (_LAT_MIN <= v <= _LAT_MAX):
        return None  # Out of Mexico bounds — treat as missing
    return v


def _validate_lng(v: Optional[float]) -> Optional[float]:
    if v is None:
        return None
    if v == 0.0:
        return None
    if not (_LNG_MIN <= v <= _LNG_MAX):
        return None
    return v


# ═══════════════════════════════════════════════════════════
# RAW MODELS — exact field names from source APIs
# ═══════════════════════════════════════════════════════════

class RawCREStation(BaseModel):
    """
    Raw station record from CRE Places API.
    Field names match the API response exactly (snake_case normalized).
    """
    place_id: Optional[str] = None       # CRE internal place identifier
    cre_id: Optional[str] = None         # CRE permit-linked ID
    nombre: Optional[str] = None         # Commercial/common name
    razon_social: Optional[str] = None   # Legal entity name
    marca: Optional[str] = None          # Brand
    domicilio: Optional[str] = None      # Street address
    municipio: Optional[str] = None      # Municipality
    estado: Optional[str] = None         # State
    cp: Optional[str] = None             # Postal code
    latitud: Optional[float] = None
    longitud: Optional[float] = None
    fetched_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    @field_validator("latitud", mode="before")
    @classmethod
    def validate_lat(cls, v: Any) -> Optional[float]:
        try:
            return _validate_lat(float(v)) if v is not None else None
        except (TypeError, ValueError):
            return None

    @field_validator("longitud", mode="before")
    @classmethod
    def validate_lng(cls, v: Any) -> Optional[float]:
        try:
            return _validate_lng(float(v)) if v is not None else None
        except (TypeError, ValueError):
            return None

    @field_validator("cp", mode="before")
    @classmethod
    def normalize_cp(cls, v: Any) -> Optional[str]:
        if v is None:
            return None
        s = str(v).strip().zfill(5)  # Pad to 5 digits
        return s if len(s) == 5 else None

    model_config = {
        "json_schema_extra": {
            "example": {
                "place_id": "MX001234",
                "cre_id": "ES-01-JAL-00001",
                "nombre": "GASOLINERA POLANCO NORTE",
                "razon_social": "COMBUSTIBLES DEL NORTE S.A. DE C.V.",
                "marca": "PEMEX",
                "domicilio": "AV. PRESIDENTE MASARYK 123 COL. POLANCO",
                "municipio": "MIGUEL HIDALGO",
                "estado": "CIUDAD DE MEXICO",
                "cp": "11560",
                "latitud": 19.4326,
                "longitud": -99.1967,
            }
        }
    }


class RawOSMStation(BaseModel):
    """
    Raw station record from OpenStreetMap Overpass API.
    Both node and way elements are flattened to this model.
    """
    osm_id: str
    osm_type: str = "node"          # node | way | relation
    name: Optional[str] = None      # OSM name tag
    brand: Optional[str] = None     # OSM brand tag
    brand_wikidata: Optional[str] = None  # OSM brand:wikidata tag (e.g. Q152057)
    operator: Optional[str] = None  # OSM operator tag
    ref_mx_cre: Optional[str] = None  # OSM ref:MX:CRE tag (sometimes has PL number)
    addr_street: Optional[str] = None
    addr_housenumber: Optional[str] = None
    addr_suburb: Optional[str] = None    # colonia
    addr_city: Optional[str] = None      # city / municipality
    addr_state: Optional[str] = None
    addr_postcode: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    tags: dict[str, str] = Field(default_factory=dict)  # All raw tags
    fetched_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    @field_validator("lat", mode="before")
    @classmethod
    def validate_lat(cls, v: Any) -> Optional[float]:
        try:
            return _validate_lat(float(v)) if v is not None else None
        except (TypeError, ValueError):
            return None

    @field_validator("lng", mode="before")
    @classmethod
    def validate_lng(cls, v: Any) -> Optional[float]:
        try:
            return _validate_lng(float(v)) if v is not None else None
        except (TypeError, ValueError):
            return None

    model_config = {
        "json_schema_extra": {
            "example": {
                "osm_id": "987654321",
                "osm_type": "node",
                "name": "Gasolinera Condesa",
                "brand": "Pemex",
                "lat": 19.4112,
                "lng": -99.1808,
                "tags": {"amenity": "fuel", "brand": "Pemex", "name": "Gasolinera Condesa"},
            }
        }
    }


class RawDENUEStation(BaseModel):
    """
    Raw station record from INEGI DENUE bulk CSV.
    Field names match DENUE CSV column headers (snake_case).
    """
    denue_id: Optional[str] = None       # INEGI unique establishment ID
    nom_estab: Optional[str] = None      # Commercial/establishment name
    raz_social: Optional[str] = None     # Legal entity name (razón social)
    nombre_act: Optional[str] = None     # Economic activity name
    per_ocu: Optional[str] = None        # Number of employees range
    telefono: Optional[str] = None
    correoelec: Optional[str] = None
    tipo_vial: Optional[str] = None      # Street type (CALLE, AVENIDA, etc.)
    nom_vial: Optional[str] = None       # Street name
    tipo_v_e_1: Optional[str] = None     # Cross street type
    nom_v_e_1: Optional[str] = None      # Cross street name
    numero_ext: Optional[str] = None     # Exterior number
    letra_ext: Optional[str] = None
    tipo_asent: Optional[str] = None     # Settlement type (COLONIA, FRACC, etc.)
    nomb_asent: Optional[str] = None     # Settlement name (colonia)
    cod_postal: Optional[str] = None
    cve_ent: Optional[str] = None        # State INEGI code
    entidad: Optional[str] = None        # State name
    cve_mun: Optional[str] = None        # Municipality INEGI code
    municipio: Optional[str] = None      # Municipality name
    localidad: Optional[str] = None      # Locality name
    latitud: Optional[float] = None
    longitud: Optional[float] = None
    fecha_alta: Optional[str] = None     # Registration date in DENUE
    codigo_act: Optional[str] = None     # SCIAN activity code (46411)
    fetched_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    @field_validator("latitud", mode="before")
    @classmethod
    def validate_lat(cls, v: Any) -> Optional[float]:
        try:
            return _validate_lat(float(v)) if v is not None and str(v).strip() else None
        except (TypeError, ValueError):
            return None

    @field_validator("longitud", mode="before")
    @classmethod
    def validate_lng(cls, v: Any) -> Optional[float]:
        try:
            return _validate_lng(float(v)) if v is not None and str(v).strip() else None
        except (TypeError, ValueError):
            return None

    @field_validator("cod_postal", mode="before")
    @classmethod
    def normalize_cp(cls, v: Any) -> Optional[str]:
        if v is None:
            return None
        s = str(v).strip()
        if not s:
            return None
        return s.zfill(5)

    @property
    def full_address(self) -> str:
        """Assemble a single address string from DENUE components."""
        parts = []
        if self.tipo_vial and self.nom_vial:
            parts.append(f"{self.tipo_vial} {self.nom_vial}")
        elif self.nom_vial:
            parts.append(self.nom_vial)
        if self.numero_ext:
            parts.append(f"No. {self.numero_ext}")
        if self.tipo_asent and self.nomb_asent:
            parts.append(f"{self.tipo_asent} {self.nomb_asent}")
        elif self.nomb_asent:
            parts.append(self.nomb_asent)
        return ", ".join(p for p in parts if p)

    model_config = {
        "json_schema_extra": {
            "example": {
                "denue_id": "00123456",
                "nom_estab": "ESTACION DE SERVICIO GASOLINERA EL ROBLE",
                "raz_social": "COMBUSTIBLES JALISCO S.A. DE C.V.",
                "codigo_act": "46411",
                "municipio": "GUADALAJARA",
                "entidad": "JALISCO",
                "latitud": 20.6736,
                "longitud": -103.3442,
            }
        }
    }


# ═══════════════════════════════════════════════════════════
# SOURCE REFERENCE — links a master record back to a raw source
# ═══════════════════════════════════════════════════════════

class SourceRef(BaseModel):
    """A reference to a specific record in a specific source."""
    source: str   # cre | osm | denue | brand | google
    id: str       # The source-native identifier

    def __str__(self) -> str:
        return f"{self.source}:{self.id}"


# ═══════════════════════════════════════════════════════════
# STAGING STATION — normalized record, all sources unified
# ═══════════════════════════════════════════════════════════

class StagingStation(BaseModel):
    """
    Normalized staging record. All source-specific models converge to this.
    Used as input/output for the blocking, scoring, and resolution steps.
    """
    # Identity
    id: str                              # pipeline-generated: f"{source}_{source_id}"
    source: str                          # cre | osm | denue | brand | google
    batch_id: str

    # Source-native IDs
    cre_place_id: Optional[str] = None
    cre_id: Optional[str] = None
    osm_id: Optional[str] = None
    osm_type: Optional[str] = None
    denue_id: Optional[str] = None
    brand_source: Optional[str] = None  # pemex | oxxo | shell | bp (for brand source)
    external_id: Optional[str] = None   # brand-source-native ID

    # Raw (pre-normalization) fields — preserved for debugging
    raw_name: Optional[str] = None
    raw_brand: Optional[str] = None
    raw_address: Optional[str] = None
    raw_municipality: Optional[str] = None
    raw_state: Optional[str] = None
    raw_zip: Optional[str] = None

    # Normalized fields — output of the normalize pipeline
    norm_name: Optional[str] = None
    norm_brand: Optional[str] = None
    norm_address: Optional[str] = None
    norm_municipality: Optional[str] = None
    norm_state: Optional[str] = None
    norm_zip: Optional[str] = None

    # Coordinates
    lat: Optional[float] = None
    lng: Optional[float] = None
    geohash6: Optional[str] = None   # blocking key
    geohash7: Optional[str] = None   # storage/lookup key
    coord_precision: Optional[str] = None  # high | medium | low | none

    # Metadata
    content_hash: Optional[str] = None  # SHA-256 of raw fields (for delta detection)
    fetched_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    @field_validator("lat", mode="before")
    @classmethod
    def validate_lat(cls, v: Any) -> Optional[float]:
        try:
            return _validate_lat(float(v)) if v is not None else None
        except (TypeError, ValueError):
            return None

    @field_validator("lng", mode="before")
    @classmethod
    def validate_lng(cls, v: Any) -> Optional[float]:
        try:
            return _validate_lng(float(v)) if v is not None else None
        except (TypeError, ValueError):
            return None

    @property
    def has_coordinates(self) -> bool:
        return self.lat is not None and self.lng is not None

    @property
    def display_name(self) -> str:
        return self.norm_name or self.raw_name or f"[{self.source}:{self.id}]"


# ═══════════════════════════════════════════════════════════
# STATION PRICE — current fuel prices
# ═══════════════════════════════════════════════════════════

class StationPrice(BaseModel):
    """Current fuel prices for a station, from CRE Prices API."""
    cre_id: Optional[str] = None
    place_id: Optional[str] = None
    gasolina_regular: Optional[float] = None    # MXN per liter
    gasolina_premium: Optional[float] = None
    diesel: Optional[float] = None
    updated_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    @field_validator("gasolina_regular", "gasolina_premium", "diesel", mode="before")
    @classmethod
    def validate_price(cls, v: Any) -> Optional[float]:
        if v is None:
            return None
        try:
            f = float(v)
            # Sanity check: Mexican gas prices are roughly 15–35 MXN/L
            if f < 5.0 or f > 100.0:
                return None
            return round(f, 2)
        except (TypeError, ValueError):
            return None


# ═══════════════════════════════════════════════════════════
# MASTER STATION — the canonical curated record
# ═══════════════════════════════════════════════════════════

class MasterStation(BaseModel):
    """
    Canonical curated station record stored in station_master table.
    This is the output of the entire pipeline and the input to exports.
    """
    master_id: str                           # UUID v4, pipeline-generated
    pl_number: Optional[str] = None          # CRE permit number e.g. PL/0001/EXP/ES/2001

    canonical_name: str
    canonical_brand: Optional[str] = None
    canonical_address: Optional[str] = None
    canonical_municipality: Optional[str] = None
    canonical_state: Optional[str] = None
    canonical_zip: Optional[str] = None

    lat: Optional[float] = None
    lng: Optional[float] = None
    geohash: Optional[str] = None            # geohash precision-7

    status: str = "active"                   # active | closed | unknown
    confidence_score: float = 0.0            # 0.0–1.0
    primary_source: Optional[str] = None     # cre | denue | osm | brand | google

    source_ids: list[SourceRef] = Field(default_factory=list)
    source_ids_json: Optional[str] = None    # JSON string for DB storage

    # Source-specific ID cross-references
    cre_place_id: Optional[str] = None
    cre_id: Optional[str] = None
    denue_id: Optional[str] = None
    osm_id: Optional[str] = None

    # Temporal fields
    first_seen_at: Optional[str] = None
    last_confirmed_at: Optional[str] = None
    last_refreshed_at: Optional[str] = None

    # Flags
    name_drift_flag: int = 0    # 1 if name changed significantly since last refresh
    review_flag: int = 0        # 1 if needs human review
    review_reason: Optional[str] = None

    # Current prices (not stored in master table, joined at export time)
    prices: Optional[StationPrice] = None

    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    updated_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    @field_validator("lat", mode="before")
    @classmethod
    def validate_lat(cls, v: Any) -> Optional[float]:
        try:
            return _validate_lat(float(v)) if v is not None else None
        except (TypeError, ValueError):
            return None

    @field_validator("lng", mode="before")
    @classmethod
    def validate_lng(cls, v: Any) -> Optional[float]:
        try:
            return _validate_lng(float(v)) if v is not None else None
        except (TypeError, ValueError):
            return None

    @field_validator("confidence_score", mode="before")
    @classmethod
    def clamp_confidence(cls, v: Any) -> float:
        try:
            return max(0.0, min(1.0, float(v)))
        except (TypeError, ValueError):
            return 0.0

    @model_validator(mode="after")
    def sync_source_ids_json(self) -> "MasterStation":
        """Keep source_ids_json in sync with source_ids list."""
        if self.source_ids and not self.source_ids_json:
            self.source_ids_json = json.dumps(
                [ref.model_dump() for ref in self.source_ids]
            )
        return self

    @property
    def has_coordinates(self) -> bool:
        return self.lat is not None and self.lng is not None

    @property
    def source_count(self) -> int:
        return len(self.source_ids)

    def to_export_dict(self) -> dict[str, Any]:
        """Serialize to the JS app export format."""
        result: dict[str, Any] = {
            "master_id": self.master_id,
            "pl_number": self.pl_number,
            "canonical_name": self.canonical_name,
            "canonical_brand": self.canonical_brand,
            "canonical_address": self.canonical_address,
            "canonical_municipality": self.canonical_municipality,
            "canonical_state": self.canonical_state,
            "canonical_zip": self.canonical_zip,
            "lat": self.lat,
            "lng": self.lng,
            "status": self.status,
            "confidence_score": round(self.confidence_score, 4),
            "primary_source": self.primary_source,
            "source_ids": [ref.model_dump() for ref in self.source_ids],
            "last_confirmed_at": self.last_confirmed_at,
        }
        if self.prices:
            result["prices"] = {
                "regular":    self.prices.gasolina_regular,
                "premium":    self.prices.gasolina_premium,
                "diesel":     self.prices.diesel,
                "updated_at": self.prices.updated_at,
            }
        return result

    model_config = {
        "json_schema_extra": {
            "example": {
                "master_id": "gi-mx-001a2b3c",
                "pl_number": "PL/0001/EXP/ES/2001",
                "canonical_name": "GASOLINERA POLANCO NORTE",
                "canonical_brand": "PEMEX",
                "canonical_address": "AVENIDA PRESIDENTE MASARYK 123",
                "canonical_municipality": "MIGUEL HIDALGO",
                "canonical_state": "CIUDAD DE MEXICO",
                "canonical_zip": "11560",
                "lat": 19.4326,
                "lng": -99.1967,
                "status": "active",
                "confidence_score": 0.94,
                "primary_source": "cre",
            }
        }
    }
