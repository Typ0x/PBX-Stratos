"""Secret detection — pure functions, no side effects.

find_secrets(text) -> list[Finding]   secrets found in `text`
is_whole_file_secret(text, filename) -> bool   whole file IS a secret
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# An inline `# secret-scrub: allow` comment suppresses findings whose
# match starts on that same line (escape hatch for false positives).
_ALLOW_RE = re.compile(r'secret-scrub:\s*allow')

# Filenames that are secrets in their entirety.
_SECRET_FILENAME_RE = re.compile(
    r'(^|/)(\.env(\..+)?|.*keypair.*\.json|id_[a-z0-9]+|.*\.pem)$', re.IGNORECASE)

_PRIVATE_KEY_KINDS = {'solana_keypair', 'mnemonic', 'base58_key', 'pem_private_key'}


@dataclass
class Finding:
    kind: str          # solana_keypair|mnemonic|base58_key|api_key|github_token|pem_private_key|env_secret
    start: int         # char offset, inclusive
    end: int           # char offset, exclusive
    is_private_key: bool


def _line_start(text: str, idx: int) -> int:
    nl = text.rfind('\n', 0, idx)
    return nl + 1


def _line_is_allowed(text: str, idx: int) -> bool:
    """True if the line containing offset `idx` has an allow comment."""
    start = _line_start(text, idx)
    end = text.find('\n', idx)
    line = text[start:(end if end != -1 else len(text))]
    return bool(_ALLOW_RE.search(line))


def _solana_keypair_spans(text: str):
    for m in re.finditer(r'\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]', text):
        nums = [int(n) for n in re.findall(r'\d{1,3}', m.group())]
        if len(nums) == 64 and all(0 <= n <= 255 for n in nums):
            yield m.start(), m.end()


def _mnemonic_spans(text: str):
    # Heuristic: 12 or 24 consecutive words of 3-8 lowercase ASCII
    # letters. This is a deliberate approximation — it does NOT validate
    # against the BIP39 wordlist, so a run of short lowercase words can
    # false-positive. The `# secret-scrub: allow` escape hatch covers that.
    for m in re.finditer(r'\b(?:[a-z]{3,8} ){11,23}[a-z]{3,8}\b', text):
        if len(m.group().split()) in (12, 24):
            yield m.start(), m.end()


def _base58_key_spans(text: str):
    # Solana secret keys are 64 bytes → 87-88 base58 chars.
    for m in re.finditer(r'\b[1-9A-HJ-NP-Za-km-z]{87,88}\b', text):
        yield m.start(), m.end()


def _regex_spans(text: str, pattern: str):
    for m in re.finditer(pattern, text):
        yield m.start(), m.end()


# kind -> regex
_REGEX_KINDS = {
    'github_token': r'\bgh[posru]_[A-Za-z0-9]{36,}\b',
    'api_key': r'\bsk-[A-Za-z0-9]{20,}\b',
    'pem_private_key':
        r'-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----',
    'env_secret':
        r'(?im)^\s*[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|MNEMONIC|SEED)'
        r'[A-Z0-9_]*\s*=\s*\S{8,}',
}


def find_secrets(text: str, filename: str = '') -> list[Finding]:
    """Return every secret found in `text`, sorted by start offset."""
    found: list[Finding] = []

    for start, end in _solana_keypair_spans(text):
        found.append(Finding('solana_keypair', start, end, True))
    for start, end in _mnemonic_spans(text):
        found.append(Finding('mnemonic', start, end, True))
    for start, end in _base58_key_spans(text):
        found.append(Finding('base58_key', start, end, True))
    for kind, pattern in _REGEX_KINDS.items():
        for start, end in _regex_spans(text, pattern):
            found.append(Finding(kind, start, end, kind in _PRIVATE_KEY_KINDS))

    # Drop findings on allow-listed lines, then sort + de-overlap.
    found = [f for f in found if not _line_is_allowed(text, f.start)]
    # Sort: by start offset; break ties by putting specific kinds before env_secret
    # so that e.g. `github_token` inside a `token=ghp_...` line wins.
    _GENERIC_KINDS = {'env_secret'}
    found.sort(key=lambda f: (f.start, f.kind in _GENERIC_KINDS))
    deduped: list[Finding] = []
    for f in found:
        if deduped and f.start < deduped[-1].end:
            # Overlaps the last kept finding.  If the new finding is more
            # specific (not generic) and the kept one is generic, replace it.
            if deduped[-1].kind in _GENERIC_KINDS and f.kind not in _GENERIC_KINDS:
                deduped[-1] = f
            continue
        deduped.append(f)
    return deduped


def is_whole_file_secret(text: str, filename: str) -> bool:
    """True when the entire file is a secret (→ unstage it, don't redact)."""
    if _SECRET_FILENAME_RE.search(filename or ''):
        return True
    stripped = text.strip()
    for start, end in _solana_keypair_spans(text):
        if text[start:end].strip() == stripped:
            return True
    return False
