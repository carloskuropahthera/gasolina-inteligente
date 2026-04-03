"""
Generate pre-computed distance matrix for gasolina-inteligente.
Output: data/static/stations_within_5km.csv
         data/static/distance_matrix_summary.json

Only pairs with haversine ≤ 5 km are included; both A→B and B→A rows are written.
A bounding box pre-filter (±0.045° lat, adjusted lng) keeps the hot loop O(n·k)
instead of O(n²).
"""

import json
import math
import csv
import os
import bisect
from datetime import datetime, timezone

# ── helpers ──────────────────────────────────────────────────────────────────

def haversine(lat1, lon1, lat2, lon2):
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(a))


def manhattan_approx(lat1, lon1, lat2, lon2):
    dlat_km = abs(lat2 - lat1) * 111
    avg_lat = (lat1 + lat2) / 2
    dlng_km = abs(lon2 - lon1) * 111 * math.cos(math.radians(avg_lat))
    return dlat_km + dlng_km


# ── paths ─────────────────────────────────────────────────────────────────────

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STATIONS_JSON = os.path.join(BASE, "data", "stations_latest.json")
STATIC_DIR    = os.path.join(BASE, "data", "static")
CSV_OUT       = os.path.join(STATIC_DIR, "stations_within_5km.csv")
SUMMARY_OUT   = os.path.join(STATIC_DIR, "distance_matrix_summary.json")

os.makedirs(STATIC_DIR, exist_ok=True)

# ── load stations ─────────────────────────────────────────────────────────────

print("Loading stations …")
with open(STATIONS_JSON, encoding="utf-8") as f:
    raw = json.load(f)

stations_raw = raw["stations"]
stations = [s for s in stations_raw
            if s.get("lat") is not None and s.get("lng") is not None]
print(f"  {len(stations_raw)} total, {len(stations)} with valid lat/lng")

# ── sort by lat for sliding-window scan ───────────────────────────────────────

stations.sort(key=lambda s: s["lat"])
lats = [s["lat"] for s in stations]

RADIUS_KM  = 5.0
LAT_DEG    = 0.045          # 5 km in degrees latitude (≈ 111 km/deg)
LNG_MARGIN = 0.055          # slightly wider to account for cos(lat) shrinkage near equator

# ── generate pairs ────────────────────────────────────────────────────────────

print("Computing pairs …")
pair_count = 0

with open(CSV_OUT, "w", newline="", encoding="utf-8") as csvfile:
    writer = csv.writer(csvfile)
    writer.writerow(["ID_A", "ID_B", "haversine_km", "manhattan_approx_km"])

    n = len(stations)
    report_step = max(1, n // 20)   # progress every 5 %

    for i, a in enumerate(stations):
        if i % report_step == 0:
            pct = 100 * i / n
            print(f"  {pct:5.1f}%  station {i}/{n}  pairs so far: {pair_count:,}")

        a_lat, a_lng = a["lat"], a["lng"]
        a_id = a["id"]

        # binary search for the window of stations within ±LAT_DEG
        lo = bisect.bisect_left(lats,  a_lat - LAT_DEG)
        hi = bisect.bisect_right(lats, a_lat + LAT_DEG)

        for j in range(lo, hi):
            if j == i:
                continue
            b = stations[j]
            b_lat, b_lng = b["lat"], b["lng"]

            # cheap lng pre-filter
            if abs(b_lng - a_lng) > LNG_MARGIN:
                continue

            dist = haversine(a_lat, a_lng, b_lat, b_lng)
            if dist > RADIUS_KM:
                continue

            man = manhattan_approx(a_lat, a_lng, b_lat, b_lng)
            # write A→B
            writer.writerow([a_id, b["id"], f"{dist:.4f}", f"{man:.4f}"])
            pair_count += 1

print(f"  100.0%  done — {pair_count:,} directed pairs written")

# The loop above writes every (i,j) AND (j,i) pair because for each station i
# we scan all stations j within the window, which includes stations with j < i.
# So both directions are already captured.

# ── summary JSON ──────────────────────────────────────────────────────────────

summary = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "radius_km": RADIUS_KM,
    "station_count": len(stations),
    "pair_count": pair_count,
}
with open(SUMMARY_OUT, "w", encoding="utf-8") as f:
    json.dump(summary, f, indent=2)

print(f"\nFiles written:")
print(f"  {CSV_OUT}")
print(f"  {SUMMARY_OUT}")
print(f"\nSummary: {json.dumps(summary, indent=2)}")
