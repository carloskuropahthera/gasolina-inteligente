"""
scripts/refresh.py — Delta refresh for one or all sources.

Usage:
  python scripts/refresh.py --source cre_prices   # Daily CRE prices
  python scripts/refresh.py --source cre_places   # Weekly CRE places
  python scripts/refresh.py --source osm          # Weekly OSM
  python scripts/refresh.py --source denue        # Monthly DENUE
  python scripts/refresh.py --source all          # Full weekly refresh
  python scripts/refresh.py --source all --mock   # Test with mock data
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import click
import structlog
from rich.console import Console

log = structlog.get_logger(__name__)
console = Console()


@click.command()
@click.option(
    "--source",
    type=click.Choice(
        ["cre_prices", "cre_places", "osm", "denue", "brand", "all"],
        case_sensitive=False,
    ),
    required=True,
    help="Which source to refresh.",
)
@click.option("--mock", is_flag=True, default=False)
@click.option("--no-export", is_flag=True, default=False, help="Skip export step.")
@click.option("--no-qa", is_flag=True, default=False, help="Skip QA step.")
def refresh(source: str, mock: bool, no_export: bool, no_qa: bool) -> None:
    """Incremental delta refresh for one or all pipeline sources."""
    start = time.time()
    console.print(f"\n[bold cyan]Gasolina Inteligente — Refresh[/bold cyan]")
    console.print(f"Source: [bold]{source}[/bold]  |  Mock: {mock}\n")

    from orchestration.pipeline import (
        generate_batch_id,
        step_fetch_cre,
        step_fetch_osm,
        step_fetch_denue,
        step_convert_to_staging,
        step_normalize,
        step_upsert_staging,
        step_block_and_score,
        step_resolve,
        step_write_decisions,
        step_build_master_records,
        step_upsert_master,
        step_run_qa,
        step_export,
        step_write_audit,
    )
    from storage.db import init_db, curated_session
    from storage.raw_zone import find_changed_ids, read_latest_parquet, add_content_hashes

    import pandas as pd

    init_db()
    batch_id = generate_batch_id()
    console.print(f"[dim]Batch ID: {batch_id}[/dim]\n")

    cre_stations, cre_prices = [], []
    osm_stations = []
    denue_stations = []

    try:
        # ── Fetch + delta detection ────────────────────────────────────────────────
        if source in ("cre_prices", "all"):
            console.print("[cyan]Fetching CRE prices...[/cyan]")
            cre_stations_raw, cre_prices = step_fetch_cre(batch_id, mock=mock)
            cre_stations = cre_stations_raw

            # Delta detection for prices
            current_df   = pd.DataFrame([p.model_dump() for p in cre_prices])
            previous_df  = read_latest_parquet("cre_prices")
            if not previous_df.empty:
                current_df  = add_content_hashes(current_df)
                previous_df = add_content_hashes(previous_df)
                changed_ids = find_changed_ids(
                    current_df, previous_df, id_column="cre_id"
                )
                console.print(
                    f"  CRE prices: {len(current_df)} total, "
                    f"[yellow]{len(changed_ids)} changed[/yellow]"
                )
            else:
                console.print(f"  CRE prices: {len(current_df)} total (first run)")

        if source in ("cre_places", "all"):
            console.print("[cyan]Fetching CRE places...[/cyan]")
            cre_places_raw, _ = step_fetch_cre(batch_id, mock=mock)
            cre_stations = cre_places_raw
            console.print(f"  CRE places: {len(cre_stations)} stations")

        if source in ("osm", "all"):
            console.print("[cyan]Fetching OSM...[/cyan]")
            osm_stations = step_fetch_osm(batch_id, mock=mock)
            console.print(f"  OSM: {len(osm_stations)} stations")

        if source in ("denue", "all"):
            console.print("[cyan]Fetching DENUE...[/cyan]")
            denue_stations = step_fetch_denue(batch_id, mock=mock)
            console.print(f"  DENUE: {len(denue_stations)} stations")

        # ── Normalize + stage ──────────────────────────────────────────────────────
        console.print("\n[cyan]Normalizing records...[/cyan]")
        staging = step_convert_to_staging(
            cre_stations   if source in ("cre_prices", "cre_places", "all") else [],
            osm_stations   if source in ("osm", "all")                      else [],
            denue_stations if source in ("denue", "all")                    else [],
            batch_id,
        )
        staging = step_normalize(staging)
        step_upsert_staging(staging)
        console.print(f"  Staged: {len(staging)} records")

        # ── Block + Score + Resolve ────────────────────────────────────────────────
        console.print("\n[cyan]Matching records...[/cyan]")
        pairs_by_id, scored, explanations = step_block_and_score(staging)
        explanations_by_cid = {e.candidate_id: e for e in explanations}

        results = step_resolve(scored, pairs_by_id)
        step_write_decisions(results, explanations_by_cid)

        master_stations = step_build_master_records(results, pairs_by_id)
        step_upsert_master(master_stations)

        summary = results.summary()
        console.print(
            f"  Candidates: {len(pairs_by_id)} | "
            f"Matched: {summary['auto_matched']} | "
            f"Review: {summary['review_queue']} | "
            f"Master: {len(master_stations)}"
        )

        # ── QA ────────────────────────────────────────────────────────────────────
        if not no_qa:
            console.print("\n[cyan]Running QA...[/cyan]")
            qa_issues = step_run_qa()
            from quality.reporter import print_summary
            print_summary(qa_issues)

        # ── Export ────────────────────────────────────────────────────────────────
        if not no_export:
            console.print("[cyan]Exporting...[/cyan]")
            step_export(batch_id)
            console.print("  Export complete ✓")

        duration = time.time() - start

        # ── Audit ─────────────────────────────────────────────────────────────────
        with curated_session() as session:
            step_write_audit(
                session=session,
                source=source,
                batch_id=batch_id,
                records_fetched=len(staging),
                records_new=len(master_stations),
                duration_seconds=duration,
                status="success",
            )

        console.print(f"\n[bold green]Refresh complete[/bold green] in {duration:.1f}s")

    except Exception as e:
        duration = time.time() - start
        console.print(f"\n[bold red]Refresh failed: {e}[/bold red]")
        log.error("refresh_failed", source=source, error=str(e))

        try:
            with curated_session() as session:
                step_write_audit(
                    session=session,
                    source=source,
                    batch_id=batch_id,
                    records_fetched=0,
                    records_new=0,
                    duration_seconds=duration,
                    status="failed",
                    error_message=str(e),
                )
        except Exception:
            pass

        sys.exit(1)


if __name__ == "__main__":
    refresh()
