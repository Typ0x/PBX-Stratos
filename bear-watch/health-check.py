#!/usr/bin/env python3
"""
PBX Stratos — Health check (7 categories)
==========================================

Runs 7 GREEN/RED checks on the running bot setup:

    1. Server alive       — HTTP /health responds 200
    2. Dashboard responds — HTTP /dashboard responds 200
    3. Paper-trade heartbeat — mtime of paper-trade heartbeat file < 5min
    4. AQI feed fresh     — mtime of cached AQI snapshot < 30min
    5. Alerts writable    — alerts.jsonl is open-for-append
    6. Disk space         — > 10% free on the partition holding ~/.pbx-lab
    7. RPC reachable      — Helius getSlot returns a slot number

Exits 0 if all GREEN, 1 if any RED. Designed to be called from a
scheduled task (BEARWATCH-HealthCheck every 5 min) — its stdout is
both a human-readable summary and a machine-parseable status line.

Each check has been written to be CHEAP — none take more than a few
seconds in the normal case, so total runtime is well under 10s.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

# ---- Configuration (override via env vars if you want) ------------------

DASHBOARD_BASE   = os.environ.get("PBX_DASHBOARD_BASE", "http://localhost:8787")
HEALTH_URL       = f"{DASHBOARD_BASE}/health"
DASHBOARD_URL    = f"{DASHBOARD_BASE}/dashboard"
RPC_URL          = os.environ.get("HELIUS_MAINNET_URL", "")   # required for check 7
LAB_DIR          = Path.home() / ".pbx-lab"
HEARTBEAT_FILE   = LAB_DIR / "paper-trade-heartbeat"
AQI_SNAPSHOT     = LAB_DIR / "aqi-snapshot.json"
ALERTS_FILE      = LAB_DIR / "alerts.jsonl"
HEARTBEAT_MAX_AGE_SEC = 5 * 60
AQI_MAX_AGE_SEC       = 30 * 60
MIN_FREE_DISK_FRAC    = 0.10

# ---- Result helpers -----------------------------------------------------

GREEN = "\033[32m" if sys.stdout.isatty() else ""
RED   = "\033[31m" if sys.stdout.isatty() else ""
RESET = "\033[0m"  if sys.stdout.isatty() else ""

results: list[tuple[str, bool, str]] = []

def check(name: str, ok: bool, detail: str) -> None:
    results.append((name, ok, detail))

def http_get(url: str, timeout: float = 5.0) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "pbx-health-check"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read().decode("utf-8", errors="replace")

# ---- The 7 checks -------------------------------------------------------

# 1. Server alive
try:
    status, _ = http_get(HEALTH_URL)
    check("Server alive", status == 200, f"GET {HEALTH_URL} returned {status}")
except Exception as e:
    check("Server alive", False, f"GET {HEALTH_URL} failed: {e}")

# 2. Dashboard responds
try:
    status, _ = http_get(DASHBOARD_URL)
    check("Dashboard responds", status == 200, f"GET {DASHBOARD_URL} returned {status}")
except Exception as e:
    check("Dashboard responds", False, f"GET {DASHBOARD_URL} failed: {e}")

# 3. Paper-trade heartbeat
try:
    if not HEARTBEAT_FILE.exists():
        check("Paper-trade heartbeat", False, f"missing: {HEARTBEAT_FILE}")
    else:
        age = time.time() - HEARTBEAT_FILE.stat().st_mtime
        ok = age < HEARTBEAT_MAX_AGE_SEC
        check("Paper-trade heartbeat", ok, f"age {age:.0f}s (max {HEARTBEAT_MAX_AGE_SEC}s)")
except Exception as e:
    check("Paper-trade heartbeat", False, f"check failed: {e}")

# 4. AQI feed fresh
try:
    if not AQI_SNAPSHOT.exists():
        check("AQI feed fresh", False, f"missing: {AQI_SNAPSHOT}")
    else:
        age = time.time() - AQI_SNAPSHOT.stat().st_mtime
        ok = age < AQI_MAX_AGE_SEC
        check("AQI feed fresh", ok, f"age {age:.0f}s (max {AQI_MAX_AGE_SEC}s)")
except Exception as e:
    check("AQI feed fresh", False, f"check failed: {e}")

# 5. Alerts writable
try:
    ALERTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(ALERTS_FILE, "a") as f:
        pass  # no actual write — just confirm we can open in append mode
    check("Alerts writable", True, str(ALERTS_FILE))
except Exception as e:
    check("Alerts writable", False, f"could not open {ALERTS_FILE} for append: {e}")

# 6. Disk space
try:
    total, used, free = shutil.disk_usage(str(LAB_DIR if LAB_DIR.exists() else Path.home()))
    free_frac = free / total if total else 0
    ok = free_frac >= MIN_FREE_DISK_FRAC
    check("Disk space", ok, f"{free_frac*100:.1f}% free (min {MIN_FREE_DISK_FRAC*100:.0f}%)")
except Exception as e:
    check("Disk space", False, f"check failed: {e}")

# 7. RPC reachable
if not RPC_URL:
    check("RPC reachable", False, "HELIUS_MAINNET_URL not set in environment")
else:
    try:
        payload = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getSlot",
            "params": [],
        }).encode("utf-8")
        req = urllib.request.Request(
            RPC_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            body = json.loads(resp.read())
        slot = body.get("result")
        check("RPC reachable", isinstance(slot, int) and slot > 0, f"slot {slot}")
    except Exception as e:
        check("RPC reachable", False, f"RPC call failed: {e}")

# ---- Report -------------------------------------------------------------

green_count = sum(1 for _, ok, _ in results if ok)
total = len(results)
ts = datetime.now(timezone.utc).isoformat(timespec="seconds")

print(f"PBX Stratos health-check  {ts}")
print(f"{green_count}/{total} GREEN")
print()
for name, ok, detail in results:
    mark = f"{GREEN}GREEN{RESET}" if ok else f"{RED}RED  {RESET}"
    print(f"  {mark}  {name:<26}  {detail}")
print()
print(f"PBX_HEALTH_STATUS={'GREEN' if green_count == total else 'RED'}")

sys.exit(0 if green_count == total else 1)
