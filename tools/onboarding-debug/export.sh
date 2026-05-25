#!/usr/bin/env bash
# noob-loop only -- wrapper around export.py.
# Calls the bundled venv Python if available, else system python.

set -e

REPO="$(cd "$(dirname "$0")/../.." && pwd)"

# Prefer the bundled venv (created by install.ps1) over system python so
# we don't bump into the Windows Microsoft Store python.exe stub.
if [ -x "$REPO/.venv/Scripts/python.exe" ]; then
  PY="$REPO/.venv/Scripts/python.exe"
elif [ -x "$REPO/.venv/bin/python" ]; then
  PY="$REPO/.venv/bin/python"
elif [ -x "$REPO/.tooling/python/python.exe" ]; then
  PY="$REPO/.tooling/python/python.exe"
elif command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "no python interpreter found" >&2
  exit 1
fi

exec "$PY" "$REPO/tools/onboarding-debug/export.py" "$@"
