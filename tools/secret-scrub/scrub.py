#!/usr/bin/env python3
"""secret-scrub — keep secrets out of commits and Claude sessions.

  scrub.py --staged     pre-commit: scrub secrets from staged files
  scrub.py --sessions   redact secrets in ~/.claude session transcripts

Exit codes (--staged): 0 = clean or scrubbed clean; 1 = a secret remains.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from detect import find_secrets, is_whole_file_secret  # noqa: E402

REDACTION = '[REDACTED]'


def _git(*args: str) -> str:
    r = subprocess.run(['git', *args], capture_output=True, text=True)
    if r.returncode != 0 and r.stderr.strip():
        print(f'secret-scrub: git {args[0]} failed: {r.stderr.strip()}',
              file=sys.stderr)
    return r.stdout


def _staged_files() -> list[str]:
    out = _git('diff', '--cached', '--name-only', '--diff-filter=ACM')
    return [line for line in out.splitlines() if line]


def _staged_content(rel: str) -> str | None:
    """Staged (index) content of `rel`, or None if binary/unreadable."""
    r = subprocess.run(['git', 'show', f':{rel}'], capture_output=True)
    if r.returncode != 0:
        return None
    try:
        return r.stdout.decode('utf-8')
    except UnicodeDecodeError:
        return None  # binary


def _is_text(path: Path) -> bool:
    try:
        path.read_text(encoding='utf-8')
        return True
    except (UnicodeDecodeError, OSError):
        return False


def _redact(text: str, findings) -> str:
    """Replace each finding span with REDACTION, last-to-first."""
    for f in sorted(findings, key=lambda x: x.start, reverse=True):
        text = text[:f.start] + REDACTION + text[f.end:]
    return text


def _ensure_gitignored(path: str) -> None:
    gi = Path('.gitignore')
    lines = gi.read_text().splitlines() if gi.exists() else []
    if path not in lines:
        with gi.open('a') as fh:
            fh.write(('' if not lines or lines[-1] == '' else '\n') + path + '\n')
        _git('add', '.gitignore')


def scrub_staged() -> int:
    caught: list[str] = []
    private_key_hit = False
    residual = False

    for rel in _staged_files():
        path = Path(rel)
        text = _staged_content(rel)
        if text is None:
            continue
        findings = find_secrets(text, rel)
        if not findings:
            continue

        if is_whole_file_secret(text, rel):
            _git('rm', '--cached', '--quiet', rel)
            _ensure_gitignored(rel)
            caught.append(f'  unstaged + gitignored: {rel} (whole-file secret)')
            if any(f.is_private_key for f in findings):
                private_key_hit = True
            # File is no longer staged — nothing residual to worry about.
        else:
            redacted = _redact(text, findings)
            path.write_text(redacted, encoding='utf-8')
            _git('add', rel)
            if any(f.is_private_key for f in findings):
                private_key_hit = True
            # Re-scan staged content to confirm redaction was complete.
            after = _staged_content(rel)
            if after is not None and find_secrets(after, rel):
                caught.append(f'  ⚠ redaction INCOMPLETE in: {rel} — residual secret remains')
                residual = True
            else:
                caught.append(f'  redacted {len(findings)} secret(s) in: {rel}')

    if caught:
        print('🔒 secret-scrub caught secrets before commit:', file=sys.stderr)
        for line in caught:
            print(line, file=sys.stderr)
        print('   Please do not commit secrets — paste them into a password '
              'manager, not the repo.', file=sys.stderr)
        if private_key_hit:
            print('   ⚠ A PRIVATE KEY was exposed and is now COMPROMISED — '
                  'rotate it (move funds to a new wallet).', file=sys.stderr)
    if residual:
        print('❌ a secret could not be scrubbed automatically — commit '
              'blocked. Remove it by hand.', file=sys.stderr)
        return 1
    return 0


def _sessions_dir() -> Path:
    # PBX_SESSIONS_DIR overrides for tests; default is the real location.
    import os
    override = os.environ.get('PBX_SESSIONS_DIR')
    if override:
        return Path(override)
    return Path.home() / '.claude' / 'projects'


def scrub_sessions() -> int:
    root = _sessions_dir()
    if not root.exists():
        print(f'secret-scrub: no sessions dir at {root}', file=sys.stderr)
        return 0
    redacted_files = 0
    for path in sorted(root.rglob('*')):
        if not path.is_file() or not _is_text(path):
            continue
        text = path.read_text(encoding='utf-8')
        findings = find_secrets(text, path.name)
        if findings:
            path.write_text(_redact(text, findings), encoding='utf-8')
            redacted_files += 1
            print(f'  redacted {len(findings)} secret(s) in {path}',
                  file=sys.stderr)
    print(f'🔒 secret-scrub --sessions: cleaned {redacted_files} file(s).',
          file=sys.stderr)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--staged', action='store_true')
    g.add_argument('--sessions', action='store_true')
    args = ap.parse_args()
    if args.staged:
        return scrub_staged()
    return scrub_sessions()


if __name__ == '__main__':
    sys.exit(main())
