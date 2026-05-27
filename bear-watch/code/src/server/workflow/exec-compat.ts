/**
 * Cross-platform process-spawning helpers for the workflow subprocesses.
 *
 * Two Windows portability problems the workflow used to hit:
 *
 *  1. `python3` — on Windows the interpreter is almost always `python`
 *     (`python.exe`); `python3.exe` usually doesn't exist. `resolvePython`
 *     picks whichever interpreter is actually present.
 *
 *  2. `claude` — `npm i -g @anthropic-ai/claude-code` installs `claude.cmd`
 *     on Windows, not `claude.exe`. Since CVE-2024-27980 Node refuses to
 *     spawn a `.cmd`/`.bat` without `shell: true`. `CLAUDE_NEEDS_SHELL`
 *     says when to set that flag.
 *
 * The claude callers also pipe the prompt over stdin rather than passing
 * it as an argv string. That's required for `shell: true` to be safe (a
 * large prompt on a cmd.exe command line would be mangled by quoting),
 * and it's better regardless — the model prompt never touches a shell
 * command line on any platform.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IS_WINDOWS = platform() === 'win32';

/** On Windows a `.cmd` shim must be spawned with shell: true. */
export const CLAUDE_NEEDS_SHELL = IS_WINDOWS;

/** Lowest Python the lab supports. */
const MIN_PYTHON_MINOR = 10; // i.e. 3.10

/** Repo root — for locating the project virtualenv. STRATOS_REPO_ROOT
 *  overrides; otherwise derived from this file's path
 *  (bear-watch/code/src/server/workflow/exec-compat.ts → up four). */
function repoRoot(): string {
  const env = process.env.STRATOS_REPO_ROOT;
  if (env) return resolve(env);
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

/** True if `cmd` runs and reports Python ≥ MIN_PYTHON_MINOR. */
function isPython310Plus(cmd: string): boolean {
  try {
    // windowsHide: true on every probe — these fire on dashboard load,
    // and without it every page render would flash multiple console
    // windows on Windows users' screens.
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    if (r.status !== 0) return false;
    const m = (r.stdout || r.stderr || '').match(/(\d+)\.(\d+)/);
    if (!m) return false;
    const major = parseInt(m[1]!, 10);
    const minor = parseInt(m[2]!, 10);
    return major > 3 || (major === 3 && minor >= MIN_PYTHON_MINOR);
  } catch {
    return false;
  }
}

let _python: string | null = null;

/** Return the name of a working Python ≥3.10 interpreter.
 *
 *  Version-specific names are probed FIRST (python3.13 … python3.10)
 *  so a fresh `brew install python@3.12` is picked up even when the
 *  bare `python3` on PATH still points at an older system Python — the
 *  common macOS case. Each candidate's `--version` is parsed; the
 *  first that reports ≥3.10 wins.
 *
 *  If nothing ≥3.10 is found, returns the first interpreter that ran
 *  at all (so the preflight surfaces a clear "too old" message rather
 *  than an ENOENT), or the platform default name as a last resort. */
export function resolvePython(): string {
  if (_python) return _python;

  // 1. The project virtualenv, if present. install.sh / install.ps1 put
  //    the decoder deps (scikit-learn, numpy) here — a bare system
  //    `python3` won't have them. This is the interpreter to use.
  const venvPython = IS_WINDOWS
    ? join(repoRoot(), '.venv', 'Scripts', 'python.exe')
    : join(repoRoot(), '.venv', 'bin', 'python');
  if (existsSync(venvPython) && isPython310Plus(venvPython)) {
    _python = venvPython;
    return venvPython;
  }

  // 2. No venv — probe system interpreters. Version-specific names
  //    first so a `brew install python@3.12` is found even when the
  //    bare `python3` still points at an older system Python.
  const candidates = [
    'python3.13', 'python3.12', 'python3.11', 'python3.10',
    ...(IS_WINDOWS ? ['python', 'python3'] : ['python3', 'python']),
  ];
  let firstThatRuns: string | null = null;
  for (const cand of candidates) {
    try {
      const r = spawnSync(cand, ['--version'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
      if (r.status !== 0) continue;
      if (firstThatRuns == null) firstThatRuns = cand;
      if (isPython310Plus(cand)) {
        _python = cand;
        return cand;
      }
    } catch {
      /* try next candidate */
    }
  }
  _python = firstThatRuns ?? candidates[candidates.length - 1]!;
  return _python;
}

let _claude: string | null = null;
let _claudeAvailable: boolean | null = null;

/** True if the resolved `claude` binary actually runs `--version` cleanly.
 *
 *  Used as a hard gate on the decode workflow — the dashboard preflight
 *  already surfaces a blocking banner, and /api/workflow/run refuses to
 *  start without a working CLI so a stale page or direct curl can't
 *  silently degrade. Result is cached for the process lifetime, matching
 *  `resolveClaude`'s caching contract: if the user installs claude
 *  mid-session, the server must be restarted to pick it up. */
export function isClaudeAvailable(): boolean {
  if (_claudeAvailable !== null) return _claudeAvailable;
  try {
    const r = spawnSync(resolveClaude(), ['--version'], {
      encoding: 'utf8', timeout: 4000, shell: CLAUDE_NEEDS_SHELL, windowsHide: true,
    });
    _claudeAvailable = r.status === 0;
  } catch {
    _claudeAvailable = false;
  }
  return _claudeAvailable;
}

/** Return a path (or bare name) for the `claude` CLI.
 *
 *  Tries the bare name first — works whenever `claude` is on PATH. If
 *  it isn't, probes the well-known native-installer locations. This
 *  matters for the dead-easy non-dev flow: a Claude Code Desktop user
 *  has the `claude` binary, but the dashboard server is a subprocess
 *  whose PATH may not include `~/.local/bin`, so a bare `claude` spawn
 *  would ENOENT even though the CLI is installed.
 *
 *  Falls back to `'claude'` when nothing is found, so callers get the
 *  same ENOENT behavior as before rather than a surprise. */
export function resolveClaude(): string {
  if (_claude) return _claude;

  // 1. On PATH already?
  try {
    const r = spawnSync('claude', ['--version'], {
      encoding: 'utf8', timeout: 4000, shell: CLAUDE_NEEDS_SHELL, windowsHide: true,
    });
    if (r.status === 0) { _claude = 'claude'; return _claude; }
  } catch { /* not on PATH — fall through to well-known locations */ }

  // 2. Well-known install locations the native installer / npm use.
  const home = homedir();
  const candidates = IS_WINDOWS
    ? [
        join(home, '.local', 'bin', 'claude.exe'),
        join(process.env.APPDATA ?? '', 'npm', 'claude.cmd'),
      ]
    : [
        join(home, '.local', 'bin', 'claude'),
        join(home, '.claude', 'local', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
      ];
  for (const cand of candidates) {
    if (cand && existsSync(cand)) { _claude = cand; return cand; }
  }

  _claude = 'claude';
  return _claude;
}
