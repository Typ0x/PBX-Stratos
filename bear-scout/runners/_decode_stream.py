"""Pure helpers for streaming the `claude` CLI decode.

A single-purpose module: the parsing logic, separated from the
agentic-decode.py script's subprocess I/O so it stays focused and
unit-testable. Mirrors the existing `_api.py` sibling helper.
"""
from __future__ import annotations

import json
import re
from typing import Callable, Iterable

_STATUS_RE = re.compile(r'\[status\]\s*(.+)')


def extract_status(text: str) -> list[str]:
    """Return every `[status] <phrase>` marker found in `text`, in order,
    with surrounding whitespace trimmed."""
    return [m.group(1).strip() for m in _STATUS_RE.finditer(text)]


def parse_stream_line(line: str) -> dict | None:
    """Parse one NDJSON stream line into a dict, or None if the line is
    blank or not valid JSON."""
    line = line.strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        return None


def _line_text(event: dict) -> str:
    """Extract assistant text from one stream event, or '' if none.

    A `claude` stream-json `assistant` event nests text under
    message.content[].text. Tolerant of shapes that differ slightly."""
    msg = event.get('message')
    if isinstance(msg, dict):
        parts = msg.get('content')
        if isinstance(parts, list):
            return ''.join(
                p.get('text', '') for p in parts
                if isinstance(p, dict) and p.get('type') == 'text')
    # Some CLI versions put text directly on the event.
    t = event.get('text')
    return t if isinstance(t, str) else ''


def assemble_stream(
    lines: Iterable[str], on_status: Callable[[str], None],
) -> tuple[str, float]:
    """Consume `claude` stream-json `lines`. For every `[status]` marker
    seen in assistant text, call `on_status(phrase)` exactly once, live,
    as soon as the complete line containing it is received. Return
    `(final_text, cost_usd)`.

    The real `claude -p --output-format stream-json --verbose
    --include-partial-messages` CLI emits three relevant event shapes:

    1. ``{"type": "stream_event", "event": {"type":
       "content_block_delta", "index": 0, "delta": {"type":
       "text_delta", "text": "<chunk>"}}}`` — incremental text; this is
       where ``[status]`` markers arrive live.
    2. ``{"type": "assistant", "message": {"content": [{"type": "text",
       "text": "<full text>"}]}}`` — late single event containing the
       whole assistant message; used only as a fallback text source.
    3. ``{"type": "result", "result": "<text>", "total_cost_usd":
       <float>}`` — final event supplying canonical text + cost.

    Status extraction uses a line buffer so that:
    - Markers split across two deltas fire only once with the full phrase.
    - Partial trailing lines (no ``\\n`` yet) are held until more text
      arrives or the stream ends, then flushed.

    Malformed lines are skipped silently."""
    delta_text = ''          # accumulates all delta chunks
    assistant_fallback = ''  # from the late 'assistant' event, if any
    result_text: str | None = None
    cost = 0.0

    # Line buffer for incremental status detection.
    buffer = ''

    def _flush_complete_lines(chunk: str) -> None:
        """Append chunk to buffer; fire on_status for every complete line."""
        nonlocal buffer
        buffer += chunk
        # Split on newlines: all parts except the last are complete lines.
        parts = buffer.split('\n')
        for complete_line in parts[:-1]:
            for phrase in extract_status(complete_line):
                on_status(phrase)
        buffer = parts[-1]  # remainder (no trailing newline yet)

    for line in lines:
        event = parse_stream_line(line)
        if event is None:
            continue
        etype = event.get('type')

        if etype == 'stream_event':
            inner = event.get('event')
            if not isinstance(inner, dict):
                continue
            if inner.get('type') != 'content_block_delta':
                continue
            delta = inner.get('delta')
            if not isinstance(delta, dict):
                continue
            if delta.get('type') != 'text_delta':
                continue
            chunk = delta.get('text', '')
            if not isinstance(chunk, str):
                continue
            delta_text += chunk
            _flush_complete_lines(chunk)

        elif etype == 'assistant':
            # Late full-message event — collect as fallback text only.
            # Do NOT extract status here; all markers were already fired
            # incrementally via stream_event deltas.
            assistant_fallback = _line_text(event)

        elif etype == 'result':
            if isinstance(event.get('result'), str):
                result_text = event['result']
            c = event.get('total_cost_usd')
            if isinstance(c, (int, float)):
                cost = float(c)

    # Flush whatever remains in the buffer (last line with no trailing newline).
    if buffer:
        for phrase in extract_status(buffer):
            on_status(phrase)

    # Canonical text priority: result > delta text > assistant fallback.
    if result_text is not None:
        final_text = result_text
    elif delta_text:
        final_text = delta_text
    else:
        final_text = assistant_fallback

    return final_text, cost
