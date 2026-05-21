"""Tests for install.sh — runs in hermetic temp git repos."""
from __future__ import annotations

import os
import subprocess
import stat
from pathlib import Path

INSTALL_SH = Path(__file__).parent / 'install.sh'
TOOLS_DIR = Path(__file__).parent.parent  # tools/


def _make_env(extra: dict) -> dict:
    """Base env with HOME kept, plus overrides."""
    env = {k: v for k, v in os.environ.items()}
    env.update(extra)
    return env


def _git(repo: Path, *args: str, env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        ['git', '-C', str(repo), *args],
        capture_output=True, text=True, env=env,
    )


def _new_repo(tmp_path: Path, env: dict) -> Path:
    repo = tmp_path / 'repo'
    repo.mkdir()
    _git(repo, 'init', '-q', env=env)
    _git(repo, 'config', 'user.email', 't@t', env=env)
    _git(repo, 'config', 'user.name', 't', env=env)
    # Symlink tools dir so install.sh can find tools/secret-scrub/githooks
    (repo / 'tools').symlink_to(TOOLS_DIR)
    return repo


def _run_install(repo: Path, *args: str, env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        ['bash', str(INSTALL_SH), *args],
        cwd=str(repo), capture_output=True, text=True, env=env,
    )


# ---------------------------------------------------------------------------
# Case B: no global core.hooksPath → install.sh sets core.hooksPath
# ---------------------------------------------------------------------------

def test_case_b_install_sets_hooks_path(tmp_path):
    empty_cfg = tmp_path / 'empty_gitconfig'
    empty_cfg.write_text('')
    env = _make_env({'GIT_CONFIG_GLOBAL': str(empty_cfg)})

    repo = _new_repo(tmp_path, env=env)
    r = _run_install(repo, env=env)
    assert r.returncode == 0, r.stderr

    hooks_path = _git(repo, 'config', 'core.hooksPath', env=env).stdout.strip()
    assert hooks_path == 'tools/secret-scrub/githooks', (
        f'Expected tools/secret-scrub/githooks, got {hooks_path!r}'
    )


def test_case_b_uninstall_unsets_hooks_path(tmp_path):
    empty_cfg = tmp_path / 'empty_gitconfig'
    empty_cfg.write_text('')
    env = _make_env({'GIT_CONFIG_GLOBAL': str(empty_cfg)})

    repo = _new_repo(tmp_path, env=env)
    _run_install(repo, env=env)

    r = _run_install(repo, 'uninstall', env=env)
    assert r.returncode == 0, r.stderr

    result = _git(repo, 'config', 'core.hooksPath', env=env)
    # git config returns exit 1 when the key is absent
    assert result.returncode != 0 or result.stdout.strip() == '', (
        f'core.hooksPath should be unset, got {result.stdout.strip()!r}'
    )


# ---------------------------------------------------------------------------
# Case A: global hooks dir has a pre-commit that delegates to pre-commit-local
# ---------------------------------------------------------------------------

def test_case_a_install_creates_pre_commit_local(tmp_path):
    # Build a fake global hooks dir
    global_hooks = tmp_path / 'global_hooks'
    global_hooks.mkdir()
    pre_commit = global_hooks / 'pre-commit'
    pre_commit.write_text('#!/bin/sh\n. "$(git rev-parse --show-toplevel)/.git/hooks/pre-commit-local"\n')
    pre_commit.chmod(pre_commit.stat().st_mode | stat.S_IEXEC)

    # Write a global git config that points core.hooksPath at our fake dir
    global_cfg = tmp_path / 'gitconfig'
    global_cfg.write_text(f'[core]\n\thooksPath = {global_hooks}\n')

    env = _make_env({'GIT_CONFIG_GLOBAL': str(global_cfg)})

    repo = _new_repo(tmp_path, env=env)
    r = _run_install(repo, env=env)
    assert r.returncode == 0, r.stderr

    pclf = repo / '.git' / 'hooks' / 'pre-commit-local'
    assert pclf.exists(), '.git/hooks/pre-commit-local should exist after Case A install'
    assert pclf.stat().st_mode & stat.S_IEXEC, 'pre-commit-local should be executable'


def test_case_a_uninstall_removes_pre_commit_local(tmp_path):
    global_hooks = tmp_path / 'global_hooks'
    global_hooks.mkdir()
    pre_commit = global_hooks / 'pre-commit'
    pre_commit.write_text('#!/bin/sh\n. "$(git rev-parse --show-toplevel)/.git/hooks/pre-commit-local"\n')
    pre_commit.chmod(pre_commit.stat().st_mode | stat.S_IEXEC)

    global_cfg = tmp_path / 'gitconfig'
    global_cfg.write_text(f'[core]\n\thooksPath = {global_hooks}\n')

    env = _make_env({'GIT_CONFIG_GLOBAL': str(global_cfg)})

    repo = _new_repo(tmp_path, env=env)
    _run_install(repo, env=env)

    r = _run_install(repo, 'uninstall', env=env)
    assert r.returncode == 0, r.stderr

    pclf = repo / '.git' / 'hooks' / 'pre-commit-local'
    assert not pclf.exists(), '.git/hooks/pre-commit-local should be removed after uninstall'


# ---------------------------------------------------------------------------
# Idempotency: running install.sh twice succeeds both times
# ---------------------------------------------------------------------------

def test_idempotency_case_b(tmp_path):
    empty_cfg = tmp_path / 'empty_gitconfig'
    empty_cfg.write_text('')
    env = _make_env({'GIT_CONFIG_GLOBAL': str(empty_cfg)})

    repo = _new_repo(tmp_path, env=env)
    r1 = _run_install(repo, env=env)
    assert r1.returncode == 0, r1.stderr
    r2 = _run_install(repo, env=env)
    assert r2.returncode == 0, r2.stderr


def test_idempotency_case_a(tmp_path):
    global_hooks = tmp_path / 'global_hooks'
    global_hooks.mkdir()
    pre_commit = global_hooks / 'pre-commit'
    pre_commit.write_text('#!/bin/sh\n. "$(git rev-parse --show-toplevel)/.git/hooks/pre-commit-local"\n')
    pre_commit.chmod(pre_commit.stat().st_mode | stat.S_IEXEC)

    global_cfg = tmp_path / 'gitconfig'
    global_cfg.write_text(f'[core]\n\thooksPath = {global_hooks}\n')

    env = _make_env({'GIT_CONFIG_GLOBAL': str(global_cfg)})

    repo = _new_repo(tmp_path, env=env)
    r1 = _run_install(repo, env=env)
    assert r1.returncode == 0, r1.stderr
    r2 = _run_install(repo, env=env)
    assert r2.returncode == 0, r2.stderr
