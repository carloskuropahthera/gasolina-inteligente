# Deploy + Pipeline Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push the repo to GitHub, fix the GitHub Actions workflow for standalone-repo paths, and deploy the static app to Vercel with auto-deploy on every push.

**Architecture:** The repo root IS the app root (no monorepo prefix). GitHub Actions fetches CRE prices daily, commits `data/stations_latest.json`, which triggers Vercel auto-redeploy. Zero recurring cost.

**Tech Stack:** Git, GitHub Actions, Vercel (free hobby tier), Python 3.11, existing pipeline.

---

## File Map

| File | Change |
|---|---|
| `.github/workflows/daily-refresh.yml` | Fix all paths (strip `gasolina-inteligente/` prefix), add `PYTHONUTF8: "1"` to all Python steps |
| `vercel.json` | Create — tells Vercel framework=none, output=root |

---

### Task 1: Fix GitHub Actions workflow paths

**Files:**
- Modify: `.github/workflows/daily-refresh.yml`

The current workflow was written for a monorepo where the app was at `gasolina-inteligente/`. The repo is now standalone so all paths must drop that prefix.

- [ ] **Step 1: Replace the workflow file**

Replace `.github/workflows/daily-refresh.yml` with:

```yaml
name: Daily Price Refresh

on:
  schedule:
    - cron: '30 13 * * *'
  workflow_dispatch:

jobs:
  refresh:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          fetch-depth: 1

      - name: Set up Python 3.11
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          cache: 'pip'
          cache-dependency-path: pipeline/requirements.txt

      - name: Install Python dependencies
        run: pip install -r requirements.txt
        working-directory: pipeline
        env:
          PYTHONUTF8: "1"

      - name: Restore pipeline databases (price history continuity)
        uses: actions/cache@v4
        with:
          path: |
            pipeline/data/staging/gasolina_staging.db
            pipeline/data/curated/gasolina_master.db
            pipeline/data/raw/
          key: pipeline-db-${{ github.run_number }}
          restore-keys: |
            pipeline-db-

      - name: Initialize databases (idempotent)
        run: python -c "import sys; sys.path.insert(0,'pipeline'); from storage.db import init_db; init_db()"
        env:
          PYTHONUTF8: "1"

      - name: Run daily CRE price refresh
        run: python scripts/refresh.py --source cre_prices --no-qa
        working-directory: pipeline
        env:
          PYTHONPATH: .
          PYTHONUTF8: "1"

      - name: Copy export to web app data directory
        run: |
          mkdir -p data
          cp pipeline/data/curated/exports/stations_latest.json data/stations_latest.json
          echo "Exported: $(python3 -c "import json; d=json.load(open('data/stations_latest.json')); print(d['total'], 'stations,', d['exported_at'])")"
        env:
          PYTHONUTF8: "1"

      - name: Commit and push updated data
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/stations_latest.json
          git diff --staged --quiet && echo "No changes to commit" || \
            git commit -m "data: daily price refresh $(date -u +%Y-%m-%d)" && \
            git push
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/daily-refresh.yml
git commit -m "fix: update workflow paths for standalone repo, add PYTHONUTF8"
```

---

### Task 2: Create Vercel configuration

**Files:**
- Create: `vercel.json`

Vercel needs to know this is a static site with no build step.

- [ ] **Step 1: Create `vercel.json` at repo root**

```json
{
  "version": 2,
  "buildCommand": null,
  "outputDirectory": ".",
  "framework": null,
  "rewrites": [
    { "source": "/(.*)", "destination": "/$1" }
  ],
  "headers": [
    {
      "source": "/data/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=3600, stale-while-revalidate=86400" }
      ]
    },
    {
      "source": "/(.*\\.js)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=86400" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add vercel.json
git commit -m "feat: add vercel.json for static deployment config"
```

---

### Task 3: Create GitHub repository and push

**Files:** None (git remote operations)

- [ ] **Step 1: Create repo on GitHub**

Go to https://github.com/new and create:
- Repository name: `gasolina-inteligente`
- Visibility: Public (required for free Vercel + GitHub Actions)
- Do NOT initialize with README, .gitignore, or license (the repo already has content)

- [ ] **Step 2: Add remote and push**

```bash
cd C:/Users/carlo/gasolina-inteligente
git remote add origin https://github.com/carlosdiaz-3388/gasolina-inteligente.git
git branch -M main
git push -u origin main
```

Expected output:
```
Enumerating objects: ...
To https://github.com/carlosdiaz-3388/gasolina-inteligente.git
 * [new branch]      main -> main
Branch 'main' set up to track remote branch 'main' from 'origin'.
```

- [ ] **Step 3: Verify on GitHub**

Open `https://github.com/carlosdiaz-3388/gasolina-inteligente` — confirm all files are visible including `data/stations_latest.json` and `.github/workflows/daily-refresh.yml`.

---

### Task 4: Deploy to Vercel

**Files:** None (Vercel MCP / vercel.com UI)

- [ ] **Step 1: Deploy via Vercel MCP**

Use the `deploy_to_vercel` MCP tool with:
- `projectPath`: `C:/Users/carlo/gasolina-inteligente`
- `teamId`: `team_onwzIRqG6fhZYoDJly9ZaeED`

Or via Vercel dashboard:
- Go to https://vercel.com/new
- Import Git repository → select `gasolina-inteligente`
- Framework Preset: **Other**
- Root Directory: `.` (leave blank)
- Build Command: (leave blank)
- Output Directory: `.` (leave blank)
- Click Deploy

- [ ] **Step 2: Verify deployment**

Vercel will show a URL like `https://gasolina-inteligente-xxxx.vercel.app`. Open it and confirm:
- The app loads (`Gasolina Inteligente` title appears)
- The map renders with station clusters
- Price list shows stations with prices (check browser console: `Static data loaded: 14638 stations`)

- [ ] **Step 3: Connect GitHub for auto-deploy**

In Vercel project Settings → Git → Connected Git Repository → connect to `carlosdiaz-3388/gasolina-inteligente`. This enables auto-deploy on every push to `main`.

---

### Task 5: Verify the full automation loop

- [ ] **Step 1: Manually trigger the GitHub Actions workflow**

Go to `https://github.com/carlosdiaz-3388/gasolina-inteligente/actions` → select `Daily Price Refresh` → click `Run workflow` → `Run workflow`.

- [ ] **Step 2: Monitor the run**

Watch the run complete. Expected duration: ~60–90s. All steps should show green checkmarks. The final step should output something like:
```
Exported: 14722 stations, 2026-04-01T...
```

- [ ] **Step 3: Verify the commit appeared**

On GitHub, check that a new commit `data: daily price refresh YYYY-MM-DD` was pushed to `main` by `github-actions[bot]`.

- [ ] **Step 4: Verify Vercel auto-redeployed**

In the Vercel dashboard, a new deployment should have triggered automatically from the Actions commit. Wait for it to complete and confirm the live URL still loads correctly.

---

## Success Criteria

- `https://gasolina-inteligente.vercel.app` (or assigned URL) serves the app publicly
- GitHub Actions run completes without errors
- After Actions run: new commit appears on GitHub, Vercel redeploys automatically
- Live app shows 14,000+ stations with real prices
