#!/usr/bin/env python3
# noob-loop only -- bundles everything the dev team needs to diagnose
# a failed (or successful) noob install into a single markdown file.
#
# Usage:
#   python tools/onboarding-debug/export.py
#
# Writes to runtime/lab/logs/onboarding-export-YYYYMMDD-HHMMSS.md and
# prints the absolute path to stdout (single line, easy to grep).

import argparse
import datetime as dt
import json
import os
import platform
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# Path setup so `redact` import works regardless of CWD.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from redact import Redactor  # noqa: E402

REPO = HERE.parent.parent  # tools/onboarding-debug/.. = repo root
RUNTIME_LAB = REPO / "runtime" / "lab"
LOGS_DIR = REPO / "runtime" / "lab" / "logs"
EXPORT_DIR = LOGS_DIR

# Prepend the bundled .tooling/node dir to PATH so subprocess lookups
# for node/npm/pm2 find the bundled binaries even when the user
# invoked the exporter from a shell that wasn't sourced for them
# (the pbx.cmd wrapper does this for normal Claude CLI use, but
# the dev exporter is called directly via bash). Without this,
# `pm2 jlist` reports "not_found" in the export even when pm2 IS
# installed under .tooling/node/.
_bundled_node = REPO / ".tooling" / "node"
if _bundled_node.is_dir():
    os.environ["PATH"] = str(_bundled_node) + os.pathsep + os.environ.get("PATH", "")


def now_stamp() -> str:
    return dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def safe_read(path: Path, max_bytes: int = 1_000_000) -> Optional[str]:
    """Read a file. Return None on missing. Truncate to max_bytes if huge."""
    try:
        if not path.exists():
            return None
        b = path.read_bytes()
        # Strip BOM if present (PS 5.1 writes UTF-8-BOM by default).
        if b.startswith(b"\xef\xbb\xbf"):
            b = b[3:]
        if len(b) > max_bytes:
            head = b[: max_bytes // 2]
            tail = b[-max_bytes // 2 :]
            return (
                head.decode("utf-8", errors="replace")
                + f"\n\n... [TRUNCATED {len(b) - max_bytes} bytes] ...\n\n"
                + tail.decode("utf-8", errors="replace")
            )
        return b.decode("utf-8", errors="replace")
    except Exception as e:
        return f"[error reading {path}: {e}]"


def run_cmd(cmd: List[str], timeout: int = 10, cwd: Optional[Path] = None) -> Dict[str, Any]:
    """Run a command, return {cmd, stdout, stderr, returncode, error}.

    cwd defaults to REPO so git invocations and pm2 lookups always
    resolve against the repo root regardless of where the user
    invoked the exporter from. (Without this, running export.sh
    from anywhere other than the repo root produced `branch: ?`
    output because git rev-parse failed silently.)"""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            shell=False,
            cwd=str(cwd) if cwd else str(REPO),
        )
        return {
            "cmd": " ".join(cmd),
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
        }
    except FileNotFoundError:
        return {"cmd": " ".join(cmd), "error": "not_found"}
    except subprocess.TimeoutExpired:
        return {"cmd": " ".join(cmd), "error": "timeout"}
    except Exception as e:
        return {"cmd": " ".join(cmd), "error": str(e)}


def section(title: str, body: str) -> str:
    return f"## {title}\n\n{body.rstrip()}\n\n"


def code_block(content: str, lang: str = "") -> str:
    return f"```{lang}\n{content.rstrip()}\n```"


def parse_jsonl(text: Optional[str]) -> List[Dict[str, Any]]:
    """Parse JSONL (one JSON object per line)."""
    if not text:
        return []
    out = []
    for i, line in enumerate(text.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError as e:
            out.append({"_parse_error": str(e), "_raw": line, "_line": i + 1})
    return out


def build_timeline(
    events: List[Dict[str, Any]],
    http_events: List[Dict[str, Any]],
    redactor: Redactor,
) -> str:
    """Interleave step events + HTTP events into one chronological list."""
    items: List[Dict[str, Any]] = []
    for e in events:
        items.append({"_kind": "step", **e})
    for e in http_events:
        items.append({"_kind": "http", **e})

    # Sort by ts (string ISO, so lex order works).
    items.sort(key=lambda x: x.get("ts", ""))

    if not items:
        return "(no events logged)"

    lines = []
    for item in items:
        ts = item.get("ts", "?")
        if item.get("_kind") == "step":
            step = item.get("step", "?")
            event = item.get("event", "?")
            message = redactor.line(str(item.get("message", "")))
            tag = f"**[{step}]**"  # bold the Claude step events so they stand out from HTTP noise
            line = f"`{ts}` {tag} **{event}**"
            if message:
                line += f" — {message}"
            lines.append(line)
        else:
            method = item.get("method", "?")
            path = item.get("path", "?")
            status = item.get("status", "?")
            ms = item.get("ms", "?")
            line = f"`{ts}` [HTTP] **{method} {path}** → `{status}` ({ms}ms)"
            lines.append(line)

    return "\n".join(lines)


def build_step_only_timeline(
    events: List[Dict[str, Any]],
    redactor: Redactor,
) -> str:
    """Step events only -- the Claude-narrated story, separated out
    so it's readable without the HTTP-poll noise."""
    if not events:
        return "(no step events -- Claude on the VM didn't call log.sh. Skill compliance regression — investigate.)"
    items = sorted(events, key=lambda x: x.get("ts", ""))
    lines = []
    prev_ts: Optional[str] = None
    for item in items:
        ts = item.get("ts", "?")
        step = item.get("step", "?")
        event = item.get("event", "?")
        message = redactor.line(str(item.get("message", "")))
        # Compute gap from previous event in seconds for easy scan.
        gap = ""
        if prev_ts:
            try:
                t0 = dt.datetime.fromisoformat(prev_ts.replace("Z", "+00:00"))
                t1 = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
                delta = (t1 - t0).total_seconds()
                gap = f"  (+{delta:.1f}s)"
            except Exception:
                gap = ""
        line = f"`{ts}`{gap}  **[{step}]** {event}"
        if message:
            line += f" — {message}"
        lines.append(line)
        prev_ts = ts
    return "\n".join(lines)


def build_failures(events: List[Dict[str, Any]], http_events: List[Dict[str, Any]]) -> str:
    """Filter to just error-flavored events for quick scan."""
    failures: List[str] = []
    for e in events:
        if e.get("step", "").startswith("error") or e.get("event", "").endswith("_failed"):
            failures.append(
                f"- `{e.get('ts','?')}` [{e.get('step','?')}] {e.get('event','?')} — {e.get('message','')}"
            )
    for e in http_events:
        try:
            status_int = int(e.get("status", 0))
        except (TypeError, ValueError):
            status_int = 0
        if status_int >= 400:
            failures.append(
                f"- `{e.get('ts','?')}` [HTTP] {e.get('method','?')} {e.get('path','?')} → {status_int}"
            )
    if not failures:
        return "(no failures detected)"
    return "\n".join(failures)


def env_summary(redactor: Redactor) -> str:
    """Read .env file, show keys with redacted values."""
    env_path = REPO / ".env"
    if not env_path.exists():
        return "(no .env file)"
    lines = []
    for raw in safe_read(env_path, max_bytes=50_000).splitlines():
        raw = raw.strip()
        if not raw or raw.startswith("#"):
            continue
        if "=" not in raw:
            continue
        k, _, v = raw.partition("=")
        k = k.strip()
        v = v.strip()
        redacted = redactor.env_value(k, v)
        lines.append(f"- `{k}` = `{redacted}`")
    return "\n".join(lines) if lines else "(empty)"


def pm2_logs() -> str:
    """Last 200 lines of pm2 logs for both apps.

    pm2.config.cjs writes logs to repo-relative paths (out_file +
    error_file overrides) -- bots/_server_log.txt and
    bear-scout/runners/_paper_trade_log.txt -- NOT to the default
    ~/.pm2/logs/<name>-out.log. Check both locations; the relative
    one is correct for this repo, the home one is the fallback for
    any pm2 process that didn't override its log path."""
    home = Path(os.path.expanduser("~"))
    candidates = [
        # pm2.config.cjs canonical paths
        REPO / "bots" / "_server_log.txt",
        REPO / "bear-scout" / "runners" / "_paper_trade_log.txt",
        # Fallback to pm2 defaults in case the config gets reverted
        home / ".pm2" / "logs" / "bear-watch-server-stratos-out.log",
        home / ".pm2" / "logs" / "bear-watch-server-stratos-error.log",
        home / ".pm2" / "logs" / "paper-trade-bot-stratos-out.log",
        home / ".pm2" / "logs" / "paper-trade-bot-stratos-error.log",
    ]
    parts = []
    for p in candidates:
        body = safe_read(p, max_bytes=100_000)
        if body is None:
            parts.append(f"### `{p.name}`\n\n(missing)")
        else:
            # Last 200 lines.
            tail = "\n".join(body.splitlines()[-200:])
            parts.append(f"### `{p.name}`\n\n{code_block(tail or '(empty)')}")
    return "\n\n".join(parts)


def install_stdout(redactor: Redactor) -> str:
    """Tail of install.ps1 / install.bat stdout."""
    candidates = [
        LOGS_DIR / "install-stdout.log",
        RUNTIME_LAB / "install-stdout.log",  # legacy path (pre-logs-folder layout)
        RUNTIME_LAB / "install.log",
        REPO / "install-stdout.log",
    ]
    for p in candidates:
        body = safe_read(p, max_bytes=200_000)
        if body is not None:
            # Redact and return.
            body = "\n".join(redactor.line(ln) for ln in body.splitlines())
            return f"From `{p.relative_to(REPO)}`:\n\n{code_block(body)}"
    return "(install stdout not captured -- install.ps1 doesn't mirror to a file by default; we'd need to add `Tee-Object` to install.ps1 to capture it)"


def sysinfo() -> str:
    """Versions + platform info."""
    versions: List[str] = []
    for label, cmd in [
        ("node", ["node", "--version"]),
        ("npm", ["npm", "--version"]),
        ("python", ["python", "--version"]),
        ("git", ["git", "--version"]),
        ("pm2", ["pm2", "--version"]),
    ]:
        r = run_cmd(cmd, timeout=5)
        if "error" in r:
            versions.append(f"- {label}: `{r.get('error')}`")
        else:
            out = (r.get("stdout") or "").strip() or (r.get("stderr") or "").strip()
            versions.append(f"- {label}: `{out or '(no output)'}`")
    versions.append(f"- python (process): `{sys.version.split()[0]}`")
    versions.append(f"- platform: `{platform.platform()}`")
    versions.append(f"- machine: `{platform.machine()}`")
    return "\n".join(versions)


def scheduled_tasks() -> str:
    """Windows: list STRATOS-* scheduled tasks. Else: skip."""
    if os.name != "nt":
        return "(not Windows -- scheduled tasks N/A)"
    r = run_cmd(
        ["schtasks", "/Query", "/FO", "LIST", "/TN", "STRATOS-HealthCheck"],
        timeout=10,
    )
    # Just list which ones exist by trying each known name.
    expected = [
        "STRATOS-HealthCheck",
        "STRATOS-WeatherPull",
        "STRATOS-DailyDigest",
        "STRATOS-StateBackup",
        "STRATOS-CodebaseBackup",
        "STRATOS-MetaWatchdog",
    ]
    lines = []
    for name in expected:
        r = run_cmd(["schtasks", "/Query", "/TN", name], timeout=5)
        if "error" in r:
            lines.append(f"- `{name}`: ❌ (`{r['error']}`)")
        elif r.get("returncode") == 0:
            lines.append(f"- `{name}`: ✅ registered")
        else:
            lines.append(
                f"- `{name}`: ❌ exit={r.get('returncode')} stderr={(r.get('stderr') or '').strip()[:120]}"
            )
    return "\n".join(lines)


def pm2_list() -> str:
    r = run_cmd(["pm2", "jlist"], timeout=10)
    if "error" in r:
        return f"`pm2 jlist` failed: {r['error']}"
    try:
        procs = json.loads(r.get("stdout") or "[]")
        if not procs:
            return "(no pm2 processes)"
        lines = []
        for p in procs:
            name = p.get("name", "?")
            status = p.get("pm2_env", {}).get("status", "?")
            uptime_ms = p.get("pm2_env", {}).get("pm_uptime", 0)
            restarts = p.get("pm2_env", {}).get("restart_time", 0)
            lines.append(f"- `{name}` — status=`{status}` restarts=`{restarts}`")
        return "\n".join(lines)
    except Exception as e:
        return f"(parse error: {e})"


def final_state(redactor: Redactor) -> str:
    """ready.json + user-profile.json contents, redacted."""
    parts = []
    for label, p in [
        (".tooling/ready.json", REPO / ".tooling" / "ready.json"),
        ("runtime/lab/user-profile.json", RUNTIME_LAB / "user-profile.json"),
    ]:
        body = safe_read(p, max_bytes=20_000)
        if body is None:
            parts.append(f"### `{label}`\n\n(missing)")
            continue
        body = redactor.line(body)
        # Pretty-print JSON if parseable.
        try:
            obj = json.loads(body)
            body = json.dumps(obj, indent=2)
        except Exception:
            pass
        parts.append(f"### `{label}`\n\n{code_block(body, 'json')}")
    return "\n\n".join(parts)


def git_state() -> str:
    """Branch + HEAD SHA + dirty?"""
    branch = run_cmd(["git", "rev-parse", "--abbrev-ref", "HEAD"], timeout=5)
    sha = run_cmd(["git", "rev-parse", "HEAD"], timeout=5)
    dirty = run_cmd(["git", "status", "--porcelain"], timeout=10)
    return (
        f"- branch: `{(branch.get('stdout') or '').strip() or '?'}`\n"
        f"- HEAD: `{(sha.get('stdout') or '').strip() or '?'}`\n"
        f"- working tree clean: `{not (dirty.get('stdout') or '').strip()}`"
    )


def build_report() -> str:
    redactor = Redactor()

    # Prefer the new logs/ folder layout; fall back to runtime/lab/ for
    # legacy state from a pre-cleanup install.
    session_path = LOGS_DIR / "install-session.jsonl"
    if not session_path.exists():
        session_path = RUNTIME_LAB / "install-session.jsonl"
    http_path = LOGS_DIR / "install-http.jsonl"
    if not http_path.exists():
        http_path = RUNTIME_LAB / "install-http.jsonl"
    session = parse_jsonl(safe_read(session_path))
    http = parse_jsonl(safe_read(http_path))

    out = []
    out.append(f"# PBX Stratos -- Onboarding Export\n")
    out.append(f"_Generated: {now_iso()}_\n")
    out.append(f"_Repo: `{REPO}`_\n")
    out.append("\n")
    out.append("> **noob-loop only.** This file is built by the dev tooling at\n")
    out.append("> `tools/onboarding-debug/export.py`. Paste its contents into the dev-handoff\n")
    out.append("> channel and the team will diagnose what happened.\n\n")

    out.append(section("Git state", git_state()))
    out.append(section("System info", sysinfo()))
    out.append(section("Step log (Claude's narration only)",
                       build_step_only_timeline(session, redactor)))
    out.append(section("Full timeline (Claude steps + HTTP requests)",
                       build_timeline(session, http, redactor)))
    out.append(section("Failures", build_failures(session, http)))
    out.append(section("Final state", final_state(redactor)))
    out.append(section("Scheduled tasks (Windows)", scheduled_tasks()))
    out.append(section("pm2 processes", pm2_list()))
    out.append(section(".env summary", env_summary(redactor)))
    out.append(section("install.bat / install.ps1 stdout", install_stdout(redactor)))
    out.append(section("pm2 logs (last 200 lines each)", pm2_logs()))

    out.append(section("Redactions applied", redactor.report()))

    return "".join(out)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out",
        help="Output file path. Default: runtime/lab/logs/onboarding-export-<ts>.md",
    )
    args = parser.parse_args()

    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = (
        Path(args.out)
        if args.out
        else EXPORT_DIR / f"onboarding-export-{now_stamp()}.md"
    )
    report = build_report()
    out_path.write_text(report, encoding="utf-8")

    # Single-line absolute path so Claude can grep it.
    print(str(out_path.resolve()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
