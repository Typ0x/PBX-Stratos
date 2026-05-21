"""
HTTP client for the public PBX lab API (pbx-mainnet-api.onrender.com).

Replaces direct Postgres access in the decoder runners. With this module,
the runners need NO `DATABASE_URL` — just internet access. Each helper
returns parsed dicts with `datetime` timestamps so the runner code can
work with them just like it would with psycopg2 rows.

Optional override: set PBX_LAB_API_BASE to point at a local API server
(default: https://pbx-mainnet-api.onrender.com).
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Force UTF-8 on stdout/stderr. Runners print box-drawing characters in
# their banners; on a Windows console defaulting to cp1252 those raise
# UnicodeEncodeError. Importing this module fixes it for every runner
# that uses the shared API client.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except (AttributeError, ValueError, OSError):
        pass
from datetime import datetime
from typing import Any

DEFAULT_API_BASE = "https://pbx-mainnet-api.onrender.com"
DEFAULT_TIMEOUT = 60  # seconds — endpoint can return up to 200k rows
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_SEC = 2


def api_base() -> str:
    return os.environ.get("PBX_LAB_API_BASE", DEFAULT_API_BASE).rstrip("/")


def _fetch_json(path: str, params: dict[str, Any] | None = None) -> dict:
    """GET a JSON endpoint with bounded retry on transient failure."""
    qs = "?" + urllib.parse.urlencode(params) if params else ""
    url = f"{api_base()}{path}{qs}"
    last_err: Exception | None = None
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            req = urllib.request.Request(url, headers={"accept": "application/json"})
            with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            # 4xx errors don't get retries — input problem
            if 400 <= e.code < 500:
                body = e.read().decode("utf-8", errors="replace")[:500]
                raise RuntimeError(f"HTTP {e.code} from {path}: {body}") from e
            last_err = e
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
            last_err = e
        if attempt < RETRY_ATTEMPTS:
            sleep_for = RETRY_BACKOFF_SEC * attempt
            print(f"  ! API {path} attempt {attempt} failed ({last_err}); retrying in {sleep_for}s",
                  file=sys.stderr, flush=True)
            time.sleep(sleep_for)
    raise RuntimeError(f"API {path} failed after {RETRY_ATTEMPTS} attempts: {last_err}")


def _parse_ts(s: str) -> datetime:
    """Parse ISO 8601 timestamp from API JSON to a datetime."""
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


# ─── public helpers ──────────────────────────────────────────────────


def get_wallet_trades(pubkey: str, days: int = 30) -> list[dict]:
    """
    Per-wallet swap history.

    Returns a list of dicts with keys:
      - ts: datetime (block_time)
      - side: 'buy' | 'sell'
      - region_mint: str (Solana address)
      - region: str | None (NYC/CHI/TOR, may be None if unknown mint)
      - usdc_amount: float (already divided by 1e6)
      - signature: str

    Sorted ascending by ts.
    """
    data = _fetch_json("/api/lab/wallet-trades", {"pubkey": pubkey, "days": days})
    return [
        {
            "ts": _parse_ts(t["ts"]),
            "side": t["side"],
            "region_mint": t["region_mint"],
            "region": t.get("region"),
            "usdc_amount": float(t["usdc_amount"]),
            "signature": t["signature"],
        }
        for t in data.get("trades", [])
    ]


def get_vault_trades(days: int = 30) -> list[dict]:
    """
    Vault rebalance trades (VaultSwap rows from rebalance_trades).

    Returns dicts with keys:
      - ts: datetime
      - signature: str
      - token_in_mint: str
      - token_out_mint: str
      - amount_in: float (already divided by 1e6)
      - amount_out: float (already divided by 1e6)
      - pool_address: str | None
    """
    data = _fetch_json("/api/lab/trades", {"days": days})
    return [
        {
            "ts": _parse_ts(t["ts"]),
            "signature": t["signature"],
            "token_in_mint": t["token_in"],
            "token_out_mint": t["token_out"],
            "amount_in": float(t["amount_in"]),
            "amount_out": float(t["amount_out"]),
            "pool_address": t.get("pool_address"),
        }
        for t in data.get("trades", [])
    ]


def get_cycles(days: int = 30) -> list[dict]:
    """
    Rebalance cycles with sold/bought regions resolved.

    Returns dicts with keys:
      - ts: datetime
      - signature: str
      - n_trades: int
      - sold: str | None (NYC/CHI/TOR)
      - bought: str | None (NYC/CHI/TOR)
      - sold_usdc: float
      - bought_usdc: float
    """
    data = _fetch_json("/api/lab/cycles", {"days": days})
    return [
        {
            "ts": _parse_ts(c["ts"]),
            "signature": c["signature"],
            "n_trades": int(c.get("n_trades", 0)),
            "sold": c.get("sold"),
            "bought": c.get("bought"),
            "sold_usdc": float(c.get("sold_usdc", 0)),
            "bought_usdc": float(c.get("bought_usdc", 0)),
        }
        for c in data.get("cycles", [])
    ]


def get_all_user_trades(days: int = 30) -> list[dict]:
    """
    All-wallet swap history (capped at 30d server-side regardless of param).

    Returns dicts with same shape as get_wallet_trades plus a 'wallet' key.
    Use sparingly — response can be several MB.
    """
    data = _fetch_json("/api/lab/user-trades", {"days": days})
    return [
        {
            "ts": _parse_ts(t["ts"]),
            "wallet": t["wallet"],
            "side": t["side"],
            "region_mint": t["region_mint"],
            "region": t.get("region"),
            "usdc_amount": float(t["usdc_amount"]),
            "signature": t["signature"],
        }
        for t in data.get("trades", [])
    ]
