# noob-loop only -- shared redaction helpers for the onboarding exporter.
#
# Replaces sensitive values with `[REDACTED:reason]` markers and reports
# what was redacted so the dev team knows what's missing.

import re
from typing import List, Tuple

# Env-var name patterns that always trigger redaction.
SECRET_NAME_PATTERNS = [
    re.compile(r".*_KEY$", re.IGNORECASE),
    re.compile(r".*_TOKEN$", re.IGNORECASE),
    re.compile(r".*_SECRET$", re.IGNORECASE),
    re.compile(r".*_PASSWORD$", re.IGNORECASE),
    re.compile(r".*_PASS$", re.IGNORECASE),
    re.compile(r".*_MNEMONIC$", re.IGNORECASE),
    re.compile(r".*_PRIVATE.*", re.IGNORECASE),
    re.compile(r".*_SEED.*", re.IGNORECASE),
    re.compile(r"^HELIUS_.*", re.IGNORECASE),
    re.compile(r".*_API_URL$", re.IGNORECASE),  # often contains embedded key
]

# Standalone patterns inside arbitrary text.
# Base58 strings that look like Solana private keys (typically 87-88 chars).
BASE58_LONG = re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{80,200}\b")

# 12 or 24 word BIP39 mnemonic. Heuristic: 12 or 24 lowercase a-z words
# separated by single spaces. Only triggers if the line LOOKS like it
# could be a seed (whole-string match, not embedded in a sentence).
MNEMONIC_12 = re.compile(r"\b(?:[a-z]{3,8}\s+){11}[a-z]{3,8}\b")
MNEMONIC_24 = re.compile(r"\b(?:[a-z]{3,8}\s+){23}[a-z]{3,8}\b")

# URLs with `api-key=...` query param or `https://<host>/?api-key=...`
HELIUS_URL = re.compile(r"https?://[^\s\"']*api-key=[A-Za-z0-9_\-]+")


class Redactor:
    """Stateful redactor that tracks every redaction it applies so the
    final report can list what was scrubbed."""

    def __init__(self) -> None:
        self.redactions: List[Tuple[str, str]] = []  # (reason, sample-prefix)

    def _note(self, reason: str, original: str) -> None:
        prefix = original[:8] + "..." if len(original) > 8 else original
        self.redactions.append((reason, prefix))

    def env_value(self, key: str, value: str) -> str:
        """Redact an env-var VALUE if its KEY matches a secret pattern."""
        for pat in SECRET_NAME_PATTERNS:
            if pat.match(key):
                self._note(f"envvar:{key}", value)
                return "[REDACTED:envvar]"
        return value

    def line(self, text: str) -> str:
        """Apply standalone-pattern redactions inside arbitrary text."""
        result = text

        def sub_mnemonic_24(m):
            self._note("mnemonic24", m.group(0))
            return "[REDACTED:mnemonic24]"

        def sub_mnemonic_12(m):
            self._note("mnemonic12", m.group(0))
            return "[REDACTED:mnemonic12]"

        def sub_base58(m):
            self._note("base58", m.group(0))
            return "[REDACTED:base58]"

        def sub_helius_url(m):
            self._note("helius-url", m.group(0))
            return "[REDACTED:helius-url]"

        # Order matters: longer / more-specific patterns first.
        result = MNEMONIC_24.sub(sub_mnemonic_24, result)
        result = MNEMONIC_12.sub(sub_mnemonic_12, result)
        result = HELIUS_URL.sub(sub_helius_url, result)
        result = BASE58_LONG.sub(sub_base58, result)
        return result

    def report(self) -> str:
        """Return a human-readable summary of what was redacted."""
        if not self.redactions:
            return "(nothing redacted)"
        counts: dict = {}
        samples: dict = {}
        for reason, sample in self.redactions:
            counts[reason] = counts.get(reason, 0) + 1
            samples.setdefault(reason, sample)
        lines = []
        for reason in sorted(counts.keys()):
            lines.append(f"- {reason}: {counts[reason]} occurrence(s) (sample prefix: `{samples[reason]}`)")
        return "\n".join(lines)
