"""
scripts/export_for_app.py — Export master dataset for the Gasolina Inteligente JS app.

Outputs:
  1. data/curated/exports/stations_YYYYMMDD.json  — full master + prices, JS app format
  2. data/curated/exports/stations_latest.json     — symlink/copy, always current
  3. data/curated/exports/stations_YYYYMMDD.csv    — flat CSV for Power BI / analytics

The JSON format matches exactly the Merged[] data shape used by the JS app.

Usage:
  python scripts/export_for_app.py
  python scripts/export_for_app.py --output /path/to/output/
  python scripts/export_for_app.py --only-active   (default: True)
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent.parent))

import click
import pandas as pd
import structlog
from rich.console import Console

from config import CURATED_DB_PATH, EXPORT_JSON_FILENAME_TEMPLATE, EXPORTS_DIR, APP_DATA_DIR

log = structlog.get_logger(__name__)
console = Console()


def _clean(value, default=None):
    """Convert pandas NaN / None to a clean Python value suitable for JSON."""
    if value is None:
        return default
    try:
        if pd.isna(value):
            return default
    except (TypeError, ValueError):
        pass
    return value


# ═══════════════════════════════════════════════════════════
# DATA LOADING
# ═══════════════════════════════════════════════════════════

def _load_master_stations(only_active: bool = True) -> pd.DataFrame:
    """Load station_master from the curated SQLite database."""
    import sqlite3
    conn = sqlite3.connect(str(CURATED_DB_PATH))

    query = "SELECT * FROM station_master"
    if only_active:
        query += " WHERE status = 'active'"
    query += " ORDER BY canonical_state, canonical_municipality, canonical_name"

    try:
        df = pd.read_sql_query(query, conn)
    except sqlite3.DatabaseError as e:
        log.error("db_read_failed", error=str(e), path=str(CURATED_DB_PATH))
        sys.exit(1)
    finally:
        conn.close()

    log.info("master_loaded", rows=len(df), active_only=only_active)
    return df


def _load_latest_prices() -> pd.DataFrame:
    """
    Load the latest CRE prices from the raw zone (most recent parquet file).
    Returns DataFrame with columns: cre_id, place_id, gasolina_regular,
    gasolina_premium, diesel, updated_at
    """
    from storage.raw_zone import read_latest_parquet
    df = read_latest_parquet("cre_prices")

    if df.empty:
        log.warning("no_prices_found")
        return pd.DataFrame(columns=["cre_id", "gasolina_regular", "gasolina_premium", "diesel", "updated_at"])

    log.info("prices_loaded", rows=len(df))
    return df


# ═══════════════════════════════════════════════════════════
# JSON EXPORT
# ═══════════════════════════════════════════════════════════

def _build_station_json(row: pd.Series, prices_map: dict) -> dict:
    """
    Build the JSON object for a single station in the JS app format.
    Matches the Merged[] data shape in the Gasolina Inteligente app.
    """
    master_id = row.get("master_id", "")
    cre_id    = row.get("cre_id")
    place_id  = row.get("cre_place_id")

    # Look up prices — prefer numeric place_id (prices are indexed by place_id),
    # fall back to cre_id permit number for any future sources that use it
    price_key  = place_id or cre_id
    prices_row = prices_map.get(price_key, {})

    # Parse source_ids
    try:
        source_ids = json.loads(row.get("source_ids") or "[]")
    except (json.JSONDecodeError, TypeError):
        source_ids = []

    # JS-app field names (short aliases used by the frontend)
    canonical_name  = _clean(row.get("canonical_name"), "") or ""
    canonical_brand = _clean(row.get("canonical_brand"), "OTRO") or "OTRO"

    prices_row_data = None
    if prices_row:
        regular  = _clean(prices_row.get("gasolina_regular"))
        premium  = _clean(prices_row.get("gasolina_premium"))
        diesel   = _clean(prices_row.get("diesel"))
        has_any  = any(v is not None for v in [regular, premium, diesel])
        prices_row_data = {
            "regular":   regular,
            "premium":   premium,
            "diesel":    diesel,
            "updatedAt": _clean(prices_row.get("updated_at") or prices_row.get("fetched_at")),
        } if has_any else None

    station: dict = {
        # JS app expects these short field names
        "id":        master_id,
        "name":      canonical_name,
        "brand":     canonical_brand,
        "address":   _clean(row.get("canonical_address"), "") or "",
        "city":      _clean(row.get("canonical_municipality"), "") or "",
        "state":     _clean(row.get("canonical_state"), "") or "",
        "zipCode":   _clean(row.get("canonical_zip"), "") or "",
        "lat":       _clean(row.get("lat")),
        "lng":       _clean(row.get("lng")),
        "hasData":   prices_row_data is not None,
        "prices":    prices_row_data,
        # Pipeline metadata (kept for debugging / analytics)
        "master_id":       master_id,
        "pl_number":       _clean(row.get("pl_number")),
        "confidence":      round(float(_clean(row.get("confidence_score"), 0.0)), 4),
        "primary_source":  _clean(row.get("primary_source")),
        "source_ids":      source_ids,
    }

    return station


def _export_json(
    master_df: pd.DataFrame,
    prices_df: pd.DataFrame,
    output_path: Path,
) -> int:
    """
    Export master stations + prices to JSON.
    Returns count of exported stations.
    """
    # Build prices lookup: cre_id → price row dict
    prices_map: dict = {}
    if not prices_df.empty:
        for _, row in prices_df.iterrows():
            key = row.get("cre_id") or row.get("place_id")
            if key:
                prices_map[key] = row.to_dict()

    stations = []
    for _, row in master_df.iterrows():
        stations.append(_build_station_json(row, prices_map))

    export_data = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "total":       len(stations),
        "stations":    stations,
    }

    output_path.write_text(
        json.dumps(export_data, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )

    log.info("json_exported", path=str(output_path), count=len(stations))
    return len(stations)


# ═══════════════════════════════════════════════════════════
# CSV EXPORT (VIPER matrix format for analytics)
# ═══════════════════════════════════════════════════════════

def _export_csv(
    master_df: pd.DataFrame,
    prices_df: pd.DataFrame,
    output_path: Path,
) -> int:
    """
    Export flat CSV joining master stations with latest prices.
    Suitable for Power BI, Excel, or further analysis.
    """
    df = master_df.copy()

    # Join prices
    if not prices_df.empty and "cre_id" in prices_df.columns:
        price_cols = ["cre_id", "gasolina_regular", "gasolina_premium", "diesel", "fetched_at"]
        available_cols = [c for c in price_cols if c in prices_df.columns]
        prices_slim = prices_df[available_cols].rename(columns={
            "gasolina_regular": "precio_regular",
            "gasolina_premium": "precio_premium",
            "diesel":           "precio_diesel",
            "fetched_at":       "precio_updated_at",
        })

        if "cre_id" in df.columns:
            df = df.merge(prices_slim, on="cre_id", how="left")

    # Select and order columns for export
    export_columns = [
        "master_id", "pl_number", "canonical_name", "canonical_brand",
        "canonical_address", "canonical_municipality", "canonical_state",
        "canonical_zip", "lat", "lng", "status", "confidence_score",
        "primary_source", "last_confirmed_at",
    ]
    if "precio_regular" in df.columns:
        export_columns += ["precio_regular", "precio_premium", "precio_diesel", "precio_updated_at"]

    export_df = df[[c for c in export_columns if c in df.columns]]
    export_df.to_csv(output_path, index=False, encoding="utf-8-sig")

    log.info("csv_exported", path=str(output_path), rows=len(export_df))
    return len(export_df)


# ═══════════════════════════════════════════════════════════
# MAIN EXPORT FUNCTION
# ═══════════════════════════════════════════════════════════

def run_export(
    output_dir: Optional[Path] = None,
    only_active: bool = True,
    batch_id: Optional[str] = None,
) -> dict[str, Path]:
    """
    Run the full export pipeline.

    Args:
        output_dir: Optional override for exports directory
        only_active: If True, only export active stations
        batch_id: Optional batch identifier (used in filenames)

    Returns:
        Dict of {"json": path, "csv": path}
    """
    if output_dir is None:
        output_dir = EXPORTS_DIR

    date_str = datetime.now(timezone.utc).strftime("%Y%m%d")

    json_filename = EXPORT_JSON_FILENAME_TEMPLATE.format(date=date_str)
    json_path     = output_dir / json_filename
    csv_path      = output_dir / f"stations_{date_str}.csv"
    latest_path   = output_dir / "stations_latest.json"

    # Load data
    master_df = _load_master_stations(only_active=only_active)
    prices_df = _load_latest_prices()

    if master_df.empty:
        log.warning("export_no_master_data")
        console.print("[yellow]Warning: No master stations found to export.[/yellow]")
        return {}

    # Export
    json_count = _export_json(master_df, prices_df, json_path)
    csv_count  = _export_csv(master_df, prices_df, csv_path)

    # Validate that the JSON file was actually written before copying
    import shutil
    if not json_path.exists() or json_path.stat().st_size == 0:
        log.error("json_export_missing_or_empty", path=str(json_path))
        sys.exit(1)

    # Copy to stations_latest.json (pipeline exports dir)
    shutil.copy2(json_path, latest_path)

    # Also copy to the JS app's data/ directory so the frontend can load it
    app_latest = APP_DATA_DIR / "stations_latest.json"
    APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(json_path, app_latest)

    # Verify copies landed correctly
    if not latest_path.exists():
        log.error("copy_failed", dest=str(latest_path))
        sys.exit(1)
    if not app_latest.exists():
        log.error("copy_failed", dest=str(app_latest))
        sys.exit(1)

    console.print(
        f"[green]Exported {json_count} stations[/green] → "
        f"[dim]{json_path.name}[/dim]"
    )
    console.print(
        f"[green]CSV exported {csv_count} rows[/green] → "
        f"[dim]{csv_path.name}[/dim]"
    )

    return {"json": json_path, "csv": csv_path, "latest": latest_path}


# ═══════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════

@click.command()
@click.option("--output", type=click.Path(), default=None, help="Output directory path.")
@click.option("--all-statuses", is_flag=True, default=False, help="Include non-active stations.")
def export_cli(output: Optional[str], all_statuses: bool) -> None:
    """Export master station data for the Gasolina Inteligente JS app."""
    console.print("\n[bold cyan]Gasolina Inteligente — Export[/bold cyan]\n")

    output_dir = Path(output) if output else None
    only_active = not all_statuses

    paths = run_export(output_dir=output_dir, only_active=only_active)

    if paths:
        console.print("\n[bold]Output files:[/bold]")
        for key, path in paths.items():
            console.print(f"  {key}: [dim]{path}[/dim]")
    console.print()


if __name__ == "__main__":
    export_cli()
