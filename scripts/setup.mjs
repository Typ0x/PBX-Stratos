// Cross-platform setup: ensure Python, install npm deps, write readiness marker.
// Run via: node scripts/setup.mjs   (invoked by scripts/bootstrap.{sh,ps1})
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';

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

/** Probes candidate interpreter names; returns the path of the first >= 3.9. */
function findSystemPython() {
  const candidates = process.platform === 'win32'
    ? ['python', 'python3']
    : ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3'];
  for (const cand of candidates) {
    const r = spawnSync(cand, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && isUsablePython((r.stdout || r.stderr).trim())) return cand;
  }
  return null;
}

async function ensurePython() {
  const sys = findSystemPython();
  if (sys && process.platform !== 'win32') {
    console.log(`[setup] using system Python: ${sys}`);
    return sys;
  }
  if (process.platform !== 'win32') {
    // macOS/Linux without a usable Python — rare. Surface clearly.
    throw new Error('No Python 3.9+ found. Install Python 3.9+ and re-run.');
  }
  // Windows: always bundle. See spec — detection here is unreliable.
  const { pythonWinEmbedUrl } = await import('./lib/platform.mjs');
  const pyDir = join(toolingDir, 'python');
  if (existsSync(join(pyDir, 'python.exe'))) {
    console.log('[setup] bundled Python already present');
    return join(pyDir, 'python.exe');
  }
  console.log('[setup] downloading bundled Python for Windows...');
  const url = pythonWinEmbedUrl(process.arch);
  mkdirSync(pyDir, { recursive: true });
  const zip = join(toolingDir, 'python-embed.zip');
  await downloadFile(url, zip);
  // Expand-Archive via PowerShell (always present on Windows).
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${pyDir}'`], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('failed to extract bundled Python');
  rmSync(zip, { force: true });
  return join(pyDir, 'python.exe');
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

async function main() {
  mkdirSync(toolingDir, { recursive: true });
  const python = await ensurePython();
  npmInstall();
  const marker = {
    ready: true,
    python,
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
