#!/usr/bin/env bash
# noob-loop only -- onboarding step logger.
# Appends one JSON line to runtime/lab/install-session.jsonl.
#
# Usage:
#   bash tools/onboarding-debug/log.sh <step> <event> "<message>"
#
# Example:
#   bash tools/onboarding-debug/log.sh step1 install_launched ""
#   bash tools/onboarding-debug/log.sh step3 install_completed "exit=0 duration=187s"

set -e

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$REPO/runtime/lab/logs"
LOG_FILE="$LOG_DIR/install-session.jsonl"

mkdir -p "$LOG_DIR"

STEP="${1:-unknown}"
EVENT="${2:-unknown}"
MESSAGE="${3:-}"

# ISO-8601 timestamp with milliseconds, UTC.
TS="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"

# Escape backslashes + quotes for JSON.
escape_json() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

ESC_STEP="$(escape_json "$STEP")"
ESC_EVENT="$(escape_json "$EVENT")"
ESC_MESSAGE="$(escape_json "$MESSAGE")"

# Append the JSON line. Use >> so concurrent calls don't clobber.
printf '{"ts":"%s","step":"%s","event":"%s","message":"%s"}\n' \
  "$TS" "$ESC_STEP" "$ESC_EVENT" "$ESC_MESSAGE" >> "$LOG_FILE"

# Echo nothing on success so Claude's narration stays clean.
exit 0
