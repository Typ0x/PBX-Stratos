#!/usr/bin/env python3
"""
PBX Stratos — Paper trader (template stub)
===========================================

A minimal paper-trade loop. Reads strategies from
strategy-registry.json, ticks every 60 seconds, simulates entry +
exit decisions against live market prices, writes results to
~/.pbx-lab/paper-trades.jsonl, and writes a heartbeat file every
tick so health-check.py can detect stalls.

This is a TEMPLATE. The actual filter / entry / exit / DCA logic is
deliberately empty — the framework ships the scaffolding; you build
the strategy. See `lab/runners/README.md` for the strategy spec
format and the roadmap (sections 3-4) for how to design your own.

Run:
    python paper-trade.py
    python paper-trade.py --list-strategies
    python paper-trade.py --once         # one tick, then exit (useful for testing)
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# --- Paths -----------------------------------------------------------------

HERE             = Path(__file__).resolve().parent
REGISTRY_PATH    = HERE / "strategy-registry.json"
LAB_DIR          = Path.home() / ".pbx-lab"
TRADES_LOG       = LAB_DIR / "paper-trades.jsonl"
HEARTBEAT_FILE   = LAB_DIR / "paper-trade-heartbeat"

TICK_INTERVAL_SEC = 60
TICK_BUDGET_SEC   = 240   # if one tick takes longer than this, exit (pm2 respawns)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_registry() -> dict:
    if not REGISTRY_PATH.exists():
        sys.exit(f"strategy-registry.json not found at {REGISTRY_PATH}")
    with open(REGISTRY_PATH) as f:
        return json.load(f)


def write_heartbeat() -> None:
    LAB_DIR.mkdir(parents=True, exist_ok=True)
    HEARTBEAT_FILE.write_text(now_iso())


def append_trade(entry: dict) -> None:
    LAB_DIR.mkdir(parents=True, exist_ok=True)
    with open(TRADES_LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")


# --- Per-tick logic --------------------------------------------------------

def fetch_market_snapshot() -> dict:
    """
    Pull whatever data your strategies need to make decisions.

    Typical sources:
      - Live token prices (from a public DEX API or your own RPC)
      - PM2.5 sensor readings (PurpleAir / AirNow)
      - Weather data (boundary layer height, wind, precipitation)
      - PBX mainnet API for rebalance cycle state

    Return a dict shaped however your filters expect it.
    """
    # TEMPLATE: empty snapshot. Replace with real data sources.
    return {
        "ts": now_iso(),
        "prices": {},
        "pm25": {},
        "weather": {},
    }


def evaluate_filters(strategy: dict, snapshot: dict) -> bool:
    """
    Run the strategy's entry filters against the snapshot.
    Return True if all filters pass (entry conditions met).
    """
    # TEMPLATE: always False. Replace with real filter logic.
    return False


def manage_open_positions(strategy: dict, snapshot: dict) -> list[dict]:
    """
    For each open position under this strategy, decide whether to
    exit. Return a list of {position_id, action: 'hold'|'exit', reason}.
    """
    # TEMPLATE: empty. Replace with exit logic.
    return []


def tick(registry: dict) -> None:
    snapshot = fetch_market_snapshot()
    active = [s for s in registry.get("strategies", []) if s.get("status") == "paper"]
    for strategy in active:
        if evaluate_filters(strategy, snapshot):
            append_trade({
                "ts": snapshot["ts"],
                "strategy": strategy["id"],
                "action": "entry",
                "detail": "filters passed (template stub — no real fill)",
            })
        for decision in manage_open_positions(strategy, snapshot):
            append_trade({
                "ts": snapshot["ts"],
                "strategy": strategy["id"],
                "action": decision.get("action"),
                "detail": decision.get("reason", ""),
            })
    write_heartbeat()


# --- Main loop -------------------------------------------------------------

def list_strategies(registry: dict) -> None:
    strategies = registry.get("strategies", [])
    if not strategies:
        print("No strategies in registry yet. Add them to strategy-registry.json.")
        return
    print(f"{'ID':<24} {'STATUS':<10} DESCRIPTION")
    print("-" * 80)
    for s in strategies:
        print(f"{s.get('id',''):<24} {s.get('status',''):<10} {s.get('description','')}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--list-strategies", action="store_true")
    parser.add_argument("--once", action="store_true", help="Run one tick and exit")
    args = parser.parse_args()

    registry = load_registry()

    if args.list_strategies:
        list_strategies(registry)
        return

    print(f"paper-trade.py starting  {now_iso()}")
    print(f"strategies: {len(registry.get('strategies', []))} total, "
          f"{len([s for s in registry.get('strategies', []) if s.get('status') == 'paper'])} active in paper")

    while True:
        tick_start = time.time()
        try:
            tick(registry)
        except KeyboardInterrupt:
            print("interrupted; exiting cleanly")
            return
        except Exception as e:
            print(f"tick error: {e}", file=sys.stderr)
        elapsed = time.time() - tick_start
        if elapsed > TICK_BUDGET_SEC:
            print(f"tick exceeded budget ({elapsed:.0f}s > {TICK_BUDGET_SEC}s); exiting for pm2 respawn",
                  file=sys.stderr)
            sys.exit(1)
        if args.once:
            return
        sleep_for = max(0, TICK_INTERVAL_SEC - elapsed)
        time.sleep(sleep_for)


if __name__ == "__main__":
    main()
