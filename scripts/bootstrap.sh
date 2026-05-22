#!/usr/bin/env bash
# PBX Stratos bootstrap (macOS/Linux). Ensures Node, then runs setup.mjs.
# No sudo. Everything lands under ./.tooling/.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
TOOLING="$ROOT/.tooling"
NODE_VERSION="v22.11.0"

have_node() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 18 ]
}

NODE_BIN=""
if have_node; then
  echo "[bootstrap] using existing Node $(node -v)"
  NODE_BIN="$(command -v node)"
elif [ -x "$TOOLING/node/bin/node" ]; then
  echo "[bootstrap] using bundled Node"
  NODE_BIN="$TOOLING/node/bin/node"
else
  OS="$(uname -s)"; ARCH="$(uname -m)"
  case "$OS" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) echo "[bootstrap] unsupported OS: $OS" >&2; exit 1 ;; esac
  case "$ARCH" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=x64 ;; *) echo "[bootstrap] unsupported arch: $ARCH" >&2; exit 1 ;; esac
  if [ "$OS" = linux ]; then EXT=tar.xz; else EXT=tar.gz; fi
  URL="https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$OS-$ARCH.$EXT"
  echo "[bootstrap] downloading Node from $URL"
  mkdir -p "$TOOLING"
  TARBALL="$TOOLING/node.$EXT"
  curl -fsSL "$URL" -o "$TARBALL" || { echo "[bootstrap] Node download failed — check your internet connection" >&2; exit 1; }
  tar -xf "$TARBALL" -C "$TOOLING"
  rm -f "$TARBALL"
  mv "$TOOLING"/node-"$NODE_VERSION"-* "$TOOLING/node"
  NODE_BIN="$TOOLING/node/bin/node"
  echo "[bootstrap] bundled Node $("$NODE_BIN" -v)"
fi

# Put the chosen Node's dir first on PATH so `npm` resolves consistently.
export PATH="$(dirname "$NODE_BIN"):$PATH"
exec "$NODE_BIN" "$ROOT/scripts/setup.mjs"
