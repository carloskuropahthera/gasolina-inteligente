"""
quality/reporter.py — QA report generator.

Generates:
  - Markdown report with summary table and per-issue detail
  - CSV export of all issues
  - Rich terminal summary table
"""

from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import structlog
from rich.console import Console
from rich.table import Table

from config import EXPORTS_DIR
from models.match import QAIssue, QASeverity

log = structlog.get_logger(__name__)
console = Console()


# ═══════════════════════════════════════════════════════════
# REPORT GENERATION
# ═══════════════════════════════════════════════════════════

def _severity_emoji(severity: QASeverity) -> str:
    return {QASeverity.HIGH: "🔴", QASeverity.MEDIUM: "🟡", QASeverity.LOW: "🟢"}.get(severity, "⚪")


def generate_markdown(issues: list[QAIssue], run_date: Optional[str] = None) -> str:
    """
    Generate a markdown report from a list of QA issues.
    Returns the markdown string.
    """
    if run_date is None:
        run_date = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    high   = [i for i in issues if i.severity == QASeverity.HIGH]
    medium = [i for i in issues if i.severity == QASeverity.MEDIUM]
    low    = [i for i in issues if i.severity == QASeverity.LOW]

    lines = [
        "# Gasolina Inteligente — QA Report",
        "",
        f"**Run Date:** {run_date}  ",
        f"**Total Issues:** {len(issues)}  ",
        f"**High:** {len(high)} | **Medium:** {len(medium)} | **Low:** {len(low)}",
        "",
        "---",
        "",
        "## Summary by Rule",
        "",
        "| Rule | Description | Count | Severity |",
        "|------|-------------|-------|----------|",
    ]

    # Group by rule
    by_rule: dict[str, list[QAIssue]] = {}
    for issue in issues:
        by_rule.setdefault(issue.qa_rule, []).append(issue)

    for rule_id in sorted(by_rule.keys()):
        rule_issues = by_rule[rule_id]
        desc    = rule_issues[0].qa_description
        sev     = rule_issues[0].severity
        emoji   = _severity_emoji(sev)
        lines.append(f"| {rule_id} | {desc} | {len(rule_issues)} | {emoji} {sev.value} |")

    lines += ["", "---", "", "## Issue Detail", ""]

    for sev_group, sev_label in [
        (high,   "High Severity"),
        (medium, "Medium Severity"),
        (low,    "Low Severity"),
    ]:
        if not sev_group:
            continue

        lines += [f"### {sev_label}", ""]

        for issue in sev_group:
            master_ref = f" (master: `{issue.master_id}`)" if issue.master_id else ""
            lines += [
                f"**{issue.qa_rule}**{master_ref}  ",
                f"{issue.detail}  ",
                "",
            ]

    return "\n".join(lines)


def generate_csv(issues: list[QAIssue]) -> str:
    """
    Generate a CSV string from a list of QA issues.
    Suitable for import into Excel or Power BI.
    """
    import io
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=[
        "qa_rule", "qa_description", "severity", "master_id",
        "detail", "detected_at",
    ])
    writer.writeheader()
    for issue in issues:
        writer.writerow({
            "qa_rule":        issue.qa_rule,
            "qa_description": issue.qa_description,
            "severity":       issue.severity.value,
            "master_id":      issue.master_id or "",
            "detail":         issue.detail,
            "detected_at":    issue.detected_at,
        })
    return buf.getvalue()


def save_report(issues: list[QAIssue], output_dir: Optional[Path] = None) -> dict[str, Path]:
    """
    Save QA report as both markdown and CSV.
    Returns dict of {"markdown": path, "csv": path}.
    """
    if output_dir is None:
        output_dir = EXPORTS_DIR

    date_str = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M")
    md_path  = output_dir / f"qa_report_{date_str}.md"
    csv_path = output_dir / f"qa_issues_{date_str}.csv"

    md_path.write_text(generate_markdown(issues), encoding="utf-8")
    csv_path.write_text(generate_csv(issues), encoding="utf-8")

    log.info("qa_report_saved", markdown=str(md_path), csv=str(csv_path), issues=len(issues))
    return {"markdown": md_path, "csv": csv_path}


# ═══════════════════════════════════════════════════════════
# RICH TERMINAL SUMMARY
# ═══════════════════════════════════════════════════════════

def print_summary(issues: list[QAIssue]) -> None:
    """Print a rich-formatted QA summary table to the terminal."""
    high   = [i for i in issues if i.severity == QASeverity.HIGH]
    medium = [i for i in issues if i.severity == QASeverity.MEDIUM]
    low    = [i for i in issues if i.severity == QASeverity.LOW]

    console.print()
    console.print("[bold]Gasolina Inteligente — QA Summary[/bold]", style="cyan")
    console.print(
        f"Total: [bold]{len(issues)}[/bold] issues  |  "
        f"[red]High: {len(high)}[/red]  |  "
        f"[yellow]Medium: {len(medium)}[/yellow]  |  "
        f"[green]Low: {len(low)}[/green]"
    )
    console.print()

    if not issues:
        console.print("[green]✓ No QA issues found.[/green]")
        return

    table = Table(title="QA Issues by Rule", show_header=True, header_style="bold blue")
    table.add_column("Rule",        style="dim",   width=8)
    table.add_column("Severity",    width=10)
    table.add_column("Count",       width=6,  justify="right")
    table.add_column("Description", width=50)

    # Group by rule
    by_rule: dict[str, list[QAIssue]] = {}
    for issue in issues:
        by_rule.setdefault(issue.qa_rule, []).append(issue)

    for rule_id in sorted(by_rule.keys()):
        rule_issues = by_rule[rule_id]
        sev = rule_issues[0].severity
        desc = rule_issues[0].qa_description
        count = str(len(rule_issues))

        if sev == QASeverity.HIGH:
            sev_str   = "[red]HIGH[/red]"
            count_str = f"[red]{count}[/red]"
        elif sev == QASeverity.MEDIUM:
            sev_str   = "[yellow]MEDIUM[/yellow]"
            count_str = f"[yellow]{count}[/yellow]"
        else:
            sev_str   = "[green]LOW[/green]"
            count_str = f"[green]{count}[/green]"

        table.add_row(rule_id, sev_str, count_str, desc)

    console.print(table)
    console.print()

    # Show first 5 high severity issues
    if high:
        console.print("[bold red]High Severity Issues (first 5):[/bold red]")
        for issue in high[:5]:
            master_ref = f" [{issue.master_id}]" if issue.master_id else ""
            console.print(f"  [red]•[/red] {issue.qa_rule}{master_ref}: {issue.detail[:100]}")
        console.print()


def generate_report(session, output_dir: Optional[Path] = None) -> dict[str, Path]:
    """
    Run all QA checks, print summary, save reports. Returns file paths.

    Args:
        session: SQLAlchemy session (curated DB)
        output_dir: Optional output directory override

    Returns:
        dict with "markdown" and "csv" paths.
    """
    from quality.checks import run_all_checks
    issues = run_all_checks(session)
    print_summary(issues)
    return save_report(issues, output_dir)
