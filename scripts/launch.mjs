// Starts the PBX Stratos dashboard in explore-only mode and opens it.
// Run via: node scripts/launch.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findFreePort } from './lib/net.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Returns [command, args] to open `url` in the default browser. */
export function browserOpenCommand(platform, url) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  return ['xdg-open', [url]];
}

async function waitForHealth(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  const port = await findFreePort(8787);
  console.log(`[launch] starting dashboard on port ${port}`);

  // Explore-only: HELIUS_MAINNET_URL deliberately unset.
  const server = spawn('npm', ['--workspace', 'bots', 'run', 'server'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const healthy = await waitForHealth(port);
  if (!healthy) {
    console.error('[launch] server did not become healthy in time');
    server.kill();
    process.exit(1);
  }

  const url = `http://localhost:${port}/dashboard`;
  const [cmd, args] = browserOpenCommand(process.platform, url);
  spawn(cmd, args, { stdio: 'ignore', shell: process.platform === 'win32' }).on('error', () => {});
  console.log(`[launch] dashboard ready — open ${url}`);
}

// Only run main() when executed directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('launch.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
