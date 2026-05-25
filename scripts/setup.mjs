// Cross-platform setup: ensure Python, install npm deps, write readiness marker.
// Run via: node scripts/setup.mjs   (invoked by scripts/bootstrap.{sh,ps1})
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, rmSync, openSync } from 'node:fs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const toolingDir = join(repoRoot, '.tooling');

/** Parses "Python X.Y.Z" -> {major, minor}, or null. */
export function parsePyVersion(text) {
  const m = String(text).match(/Python (\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/** True if the version string is Python >= 3.9. */
export function isUsablePython(versionText) {
  const v = parsePyVersion(versionText);
  if (!v) return false;
  return v.major > 3 || (v.major === 3 && v.minor >= 9);
}

/** Probes a single candidate, returns interpreter path or null. */
function probePython(cand) {
  // The `py` launcher needs `-3` to prefer Python 3 over a default 2 install.
  const args = (cand === 'py') ? ['-3', '--version'] : ['--version'];
  try {
    // stdio: ['ignore', 'pipe', 'pipe'] -- capture both streams but
    // SUPPRESS the Microsoft Store Python launcher stub's scary
    // "Python was not found; run without arguments to install from
    // the Microsoft Store..." stderr message from leaking to the
    // user's console. We still inspect the captured stderr for the
    // real Python version line below; we just don't pass it through.
    const r = spawnSync(cand, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status === 0 && isUsablePython((r.stdout || r.stderr || '').trim())) {
      // For `py -3` return the launcher with the -3 flag baked into the
      // returned identifier so callers know to invoke it with -3.
      return (cand === 'py') ? 'py -3' : cand;
    }
  } catch {
    /* candidate not found — keep looking */
  }
  return null;
}

/**
 * Probes candidate interpreter names + paths and returns the first
 * usable Python >= 3.9. On Windows expands the search beyond bare PATH
 * lookups to cover `py` launcher + per-user / system-wide install dirs.
 */
async function findSystemPython() {
  if (process.platform === 'win32') {
    const { windowsPythonCandidates } = await import('./lib/platform.mjs');
    for (const cand of windowsPythonCandidates()) {
      const found = probePython(cand);
      if (found) return found;
    }
    return null;
  }
  const candidates = ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3', 'python'];
  for (const cand of candidates) {
    const found = probePython(cand);
    if (found) return found;
  }
  return null;
}

async function ensurePython() {
  const sys = await findSystemPython();
  if (sys) {
    console.log(`[setup] using system Python: ${sys}`);
    return sys;
  }
  if (process.platform !== 'win32') {
    // macOS/Linux without a usable Python — rare. Surface clearly.
    throw new Error('No Python 3.9+ found. Install Python 3.9+ and re-run.');
  }
  // Windows: no system Python found, fall back to bundled.
  // We use the OFFICIAL Python installer (.exe), not the embeddable ZIP
  // distro. The embeddable ZIP lacks pip + venv + ensurepip and would
  // break `python -m venv .venv` and `pip install -e .[decoder]` later.
  const { pythonWinInstallerUrl, PYTHON_VERSION } = await import('./lib/platform.mjs');
  const pyDir = join(toolingDir, 'python');
  const pyExe = join(pyDir, 'python.exe');
  if (existsSync(pyExe)) {
    console.log('[setup] bundled Python already present at', pyExe);
    return pyExe;
  }
  console.log(`[setup] downloading bundled Python ${PYTHON_VERSION} for Windows...`);
  const url = pythonWinInstallerUrl(process.arch);
  mkdirSync(pyDir, { recursive: true });
  const exe = join(toolingDir, 'python-installer.exe');
  await downloadFile(url, exe);
  console.log('[setup] running silent per-user install to', pyDir);
  // Per-user, no admin, no PATH pollution, install into our .tooling dir.
  // /quiet = no UI, InstallAllUsers=0 = current user only, no admin needed.
  // PrependPath=0 = don't touch the system PATH (we manage it ourselves).
  // TargetDir = our bundled location. Include_pip + Include_launcher
  // ensure pip + py launcher are installed inside our bundle.
  const args = [
    '/quiet',
    'InstallAllUsers=0',
    'PrependPath=0',
    'Include_test=0',
    'Include_doc=0',
    'Include_pip=1',
    'Include_launcher=0',
    `TargetDir=${pyDir}`,
  ];
  const r = spawnSync(exe, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`bundled Python installer exited ${r.status}`);
  rmSync(exe, { force: true });
  if (!existsSync(pyExe)) {
    throw new Error(`installer ran but ${pyExe} not present — install layout unexpected`);
  }
  return pyExe;
}

/** Streams a URL to a file using fetch (Node 18+). */
async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

function npmInstall() {
  console.log('[setup] installing workspace dependencies (npm install)...');
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new Error('npm install failed — see output above');
}

/**
 * The dashboard's wallet-decode workflow shells out to the `claude` CLI
 * to run its DSL refinement loop. Without it, /api/workflow/preflight
 * fails with `claudeCli.ok: false`, the "Find top traders & decode"
 * button stays disabled, and the decode hangs at 0% if the user clicks
 * it. Install the CLI globally as part of bootstrap so first-run users
 * never see that error. Best-effort — surface a clear note on failure
 * but don't abort the whole setup.
 */
function ensureClaudeCli() {
  const probe = spawnSync('claude', ['--version'], {
    encoding: 'utf8', shell: process.platform === 'win32',
  });
  if (probe.status === 0 && /\d+\.\d+/.test(probe.stdout || '')) {
    console.log(`[setup] claude CLI present: ${probe.stdout.trim()}`);
    return;
  }
  // PERF: claude CLI is only needed by the wallet-decode workflow,
  // which the user reaches many minutes after first dashboard load.
  // Originally this was a blocking ~60s install at the END of bootstrap
  // (right before install.ps1 moved on to Steps 2-4); now spawn it
  // DETACHED so bootstrap returns immediately and the dashboard can
  // come up sooner. If the user hits the decode button before this
  // background install finishes, /api/workflow/preflight will surface
  // the missing-CLI message; they retry after a moment.
  console.log('[setup] launching detached background install of @anthropic-ai/claude-code (ready in ~1-2 min)...');
  // Write a marker log so /api/workflow/preflight can detect the
  // background install is in flight and show the user a
  // "decoder finishing install" hint instead of a hard error if they
  // click decode before the install completes (see Bug #2 / dee7676).
  import('node:child_process').then(({ spawn }) => {
    try {
      // Make sure runtime/lab/ exists -- it might not yet on first install
      const labDir = process.env.STRATOS_LAB_HOME
        || join(repoRoot, 'runtime', 'lab');
      mkdirSync(labDir, { recursive: true });
      const bgLog = join(labDir, 'claude-cli-bg.log');
      writeFileSync(bgLog, `${new Date().toISOString()} -- starting background npm install -g @anthropic-ai/claude-code\n`);
      // Touch the file periodically so /api/workflow/preflight's
      // "modified in last 5 min" check stays true even if install is
      // slow. Simpler: just rely on the initial timestamp being recent.
      const out = openSync(bgLog, 'a');
      const child = spawn('npm', ['install', '-g', '@anthropic-ai/claude-code',
        '--no-audit', '--no-fund', '--loglevel=error'], {
        cwd: repoRoot,
        detached: true,
        stdio: ['ignore', out, out],
        shell: process.platform === 'win32',
      });
      child.unref();
    } catch (e) {
      console.warn(`[setup] WARN: could not launch detached claude CLI install: ${e.message}`);
    }
  }).catch(() => {});
}

/**
 * Kick off `npm install -g pm2` in the background BEFORE the
 * workspace npm install. The two npm processes run concurrently --
 * by the time the workspace install finishes (~5-6 min on cold VM),
 * pm2 is also installed. install.ps1 Step 3 then becomes a no-op
 * because Get-Command pm2 returns the path. Net saving: ~1-2 min
 * off cold install wall time.
 *
 * No-op if pm2 is already on PATH (detected via `pm2 --version`).
 */
function ensurePm2InBackground() {
  const probe = spawnSync('pm2', ['--version'], {
    encoding: 'utf8', shell: process.platform === 'win32',
  });
  if (probe.status === 0 && /\d+\.\d+/.test(probe.stdout || '')) {
    console.log(`[setup] pm2 already present: ${probe.stdout.trim()}`);
    return;
  }
  console.log('[setup] launching parallel background install of pm2 (concurrent with workspace install)...');
  // Same pattern as ensureClaudeCli: detached spawn + marker log so
  // install.ps1 can detect bg install is in flight.
  import('node:child_process').then(({ spawn }) => {
    try {
      const labDir = process.env.STRATOS_LAB_HOME
        || join(repoRoot, 'runtime', 'lab', 'logs');
      mkdirSync(labDir, { recursive: true });
      const bgLog = join(labDir, 'pm2-bg.log');
      writeFileSync(bgLog, `${new Date().toISOString()} -- starting parallel npm install -g pm2\n`);
      const out = openSync(bgLog, 'a');
      const child = spawn('npm', ['install', '-g', 'pm2',
        '--no-audit', '--no-fund', '--loglevel=error'], {
        cwd: repoRoot,
        detached: true,
        stdio: ['ignore', out, out],
        shell: process.platform === 'win32',
      });
      child.unref();
    } catch (e) {
      console.warn(`[setup] WARN: could not launch parallel pm2 install: ${e.message}`);
    }
  }).catch(() => {});
}

async function main() {
  mkdirSync(toolingDir, { recursive: true });
  const python = await ensurePython();
  // Kick off pm2 install in BACKGROUND so it runs in parallel with
  // the workspace npm install below. install.ps1 Step 3 becomes a
  // no-op when pm2 is already on PATH by then.
  ensurePm2InBackground();
  npmInstall();
  ensureClaudeCli();
  // Record both the python AND node paths the bootstrap chose so that
  // install.ps1 (which runs in a separate process and doesn't inherit
  // bootstrap.ps1's PATH edits) can find them.
  // process.execPath = the actual node binary we're running inside.
  const marker = {
    ready: true,
    python,
    node: process.execPath,
    platform: process.platform,
    arch: process.arch,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(join(toolingDir, 'ready.json'), JSON.stringify(marker, null, 2));
  console.log('[setup] done — wrote .tooling/ready.json');
}

if (process.argv[1] && process.argv[1].endsWith('setup.mjs')) {
  main().catch((e) => { console.error(`[setup] ERROR: ${e.message}`); process.exit(1); });
}
