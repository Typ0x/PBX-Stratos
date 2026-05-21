#!/usr/bin/env node
/**
 * scripts/screenshot-theme-audit.mjs
 *
 * Comprehensive per-theme screenshot pipeline. For each of the 6 themes:
 *   - Copy themes/<id>.css → bots/src/server/active-theme.css
 *   - Fresh Chromium context (no CSS cache carryover)
 *   - Navigate to /dashboard, set onboarding flag done, screenshot:
 *       01 discover, 02 leaderboard, 03 strategies, 04 paper, 05 live,
 *       06 health, 07 achievements
 *   - Trigger key modals (08 onboarding, 09 backup if visible)
 *
 * Total expected output: ~42-48 PNGs under screenshots/audit/.
 *
 * Restores `lambo` as the active theme at the end (user is on
 * crypto-bro). Server reads the theme file lazily so no pm2 restart
 * is needed — the cache-bust query on the link tag handles staleness.
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
const RESTORE  = 'lambo';
const DASH_URL = process.env.STRATOS_DASHBOARD_BASE || 'http://127.0.0.1:8787';
const OUT_DIR  = join(REPO_ROOT, 'screenshots', 'audit');
const THEME_SRC_DIR = join(REPO_ROOT, 'themes');
const ACTIVE_THEME_DST = join(REPO_ROOT, 'bots', 'src', 'server', 'active-theme.css');
const VIEWPORT = { width: 1440, height: 900 };

// Allow running for a single theme via CLI arg, e.g.
//   node scripts/screenshot-theme-audit.mjs lambo
const ARG_THEME = process.argv[2];

function readToken() {
  // Try the two known locations: the original `.pbx-bots/local.env`
  // (legacy / per pbx-bots starter), and the PBX Stratos runtime path
  // `.pbx-stratos-runtime/bots/local.env` which the current install uses.
  const candidates = [
    join(homedir(), '.pbx-stratos-runtime', 'bots', 'local.env'),
    join(process.env.STRATOS_BOTS_DATA_DIR ?? join(homedir(), '.pbx-bots'), 'local.env'),
  ];
  for (const path of candidates) {
    try {
      const content = readFileSync(path, 'utf8');
      const m = /^BOT_API_TOKEN=(\S+)\s*$/m.exec(content);
      if (m) return m[1];
    } catch {}
  }
  throw new Error(`no BOT_API_TOKEN found in any of: ${candidates.join(', ')}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Per-view settle times. Achievements + Health pull bigger payloads
// (markdown render + 7-check fan-out) so they need a longer beat.
const SETTLE_MS = {
  default:      1100,
  achievements: 4500,
  health:       4500,
  leaderboard:  2000,
};

async function screenshotView(page, dataView, file) {
  const btn = page.locator(`[data-view="${dataView}"]`);
  if (await btn.count() === 0) {
    console.error(`  [skip] no [data-view="${dataView}"] nav`);
    return;
  }
  await btn.first().click();
  await sleep(SETTLE_MS[dataView] ?? SETTLE_MS.default);
  // For achievements/health, wait specifically until the "Loading…" text
  // is gone (best-effort; falls through after the settle timeout).
  if (dataView === 'achievements' || dataView === 'health') {
    try {
      await page.waitForFunction(() => {
        const host = document.getElementById('view-' + (window.location.hash || ''));
        return !document.body.innerText.match(/Loading (achievements|health)…/);
      }, { timeout: 4000 });
    } catch {}
  }
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  ${dataView} → ${file}`);
}

async function shootTheme(browser, theme, token) {
  const src = join(THEME_SRC_DIR, `${theme}.css`);
  copyFileSync(src, ACTIVE_THEME_DST);
  console.log(`[theme:${theme}] copied → active-theme.css`);

  const ctx = await browser.newContext({ viewport: VIEWPORT });
  await ctx.addInitScript((t) => {
    try { localStorage.setItem('STRATOS_BOT_API_TOKEN', t); } catch {}
    try { localStorage.setItem('pbx_onboarding_v1_done', '1'); } catch {}
  }, token);

  const page = await ctx.newPage();
  page.on('pageerror', e => console.error(`  [pageerr]`, e.message));

  const url = `${DASH_URL}/dashboard?_t=${Date.now()}_${theme}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await sleep(1500);

  // Standard 7 views.
  await screenshotView(page, 'discover',     join(OUT_DIR, `${theme}-01-discover.png`));
  await screenshotView(page, 'leaderboard',  join(OUT_DIR, `${theme}-02-leaderboard.png`));
  await screenshotView(page, 'strategies',   join(OUT_DIR, `${theme}-03-strategies.png`));
  await screenshotView(page, 'paper',        join(OUT_DIR, `${theme}-04-paper.png`));
  await screenshotView(page, 'live',         join(OUT_DIR, `${theme}-05-live.png`));
  await screenshotView(page, 'health',       join(OUT_DIR, `${theme}-06-health.png`));
  await screenshotView(page, 'achievements', join(OUT_DIR, `${theme}-07-achievements.png`));

  // Onboarding tour, step 1. Clear the done flag and reload, then wait
  // for the modal to materialize.
  await ctx.clearCookies();
  await page.evaluate(() => {
    try { localStorage.removeItem('pbx_onboarding_v1_done'); } catch {}
  });
  await page.goto(`${DASH_URL}/dashboard?_t=${Date.now()}_${theme}_onb`, {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await sleep(2000); // tour fires on a small delay after auth
  // Best-effort: take the screenshot whether or not the modal shows.
  const onbFile = join(OUT_DIR, `${theme}-08-onboard.png`);
  await page.screenshot({ path: onbFile, fullPage: false });
  console.log(`  onboarding → ${onbFile}`);

  // Backup modal — open via the banner button if it appears.
  // Note: in many local installs the mnemonic is already verified, so the
  // banner won't show. We try; if the banner element isn't visible we
  // skip silently.
  try {
    await page.evaluate(() => {
      try { localStorage.setItem('pbx_onboarding_v1_done', '1'); } catch {}
    });
    await page.goto(`${DASH_URL}/dashboard?_t=${Date.now()}_${theme}_backup`, {
      waitUntil: 'networkidle', timeout: 30000,
    });
    await sleep(1500);
    const open = page.locator('#backup-banner-open');
    if (await open.count() > 0 && await open.first().isVisible()) {
      await open.first().click();
      await sleep(800);
      const f = join(OUT_DIR, `${theme}-09-backup.png`);
      await page.screenshot({ path: f, fullPage: false });
      console.log(`  backup → ${f}`);
    } else {
      console.log(`  backup → (banner not visible, skipped)`);
    }
  } catch (e) {
    console.error(`  [backup-err]`, e.message);
  }

  await ctx.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const token = readToken();
  console.log(`[audit] token loaded (${token.length} chars)`);

  const browser = await chromium.launch({ headless: true });

  const themes = ARG_THEME ? [ARG_THEME] : THEMES;
  for (const theme of themes) {
    if (!THEMES.includes(theme)) {
      console.error(`[audit] unknown theme: ${theme}`);
      continue;
    }
    await shootTheme(browser, theme, token);
  }

  // Restore lambo unless a single-theme run was requested (in which case
  // leave whatever you were just iterating on active so iteration is fast).
  if (!ARG_THEME) {
    copyFileSync(join(THEME_SRC_DIR, `${RESTORE}.css`), ACTIVE_THEME_DST);
    console.log(`[audit] restored ${RESTORE}.css as active`);
  } else {
    console.log(`[audit] single-theme run; leaving ${ARG_THEME}.css active`);
  }

  await browser.close();
  console.log('[audit] done.');
}

main().catch(e => { console.error('[audit] fatal:', e); process.exit(1); });
