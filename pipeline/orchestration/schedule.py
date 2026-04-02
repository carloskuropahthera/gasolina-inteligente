"""
orchestration/schedule.py — Cron schedule definitions for the MVP pipeline.

These are the cron expressions and their meanings.
Copy the cron entries into your crontab (Linux/macOS) or Task Scheduler (Windows).
"""

from __future__ import annotations

PIPELINE_DIR = "/path/to/gasolina-inteligente/pipeline"

CRON_SCHEDULES = """
# ═══════════════════════════════════════════════════════════
# Gasolina Inteligente Pipeline — Cron Schedules
# ═══════════════════════════════════════════════════════════
# Edit PIPELINE_DIR to match your installation path.
# Run: crontab -e  and paste these lines.
#
# Format: minute hour day_of_month month day_of_week command
# ═══════════════════════════════════════════════════════════

# ── Daily: CRE prices (06:00 every day) ──────────────────────
0 6 * * * cd {PIPELINE_DIR} && python scripts/refresh.py --source cre_prices >> data/logs/cre_prices_$(date +\\%Y\\%m\\%d).log 2>&1

# ── Weekly: Full refresh (Sunday 02:00) ──────────────────────
0 2 * * 0 cd {PIPELINE_DIR} && python scripts/refresh.py --source all >> data/logs/weekly_refresh_$(date +\\%Y\\%m\\%d).log 2>&1

# ── Weekly: Export for app (Sunday 03:30, after full refresh) ─
30 3 * * 0 cd {PIPELINE_DIR} && python scripts/export_for_app.py >> data/logs/export_$(date +\\%Y\\%m\\%d).log 2>&1

# ── Weekly: QA report (Monday 07:00) ─────────────────────────
0 7 * * 1 cd {PIPELINE_DIR} && python -m quality.reporter >> data/logs/qa_$(date +\\%Y\\%m\\%d).log 2>&1
""".format(PIPELINE_DIR=PIPELINE_DIR)


WINDOWS_TASK_SCHEDULES = """
# ═══════════════════════════════════════════════════════════
# Windows Task Scheduler equivalents (PowerShell commands)
# Run these once to register scheduled tasks.
# Replace C:\\path\\to\\pipeline with your actual path.
# ═══════════════════════════════════════════════════════════

# Daily CRE prices at 06:00
$action = New-ScheduledTaskAction -Execute "python" -Argument "scripts/refresh.py --source cre_prices" -WorkingDirectory "C:\\path\\to\\pipeline"
$trigger = New-ScheduledTaskTrigger -Daily -At 06:00
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "GI_CRE_Prices"

# Weekly full refresh Sunday 02:00
$action = New-ScheduledTaskAction -Execute "python" -Argument "scripts/refresh.py --source all" -WorkingDirectory "C:\\path\\to\\pipeline"
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 02:00
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "GI_Weekly_Refresh"

# Weekly export Sunday 03:30
$action = New-ScheduledTaskAction -Execute "python" -Argument "scripts/export_for_app.py" -WorkingDirectory "C:\\path\\to\\pipeline"
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 03:30
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "GI_Export"
"""


def print_cron_setup():
    """Print cron setup instructions."""
    from rich.console import Console
    from rich.syntax import Syntax
    console = Console()
    console.print("[bold]Cron Schedule Setup[/bold]", style="cyan")
    console.print()
    console.print("Run [bold]crontab -e[/bold] and add these lines:")
    console.print()
    syntax = Syntax(CRON_SCHEDULES, "bash", theme="monokai", line_numbers=False)
    console.print(syntax)
    console.print()
    console.print("For Windows, use Task Scheduler (see schedule.py for PowerShell commands)")
