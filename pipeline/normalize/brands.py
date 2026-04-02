"""
normalize/brands.py — Brand name standardization for Mexican gas stations.

Maps raw brand strings (from any source) to canonical brand names.
Uses exact match first, then fuzzy match as fallback.
"""

from __future__ import annotations

from typing import Optional

from rapidfuzz import process as fuzz_process
from rapidfuzz import fuzz

from normalize.text import strip_accents


# ═══════════════════════════════════════════════════════════
# BRAND ALIAS TABLE
# Maps raw brand strings (normalized to uppercase) → canonical brand name
# ═══════════════════════════════════════════════════════════

BRAND_ALIASES: dict[str, str] = {
    # PEMEX variants
    "PEMEX":                    "PEMEX",
    "PETRO7":                   "PEMEX",
    "PETRO 7":                  "PEMEX",
    "GASOLINERA PEMEX":         "PEMEX",
    "ESTACION PEMEX":           "PEMEX",
    "SERVICIO PEMEX":           "PEMEX",
    "PETROLEOS MEXICANOS":      "PEMEX",
    "PETROLEOS MEX":            "PEMEX",

    # OXXO GAS variants
    "OXXO GAS":                 "OXXO GAS",
    "OXXOGAS":                  "OXXO GAS",
    "OXXO":                     "OXXO GAS",
    "CIRCLE K":                 "OXXO GAS",
    "CIRCLEK":                  "OXXO GAS",
    "CIRCLE-K":                 "OXXO GAS",

    # Shell variants
    "SHELL":                    "SHELL",
    "SHELL MEXICO":             "SHELL",
    "SHELL MEX":                "SHELL",
    "SHELLMEX":                 "SHELL",

    # BP variants
    "BP":                       "BP",
    "AMPM":                     "BP",
    "AM PM":                    "BP",
    "BRITISH PETROLEUM":        "BP",
    "BP MEXICO":                "BP",

    # TotalEnergies variants
    "TOTAL":                    "TOTALENERGIES",
    "TOTALENERGIES":            "TOTALENERGIES",
    "TOTAL ENERGIES":           "TOTALENERGIES",
    "TOTAL ENERGY":             "TOTALENERGIES",
    "TOTALENERGIE":             "TOTALENERGIES",

    # Hidrosina
    "HIDROSINA":                "HIDROSINA",
    "HIDROSINAGAS":             "HIDROSINA",

    # G500
    "G500":                     "G500",
    "GREENGAS":                 "G500",
    "GREEN GAS":                "G500",
    "GAS 500":                  "G500",
    "G 500":                    "G500",

    # Repsol
    "REPSOL":                   "REPSOL",
    "REPSOL MEXICO":            "REPSOL",

    # Mobil
    "MOBIL":                    "MOBIL",
    "EXXONMOBIL":               "MOBIL",
    "EXXON MOBIL":              "MOBIL",
    "EXXON":                    "MOBIL",

    # Chevron
    "CHEVRON":                  "CHEVRON",
    "CHEVRON MEXICO":           "CHEVRON",
    "TEXACO":                   "CHEVRON",

    # Redco
    "REDCO":                    "REDCO",
    "REDCO GAS":                "REDCO",

    # Accel
    "ACCEL":                    "ACCEL",
    "ACCEL GAS":                "ACCEL",

    # Baja Gas
    "BAJA GAS":                 "BAJA GAS",
    "BAJAGAS":                  "BAJA GAS",

    # Petro Global
    "PETRO GLOBAL":             "PETRO GLOBAL",
    "PETROGLOBAL":              "PETRO GLOBAL",

    # Orsan
    "ORSAN":                    "ORSAN",
    "ORSAN GAS":                "ORSAN",

    # Zeta Gas
    "ZETA GAS":                 "ZETA GAS",
    "ZETAGA":                   "ZETA GAS",

    # Onexpo (trade association — member stations)
    "ONEXPO":                   "ONEXPO",

    # Fuelgas
    "FUELGAS":                  "FUELGAS",
    "FUEL GAS":                 "FUELGAS",

    # Combustibles del Norte
    "COMBUSTIBLES DEL NORTE":   "COMBUSTIBLES DEL NORTE",
    "COMB DEL NORTE":           "COMBUSTIBLES DEL NORTE",

    # Gasolina Express
    "GASOLINA EXPRESS":         "GASOLINA EXPRESS",
    "GAS EXPRESS":              "GASOLINA EXPRESS",

    # Generic / Independent
    "INDEPENDIENTE":            None,  # No canonical brand
    "INDEPENDENT":              None,
    "SIN MARCA":                None,
    "SIN FRANQUICIA":           None,
}


# ═══════════════════════════════════════════════════════════
# KNOWN CANONICAL BRANDS (the set of valid outputs)
# ═══════════════════════════════════════════════════════════

KNOWN_BRANDS: frozenset[str] = frozenset(
    b for b in BRAND_ALIASES.values() if b is not None
)


# ═══════════════════════════════════════════════════════════
# NORMALIZATION FUNCTION
# ═══════════════════════════════════════════════════════════

def _prep_for_lookup(text: str) -> str:
    """Prepare a brand string for dictionary lookup: strip accents, uppercase, normalize spaces."""
    return " ".join(strip_accents(text).upper().split())


def normalize_brand(raw_brand: Optional[str]) -> Optional[str]:
    """
    Normalize a raw brand string to its canonical form.

    Steps:
    1. Exact match after basic normalization
    2. Fuzzy match against KNOWN_BRANDS if exact match fails
    3. Return None if no match found (station has no known brand)

    Returns the canonical brand name, or None if unrecognized or explicitly independent.
    """
    if not raw_brand or not raw_brand.strip():
        return None

    prepped = _prep_for_lookup(raw_brand)

    # Step 1: Exact match
    if prepped in BRAND_ALIASES:
        return BRAND_ALIASES[prepped]

    # Step 2: Partial exact match — check if any alias is a substring
    for alias, canonical in BRAND_ALIASES.items():
        if alias in prepped or prepped in alias:
            if len(min(alias, prepped)) >= 4:  # Avoid matching very short strings
                return canonical

    # Step 3: Fuzzy match against KNOWN_BRANDS
    result = fuzz_process.extractOne(
        prepped,
        list(KNOWN_BRANDS),
        scorer=fuzz.token_sort_ratio,
        score_cutoff=80,
    )
    if result:
        matched_brand, score, _ = result
        return matched_brand

    # Step 4: Fuzzy match against alias keys
    result = fuzz_process.extractOne(
        prepped,
        list(BRAND_ALIASES.keys()),
        scorer=fuzz.token_sort_ratio,
        score_cutoff=82,
    )
    if result:
        matched_alias, score, _ = result
        return BRAND_ALIASES.get(matched_alias)

    return None


def get_brand_confidence(raw_brand: Optional[str], canonical: Optional[str]) -> float:
    """
    Return a confidence score for a brand normalization result.

    1.0 — exact match found in BRAND_ALIASES
    0.85 — substring match found
    0.70 — fuzzy match above threshold
    0.0 — no match (canonical is None)
    """
    if raw_brand is None or canonical is None:
        return 0.0

    prepped = _prep_for_lookup(raw_brand)

    # Check exact match
    if prepped in BRAND_ALIASES:
        return 1.0

    # Check if alias is substring
    for alias, brand_canonical in BRAND_ALIASES.items():
        if brand_canonical == canonical:
            if alias in prepped or prepped in alias:
                if len(min(alias, prepped)) >= 4:
                    return 0.85

    # It was a fuzzy match
    return 0.70


def are_same_brand(brand_a: Optional[str], brand_b: Optional[str]) -> bool:
    """
    Check if two raw brand strings resolve to the same canonical brand.
    Returns False if either is None.
    """
    if not brand_a or not brand_b:
        return False
    return normalize_brand(brand_a) == normalize_brand(brand_b)


def brand_match_score(raw_a: Optional[str], raw_b: Optional[str]) -> float:
    """
    Returns a 0.0–1.0 score for how well two raw brand strings match.
    Used by the match scorer.

    1.0  — both normalize to the same canonical brand
    0.5  — fuzzy similarity > 80 between normalized strings (partial match)
    0.0  — different canonical brands, or both None
    """
    if raw_a is None and raw_b is None:
        return 0.5  # Both unknown — neutral, not disqualifying

    canon_a = normalize_brand(raw_a)
    canon_b = normalize_brand(raw_b)

    if canon_a is None and canon_b is None:
        return 0.5  # Both unrecognized — neutral

    if canon_a is not None and canon_b is not None:
        if canon_a == canon_b:
            return 1.0
        # Different canonical brands — definite mismatch
        return 0.0

    # One has a known brand, other doesn't — partial credit
    return 0.3
