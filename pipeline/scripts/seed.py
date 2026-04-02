"""
scripts/seed.py — One-time initial seed of the Gasolina Inteligente master dataset.

This script runs the FULL pipeline for the first time:
  1. Fetch CRE Places + Prices
  2. Fetch INEGI DENUE
  3. Fetch OpenStreetMap fuel stations
  4. Normalize all records
  5. Block + Score + Resolve
  6. Build station_master
  7. Run QA checks
  8. Export for JS app

Usage:
  python scripts/seed.py
  python scripts/seed.py --mock          # Use synthetic data (offline testing)
  python scripts/seed.py --source cre    # Only seed from CRE (fastest first run)
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

# Ensure pipeline package is on PYTHONPATH
sys.path.insert(0, str(Path(__file__).parent.parent))

import click
import structlog
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn, TimeElapsedColumn

log = structlog.get_logger(__name__)
console = Console()


@click.command()
@click.option(
    "--mock",
    is_flag=True,
    default=False,
    help="Use synthetic mock data instead of real API calls (for offline testing).",
)
@click.option(
    "--source",
    type=click.Choice(["all", "cre", "osm", "denue"], case_sensitive=False),
    default="all",
    help="Which data source(s) to seed from.",
)
@click.option(
    "--skip-qa",
    is_flag=True,
    default=False,
    help="Skip QA checks after seeding (faster, not recommended for production).",
)
@click.option(
    "--skip-export",
    is_flag=True,
    default=False,
    help="Skip JSON export after seeding.",
)
def seed(mock: bool, source: str, skip_qa: bool, skip_export: bool) -> None:
    """
    One-time initial seed of the Gasolina Inteligente master dataset.

    This command sets up the databases and runs the full ingestion pipeline
    for the first time. Subsequent runs should use scripts/refresh.py instead.
    """
    start_time = time.time()

    console.print()
    console.print("[bold cyan]Gasolina Inteligente — Initial Seed[/bold cyan]")
    console.print(f"Source: [bold]{source}[/bold]  |  Mock: [bold]{mock}[/bold]")
    console.print()

    if mock:
        console.print("[yellow]⚠  MOCK MODE — using synthetic data, no real API calls[/yellow]")
        console.print()

    # Step 0: Initialize databases
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Initializing databases...", total=None)
        from storage.db import init_db, verify_db_health
        init_db()
        health = verify_db_health()
        progress.update(task, description="Databases initialized ✓")

    if not all(health.values()):
        console.print(f"[red]Database health check failed: {health}[/red]")
        sys.exit(1)

    # Step 1: Fetch raw data
    cre_stations, cre_prices = [], []
    osm_stations = []
    denue_stations = []

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
        step_promote_unmatched_cre,
        step_upsert_master,
        step_run_qa,
        step_export,
        step_write_audit,
    )

    batch_id = generate_batch_id()
    console.print(f"[dim]Batch ID: {batch_id}[/dim]")
    console.print()

    staging = []
    pairs_by_id = {}
    master_stations = []
    summary = {"auto_matched": 0, "review_queue": 0, "rejected": 0}

    try:
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            TimeElapsedColumn(),
            console=console,
        ) as progress:

            # Fetch sources
            if source in ("all", "cre"):
                task = progress.add_task("Fetching CRE Places + Prices...", total=None)
                try:
                    cre_stations, cre_prices = step_fetch_cre(batch_id, mock=mock)
                except Exception as e:
                    log.error("fetch_cre_failed", error=str(e), batch_id=batch_id)
                    raise
                progress.update(
                    task,
                    description=f"CRE: {len(cre_stations)} stations, {len(cre_prices)} prices ✓"
                )

            if source in ("all", "osm"):
                task = progress.add_task("Fetching OSM fuel stations...", total=None)
                try:
                    osm_stations = step_fetch_osm(batch_id, mock=mock)
                except Exception as e:
                    log.error("fetch_osm_failed", error=str(e), batch_id=batch_id)
                    raise
                progress.update(task, description=f"OSM: {len(osm_stations)} stations ✓")

            if source in ("all", "denue"):
                task = progress.add_task("Fetching INEGI DENUE...", total=None)
                try:
                    denue_stations = step_fetch_denue(batch_id, mock=mock)
                except Exception as e:
                    log.error("fetch_denue_failed", error=str(e), batch_id=batch_id)
                    raise
                progress.update(task, description=f"DENUE: {len(denue_stations)} stations ✓")

            # Convert + Normalize
            task = progress.add_task("Converting to staging model...", total=None)
            staging = step_convert_to_staging(
                cre_stations if source in ("all", "cre") else [],
                osm_stations if source in ("all", "osm") else [],
                denue_stations if source in ("all", "denue") else [],
                batch_id,
            )
            progress.update(task, description=f"Converted {len(staging)} records ✓")

            task = progress.add_task("Normalizing records...", total=None)
            staging = step_normalize(staging)
            progress.update(task, description=f"Normalized {len(staging)} records ✓")

            # Write to staging DB
            task = progress.add_task("Writing to staging database...", total=None)
            step_upsert_staging(staging)
            progress.update(task, description="Staging DB updated ✓")

            # Block + Score
            task = progress.add_task("Blocking + scoring candidates...", total=None)
            pairs_by_id, scored, explanations = step_block_and_score(staging)
            explanations_by_cid = {e.candidate_id: e for e in explanations}
            progress.update(
                task,
                description=f"Generated {len(pairs_by_id)} candidates, scored ✓"
            )

            # Resolve
            task = progress.add_task("Resolving entity matches...", total=None)
            results = step_resolve(scored, pairs_by_id)
            summary = results.summary()
            progress.update(
                task,
                description=(
                    f"Resolved: {summary['auto_matched']} matched, "
                    f"{summary['review_queue']} review, "
                    f"{summary['rejected']} rejected ✓"
                )
            )

            # Write decisions
            task = progress.add_task("Writing match decisions...", total=None)
            step_write_decisions(results, explanations_by_cid)
            progress.update(task, description="Match decisions written ✓")

            # Build + write master
            task = progress.add_task("Building master station records...", total=None)
            master_stations = step_build_master_records(results, pairs_by_id)
            master_stations += step_promote_unmatched_cre(staging, results, pairs_by_id)
            step_upsert_master(master_stations)
            progress.update(task, description=f"{len(master_stations)} master records written ✓")

    except Exception as e:
        duration = time.time() - start_time
        console.print(f"\n[bold red]Seed failed: {e}[/bold red]")
        log.error("seed_failed", source=source, error=str(e), batch_id=batch_id)
        try:
            from storage.db import curated_session
            with curated_session() as session:
                step_write_audit(
                    session=session,
                    source=f"seed_{source}",
                    batch_id=batch_id,
                    records_fetched=len(staging),
                    records_new=len(master_stations),
                    duration_seconds=duration,
                    status="failed",
                    error_message=str(e),
                )
        except Exception:
            pass
        sys.exit(1)

    # Print pipeline summary
    duration = time.time() - start_time
    console.print()
    console.print("[bold green]Seed Complete![/bold green]")
    console.print(f"  Duration:     [bold]{duration:.1f}s[/bold]")
    console.print(f"  Staged:       [bold]{len(staging)}[/bold] records")
    console.print(f"  Candidates:   [bold]{len(pairs_by_id)}[/bold]")
    console.print(f"  Auto-matched: [bold]{summary['auto_matched']}[/bold]")
    console.print(f"  Review queue: [bold]{summary['review_queue']}[/bold]")
    console.print(f"  Master recs:  [bold]{len(master_stations)}[/bold]")
    console.print()

    # QA
    if not skip_qa:
        console.print("[cyan]Running QA checks...[/cyan]")
        try:
            qa_issues = step_run_qa()
            from quality.reporter import print_summary
            print_summary(qa_issues)
        except Exception as e:
            log.error("qa_failed", error=str(e), batch_id=batch_id)
            console.print(f"[yellow]Warning: QA step failed: {e}[/yellow]")

    # Export
    if not skip_export:
        console.print("[cyan]Exporting for JS app...[/cyan]")
        try:
            step_export(batch_id)
            console.print("[green]Export complete ✓[/green]")
        except Exception as e:
            log.error("export_failed", error=str(e), batch_id=batch_id)
            console.print(f"[yellow]Warning: Export step failed: {e}[/yellow]")

    # Audit
    from storage.db import curated_session
    try:
        with curated_session() as session:
            step_write_audit(
                session=session,
                source=f"seed_{source}",
                batch_id=batch_id,
                records_fetched=len(staging),
                records_new=len(master_stations),
                duration_seconds=duration,
                status="success",
            )
    except Exception as e:
        log.error("audit_write_failed", error=str(e), batch_id=batch_id)
        console.print(f"[yellow]Warning: Audit write failed: {e}[/yellow]")

    console.print()
    console.print("[bold]Next steps:[/bold]")
    console.print("  1. Review the QA report in data/curated/exports/")
    console.print("  2. Use [bold]scripts/review_queue.py[/bold] to resolve low-confidence matches")
    console.print("  3. Set up cron with [bold]python -m orchestration.schedule[/bold]")
    console.print()


if __name__ == "__main__":
    seed()
