#!/usr/bin/env bash
# PBX Stratos uninstaller (macOS / Linux).
#
# Reverses what install.sh / scripts/bootstrap.sh did:
#   - Stops + deletes the pm2 Stratos apps (exact-name only)
#   - Offers to remove .tooling/, .venv/, _context/, runtime/, global pm2
#
# Iron rule: never touches *-pbxtra or any sibling-install processes.
# Only acts on exact-name matches for bear-watch-server-stratos +
# paper-trade-bot-stratos.
#
# Run from the repo root:
#   bash uninstall.sh

set -u
cd "$(dirname "$0")"

echo ""
echo "PBX Stratos uninstaller"
echo "======================="
echo ""

# ─── 1. Stop + delete pm2 apps (exact name; never touch *-pbxtra) ───

if command -v pm2 >/dev/null 2>&1; then
  for app in bear-watch-server-stratos paper-trade-bot-stratos; do
    if pm2 jlist 2>/dev/null | grep -q "\"name\":\"$app\""; then
      echo "  Stopping $app..."
      pm2 stop "$app" >/dev/null 2>&1 || true
      pm2 delete "$app" >/dev/null 2>&1 || true
      echo "  Deleted $app from pm2"
    else
      echo "  $app — not registered, skipping"
    fi
  done
  pm2 save --force >/dev/null 2>&1 || true
else
  echo "  pm2 not installed — skipping pm2 cleanup"
fi

echo ""

# ─── 2. Optional cleanup (interactive) ─────────────────────────────

echo "Optional cleanup. Each prompt is yes/no:"
echo ""
echo "  .tooling/  — bundled Node + Python (safe to delete; re-downloads on next install)"
echo "  .venv/     — Python virtualenv (safe to delete)"
echo "  _context/  — your Claude session memory (safe to delete; harmless to keep)"
echo "  runtime/   — YOUR WALLET, paper trades, profile. Deleting loses your wallet permanently."
echo ""

ask_yn() {
  local prompt="$1"
  local ans
  read -r -p "$prompt [y/N] " ans
  [[ "$ans" =~ ^[Yy] ]]
}

if [ -d .tooling ] && ask_yn "Delete .tooling/ ?"; then
  rm -rf .tooling && echo "    removed .tooling/"
fi

if [ -d .venv ] && ask_yn "Delete .venv/ ?"; then
  rm -rf .venv && echo "    removed .venv/"
fi

if [ -d _context ] && ask_yn "Delete _context/ ?"; then
  rm -rf _context && echo "    removed _context/"
fi

echo ""
if [ -d runtime ]; then
  echo "About runtime/ — this contains your wallet keys (runtime/bots/local.env),"
  echo "paper trade history, achievements, and user profile."
  echo ""
  echo "DELETING IS PERMANENT. If you haven't backed up your 24-word BOT_HD_MNEMONIC"
  echo "on paper, your funds are unrecoverable after this."
  echo ""
  read -r -p "  Type 'DELETE WALLET' (exact, all caps) to confirm, anything else to keep: " ans
  if [ "$ans" = "DELETE WALLET" ]; then
    rm -rf runtime
    echo "    removed runtime/"
  else
    echo "    kept runtime/"
  fi
fi

echo ""
if command -v pm2 >/dev/null 2>&1 && ask_yn "Uninstall pm2 globally (npm uninstall -g pm2) ?"; then
  npm uninstall -g pm2 >/dev/null 2>&1 && echo "    uninstalled global pm2"
fi

echo ""
echo "Done. The repo folder itself is still here. Delete it manually if"
echo "you want it gone:  rm -rf \"$(pwd)\""
echo ""
