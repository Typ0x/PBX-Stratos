#!/usr/bin/env bash
# One-shot launcher for the bot portfolio.
# Idempotent: re-running after partial failure picks up where you left off.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PBX="$SCRIPT_DIR/pbx-bots.sh"

run() {
  echo ">>> $*"
  "$@" || true   # tolerate "already exists / running" errors and keep going
  echo
}

# spec format: "bot-name:strategy[:usdcCap:tickMs]"
#   usdcCap and tickMs are optional; default to the conservative pm25 values.
#   spread_revert needs a higher cap so its spread-depth sizing
#   ($100/$200/$400 at -4/-6/-8% spread) isn't clamped server-side.
SPECS=(
  "arb-band:pm25_band:8:60000"
  "arb-allin:pm25_all_in:8:60000"
  "arb-zscore:pm25_zscore:8:60000"
  "arb-spread:spread_revert:400:15000"
)

DEFAULT_USDC=8
DEFAULT_TICK=60000

for spec in "${SPECS[@]}"; do
  IFS=':' read -r name strat usdc_cap tick_ms <<<"$spec"
  usdc_cap="${usdc_cap:-$DEFAULT_USDC}"
  tick_ms="${tick_ms:-$DEFAULT_TICK}"
  echo "==================================================="
  echo "  $name  ($strat)  cap=\$$usdc_cap  tick=${tick_ms}ms"
  echo "==================================================="
  run "$PBX" remote new "$name"
  run "$PBX" remote strategy "$name" "$strat" --usdc "$usdc_cap" --tick-ms "$tick_ms"
  run "$PBX" remote fund "$name" --usdc 10 --sol 0.05
  run "$PBX" remote launch "$name"
done

echo "==================================================="
echo "  Final state"
echo "==================================================="
"$PBX" remote list
