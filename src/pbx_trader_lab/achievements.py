"""
Achievement tracker — reads events.jsonl, updates achievements.json,
prints celebrations on unlock.

Each runner / bot emits events to ~/.pbx-lab/events.jsonl. The tracker
scans events and unlocks corresponding achievements. Run via:

    python3 -m pbx_trader_lab.achievements
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

PBX_HOME = Path.home() / ".pbx-lab"
EVENTS_PATH = PBX_HOME / "events.jsonl"
ACHIEVEMENTS_PATH = PBX_HOME / "achievements.json"
DEFS_PATH = Path(__file__).resolve().parent.parent.parent / "achievements" / "definitions.json"


def _load_events() -> list[dict]:
    if not EVENTS_PATH.exists():
        return []
    out = []
    with open(EVENTS_PATH) as f:
        for line in f:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def _load_state() -> dict:
    if not ACHIEVEMENTS_PATH.exists():
        return {"unlocked": [], "first_unlocked_at": {}, "last_check": None}
    try:
        with open(ACHIEVEMENTS_PATH) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"unlocked": [], "first_unlocked_at": {}, "last_check": None}


def _save_state(state: dict) -> None:
    PBX_HOME.mkdir(parents=True, exist_ok=True)
    ACHIEVEMENTS_PATH.write_text(json.dumps(state, indent=2) + "\n")


def _unlock(state: dict, aid: str, defs_by_id: dict, *, quiet: bool = False) -> bool:
    if aid in state["unlocked"]:
        return False
    state["unlocked"].append(aid)
    state["first_unlocked_at"][aid] = datetime.now(timezone.utc).isoformat()
    if not quiet:
        ach = defs_by_id.get(aid, {})
        title = ach.get("title", aid)
        desc = ach.get("description", "")
        print()
        print(f"  ★ ACHIEVEMENT UNLOCKED: {title}")
        print(f"    {desc}")
        print()
    return True


def evaluate(events: list[dict], state: dict, defs_by_id: dict, *, quiet: bool = False) -> int:
    """Walk events and unlock achievements. Returns count of new unlocks."""
    new = 0
    # first_light: any event implies the wizard ran
    if events and "first_light" not in state["unlocked"]:
        if _unlock(state, "first_light", defs_by_id, quiet=quiet):
            new += 1
    # event-driven unlocks
    backtest_count = 0
    max_sharpe = 0.0
    for ev in events:
        t = ev.get("type")
        if t == "wallet_created":
            if _unlock(state, "wallet_created", defs_by_id, quiet=quiet): new += 1
        elif t == "wallet_decoded":
            if _unlock(state, "wallet_decoded", defs_by_id, quiet=quiet): new += 1
        elif t == "backtest_completed":
            backtest_count += 1
            sharpe = ev.get("sharpe", 0)
            if sharpe > max_sharpe:
                max_sharpe = sharpe
    if backtest_count >= 1 and _unlock(state, "first_backtest", defs_by_id, quiet=quiet): new += 1
    if max_sharpe >= 5 and _unlock(state, "sharpe_5", defs_by_id, quiet=quiet): new += 1
    if max_sharpe >= 20 and _unlock(state, "sharpe_20", defs_by_id, quiet=quiet): new += 1
    if backtest_count >= 10000 and _unlock(state, "ten_thousand_tests", defs_by_id, quiet=quiet): new += 1
    state["last_check"] = datetime.now(timezone.utc).isoformat()
    return new


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiet", action="store_true", help="don't print celebrations")
    ap.add_argument("--defs", default=str(DEFS_PATH), help="path to definitions.json")
    args = ap.parse_args()
    defs_path = Path(args.defs)
    if not defs_path.exists():
        print(f"definitions not found: {defs_path}", file=sys.stderr)
        return 1
    defs = json.load(open(defs_path))
    defs_by_id = {a["id"]: a for a in defs.get("achievements", [])}
    state = _load_state()
    events = _load_events()
    new = evaluate(events, state, defs_by_id, quiet=args.quiet)
    _save_state(state)
    if not args.quiet:
        print(f"  evaluated {len(events)} events, {new} new unlocks, "
              f"{len(state['unlocked'])} total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
