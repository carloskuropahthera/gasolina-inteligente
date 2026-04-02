"""
normalize/address.py — Mexican address normalization.

Handles:
- Street type abbreviations (AV → AVENIDA, BLVD → BOULEVARD)
- Settlement type abbreviations (COL → COLONIA)
- Number formatting (S/N → SIN NUMERO, KM markers, No. → NUMERO)
- State name/abbreviation → official INEGI name
- Municipality normalization
- ZIP code padding
"""

from __future__ import annotations

import re
from typing import Optional

from normalize.text import collapse_whitespace, strip_accents


# ═══════════════════════════════════════════════════════════
# STREET TYPE ABBREVIATIONS → FULL NAMES
# ═══════════════════════════════════════════════════════════

STREET_ABBREVIATIONS: dict[str, str] = {
    r"\bAV\b":       "AVENIDA",
    r"\bAVDA\b":     "AVENIDA",
    r"\bAVE\b":      "AVENIDA",
    r"\bBLVD\b":     "BOULEVARD",
    r"\bBULEVAR\b":  "BOULEVARD",
    r"\bBVAR\b":     "BOULEVARD",
    r"\bCALZ\b":     "CALZADA",
    r"\bC\b":        "CALLE",       # Single C is almost always Calle — apply last
    r"\bCALL\b":     "CALLE",
    r"\bCARR\b":     "CARRETERA",
    r"\bCARRT\b":    "CARRETERA",
    r"\bCIRC\b":     "CIRCUITO",
    r"\bCDA\b":      "CERRADA",
    r"\bCERR\b":     "CERRADA",
    r"\bPRIV\b":     "PRIVADA",
    r"\bPROL\b":     "PROLONGACION",
    r"\bAND\b":      "ANDADOR",
    r"\bPERIF\b":    "PERIFERICO",
    r"\bPERI\b":     "PERIFERICO",
    r"\bEJE\b":      "EJE",        # Already full, keep
    r"\bRETORNO\b":  "RETORNO",
    r"\bRET\b":      "RETORNO",
    r"\bDIAG\b":     "DIAGONAL",
    r"\bPASEO\b":    "PASEO",
}

# ═══════════════════════════════════════════════════════════
# SETTLEMENT/COLONIA TYPE ABBREVIATIONS
# ═══════════════════════════════════════════════════════════

COLONIA_ABBREVIATIONS: dict[str, str] = {
    r"\bCOL\b":      "COLONIA",
    r"\bFRACC\b":    "FRACCIONAMIENTO",
    r"\bFRAC\b":     "FRACCIONAMIENTO",
    r"\bURB\b":      "URBANIZACION",
    r"\bAMPL\b":     "AMPLIACION",
    r"\bBARR\b":     "BARRIO",
    r"\bPOBL\b":     "POBLADO",
    r"\bRCH\b":      "RANCHO",
    r"\bEJ\b":       "EJIDO",
    r"\bRES\b":      "RESIDENCIAL",
    r"\bCENTRO\b":   "CENTRO",
    r"\bCD\b":       "CIUDAD",
    r"\bPTA\b":      "PUNTA",
}

# ═══════════════════════════════════════════════════════════
# STATE ALIASES → OFFICIAL INEGI STATE NAMES
# ═══════════════════════════════════════════════════════════

STATE_ALIASES: dict[str, str] = {
    # CDMX variants
    "CDMX":                          "CIUDAD DE MEXICO",
    "D.F.":                          "CIUDAD DE MEXICO",
    "DF":                            "CIUDAD DE MEXICO",
    "DISTRITO FEDERAL":              "CIUDAD DE MEXICO",
    "CIUDAD DE MEXICO":              "CIUDAD DE MEXICO",
    "CIUDAD DE MéXICO":              "CIUDAD DE MEXICO",
    "MEXICO D.F.":                   "CIUDAD DE MEXICO",
    "MEXICO DF":                     "CIUDAD DE MEXICO",
    # States
    "AGS":                           "AGUASCALIENTES",
    "AGUASCALIENTES":                "AGUASCALIENTES",
    "BC":                            "BAJA CALIFORNIA",
    "BAJA CALIFORNIA":               "BAJA CALIFORNIA",
    "BCS":                           "BAJA CALIFORNIA SUR",
    "BAJA CALIFORNIA SUR":           "BAJA CALIFORNIA SUR",
    "CAMP":                          "CAMPECHE",
    "CAMPECHE":                      "CAMPECHE",
    "CHIS":                          "CHIAPAS",
    "CHIAPAS":                       "CHIAPAS",
    "CHIH":                          "CHIHUAHUA",
    "CHIHUAHUA":                     "CHIHUAHUA",
    "COAH":                          "COAHUILA",
    "COAHUILA":                      "COAHUILA",
    "COAHUILA DE ZARAGOZA":          "COAHUILA",
    "COL":                           "COLIMA",
    "COLIMA":                        "COLIMA",
    "DGO":                           "DURANGO",
    "DURANGO":                       "DURANGO",
    "GTO":                           "GUANAJUATO",
    "GUANAJUATO":                    "GUANAJUATO",
    "GRO":                           "GUERRERO",
    "GUERRERO":                      "GUERRERO",
    "HGO":                           "HIDALGO",
    "HIDALGO":                       "HIDALGO",
    "JAL":                           "JALISCO",
    "JALISCO":                       "JALISCO",
    "MEX":                           "ESTADO DE MEXICO",
    "EDO MEX":                       "ESTADO DE MEXICO",
    "EDO. MEX.":                     "ESTADO DE MEXICO",
    "ESTADO DE MEXICO":              "ESTADO DE MEXICO",
    "ESTADO DE MéXICO":              "ESTADO DE MEXICO",
    "MEXICO":                        "ESTADO DE MEXICO",  # Ambiguous but state > country in context
    "MICH":                          "MICHOACAN",
    "MICHOACAN":                     "MICHOACAN",
    "MICHOACAN DE OCAMPO":           "MICHOACAN",
    "MOR":                           "MORELOS",
    "MORELOS":                       "MORELOS",
    "NAY":                           "NAYARIT",
    "NAYARIT":                       "NAYARIT",
    "NL":                            "NUEVO LEON",
    "NUEVO LEON":                    "NUEVO LEON",
    "NUEVO LEóN":                    "NUEVO LEON",
    "OAX":                           "OAXACA",
    "OAXACA":                        "OAXACA",
    "PUE":                           "PUEBLA",
    "PUEBLA":                        "PUEBLA",
    "QRO":                           "QUERETARO",
    "QUERETARO":                     "QUERETARO",
    "QUERéTARO":                     "QUERETARO",
    "QUERETARO DE ARTEAGA":          "QUERETARO",
    "QROO":                          "QUINTANA ROO",
    "Q ROO":                         "QUINTANA ROO",
    "QUINTANA ROO":                  "QUINTANA ROO",
    "SLP":                           "SAN LUIS POTOSI",
    "SAN LUIS POTOSI":               "SAN LUIS POTOSI",
    "SAN LUIS POTOSí":               "SAN LUIS POTOSI",
    "SIN":                           "SINALOA",
    "SINALOA":                       "SINALOA",
    "SON":                           "SONORA",
    "SONORA":                        "SONORA",
    "TAB":                           "TABASCO",
    "TABASCO":                       "TABASCO",
    "TAMPS":                         "TAMAULIPAS",
    "TAMAULIPAS":                    "TAMAULIPAS",
    "TLAX":                          "TLAXCALA",
    "TLAXCALA":                      "TLAXCALA",
    "VER":                           "VERACRUZ",
    "VERACRUZ":                      "VERACRUZ",
    "VERACRUZ DE IGNACIO DE LA LLAVE": "VERACRUZ",
    "YUC":                           "YUCATAN",
    "YUCATAN":                       "YUCATAN",
    "YUCATáN":                       "YUCATAN",
    "ZAC":                           "ZACATECAS",
    "ZACATECAS":                     "ZACATECAS",
}

# Pre-compile street type patterns (order: longest/most specific first)
_STREET_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(pattern, flags=re.IGNORECASE), replacement)
    for pattern, replacement in STREET_ABBREVIATIONS.items()
    if pattern != r"\bC\b"  # Apply single-letter C last
]
# Add single-C pattern at end
_STREET_PATTERNS.append(
    (re.compile(r"\bC\b", flags=re.IGNORECASE), "CALLE")
)

_COLONIA_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(pattern, flags=re.IGNORECASE), replacement)
    for pattern, replacement in COLONIA_ABBREVIATIONS.items()
]


# ═══════════════════════════════════════════════════════════
# NUMBER NORMALIZATION HELPERS
# ═══════════════════════════════════════════════════════════

# "S/N", "SN", "S N", "S.N." → "SIN NUMERO"
_SN_PATTERN = re.compile(
    r"\b(?:S\.?/N\.?|S\.?N\.?|SIN\s+NUM(?:ERO)?)\b",
    flags=re.IGNORECASE,
)

# "KM 45", "KM. 45.5", "KM45", "KM-45" → "KILOMETRO 45"
_KM_PATTERN = re.compile(
    r"\bKM\.?\s*[-]?\s*(\d+(?:\.\d+)?)\b",
    flags=re.IGNORECASE,
)

# "No. 12", "Num 12", "NUM. 12", "#12", "N°12" → "NUMERO 12"
_NUM_PATTERN = re.compile(
    r"\b(?:No\.?|Num\.?|N°|#)\s*(\d+)\b",
    flags=re.IGNORECASE,
)

# Strip interior/unit info: "INT 3", "DEPTO 4", "LOCAL 2", "PISO 3"
_INTERIOR_PATTERN = re.compile(
    r"\b(?:INT(?:ERIOR)?|DEPTO?|LOCAL|PISO|APT|APART(?:AMENTO)?)\s*\w*\b",
    flags=re.IGNORECASE,
)


# ═══════════════════════════════════════════════════════════
# PUBLIC NORMALIZATION FUNCTIONS
# ═══════════════════════════════════════════════════════════

def handle_sin_numero(text: str) -> str:
    """Replace S/N and variants with SIN NUMERO."""
    return _SN_PATTERN.sub("SIN NUMERO", text)


def handle_km_markers(text: str) -> str:
    """Normalize KM markers: 'KM 45.5' → 'KILOMETRO 45'."""
    def replacer(m: re.Match) -> str:
        # Truncate decimal — KM 45.5 → KILOMETRO 45
        km_num = m.group(1).split(".")[0]
        return f"KILOMETRO {km_num}"
    return _KM_PATTERN.sub(replacer, text)


def handle_number_prefix(text: str) -> str:
    """Normalize number prefixes: 'No. 12' → 'NUMERO 12'."""
    return _NUM_PATTERN.sub(lambda m: f"NUMERO {m.group(1)}", text)


def strip_interior_info(text: str) -> str:
    """Remove apartment/unit/interior designations."""
    return _INTERIOR_PATTERN.sub("", text)


def normalize_address(text: Optional[str]) -> Optional[str]:
    """
    Full address normalization pipeline.
    - Strips accents → uppercase
    - Expands street type abbreviations
    - Expands colonia type abbreviations
    - Normalizes S/N, KM markers, number prefixes
    - Removes interior/unit information
    - Collapses whitespace
    """
    if not text or not text.strip():
        return None

    result = strip_accents(text.strip()).upper()

    # Number handling before abbreviation expansion (order matters)
    result = handle_sin_numero(result)
    result = handle_km_markers(result)
    result = handle_number_prefix(result)
    result = strip_interior_info(result)

    # Expand settlement type abbreviations
    for pattern, replacement in _COLONIA_PATTERNS:
        result = pattern.sub(replacement, result)

    # Expand street type abbreviations
    for pattern, replacement in _STREET_PATTERNS:
        result = pattern.sub(replacement, result)

    result = collapse_whitespace(result)
    return result if result else None


def normalize_state(text: Optional[str]) -> Optional[str]:
    """
    Normalize a state name or abbreviation to the official INEGI state name.
    Returns None if the input cannot be matched.
    """
    if not text or not text.strip():
        return None

    prepped = strip_accents(text.strip()).upper()
    # Remove dots (D.F. → DF)
    prepped_nodots = re.sub(r"\.", "", prepped).strip()

    # Try exact match first
    if prepped in STATE_ALIASES:
        return STATE_ALIASES[prepped]
    if prepped_nodots in STATE_ALIASES:
        return STATE_ALIASES[prepped_nodots]

    # Try case-insensitive lookup
    for alias, official in STATE_ALIASES.items():
        if alias.upper() == prepped:
            return official

    # Return the cleaned input as fallback — better to have imperfect than nothing
    return prepped if prepped else None


def normalize_municipality(text: Optional[str]) -> Optional[str]:
    """
    Normalize a municipality name.
    - Strips accents
    - Uppercase
    - Collapses whitespace
    - Removes trailing state name if present (e.g., "Guadalajara, Jalisco" → "Guadalajara")

    Note: We don't maintain a full municipality catalog here (2,475 municipalities).
    The INEGI catalog is used for more precise QA-05 checks elsewhere.
    """
    if not text or not text.strip():
        return None

    result = strip_accents(text.strip()).upper()

    # Remove trailing state name if separated by comma
    if "," in result:
        result = result.split(",")[0].strip()

    result = collapse_whitespace(result)
    return result if result else None


def normalize_zip(text: Optional[str]) -> Optional[str]:
    """Normalize Mexican ZIP code to exactly 5 digits with leading zeros."""
    if not text or not text.strip():
        return None
    digits = re.sub(r"\D", "", text.strip())
    if not digits:
        return None
    padded = digits.zfill(5)
    return padded if len(padded) == 5 else None
