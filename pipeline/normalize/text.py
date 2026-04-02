"""
normalize/text.py — Text normalization for Mexican gas station names.

Pipeline (applied in order):
  1. Unicode NFKD → strip combining chars → lowercase ASCII
  2. Remove legal entity suffixes (S.A. DE C.V., etc.)
  3. Expand abbreviations (GASO → GASOLINERA, etc.)
  4. Remove punctuation except hyphens between words
  5. Collapse whitespace
  6. Remove stop words
  7. Token sort (for order-invariant comparison)
"""

from __future__ import annotations

import re
import unicodedata
from typing import Optional


# ═══════════════════════════════════════════════════════════
# LEGAL ENTITY SUFFIXES
# (removed before matching — these appear in CRE/DENUE legal names)
# ═══════════════════════════════════════════════════════════

LEGAL_SUFFIXES: list[str] = [
    # Most specific (longest) first — order matters for regex
    r"S\.A\.P\.I\. DE C\.V\.",
    r"S\.A\.P\.I\. DE C\.V",
    r"S\.A\.P\.I\.",
    r"S\.A\. DE C\.V\. DE C\.V\.",  # Typo variant seen in wild
    r"S\.A\. DE C\.V\.",
    r"S\.A\. DE C\.V",
    r"S\. DE R\.L\. DE C\.V\.",
    r"S\. DE R\.L\. DE C\.V",
    r"S\. DE R\.L\.",
    r"S\.C\.S\.",
    r"S\.A\.",
    r"S\.C\.",
    r"A\.C\.",
    r"S\.P\.R\. DE R\.L\.",
    r"S\.P\.R\. DE R\.I\.",
    r"S\.P\.R\.",
    r"A\.P\.F\.",
    # Text versions
    r"SOCIEDAD ANONIMA DE CAPITAL VARIABLE",
    r"SOCIEDAD ANONIMA",
    r"SOCIEDAD CIVIL",
    r"ASOCIACION CIVIL",
]

# Pre-compiled legal suffix removal pattern
_LEGAL_SUFFIX_PATTERN = re.compile(
    r"\s*\b(?:" + "|".join(LEGAL_SUFFIXES) + r")\s*$",
    flags=re.IGNORECASE,
)


# ═══════════════════════════════════════════════════════════
# ABBREVIATIONS
# (expanded before matching — common in station names)
# ═══════════════════════════════════════════════════════════

ABBREVIATIONS: dict[str, str] = {
    r"\bGASO\b":    "GASOLINERA",
    r"\bGASLNA\b":  "GASOLINERA",
    r"\bGASNA\b":   "GASOLINERA",
    r"\bSERV\b":    "SERVICIO",
    r"\bSERVS\b":   "SERVICIOS",
    r"\bEXP\b":     "EXPENDIO",
    r"\bESTAC\b":   "ESTACION",
    r"\bEST\b":     "ESTACION",
    r"\bDIST\b":    "DISTRIBUIDORA",
    r"\bCOMB\b":    "COMBUSTIBLE",
    r"\bCOMBS\b":   "COMBUSTIBLES",
    r"\bHIDROC\b":  "HIDROCARBUROS",
    r"\bPETROL\b":  "PETROLEO",
    r"\bCIA\b":     "COMPANIA",
    r"\bCOMERC\b":  "COMERCIAL",
    r"\bINDUST\b":  "INDUSTRIAL",
    r"\bADMON\b":   "ADMINISTRACION",
    r"\bGRAL\b":    "GENERAL",
    r"\bINTL\b":    "INTERNACIONAL",
    r"\bNAL\b":     "NACIONAL",
    r"\bMEXICAN\b": "MEXICANA",
}

# Pre-compiled abbreviation patterns
_ABBREV_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(pattern, flags=re.IGNORECASE), replacement)
    for pattern, replacement in ABBREVIATIONS.items()
]


# ═══════════════════════════════════════════════════════════
# STOP WORDS
# (removed after abbreviation expansion — common connecting words)
# ═══════════════════════════════════════════════════════════

STOP_WORDS: frozenset[str] = frozenset([
    "DE", "LA", "EL", "LOS", "LAS", "Y", "AND", "DEL",
    "EN", "A", "AL", "E", "O", "U",
    "TE", "SE", "SU", "MI", "TU",
    "CON", "POR", "SIN", "PARA", "DESDE",
])


# ═══════════════════════════════════════════════════════════
# CORE NORMALIZATION FUNCTIONS
# ═══════════════════════════════════════════════════════════

def strip_accents(text: str) -> str:
    """
    Remove diacritics/accents from text using Unicode NFKD decomposition.
    GASO→GASOLINERA is done separately; this handles á→a, ñ→n, ü→u, etc.

    Note: ñ → n may cause some false positives (SEÑOR vs SENOR) but is
    necessary for cross-source matching where some sources strip accents.
    """
    normalized = unicodedata.normalize("NFKD", text)
    return "".join(c for c in normalized if not unicodedata.combining(c))


def remove_legal_suffixes(text: str) -> str:
    """Remove Mexican legal entity suffixes from the end of a name."""
    # Repeatedly apply until stable (handles nested: "S.A. DE C.V. DE C.V.")
    prev = None
    result = text
    while result != prev:
        prev = result
        result = _LEGAL_SUFFIX_PATTERN.sub("", result).strip()
    return result


def expand_abbreviations(text: str) -> str:
    """Expand common Mexican business abbreviations to full words."""
    result = text
    for pattern, replacement in _ABBREV_PATTERNS:
        result = pattern.sub(replacement, result)
    return result


def remove_punctuation_except_hyphens(text: str) -> str:
    """
    Remove all punctuation except hyphens that appear between word characters.
    Keeps: "NORTE-CENTRO" → "NORTE-CENTRO"
    Removes: "S.A.", "No.", "Cía." → "SA", "No", "Cia"
    """
    # Remove periods, commas, parentheses, slashes, etc.
    result = re.sub(r"[.,;:!?()[\]{}/\\\"'`#@$%^&*+=<>|~]", " ", text)
    # Remove hyphens that are at start/end of words (not between words)
    result = re.sub(r"(?<!\w)-|-(?!\w)", " ", result)
    return result


def collapse_whitespace(text: str) -> str:
    """Collapse multiple spaces to single, strip leading/trailing."""
    return re.sub(r"\s+", " ", text).strip()


def remove_stop_words(text: str) -> str:
    """Remove stop words from token sequence."""
    tokens = text.split()
    filtered = [t for t in tokens if t.upper() not in STOP_WORDS]
    return " ".join(filtered)


def token_sort(text: str) -> str:
    """
    Sort tokens alphabetically and rejoin.
    "GASOLINERA NORTE CONDESA" → "CONDESA GASOLINERA NORTE"
    This makes string comparison order-invariant.
    """
    tokens = sorted(text.split())
    return " ".join(tokens)


# ═══════════════════════════════════════════════════════════
# MAIN NORMALIZATION PIPELINES
# ═══════════════════════════════════════════════════════════

def normalize_name(text: Optional[str]) -> Optional[str]:
    """
    Full normalization pipeline for station names.
    Returns token-sorted normalized string, or None if input is empty/None.

    This is the standard normalization used for storing norm_name in staging.
    """
    if not text or not text.strip():
        return None

    result = text.strip()
    result = strip_accents(result)
    result = result.upper()
    result = remove_legal_suffixes(result)
    result = expand_abbreviations(result)
    result = remove_punctuation_except_hyphens(result)
    result = collapse_whitespace(result)
    result = remove_stop_words(result)
    result = token_sort(result)

    return result if result else None


def normalize_for_comparison(text: Optional[str]) -> Optional[str]:
    """
    Most aggressive normalization — for matching only, NOT for display or storage.
    Strips numbers in addition to punctuation, to handle minor formatting differences.
    "GASOLINERA No. 1234" and "GASOLINERA" will be comparable.
    """
    if not text or not text.strip():
        return None

    result = normalize_name(text)
    if not result:
        return None

    # Additionally strip standalone numbers and short codes
    result = re.sub(r"\b\d+\b", "", result)
    result = collapse_whitespace(result)
    result = token_sort(result)

    return result if result else None


def similarity_tokens(text_a: Optional[str], text_b: Optional[str]) -> frozenset[str]:
    """Return the set of tokens that both texts share after normalization."""
    if not text_a or not text_b:
        return frozenset()
    tokens_a = frozenset((normalize_for_comparison(text_a) or "").split())
    tokens_b = frozenset((normalize_for_comparison(text_b) or "").split())
    return tokens_a & tokens_b


def token_overlap_ratio(text_a: Optional[str], text_b: Optional[str]) -> float:
    """
    Compute token overlap ratio between two texts after normalization.
    = |intersection| / |union|
    Used for QA-08 name drift detection.
    """
    if not text_a or not text_b:
        return 0.0
    tokens_a = frozenset((normalize_for_comparison(text_a) or "").split())
    tokens_b = frozenset((normalize_for_comparison(text_b) or "").split())
    if not tokens_a and not tokens_b:
        return 1.0  # Both empty → identical
    if not tokens_a or not tokens_b:
        return 0.0
    intersection = tokens_a & tokens_b
    union = tokens_a | tokens_b
    return len(intersection) / len(union)
