# Gasolina Inteligente — Overnight Task Plan

This document describes what the pipeline can run autonomously overnight vs. what requires human action before tasks can begin.

---

## OVERNIGHT AUTONOMOUS TASKS (no human needed)

These tasks run without any manual intervention once the pipeline is installed and dependencies are configured.

### Task 1: Initial Database Setup
**Duration:** ~30 seconds
**Command:** `python -c "from storage.db import init_db; init_db()"`
What it does: Creates SQLite staging and curated databases with all tables. Safe to run multiple times.

---

### Task 2: CRE Places Seed (first run)
**Duration:** ~2–5 minutes (depends on API response time)
**Command:** `python scripts/seed.py --source cre`
What it does: Fetches all CRE station records (~12,000), normalizes names/addresses/brands, writes to staging DB. No matching yet — single source.

---

### Task 3: OSM Fuel Station Fetch
**Duration:** ~5–15 minutes (Overpass API is slow for Mexico bbox)
**Command:** `python scripts/refresh.py --source osm`
What it does: Fetches all amenity=fuel nodes and ways from OpenStreetMap via Overpass API. Rate-limited to 2 requests/minute. May need 2–3 API calls for Mexico's full bbox.

---

### Task 4: DENUE Gas Station Filter (from local file)
**Duration:** ~5–10 minutes once file is available
**Command:** `python scripts/refresh.py --source denue`
**Prerequisite:** DENUE ZIP file must be manually downloaded first (see below)
What it does: Parses DENUE bulk CSV, filters SCIAN 46411, normalizes, writes to staging.

---

### Task 5: Entity Matching (seed run)
**Duration:** ~15–30 minutes for 12,000 stations
**Command:** `python scripts/seed.py --source all --skip-export`
What it does: Runs full blocking + scoring + resolution on all staged records. Produces station_master table with ~12,000 canonical records. Writes ~200–500 review_queue items.

---

### Task 6: QA Check Run
**Duration:** ~1–2 minutes
**Command:** `python -c "from storage.db import curated_session; from quality.reporter import generate_report; curated_session().__enter__().__class__; exec('from storage.db import curated_session; from quality.reporter import generate_report\nwith curated_session() as s: generate_report(s)')"`
Simpler: `python -m quality.reporter` (after adding `__main__.py` to quality package)
What it does: Runs all 10 QA rules, writes markdown + CSV reports to data/curated/exports/.

---

### Task 7: Initial Export for JS App
**Duration:** ~30 seconds
**Command:** `python scripts/export_for_app.py`
What it does: Joins station_master with latest CRE prices, writes stations_latest.json and stations_YYYYMMDD.csv to data/curated/exports/. This is what the JS app reads.

---

### Overnight Sequence (run all at once)
```bash
# Estimated total: 30–60 minutes
cd C:/Users/carlo/gasolina-inteligente/pipeline
python -c "from storage.db import init_db; init_db()"
python scripts/seed.py --source cre
python scripts/refresh.py --source osm
python scripts/seed.py --source all --no-export
python scripts/export_for_app.py
```

Or as a single batch command:
```bash
python scripts/seed.py --source all 2>&1 | tee data/logs/seed_$(date +%Y%m%d).log
```

---

## TASKS REQUIRING HUMAN ACTION

These tasks require you to do something before the pipeline can proceed.

---

### REQUIRED: Python Environment Setup
**Who:** You (one-time setup)
**Time:** ~10 minutes
**Steps:**
```bash
cd C:/Users/carlo/gasolina-inteligente/pipeline
python -m venv venv
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

pip install -r requirements.txt
# Playwright (for brand scrapers):
playwright install chromium
```

---

### REQUIRED: INEGI DENUE Bulk Download
**Who:** You (monthly)
**Why:** The DENUE bulk download page may require browser interaction (captcha or session cookies). The direct URL sometimes works without auth, but not reliably.

**Manual download steps:**
1. Go to: https://www.inegi.org.mx/app/descargadenue/
2. Select: "Descarga masiva por entidad federativa" → "Todo el país"
3. Select: Actividad económica → "46411 — Expendio de gasolina..."
4. Or download the full dataset ZIP and let the pipeline filter it
5. Save the file to: `C:/Users/carlo/gasolina-inteligente/pipeline/data/staging/denue_bulk_latest.zip`
6. Then run: `python scripts/refresh.py --source denue`

**Alternative URL to try first (may work without browser):**
```
https://www.inegi.org.mx/contenidos/masiva/denue/denue_csv.zip
```
If this URL fails with a 403 or redirect, use the manual browser download.

---

### REQUIRED (if using Google Places): Google Cloud API Key
**Who:** You (one-time setup)
**Why:** Google Places API requires authentication. Used only for enriching review_queue records, NOT for bulk operations.

**Steps:**
1. Go to: https://console.cloud.google.com/
2. Create a new project (or use existing): "gasolina-inteligente"
3. Enable API: "Places API" (find in API Library)
4. Go to: Credentials → Create Credentials → API Key
5. Restrict key to: Places API only
6. Set environment variable:
   ```bash
   # Windows (PowerShell):
   $env:GOOGLE_PLACES_API_KEY = "AIza..."
   # Or add to your .env file (do NOT commit to git)
   ```
7. Estimated cost: $0 for <100 requests/day (free tier), $0.017/request above that

**Recommended:** Only use for review_queue items (typically 200–500 items per seed run). Total cost for full review queue enrichment: $3–8 one-time.

---

### OPTIONAL: OpenCage Geocoding API Key
**Who:** You (if you need geocoding for address-only records)
**Free tier:** 2,500 requests/day with account, no credit card required
**Steps:**
1. Go to: https://opencagedata.com/
2. Click "Sign Up for Free"
3. Get your API key from the dashboard
4. Set: `$env:OPENCAGE_API_KEY = "your_key_here"`

---

### OPTIONAL: PEMEX Locator Scraper Setup
**Who:** You (if you want brand locator enrichment)
**Why:** Some brand locator pages use JavaScript rendering, requiring Playwright (Chromium).
**Steps:**
```bash
playwright install chromium
```
Then run: `python scripts/refresh.py --source brand`

Check `pemex.com/robots.txt` before scraping. Rate limit is already set to 1 req/2s in config.py.

---

### CRE API PL Number Research (IMPORTANT — Day 1 task)
**Who:** You
**Why:** It is not documented whether CRE API `cre_id` / `place_id` fields are the same as PL permit numbers (format: PL/NNNN/EXP/ES/YYYY). This must be verified before using any PL numbers.

**Steps:**
1. Download 10 sample records from CRE Places API
2. Look up the same stations on: https://www.cre.gob.mx/ConsultaPermisos/
3. Compare the `cre_id` field values against the permit registry
4. Document the mapping in a comment in `storage/curated_zone.py` (line with `# TODO`)

---

## MORNING CHECKLIST

Run these checks when you wake up after the overnight tasks:

### 1. Check pipeline completion
```bash
cd C:/Users/carlo/gasolina-inteligente/pipeline
# Check the log file:
cat data/logs/seed_$(date +%Y%m%d 2>/dev/null).log | tail -50
# Or on Windows:
Get-Content data\logs\seed_$(Get-Date -Format yyyyMMdd).log -Tail 50
```

### 2. Check database record counts
```bash
python -c "
import sqlite3
conn = sqlite3.connect('data/curated/gasolina_master.db')
print('station_master:', conn.execute('SELECT COUNT(*) FROM station_master').fetchone()[0])
print('review_queue:  ', conn.execute('SELECT COUNT(*) FROM review_queue WHERE status=\"pending\"').fetchone()[0])
print('match_decisions:', conn.execute('SELECT decision, COUNT(*) FROM match_decisions GROUP BY decision').fetchall())
conn.close()
"
```
**Expected after full seed:**
- station_master: 8,000–12,000 records
- review_queue pending: 200–500 items
- match_decisions auto_match: most of the auto-resolved pairs

### 3. Review the QA report
Open: `data/curated/exports/qa_report_YYYYMMDD_HHMM.md`

Look for:
- QA-01 HIGH severity: duplicate PL numbers (should be 0 after seed)
- QA-04 HIGH: out-of-bounds coordinates (check source data quality)
- QA-07 HIGH: missing name/coordinates (affects app display)

### 4. Check the export file
Open: `data/curated/exports/stations_latest.json`

Verify:
- File exists and is valid JSON
- `total` count matches station_master count
- A few random records have reasonable data (name, lat/lng, brand)
- Some records have `prices` populated (from CRE prices API)

### 5. Review queue (if time permits)
```bash
python scripts/review_queue.py --list --limit 10
```
Shows the 10 highest-priority review items. Spend 30 minutes resolving easy ones
(e.g., where geo_score is 0.99 but name_score is low — these are almost certainly the same station).

### 6. Address any high-severity QA issues
- Duplicate PL numbers → run `scripts/review_queue.py --fix-duplicates`
- Out-of-bounds coordinates → check source data; may need manual correction
- Missing names → check if CRE API returned empty names for some stations

---

## ESTIMATED TIME BREAKDOWN

| Task | Autonomous? | Duration | Notes |
|------|-------------|----------|-------|
| pip install | Manual (once) | 5 min | |
| CRE fetch | Autonomous | 2–5 min | |
| OSM fetch | Autonomous | 10–15 min | Slow API |
| DENUE download | Manual + auto | 5 min manual + 5 min processing | See above |
| Normalize | Autonomous | 2–3 min | 12K records |
| Block + Score | Autonomous | 5–15 min | Depends on pair count |
| Resolve | Autonomous | <1 min | |
| QA | Autonomous | <1 min | |
| Export | Autonomous | <1 min | |
| **Total autonomous** | — | **~30–45 min** | Excluding DENUE manual step |
| **Total with manual** | — | **~45–60 min** | |
