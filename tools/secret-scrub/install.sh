#!/usr/bin/env bash
# Install (or uninstall) the secret-scrub pre-commit hook for THIS repo
# only. Never edits a machine-global hooks setup.
#   ./tools/secret-scrub/install.sh            install
#   ./tools/secret-scrub/install.sh uninstall  remove
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
HOOKS_PATH="$(git config core.hooksPath || echo '')"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  • %s\n' "$*"; }

# Case A iff a global hooks dir is set whose pre-commit delegates to a
# per-repo pre-commit-local. Otherwise Case B.
is_case_a() {
  [ -n "$HOOKS_PATH" ] || return 1
  [ -f "$HOOKS_PATH/pre-commit" ] || return 1
  grep -q 'pre-commit-local' "$HOOKS_PATH/pre-commit"
}

install() {
  if is_case_a; then
    cp tools/secret-scrub/githooks/pre-commit .git/hooks/pre-commit-local
    chmod +x .git/hooks/pre-commit-local
    ok "installed as .git/hooks/pre-commit-local (delegated by your global hook)"
  else
    git config core.hooksPath tools/secret-scrub/githooks
    ok "set this repo's core.hooksPath → tools/secret-scrub/githooks"
  fi
  info "secret-scrub guards commits in THIS repo only."
}

uninstall() {
  if [ -f .git/hooks/pre-commit-local ] && \
     grep -q secret-scrub .git/hooks/pre-commit-local 2>/dev/null; then
    rm -f .git/hooks/pre-commit-local
    ok "removed .git/hooks/pre-commit-local"
  fi
  if [ "$(git config core.hooksPath || echo '')" = 'tools/secret-scrub/githooks' ]; then
    git config --unset core.hooksPath
    ok "unset this repo's core.hooksPath"
  fi
}

case "${1:-install}" in
  install)   install ;;
  uninstall) uninstall ;;
  *) echo "usage: $0 [install|uninstall]" >&2; exit 1 ;;
esac
