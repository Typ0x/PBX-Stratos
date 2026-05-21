#!/usr/bin/env node
/**
 * scripts/screenshot-new-pages.mjs
 *
 * Drive a headless Chromium through the dashboard's new Health and
 * Achievements pages and screenshot each. Used to verify the UI
 * matches the existing dashboard look + the data renders correctly.
 *
 * Skips the onboarding tour by pre-setting the
 * `pbx_onboarding_v1_done` localStorage flag.
 *
 * Usage:
 *   node scripts/screenshot-new-pages.mjs
 *
 * Output:
 *   screenshots/new-health.png
 *   screenshots/new-achievements.png
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DASH_URL = process.env.STRATOS_DASHBOARD_BASE || 'http://127.0.0.1:8787';
const OUT_DIR  = join(process.cwd(), 'screenshots');
const VIEWPORT = { width: 1440, height: 900 }; // matches max-w-[1440px] shell

function readTokenFromLocalEnv() {
  const path = join(process.env.STRATOS_BOTS_DATA_DIR ?? join(homedir(), '.pbx-bots'), 'local.env');
  try {
    const content = readFileSync(path, 'utf8');
    const m = /^BOT_API_TOKEN=(\S+)\s*$/m.exec(content);
    if (!m) throw new Error(`no BOT_API_TOKEN= line in ${path}`);
    return m[1];
  } catch (e) {
    console.error(`[screenshot] could not read token: ${e.message}`);
    process.exit(1);
  }
}

const waitFor = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const token = readTokenFromLocalEnv();
  console.log(`[screenshot] token read (${token.length} chars)`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: VIEWPORT });

  // Pre-inject auth token + skip the onboarding tour.
  await ctx.addInitScript((t) => {
    try { localStorage.setItem('STRATOS_BOT_API_TOKEN', t); } catch {}
    try { localStorage.setItem('pbx_onboarding_v1_done', '1'); } catch {}
  }, token);

  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  page.on('console', m => { if (m.type() === 'error') console.error('[browser-err]', m.text()); });

  console.log(`[screenshot] navigating to ${DASH_URL}/dashboard`);
  await page.goto(`${DASH_URL}/dashboard`, { waitUntil: 'networkidle', timeout: 30000 });
  await waitFor(1200); // let post-load JS settle

  // Health page
  const healthBtn = page.locator('[data-view="health"]');
  if (await healthBtn.count() > 0) {
    await healthBtn.first().click();
    await waitFor(1500); // let data fetch + render
    const file = join(OUT_DIR, 'new-health.png');
    await page.screenshot({ path: file, fullPage: true });
    console.log(`[screenshot] Health → ${file}`);
  } else {
    console.error('[screenshot] [data-view="health"] nav button not found');
  }

  // Achievements page
  const achBtn = page.locator('[data-view="achievements"]');
  if (await achBtn.count() > 0) {
    await achBtn.first().click();
    await waitFor(1500);
    const file = join(OUT_DIR, 'new-achievements.png');
    await page.screenshot({ path: file, fullPage: true });
    console.log(`[screenshot] Achievements → ${file}`);
  } else {
    console.error('[screenshot] [data-view="achievements"] nav button not found');
  }

  await browser.close();
  console.log('[screenshot] done.');
}

main().catch(e => { console.error('[screenshot] fatal:', e); process.exit(1); });
