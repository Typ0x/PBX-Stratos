#!/usr/bin/env bash
# CWD-agnostic wrapper for pbx-bots.ts. Add an alias to your shell config:
#   alias pbx-bots="$HOME/PBX-Stratos/bear-watch/code/scripts/pbx-bots.sh"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# bear-watch/code/scripts/ → up 3 = repo root.
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd -P)"
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"

if [[ ! -x "$TSX_BIN" ]]; then
  echo "error: tsx not found at $TSX_BIN — run 'npm install' at $REPO_ROOT" >&2
  exit 1
fi

# Suppress noisy DEP0040 (punycode) warning emitted by transitive deps
# (@solana/web3.js@1.x → node-fetch@2 → whatwg-url@5 → tr46@0.0.3). The
# real fix requires migrating to @solana/web3.js@2.x / @solana/kit;
# until then this just hides the cosmetic warning.
export NODE_OPTIONS="--no-deprecation${NODE_OPTIONS:+ $NODE_OPTIONS}"
exec "$TSX_BIN" "$SCRIPT_DIR/pbx-bots.ts" "$@"
