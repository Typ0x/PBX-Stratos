#!/usr/bin/env bash
# pbx-trader-lab installer  (macOS / Linux)
# Usage:
#   curl -sSL https://raw.githubusercontent.com/polar-bear-express/pbx-trader-lab/main/install.sh | sh
# Or:
#   git clone <repo> && ./install.sh
#
# Auto-opens the dashboard in the user's default browser when done.
# Windows users: see install.bat / install.ps1 instead.

set -euo pipefail

REPO_URL="${PBX_TRADER_LAB_REPO:-https://github.com/polar-bear-express/pbx-trader-lab.git}"
INSTALL_DIR="${PBX_TRADER_LAB_HOME:-$HOME/pbx-trader-lab}"

# ─── helpers ──────────────────────────────────────────────────────────
BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
log()  { printf "  %s\n" "$*"; }
info() { printf "  ${CYAN}•${RESET} %s\n" "$*"; }
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
warn() { printf "  ${YELLOW}!${RESET} %s\n" "$*"; }
err()  { printf "  ${RED}✗${RESET} %s\n" "$*" >&2; }
banner() {
  printf "\n  ${BOLD}${CYAN}%s${RESET}\n" "$*"
  printf "  ${DIM}%s${RESET}\n" "$(printf '─%.0s' $(seq 1 40))"
}

# ─── preflight ────────────────────────────────────────────────────────
banner "PBX Trader Lab installer"

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ok "detected: $OS" ;;
  MINGW*|MSYS*|CYGWIN*)
    err "This bash installer doesn't run on native Windows / Git Bash."
    info "Windows users: run the PowerShell installer instead —"
    info "  powershell -ExecutionPolicy Bypass -File setup.ps1"
    info "That sets up the offline backtesting workbench. The live bot"
    info "fleet (bots/) additionally needs Node.js >= 18."
    info "WSL2 also works if you prefer Linux: https://learn.microsoft.com/en-us/windows/wsl/install"
    info "Docs: https://pbx.earth/docs"
    exit 1
    ;;
  *) warn "unrecognized OS: $OS — proceeding, but YMMV" ;;
esac

# Python check
if ! command -v python3 >/dev/null 2>&1; then
  err "python3 not found."
  case "$OS" in
    Darwin) info "install: brew install python3" ;;
    Linux)  info "install: apt-get install python3 OR dnf install python3" ;;
  esac
  exit 1
fi
PY_VERSION="$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
PY_MAJOR="${PY_VERSION%.*}"; PY_MINOR="${PY_VERSION#*.}"
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
  # Probe for newer python interpreters in PATH before failing
  for CAND in python3.16 python3.15 python3.14 python3.13 python3.12 python3.11 python3.10; do
    if command -v "$CAND" >/dev/null 2>&1; then
      ok "python3 $PY_VERSION too old, using $CAND instead"
      # Re-alias by exporting an override; the rest of the script uses python3
      alias python3="$CAND" 2>/dev/null || true
      # Prefer pointing $PATH at the binary's location so subsequent invocations pick it up.
      CAND_BIN="$(command -v "$CAND")"
      CAND_DIR="$(dirname "$CAND_BIN")"
      export PATH="$CAND_DIR:$PATH"
      # Refresh version detection
      PY_VERSION="$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null || echo "$PY_VERSION")"
      break
    fi
  done
  PY_MAJOR="${PY_VERSION%.*}"; PY_MINOR="${PY_VERSION#*.}"
  if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
    err "python3 $PY_VERSION found; need >= 3.10"
    echo
    case "$OS" in
      Darwin)
        info "Easiest fix (Homebrew): brew install python@3.12"
        info "Then re-run this installer."
        info "If you don't have Homebrew: https://brew.sh"
        ;;
      Linux)
        info "Try one of:"
        info "  Ubuntu/Debian: sudo apt-get install python3.12 python3.12-venv"
        info "  Fedora:        sudo dnf install python3.12"
        info "  Or pyenv:      curl https://pyenv.run | bash && pyenv install 3.12 && pyenv local 3.12"
        ;;
    esac
    info "After installing, re-run: ./install.sh"
    info "Stuck? See https://pbx.earth/docs"
    exit 1
  fi
fi
ok "python3 $PY_VERSION"

# git check
if ! command -v git >/dev/null 2>&1; then
  err "git not found. Install git first."
  exit 1
fi
ok "git $(git --version | awk '{print $3}')"

# Optional: solana-keygen
if command -v solana-keygen >/dev/null 2>&1; then
  ok "solana-keygen found (wallet generation enabled)"
else
  warn "solana-keygen not installed. You can install later for wallet features:"
  warn "  sh -c \"\$(curl -sSfL https://release.solana.com/stable/install)\""
fi

# ─── clone ────────────────────────────────────────────────────────────
banner "Cloning repo"
if [ -d "$INSTALL_DIR/.git" ]; then
  ok "existing install at $INSTALL_DIR — pulling latest"
  git -C "$INSTALL_DIR" pull --ff-only
else
  if [ -e "$INSTALL_DIR" ]; then
    err "$INSTALL_DIR exists but isn't a git repo. Move it or set PBX_TRADER_LAB_HOME."
    exit 1
  fi
  info "cloning $REPO_URL → $INSTALL_DIR"
  git clone --depth=1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ─── install ──────────────────────────────────────────────────────────
banner "Setting up Python environment"
# Create a project virtualenv and install the decoder deps (scikit-learn,
# numpy) into it. The bots dashboard resolves this .venv to run the
# Python decoders, so the deps must live here — a plain --user install
# isn't visible to the venv-scoped interpreter the server spawns.
if [ -f "pyproject.toml" ]; then
  if [ ! -d ".venv" ]; then
    info "creating virtualenv at .venv"
    python3 -m venv .venv
  else
    ok ".venv already exists"
  fi
  info "installing pbx-trader-lab + decoder deps (scikit-learn, numpy)"
  .venv/bin/python -m pip install --quiet --upgrade pip
  if ! .venv/bin/python -m pip install --quiet -e ".[decoder]" 2>/dev/null; then
    warn "editable install failed; installing decoder deps directly"
    .venv/bin/python -m pip install --quiet scikit-learn numpy || {
      warn "decoder dep install failed — the decode/backtest workflow won't run"
    }
  fi
  ok "Python environment ready"
fi

# ─── dashboard (Node) ─────────────────────────────────────────────────
# The Python venv above runs the CLI + decoders. The dashboard — the
# fastest path to something useful — lives in bots/ and needs Node.
# Set it up here too so one installer leaves nothing half-done.
banner "Setting up dashboard (bots/)"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -lt 18 ]; then
    warn "node $(node -v 2>/dev/null) found; the dashboard needs Node >= 18 — skipping."
    warn "Upgrade Node, then run: npm install   (the Python workbench works without it)"
  else
    ok "node $(node -v)"
    info "installing dashboard deps (npm install)"
    if npm install --no-audit --no-fund --loglevel=error; then
      ok "dashboard ready — start it with: npm run server"
    else
      warn "npm install failed — fix the error above, then re-run: npm install"
    fi
  fi
else
  warn "node not found — skipping the dashboard (bots/)."
  warn "The Python backtesting workbench above is fully set up and works without it."
  warn "For the dashboard later: install Node >= 18 (https://nodejs.org), then 'npm install'"
fi

# Try to symlink ./pbx into ~/.local/bin if it exists and is on PATH
LOCAL_BIN="$HOME/.local/bin"
if [ -d "$LOCAL_BIN" ] && case ":$PATH:" in *":$LOCAL_BIN:"*) true ;; *) false ;; esac; then
  ln -sf "$INSTALL_DIR/pbx" "$LOCAL_BIN/pbx"
  ok "linked $LOCAL_BIN/pbx → $INSTALL_DIR/pbx (in PATH)"
else
  warn "$LOCAL_BIN not in PATH. Run via: $INSTALL_DIR/pbx"
fi

# ─── onboard ──────────────────────────────────────────────────────────
banner "Starting onboarding wizard"
exec "$INSTALL_DIR/pbx"
