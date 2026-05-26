// example extension client logic
// Scoped to #ext-example-root by the dashboard's extension loader
// All DOM queries MUST be relative to the panel's root element (#ext-example-root)
// Per the sandbox: no DOM access outside the panel, no external network, no wallet/secrets

(function () {
  'use strict';

  const EXT_ROOT_ID = 'ext-example-root';
  const REFRESH_INTERVAL_MS = 60 * 1000;  // 60s per manifest
  const API_ENDPOINT = '/api/alerts';

  // Get the panel root (auto-injected by dashboard)
  const root = document.getElementById(EXT_ROOT_ID);
  if (!root) {
    console.warn('[ext:example] root element not found — extension not loaded into DOM');
    return;
  }

  const countEl = root.querySelector('#ext-example-count');
  const footEl = root.querySelector('#ext-example-foot');

  if (!countEl || !footEl) {
    console.warn('[ext:example] expected DOM elements missing — panel.html may be malformed');
    return;
  }

  let lastRefreshMs = 0;
  let pollHandle = null;

  /**
   * Fetch alert count from /api/alerts, count entries from last 24h.
   * Updates DOM.
   */
  async function refresh() {
    try {
      const res = await fetch(`${API_ENDPOINT}?limit=200`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });

      if (!res.ok) {
        countEl.textContent = '!';
        countEl.dataset.empty = 'true';
        footEl.textContent = `error ${res.status} • try again in 60s`;
        return;
      }

      const data = await res.json();
      const alerts = Array.isArray(data) ? data : (data.alerts || []);

      const nowMs = Date.now();
      const dayAgoMs = nowMs - (24 * 60 * 60 * 1000);

      const recent = alerts.filter(a => {
        const ts = a.ts || a.ts_ms || (a.ts_iso ? new Date(a.ts_iso).getTime() : 0);
        return ts >= dayAgoMs;
      });

      const count = recent.length;
      countEl.textContent = String(count);
      countEl.dataset.empty = count === 0 ? 'true' : 'false';

      lastRefreshMs = nowMs;
      footEl.textContent = `last refreshed ${formatAge(nowMs - lastRefreshMs)} ago`;

      // Color hint: 0-2 = ok, 3-9 = warn, 10+ = error
      countEl.style.color = count === 0
        ? 'var(--text-muted, #888)'
        : (count < 10 ? 'var(--text-warn, #facc15)' : 'var(--text-error, #ef4444)');

    } catch (err) {
      console.warn('[ext:example] refresh failed:', err);
      countEl.textContent = '?';
      footEl.textContent = `fetch failed • try again in 60s`;
    }
  }

  /**
   * Tick footer's "last refreshed Xs ago" every second so it stays live.
   */
  function tickFooter() {
    if (lastRefreshMs === 0) {
      footEl.textContent = 'never refreshed';
      return;
    }
    const ageMs = Date.now() - lastRefreshMs;
    footEl.textContent = `last refreshed ${formatAge(ageMs)} ago`;
  }

  function formatAge(ms) {
    if (ms < 1000) return '0s';
    if (ms < 60000) return Math.floor(ms / 1000) + 's';
    if (ms < 3600000) return Math.floor(ms / 60000) + 'm';
    return Math.floor(ms / 3600000) + 'h';
  }

  // Initial load
  refresh();

  // Periodic refresh
  pollHandle = setInterval(refresh, REFRESH_INTERVAL_MS);

  // Footer tick (1s)
  setInterval(tickFooter, 1000);

  // Cleanup on panel removal (if dashboard supports it)
  if (window.__pbxRegisterExtensionCleanup) {
    window.__pbxRegisterExtensionCleanup('example', () => {
      if (pollHandle) clearInterval(pollHandle);
    });
  }
})();
