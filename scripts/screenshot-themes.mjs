#!/usr/bin/env node
/**
 * scripts/screenshot-themes.mjs
 *
 * Loops through all 6 theme CSS files, copies each to active-theme.css,
 * then loads the dashboard in chromium and screenshots it. Produces
 * one screenshots/theme-<id>.png per theme. Restores `lambo` as active
 * at the end (user is on crypto-bro personality).
 *
 * No pm2 restart needed — the /active-theme.css route reads the file
 * lazily on each request. Browser cache is defeated by a unique
 * cache-bust query string per theme.
 *
 * Usage:
 *   node scripts/screenshot-themes.mjs
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = join(__dirname, '..');

const THEMES   = ['default', 'lambo', 'camo', 'beach', 'academia', 'matrix'];
const RESTORE  = 'lambo'; // user is on crypto-bro
const DASH_URL = process.env.STRATOS_DASHBOARD_BASE || 'http://127.0.0.1:8787';
const OUT_DIR  = join(REPO_ROOT, 'screenshots');
const THEME_SRC_DIR = join(REPO_ROOT, 'themes');
const ACTIVE_THEME_DST = join(REPO_ROOT, 'bots', 'src', 'server', 'active-theme.css');
const VIEWPORT = { width: 1440, height: 900 };

function readToken() {
  const path = join(process.env.STRATOS_BOTS_DATA_DIR ?? join(homedir(), '.pbx-bots'), 'local.env');
  const content = readFileSync(path, 'utf8');
  const m = /^BOT_API_TOKEN=(\S+)\s*$/m.exec(content);
  if (!m) throw new Error(`no BOT_API_TOKEN in ${path}`);
  return m[1];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const token = readToken();
  console.log(`[screenshot] token read (${token.length} chars)`);

  const browser = await chromium.launch({ headless: true });

  for (const theme of THEMES) {
    const src = join(THEME_SRC_DIR, `${theme}.css`);
    copyFileSync(src, ACTIVE_THEME_DST);
    console.log(`[screenshot] copied ${theme}.css → active-theme.css`);

    // Fresh browser context per theme — guarantees no stale CSS in
    // memory/disk cache. addInitScript pre-loads the auth token and
    // suppresses the onboarding tour.
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    await ctx.addInitScript((t) => {
      try { localStorage.setItem('STRATOS_BOT_API_TOKEN', t); } catch {}
      try { localStorage.setItem('pbx_onboarding_v1_done', '1'); } catch {}
    }, token);

    const page = await ctx.newPage();
    page.on('pageerror', e => console.error(`[pageerror:${theme}]`, e.message));

    // Unique cache-bust per theme so the link tag pulls fresh CSS.
    const url = `${DASH_URL}/dashboard?_t=${Date.now()}_${theme}`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(1500); // let post-load JS + theme paint settle

    const file = join(OUT_DIR, `theme-${theme}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`[screenshot] ${theme} → ${file}`);

    await ctx.close();
  }

  // Restore the user's active personality (crypto-bro = lambo).
  copyFileSync(join(THEME_SRC_DIR, `${RESTORE}.css`), ACTIVE_THEME_DST);
  console.log(`[screenshot] restored ${RESTORE}.css as active`);

  await browser.close();
  console.log('[screenshot] done.');
}

main().catch(e => { console.error('[screenshot] fatal:', e); process.exit(1); });
