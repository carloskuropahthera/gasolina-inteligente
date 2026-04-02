"""
storage/raw_zone.py — Parquet read/write helpers for the raw data zone.

The raw zone stores immutable snapshots of source data.
Files are named: {source}_{YYYYMMDD}_{batch_id_short}.parquet
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import pandas as pd
import structlog

from config import DELTA_EXCLUDE_FIELDS, FAILED_DIR, RAW_DIR

log = structlog.get_logger(__name__)


# ═══════════════════════════════════════════════════════════
# FILE NAMING
# ═══════════════════════════════════════════════════════════

def _raw_parquet_path(source_name: str, date_str: str, batch_id: str) -> Path:
    short_id = batch_id.replace("-", "")[:8]
    return RAW_DIR / f"{source_name}_{date_str}_{short_id}.parquet"


def _date_str_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d")


# ═══════════════════════════════════════════════════════════
# WRITE
# ═══════════════════════════════════════════════════════════

def write_parquet(
    df: pd.DataFrame,
    source_name: str,
    batch_id: str,
    date_str: Optional[str] = None,
) -> Path:
    """
    Write a DataFrame to a Parquet file in the raw zone.

    Args:
        df: DataFrame to write
        source_name: e.g. "cre_places", "osm_fuel", "denue_gasolineras"
        batch_id: Pipeline batch identifier
        date_str: Optional date override (YYYYMMDD); defaults to today UTC

    Returns:
        Path to the written file.
    """
    if date_str is None:
        date_str = _date_str_now()

    path = _raw_parquet_path(source_name, date_str, batch_id)

    if df.empty:
        log.warning("write_parquet_empty", source=source_name, batch_id=batch_id)

    df.to_parquet(path, index=False, compression="snappy")
    log.info(
        "raw_parquet_written",
        path=str(path),
        source=source_name,
        rows=len(df),
        columns=len(df.columns),
        size_kb=round(path.stat().st_size / 1024, 1),
    )
    return path


def write_failed(
    records: list[dict[str, Any]],
    source_name: str,
    batch_id: str,
) -> Optional[Path]:
    """Write failed records to the dead-letter parquet in the failed directory."""
    if not records:
        return None

    date_str = _date_str_now()
    path = FAILED_DIR / f"failed_{source_name}_{date_str}_{batch_id[:8]}.parquet"
    pd.DataFrame(records).to_parquet(path, index=False, compression="snappy")
    log.warning("failed_records_written", path=str(path), count=len(records))
    return path


# ═══════════════════════════════════════════════════════════
# READ
# ═══════════════════════════════════════════════════════════

def read_parquet(source_name: str, date_str: str, batch_id: Optional[str] = None) -> pd.DataFrame:
    """
    Read a parquet file from the raw zone.

    Args:
        source_name: e.g. "cre_prices"
        date_str: YYYYMMDD
        batch_id: Optional — if provided, reads that specific batch;
                  if None, reads the most recent file for that date.

    Returns:
        DataFrame (empty DataFrame if file not found).
    """
    if batch_id:
        path = _raw_parquet_path(source_name, date_str, batch_id)
        if not path.exists():
            log.warning("raw_parquet_not_found", path=str(path))
            return pd.DataFrame()
        return pd.read_parquet(path)

    # Find most recent file for the given date
    matches = sorted(
        RAW_DIR.glob(f"{source_name}_{date_str}_*.parquet"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not matches:
        log.warning("raw_parquet_no_match", source=source_name, date=date_str)
        return pd.DataFrame()

    path = matches[0]
    log.info("raw_parquet_read", path=str(path))
    return pd.read_parquet(path)


def read_latest_parquet(source_name: str) -> pd.DataFrame:
    """Read the most recently written parquet file for a source (any date)."""
    matches = sorted(
        RAW_DIR.glob(f"{source_name}_*.parquet"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not matches:
        log.warning("raw_parquet_no_files", source=source_name)
        return pd.DataFrame()

    path = matches[0]
    log.info("raw_parquet_read_latest", path=str(path))
    return pd.read_parquet(path)


def list_batches(source_name: str) -> list[dict[str, str]]:
    """
    List all available batches for a source.

    Returns:
        List of {"date": "YYYYMMDD", "batch_id": "...", "path": "..."} dicts,
        sorted newest first.
    """
    files = sorted(
        RAW_DIR.glob(f"{source_name}_*.parquet"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    results: list[dict[str, str]] = []
    for f in files:
        parts = f.stem.split("_")
        if len(parts) >= 3:
            # source_name can have underscores, so date is second-to-last, batch is last
            results.append({
                "date":     parts[-2],
                "batch_id": parts[-1],
                "path":     str(f),
            })
    return results


# ═══════════════════════════════════════════════════════════
# DELTA DETECTION
# ═══════════════════════════════════════════════════════════

def _record_hash(record: dict[str, Any]) -> str:
    """
    Compute a SHA-256 hash of a record dict, excluding delta-excluded fields.
    Used to detect whether a record actually changed between batches.
    """
    filtered = {k: v for k, v in record.items() if k not in DELTA_EXCLUDE_FIELDS}
    serialized = json.dumps(filtered, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()


def add_content_hashes(df: pd.DataFrame) -> pd.DataFrame:
    """
    Add a 'content_hash' column to a DataFrame.
    Each row's hash is computed over all columns except DELTA_EXCLUDE_FIELDS.
    """
    df = df.copy()
    df["content_hash"] = df.apply(
        lambda row: _record_hash(row.to_dict()), axis=1
    )
    return df


def find_changed_ids(
    current_df: pd.DataFrame,
    previous_df: pd.DataFrame,
    id_column: str = "id",
) -> set[str]:
    """
    Find records that have changed between the current and previous batch.

    Args:
        current_df:  DataFrame from the new batch (with content_hash column)
        previous_df: DataFrame from the previous batch (with content_hash column)
        id_column:   Column to use as record identifier

    Returns:
        Set of IDs that are new or have changed content.
    """
    if previous_df.empty:
        # First run — everything is "changed"
        return set(current_df[id_column].dropna().astype(str).tolist())

    if "content_hash" not in current_df.columns:
        current_df = add_content_hashes(current_df)
    if "content_hash" not in previous_df.columns:
        previous_df = add_content_hashes(previous_df)

    current_hashes  = dict(zip(current_df[id_column].astype(str), current_df["content_hash"]))
    previous_hashes = dict(zip(previous_df[id_column].astype(str), previous_df["content_hash"]))

    changed: set[str] = set()
    for record_id, current_hash in current_hashes.items():
        prev_hash = previous_hashes.get(record_id)
        if prev_hash is None or prev_hash != current_hash:
            changed.add(record_id)

    total      = len(current_hashes)
    unchanged  = total - len(changed)
    log.info(
        "delta_detection_complete",
        total=total,
        changed=len(changed),
        unchanged=unchanged,
        pct_changed=round(len(changed) / total * 100, 1) if total > 0 else 0,
    )
    return changed
