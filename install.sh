#!/usr/bin/env bash
# PBX Stratos -- one-shot installer (macOS / Linux)
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/Typ0x/PBX-Stratos/main/install.sh | bash
# Or after cloning the repo:
#   bash install.sh
#
# What it does, in order:
#   1. Verify host: Python >= 3.10, git, Node >= 18
#   2. Clone the repo to ~/PBX-Stratos (or pull latest if already present)
#   3. npm install at repo root (workspaces pull in bots/ + packages/*)
#   4. Python venv at .venv + pip install -e ".[decoder]"
#   5. Install pm2 globally if missing
#   6. pm2 start bear-watch/pm2.config.cjs + pm2 save
#   7. Write .tooling/ready.json install marker
#   8. Poll /health for up to 20s, then open dashboard in default browser
#
# Idempotent -- safe to re-run; every step skips work already done.
#
# NOT included on Mac/Linux (Windows-only feature for now):
#   - The 6 STRATOS-* scheduled tasks (HealthCheck / WeatherPull / etc.)
#     On Windows these install via schtasks; cross-platform cron equivalents
#     are a planned follow-up. Until then, on Unix the pm2 fleet handles
#     the always-on parts; periodic health checks can be added via crontab
#     manually (see bear-watch/cron-examples.txt -- planned).
#
# Windows users: this script refuses to run under MINGW/MSYS/CYGWIN.
# Use install.bat (which invokes install.ps1) instead.

set -euo pipefail

REPO_URL="${PBX_STRATOS_REPO:-https://github.com/Typ0x/PBX-Stratos.git}"
INSTALL_DIR="${PBX_STRATOS_HOME:-$HOME/PBX-Stratos}"

# ---- helpers -----------------------------------------------------------
BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
log()  { printf "  %s\n" "$*"; }
info() { printf "  ${CYAN}*${RESET} %s\n" "$*"; }
ok()   { printf "  ${GREEN}OK${RESET} %s\n" "$*"; }
warn() { printf "  ${YELLOW}!${RESET} %s\n" "$*"; }
err()  { printf "  ${RED}X${RESET} %s\n" "$*" >&2; }
step() {
  printf "\n  ${BOLD}${CYAN}[%s/8] %s${RESET}\n" "$1" "$2"
  printf "  ${DIM}%s${RESET}\n" "$(printf -- '-%.0s' $(seq 1 40))"
}

# ---- preflight ---------------------------------------------------------
printf "\n  ${BOLD}${CYAN}PBX Stratos installer${RESET}\n"

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ok "host: $OS" ;;
  MINGW*|MSYS*|CYGWIN*)
    err "This bash installer doesn't run on native Windows / Git Bash."
    info "Windows users: double-click install.bat (or run install.ps1)."
    info "WSL2 also works if you prefer Linux: https://learn.microsoft.com/en-us/windows/wsl/install"
    exit 1
    ;;
  *) warn "unrecognized OS: $OS -- proceeding, but YMMV" ;;
esac

# ---- step 1: Python >= 3.10 -------------------------------------------
step 1 "Verifying Python >= 3.10"
if ! command -v python3 >/dev/null 2>&1; then
  err "python3 not found."
  case "$OS" in
    Darwin) info "install: brew install python@3.12" ;;
    Linux)  info "install: sudo apt-get install python3.12 python3.12-venv (Ubuntu/Debian) or sudo dnf install python3.12 (Fedora)" ;;
  esac
  exit 1
fi
PY_VERSION="$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
PY_MAJOR="${PY_VERSION%.*}"; PY_MINOR="${PY_VERSION#*.}"
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
  # Probe for newer python interpreters in PATH before failing
  for CAND in python3.16 python3.15 python3.14 python3.13 python3.12 python3.11 python3.10; do
    if command -v "$CAND" >/dev/null 2>&1; then
      CAND_BIN="$(command -v "$CAND")"
      CAND_DIR="$(dirname "$CAND_BIN")"
      export PATH="$CAND_DIR:$PATH"
      PY_VERSION="$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null || echo "$PY_VERSION")"
      ok "using $CAND (python3 $PY_VERSION)"
      break
    fi
  done
  PY_MAJOR="${PY_VERSION%.*}"; PY_MINOR="${PY_VERSION#*.}"
  if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
    err "python3 $PY_VERSION found; need >= 3.10"
    case "$OS" in
      Darwin) info "Easiest fix: brew install python@3.12, then re-run this installer" ;;
      Linux)  info "Try: sudo apt-get install python3.12 python3.12-venv  OR  curl https://pyenv.run | bash && pyenv install 3.12 && pyenv local 3.12" ;;
    esac
    exit 1
  fi
fi
ok "python3 $PY_VERSION"

# git check
if ! command -v git >/dev/null 2>&1; then
  err "git not found. Install git first (e.g. brew install git, apt-get install git)."
  exit 1
fi
ok "git $(git --version | awk '{print $3}')"

# Node check (warn for now; npm install step below will fail loudly if missing)
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -lt 18 ]; then
    err "node $(node -v 2>/dev/null) found; need Node >= 18"
    info "Install via nvm: https://github.com/nvm-sh/nvm  OR  brew install node@20"
    exit 1
  fi
  ok "node $(node -v)"
else
  err "node not found. Install Node >= 18 first."
  info "Mac: brew install node@20  |  Linux: nvm install --lts  |  https://nodejs.org"
  exit 1
fi

# Optional: solana-keygen (informational only -- the bot has its own HD derivation)
if command -v solana-keygen >/dev/null 2>&1; then
  ok "solana-keygen found (optional, not required -- bot uses bip39 + ed25519-hd-key directly)"
fi

# ---- step 2: clone or pull --------------------------------------------
step 2 "Cloning the repo (or pulling latest)"
if [ -d "$INSTALL_DIR/.git" ]; then
  ok "existing install at $INSTALL_DIR -- pulling latest"
  git -C "$INSTALL_DIR" pull --ff-only
else
  if [ -e "$INSTALL_DIR" ]; then
    err "$INSTALL_DIR exists but isn't a git repo. Move it or set PBX_STRATOS_HOME."
    exit 1
  fi
  info "cloning $REPO_URL -> $INSTALL_DIR"
  git clone --depth=1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ---- step 3: npm install ----------------------------------------------
step 3 "Installing Node dependencies (workspaces: bots + packages)"
if [ -d "node_modules" ]; then
  ok "node_modules/ already present -- npm install will be a fast no-op if up to date"
fi
npm install --no-audit --no-fund --loglevel=error
ok "node_modules ready"

# ---- step 4: Python venv + decoder deps -------------------------------
step 4 "Setting up Python venv + decoder deps"
if [ ! -d ".venv" ]; then
  info "creating virtualenv at .venv"
  python3 -m venv .venv
else
  ok ".venv already exists"
fi
.venv/bin/python -m pip install --quiet --upgrade pip
if ! .venv/bin/python -m pip install --quiet -e ".[decoder]" 2>/dev/null; then
  warn "editable install with [decoder] failed; trying plain decoder deps install"
  .venv/bin/python -m pip install --quiet scikit-learn numpy || {
    warn "decoder dep install failed -- decode/backtest workflows won't run; dashboard still works"
  }
fi
ok "Python venv ready"

# ---- step 5: pm2 (global) ---------------------------------------------
step 5 "Installing pm2 process supervisor (if missing)"
if ! command -v pm2 >/dev/null 2>&1; then
  info "pm2 not found -- installing globally via npm"
  npm install -g pm2 || {
    err "npm install -g pm2 failed. Try with sudo, or use a Node version manager (nvm) that doesn't require sudo for globals."
    exit 1
  }
  ok "pm2 installed globally"
else
  ok "pm2 already present at $(command -v pm2)"
fi

# ---- step 6: pm2 start fleet ------------------------------------------
step 6 "Starting the bear-watch fleet via pm2"
if pm2 start bear-watch/pm2.config.cjs --update-env; then
  pm2 save || warn "pm2 save returned non-zero (may be fine -- list saved when daemon next restarts)"
  ok "pm2 fleet started + saved"
else
  warn "pm2 start exited non-zero. The fleet may already be running -- run 'pm2 list' to check."
fi

# ---- step 7: ready.json marker ----------------------------------------
step 7 "Writing install marker"
mkdir -p .tooling
PYTHON_PATH="$INSTALL_DIR/.venv/bin/python"
NODE_ARCH="$(node -p 'process.arch' 2>/dev/null || uname -m)"
cat > .tooling/ready.json <<EOF
{
  "ready": true,
  "python": "$PYTHON_PATH",
  "platform": "$(uname -s | tr '[:upper:]' '[:lower:]')",
  "arch": "$NODE_ARCH",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "installer_version": "1.0"
}
EOF
ok "marker: .tooling/ready.json"

# Symlink ./pbx into ~/.local/bin if that dir exists and is on PATH
LOCAL_BIN="$HOME/.local/bin"
if [ -d "$LOCAL_BIN" ] && case ":$PATH:" in *":$LOCAL_BIN:"*) true ;; *) false ;; esac; then
  ln -sf "$INSTALL_DIR/pbx" "$LOCAL_BIN/pbx"
  ok "linked $LOCAL_BIN/pbx -> $INSTALL_DIR/pbx (in PATH)"
else
  info "$LOCAL_BIN not in PATH. Run the CLI via: $INSTALL_DIR/pbx"
fi

# ---- step 8: auto-open dashboard --------------------------------------
step 8 "Waiting for /health then opening the dashboard"
# /dashboard/fresh (vs /dashboard) clears localStorage and force-fires
# the 10-step onboarding overlay even if a previous browser session
# set the "tour-done" flag. Critical for first-install UX.
DASHBOARD_URL="http://localhost:8787/dashboard/fresh"
MAX_WAIT=20
ELAPSED=0
while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
  if curl -fsS -m 2 "$DASHBOARD_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done
if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
  warn "Server didn't reach /health within ${MAX_WAIT}s. Opening browser anyway -- it may need another moment."
fi

# Cross-platform open
case "$OS" in
  Darwin) open "$DASHBOARD_URL" >/dev/null 2>&1 || warn "open failed; browse to $DASHBOARD_URL manually" ;;
  Linux)
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$DASHBOARD_URL" >/dev/null 2>&1 || warn "xdg-open failed; browse to $DASHBOARD_URL manually"
    else
      info "No xdg-open available -- browse to $DASHBOARD_URL manually."
    fi
    ;;
esac

printf "\n  ${BOLD}${GREEN}PBX Stratos installed successfully${RESET}\n"
printf "  ${DIM}%s${RESET}\n\n" "$(printf -- '-%.0s' $(seq 1 40))"
printf "  Dashboard:  ${BOLD}%s${RESET}\n" "$DASHBOARD_URL"
printf "\n  Verify with:\n"
printf "    ${DIM}pm2 list${RESET}\n"
printf "    ${DIM}curl %s/health${RESET}\n\n" "$DASHBOARD_URL"
printf "  Personality + theme picks (interactive):\n"
printf "    Tell Claude  ${BOLD}\"set up PBX Stratos\"${RESET}  or  ${BOLD}\"run the personality quiz\"${RESET}\n\n"
