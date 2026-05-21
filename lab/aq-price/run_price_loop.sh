#!/bin/bash
# Sequential self-check loop for the AQ -> price modelling track.
#
# Runs one price experiment cycle at a time, regenerates the leaderboard,
# and checks itself: when the queue is exhausted it idles, waiting for new
# hypotheses to be appended to price_loop.py's QUEUE.
#
# Deliberately SEQUENTIAL and LOCAL: no parallel agents, no commits, no
# pushes, no PRs. Results (price_experiments.jsonl, PRICE_LEADERBOARD.md)
# are gitignored local state — this loop only writes those files.
#
# Start:  ./run_price_loop.sh        Stop: Ctrl-C (or `touch ~/.pbx-price-stop`)
cd "$(dirname "$0")" || exit 1
STOP="$HOME/.pbx-price-stop"

while true; do
  [ -f "$STOP" ] && { echo "stop flag set — exiting"; rm -f "$STOP"; exit 0; }

  out=$(python3 price_loop.py 2>&1 | grep -vE 'Warning|warn')
  echo "$out"
  python3 price_leaderboard.py 2>&1 | tail -1

  if echo "$out" | grep -q 'QUEUE EXHAUSTED'; then
    echo "  (queue exhausted — idling 300s; append new hypotheses to price_loop.py QUEUE)"
    sleep 300
  fi
done
