#!/usr/bin/env node
/**
 * scripts/screenshot-onboarding.mjs
 *
 * Drive a headless Chromium through the dashboard onboarding overlay
 * and screenshot each step. Used to verify the UI matches the existing
 * dashboard theme (visual review by a human or vision model).
 *
 * Usage:
 *   node scripts/screenshot-onboarding.mjs
 *
 * Output:
 *   screenshots/onboard-step-01.png ... onboard-step-14.png
 *   screenshots/onboard-full-dashboard.png (after dismiss)
 *
 * Pre-reqs:
 *   - pm2 fleet must be running with bear-watch-server online at :8787
 *   - ~/.pbx-bots/local.env must exist with BOT_API_TOKEN line
 *   - playwright + chromium installed (npm install + npx playwright install chromium)
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const DASH_URL = process.env.STRATOS_DASHBOARD_BASE || 'http://127.0.0.1:8787';
const OUT_DIR  = join(process.cwd(), 'screenshots');
const VIEWPORT = { width: 1280, height: 800 };

function readTokenFromLocalEnv() {
  const path = join(process.env.STRATOS_BOTS_DATA_DIR ?? join(homedir(), '.pbx-bots'), 'local.env');
  try {
    const content = readFileSync(path, 'utf8');
    const m = /^BOT_API_TOKEN=(\S+)\s*$/m.exec(content);
    if (!m) throw new Error(`no BOT_API_TOKEN= line in ${path}`);
    return m[1];
  } catch (e) {
    console.error(`[screenshot] could not read token from ${path}: ${e.message}`);
    process.exit(1);
  }
}

async function waitFor(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const token = readTokenFromLocalEnv();
  console.log(`[screenshot] token read (${token.length} chars, not echoed)`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: VIEWPORT });

  // Pre-inject the auth token AND clear the onboarding-done flag so the
  // overlay always re-appears for screenshot runs. addInitScript runs
  // before any page script.
  await ctx.addInitScript((t) => {
    try { localStorage.setItem('STRATOS_BOT_API_TOKEN', t); } catch {}
    try { localStorage.removeItem('pbx_onboarding_v1_done'); } catch {}
  }, token);

  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  page.on('console', m => { if (m.type() === 'error') console.error('[browser-err]', m.text()); });

  console.log(`[screenshot] navigating to ${DASH_URL}/dashboard`);
  await page.goto(`${DASH_URL}/dashboard`, { waitUntil: 'networkidle', timeout: 30000 });
  await waitFor(800); // let any post-load JS settle

  // Wait for the onboarding overlay to be present + visible.
  const overlay = page.locator('#onboard-modal');
  await overlay.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {
    console.error('[screenshot] onboard-overlay did not appear within 8s — is the overlay code deployed?');
  });

  // Step through the tutorial. The onboarding controller exposes
  // either a button#onboard-next or step dots — try the Next button.
  const TOTAL_STEPS = 12;
  for (let step = 1; step <= TOTAL_STEPS; step++) {
    const file = join(OUT_DIR, `onboard-step-${String(step).padStart(2, '0')}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`[screenshot] step ${step}/${TOTAL_STEPS} → ${file}`);
    if (step < TOTAL_STEPS) {
      // The new tour has action-gated steps that wait for real user
      // clicks (Discover, Decode, etc). For the screenshot pass we
      // prefer the "Just continue →" fallback link if present —
      // it advances without firing the real action. Falls back to
      // clicking #onboard-next when there's no gate.
      const skipGate = page.locator('.onboard-skip-gate');
      if (await skipGate.count() > 0 && await skipGate.first().isVisible()) {
        await skipGate.first().click().catch(() => {});
      } else {
        const next = page.locator('#onboard-next');
        if (await next.count() === 0) { console.error('[screenshot] #onboard-next not found, aborting'); break; }
        await next.click();
      }
      await waitFor(600); // allow view-switch animations to settle
    }
  }

  // Final "finish" click on step 14 to dismiss the overlay, then
  // screenshot the now-visible dashboard underneath.
  const finishBtn = page.locator('#onboard-finish, #onboard-next');
  if (await finishBtn.count() > 0) {
    await finishBtn.last().click().catch(() => {});
    await waitFor(900);
  }
  const dashboardShot = join(OUT_DIR, 'onboard-99-dashboard-after-dismiss.png');
  await page.screenshot({ path: dashboardShot, fullPage: false });
  console.log(`[screenshot] post-dismiss dashboard → ${dashboardShot}`);

  await browser.close();
  console.log(`[screenshot] done. ${OUT_DIR}`);
}

main().catch(e => { console.error('[screenshot] fatal:', e); process.exit(1); });
