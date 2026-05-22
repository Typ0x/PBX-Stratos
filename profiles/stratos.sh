# PBX Stratos — environment profile (bash / zsh)
#
# Source this before running any pm2 / npm / dashboard command so
# the shell sees the self-contained runtime layout. After this is
# sourced, every stratos process resolves its data + config paths
# under <repo-root>/runtime/{lab,bots,config}/ instead of dotfiles
# under $HOME.
#
# Usage:
#   source ./profiles/stratos.sh        # source into current shell
#   pm2 start bear-watch/pm2.config.cjs
#   curl http://localhost:8787/health
#
# REPO_ROOT resolves dynamically from this script's path so the same
# file works on any user's machine — no hardcoded paths.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
export STRATOS_PROFILE='stratos'
export STRATOS_REPO_ROOT="$REPO_ROOT"
export STRATOS_BOTS_DATA_DIR="$REPO_ROOT/runtime/bots"
export STRATOS_BOTS_HOME="$REPO_ROOT/runtime/config"
export STRATOS_LAB_HOME="$REPO_ROOT/runtime/lab"
export PM2_HOME="$REPO_ROOT/runtime/pm2"
export PORT='8787'

echo "[STRATOS] Profile activated (PORT=8787)"
echo "          repo: $REPO_ROOT"
echo "          lab:  $STRATOS_LAB_HOME"
echo "          bots: $STRATOS_BOTS_DATA_DIR"
