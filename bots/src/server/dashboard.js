  // ============ DOM helpers (no innerHTML — XSS-safe by construction) ============
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'style') node.style.cssText = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, String(v));
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  const replace = (parent, ...nodes) => { parent.replaceChildren(...nodes.flat().filter(Boolean)); };
  const t = (s) => document.createTextNode(String(s));

  // ============ auth ============
  let TOKEN = localStorage.getItem('STRATOS_BOT_API_TOKEN');
  // On localhost the server bypasses bearer auth for loopback sockets, so
  // we don't need a token at all — but we still grab the autogen value from
  // /api/local-token to keep the same code path (bearer header is harmless
  // when the server already trusted us). This kills the copy-paste step.
  const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '::1';
  const showAuth = () => { document.getElementById('auth-overlay').classList.remove('hidden'); document.getElementById('token-input').focus(); };
  const hideAuth = () => document.getElementById('auth-overlay').classList.add('hidden');
  document.getElementById('token-save').onclick = () => {
    const v = document.getElementById('token-input').value.trim();
    if (!v) return;
    TOKEN = v;
    localStorage.setItem('STRATOS_BOT_API_TOKEN', v);
    hideAuth();
    refreshAll();
    setInterval(refreshAll, 15000);
  };
  document.getElementById('token-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('token-save').click();
  });

  async function api(path) {
    const headers = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
    const res = await fetch(path, { headers });
    if (res.status === 401) {
      if (IS_LOCAL) {
        // Shouldn't happen — server bypasses auth on loopback — but surface
        // it rather than silently looping if something is misconfigured.
        throw new Error('localhost returned 401 (server auth misconfigured)');
      }
      localStorage.removeItem('STRATOS_BOT_API_TOKEN');
      TOKEN = null;
      const errEl = document.getElementById('token-err');
      errEl.textContent = 'Bad token. Try again.';
      errEl.classList.remove('hidden');
      showAuth();
      throw new Error('unauthorized');
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // Same auth flow as api() but for POST. Body is optional; only when
  // present do we set content-type — Fastify's parser 400s on an empty
  // body if content-type: application/json is declared. Returns parsed
  // JSON response (or {} for empty 2xx bodies).
  async function apiPost(path, body) {
    const headers = {};
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
    const init = { method: 'POST', headers };
    if (body != null) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j && j.error) msg += ' — ' + j.error; } catch {}
      throw new Error(msg);
    }
    try { return await res.json(); } catch { return {}; }
  }

  // ============ backup modal ============
  //
  // Three-step UX: reveal 24 words → verify by re-typing 3 random ones
  // → success. The modal opens whenever the server says a mnemonic
  // exists but no verifiedAt timestamp has been recorded. It also
  // re-opens from the persistent amber banner.

  const backupOverlay = () => document.getElementById('backup-overlay');
  const backupBanner = () => document.getElementById('backup-banner');
  let backupVerifyPositions = [];
  let backupLiveBotCount = 0;  // funded-bot count, sent with a snooze

  function openBackupModal() {
    backupOverlay().classList.remove('hidden');
    // Always open on the gate pre-screen — the 24 words are never fetched
    // or rendered until the user explicitly clicks through it. This keeps
    // a seed phrase off-screen (and out of the network tab) for anyone who
    // opens the dashboard while livestreaming or screen-sharing.
    showBackupStep('gate');
  }
  function closeBackupModal() {
    backupOverlay().classList.add('hidden');
    // Scrub the rendered words from the DOM on close so a dismissed modal
    // doesn't leave the seed sitting in the page for later inspection.
    gridPlaceholder('', 'muted');
  }
  function showBackupStep(step) {
    for (const s of ['gate', 'reveal', 'verify', 'success']) {
      const elx = document.getElementById('backup-step-' + s);
      if (elx) elx.classList.toggle('hidden', s !== step);
    }
  }

  function gridPlaceholder(text, cls) {
    const grid = document.getElementById('backup-mnemonic-grid');
    while (grid.firstChild) grid.removeChild(grid.firstChild);
    const div = document.createElement('div');
    div.className = 'col-span-4 text-center text-[12px] ' + cls;
    div.textContent = text;
    grid.append(div);
  }

  async function loadMnemonicIntoGrid() {
    gridPlaceholder('loading…', 'muted');
    try {
      const res = await fetch('/api/local-mnemonic');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const { mnemonic } = await res.json();
      const words = String(mnemonic).split(/\s+/);
      const grid = document.getElementById('backup-mnemonic-grid');
      while (grid.firstChild) grid.removeChild(grid.firstChild);
      words.forEach((w, i) => {
        const cell = document.createElement('div');
        cell.className = 'flex items-baseline gap-2 px-3 py-2 bg-[#131720] rounded border border-zinc-800/60 mono text-sm';
        const num = document.createElement('span');
        // select-none keeps the position number out of a copy selection —
        // pasting into a wallet must yield just the words, no "1." prefixes.
        num.className = 'text-zinc-500 text-[11px] w-6 text-right select-none';
        num.textContent = (i + 1) + '.';
        const word = document.createElement('span');
        word.className = 'text-zinc-100';
        word.textContent = w;
        cell.append(num, word);
        grid.append(cell);
      });
    } catch (err) {
      gridPlaceholder('failed to load mnemonic: ' + (err && err.message ? err.message : String(err)), 'text-rose-400');
    }
  }

  function pickVerifyPositions(count, total) {
    if (count == null) count = 3;
    if (total == null) total = 24;
    const all = Array.from({ length: total }, (_, i) => i);
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, count).sort((a, b) => a - b);
  }

  function renderVerifyInputs() {
    backupVerifyPositions = pickVerifyPositions();
    const host = document.getElementById('backup-verify-inputs');
    while (host.firstChild) host.removeChild(host.firstChild);
    backupVerifyPositions.forEach((pos) => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-3';
      const label = document.createElement('label');
      label.className = 'w-24 text-[12px] muted mono';
      label.textContent = 'Word #' + (pos + 1);
      const input = document.createElement('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.className = 'flex-1 bg-[#0a0d13] border border-zinc-700 rounded px-3 py-2 mono text-sm value focus:outline-none focus:border-emerald-500';
      input.dataset.position = String(pos);
      row.append(label, input);
      host.append(row);
    });
    const first = host.querySelector('input');
    if (first) first.focus();
    document.getElementById('backup-verify-err').classList.add('hidden');
  }

  async function submitVerify() {
    const inputs = Array.from(document.querySelectorAll('#backup-verify-inputs input'));
    const errEl = document.getElementById('backup-verify-err');
    errEl.classList.add('hidden');
    const positions = [];
    const words = [];
    for (const inp of inputs) {
      const v = inp.value.trim().toLowerCase();
      if (!v) {
        errEl.textContent = 'Fill in all words first';
        errEl.classList.remove('hidden');
        return;
      }
      positions.push(Number(inp.dataset.position));
      words.push(v);
    }
    const submitBtn = document.getElementById('backup-verify-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifying…';
    try {
      await apiPost('/api/funder/backup/verify', { positions, words });
      showBackupStep('success');
      backupBanner().classList.add('hidden');
      setTimeout(closeBackupModal, 1800);
      refreshAll();
    } catch (err) {
      errEl.textContent = (err && err.message) ? err.message : 'Verification failed — check the words and try again.';
      errEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Verify';
    }
  }

  function initBackupModal() {
    document.getElementById('backup-later').addEventListener('click', async () => {
      closeBackupModal();
      // Snooze the nag: 1st dismissal 24h, then weekly. Best-effort —
      // a failed POST just means it may reappear sooner.
      try {
        await apiPost('/api/funder/backup/snooze', { liveBots: backupLiveBotCount });
      } catch { /* non-critical reminder state */ }
    });
    // Gate → reveal: this explicit click is the ONLY thing that fetches
    // /api/local-mnemonic and renders the words. Nothing loads them on
    // dashboard open.
    document.getElementById('backup-reveal-confirm').addEventListener('click', () => {
      loadMnemonicIntoGrid();
      showBackupStep('reveal');
    });
    document.getElementById('backup-wrote-it-down').addEventListener('click', () => {
      renderVerifyInputs();
      showBackupStep('verify');
    });
    document.getElementById('backup-verify-back').addEventListener('click', () => {
      showBackupStep('reveal');
    });
    document.getElementById('backup-verify-submit').addEventListener('click', submitVerify);
    document.getElementById('backup-verify-inputs').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitVerify();
    });
    document.getElementById('backup-banner-open').addEventListener('click', () => {
      openBackupModal();
    });
  }

  /** Drive modal + banner visibility from /dashboard/state. Call this on
   *  every refresh; it only toggles classes when state changes.
   *
   *  The recovery-phrase prompt is gated on the user actually having a
   *  bot. A fresh user exploring the lab has no funds at risk — nagging
   *  them to write down 24 words before they've done anything is a
   *  jarring first impression. Once a bot exists the mnemonic protects
   *  real funds, and the prompt is appropriate. */
  function applyBackupGate(s) {
    const stateBackup = s && s.backup;
    const hasBots = !!(s && Array.isArray(s.bots) && s.bots.length > 0);
    if (!hasBots || !stateBackup || !stateBackup.mnemonicAvailable) {
      backupBanner().classList.add('hidden');
      closeBackupModal();
      return;
    }
    if (stateBackup.verifiedAt) {
      // Verified — never prompt or check again.
      backupBanner().classList.add('hidden');
      return;
    }
    backupBanner().classList.remove('hidden');
    backupLiveBotCount = stateBackup.liveBotCount || 0;
    // Risk-informed line: how many bot wallets this phrase recovers.
    const riskLine = document.getElementById('backup-risk-line');
    if (riskLine) {
      const n = s.bots.length;
      riskLine.textContent = n + (n === 1 ? ' bot wallet depends' : ' bot wallets depend')
        + ' on this phrase — back it up.';
      riskLine.classList.remove('hidden');
    }
    // Auto-pop follows the server's cadence (shouldPrompt = snooze
    // elapsed, or a newly funded bot). Still only once per page load so
    // a 15s state refresh can't re-pop within a session.
    if (stateBackup.shouldPrompt && !backupOverlay().dataset.shownOnce) {
      backupOverlay().dataset.shownOnce = '1';
      // Opens on the gate pre-screen only — the words are not fetched here.
      openBackupModal();
    }
  }

  /** First-run layout. A pristine user (no bots, hasn't started
   *  discovery) sees ONLY the welcome hero — the funder card, the
   *  workflow card, and the analytics panels are empty or irrelevant
   *  noise at that point (the funder card even contradicts the hero's
   *  "no funds needed to explore"). Each piece reveals as it becomes
   *  relevant: workflow + funder once they start discovering, analytics
   *  once a bot exists. */
  function renderWelcomeHero(s) {
    const hero = document.getElementById('welcome-hero');
    if (!hero) return;
    const hasBots = !!(s && Array.isArray(s.bots) && s.bots.length > 0);
    const workflowStarted =
      !document.getElementById('workflow-status').classList.contains('hidden')
      || (typeof wfWallets !== 'undefined' && wfWallets.size > 0);
    // heroEngaged: once the user clicks the hero CTA the cards stay
    // revealed, even if the workflow hasn't emitted anything yet.
    const pristine = !hasBots && !workflowStarted && !heroEngaged;

    hero.classList.toggle('hidden', hasBots);
    // Funder card moved to the Live trading view — visibility is now
    // governed by which sidebar tab is active (showView), not by the
    // pristine flag. The pristine hide only applies to Discover-view
    // siblings (workflow-card). The funder element is left out of
    // this toggle so it doesn't end up double-hidden when the user
    // clicks into Live trading.
    document.getElementById('workflow-card').classList.toggle('hidden', pristine);
    // Performance / Trade history / Tick log / Backtest — only meaningful
    // once at least one bot exists.
    document.querySelectorAll('[data-analytics]').forEach((el) => {
      el.classList.toggle('hidden', !hasBots);
    });
    // Paper view empty-state — inverse of data-analytics. When there
    // are no bots, the analytics blocks are hidden AND #paper-empty is
    // shown so the user sees a "what is paper trading + how do I get a
    // bot" card instead of a totally blank screen. Once a bot lands,
    // the analytics surface and this empty card hides.
    document.getElementById('paper-empty')?.classList.toggle('hidden', hasBots);
    // Header: the Capital/NAV/PnL/Volume KPIs and the "show stopped"
    // toggle are a row of dead $0.00s for a user with no bots. Hide
    // them until there's a bot, so the header stays clean on first run.
    document.getElementById('header-kpis')?.classList.toggle('hidden', !hasBots);
    document.getElementById('show-stopped-wrap')?.classList.toggle('hidden', !hasBots);
    document.getElementById('fleet-mode-filter')?.classList.toggle('hidden', !hasBots);
  }

  async function bootstrapAuth() {
    // Try to pick up an auto-generated token from a local server. Two
    // failure modes worth handling explicitly:
    //   - 404: server is in production-style mode (BOT_API_TOKEN was
    //     pinned in env); fall back to localStorage / auth overlay.
    //   - network/JSON error: fall through the same way.
    if (IS_LOCAL) {
      try {
        const res = await fetch('/api/local-token');
        if (res.ok) {
          const j = await res.json();
          if (j && typeof j.token === 'string') TOKEN = j.token;
        }
      } catch {
        /* fall through */
      }
    }
    return Boolean(TOKEN);
  }

  // ============ formatters ============
  const fmtUsd = (n, d=2) => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(d);
  const fmtPct = (n, d=2) => (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
  const fmtAge = (ms) => {
    if (ms == null) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + (m%60) + 'm ago';
    return Math.floor(h/24) + 'd ago';
  };
  const fmtDuration = (ms) => {
    if (ms == null) return '—';
    const m = Math.floor(ms / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 48) return h + 'h ' + (m%60) + 'm';
    const d = Math.floor(h / 24);
    return d + 'd ' + (h%24) + 'h';
  };
  // Live-feel duration: D/H/M/S, omitting leading zero units. Used by
  // the bot age + last-fired badges, ticked once per second so the
  // dashboard feels alive.
  const fmtAlive = (ms) => {
    if (ms == null || ms < 0) return '—';
    const totalS = Math.floor(ms / 1000);
    const d = Math.floor(totalS / 86400);
    const h = Math.floor((totalS % 86400) / 3600);
    const m = Math.floor((totalS % 3600) / 60);
    const s = totalS % 60;
    const parts = [];
    if (d) parts.push(d + 'd');
    if (d || h) parts.push(h + 'h');
    if (d || h || m) parts.push(m + 'm');
    parts.push(s + 's');
    return parts.join(' ');
  };
  const REGION_COLORS = { CHI: '#f97316', NYC: '#38bdf8', TOR: '#a78bfa' };
  // Bot colors derive from the bot name so any newly-spawned strategy
  // gets a stable, distinct color without code edits. We hash the name
  // → hue (golden-angle stride for max separation), keeping S/L fixed
  // so all series read clearly on the dark chart background.
  const _botColorCache = {};
  function botColor(name) {
    if (_botColorCache[name]) return _botColorCache[name];
    if (!name) return '#94a3b8';
    let h = 2166136261 >>> 0; // FNV-1a 32-bit
    for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    // Golden-angle around the wheel produces well-separated hues even
    // for strings with similar prefixes (e.g. arb-spread, arb-spread-fast).
    const hue = (h * 137.508) % 360;
    const c = `hsl(${hue.toFixed(1)} 75% 62%)`;
    _botColorCache[name] = c;
    return c;
  }
  // Per-series visibility (legend click → toggle). Persisted in
  // localStorage so the user's hide/show choices survive page reloads.
  const HIDDEN_KEY = 'pbx-dash-hidden-series';
  let HIDDEN_SERIES;
  try { HIDDEN_SERIES = new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')); }
  catch { HIDDEN_SERIES = new Set(); }
  const colorClass = (n) => n > 0 ? 'text-emerald-400' : n < 0 ? 'text-rose-400' : 'text-zinc-400';
  const hms = (ts) => new Date(ts).toISOString().slice(11, 16);

  // ============ render: top bar ============
  function renderTopBar(s) {
    document.getElementById('kpi-capital').textContent = '$' + s.totalCapital.toFixed(2);
    document.getElementById('kpi-nav').textContent = '$' + s.totalNav.toFixed(2);
    const pnl = s.totalNav - s.totalCapital;
    const pct = s.totalCapital > 0 ? (pnl / s.totalCapital) * 100 : 0;
    const pnlEl = document.getElementById('kpi-pnl');
    pnlEl.textContent = fmtUsd(pnl) + ' ' + fmtPct(pct);
    pnlEl.className = 'mono text-base ' + colorClass(pnl);
    const volEl = document.getElementById('kpi-volume');
    if (volEl) {
      const v = s.totalVolumeUsd || 0;
      const swaps = s.totalSwaps || 0;
      volEl.textContent = (v >= 1000 ? '$' + (v / 1000).toFixed(2) + 'k' : '$' + v.toFixed(2))
        + ' · ' + swaps + ' swap' + (swaps === 1 ? '' : 's');
    }
    document.getElementById('kpi-last-tick').textContent = s.lastTickMs ? fmtAge(Date.now() - s.lastTickMs) : '—';
    document.getElementById('kpi-uptime').textContent = fmtDuration(s.serverUptimeMs);
    const pillNode = (text, ok) => {
      const cls = ok
        ? 'px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
        : 'px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20';
      return el('span', { class: cls }, text);
    };
    // Skip the "0/0 bots up" pill on a fresh dashboard — it's a dead
    // zero. Show it only once the user actually has bots.
    const pills = [pillNode('RPC ok', true)];
    if ((s.botsTotal ?? 0) > 0) {
      pills.unshift(pillNode(
        (s.botsRunning ?? 0) + '/' + (s.botsTotal ?? 0) + ' bots up',
        s.botsRunning === s.botsTotal));
    }
    replace(document.getElementById('health-pills'), ...pills);
  }

  // ============ render: funder CTA card ============
  // Per-bot funding requirement (USDC + SOL), used to compute capacity
  // ("can spawn N more bots") on the funder card. These match the
  // current spawn defaults; if those change, update here too.
  const PER_BOT_USDC = 50;
  const PER_BOT_SOL = 0.05;
  const SHORT_PUBKEY = (k) => k ? k.slice(0, 4) + '…' + k.slice(-4) : '';

  function renderFunder(s) {
    const host = document.getElementById('funder-card');
    if (!host) return;
    const f = s.funder;
    if (!f || !f.exists) {
      // Empty-state with an inline Create button. Disables itself during
      // the request to prevent double-create races, and shows the error
      // message inline so the user doesn't have to open devtools.
      const createBtn = el('button', {
        class: 'bg-emerald-500 text-[#0a0d13] font-medium rounded px-4 py-2 hover:bg-emerald-400 transition disabled:opacity-50 disabled:cursor-not-allowed',
      }, 'Create funder wallet');
      const errEl = el('div', { class: 'text-[12px] text-rose-400 mt-2 hidden' });
      createBtn.addEventListener('click', async () => {
        createBtn.disabled = true;
        createBtn.textContent = 'Creating…';
        errEl.classList.add('hidden');
        try {
          await apiPost('/funder/init');
          // Trigger an immediate refresh; the next /dashboard/state will
          // include the new pubkey + zero balances.
          refreshAll();
        } catch (err) {
          errEl.textContent = err.message || String(err);
          errEl.classList.remove('hidden');
          createBtn.disabled = false;
          createBtn.textContent = 'Create funder wallet';
        }
      });
      replace(host, el('div', { class: 'card rounded-xl p-5' },
        el('div', { class: 'text-sm font-semibold text-zinc-50 mb-1' }, 'No funder wallet yet'),
        el('div', { class: 'text-[12px] muted mb-4' },
          'Creates a new Solana keypair encrypted at rest on this server. You’ll then send USDC + SOL to its address to scale up the fleet.'),
        createBtn,
        errEl,
      ));
      return;
    }
    const sol = Number(f.solLamports || 0) / 1e9;
    const usdc = Number(f.usdcRaw || 0) / 1e6;
    const capByUsdc = Math.floor(usdc / PER_BOT_USDC);
    const capBySol = Math.floor(sol / PER_BOT_SOL);
    const capacity = Math.min(capByUsdc, capBySol);
    const bottleneck = capByUsdc <= capBySol ? 'USDC' : 'SOL';
    // Low-balance state: less than 2 bots' worth in either dimension.
    // Drives the call-to-action styling — when the funder is healthy
    // we keep the card understated; when it's low we light it up.
    const low = capacity < 2;
    const cardCls = 'card rounded-xl p-5 ' + (low
      ? 'border border-amber-500/40 bg-amber-500/[0.03]'
      : '');

    // Address copy button — simple click-to-clipboard with a transient
    // "copied" affordance so the user has feedback the action worked.
    const copyBtn = el('button', {
      class: 'mono text-[11px] px-2 py-1 rounded border border-zinc-700 hover:border-zinc-500 hover:text-zinc-100 transition',
    }, 'copy');
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(f.pubkey); copyBtn.textContent = 'copied ✓'; }
      catch { copyBtn.textContent = 'copy failed'; }
      setTimeout(() => { copyBtn.textContent = 'copy'; }, 1500);
    });

    const ctaText = low
      ? 'Funder is low — top up to keep spawning bots'
      : 'Send USDC + SOL here to scale up the fleet';

    const header = el('div', { class: 'flex items-baseline justify-between mb-3 gap-4' },
      el('div', null,
        el('div', { class: 'text-sm font-semibold text-zinc-50' }, 'Funder wallet'),
        el('div', { class: 'text-[12px] mt-0.5 ' + (low ? 'text-amber-400' : 'muted') }, ctaText),
      ),
      el('div', { class: 'text-right' },
        el('div', { class: 'label' }, 'Capacity'),
        el('div', { class: 'mono text-base ' + (low ? 'text-amber-400' : 'text-zinc-100') },
          capacity + ' bot' + (capacity === 1 ? '' : 's')),
        el('div', { class: 'text-[10px] muted' }, 'limited by ' + bottleneck),
      ),
    );

    const balRow = el('div', { class: 'grid grid-cols-3 gap-3 py-3 border-y border-zinc-800/60' },
      el('div', null,
        el('div', { class: 'label' }, 'USDC'),
        el('div', { class: 'mono text-base value' }, '$' + usdc.toFixed(2)),
        el('div', { class: 'text-[11px] muted' }, '~$' + PER_BOT_USDC + ' suggested starting balance · ' + capByUsdc + ' bots covered'),
      ),
      el('div', null,
        el('div', { class: 'label' }, 'SOL'),
        el('div', { class: 'mono text-base value' }, sol.toFixed(4)),
        el('div', { class: 'text-[11px] muted' }, '~' + PER_BOT_SOL + ' for gas · ' + capBySol + ' bots covered'),
      ),
      el('div', null,
        el('div', { class: 'label' }, 'Address'),
        el('div', { class: 'flex items-center gap-2' },
          el('span', { class: 'mono value text-base', title: f.pubkey }, SHORT_PUBKEY(f.pubkey)),
          copyBtn,
        ),
        el('a', {
          class: 'text-[11px] text-sky-400 hover:text-sky-300 underline-offset-2 hover:underline',
          href: 'https://solscan.io/account/' + f.pubkey,
          target: '_blank', rel: 'noopener',
        }, 'view on Solscan ↗'),
      ),
    );

    // Step-by-step instructions — keep it to actionable bullets so
    // the user knows exactly what to do without leaving the page.
    const steps = el('div', { class: 'mt-3 text-[12px] muted leading-6' },
      el('div', null, '1. Send USDC and SOL to the address above (mainnet)'),
      el('div', null, '2. Wait ~30s for the transfer to confirm'),
      el('div', null, '3. Run ',
        el('code', { class: 'mono text-zinc-300' }, 'pbx-bots remote spawn <name> <strategy> --confirm'),
        ' for each new bot'),
    );

    replace(host, el('div', { class: cardCls }, header, balRow, steps));
  }

  // ============ render: bot cards ============
  /** Lifetime PnL for a bot — money it has ACTUALLY made: realized
   *  round-trip P&L plus any open position's unrealized P&L. The %-base
   *  is derived as NAV minus that P&L, NOT `b.startingCapital`: that
   *  field can still carry a stale $10 default baseline, which made a
   *  freshly-funded 0-trade bot display a bogus +400%. A bot that has
   *  not traded now correctly reads a flat +0.00%. */
  function botLifetimePnl(b) {
    const usd = (b.realizedPnlUsd || 0)
      + (b.openPosition ? (b.openPosition.unrealizedPnlUsd || 0) : 0);
    const base = (b.nav || 0) - usd;
    const pct = base > 0 ? (usd / base) * 100 : 0;
    return { usd, pct };
  }

  /** Win-rate footer cell. Server text is "12/20 (60%)" or
   *  "0/0 (no exits)" — long enough to wrap mid-phrase in the narrow
   *  3-up stat grid. Split the parenthetical onto a smaller muted run so
   *  the cell stays on one line. */
  function winRateCell(text) {
    const wr = text || '—';
    const m = wr.match(/^(.+?)\s*(\(.+\))$/);
    return m
      ? el('div', { class: 'mono value leading-tight' }, m[1],
          el('span', { class: 'muted text-[10px] ml-1' }, m[2]))
      : el('div', { class: 'mono value' }, wr);
  }

  function botCard(b) {
    const accent = botColor(b.name);
    const { usd: lifetimePnlUsd, pct: lifetimePnlPct } = botLifetimePnl(b);

    // Unfunded bots have no real baseline — server marks them so we
    // can suppress the misleading "-100%" PnL display (default $10
    // baseline vs $0 NAV). Show a clear "UNFUNDED" pill instead.
    const isUnfunded = b.unfunded === true;

    const card = el('article', {
      class: 'card rounded-xl p-5 ' + (isUnfunded ? '' : (lifetimePnlUsd >= 0 ? 'glow-up' : 'glow-down')),
      style: '--accent: ' + accent + '; border-left: 3px solid ' + accent + ';',
    });

    // header
    const runBadge = el('span', {
      class: 'text-[10px] mono px-1.5 py-0.5 rounded ' + (b.running
        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
        : 'bg-zinc-700/40 text-zinc-400 border border-zinc-700'),
    }, b.running ? 'RUNNING' : 'STOPPED');
    // Paper / live mode badge. Paper bots move no real funds (simulated
    // balance); live bots trade real USDC. Absence of mode = paper.
    const isLive = b.mode === 'live';
    const modeBadge = el('span', {
      class: 'text-[10px] mono px-1.5 py-0.5 rounded ' + (isLive
        ? 'bg-rose-500/10 text-rose-300 border border-rose-500/30'
        : 'bg-sky-500/10 text-sky-300 border border-sky-500/30'),
      title: isLive
        ? 'Live bot — trades real USDC on Solana mainnet.'
        : 'Paper bot — simulated balance, no real funds move.',
    }, isLive ? 'LIVE' : 'PAPER');
    const unfundedBadge = isUnfunded
      ? el('span', {
          class: 'text-[10px] mono px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20',
          title: 'Spawn never transferred capital. Fund with: pbx-bots remote fund ' + b.name + ' --usdc 50 --sol 0.05',
        }, 'UNFUNDED')
      : null;
    const ageBadge = b.createdAtMs
      ? el('span', {
          class: 'text-[10px] mono muted tick-since',
          'data-tick-since': String(b.createdAtMs),
          'data-tick-prefix': 'up ',
          title: 'spawned ' + new Date(b.createdAtMs).toISOString().slice(0, 16).replace('T', ' '),
        }, 'up ' + fmtAlive(Date.now() - b.createdAtMs))
      : null;
    const lifetimeSubText = b.realizedPnlUsd
      ? fmtUsd(lifetimePnlUsd) + ' · ' + b.closedTrades + ' closed ' + fmtUsd(b.realizedPnlUsd)
      : fmtUsd(lifetimePnlUsd);

    // Top-right PnL block — shows "—" for unfunded bots so we don't
    // display a -100% loss against a phantom $10 baseline the bot
    // never actually had.
    const pnlBlock = isUnfunded
      ? el('div', { class: 'text-right' },
          el('div', { class: 'label' }, 'Lifetime PnL'),
          el('div', { class: 'text-2xl mono leading-none text-zinc-500' }, '—'),
          el('div', { class: 'text-[12px] mono opacity-80 muted' }, 'no capital yet'),
        )
      : el('div', { class: 'text-right' },
          el('div', { class: 'label' }, 'Lifetime PnL'),
          el('div', { class: 'text-2xl mono leading-none ' + colorClass(lifetimePnlUsd) }, fmtPct(lifetimePnlPct)),
          el('div', { class: 'text-[12px] mono opacity-80 ' + colorClass(lifetimePnlUsd) }, lifetimeSubText),
        );

    card.append(
      el('header', { class: 'flex items-baseline justify-between mb-4' },
        el('div', null,
          el('div', { class: 'flex items-center gap-2 flex-wrap' },
            el('span', { class: 'w-1.5 h-1.5 rounded-full', style: 'background:' + accent }),
            el('h3', { class: 'text-base font-semibold text-zinc-50' }, b.name),
            runBadge,
            modeBadge,
            ...(unfundedBadge ? [unfundedBadge] : []),
            ...(ageBadge ? [ageBadge] : []),
          ),
          el('div', { class: 'mono text-[12px] muted mt-0.5' }, b.strategyDesc || ''),
        ),
        pnlBlock,
      ),
    );

    // open position
    if (b.openPosition) {
      const op = b.openPosition;
      card.append(
        el('div', { class: 'grid grid-cols-2 gap-3 py-3 border-y border-zinc-800/60' },
          el('div', null,
            el('div', { class: 'label' }, 'Open position'),
            el('div', { class: 'mono text-base value' },
              op.tokens.toFixed(2) + ' ',
              el('span', { style: 'color:' + (REGION_COLORS[op.region] || '#94a3b8') }, op.region),
              op.costBasisUsdc != null ? el('span', { class: 'muted text-xs ml-2' }, '($' + op.costBasisUsdc.toFixed(2) + ' in)') : null,
            ),
            el('div', { class: 'text-[11px] muted mono' },
              '@ $' + op.entryPrice.toFixed(4) + ' · now $' + ((op.currentPrice ?? 0)).toFixed(4)),
          ),
          el('div', { class: 'text-right' },
            el('div', { class: 'label' }, 'Unrealized'),
            el('div', { class: 'mono text-base ' + colorClass(op.unrealizedPnlUsd) }, fmtUsd(op.unrealizedPnlUsd)),
            el('div', { class: 'text-[11px] muted mono' }, fmtPct(op.unrealizedPnlPct) + ' on entry'),
          ),
        ),
      );
    } else {
      card.append(
        el('div', { class: 'py-3 border-y border-zinc-800/60 text-center text-[12px] muted' },
          el('div', { class: 'label mb-1' }, 'Position'),
          el('div', { class: 'mono' },
            '$' + (b.usdcBalance || 0).toFixed(2) + ' ',
            el('span', { class: 'text-emerald-400/70' }, 'USDC idle'),
          ),
        ),
      );
    }

    // gauge
    if (b.gauge) {
      const g = b.gauge;
      const gaugeChildren = [];
      // gauge zones — entry-zone color comes from the active theme via
      // --theme-hero-glow (default falls back to emerald). Exit zone
      // stays semantic red across all themes since it signals "exit"
      // regardless of palette.
      if (g.exitZone) gaugeChildren.push(el('div', { class: 'gauge-zone', style: `left:${g.exitZone[0]}%; right:${100-g.exitZone[1]}%; background:#ef4444` }));
      if (g.entryZone) gaugeChildren.push(el('div', { class: 'gauge-zone', style: `left:${g.entryZone[0]}%; right:${100-g.entryZone[1]}%; background:var(--theme-hero-glow, #10b981)` }));
      for (const tk of g.ticks || []) {
        gaugeChildren.push(el('div', { class: 'gauge-tick', style: 'left:' + tk.pos + '%' }));
        gaugeChildren.push(el('div', { class: 'gauge-tick-label', style: 'left:' + tk.pos + '%' }, tk.label));
      }
      gaugeChildren.push(el('div', { class: 'gauge-needle', style: 'left:' + g.needlePos + '%' }));
      card.append(
        el('div', { class: 'pt-3' },
          el('div', { class: 'flex items-baseline justify-between mb-2' },
            el('div', { class: 'label' }, 'Signal · ' + g.label),
            el('div', { class: 'mono text-sm value' }, g.valueText),
          ),
          el('div', { class: 'gauge mb-5' }, ...gaugeChildren),
        ),
      );
    } else {
      card.append(el('div', { class: 'py-3 text-[11px] muted' }, 'no signal yet'));
    }

    // footer stats
    card.append(
      el('div', { class: 'grid grid-cols-3 gap-2 text-sm pt-2' },
        el('div', null, el('div', { class: 'label' }, 'Trades'), el('div', { class: 'mono value' }, String(b.totalTrades))),
        el('div', null, el('div', { class: 'label' }, 'Win rate'), winRateCell(b.winRateText)),
        el('div', null, el('div', { class: 'label' }, 'Last fired'),
          b.lastTradeMs
            ? el('div', { class: 'mono value tick-since', 'data-tick-since': String(b.lastTradeMs), 'data-tick-suffix': ' ago' }, fmtAlive(Date.now() - b.lastTradeMs) + ' ago')
            : el('div', { class: 'mono value' }, '—')),
      ),
    );

    // "Graduate to live" — only on paper bots that carry a decoded rule
    // (those are the ones the deploy modal can re-deploy). Re-runs the
    // full deploy flow in live mode, including the explicit
    // live-confirmation + predicate sign-off, so there's never a
    // one-click path from paper to real capital.
    if (!isLive && b.decodedRule && b.decodedRule.entryPredicate) {
      const gradBtn = el('button', {
        class: 'mt-3 w-full text-[11px] mono rounded py-1.5 border border-rose-500/40 text-rose-300 hover:bg-rose-500/10 transition',
        title: 'Re-deploy this strategy as a LIVE bot trading real USDC.',
        onclick: () => openDeployModal(graduateRecFromBot(b)),
      }, 'Graduate to live →');
      card.append(gradBtn);
    }

    // Delete — removes the bot entirely (keypair, state, log). Kept
    // small + muted since it's destructive; a JS confirm guards it and
    // the route also requires { confirm: true }.
    const delBtn = el('button', {
      class: 'mt-2 w-full text-[10px] mono rounded py-1 text-zinc-600 '
        + 'hover:text-rose-300 hover:bg-rose-500/5 transition',
      title: 'Permanently delete this bot — keypair, state and log are erased.',
      onclick: async () => {
        if (!confirm('Delete bot "' + b.name + '"?\n\nThis erases its keypair, '
          + 'state and log — irreversible.')) return;
        try {
          await apiPost('/bots/' + b.name + '/delete', { confirm: true });
          refreshAll();
        } catch (err) {
          alert('Delete failed: ' + (err && err.message ? err.message : err));
        }
      },
    }, 'delete');
    card.append(delBtn);
    return card;
  }
  function renderBotCards(s) {
    const showStopped = document.getElementById('show-stopped').checked;
    const modeFilter = document.getElementById('fleet-mode-filter')?.value || 'all';
    let visible = showStopped ? s.bots : s.bots.filter((b) => b.running);
    // Paper/Live filter — b.mode is merged onto each bot in refreshAll
    // (default 'paper' when absent).
    if (modeFilter !== 'all') {
      visible = visible.filter((b) => (b.mode || 'paper') === modeFilter);
    }
    const hiddenCount = s.bots.length - visible.length;
    replace(document.getElementById('bot-cards'), ...visible.map(botCard));
    // Surface the count of hidden bots in the toggle label so the user
    // never wonders "where did the others go?"
    const lbl = document.getElementById('show-stopped-label');
    lbl.textContent = hiddenCount > 0 && !showStopped
      ? `show stopped (${hiddenCount})`
      : 'show stopped';
  }

  // ============ render: signals ============
  function renderSignals(s) {
    const container = document.getElementById('signals');
    // "updated Ns ago" is rendered as a .tick-since span so the shared
    // 1-second ticker keeps it counting up between the 15s data refreshes.
    const meta = document.getElementById('signals-meta');
    if (s.signalsUpdatedMs) {
      replace(meta, t('µg/m³ · '), el('span', {
        class: 'tick-since',
        dataset: {
          tickSince: String(s.signalsUpdatedMs),
          tickPrefix: 'updated ',
          tickSuffix: ' ago',
        },
      }, 'updated ' + fmtAlive(Date.now() - s.signalsUpdatedMs) + ' ago'));
    } else {
      meta.textContent = 'µg/m³ · updated —';
    }
    const nodes = s.signals.map((sig) => {
      const c = REGION_COLORS[sig.region] || '#94a3b8';
      const heldBy = s.bots.filter((b) => b.openPosition?.region === sig.region).length;
      const tag = heldBy
        ? el('span', { class: 'text-[10px] mono px-1.5 py-0.5 rounded',
            style: `background:${c}22; color:${c}; border:1px solid ${c}55` },
            heldBy + ' bot' + (heldBy > 1 ? 's' : '') + ' in')
        : null;
      return el('div', null,
        el('div', { class: 'flex items-baseline justify-between mb-1.5' },
          el('span', { class: 'flex items-center gap-2' },
            el('span', { class: 'w-2 h-2 rounded-sm', style: 'background:' + c }),
            el('span', { class: 'text-sm font-medium text-zinc-100' }, sig.region),
            tag,
          ),
          el('span', { class: 'mono text-base text-zinc-100' },
            sig.pm25.toFixed(0),
            el('span', { class: 'text-[11px] text-zinc-500' }, 'µg/m³'),
          ),
        ),
        el('div', { class: 'h-1.5 rounded-full bg-zinc-800 overflow-hidden mb-1' },
          el('div', { class: 'h-full', style: 'width:' + Math.min(sig.pm25, 100) + '%; background:' + c }),
        ),
        el('div', { class: 'flex items-baseline justify-between text-[11px] mono' },
          el('span', { class: 'muted' }, 'pctile ',
            el('span', { class: 'text-zinc-300' }, sig.pctile != null ? sig.pctile.toFixed(0) : '—')),
          el('span', { class: 'muted' }, 'z ',
            el('span', { class: 'text-zinc-300' },
              sig.z != null ? ((sig.z >= 0 ? '+' : '') + sig.z.toFixed(2) + 'σ') : '—')),
        ),
      );
    });
    replace(container, ...nodes);
  }

  // ============ render: trades ============
  function tradeRow(tr) {
    const statusBadge = tr.status === 'OPEN'
      ? el('span', { class: 'text-[11px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300' }, 'OPEN')
      : el('span', { class: 'text-[11px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300' }, 'CLOSED');
    const sinceText = tr.status === 'OPEN'
      ? 'since ' + hms(tr.entry.ts) + ' · ' + fmtAge(Date.now() - tr.entry.ts).replace(' ago','')
      : hms(tr.entry.ts) + ' → ' + hms(tr.exit.ts) + ' · ' + fmtDuration(tr.durationMs);
    const pnl = tr.status === 'OPEN' ? tr.unrealizedPnlUsd : tr.realizedPnlUsd;
    const pnlPct = tr.status === 'OPEN' ? tr.unrealizedPnlPct : tr.realizedPnlPct;

    const exitOrNowCell = tr.status === 'OPEN'
      ? el('td', { class: 'px-5 py-3 text-right text-zinc-400' },
          '$' + ((tr.currentPrice ?? 0).toFixed(4)),
          el('span', { class: 'text-zinc-500' }, ' ·'),
          ' $' + ((tr.currentValueUsd ?? 0).toFixed(2)))
      : el('td', { class: 'px-5 py-3 text-right' },
          '$' + tr.exitPrice.toFixed(4),
          el('span', { class: 'text-zinc-500' }, ' ·'),
          ' $' + tr.exitProceedsUsd.toFixed(2));

    const sigCell = el('td', { class: 'px-5 py-3 text-right' },
      el('a', { class: 'text-sky-400 hover:underline', href: 'https://solscan.io/tx/' + tr.entry.signature, target: '_blank' },
        tr.entry.signature.slice(0, 8) + '…'));
    if (tr.exit) {
      sigCell.append(el('span', { class: 'text-zinc-600' }, ' / '));
      sigCell.append(el('a', { class: 'text-sky-400 hover:underline', href: 'https://solscan.io/tx/' + tr.exit.signature, target: '_blank' },
        tr.exit.signature.slice(0, 8) + '…'));
    }

    return el('tr', { class: 'border-b border-zinc-900 hover:bg-zinc-900/40' },
      el('td', { class: 'px-5 py-3' },
        statusBadge,
        ' ',
        el('span', { class: 'text-zinc-100 ml-1' }, tr.region),
        el('div', { class: 'text-[10px] muted mt-0.5' }, sinceText),
      ),
      el('td', { class: 'px-5 py-3' },
        el('span', { style: 'color:' + botColor(tr.bot) }, tr.bot)),
      el('td', { class: 'px-5 py-3 text-right' }, tr.tokensHeld.toFixed(2) + ' ' + tr.region),
      el('td', { class: 'px-5 py-3 text-right' },
        '$' + tr.entryPrice.toFixed(4),
        el('span', { class: 'text-zinc-500' }, ' ·'),
        ' $' + tr.costBasisUsd.toFixed(2)),
      exitOrNowCell,
      el('td', { class: 'px-5 py-3 text-right ' + colorClass(pnl) },
        pnl != null ? fmtUsd(pnl) + ' ' + (pnlPct != null ? fmtPct(pnlPct) : '') : '—'),
      el('td', { class: 'px-5 py-3 text-zinc-300' }, tr.entry.reason || ''),
      sigCell,
    );
  }
  function renderTrades(s) {
    const open = s.trades.filter((t) => t.status === 'OPEN');
    const closed = s.trades.filter((t) => t.status === 'CLOSED');
    const realizedPnl = closed.reduce((a, t) => a + (t.realizedPnlUsd || 0), 0);
    const unrealizedPnl = open.reduce((a, t) => a + (t.unrealizedPnlUsd || 0), 0);
    const summary = document.getElementById('trades-summary');
    replace(summary,
      t(closed.length + ' closed round-trip' + (closed.length === 1 ? '' : 's') + ' '),
      el('span', { class: colorClass(realizedPnl) + ' mono' }, fmtUsd(realizedPnl)),
      t(' · ' + open.length + ' open position' + (open.length === 1 ? '' : 's') + ' '),
      el('span', { class: colorClass(unrealizedPnl) + ' mono' }, fmtUsd(unrealizedPnl) + ' unrealized'),
    );
    const body = document.getElementById('trades-body');
    if (s.trades.length === 0) {
      replace(body, el('tr', null, el('td', { colspan: '8', class: 'px-5 py-8 text-center muted' }, 'no trades yet')));
      return;
    }
    replace(body, ...s.trades.map(tradeRow));
  }

  // ============ render: chart ============
  let chart = null;
  function renderChart(s) {
    // Slice nav history to the user's selected range. 'all' uses
    // everything; everything else windows to the last N ms.
    const rangeMs = (RANGES.find((r) => r.key === chartRange) ?? RANGES[RANGES.length - 1]).ms;
    const cutoff = Number.isFinite(rangeMs) ? Date.now() - rangeMs : 0;
    const history = s.navHistory.filter((p) => p.ts >= cutoff);
    // X-axis labels: under 24h show HH:MM, else MM/DD HH:MM so day
    // changes are visible on the 7d/all views.
    const labels = history.map((p) => {
      const d = new Date(p.ts);
      if (rangeMs <= 24 * 3600 * 1000) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });
    const showStopped = document.getElementById('show-stopped').checked;
    const visibleBots = showStopped ? s.bots : s.bots.filter((b) => b.running);
    const visibleNames = new Set(visibleBots.map((b) => b.name));
    const visibleCapital = visibleBots.reduce((sum, b) => sum + b.startingCapital, 0);
    // Build per-bot + TOTAL series. In '%' mode each bot is anchored
    // to its starting capital so lifetime gains show even if they
    // pre-date the visible window. In '$' mode we plot raw NAV so
    // the chart literally is "net worth over time".
    const totalSeries = visibleCapital > 0
      ? history.map((p) => {
          let nav = 0;
          for (const [name, v] of Object.entries(p.perBot ?? {})) {
            if (visibleNames.has(name) && v != null) nav += v;
          }
          return chartMode === 'usd' ? nav : (nav / visibleCapital - 1) * 100;
        })
      : [];
    const datasets = [
      { label: 'TOTAL', data: totalSeries, borderColor: '#f1f5f9', borderWidth: 2.0, tension: 0.3, pointRadius: 0, fill: false },
    ];
    for (const b of visibleBots) {
      const series = history.map((p) => {
        const v = p.perBot?.[b.name];
        if (v == null) return null;
        return chartMode === 'usd' ? v : (v / b.startingCapital - 1) * 100;
      });
      const hidden = HIDDEN_SERIES.has(b.name);
      datasets.push({
        label: b.name, data: series,
        borderColor: botColor(b.name),
        borderWidth: 1.8, tension: 0.3, pointRadius: 0, fill: false, spanGaps: true,
        hidden,
      });
    }
    const isUsd = chartMode === 'usd';
    const fmtY = (v) => isUsd ? '$' + v.toFixed(2) : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
    const fmtTip = (v) => isUsd ? '$' + v.toFixed(2) : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
    // Reference line: 0% in pct mode, total starting capital in $ mode.
    const refValue = isUsd ? visibleCapital : 0;
    const refLine = {
      id: 'refLine',
      afterDatasetsDraw(c) {
        const { ctx, chartArea: { left, right }, scales: { y } } = c;
        const py = y.getPixelForValue(refValue);
        ctx.save(); ctx.strokeStyle = '#475569'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke();
        ctx.restore();
      },
    };
    const subtitle = document.getElementById('chart-subtitle');
    if (subtitle) {
      const rangeLabel = chartRange === 'all' ? 'all time' : 'last ' + chartRange;
      subtitle.textContent = (isUsd
        ? 'NAV ($) — '
        : 'PnL % since launch — ') + rangeLabel
        + (history.length === 0 ? ' · no data in window' : '');
    }
    // Empty state — an empty Chart.js canvas just draws bare gridlines and
    // an auto-scaled axis, which reads as broken. With no data in the
    // window, hide the canvas, show a centered message, clear the legend.
    const canvasEl = document.getElementById('navChart');
    const chartBox = canvasEl.parentElement;
    let emptyEl = chartBox.querySelector('.chart-empty');
    if (history.length === 0) {
      if (chart) { chart.destroy(); chart = null; }
      canvasEl.style.display = 'none';
      if (!emptyEl) {
        emptyEl = el('div', { class: 'chart-empty h-full flex flex-col items-center justify-center text-center gap-1' },
          el('div', { class: 'text-[13px] muted' }, 'No performance data yet'),
          el('div', { class: 'text-[11px] text-zinc-600' }, 'The curve appears once a bot logs its first trade.'));
        chartBox.append(emptyEl);
      }
      emptyEl.classList.remove('hidden');
      replace(document.getElementById('chart-legend'));
      return;
    }
    canvasEl.style.display = '';
    if (emptyEl) emptyEl.classList.add('hidden');
    if (chart) chart.destroy();
    chart = new Chart(document.getElementById('navChart'), {
      type: 'line', plugins: [refLine], data: { labels, datasets },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { color: '#1f2937' }, ticks: { color: '#64748b', font: { size: 10, family: 'ui-monospace' }, maxTicksLimit: 8 } },
          y: { position: 'right', grid: { color: '#1f2937' }, ticks: { color: '#64748b', font: { size: 10, family: 'ui-monospace' }, callback: fmtY } },
        },
        plugins: {
          legend: { display: false },
          tooltip: { bodyFont: { family: 'ui-monospace', size: 11 }, titleFont: { family: 'ui-monospace', size: 11 }, backgroundColor: '#0a0d13', borderColor: '#232a36', borderWidth: 1, callbacks: { label: (ctx) => ctx.dataset.label + ': ' + fmtTip(ctx.parsed.y) } },
        },
      },
    });
    const legend = document.getElementById('chart-legend');
    replace(legend, ...datasets.map((d) => {
      // Use the most recent NON-NULL value rather than the last array
      // index, which may be null for sparsely-sampled series.
      let last = 0;
      for (let i = d.data.length - 1; i >= 0; i--) {
        if (d.data[i] != null) { last = d.data[i]; break; }
      }
      const isHidden = HIDDEN_SERIES.has(d.label);
      const item = el('span', {
        class: 'flex items-center gap-1.5 cursor-pointer select-none transition-opacity ' + (isHidden ? 'opacity-30' : 'hover:opacity-80'),
        title: 'click to toggle',
      },
        el('span', { class: 'w-3 h-0.5', style: 'background:' + d.borderColor }),
        el('span', { class: 'text-zinc-300' }, d.label + ' ' + fmtTip(last)),
      );
      item.addEventListener('click', () => {
        if (HIDDEN_SERIES.has(d.label)) HIDDEN_SERIES.delete(d.label);
        else HIDDEN_SERIES.add(d.label);
        // Persist + re-render the chart
        try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...HIDDEN_SERIES])); } catch {}
        if (lastState) renderChart(lastState);
      });
      return item;
    }));
  }

  // ============ tick log ============
  let logTab = null;
  function renderLogTabs(s) {
    if (!logTab && s.bots[0]) logTab = s.bots[0].name;
    const tabs = document.getElementById('log-tabs');
    replace(tabs, ...s.bots.map((b) => {
      const btn = el('button', {
        class: 'tabbtn px-2 py-1 rounded',
        'aria-selected': b.name === logTab ? 'true' : 'false',
        onclick: () => { logTab = b.name; refreshLog(); renderLogTabs(s); },
      }, b.name);
      return btn;
    }));
  }
  async function refreshLog() {
    if (!logTab) return;
    try {
      const data = await api('/bots/' + encodeURIComponent(logTab) + '/logs?tail=60');
      const body = document.getElementById('log-body');
      body.textContent = (data.lines || []).join('\n');
      body.scrollTop = body.scrollHeight;
    } catch {}
  }

  // ============ backtest table ============
  function renderBacktest(s) {
    const body = document.getElementById('backtest-body');
    replace(body, ...s.backtestRows.map((r) => {
      // Live column: recompute from the matching bot's true PnL rather
      // than r.livePct, which is derived server-side from the same stale
      // baseline that inflated the bot cards (see botLifetimePnl).
      const liveBot = (s.bots || []).find((x) => x.name === r.bot);
      const livePct = liveBot ? botLifetimePnl(liveBot).pct : r.livePct;
      return el('tr', { class: 'border-b border-zinc-900' },
      el('td', { class: 'py-3' },
        el('div', { class: 'flex items-center gap-2' },
          el('span', { class: 'w-1.5 h-1.5 rounded-full', style: 'background:' + botColor(r.bot) }),
          el('span', { class: 'text-zinc-100' }, r.strategy),
        ),
        el('div', { class: 'text-[10px] muted' }, '~' + r.expectedTrades + ' trades / 5d backtest'),
      ),
      el('td', { class: 'py-3 text-right text-emerald-400' }, fmtPct(r.backtestPct)),
      el('td', { class: 'py-3 text-right ' + colorClass(livePct) }, fmtPct(livePct)),
      el('td', { class: 'py-3 text-right' },
        el('span', { class: colorClass(r.projectedPct) }, r.projectedPct != null ? '≈ ' + fmtPct(r.projectedPct) + ' / 5d' : '—'),
        el('span', { class: 'text-[10px] block ' + (r.onPace ? 'text-emerald-400' : 'text-amber-400') }, r.paceLabel || ''),
      ),
      );
    }));
  }

  // ============ orchestrate ============
  let lastState = null;
  async function refreshAll() {
    try {
      const s = await api('/dashboard/state');
      // `/dashboard/state` doesn't carry per-bot run mode / decoded rule
      // (those live on WalletMeta). The `/bots` list returns the full
      // WalletMeta, so we fetch it and merge `mode` + `decodedRule` onto
      // each bot by name. This is what powers the PAPER/LIVE badges and
      // the "Graduate to live" action. Failure here is non-fatal — the
      // cards still render, just without mode info (treated as paper).
      try {
        const metas = await api('/bots');
        const byName = new Map((metas || []).map((m) => [m.name, m]));
        for (const b of s.bots || []) {
          const m = byName.get(b.name);
          if (m) {
            b.mode = m.mode === 'live' ? 'live' : 'paper';
            b.decodedRule = m.decodedRule || null;
          } else {
            b.mode = 'paper';
          }
        }
      } catch (e) {
        for (const b of s.bots || []) if (!b.mode) b.mode = 'paper';
      }
      lastState = s;
      applyBackupGate(s);
      renderWelcomeHero(s);
      renderTopBar(s);
      renderFunder(s);
      renderBotCards(s);
      renderSignals(s);
      renderTrades(s);
      renderChart(s);
      renderLogTabs(s);
      renderBacktest(s);
      await refreshLog();
    } catch (err) {
      console.warn('refresh failed:', err.message);
    }
  }

  // Persist the show-stopped preference across refreshes + reloads.
  const SHOW_STOPPED_KEY = 'pbx-bots:show-stopped';
  const showStoppedInput = document.getElementById('show-stopped');
  showStoppedInput.checked = localStorage.getItem(SHOW_STOPPED_KEY) === '1';
  showStoppedInput.addEventListener('change', () => {
    localStorage.setItem(SHOW_STOPPED_KEY, showStoppedInput.checked ? '1' : '0');
    if (lastState) {
      renderBotCards(lastState);
      renderChart(lastState);
    }
  });

  // Paper/Live fleet filter — re-render on change, persist the choice.
  const FLEET_FILTER_KEY = 'pbx-bots:fleet-mode-filter';
  const fleetFilterEl = document.getElementById('fleet-mode-filter');
  if (fleetFilterEl) {
    fleetFilterEl.value = localStorage.getItem(FLEET_FILTER_KEY) || 'all';
    fleetFilterEl.addEventListener('change', () => {
      localStorage.setItem(FLEET_FILTER_KEY, fleetFilterEl.value);
      if (lastState) renderBotCards(lastState);
    });
  }

  // Tick all [.tick-since] elements once per second so durations
  // (bot age, last-fired, etc.) update visibly without waiting for
  // the next 15s data refresh. Walks DOM each tick — cheap at ~30
  // elements; replace with rAF + cached node list if it ever isn't.
  setInterval(() => {
    const now = Date.now();
    for (const node of document.querySelectorAll('.tick-since')) {
      const since = Number(node.getAttribute('data-tick-since'));
      if (!since) continue;
      const prefix = node.getAttribute('data-tick-prefix') || '';
      const suffix = node.getAttribute('data-tick-suffix') || '';
      node.textContent = prefix + fmtAlive(now - since) + suffix;
    }
  }, 1000);

  // ============ chart toolbar (range + mode) ============
  // Range = how far back to show; Mode = $ NAV vs PnL %. Both persist
  // to localStorage so the user's view sticks across reloads.
  const RANGE_KEY = 'pbx-dash-range';
  const MODE_KEY = 'pbx-dash-chart-mode';
  const RANGES = [
    { key: '1h',  label: '1h',  ms: 1 * 3600 * 1000 },
    { key: '4h',  label: '4h',  ms: 4 * 3600 * 1000 },
    { key: '24h', label: '24h', ms: 24 * 3600 * 1000 },
    { key: '7d',  label: '7d',  ms: 7 * 86400 * 1000 },
    { key: 'all', label: 'all', ms: Infinity },
  ];
  const MODES = [
    { key: 'pct', label: '%' },
    { key: 'usd', label: '$' },
  ];
  let chartRange = localStorage.getItem(RANGE_KEY) || 'all';
  let chartMode = localStorage.getItem(MODE_KEY) || 'pct';
  function renderChartToolbar() {
    const host = document.getElementById('chart-range');
    if (!host) return;
    const btn = (active, label, onclick) => {
      const b = el('button', {
        class: 'px-2 py-0.5 rounded border ' + (active
          ? 'bg-zinc-100/10 text-zinc-100 border-zinc-100/20'
          : 'text-zinc-400 border-transparent hover:text-zinc-200'),
      }, label);
      b.addEventListener('click', onclick);
      return b;
    };
    const children = [];
    for (const m of MODES) {
      children.push(btn(chartMode === m.key, m.label, () => {
        chartMode = m.key;
        localStorage.setItem(MODE_KEY, chartMode);
        renderChartToolbar();
        if (lastState) renderChart(lastState);
      }));
    }
    children.push(el('span', { class: 'mx-1 text-zinc-700' }, '|'));
    for (const r of RANGES) {
      children.push(btn(chartRange === r.key, r.label, () => {
        chartRange = r.key;
        localStorage.setItem(RANGE_KEY, chartRange);
        renderChartToolbar();
        if (lastState) renderChart(lastState);
      }));
    }
    replace(host, ...children);
  }
  // ============ left-nav / multi-view layer ============
  //
  // The dashboard is split into 4 mutually-exclusive views, each a
  // <main> container in the HTML. The left sidebar nav switches between
  // them: showView() toggles `.hidden` on the 4 view divs and the
  // active state (aria-current) on the 4 nav buttons. The last view and
  // the sidebar collapsed state both persist to localStorage so the
  // user's choices survive a reload.
  const NAV_VIEW_KEY = 'pbx-active-view';
  const NAV_COLLAPSED_KEY = 'pbx-nav-collapsed';
  const VIEW_IDS = {
    discover: 'view-discover',
    leaderboard: 'view-leaderboard',
    strategies: 'view-strategies',
    health: 'view-health',
    paper: 'view-paper',
    live: 'view-live',
    achievements: 'view-achievements',
  };

  // Switch to a view by name (discover|leaderboard|paper|live). Hides
  // the other three, marks the matching nav button active, and persists
  // the choice. Unknown names fall back to 'discover'.
  function showView(name) {
    if (!VIEW_IDS[name]) name = 'discover';
    for (const [view, id] of Object.entries(VIEW_IDS)) {
      document.getElementById(id)?.classList.toggle('hidden', view !== name);
    }
    document.querySelectorAll('#sidebar [data-view]').forEach((btn) => {
      btn.setAttribute('aria-current', btn.dataset.view === name ? 'true' : 'false');
    });
    // Entering the Leaderboard: fetch the live market table on first
    // open, otherwise just re-render so freshly-decoded wallets get
    // marked without a round-trip.
    if (name === 'leaderboard') {
      if (!lbState.traders && !lbState.loading) fetchMarketLeaderboard(false);
      else renderMarketLeaderboard();
    }
    // Strategies view: show the empty-state until a decode run has
    // populated #workflow-status, and (re)load the persisted decodes
    // each time the view becomes visible.
    if (name === 'strategies') {
      loadDecodedStrategies();
    }
    // Health view: re-fetch the 7-check ops snapshot on every visit.
    // Cheap (a couple of fs.stat + one schtasks / pm2 jlist call) so a
    // fresh read per visit is preferable to stale-on-tab-switch.
    if (name === 'health') {
      renderHealth();
    }
    // Achievements view: re-fetch roadmap progress + user profile +
    // event-driven unlocks. Once per visit; no polling.
    if (name === 'achievements') {
      renderAchievements();
    }
    try { localStorage.setItem(NAV_VIEW_KEY, name); } catch {}
  }

  // Apply (and persist) the sidebar collapsed state. Collapsed = icon
  // rail only; the CSS class hides labels, the inline width animates.
  function setNavCollapsed(collapsed) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('nav-collapsed', collapsed);
    sidebar.style.width = collapsed ? '56px' : '200px';
    const toggle = document.getElementById('nav-toggle');
    if (toggle) toggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    const icon = document.getElementById('nav-toggle-icon');
    // Chevron points right when collapsed (→ expand), left when expanded.
    if (icon) icon.style.transform = collapsed ? 'rotate(180deg)' : '';
    try { localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch {}
  }

  // Wire the nav buttons + collapse toggle, then restore saved state.
  function initNav() {
    document.querySelectorAll('#sidebar [data-view]').forEach((btn) => {
      btn.addEventListener('click', () => showView(btn.dataset.view));
    });
    const toggle = document.getElementById('nav-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const collapsed = !document.getElementById('sidebar')?.classList.contains('nav-collapsed');
        setNavCollapsed(collapsed);
      });
    }
    // Setup Guide replays the onboarding tour. Doesn't touch the
    // `pbx_onboarding_v1_done` flag — that flag still gates the
    // FIRST-VISIT auto-open. This is the manual replay path.
    const setupGuideBtn = document.getElementById('setup-guide-btn');
    if (setupGuideBtn && typeof openOnboardOverlay === 'function') {
      setupGuideBtn.addEventListener('click', () => openOnboardOverlay());
    }
    // Paper trading empty-state CTAs — clicking either jumps to the
    // relevant view so the user has a clear path forward when no
    // paper bots exist yet.
    const paperEmptyStrats = document.getElementById('paper-empty-cta-strategies');
    if (paperEmptyStrats) paperEmptyStrats.addEventListener('click', () => showView('strategies'));
    const paperEmptyDiscover = document.getElementById('paper-empty-cta-discover');
    if (paperEmptyDiscover) paperEmptyDiscover.addEventListener('click', () => showView('discover'));
    setNavCollapsed(localStorage.getItem(NAV_COLLAPSED_KEY) === '1');
    showView(localStorage.getItem(NAV_VIEW_KEY) || 'discover');
  }

  renderChartToolbar();
  // ============ market leaderboard ============
  // The Leaderboard view's primary content: the top traders on the live
  // PBX market (GET /api/workflow/discover, ranked by USDC volume),
  // browsable and sortable. Wallets the user has decoded this session
  // (present in wfWallets with a result) are marked inline.
  const lbState = {
    traders: null, loading: false, error: null,
    sortKey: 'volumeUsdc', sortDir: 'desc', loadedDays: null,
  };

  function lbDays() { return Number(document.getElementById('lb-days')?.value || 30); }

  // Fetch the ranked traders for the selected window. `force` re-fetches
  // even when the same window is already cached (the Refresh button).
  async function fetchMarketLeaderboard(force) {
    const days = lbDays();
    if (!force && lbState.traders && lbState.loadedDays === days) return;
    lbState.loading = true;
    lbState.error = null;
    renderMarketLeaderboard();
    try {
      const r = await api('/api/workflow/discover?days=' + days + '&limit=50');
      if (!r || !Array.isArray(r.traders)) {
        throw new Error(r && r.error ? r.error : 'no data returned');
      }
      lbState.traders = r.traders;
      lbState.loadedDays = days;
    } catch (err) {
      lbState.error = (err && err.message) ? err.message : String(err);
    }
    lbState.loading = false;
    renderMarketLeaderboard();
  }

  // One column header. `key` null = non-sortable; otherwise clicking it
  // sorts by that field (toggling direction on repeat clicks).
  function lbHeader(label, key, alignRight, tooltip) {
    const active = lbState.sortKey === key;
    const attrs = {
      class: 'px-5 py-2.5 font-medium select-none ' + (alignRight ? 'text-right' : 'text-left')
        + (key ? ' cursor-pointer hover:text-zinc-200 transition' : ''),
    };
    if (tooltip) attrs.title = tooltip;
    const cell = el('th', attrs,
      label + (active ? (lbState.sortDir === 'desc' ? ' ↓' : ' ↑') : ''));
    if (key) {
      cell.addEventListener('click', () => {
        if (lbState.sortKey === key) {
          lbState.sortDir = lbState.sortDir === 'desc' ? 'asc' : 'desc';
        } else {
          lbState.sortKey = key;
          lbState.sortDir = 'desc';
        }
        renderMarketLeaderboard();
      });
    }
    return cell;
  }

  // Render the market leaderboard table into #market-leaderboard from
  // lbState. Idempotent — re-called on sort, fetch, and view entry.
  function renderMarketLeaderboard() {
    const host = document.getElementById('market-leaderboard');
    if (!host) return;
    if (lbState.loading && !lbState.traders) {
      // Animated three-dot spinner so the user sees motion on slow
      // first fetches instead of a frozen "Loading top traders…"
      // string. Each dot scales independently via the .pulse-dot
      // keyframe already defined in dashboard.css; staggered delays
      // create a wave effect. (Caught in commit 71bc05d audit.)
      replace(host, el('div', { class: 'py-16 text-center text-[13px] muted flex flex-col items-center gap-3' },
        el('div', null, 'Loading top traders…'),
        el('div', { class: 'flex items-center gap-1.5' },
          el('span', { class: 'inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 pulse-dot' }),
          el('span', { class: 'inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 pulse-dot',
                       style: 'animation-delay: 0.2s' }),
          el('span', { class: 'inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 pulse-dot',
                       style: 'animation-delay: 0.4s' }),
        ),
      ));
      return;
    }
    if (lbState.error && !lbState.traders) {
      replace(host, el('div', { class: 'py-16 text-center space-y-2' },
        el('div', { class: 'text-[13px] text-rose-300' }, 'Could not load the leaderboard — ' + lbState.error),
        el('div', { class: 'text-[11px] muted' }, 'Hit Refresh to retry.')));
      return;
    }
    const traders = (lbState.traders || []).slice();
    if (traders.length === 0) {
      replace(host, el('div', { class: 'py-16 text-center text-[13px] muted' }, 'No traders found in this window.'));
      return;
    }
    const dir = lbState.sortDir === 'desc' ? -1 : 1;
    const key = lbState.sortKey;
    // For the PnL column, sort on the value the cell actually shows:
    // totalPnlUsdc for complete wallets, realizedPnlUsdc for partial
    // ones. Wallets with no realized P&L at all (realizedPnlUsdc null)
    // still fall through to null and sort to the bottom.
    const sortVal = (tr) => {
      if (key !== 'totalPnlUsdc') return tr[key];
      return tr.pnlComplete === true ? tr.totalPnlUsdc : tr.realizedPnlUsdc;
    };
    traders.sort((a, b) => {
      const av = sortVal(a);
      const bv = sortVal(b);
      // null/undefined (unknown P&L / win-rate) always sorts to the
      // bottom, regardless of sort direction.
      const aNull = av == null;
      const bNull = bv == null;
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      return ((av || 0) - (bv || 0)) * dir;
    });

    const rows = traders.map((tr, i) => {
      const rec = (typeof wfWallets !== 'undefined') ? wfWallets.get(tr.wallet) : null;
      const decoded = rec && rec.result;
      let mark;
      if (decoded) {
        // Decoded — show the backtested edge (return/trip + win-rate)
        // when there's held-out test data, else just the rule name.
        const t = rec.result.test;
        mark = el('span', {
          class: 'text-[11px] mono ' + (t && t.mean < 0 ? 'text-rose-300' : 'text-emerald-300'),
          title: rec.result.summary || rec.result.ruleName || '',
        }, t
          ? '✓ ' + fmtPct1(t.mean) + '/trip · ' + t.wr + '% win'
          : '✓ ' + (rec.result.ruleName || 'decoded'));
      } else if (rec && !rec.finished) {
        mark = el('span', { class: 'text-[11px] text-zinc-400' }, 'decoding…');
      } else {
        // Per-row decode: run the full decode pipeline on just this
        // wallet (skips discovery). stopPropagation so it doesn't also
        // trigger the row's Solscan navigation.
        mark = el('button', {
          class: 'text-[11px] mono rounded px-2 py-0.5 border border-emerald-500/40 '
            + 'text-emerald-300 hover:bg-emerald-500/10 transition',
          title: 'Decode this wallet — runs the full decode pipeline on it.',
        }, 'Decode');
        mark.addEventListener('click', (e) => {
          e.stopPropagation();
          mark.disabled = true;
          mark.textContent = 'starting…';
          mark.className = 'text-[11px] mono text-zinc-400';
          wfStart({ wallets: tr.wallet });
          showView('strategies');
        });
      }
      // Win rate — a percentage with no decimals, or a muted dash when
      // the wallet has no completed round-trips / P&L unavailable.
      let winCell;
      if (tr.winRate != null) {
        winCell = el('td', { class: 'px-5 py-2.5 text-right mono text-zinc-300' },
          Math.round(tr.winRate * 100) + '%');
      } else {
        winCell = el('td', { class: 'px-5 py-2.5 text-right mono text-zinc-600' }, '—');
      }

      // PnL — signed compact USD, emerald when ≥0 / rose when <0.
      //  • realized P&L missing entirely → muted dash (unavailable).
      //  • complete → total P&L with the realized/unrealized split tip.
      //  • partial → realized P&L only, with a muted "~" marker, since
      //    that figure is a trustworthy floor even when total isn't.
      let pnlCell;
      const realized = tr.realizedPnlUsdc;
      const unrealized = tr.unrealizedPnlUsdc;
      if (realized == null) {
        pnlCell = el('td', {
          class: 'px-5 py-2.5 text-right mono text-zinc-600',
          title: 'P&L unavailable — wallet has trades predating price tracking',
        }, '—');
      } else if (tr.pnlComplete === true) {
        const pnl = tr.totalPnlUsdc;
        const sign = pnl >= 0 ? '+' : '-';
        let splitTitle;
        if (realized != null && unrealized != null) {
          const rSign = realized >= 0 ? '+' : '-';
          const uSign = unrealized >= 0 ? '+' : '-';
          splitTitle = 'realized ' + rSign + '$' + wfCompactNum(Math.abs(realized))
            + ' · unrealized ' + uSign + '$' + wfCompactNum(Math.abs(unrealized));
        }
        pnlCell = el('td', {
          class: 'px-5 py-2.5 text-right mono ' + (pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'),
          title: splitTitle || '',
        }, sign + '$' + wfCompactNum(Math.abs(pnl)));
      } else {
        const sign = realized >= 0 ? '+' : '-';
        const unrealizedNote = (typeof unrealized === 'number')
          ? ('unrealized P&L ' + (unrealized >= 0 ? '+' : '-') + '$'
             + wfCompactNum(Math.abs(unrealized)) + ' is partial')
          : 'unrealized P&L is unavailable';
        pnlCell = el('td', {
          class: 'px-5 py-2.5 text-right mono ' + (realized >= 0 ? 'text-emerald-400' : 'text-rose-400'),
          title: 'Realized P&L only (closed round-trips) — ' + unrealizedNote
            + ' or some trade history is incomplete, so this is a floor, not the full picture.',
        },
          sign + '$' + wfCompactNum(Math.abs(realized)),
          el('span', { class: 'text-zinc-600' }, '~'));
      }

      // Wallet cell — shortened address plus any Birdeye tags rendered
      // as compact inline pills. Shows at most 2 pills; a "+N" pill
      // stands in for the rest, with the full list in the cell title.
      const tags = Array.isArray(tr.tags) ? tr.tags.filter(Boolean) : [];
      const walletKids = [el('span', { class: 'mono text-zinc-200' }, shortKey(tr.wallet))];
      if (tags.length > 0) {
        const pill = (text) => el('span', {
          class: 'text-[10px] rounded px-1.5 py-0.5 bg-zinc-800 text-zinc-300 '
            + 'border border-zinc-700/60 whitespace-nowrap',
        }, text);
        const shown = tags.slice(0, 2);
        for (const t of shown) walletKids.push(pill(t));
        if (tags.length > 2) walletKids.push(pill('+' + (tags.length - 2)));
      }
      const walletCell = el('td', {
        class: 'px-5 py-2.5',
        title: tags.length > 0 ? 'Tags: ' + tags.join(', ') : '',
      }, el('span', { class: 'flex items-center gap-1.5 flex-wrap' }, ...walletKids));

      const row = el('tr', {
        class: 'border-b border-zinc-900 hover:bg-zinc-800/30 cursor-pointer transition',
        title: 'Open ' + tr.wallet + ' on Solscan',
      },
        el('td', { class: 'px-5 py-2.5 mono text-zinc-500' }, '#' + (i + 1)),
        walletCell,
        el('td', { class: 'px-5 py-2.5 text-right mono value' }, '$' + wfCompactNum(tr.volumeUsdc || 0)),
        el('td', { class: 'px-5 py-2.5 text-right mono text-zinc-300' }, String(tr.trades || 0)),
        el('td', { class: 'px-5 py-2.5 text-right mono text-emerald-400/80' }, String(tr.buys || 0)),
        el('td', { class: 'px-5 py-2.5 text-right mono text-rose-400/80' }, String(tr.sells || 0)),
        winCell,
        pnlCell,
        el('td', { class: 'px-5 py-2.5 text-right mono text-zinc-400' }, (tr.tradesPerDay || 0).toFixed(1)),
        el('td', { class: 'px-5 py-2.5' }, mark),
      );
      row.addEventListener('click', () => {
        window.open('https://solscan.io/account/' + tr.wallet, '_blank', 'noopener');
      });
      return row;
    });

    const table = el('table', { class: 'w-full text-sm' },
      el('thead', { class: 'text-[11px] tracking-wide muted' },
        el('tr', { class: 'border-b border-zinc-800/40' },
          lbHeader('#', null, false),
          lbHeader('Wallet', null, false),
          lbHeader('Volume', 'volumeUsdc', true),
          lbHeader('Trades', 'trades', true),
          lbHeader('Buys', 'buys', true),
          lbHeader('Sells', 'sells', true),
          lbHeader('Win rate', 'winRate', true,
            "Share of this wallet's sell events that closed in profit — not "
            + 'the share of fully-closed positions. A wallet exiting one '
            + 'position in many small sells can read high.'),
          lbHeader('PnL', 'totalPnlUsdc', true),
          lbHeader('Trades/day', 'tradesPerDay', true),
          lbHeader('Decoded', null, false))),
      el('tbody', { class: 'text-zinc-200' }, ...rows));
    replace(host, el('div', { class: 'overflow-x-auto scrollbar' }, table));
  }

  document.getElementById('lb-refresh')?.addEventListener('click', () => fetchMarketLeaderboard(true));
  document.getElementById('lb-days')?.addEventListener('change', () => fetchMarketLeaderboard(true));

  // Wire the nav + restore the saved view. Runs AFTER lbState and the
  // market-leaderboard functions exist, since showView('leaderboard')
  // touches them when the saved view is the leaderboard.
  initNav();
  initBackupModal();
  initWorkflow();
  initDeployModal();
  initOnboarding();

  bootstrapAuth().then((ready) => {
    if (!ready) { showAuth(); return; }
    // First-time onboarding fires AFTER auth succeeds but BEFORE the
    // first refreshAll() paints — so the tour can highlight elements
    // without competing with state-driven re-renders. The overlay is
    // a no-op once `pbx_onboarding_v1_done` is set in localStorage.
    maybeStartOnboarding();
    refreshAll();
    setInterval(refreshAll, 15000);
    // Background achievement-unlock poll. Runs regardless of which
    // view is active so toasts fire even when the user is on Health
    // or Paper Trading. Initial call delayed 4s to let the dashboard
    // settle on first load (avoids racing the initial refreshAll).
    setTimeout(pollAchievementsForToasts, 4000);
    setInterval(pollAchievementsForToasts, 30000);
  });

  // ============ workflow (Strategy Discovery) ============
  //
  // Click [Start] → open EventSource on /api/workflow/run with the
  // form params. Each event from the orchestrator updates a per-wallet
  // row in real time. Cancel closes the stream which propagates abort
  // to the server (in-flight Python subprocesses get SIGTERM'd).

  // Active runs. Strategy Discovery supports parallel runs: clicking
  // Start while a run is in flight kicks off ANOTHER /api/workflow/run
  // stream whose wallets append to the SAME wfWallets/wfTableEl. Each
  // run owns one EventSource; the workflow finalizes only once the set
  // is empty.
  const wfEventSources = new Set();
  // Test hook: lets Playwright verify parallel runs (active stream count,
  // wallet count) without reaching into closure state.
  window.__wfDebug = {
    runCount: () => wfEventSources.size,
    walletCount: () => wfWallets.size,
  };
  // The hero's 1s progress tick. Module-scoped so wfStop() can clear it
  // on a manual cancel — closing an EventSource by hand fires no error
  // event, so the CLOSED-branch cleanup in es.onerror never runs.
  let wfOverallTick = null;
  let wfStartedAt = 0;
  let wfTableEl = null;        // the single live results table
  let wfDividerEl = null;      // the "— decoding —" zone separator
  let wfDroppedDividerEl = null; // the "— no usable test data —" separator
  // Set once the user clicks the first-run hero CTA. Keeps the workflow
  // + funder cards revealed: without it, the 15s refreshAll() recomputes
  // the "pristine" first-run layout and re-hides cards the user just
  // opened — which looks like the page glitching/reloading.
  let heroEngaged = false;
  /** Map<pubkey, { row: HTMLElement, decode: object, claude: object, backtest: object, status: string }> */
  const wfWallets = new Map();
  // Discovery stats ({ volumeUsdc, trades }) per wallet, captured from
  // the discover.done event. wallet.start may arrive after discover.done,
  // so this side-map lets a row pick up its stats whenever it's created.
  const wfDiscoverStats = new Map();

  function shortKey(k) { return k ? k.slice(0, 4) + '…' + k.slice(-4) : ''; }
  function pctClass(n) { return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-rose-400' : 'text-zinc-300'; }
  function fmtPct1(n) { return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function fmtNum(n, d = 2) { return Number.isFinite(n) ? n.toFixed(d) : '—'; }

  // ── workflow progress — "Mission control" ─────────────────────────
  // One aggregate hero (overall %, shimmer bar, elapsed) above a calm
  // live readout — one row per wallet, plain-language current action,
  // step N/4. Persistent elements: events update them in place so the
  // CSS animations run smoothly without re-render churn.
  let wfHero = null;

  function wfBuildProgress() {
    const host = document.getElementById('workflow-wallets');
    while (host.firstChild) host.removeChild(host.firstChild);
    const titleEl = el('span', { class: 'text-[15px] font-medium text-zinc-100' }, 'Decoding top wallets');
    const elapsedEl = el('span', { class: 'mono text-[12px] text-zinc-500' }, '0s elapsed');
    const pctEl = el('span', { class: 'mono text-[13px] text-emerald-400 font-semibold' }, '0%');
    const barFill = el('div', { class: 'h-full rounded-full bg-emerald-500 wf-shimmer' });
    barFill.style.width = '0%';
    const bar = el('div', { class: 'h-2 rounded-full bg-zinc-800 overflow-hidden' }, barFill);
    const summaryEl = el('div', { class: 'mono text-[11px] text-zinc-500 mt-3' }, 'starting…');
    const hero = el('div', { class: 'card rounded-2xl p-6' },
      el('div', { class: 'flex items-baseline justify-between mb-4' },
        el('div', { class: 'flex items-baseline gap-3' }, titleEl, elapsedEl),
        pctEl),
      bar, summaryEl);
    host.append(hero);
    wfHero = { titleEl, elapsedEl, pctEl, barFill, summaryEl, total: 0 };
  }

  function wfCreateRow(pubkey, index, total) {
    if (!wfHero) wfBuildProgress();
    if (total) wfHero.total = total;
    const glyphEl = el('span', { class: 'w-4 flex justify-center shrink-0' });
    const statusEl = el('span', { class: 'flex-1 truncate text-zinc-500' }, 'Queued');
    const stepEl = el('span', { class: 'mono text-[10px] text-zinc-500 shrink-0' }, '');
    // Shown only once the row is scored (filled by wfRenderScoredRow).
    const metricEl = el('span', { class: 'mono text-[12px] shrink-0 hidden' }, '');
    const deployEl = el('button', {
      class: 'text-[11px] font-medium rounded px-3 py-1 transition shrink-0 hidden '
        + 'bg-zinc-800/80 text-zinc-200 hover:bg-zinc-700',
      title: 'Deploy this strategy — opens with Paper mode preselected (no real funds)',
    }, 'Paper trade');
    // Expand affordance: a chevron shown only once the row is finished
    // and has decoded detail to reveal. Rotates when the panel is open.
    const chevronEl = el('span', { class: 'text-zinc-600 text-[9px] shrink-0 transition-transform hidden' }, '▼');
    const topLine = el('div', { class: 'flex items-center gap-3' },
      glyphEl,
      el('span', { class: 'mono text-[11.5px] text-zinc-400 w-24 shrink-0' }, shortKey(pubkey)),
      statusEl, stepEl, metricEl, deployEl, chevronEl);
    // Second layer: a live sub-detail line (round N of M, decoder activity,
    // or a per-step elapsed timer) so a slow step visibly keeps moving.
    const subEl = el('span', { class: 'flex-1 truncate mono text-[10.5px] text-zinc-600' }, '');
    const subLineEl = el('div', { class: 'flex items-center gap-3 mt-1 hidden' },
      el('span', { class: 'w-4 shrink-0' }),
      el('span', { class: 'w-24 shrink-0' }),
      subEl);
    // Third layer: the on-demand decoded-rule detail panel. Hidden until
    // the user clicks a finished row; rebuilt from rec.result on each open.
    const detailEl = el('div', { class: 'hidden mt-2.5 ml-7 pl-3 border-l border-zinc-800/60' });
    const rowEl = el('div', { class: 'px-5 py-2.5 text-[12px]' }, topLine, subLineEl, detailEl);
    const rec = {
      pubkey, index, total, rowEl, glyphEl, statusEl, stepEl, metricEl, deployEl, subEl, subLineEl,
      chevronEl, detailEl,
      phase: 'queued', step: 0, finished: false, expanded: false,
      subDetail: null, stepStartedAt: 0, result: null,
      state: { decode: null, claude: null, agentic: null, backtest: null, plan: null },
    };
    rowEl.addEventListener('click', () => wfToggleDetail(rec));
    // Clicks inside the open panel (e.g. selecting predicate text) must
    // not bubble up and collapse it — only the row header toggles.
    detailEl.addEventListener('click', (e) => e.stopPropagation());
    return rec;
  }

  /** True when a built result has decoded content worth expanding into. */
  function wfHasDetail(res) {
    return !!(res && (res.summary || res.entry || res.exit
      || res.test || res.train || res.verdict));
  }

  // Toggle a finished row's decoded-rule detail panel. Rebuilt on each
  // open so a late-arriving backtest result is reflected.
  function wfToggleDetail(rec) {
    if (!rec.finished || !wfHasDetail(rec.result)) return;
    rec.expanded = !rec.expanded;
    if (rec.expanded) rec.detailEl.replaceChildren(wfDetailPanel(rec.result));
    rec.detailEl.classList.toggle('hidden', !rec.expanded);
    rec.chevronEl.style.transform = rec.expanded ? 'rotate(180deg)' : '';
  }

  // Reveal (or hide) the expand chevron + pointer cursor for a finished
  // row, based on whether it has decoded detail. If the panel is already
  // open, refresh its contents so a re-rank or late backtest result is
  // reflected. Idempotent — called for every finished row on each reflow.
  function wfSyncExpandAffordance(rec) {
    const has = wfHasDetail(rec.result);
    rec.chevronEl.classList.toggle('hidden', !has);
    rec.rowEl.classList.toggle('cursor-pointer', has);
    if (!rec.expanded) return;
    if (has) {
      rec.detailEl.replaceChildren(wfDetailPanel(rec.result));
    } else {
      rec.expanded = false;
      rec.detailEl.classList.add('hidden');
      rec.chevronEl.style.transform = '';
    }
  }

  // The sub-detail line: a rich detail (set via wfSetSub) when one is
  // available, otherwise a per-step elapsed timer so the row keeps moving.
  function wfRenderSub(rec) {
    if (!rec.subEl) return;
    let text = '';
    if (rec.phase === 'active') {
      const secs = rec.stepStartedAt ? Math.round((Date.now() - rec.stepStartedAt) / 1000) : 0;
      const timer = secs > 1 ? `${secs}s on this step` : '';
      text = rec.subDetail
        ? (timer ? `${rec.subDetail} · ${timer}` : rec.subDetail)
        : timer;
    } else if (rec.subDetail) {
      text = rec.subDetail;
    }
    // Discovery-stats fallback: while a row is still decoding and has no
    // richer live sub-detail (rec.subDetail), show what discovery found
    // about the wallet — its volume + trade count — instead of a bare
    // timer. A real wfSetSub detail always wins.
    if (!rec.subDetail && !rec.result && rec.discoverStats
        && (rec.phase === 'active' || rec.phase === 'queued')) {
      const s = rec.discoverStats;
      const bits = [];
      if (Number.isFinite(s.volumeUsdc)) bits.push(`$${wfCompactNum(s.volumeUsdc)} vol`);
      if (Number.isFinite(s.trades)) bits.push(`${s.trades} trades`);
      if (bits.length) {
        const stats = bits.join(' · ');
        text = text ? `${stats} · ${text}` : stats;
      }
    }
    rec.subEl.textContent = text;
    rec.subLineEl.classList.toggle('hidden', !text);
  }

  // Compact number formatter for discovery stats: 1234 → "1.2k",
  // 4_500_000 → "4.5m", small values keep 1 decimal.
  function wfCompactNum(n) {
    const abs = Math.abs(n);
    if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'm';
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return n.toFixed(1);
  }

  // Set the rich sub-detail for a row (e.g. "round 2 of 4 · entry fit 3.2×").
  function wfSetSub(rec, detail) {
    rec.subDetail = detail || null;
    wfRenderSub(rec);
  }

  // Update one wallet's row: glyph, plain-language status, step counter.
  function wfSetPhase(rec, phase, step, statusText) {
    // Reset the per-step timer + clear stale sub-detail only on a real
    // step/phase change — decode.line re-fires wfSetPhase on the same step.
    if (rec.phase !== phase || rec.step !== step) {
      rec.stepStartedAt = Date.now();
      rec.subDetail = null;
    }
    rec.phase = phase;
    rec.step = step;
    rec.finished = (phase === 'done' || phase === 'skipped' || phase === 'error');
    while (rec.glyphEl.firstChild) rec.glyphEl.removeChild(rec.glyphEl.firstChild);
    if (phase === 'done') rec.glyphEl.append(el('span', { class: 'text-emerald-400 text-[11px]' }, '✓'));
    else if (phase === 'error') rec.glyphEl.append(el('span', { class: 'text-rose-400 text-[11px]' }, '✗'));
    else if (phase === 'skipped') rec.glyphEl.append(el('span', { class: 'text-zinc-600 text-[11px]' }, '–'));
    else if (phase === 'active') rec.glyphEl.append(el('span', { class: 'inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 pulse-dot' }));
    else rec.glyphEl.append(el('span', { class: 'inline-block w-1.5 h-1.5 rounded-full border border-zinc-700' }));
    rec.statusEl.textContent = statusText;
    rec.statusEl.className = 'flex-1 truncate ' + (
      phase === 'done' ? 'text-emerald-300' :
      phase === 'active' ? 'text-zinc-200' :
      phase === 'error' ? 'text-rose-300' : 'text-zinc-500');
    rec.stepEl.textContent = phase === 'active' ? `step ${step + 1}/4`
      : phase === 'done' ? 'complete'
      : phase === 'skipped' ? 'skipped' : '';
    wfRenderSub(rec);
  }

  // Recompute the aggregate hero from all wallet records.
  function wfTickProgress() {
    if (!wfHero) return;
    wfHero.elapsedEl.textContent = ((Date.now() - wfStartedAt) / 1000).toFixed(0) + 's elapsed';
    const recs = [...wfWallets.values()];
    const total = Math.max(wfHero.total || 0, recs.length) || 1;
    let progress = 0, doneN = 0;
    for (const r of recs) {
      wfRenderSub(r);  // keep the per-step timer ticking
      if (r.finished) { progress += 1; doneN += 1; }
      else if (r.phase === 'active') progress += (r.step + 0.5) / 4;
    }
    const pct = Math.min(100, Math.round(progress / total * 100));
    wfHero.pctEl.textContent = pct + '%';
    wfHero.barFill.style.width = pct + '%';
    wfHero.titleEl.textContent = `Decoding ${total} top wallet${total === 1 ? '' : 's'}`;
    wfHero.summaryEl.textContent = `${doneN} complete · ${recs.length - doneN} in progress`;
  }

  // ============ deploy-as-bot modal ============

  // The modal is driven by a normalized "deploy spec":
  //   { source, name, strategy, entryPredicate, exitPredicate, ruleName,
  //     decoded (bool), graduate (bool) }
  // A spec comes from either a workflow leaderboard result
  // (deploySpecFromWfResult) or a paper bot being graduated
  // (graduateRecFromBot). When `decoded` is true we POST
  // `strategy:'decoded_rule'` + a `decodedRule` body field; otherwise we
  // keep the legacy named-strategy path (templateName).
  let deploySpec = null;
  let deployMode = 'paper';

  /** Build a deploy spec from a wfBuildResult `r`. Uses the decoded
   *  predicate pair when present (the decoded-rule path), else falls
   *  back to the named template. */
  function deploySpecFromWfResult(r) {
    const tpl = (r.rec && r.rec.state && r.rec.state.claude && r.rec.state.claude.templateName) || 'unknown';
    const short = shortKey(r.pubkey).replace(/…/g, '');
    const decoded = !!r.entry;
    return {
      source: `Decoded from ${r.pubkey.slice(0, 4)}…${r.pubkey.slice(-4)} · ${decoded ? 'decoded rule' : tpl}`,
      name: `arb-${short}-${decoded ? 'rule' : tpl}`.replace(/_/g, '-').toLowerCase().slice(0, 32),
      strategy: decoded ? 'decoded_rule' : tpl,
      entryPredicate: r.entry || '',
      exitPredicate: r.exit || '',
      ruleName: r.ruleName || tpl,
      decoded,
    };
  }

  /** Build a deploy spec for graduating an existing paper bot to live.
   *  Re-uses the bot's persisted decodedRule. */
  function graduateRecFromBot(b) {
    const dr = b.decodedRule || {};
    return {
      source: `Graduating paper bot ${b.name} to LIVE`,
      name: b.name,
      strategy: 'decoded_rule',
      entryPredicate: dr.entryPredicate || '',
      exitPredicate: dr.exitPredicate || '',
      ruleName: dr.ruleName || b.name,
      decoded: true,
      graduate: true,
    };
  }

  /** Reflect the current mode selection across the form: button pressed
   *  state, the live-confirm checkbox, and the funding copy. */
  function setDeployMode(mode) {
    deployMode = mode === 'live' ? 'live' : 'paper';
    for (const btn of document.querySelectorAll('.deploy-mode-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset.mode === deployMode ? 'true' : 'false');
    }
    const liveWrap = document.getElementById('deploy-live-confirm-wrap');
    const liveConfirm = document.getElementById('deploy-live-confirm');
    const isLive = deployMode === 'live';
    liveWrap.classList.toggle('hidden', !isLive);
    liveWrap.classList.toggle('flex', isLive);
    if (!isLive) liveConfirm.checked = false;
    // Funding copy: paper deploys seed a simulated balance — no real USDC.
    const fundNote = document.getElementById('deploy-fund-note');
    const mainnetNote = document.getElementById('deploy-mainnet-note');
    if (isLive) {
      fundNote.textContent = 'The bot trades with its entire USDC balance. Whatever you put in "Starting USDC" is what it will buy with on its first eligible tick — not a per-trade cap. If you want $50 risk, fund $50.';
      replace(mainnetNote,
        el('span', { class: 'text-amber-300' }, '⚠ Live mainnet:'),
        t(" this creates a Solana wallet, transfers real USDC + SOL from the funder, sets the strategy, and starts trading. You'll see a final review before anything moves."));
    } else {
      fundNote.textContent = 'Paper mode: no real USDC moves. "Starting USDC" seeds a simulated balance the bot trades against — same logic, same P&L plumbing, zero capital at risk.';
      replace(mainnetNote,
        el('span', { class: 'text-sky-300' }, 'Paper mode:'),
        t(' a wallet is created but no funds are transferred. The bot runs its decision loop against a simulated balance. Graduate to live later once you trust it.'));
    }
  }

  function openDeployModal(spec) {
    deploySpec = spec;
    document.getElementById('deploy-source').textContent = spec.source;
    document.getElementById('deploy-name').value = spec.name;
    document.getElementById('deploy-strategy').value = spec.strategy;
    document.getElementById('deploy-usdc').value = '50';
    document.getElementById('deploy-sol').value = '0.05';
    document.getElementById('deploy-tick').value = '30000';
    document.getElementById('deploy-err').classList.add('hidden');

    // Decoded-rule predicate display.
    const ruleBox = document.getElementById('deploy-rule-box');
    if (spec.decoded) {
      ruleBox.classList.remove('hidden');
      document.getElementById('deploy-rule-entry').textContent = spec.entryPredicate || '(none)';
      document.getElementById('deploy-rule-exit').textContent =
        spec.exitPredicate ? spec.exitPredicate : '(none — exit on maxHoldSec only)';
    } else {
      ruleBox.classList.add('hidden');
    }

    // Graduating a paper bot is inherently a live action — default the
    // mode to live; otherwise default to paper (the safe first step).
    setDeployMode(spec.graduate ? 'live' : 'paper');

    document.getElementById('deploy-form').classList.remove('hidden');
    document.getElementById('deploy-review').classList.add('hidden');
    document.getElementById('deploy-progress').classList.add('hidden');
    document.getElementById('deploy-success').classList.add('hidden');
    document.getElementById('deploy-overlay').classList.remove('hidden');
  }

  // Plain-English of what the bot will do on its first eligible tick.
  // Strategies trade with the bot's full USDC balance, so the user
  // needs to understand exactly which token (region) gets bought,
  // when, and that the entire deposit is in play.
  function deployStrategyPlan(strategy, usdcTotal) {
    const amt = '$' + usdcTotal.toFixed(2);
    switch (strategy) {
      case 'decoded_rule': {
        // Rendered separately by renderDeployReview (it has the actual
        // predicate text). This is the generic fallback line.
        return `On each tick the bot evaluates the decoded entry predicate; when it holds, it buys with its full ${amt} USDC balance. It exits when the decoded exit predicate holds (or on maxHoldSec).`;
      }
      case 'rotation':
        return `On the next tick, the bot will swap its full ${amt} USDC into whichever region token is currently cheapest. It will hold until a different region becomes cheaper, then rotate.`;
      case 'mean_reversion':
        return `On the next tick (and only if a region is below its recent average), the bot will swap its full ${amt} USDC into that region. It will sell back to USDC when the price returns to the mean.`;
      case 'region_arb':
      case 'region_arb_dip':
        return `The bot will watch the cheapest region's price relative to its recent range. When it dips below the entry threshold, it will buy with its full ${amt} USDC. It will sell when the price recovers toward the upper threshold.`;
      case 'buy_and_hold':
        return `On the next tick, the bot will swap its full ${amt} USDC into the configured region and hold indefinitely. There is no automatic sell.`;
      case 'pair_spread':
      case 'pm25_band':
      case 'pm25_zscore':
      case 'pm25_all_in':
        return `On the next eligible tick, the bot will use its full ${amt} USDC balance to enter the position dictated by the ${strategy} signal. Read the strategy source if you're unsure.`;
      default:
        return `On the next eligible tick, the bot will trade using its full ${amt} USDC balance. Strategies in this codebase enter using the full wallet balance — not a per-trade slice.`;
    }
  }

  function renderDeployReview(opts) {
    const host = document.getElementById('deploy-review-body');
    while (host.firstChild) host.removeChild(host.firstChild);
    const isLive = opts.mode === 'live';
    const rows = [
      ['Bot name', opts.name],
      ['Mode', isLive ? 'LIVE — real USDC on mainnet' : 'PAPER — simulated, no real funds'],
      ['Strategy', opts.decoded ? `decoded_rule (${opts.ruleName})` : opts.strategy],
      ['Funding', isLive
        ? `${opts.usdcTotal.toFixed(2)} USDC + ${opts.sol.toFixed(4)} SOL (from funder)`
        : `${opts.usdcTotal.toFixed(2)} USDC simulated start (no real transfer)`],
      ['Tick interval', `${opts.tickMs} ms`],
    ];
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'flex items-baseline gap-3';
      const key = document.createElement('span');
      key.className = 'muted w-24 shrink-0';
      key.textContent = k;
      const val = document.createElement('span');
      val.className = (k === 'Mode' && isLive) ? 'text-rose-300' : 'text-zinc-100';
      val.textContent = v;
      row.append(key, val);
      host.append(row);
    }
    // Decoded-rule deploys MUST show the actual predicate pair so the
    // user signs off on the real logic, not just a strategy name.
    if (opts.decoded) {
      const rb = document.createElement('div');
      rb.className = 'mt-2 pt-2 border-t border-zinc-800 space-y-1';
      const mkRule = (label, text) => {
        const line = document.createElement('div');
        const lab = document.createElement('span');
        lab.className = 'muted';
        lab.textContent = label + ' ';
        const code = document.createElement('span');
        code.className = 'text-emerald-300';
        code.textContent = text;
        line.append(lab, code);
        return line;
      };
      const cap = document.createElement('div');
      cap.className = 'muted text-[11px]';
      cap.textContent = 'Decoded rule — review the exact trading logic:';
      rb.append(cap);
      rb.append(mkRule('entry:', opts.entryPredicate || '(none)'));
      rb.append(mkRule('exit:', opts.exitPredicate ? opts.exitPredicate : '(none — exit on maxHoldSec only)'));
      host.append(rb);
    }
    const summary = document.createElement('div');
    summary.className = 'mt-2 pt-2 border-t border-zinc-800 text-zinc-200 leading-relaxed';
    summary.textContent = deployStrategyPlan(opts.strategy, opts.usdcTotal);
    host.append(summary);
  }
  function closeDeployModal() {
    document.getElementById('deploy-overlay').classList.add('hidden');
    deploySpec = null;
  }

  function deployStepLine(text, status) {
    const row = document.createElement('div');
    row.className = 'flex items-baseline gap-2';
    const tag = document.createElement('span');
    tag.className = (status === 'ok' ? 'text-emerald-400' : status === 'err' ? 'text-rose-400' : 'text-zinc-500');
    tag.textContent = status === 'ok' ? '✓' : status === 'err' ? '✗' : '·';
    const body = document.createElement('span');
    body.className = 'text-zinc-200';
    body.textContent = text;
    row.append(tag, body);
    return row;
  }

  async function deployRunChain(opts) {
    const host = document.getElementById('deploy-progress');
    while (host.firstChild) host.removeChild(host.firstChild);
    document.getElementById('deploy-form').classList.add('hidden');
    host.classList.remove('hidden');

    // Helper: append a "running" line, then update it on completion.
    const step = (label) => {
      const line = deployStepLine(label, 'pending');
      host.append(line);
      return {
        ok: () => { const updated = deployStepLine(label, 'ok'); host.replaceChild(updated, line); },
        err: (msg) => { const updated = deployStepLine(`${label} — ${msg}`, 'err'); host.replaceChild(updated, line); },
      };
    };

    const isLive = opts.mode === 'live';

    // 0. graduate only: stop the running paper bot first. launch()
    //    throws if the bot is already running, so a re-deploy of a live
    //    bot needs the paper instance halted. Stopping an already-
    //    stopped bot is harmless.
    if (opts.graduate) {
      let stopStep = step(`Stopping paper bot ${opts.name}…`);
      try {
        await apiPost(`/bots/${opts.name}/stop`, {});
        stopStep.ok();
      } catch (err) {
        stopStep.err(err.message || String(err));
        return { ok: false };
      }
    }

    // 1. create wallet — skipped when graduating an existing bot (the
    //    wallet already exists; we only re-set strategy + relaunch).
    let wallet = null;
    if (!opts.graduate) {
      let createStep = step(`Creating wallet ${opts.name}…`);
      try {
        wallet = await apiPost('/bots', { name: opts.name });
        createStep.ok();
      } catch (err) {
        createStep.err(err.message || String(err));
        return { ok: false };
      }
    }

    // 2. set strategy. Decoded-rule deploys POST `strategy:'decoded_rule'`
    //    + a `decodedRule` body field (the route validates the predicate
    //    pair, HTTP 400 on invalid). `mode` is sent explicitly — only an
    //    explicit 'live' arms real trading.
    const strategyLabel = opts.decoded ? `decoded_rule (${opts.ruleName})` : opts.strategy;
    let strategyStep = step(`Setting strategy ${strategyLabel} · ${opts.mode} (tickMs=${opts.tickMs}, size=$${opts.usdcPerTrade.toFixed(2)})…`);
    try {
      const liveTradeUsdcRaw = String(Math.floor(opts.usdcPerTrade * 1e6));
      const body = {
        strategy: opts.strategy,
        liveTradeUsdcRaw,
        tickMs: opts.tickMs,
        mode: opts.mode,
      };
      if (opts.decoded) {
        body.decodedRule = {
          ruleName: opts.ruleName,
          entryPredicate: opts.entryPredicate,
          exitPredicate: opts.exitPredicate,
        };
      }
      await apiPost(`/bots/${opts.name}/strategy`, body);
      strategyStep.ok();
    } catch (err) {
      strategyStep.err(err.message || String(err));
      return { ok: false };
    }

    // 3. fund from funder — LIVE only. A paper deploy moves no real USDC
    //    (the strategy route seeded a simulated balance from
    //    liveTradeUsdcRaw), so there's nothing to transfer.
    if (isLive) {
      let fundStep = step(`Funding from funder (${opts.usdcTotal.toFixed(2)} USDC + ${opts.sol.toFixed(4)} SOL)…`);
      try {
        const usdcRaw = String(Math.floor(opts.usdcTotal * 1e6));
        const solLamports = String(Math.floor(opts.sol * 1e9));
        await apiPost(`/bots/${opts.name}/fund`, { usdcRaw, solLamports });
        fundStep.ok();
      } catch (err) {
        fundStep.err(err.message || String(err));
        return { ok: false };
      }
    } else {
      step(`Paper mode — no real funds transferred (simulated $${opts.usdcTotal.toFixed(2)} start)`).ok();
    }

    // 4. launch
    let launchStep = step(`Launching bot…`);
    try {
      await apiPost(`/bots/${opts.name}/launch`, {});
      launchStep.ok();
    } catch (err) {
      launchStep.err(err.message || String(err));
      return { ok: false };
    }

    return { ok: true, pubkey: wallet?.pubkey };
  }

  function deployValidate() {
    const errEl = document.getElementById('deploy-err');
    errEl.classList.add('hidden');
    const name = document.getElementById('deploy-name').value.trim();
    const strategy = document.getElementById('deploy-strategy').value.trim();
    const usdcPerTrade = Number(document.getElementById('deploy-usdc').value);
    const sol = Number(document.getElementById('deploy-sol').value);
    const tickMs = Number(document.getElementById('deploy-tick').value);
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) {
      errEl.textContent = 'Bot name must be 1-32 chars of [a-zA-Z0-9_-]';
      errEl.classList.remove('hidden');
      return null;
    }
    if (!strategy) {
      errEl.textContent = 'Strategy template required';
      errEl.classList.remove('hidden');
      return null;
    }
    if (!Number.isFinite(usdcPerTrade) || usdcPerTrade <= 0) {
      errEl.textContent = 'USDC must be a positive number';
      errEl.classList.remove('hidden');
      return null;
    }
    if (!Number.isFinite(sol) || sol <= 0) {
      errEl.textContent = 'SOL must be a positive number';
      errEl.classList.remove('hidden');
      return null;
    }
    if (!Number.isFinite(tickMs) || tickMs < 5000) {
      errEl.textContent = 'Tick interval must be ≥ 5000ms';
      errEl.classList.remove('hidden');
      return null;
    }
    const decoded = !!(deploySpec && deploySpec.decoded);
    const entryPredicate = decoded ? (deploySpec.entryPredicate || '') : '';
    const exitPredicate = decoded ? (deploySpec.exitPredicate || '') : '';
    const ruleName = decoded ? (deploySpec.ruleName || strategy) : null;
    // A decoded-rule deploy must carry a non-empty entry predicate —
    // the route fails closed (HTTP 400) without one anyway.
    if (decoded && entryPredicate.trim().length === 0) {
      errEl.textContent = 'This wallet has no decoded entry predicate — cannot deploy.';
      errEl.classList.remove('hidden');
      return null;
    }
    // Live capital requires the explicit confirmation checkbox — there
    // is never a one-click path to real funds.
    if (deployMode === 'live' && !document.getElementById('deploy-live-confirm').checked) {
      errEl.textContent = 'Tick the confirmation box to deploy LIVE with real USDC.';
      errEl.classList.remove('hidden');
      return null;
    }
    // Strategy gets `liveTradeUsdcRaw = usdcPerTrade`. For a live deploy
    // the funder transfers this amount; for paper it seeds the simulated
    // starting balance.
    const usdcTotal = usdcPerTrade;
    return {
      name, strategy, usdcPerTrade, usdcTotal, sol, tickMs,
      mode: deployMode, decoded, entryPredicate, exitPredicate, ruleName,
      graduate: !!(deploySpec && deploySpec.graduate),
    };
  }

  function initDeployModal() {
    const overlay = document.getElementById('deploy-overlay');
    if (!overlay) return;
    document.getElementById('deploy-close').addEventListener('click', closeDeployModal);
    document.getElementById('deploy-cancel').addEventListener('click', closeDeployModal);

    // Mode selector — Paper / Live toggle buttons.
    for (const btn of document.querySelectorAll('.deploy-mode-btn')) {
      btn.addEventListener('click', () => setDeployMode(btn.dataset.mode));
    }

    // Form -> Review.
    document.getElementById('deploy-confirm').addEventListener('click', () => {
      const opts = deployValidate();
      if (!opts) return;
      renderDeployReview(opts);
      document.getElementById('deploy-form').classList.add('hidden');
      document.getElementById('deploy-review').classList.remove('hidden');
    });

    // Review -> Form.
    document.getElementById('deploy-review-back').addEventListener('click', () => {
      document.getElementById('deploy-review').classList.add('hidden');
      document.getElementById('deploy-form').classList.remove('hidden');
    });

    // Review -> run chain.
    document.getElementById('deploy-review-confirm').addEventListener('click', async () => {
      const opts = deployValidate();
      if (!opts) return;
      const btn = document.getElementById('deploy-review-confirm');
      btn.disabled = true;
      try {
        const result = await deployRunChain(opts);
        if (result.ok) {
          document.getElementById('deploy-progress').classList.add('hidden');
          const detail = document.getElementById('deploy-success-detail');
          const stratLabel = opts.decoded ? `decoded_rule (${opts.ruleName})` : opts.strategy;
          const modeLabel = opts.mode === 'live' ? 'LIVE' : 'PAPER';
          detail.textContent = result.pubkey
            ? `${opts.name} · ${shortKey(result.pubkey)} · ${modeLabel} · running ${stratLabel}`
            : `${opts.name} · ${modeLabel} · running ${stratLabel}`;
          document.getElementById('deploy-success').classList.remove('hidden');
          // Trigger an immediate dashboard refresh so the new bot card
          // appears under the strategy-discovery section.
          refreshAll();
          setTimeout(closeDeployModal, 2500);
        }
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ============ final leaderboard (Variation 2) ============
  //
  // The per-wallet rows above show live progress while the run streams.
  // When the workflow finishes, this collapses all of it into one
  // decision: the strongest result is spotlit at the top, the rest sit
  // in a calm table, the no-data wallets fold into a footnote — and
  // every part expands for the full detail.

  /** Flatten an accumulated wallet rec into a display model. */
  function wfBuildResult(pubkey, rec) {
    const s = rec.state || {};
    const claude = s.claude || {};
    const ag = s.agentic || {};
    const ff = claude.freeformRule || {};
    const arule = ag.rule || {};
    const rt = (ag.testMetrics && ag.testMetrics.round_trips) || {};
    const trainRt = (ag.trainMetrics && ag.trainMetrics.round_trips) || {};
    const trips = rt.n_trips || 0;
    // Decoded predicate pair. Prefer the agentic rule's predicates, fall
    // back to Claude's freeform rule. This is what gets POSTed as
    // `decodedRule` on the /strategy call.
    const entryPred = ((arule.entryWhen || ff.entryWhen) || {}).predicate || null;
    const exitPred = ((arule.exitWhen || ff.exitWhen) || {}).predicate || null;
    return {
      pubkey, rec,
      summary: arule.summary || ff.summary || claude.strategySummary || null,
      entry: entryPred,
      exit: exitPred,
      ruleName: arule.name || ff.name || claude.templateName || null,
      verdict: ag.verdict || null,
      test: trips > 0
        ? { trips, mean: rt.mean_net_ret_pct || 0, wr: Math.round((rt.win_rate || 0) * 100) }
        : null,
      train: (trainRt.n_trips > 0)
        ? { trips: trainRt.n_trips, mean: trainRt.mean_net_ret_pct || 0, wr: Math.round((trainRt.win_rate || 0) * 100) }
        : null,
      backtest: s.backtest || null,
      // A wallet is deployable whenever it has a decoded entry predicate
      // — including `templateName: 'unknown'` wallets. Those are exactly
      // the decoded-rule deploys this feature exists for. The old gate
      // (templateName present) excluded them.
      canDeploy: !!entryPred,
      noTrades: !!(s.decode && s.decode.walletBuys === 0),
    };
  }

  const wfTrades = (n) => n + (n === 1 ? ' trade' : ' trades');

  /** The expandable detail body shared by the hero card + every row. */
  function wfDetailPanel(r) {
    const box = el('div', { class: 'space-y-2.5 text-[12px]' });
    if (r.summary) {
      box.append(el('div', { class: 'text-zinc-300 leading-relaxed' }, r.summary));
    }
    if (r.entry || r.exit) {
      const rules = el('div', { class: 'space-y-1' });
      if (r.entry) rules.append(el('div', { class: 'mono text-[10.5px] text-zinc-500' }, 'entry: ' + r.entry));
      if (r.exit) rules.append(el('div', { class: 'mono text-[10.5px] text-zinc-500' }, 'exit: ' + r.exit));
      box.append(rules);
    }
    const stats = el('div', { class: 'grid grid-cols-2 gap-5 mono text-[11px] pt-1' });
    const statCol = (label, m) => el('div', {},
      el('div', { class: 'text-zinc-600 text-[10px] tracking-wider' }, label),
      el('div', { class: 'text-zinc-200 mt-0.5' },
        m ? `${wfTrades(m.trips)} · ${fmtPct1(m.mean)}/trade · ${m.wr}% win` : '—'));
    stats.append(statCol('HELD-OUT TEST', r.test), statCol('TRAINING', r.train));
    box.append(stats);
    if (r.backtest && r.backtest.train) {
      const bt = r.backtest;
      box.append(el('div', { class: 'mono text-[10.5px] text-zinc-600 pt-1' },
        `walk-forward backtest · train ${fmtPct1(bt.train.avgTradePct)}/trade · test ${fmtPct1((bt.test || {}).avgTradePct || 0)}/trade`));
    }
    if (r.verdict) {
      box.append(el('div', { class: 'mono text-[10.5px] text-zinc-600' }, 'verdict: ' + r.verdict));
    }
    return box;
  }

  // Rebuild the live table body with a FLIP re-rank animation: scored
  // rows ranked first, a divider, then pending rows. `justScoredPubkey`
  // (optional) is the wallet that just got a score — it gets a one-shot
  // landing highlight.
  // Turn a finished row into a leaderboard row: show the strategy
  // summary, the return metric the ranking is based on, the win-rate on
  // the sub-line, and a Deploy button. Idempotent — wfReflow calls it
  // for every scored row on each pass.
  function wfRenderScoredRow(rec) {
    const res = rec.result;
    if (!res || !res.test) return;
    rec.statusEl.textContent = res.summary || '(strategy decoded)';
    rec.statusEl.className = 'flex-1 truncate text-zinc-300';
    rec.stepEl.classList.add('hidden');
    // Metric: the return % carries the weight; trade count is muted.
    rec.metricEl.className = 'mono text-[12px] shrink-0 flex items-baseline justify-end gap-1.5 w-36';
    while (rec.metricEl.firstChild) rec.metricEl.removeChild(rec.metricEl.firstChild);
    rec.metricEl.append(
      el('span', { class: 'font-semibold ' + (res.test.mean > 0 ? 'text-emerald-400' : 'text-zinc-300') },
        fmtPct1(res.test.mean)),
      el('span', { class: 'text-zinc-500' }, wfTrades(res.test.trips)));
    // Win-rate on the sub-detail line — lifted off the near-invisible grey.
    rec.subDetail = `${res.test.wr}% win`;
    rec.subEl.textContent = rec.subDetail;
    rec.subEl.className = 'flex-1 truncate mono text-[10.5px] text-zinc-400';
    rec.subLineEl.classList.remove('hidden');
    // Deploy button — wired once.
    if (res.canDeploy) {
      rec.deployEl.classList.remove('hidden');
      rec.deployEl.onclick = (e) => { e.stopPropagation(); openDeployModal(deploySpecFromWfResult(res)); };
    } else {
      rec.deployEl.classList.add('hidden');
    }
    wfSyncExpandAffordance(rec);
  }

  // A finished wallet that produced no usable held-out test result.
  // Calm grey row, no metric / deploy. Idempotent.
  function wfRenderDroppedRow(rec) {
    rec.statusEl.className = 'flex-1 truncate text-zinc-600';
    if (rec.phase !== 'skipped' && rec.phase !== 'error') {
      rec.statusEl.textContent = 'Decoded — no usable test data';
    }
    rec.stepEl.classList.add('hidden');
    rec.metricEl.classList.add('hidden');
    rec.deployEl.classList.add('hidden');
    rec.subLineEl.classList.add('hidden');
    wfSyncExpandAffordance(rec);
  }

  function wfReflow(justScoredPubkey) {
    if (!wfTableEl) return;
    const recs = [...wfWallets.values()];
    const isScored = (r) => r.result && r.result.test;
    const scored = recs.filter(isScored);
    const pending = recs.filter((r) => !isScored(r) && !r.finished);
    const dropped = recs.filter((r) => !isScored(r) && r.finished);
    const rankedScored = wfLeaderboardSort(scored.map((r) => r.result))
      .map((res) => wfWallets.get(res.pubkey))
      .filter(Boolean);

    // FIRST — record current positions of every row already in the DOM.
    const firstTop = new Map();
    recs.forEach((r) => {
      if (r.rowEl.isConnected) firstTop.set(r.rowEl, r.rowEl.getBoundingClientRect().top);
    });

    // LAST — re-append nodes in the desired order.
    const order = [];
    rankedScored.forEach((r, i) => {
      r.rowEl.classList.toggle('wf-rank-1', i === 0);
      r.rowEl.classList.remove('wf-pending', 'wf-dropped');
      wfRenderScoredRow(r);
      order.push(r.rowEl);
    });
    if (pending.length > 0) order.push(wfDividerEl);
    pending.forEach((r) => {
      r.rowEl.classList.remove('wf-rank-1', 'wf-dropped');
      r.rowEl.classList.add('wf-pending');
      order.push(r.rowEl);
    });
    if (dropped.length > 0) order.push(wfDroppedDividerEl);
    dropped.forEach((r) => {
      r.rowEl.classList.remove('wf-rank-1', 'wf-pending');
      r.rowEl.classList.add('wf-dropped');
      wfRenderDroppedRow(r);
      order.push(r.rowEl);
    });
    // Detach both dividers first — a divider not in `order` (its zone is
    // empty this pass) would otherwise linger stale in its old position.
    wfDividerEl.remove();
    wfDroppedDividerEl.remove();
    order.forEach((node) => wfTableEl.append(node));

    // INVERT + PLAY — for each row that moved, start it at its old spot
    // then clear the transform on the next frame so it slides home.
    recs.forEach((r) => {
      const before = firstTop.get(r.rowEl);
      if (before == null) return; // brand-new row — no slide
      const after = r.rowEl.getBoundingClientRect().top;
      const delta = before - after;
      if (Math.abs(delta) < 1) return;
      r.rowEl.classList.remove('wf-flip');
      r.rowEl.style.transform = `translateY(${delta}px)`;
      requestAnimationFrame(() => {
        r.rowEl.classList.add('wf-flip');
        r.rowEl.style.transform = '';
      });
    });

    // Landing highlight for the wallet that just crossed into scored.
    if (justScoredPubkey) {
      const rec = wfWallets.get(justScoredPubkey);
      if (rec) {
        rec.rowEl.classList.remove('wf-just-scored');
        void rec.rowEl.offsetWidth; // restart the animation
        rec.rowEl.classList.add('wf-just-scored');
      }
    }

    // Keep the market leaderboard's per-row decode markers in sync —
    // a wallet decoding here flips its leaderboard row to ✓ / "decoding…".
    if (lbState.traders) renderMarketLeaderboard();
  }

  // The emerald winner-hero card — built once at `done` from the #1
  // scored result. Mirrors the pre-unification hero markup.
  function wfWinnerHero(w) {
    const hero = el('div', { id: 'wf-winner-hero', class: 'card rounded-2xl p-6 mt-3' });
    hero.setAttribute('style',
      'background:linear-gradient(180deg,#10231c 0%,#0e1219 75%);border-color:rgba(16,185,129,0.4);');
    const num = el('div', { class: 'flex items-baseline gap-2.5' },
      el('span', { class: 'mono text-[32px] font-semibold text-emerald-400' }, fmtPct1(w.test.mean)),
      el('span', { class: 'text-[14px] text-zinc-400' }, 'average per trade'));
    const heroDetail = el('div', { class: 'hidden mt-4 pt-4 border-t border-zinc-800/60' }, wfDetailPanel(w));
    const expandLink = el('button', { class: 'text-[11px] muted hover:text-zinc-300 mt-3 block' },
      'how it works · the numbers ▸');
    expandLink.onclick = () => {
      heroDetail.classList.toggle('hidden');
      expandLink.textContent = heroDetail.classList.contains('hidden')
        ? 'how it works · the numbers ▸' : 'how it works · the numbers ▾';
    };
    const deployBtn = el('button', {
      class: 'mt-5 bg-emerald-500 text-[#0a0d13] font-semibold rounded-lg px-6 py-2.5 text-[13px] hover:bg-emerald-400 transition disabled:opacity-50',
      title: 'Opens the deploy modal with Paper mode preselected — no real funds. Switch to Live there if you want.',
    }, 'Paper trade this strategy  →');
    if (w.canDeploy) deployBtn.onclick = () => openDeployModal(deploySpecFromWfResult(w));
    else deployBtn.disabled = true;
    hero.append(
      el('div', { class: 'flex items-center gap-2 mb-4' },
        el('span', { class: 'mono text-[10px] tracking-wider px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300' },
          '★ STRONGEST RESULT'),
        el('span', { class: 'mono text-[12px] muted' }, shortKey(w.pubkey))),
      num,
      el('div', { class: 'mono text-[12px] muted mt-2' },
        `${wfTrades(w.test.trips)} on held-out test data · ${w.test.wr}% of them made money`),
      el('div', { class: 'text-[14px] text-zinc-200 leading-relaxed mt-4 max-w-2xl' },
        w.summary || '(no plain-English summary available)'),
      deployBtn, expandLink, heroDetail);
    return hero;
  }

  /** Render the whole Variation-2 leaderboard into #workflow-wallets. */
  function wfRenderLeaderboard() {
    const host = document.getElementById('workflow-wallets');
    if (!host || !wfTableEl) return;
    wfReflow();
    const results = [...wfWallets.values()].map((r) => r.result).filter(Boolean);
    const scored = results.filter((r) => r.test);

    const oldHero = document.getElementById('wf-winner-hero');
    if (oldHero) oldHero.remove();
    // Re-show every row (clears a prior render's winner-hide).
    wfWallets.forEach((r) => r.rowEl.classList.remove('hidden'));
    if (scored.length > 0) {
      const winner = wfLeaderboardSort(scored)[0];
      host.insertBefore(wfWinnerHero(winner), wfTableEl);
      // The winner now lives in the hero card — remove its duplicate
      // table row so the list shows only runners-up.
      const winnerRec = wfWallets.get(winner.pubkey);
      if (winnerRec) winnerRec.rowEl.classList.add('hidden');
    }

    if (scored.length === 0 && !document.getElementById('wf-empty-state')) {
      const empty = el('div', { id: 'wf-empty-state', class: 'card rounded-xl p-6 text-center mt-3' },
        el('div', { class: 'text-[14px] text-zinc-300' }, 'No strategy cleared the bar this run.'),
        el('div', { class: 'text-[12px] muted mt-1' },
          'None of the decoded wallets produced enough held-out test trades to judge. Try a longer discover window or more wallets.'));
      host.append(empty);
    }

  }

  // Cancel/finalize: abort ALL active runs and tear the workflow down.
  function wfStop() {
    for (const es of wfEventSources) { try { es.close(); } catch {} }
    wfEventSources.clear();
    if (wfOverallTick) { clearInterval(wfOverallTick); wfOverallTick = null; }
    document.getElementById('workflow-start').disabled = false;
    document.getElementById('workflow-cancel').classList.add('hidden');
  }

  // `opts.wallets` (a single pubkey or comma-joined list) decodes exactly
  // those wallets, skipping discovery — the leaderboard's per-row Decode
  // action. Omitted = the normal discover→decode run from the Discover
  // view's parameters.
  function wfStart(opts) {
    // Parallel runs: if a run is already in flight this is an ADDITIONAL
    // run. Don't clobber the live UI — keep wfWallets/wfTableEl/the hero
    // and just open another stream feeding the same handlers. Only the
    // first run builds the progress UI.
    const firstRun = wfEventSources.size === 0;
    document.getElementById('workflow-cancel').classList.remove('hidden');
    const statusEl = document.getElementById('workflow-status');
    statusEl.classList.remove('hidden');

    if (firstRun) {
      const wallets = document.getElementById('workflow-wallets');
      while (wallets.firstChild) wallets.removeChild(wallets.firstChild);
      wfWallets.clear();
      wfStartedAt = Date.now();
      wfBuildProgress();

      // The single live results table — present for the whole run. Rows
      // are added as wallets appear and reordered by wfReflow().
      wfTableEl = el('div', { class: 'mt-3 card rounded-xl overflow-hidden' });
      wfDividerEl = el('div', {
        class: 'px-5 py-1.5 border-b border-zinc-800/70 mono text-[10px] tracking-wider text-zinc-600',
      }, '— decoding —');
      wfDroppedDividerEl = el('div', {
        class: 'px-5 py-1.5 border-b border-zinc-800/70 mono text-[10px] tracking-wider text-zinc-600',
      }, '— no usable test data —');
      document.getElementById('workflow-wallets').append(wfTableEl);
    }

    const qs = new URLSearchParams({
      discoverDays: document.getElementById('wf-discover-days').value,
      limit: document.getElementById('wf-limit').value,
      decodeDays: document.getElementById('wf-decode-days').value,
      decodeEpochs: document.getElementById('wf-decode-epochs').value,
      backtestDays: document.getElementById('wf-backtest-days').value,
    });
    if (opts && opts.wallets) qs.set('wallets', opts.wallets);
    const url = '/api/workflow/run?' + qs.toString();
    const es = new EventSource(url);
    wfEventSources.add(es);

    // 1s tick keeps the hero's elapsed timer + bar alive. Shared across
    // all parallel runs — created once, cleared by wfStop().
    if (!wfOverallTick) wfOverallTick = setInterval(wfTickProgress, 1000);

    // Connection-loss watchdog. EventSource auto-reconnects on a dropped
    // stream, so a transient network blip and a dead server look
    // identical at the first onerror. We tell them apart with a grace
    // window: a blip reconnects (fires 'open', clearing the timer); a
    // dead server never does, the timer fires, and we stop rendering
    // fake forever-climbing progress.
    const CONN_LOST_GRACE_MS = 30000;
    let connGraceTimer = null;
    let connLost = false;
    function wfConnectionLost() {
      if (connLost) return;
      connLost = true;
      if (connGraceTimer) { clearTimeout(connGraceTimer); connGraceTimer = null; }
      // Per-run: only drop THIS stream from the active set — sibling
      // parallel runs keep going. If this was the last run, finalize.
      try { es.close(); } catch {}
      wfEventSources.delete(es);
      if (wfEventSources.size === 0) {
        // Last run down — freeze elapsed timers and mark anything still
        // in flight as failed instead of perpetually "in progress".
        for (const rec of wfWallets.values()) {
          if (!rec.finished) {
            wfSetPhase(rec, 'error', rec.step, 'Connection lost — server stopped responding');
          }
        }
        if (wfHero) {
          wfHero.summaryEl.textContent =
            'connection lost — server stopped responding (restart the server and re-run)';
        }
        wfTickProgress();
        wfStop();
      }
    }
    es.addEventListener('open', () => {
      // Reconnected (or first connect) — cancel any pending loss timer.
      if (connGraceTimer) { clearTimeout(connGraceTimer); connGraceTimer = null; }
    });
    es.addEventListener('discover.start', () => {
      if (wfHero) wfHero.summaryEl.textContent = 'discovering top traders…';
    });
    es.addEventListener('discover.done', (ev) => {
      const d = JSON.parse(ev.data);
      if (wfHero) wfHero.total = d.traders.length;
      // Stash each trader's discovery stats (volume, trade count) so a
      // row that's still decoding can show them as a sub-detail fallback
      // (see wfRenderSub). Keyed by wallet — the row rec may not exist
      // yet (wallet.start arrives later), so park them on a side map and
      // also copy onto any rec that already exists.
      for (const tr of (d.traders || [])) {
        if (!tr || !tr.wallet) continue;
        const stats = { volumeUsdc: tr.volumeUsdc, trades: tr.trades };
        wfDiscoverStats.set(tr.wallet, stats);
        const rec = wfWallets.get(tr.wallet);
        if (rec) rec.discoverStats = stats;
      }
      wfTickProgress();
    });
    es.addEventListener('wallet.start', (ev) => {
      const d = JSON.parse(ev.data);
      // Parallel runs can independently discover the same wallet — if a
      // row already exists, ignore the duplicate (no re-add, no double
      // count); the existing row keeps decoding.
      if (wfWallets.has(d.pubkey)) return;
      const rec = wfCreateRow(d.pubkey, d.index, d.total);
      // Pick up discovery stats captured earlier (discover.done).
      if (wfDiscoverStats.has(d.pubkey)) rec.discoverStats = wfDiscoverStats.get(d.pubkey);
      wfWallets.set(d.pubkey, rec);
      wfSetPhase(rec, 'active', 0, 'Reading on-chain trade history…');
      wfTickProgress();
      wfReflow();
    });
    es.addEventListener('decode.start', (ev) => {
      const rec = wfWallets.get(JSON.parse(ev.data).pubkey);
      if (rec) wfSetPhase(rec, 'active', 0, 'Reading on-chain trade history…');
    });
    es.addEventListener('decode.line', (ev) => {
      const d = JSON.parse(ev.data);
      const rec = wfWallets.get(d.pubkey);
      if (!rec) return;
      wfSetPhase(rec, 'active', 0,
        d.stage === 'evolve' ? 'Evaluating trade patterns…' : 'Reading on-chain trade history…');
      // Surface the decoder's own latest line on the sub-detail row.
      const line = (d.line || '').trim();
      if (line) wfSetSub(rec, line);
    });
    es.addEventListener('decode.done', (ev) => {
      const d = JSON.parse(ev.data);
      const rec = wfWallets.get(d.pubkey);
      if (!rec) return;
      rec.state.decode = d.result;
      if (d.result && d.result.walletBuys === 0) {
        wfSetPhase(rec, 'skipped', 4, 'No trades in the decode window — skipped');
        wfTickProgress();
        rec.result = wfBuildResult(rec.pubkey, rec);
        wfReflow();
      } else {
        const n = d.result ? d.result.walletBuys : 0;
        wfSetPhase(rec, 'active', 1, `Found ${n} trades — decoding the strategy…`);
        wfTickProgress();
      }
    });
    es.addEventListener('claude.start', (ev) => {
      const rec = wfWallets.get(JSON.parse(ev.data).pubkey);
      if (rec) wfSetPhase(rec, 'active', 1, 'Claude is decoding the trading rules…');
    });
    es.addEventListener('claude.progress', (ev) => {
      const d = JSON.parse(ev.data);
      const rec = wfWallets.get(d.pubkey);
      if (rec && d.text) wfSetSub(rec, d.text);
    });
    es.addEventListener('claude.done', (ev) => {
      const d = JSON.parse(ev.data);
      const rec = wfWallets.get(d.pubkey);
      if (!rec) return;
      rec.state.claude = d.result;
      wfSetPhase(rec, 'active', 2, 'Walk-forward testing on held-out data…');
      wfTickProgress();
    });
    es.addEventListener('agentic.start', (ev) => {
      const rec = wfWallets.get(JSON.parse(ev.data).pubkey);
      if (rec) wfSetPhase(rec, 'active', 2, 'Walk-forward testing the rule…');
    });
    es.addEventListener('agentic.progress', (ev) => {
      const d = JSON.parse(ev.data);
      const rec = wfWallets.get(d.pubkey);
      if (!rec) return;
      const p = d.progress || {};
      let detail = '';
      if (p.mode === 'data_search') {
        detail = `searching candidate rules (${(p.tried || 0) + 1}/${p.total || '?'})`;
      } else if (p.phase === 'asking_claude') {
        detail = `round ${p.round} of ${p.maxRounds} — asking Claude…`;
      } else if (p.phase === 'scored') {
        const bits = [`round ${p.round} of ${p.maxRounds} scored`];
        if (Number.isFinite(p.entryLift)) bits.push(`entry fit ${p.entryLift}×`);
        if (Number.isFinite(p.tripMean)) {
          bits.push(`${p.tripMean >= 0 ? '+' : ''}${p.tripMean}%/trip`);
        }
        detail = bits.join(' · ');
      } else if (p.phase === 'claude_status' && p.text) {
        detail = p.text;
      }
      if (detail) wfSetSub(rec, detail);
    });
    es.addEventListener('agentic.done', (ev) => {
      const d = JSON.parse(ev.data);
      const rec = wfWallets.get(d.pubkey);
      if (!rec) return;
      rec.state.agentic = d.result;
      wfSetPhase(rec, 'active', 3, 'Running the backtest…');
      wfTickProgress();
      rec.result = wfBuildResult(rec.pubkey, rec);
      wfReflow(rec.result && rec.result.test ? rec.pubkey : undefined);
    });
    es.addEventListener('backtest.start', (ev) => {
      const rec = wfWallets.get(JSON.parse(ev.data).pubkey);
      if (rec) wfSetPhase(rec, 'active', 3, 'Backtesting the strategy…');
    });
    es.addEventListener('backtest.done', (ev) => {
      const d = JSON.parse(ev.data);
      const rec = wfWallets.get(d.pubkey);
      if (!rec) return;
      rec.state.backtest = d.result;
      wfSetPhase(rec, 'done', 4, 'Decoded — done');
      wfTickProgress();
      rec.result = wfBuildResult(rec.pubkey, rec);
      wfReflow(rec.result && rec.result.test ? rec.pubkey : undefined);
    });
    es.addEventListener('backtest.skipped', (ev) => {
      const rec = wfWallets.get(JSON.parse(ev.data).pubkey);
      if (rec) {
        wfSetPhase(rec, 'done', 4, 'Decoded — done');
        wfTickProgress();
        rec.result = wfBuildResult(rec.pubkey, rec);
        wfReflow(rec.result && rec.result.test ? rec.pubkey : undefined);
      }
    });
    es.addEventListener('wallet.done', (ev) => {
      const rec = wfWallets.get(JSON.parse(ev.data).pubkey);
      if (rec && !rec.finished) {
        wfSetPhase(rec, 'done', 4, 'Decoded — done');
        wfTickProgress();
        rec.result = wfBuildResult(rec.pubkey, rec);
        wfReflow(rec.result && rec.result.test ? rec.pubkey : undefined);
      }
    });
    es.addEventListener('error', (ev) => {
      // The SSE 'error' event fires both for orchestrator-side errors
      // (carries data) AND for connection-level errors (no data).
      let parsed = null;
      try { parsed = ev.data ? JSON.parse(ev.data) : null; } catch {}
      if (parsed && parsed.pubkey) {
        const rec = wfWallets.get(parsed.pubkey);
        if (rec) {
          wfSetPhase(rec, 'error', rec.step, 'Error — ' + (parsed.message || parsed.stage || 'failed'));
          wfTickProgress();
        }
      }
    });
    es.addEventListener('done', () => {
      // This run finished — drop it from the active set. A 'done' from
      // one parallel run must NOT stop the others; only finalize the
      // workflow once every run is done.
      try { es.close(); } catch {}
      wfEventSources.delete(es);
      wfTickProgress();
      if (wfEventSources.size === 0) {
        wfStop();
        // Collapse the live progress rows into the final leaderboard.
        try { wfRenderLeaderboard(); } catch (err) { console.warn('leaderboard render failed:', err); }
      }
    });

    // Connection-level close (server end()) — EventSource fires onerror
    // when the stream terminates cleanly too. Cleanup is idempotent.
    es.onerror = () => {
      // Distinguish three cases:
      //  - CLOSED: clean close — drop this run; finalize if it was last.
      //  - CONNECTING: the stream dropped and EventSource is retrying.
      //    Arm the loss watchdog; an 'open' event cancels it if the
      //    blip was transient, otherwise wfConnectionLost() fires.
      if (es.readyState === EventSource.CLOSED) {
        wfEventSources.delete(es);
        if (wfEventSources.size === 0) wfStop();
      } else if (es.readyState === EventSource.CONNECTING && !connLost) {
        if (!connGraceTimer) {
          connGraceTimer = setTimeout(wfConnectionLost, CONN_LOST_GRACE_MS);
        }
      }
    };
  }

  function decodedStrategyRow(d) {
    const bt = d.backtest || {};
    const metrics = [];
    if (typeof bt.returnPerTrip === 'number') metrics.push(fmtPct(bt.returnPerTrip) + ' / trip');
    if (typeof bt.winRate === 'number') metrics.push((bt.winRate * 100).toFixed(0) + '% win');
    if (typeof bt.trips === 'number') metrics.push(bt.trips + ' trips');
    const pk = d.pubkey || '';
    return el('div', { class: 'card rounded-xl p-4' },
      el('div', { class: 'flex items-baseline justify-between gap-3' },
        el('div', { class: 'text-sm font-semibold text-zinc-100' }, d.ruleName || 'decoded rule'),
        el('div', { class: 'text-[11px] mono muted' }, pk.slice(0, 4) + '…' + pk.slice(-4))),
      el('div', { class: 'text-[11px] mono muted mt-1' }, metrics.join('  ·  ') || 'no backtest'),
      el('div', { class: 'text-[11px] mono text-zinc-400 mt-2' }, 'entry: ' + (d.entryPredicate || '—')),
      el('div', { class: 'text-[11px] mono text-zinc-400' }, 'exit: ' + (d.exitPredicate || '—')));
  }

  // Load persisted decoded strategies into #decoded-list and own the
  // empty-state. The empty card hides as soon as there is at least one
  // persisted decode OR a live decode run is in progress.
  async function loadDecodedStrategies() {
    const list = document.getElementById('decoded-list');
    const empty = document.getElementById('strategies-empty');
    if (!list) return;
    try {
      const data = await api('/api/workflow/decodes');
      const decodes = (data && Array.isArray(data.decodes)) ? data.decodes : [];
      replace(list, decodes.map(decodedStrategyRow));
      if (empty) {
        const status = document.getElementById('workflow-status');
        const liveRun = status ? !status.classList.contains('hidden') : false;
        empty.classList.toggle('hidden', decodes.length > 0 || liveRun);
      }
    } catch (err) {
      replace(list, el('div', { class: 'text-[12px] muted' },
        'Could not load decoded strategies — ' + (err && err.message ? err.message : String(err))));
    }
  }



  function initWorkflow() {
    const startBtn = document.getElementById('workflow-start');
    const cancelBtn = document.getElementById('workflow-cancel');
    if (!startBtn || !cancelBtn) return;
    // Starting a run jumps straight to the Leaderboard view so the user
    // immediately watches the decode progress stream in.
    startBtn.addEventListener('click', () => { wfStart(); showView('strategies'); });
    cancelBtn.addEventListener('click', wfStop);
    // The first-run hero's CTA is the same action as the workflow Start
    // button — kick off discovery, then scroll the workflow card into
    // view so the user watches it run.
    const heroBtn = document.getElementById('hero-start');
    if (heroBtn) {
      heroBtn.addEventListener('click', async () => {
        // Engage: reveal the workflow + funder cards and keep them
        // revealed (heroEngaged stops refreshAll re-hiding them).
        heroEngaged = true;
        document.getElementById('workflow-card')?.classList.remove('hidden');
        document.getElementById('funder-card')?.classList.remove('hidden');
        const card = document.getElementById('workflow-card');
        card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Re-probe the toolchain live — a `disabled` state left over
        // from an earlier page load (preflight that has since been
        // fixed) shouldn't silently block the run.
        await checkWorkflowPreflight();
        // Start only if the toolchain is ready AND no run is already
        // in flight — the hero CTA is a first-run entry point, not a
        // way to queue parallel runs (that's the Start button).
        if (!startBtn.disabled && wfEventSources.size === 0) {
          wfStart();
          // Same as the Start button: jump to the Strategies view to
          // watch the decode progress.
          showView('strategies');
        }
      });
    }
    // Probe local toolchain on load; banner + disabled button if missing.
    checkWorkflowPreflight();
  }

  // Hit /api/workflow/preflight on load and render a banner if any of
  // python ≥3.10, sklearn, or the claude CLI are missing. The workflow
  // spawns these subprocesses; missing any one fails the run mid-flight
  // with a confusing error, so we'd rather block + tell the user up
  // front than let them click Start and find out the hard way.
  async function checkWorkflowPreflight() {
    const banner = document.getElementById('workflow-preflight');
    const startBtn = document.getElementById('workflow-start');
    if (!banner || !startBtn) return;
    let data;
    try {
      data = await api('/api/workflow/preflight');
    } catch (err) {
      // If the endpoint itself fails, fail open — don't block the user.
      return;
    }
    const c = data.checks || {};
    const rem0 = data.remediation || {};
    const osHint0 = (navigator.userAgent.includes('Mac')) ? 'macOS' : 'linux';

    if (data.ready) {
      // All required tools present → workflow can run.
      while (banner.firstChild) banner.removeChild(banner.firstChild);
      startBtn.disabled = false;
      startBtn.title = 'Click again while a run is going to queue another run in parallel';
      banner.classList.add('hidden');
      return;
    }
    // Render missing-tool list with remediation
    while (banner.firstChild) banner.removeChild(banner.firstChild);
    const head = document.createElement('div');
    head.className = 'text-amber-200 font-medium';
    head.textContent = '⚠ Workflow can\'t run yet — local toolchain is incomplete.';
    banner.append(head);
    const list = document.createElement('ul');
    list.className = 'text-amber-100/90 space-y-1 ml-4 list-disc';
    const osHint = osHint0;
    const itemFor = (label, check, remediation) => {
      if (!check || check.ok) return null;
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'mono text-amber-50';
      name.textContent = label;
      const dash = document.createTextNode(' — ');
      const msg = document.createElement('span');
      msg.textContent = check.error || 'missing';
      li.append(name, dash, msg);
      if (remediation) {
        const fix = document.createElement('div');
        fix.className = 'mono text-[11px] text-amber-200/80 mt-0.5';
        fix.textContent = `fix: ${remediation[osHint] || remediation.any || ''}`;
        li.append(fix);
        if (remediation.note) {
          const note = document.createElement('div');
          note.className = 'text-[10.5px] muted mt-0.5';
          note.textContent = remediation.note;
          li.append(note);
        }
      }
      return li;
    };
    const rem = rem0;
    // Both python and claude are hard requirements — without either, the
    // decode workflow can't run. sklearn is diagnostic-only.
    [
      ['python3 (≥3.10)', c.python,    rem.python],
      ['claude CLI',      c.claudeCli, rem.claudeCli],
      ['scikit-learn',    c.sklearn,   rem.sklearn],
    ].forEach(([label, check, r]) => {
      const li = itemFor(label, check, r);
      if (li) list.append(li);
    });
    banner.append(list);
    const tail = document.createElement('div');
    tail.className = 'text-[11px] muted mt-1';
    tail.textContent = 'Install the missing tools and reload this page.';
    banner.append(tail);
    banner.classList.remove('hidden');
    startBtn.disabled = true;
    startBtn.title = 'Workflow disabled — see banner above for missing tools';
  }

  // ============ first-time onboarding tour ============
  //
  // 10-step interactive walkthrough. Unlike the previous retrospective
  // tour, this one NAVIGATES the dashboard and WAITS for user actions:
  // it switches views via showView(), highlights real panels, and gates
  // certain steps on real DOM events (e.g. clicking Decode on a wallet).
  //
  // Step list:
  //   1. Welcome / congrats           (no gate, no view change)
  //   2. Discover — Find top traders  (view=discover, gate=click #workflow-start)
  //   3. While that runs…             (view=discover, no gate)
  //   4. Leaderboard tour             (view=leaderboard, gate=click any Decode)
  //   5. Strategies tour              (view=strategies, no gate)
  //   6. Paper trading + sample data  (view=paper, no gate, inject mock card)
  //   7. Live trading + sample data   (view=live, no gate, inject mock card)
  //   8. Back to Discover — save      (view=discover, gate=fallback button)
  //   9. Decode a wallet directly     (view=discover, gate=fallback button)
  //  10. You're ready                 (Finish button — sets done flag)
  //
  // Each gated step also offers a "Just continue →" escape link so a
  // user who can't find the target never gets stuck. Cleanup functions
  // returned by gate.listen() are run when the step changes or the tour
  // is dismissed, so click handlers don't leak.
  //
  // State key (unchanged — the screenshot script reads this name):
  //   localStorage.pbx_onboarding_v1_done = '1'  → never show again.
  //
  // Current step is NOT persisted — a reload restarts at step 1.

  const ONBOARD_KEY = 'pbx_onboarding_v1_done';

  // Each step is { title, body: (string|Node)[], view?: 'discover'|...,
  //                highlight?: selector, gate?: {description, listen} }.
  // gate.listen(advance) wires an action listener and returns a cleanup
  // function; advance() is the tour's "go to next step" callback.
  let onboardSteps = null;
  let onboardCurrent = 0;
  // Active gate cleanup — invoked on step change / dismiss so click
  // handlers wired by gate.listen() don't accumulate.
  let onboardGateCleanup = null;
  // Track which sample-data injections are live so we can remove them
  // when leaving the relevant step or dismissing the tour.
  let onboardSampleNodes = [];

  function buildOnboardSteps() {
    const steps = [];

    // 1 — Welcome / congrats (with confetti)
    steps.push({
      title: "You're set up",
      body: () => [
        el('p', null,
          "Claude just audited the code, installed dependencies, generated your wallet keys, started the dashboard server and paper-trade bot, and registered six background watchdogs. ",
          "This tour shows you how to actually use what you've got."),
        el('p', { class: 'muted' }, 'Eleven short steps follow — most just take a click. You can skip anytime, or replay later with the "?" Setup Guide icon top-left.'),
      ],
      onEnter: () => onboardConfetti(),
    });

    // 2 — Discover: click Find top traders
    //
    // First-run state shows #welcome-hero with its big #hero-start
    // CTA; once the user has bots, the workflow card with
    // #workflow-start is what's visible. The tour fires on first
    // visit so #hero-start is the practical target, but we gate on
    // BOTH so the step advances no matter which CTA the user clicks.
    steps.push({
      title: 'Step 1: Discover top traders',
      view: 'discover',
      // The tour only fires on first visit, when #welcome-hero is
      // showing — so #hero-start is the visible CTA. The gate below
      // listens for both #hero-start and #workflow-start so the tour
      // advances no matter which button the user actually clicks.
      highlight: '#hero-start',
      body: () => [
        el('p', null,
          'Discover finds the wallets currently making money on PBX. Click the green ',
          el('strong', { class: 'text-emerald-300' }, 'Find top traders & decode'),
          ' button to start the search. It takes about two minutes.'),
        el('p', { class: 'muted' },
          "While it runs we'll walk through the rest of the dashboard."),
      ],
      gate: {
        description: 'Waiting for: click Find top traders & decode',
        listen: (advance) => {
          const heroBtn = document.getElementById('hero-start');
          const wfBtn   = document.getElementById('workflow-start');
          const handler = () => advance();
          if (heroBtn) heroBtn.addEventListener('click', handler, { once: true });
          if (wfBtn)   wfBtn.addEventListener('click',   handler, { once: true });
          return () => {
            if (heroBtn) heroBtn.removeEventListener('click', handler);
            if (wfBtn)   wfBtn.removeEventListener('click',   handler);
          };
        },
      },
    });

    // 3 — Discovery running, let's tour the rest
    steps.push({
      title: 'Step 2: While that runs, let’s tour the rest of the site',
      view: 'discover',
      body: () => [
        el('p', null,
          "Discovery is working in the background. Meanwhile, let me show you the other four pages so you know what's where."),
        el('p', { class: 'muted' }, 'Click Next to keep moving.'),
      ],
    });

    // 4 — Leaderboard: click any wallet's Decode button
    steps.push({
      title: 'Step 3: The Leaderboard',
      view: 'leaderboard',
      highlight: '#market-leaderboard',
      body: () => [
        el('p', null,
          'Leaderboard ranks every wallet Discover has found, sorted by recent P&L. ',
          'Pick a wallet that looks interesting and click its ',
          el('strong', { class: 'text-emerald-300' }, 'Decode'),
          ' button — that kicks off the strategy reverse-engineering and takes you to the Strategies page.'),
        el('p', { class: 'muted' },
          "If the table is still loading, hit Refresh up top or use Just continue below."),
      ],
      gate: {
        description: 'Waiting for: click Decode on any wallet row',
        listen: (advance) => {
          // The per-row Decode markup is generated dynamically and
          // doesn't carry a stable data-attr — match on button text +
          // the leaderboard container so we don't fire on stray
          // "decode" text elsewhere on the page.
          const container = document.getElementById('market-leaderboard');
          const handler = (e) => {
            if (!container) return;
            const btn = e.target.closest('button');
            if (!btn || !container.contains(btn)) return;
            const txt = (btn.textContent || '').trim().toLowerCase();
            if (txt === 'decode' || txt === 'starting…') advance();
          };
          document.addEventListener('click', handler, true);
          return () => document.removeEventListener('click', handler, true);
        },
      },
    });

    // 5 — Strategies (no gate)
    //
    // Highlights the "Decoded strategies" section card (not the whole
    // #view-strategies <main> container — that's 1440px wide so the
    // outline is invisible at viewport scale). The decoded-section
    // wrapper exists statically in dashboard.html, so it's present
    // the instant showView('strategies') flips the view visible.
    steps.push({
      title: 'Step 4: Strategies',
      view: 'strategies',
      highlight: '#strategies-decoded-section',
      body: () => [
        el('p', null,
          'You just kicked off the wallet decoder. It runs Claude in a loop against historical trades to extract the entry and exit rules. ',
          'Decoded strategies land here.'),
        el('p', null,
          'From this page you can backtest, deploy to paper, or promote to live. Click Next to keep touring.'),
      ],
    });

    // 6 — Paper trading + injected sample data
    //
    // Highlights #bot-cards (where injectSamplePaperBots writes its
    // preview cards). Previous #view-paper drew the outline around
    // the entire 1440px <main> — invisible at viewport scale because
    // the outline IS the page edge.
    steps.push({
      title: 'Step 5: Paper trading',
      view: 'paper',
      highlight: '#bot-cards',
      onEnter: () => injectSamplePaperBots(),
      onLeave: () => removeSampleNodes(),
      body: () => [
        el('p', null,
          'Paper trading runs a strategy against live market prices without spending real money. ',
          'Use it to validate a decoded strategy before going live.'),
        el('p', { class: 'muted' },
          "We've shown you some sample data here so you can see what an active paper bot looks like."),
      ],
    });

    // 7 — Live trading + injected sample data
    //
    // Highlights #onboard-live-sample (the injected sample bot section
    // — see injectSampleLiveBots). renderOnboardStep runs onEnter
    // BEFORE onboardHighlight, so the sample section exists in the
    // DOM by the time the highlight selector resolves. Previous
    // #view-live was the full <main> container — invisible outline.
    steps.push({
      title: 'Step 6: Live trading',
      view: 'live',
      highlight: '#onboard-live-sample',
      onEnter: () => injectSampleLiveBots(),
      onLeave: () => removeSampleNodes(),
      body: () => [
        el('p', null,
          'Live trading is the real-money mode. A bot here actually swaps USDC for region tokens on Solana mainnet. ',
          'Only promote strategies you’ve paper-traded for at least a week.'),
        el('p', { class: 'muted' },
          "Like paper, we've populated some sample bots so you can see the layout."),
      ],
    });

    // 8 — Wallet setup reminder, anchored on the Live trading view
    //     so the funder-card is right there as the user reads it.
    //
    // Skip-able by design: the user might be exploring with no
    // intent to trade live. Live-trading endpoints stay 503 until
    // BOT_HD_MNEMONIC is set up + the funder is funded, so deferring
    // is safe.
    steps.push({
      title: 'Step 7: Set up your wallet (optional)',
      view: 'live',
      highlight: '#funder-card',
      body: () => [
        el('p', null,
          "Discovery's still running in the background. While you wait, lock down your wallet so you're ready if you decide to trade live later. ",
          "The card highlighted above is your ",
          el('strong', null, 'funder wallet'),
          ' — every live bot derives from it.'),
        el('div', { class: 'border border-amber-500/30 bg-amber-500/5 rounded p-3 text-[12px] space-y-2' },
          el('div', { class: 'text-amber-200 font-medium' }, '⚠ Recommended (skippable):'),
          el('ul', { class: 'list-disc ml-5 space-y-1.5 text-zinc-300 leading-relaxed' },
            el('li', null,
              'Back up the 24-word recovery phrase: open ',
              el('code', { class: 'mono text-amber-200' }, '~/.pbx-bots/local.env'),
              ' and copy the words after ',
              el('code', { class: 'mono text-amber-200' }, 'BOT_HD_MNEMONIC='),
              ' onto paper. Fireproof storage. ',
              el('strong', null, 'Do not screenshot, do not paste into a cloud sync.'),
            ),
            el('li', null,
              "If you want to actually trade live later, send USDC + SOL to the address shown on the funder card above (~$50 USDC + ~0.05 SOL covers one bot). ",
              el('span', { class: 'muted' }, "Skip this if you're just paper-trading — costs nothing."),
            ),
          ),
        ),
        el('p', { class: 'muted text-[12px]' },
          "Not ready yet? Click Next to skip — you can come back to this anytime. ",
          "Live trading stays gated until you do, but everything else still works."),
      ],
    });

    // 9 — Strategies page (where decoded strategies populate after Discover)
    //
    // Navigates to /view-strategies + highlights the decoded-strategies
    // section card so the user can SEE where their decoded strategies
    // will land once Discover finishes. (Was #view-strategies — same
    // invisible-outline issue as Step 4.)
    steps.push({
      title: 'Step 8: Where the cool stuff lands',
      view: 'strategies',
      highlight: '#strategies-decoded-section',
      body: () => [
        el('p', null,
          'This is the Strategies page — every decoded wallet Discover finishes turns into a strategy on this list.'),
        el('p', null,
          'Each row is a reverse-engineered rule with its own entry filters, exit logic, and a status flag (paper / live). ',
          'You can backtest any strategy, deploy it as a paper bot, or promote a paper-tested winner to live.'),
        el('p', { class: 'muted text-[12px]' },
          "Page might be empty right now — Discover hasn't finished yet. Strategies populate here in real time as it does."),
      ],
    });

    // 10 — Health page (system at a glance)
    //
    // Navigate to /view-health + pulse-highlight the 7-check card
    // (id="health-checks-card", added by renderHealth) so the user
    // sees the live system status. Reassuring "we're watching
    // everything for you" beat right before the final achievements
    // step — they should leave the tour feeling supervised, not alone.
    //
    // renderHealth is async — onboardHighlight retries up to ~2s
    // for the selector to land in the DOM, so the highlight catches
    // the card after the API response settles.
    steps.push({
      title: 'Step 9: Your system, at a glance',
      view: 'health',
      highlight: '#health-checks-card',
      body: () => [
        el('p', null,
          'The Health page is your one-screen ops view. The 7-check above tracks server uptime, ',
          'paper-trade heartbeat freshness, AQI feed, disk space, and the Solana RPC connection — all live.'),
        el('p', null,
          'Six background watchdogs (STRATOS-* scheduled tasks) also run on their own cadence ',
          'every 5 min / hourly / daily — they handle health checks, weather pulls, daily digests, ',
          'state + codebase backups, and outage recovery without you ever clicking anything.'),
        el('p', { class: 'muted text-[12px]' },
          'Green dots = humming. Red = something needs attention. Hit "Re-check" up top to refresh.'),
      ],
    });

    // 11 — Achievements page (the final step before handoff)
    //
    // Navigate to /view-achievements and highlight the profile/progress
    // card (id="achievements-profile-card", added by renderAchievements)
    // so the user sees their auto-tracked progress. This is also where
    // the tour lands — the final Ready step stays on this view.
    //
    // renderAchievements is async — onboardHighlight retries up to ~2s
    // for the selector to land in the DOM.
    steps.push({
      title: 'Step 10: Your roadmap + achievements',
      view: 'achievements',
      highlight: '#achievements-profile-card',
      body: () => [
        el('p', null,
          'Every install gets a 7-section, 131-task roadmap. Section 1 (Genesis) is mostly auto-tracked ',
          'already — Claude detects what you\'ve done from your install state and marks it complete.'),
        el('p', null,
          'Sections 2 through 7 unlock as you ',
          el('strong', null, 'trade, decode wallets, and explore the dashboard'),
          '. Tasks in those sections need a real action to fire — Claude celebrates each one in your chosen personality voice.'),
        el('div', { class: 'mt-2 p-3 rounded border border-emerald-500/40 bg-emerald-500/5 text-[12px]' },
          el('div', { class: 'text-zinc-100 font-medium mb-1' }, '💡 How to actually complete the rest'),
          el('p', { class: 'text-zinc-300' },
            'Just talk to Claude in chat. Say things like ',
            el('em', { class: 'text-emerald-300' }, '"help me decode a wallet"'),
            ', ',
            el('em', { class: 'text-emerald-300' }, '"show me my next achievement"'),
            ', or ',
            el('em', { class: 'text-emerald-300' }, '"deploy a paper bot"'),
            ' — Claude knows the roadmap and will guide you through each milestone, then mark them done automatically when conditions are met.'),
        ),
      ],
    });

    // 12 — You're ready (final handoff, lands on Achievements view)
    //
    // Stay on the Achievements view from step 11 — gives the user a
    // visual anchor (their progress card) while they read the
    // Telegram CTA + handoff line. No highlight; the modal IS the
    // focal point here.
    steps.push({
      title: "You're ready to start",
      view: 'achievements',
      body: () => [
        el('p', null,
          "That's the whole site. The roadmap is now your map — work through it with Claude one chat at a time, and the achievements page tracks every milestone in real time."),
        el('div', { class: 'mt-2 p-3 rounded border border-emerald-500/40 bg-emerald-500/5' },
          el('div', { class: 'text-[12px] text-zinc-100 font-medium mb-1' }, 'Join the PBX Stratos operator community'),
          el('p', { class: 'text-[12px] text-zinc-300 mb-2' },
            'Other operators meet on Telegram to compare strategies, share decoded wallets, and coordinate during signal regime changes. Free to join.'),
          el('a', {
            href: 'https://t.me/+CmFL4HXFGFE3NTgx',
            target: '_blank',
            rel: 'noopener noreferrer',
            class: 'inline-block bg-emerald-500 text-[#0a0d13] font-medium rounded px-4 py-1.5 text-[12px] hover:bg-emerald-400 transition',
          }, 'Open Telegram invite ↗'),
        ),
        el('p', { class: 'muted text-[12px] mt-2' },
          'Replay this tour anytime — click the "?" Setup Guide icon at the top of the sidebar.'),
      ],
    });

    return steps;
  }

  // ── Sample data injection ────────────────────────────────────────────
  // Steps 6 + 7 inject mock paper/live bots so empty views still demo
  // what real data looks like. Tracked in `onboardSampleNodes` so we
  // can yank them when leaving the step or dismissing the tour.

  function buildSampleBotCard(opts) {
    // Mirrors the visual language of botCard() without trying to mock
    // every internal field — a single descriptive card per spec, with
    // a SAMPLE pill so the user knows it's preview, not their data.
    const accent = opts.live ? '#fb7185' : '#7dd3fc';
    return el('article', {
      class: 'card rounded-xl p-5 glow-up',
      style: '--accent: ' + accent + '; border-left: 3px solid ' + accent + ';',
    },
      el('header', { class: 'flex items-start justify-between gap-3 mb-3' },
        el('div', { class: 'flex items-center gap-2 flex-wrap' },
          el('span', { class: 'text-sm font-semibold text-zinc-50' }, opts.name),
          el('span', {
            class: 'text-[10px] mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
          }, 'RUNNING'),
          el('span', {
            class: 'text-[10px] mono px-1.5 py-0.5 rounded ' + (opts.live
              ? 'bg-rose-500/10 text-rose-300 border border-rose-500/30'
              : 'bg-sky-500/10 text-sky-300 border border-sky-500/30'),
          }, opts.live ? 'LIVE' : 'PAPER'),
          el('span', { class: 'onboard-sample-pill' }, 'SAMPLE'),
        ),
        el('div', { class: 'text-right' },
          el('div', { class: 'label' }, 'Lifetime PnL'),
          el('div', { class: 'text-2xl mono leading-none ' + (opts.pnlPositive ? 'text-emerald-400' : 'text-rose-400') }, opts.pnl),
          el('div', { class: 'text-[12px] mono opacity-80 muted' }, opts.age + ' · ' + opts.closed + ' closed'),
        ),
      ),
      el('div', { class: 'grid grid-cols-2 gap-3 text-[12px] mono text-zinc-300' },
        el('div', null, el('div', { class: 'label' }, 'Strategy'), el('div', null, opts.strategy)),
        el('div', null, el('div', { class: 'label' }, 'Last tick'), el('div', null, opts.lastTick)),
      ),
    );
  }

  function injectSamplePaperBots() {
    removeSampleNodes();
    const host = document.getElementById('bot-cards');
    if (!host) return;
    const cards = [
      buildSampleBotCard({
        name: 'paper-eg-1', strategy: 'mean_reversion', live: false,
        pnl: '+4.7%', pnlPositive: true, age: 'up 2h', closed: '3',
        lastTick: '12s ago',
      }),
      buildSampleBotCard({
        name: 'paper-eg-2', strategy: 'pm25_zscore', live: false,
        pnl: '+1.2%', pnlPositive: true, age: 'up 8h', closed: '7',
        lastTick: '8s ago',
      }),
    ];
    const wrap = el('div', { id: 'onboard-paper-sample', class: 'contents' });
    cards.forEach((c) => wrap.append(c));
    host.append(wrap);
    onboardSampleNodes.push(wrap);
  }

  function injectSampleLiveBots() {
    removeSampleNodes();
    const view = document.getElementById('view-live');
    if (!view) return;
    // The live view is currently a single empty-state card. Insert the
    // samples ABOVE the empty card so the user sees both: the layout
    // they'll get once funded, and the real empty state below it.
    const wrap = el('section', {
      id: 'onboard-live-sample',
      class: 'grid grid-cols-3 gap-4',
    },
      buildSampleBotCard({
        name: 'live-eg-1', strategy: 'mean_reversion', live: true,
        pnl: '+2.1%', pnlPositive: true, age: 'up 1d', closed: '5',
        lastTick: '10s ago',
      }),
      buildSampleBotCard({
        name: 'live-eg-2', strategy: 'pm25_zscore', live: true,
        pnl: '-0.4%', pnlPositive: false, age: 'up 3d', closed: '12',
        lastTick: '6s ago',
      }),
    );
    view.prepend(wrap);
    onboardSampleNodes.push(wrap);
  }

  function removeSampleNodes() {
    while (onboardSampleNodes.length) {
      const node = onboardSampleNodes.pop();
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
  }

  // ── Highlight + step rendering ───────────────────────────────────────

  // Cancel-token for an in-flight highlight retry loop. Set when a
  // selector misses on the first try and we begin polling; cleared
  // when a new highlight call starts so we don't have two retry
  // loops racing each other.
  let onboardHighlightRetryToken = 0;

  // Recomputes .onboard-backdrop's clip-path so it covers the full
  // viewport EXCEPT a hole around the currently-highlighted element.
  // Called on every highlight change + on every scroll / resize so the
  // hole follows the target as the viewport changes. Without this,
  // some highlight targets (e.g. #hero-start, which lives inside the
  // z-52-lifted #welcome-hero) ended up with a confined dim that
  // didn't actually cover the rest of the page — only the area within
  // their parent stacking context — so the surrounding content stayed
  // bright. A viewport-fixed dim with a clip-path hole avoids that
  // entirely: it dims the whole viewport, period.
  function updateBackdropClip() {
    const backdrop = document.getElementById('onboard-backdrop');
    if (!backdrop) return;
    // No backdrop dim needed when the tour isn't open.
    if (backdrop.classList.contains('hidden')) {
      backdrop.style.clipPath = '';
      return;
    }
    const target = document.querySelector('.onboard-highlight');
    if (!target) {
      // No highlight on this step (welcome, intermediate, final) →
      // dim the entire viewport with no hole.
      backdrop.style.clipPath = '';
      return;
    }
    const r = target.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 6px padding around the highlight so the dim hole is slightly
    // larger than the card and the pulse outline sits comfortably
    // inside the bright area.
    const pad = 6;
    const x1 = Math.max(0, Math.floor(r.left - pad));
    const y1 = Math.max(0, Math.floor(r.top - pad));
    const x2 = Math.min(vw, Math.ceil(r.right + pad));
    const y2 = Math.min(vh, Math.ceil(r.bottom + pad));
    // Polygon path: trace the viewport clockwise, then jump inward
    // and trace the hole counter-clockwise. The shared edge from
    // (0,0) to (x1,y1) and back is invisible since the polygon's
    // fill is a single connected region with the inner rect
    // subtracted out by the path's self-overlap.
    const path =
      '0 0,' +
      vw + 'px 0,' +
      vw + 'px ' + vh + 'px,' +
      '0 ' + vh + 'px,' +
      '0 0,' +
      x1 + 'px ' + y1 + 'px,' +
      x1 + 'px ' + y2 + 'px,' +
      x2 + 'px ' + y2 + 'px,' +
      x2 + 'px ' + y1 + 'px,' +
      x1 + 'px ' + y1 + 'px,' +
      '0 0';
    backdrop.style.clipPath = 'polygon(' + path + ')';
  }

  // Throttle clip recomputes during high-frequency events (scroll,
  // resize, smooth-scroll animation) via requestAnimationFrame so we
  // don't recompute on every wheel tick.
  let onboardClipRafPending = false;
  function scheduleClipUpdate() {
    if (onboardClipRafPending) return;
    onboardClipRafPending = true;
    requestAnimationFrame(() => {
      onboardClipRafPending = false;
      updateBackdropClip();
    });
  }
  window.addEventListener('scroll', scheduleClipUpdate, { passive: true });
  window.addEventListener('resize', scheduleClipUpdate);

  // Watch the highlighted element's own size — when a view's data
  // lands asynchronously (leaderboard rows arriving, achievements
  // sections expanding, sample bots injected), the target element
  // GROWS after the clip was first computed. ResizeObserver fires on
  // each size change so the clip-path hole follows the element's
  // current dimensions. Only one observed target at a time — we
  // re-observe whenever onboardHighlight applies a new highlight.
  let onboardHighlightResizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    onboardHighlightResizeObserver = new ResizeObserver(scheduleClipUpdate);
  }
  function observeHighlightForResize(el) {
    if (!onboardHighlightResizeObserver) return;
    onboardHighlightResizeObserver.disconnect();
    if (el) onboardHighlightResizeObserver.observe(el);
  }

  function onboardHighlight(selector) {
    // Bump the retry token first — any in-flight poll from a previous
    // step is now stale and will bail on its next tick.
    onboardHighlightRetryToken += 1;
    const myToken = onboardHighlightRetryToken;

    document.querySelectorAll('.onboard-highlight').forEach((node) => node.classList.remove('onboard-highlight'));
    if (!selector) {
      // No highlight on this step — clip the backdrop full (no hole)
      // so the dim covers everything except the modal.
      updateBackdropClip();
      return;
    }

    // Try once immediately; if it lands, we're done. Otherwise poll
    // up to ~2s for async-rendered targets — Step 9 (Health) and
    // Step 10 (Achievements) trigger renderHealth/renderAchievements
    // via showView() and the inner cards (#health-checks-card,
    // #achievements-profile-card) don't exist until the API response
    // settles. 100ms × 20 ticks = 2s budget, plenty for the fetch.
    const apply = (target) => {
      target.classList.add('onboard-highlight');
      // Re-point the ResizeObserver at the new target so its async
      // growth (leaderboard rows arriving, achievements sections
      // expanding) re-clips the dim around its new size.
      observeHighlightForResize(target);
      // Scroll the highlighted target into the top half of the
      // viewport so the bottom-anchored modal doesn't cover it.
      // Brief delay so the .onboard-highlight class is painted
      // before the scroll animation starts.
      setTimeout(() => {
        try {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          // Add a little headroom above so the sticky header doesn't clip it.
          window.scrollBy({ top: -80, behavior: 'smooth' });
        } catch { /* old browser, no smooth-scroll — non-fatal */ }
      }, 80);
      // Punch the dim hole around this target. Run twice — once
      // right away and once after the scroll has settled — so the
      // clip lands on the correct rect after smooth-scrolling. The
      // ResizeObserver above handles any subsequent grow events
      // (e.g. when async API data lands).
      updateBackdropClip();
      setTimeout(updateBackdropClip, 500);
    };

    const immediate = document.querySelector(selector);
    if (immediate) { apply(immediate); return; }

    // Poll loop — bails if the user advanced to another step (the
    // retry token has been bumped) so we don't apply a stale highlight.
    let attempts = 0;
    const maxAttempts = 20;
    const poll = () => {
      if (myToken !== onboardHighlightRetryToken) return;
      const target = document.querySelector(selector);
      if (target) { apply(target); return; }
      if (++attempts >= maxAttempts) return;
      setTimeout(poll, 100);
    };
    setTimeout(poll, 100);
  }

  // ── Achievement unlock toasts (Steam-style, bottom-right) ───────────
  //
  // Server-side detection lives in /api/ops/achievements: each call
  // re-runs the detector array and returns `autoUnlockedThisRequest`
  // listing any task IDs unlocked in THAT request. We poll every ~30s
  // regardless of which dashboard view is active, dedupe against a
  // localStorage set so an unlock never toasts twice, and render a
  // theme-aware card at bottom-right + a confetti burst from the
  // toast's corner.
  //
  // Storage shape: localStorage.pbx_toasted_unlocks is a JSON array of
  // task IDs we've already shown a toast for. Cleared by Reset-Fresh.

  function loadToastedUnlocks() {
    try {
      const raw = localStorage.getItem('pbx_toasted_unlocks');
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr : []);
    } catch { return new Set(); }
  }
  function saveToastedUnlocks(set) {
    try { localStorage.setItem('pbx_toasted_unlocks', JSON.stringify(Array.from(set))); }
    catch { /* quota / private mode — non-fatal */ }
  }

  // Fire confetti from the bottom-right corner where the toast lives.
  // Smaller / shorter than the onboarding burst — this is celebratory
  // but shouldn't dominate the screen.
  function achievementConfetti() {
    if (typeof window.confetti !== 'function') return;
    const c = window.confetti;
    // Theme-aware colors: pull from CSS vars set by the active theme,
    // falling back to the framework's emerald palette.
    const root = getComputedStyle(document.documentElement);
    const themeColor = (root.getPropertyValue('--accent-primary') || '').trim()
                    || (root.getPropertyValue('--theme-accent') || '').trim()
                    || '#10b981';
    const colors = [themeColor, '#34d399', '#fbbf24', '#a78bfa', '#f0abfc'];
    const defaults = { startVelocity: 30, ticks: 80, zIndex: 60, gravity: 0.9, colors };
    // Burst angled up-and-to-the-left away from the bottom-right corner
    // so particles fan into the visible viewport, not off-screen.
    c({ ...defaults, particleCount: 60, angle: 135, spread: 70, origin: { x: 0.93, y: 0.92 } });
    // Tiny follow-up burst for movement.
    setTimeout(() => {
      c({ ...defaults, particleCount: 30, angle: 120, spread: 90, origin: { x: 0.88, y: 0.95 } });
    }, 220);
  }

  // Render one toast in the bottom-right stack. Auto-dismisses after
  // ~6s. Stack supports multiple toasts when several unlocks land in
  // a single poll — they cascade up the right edge.
  function showAchievementToast(unlock) {
    const stack = document.getElementById('achievement-toast-stack');
    if (!stack) return;
    const titleText = unlock.title || ('Unlocked: ' + unlock.taskId);
    const descText  = unlock.description || '';
    const imgUrl    = unlock.imageUrl || ('/achievements/img/' + encodeURIComponent(unlock.taskId));

    const toast = document.createElement('div');
    toast.className = 'pbx-achievement-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    const img = document.createElement('div');
    img.className = 'pbx-achievement-toast-img';
    img.innerHTML = '<img src="' + imgUrl + '" alt="" width="48" height="48"/>';

    const body = document.createElement('div');
    body.className = 'pbx-achievement-toast-body';

    const eyebrow = document.createElement('div');
    eyebrow.className = 'pbx-achievement-toast-eyebrow';
    eyebrow.textContent = 'Achievement Unlocked';

    const title = document.createElement('div');
    title.className = 'pbx-achievement-toast-title';
    title.textContent = titleText;

    const desc = document.createElement('div');
    desc.className = 'pbx-achievement-toast-desc';
    desc.textContent = descText;

    body.append(eyebrow, title, desc);
    toast.append(img, body);
    stack.append(toast);

    // Slide-in animation handled by CSS keyframe + class flip.
    requestAnimationFrame(() => toast.classList.add('pbx-achievement-toast-visible'));

    // Click on the toast: jump to the achievement in the list (open
    // its section, scroll the row into view, pulse it ~10s) and
    // dismiss. Dismiss anyway so the user can still click an X-style
    // close — there's no separate close button; the whole toast is
    // the navigate trigger.
    toast.addEventListener('click', () => {
      navigateToAchievement(unlock.taskId);
      dismissToast(toast);
    });
    toast.style.cursor = 'pointer';
    toast.title = 'Click to jump to this achievement in the list';

    // Auto-dismiss after 6s.
    setTimeout(() => dismissToast(toast), 6000);
  }

  // Flip a row from "not done" to "done" without re-rendering the
  // whole achievements view. Used by the manual mark buttons so the
  // user keeps their scroll position and the surrounding list state.
  // The row gets a brief pulse to confirm the click landed before the
  // toast slides in.
  function applyDoneToRow(rowEl, task) {
    if (!rowEl) return;
    // Toggle the checkbox icon if we can find it inside the row.
    const cb = rowEl.querySelector('.inline-flex.items-center.justify-center.w-4.h-4');
    if (cb) {
      cb.textContent = '✓';
      cb.className = 'inline-flex items-center justify-center w-4 h-4 rounded border shrink-0 mt-0.5 '
        + 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300';
    }
    // Swap the trailing button (last flex child) with a static "manual ✓"
    // indicator so the user can't double-click and re-fire the request.
    const lastChild = rowEl.lastElementChild;
    if (lastChild && lastChild.tagName === 'BUTTON') {
      const indicator = document.createElement('span');
      indicator.className = 'text-[10px] mono muted shrink-0';
      indicator.title = 'Manually marked done';
      indicator.textContent = 'manual ✓';
      lastChild.parentNode.replaceChild(indicator, lastChild);
    }
    // Mark task model done in case anything reads it later.
    if (task) task.done = true;
  }

  // Programmatic navigation from a toast click. Switches to the
  // achievements view if necessary, expands the row's parent section
  // if collapsed, scrolls the row into view, and adds a pulsing-glow
  // class that auto-clears after ~10s.
  function navigateToAchievement(taskId) {
    if (!taskId) return;
    // 1. Switch view if we're not already on Achievements. Note that
    // showView('achievements') triggers renderAchievements() which
    // tears down + rebuilds the DOM; our row-pulse needs to find the
    // FRESH row, so we wait a beat before querying.
    if (typeof showView === 'function') {
      try { showView('achievements'); } catch { /* falls through */ }
    }
    // Poll for the row — showView triggers an async render of the
    // achievements view, so the row DOM node might not exist yet at
    // toast-click time. Retry every 100ms for up to 2 seconds; give
    // up silently if the render never lands (network failure, etc.)
    // rather than leave a hanging timer.
    const selector = '.achievement-row[data-task-id="' + cssEscape(taskId) + '"]';
    let attempts = 0;
    const tryFind = () => {
      const row = document.querySelector(selector);
      if (row) {
        // Walk up to the parent section card and expand its body if hidden.
        const section = row.closest('section.card[data-section-id]');
        if (section && section._body && section._body.classList.contains('hidden')) {
          section._body.classList.remove('hidden');
          if (section._chev) section._chev.style.transform = 'rotate(90deg)';
        }
        // Scroll the row to center-ish, smooth.
        try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        catch { row.scrollIntoView(); /* old browser */ }
        // Apply the pulse class for 10s, then clear so subsequent
        // navigations re-trigger the animation cleanly.
        row.classList.add('achievement-row-pulsing');
        setTimeout(() => row.classList.remove('achievement-row-pulsing'), 10000);
        return;
      }
      if (++attempts < 20) setTimeout(tryFind, 100);
    };
    tryFind();
  }

  // CSS.escape polyfill for old browsers — only used for the
  // data-task-id selector which contains a "." (e.g. "s1.t3").
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
      return CSS.escape(s);
    }
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
  }

  function dismissToast(toast) {
    if (!toast || !toast.parentNode) return;
    toast.classList.add('pbx-achievement-toast-leaving');
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 350);
  }

  // Background poll: hits /api/ops/achievements every ~30s regardless
  // of which view is open. The endpoint runs server-side detection and
  // returns any IDs unlocked in that call as `autoUnlockedThisRequest`,
  // plus the canonical title/description from achievement-pack lookup.
  // For each ID we haven't toasted yet, fire toast + confetti + record.
  async function pollAchievementsForToasts() {
    let data;
    try { data = await api('/api/ops/achievements'); }
    catch { return; /* server hiccup; retry next tick */ }
    if (!data || typeof data !== 'object') return;
    const fresh = Array.isArray(data.autoUnlockedThisRequest)
      ? data.autoUnlockedThisRequest : [];
    if (fresh.length === 0) return;
    const seen = loadToastedUnlocks();
    // Build a quick lookup of taskId → { title, description } from the
    // sections payload so we can render rich content without a second
    // API call. Falls back to taskId-only if a section row isn't found.
    const idMeta = {};
    if (Array.isArray(data.sections)) {
      for (const sec of data.sections) {
        if (!Array.isArray(sec.tasks)) continue;
        for (const t of sec.tasks) idMeta[t.id] = { title: sec.name + ' — ' + t.id, description: t.description };
      }
    }
    let toasted = 0;
    for (const id of fresh) {
      if (seen.has(id)) continue;
      const meta = idMeta[id] || {};
      showAchievementToast({
        taskId: id,
        title: meta.title || ('Unlocked: ' + id),
        description: meta.description || '',
      });
      seen.add(id);
      toasted++;
    }
    if (toasted > 0) {
      saveToastedUnlocks(seen);
      // One confetti burst per poll, even if multiple unlocked at once —
      // the toast stack already conveys multiplicity visually.
      achievementConfetti();
    }
  }

  // ── Confetti (step 1 celebration) ────────────────────────────────────
  // Uses canvas-confetti loaded via CDN in dashboard.html. Fires from
  // both sides + a top burst, runs ~2.5s, then stops. No-op if the
  // library failed to load (offline / CDN block).
  function onboardConfetti() {
    if (typeof window.confetti !== 'function') return;
    const c = window.confetti;
    const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 9999, gravity: 0.8 };
    const colors = ['#10b981', '#34d399', '#6ee7b7', '#fbbf24', '#a78bfa', '#38bdf8'];
    // Top burst
    c({ ...defaults, particleCount: 80, origin: { x: 0.5, y: 0.15 }, colors });
    // Side cannons every 250ms for ~2.5s
    let bursts = 0;
    const interval = setInterval(() => {
      bursts += 1;
      if (bursts > 10) { clearInterval(interval); return; }
      c({ ...defaults, particleCount: 35, angle: 60,  spread: 65, origin: { x: 0,    y: 0.7 }, colors });
      c({ ...defaults, particleCount: 35, angle: 120, spread: 65, origin: { x: 1,    y: 0.7 }, colors });
    }, 250);
  }

  function renderOnboardDots() {
    const host = document.getElementById('onboard-dots');
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    for (let i = 0; i < onboardSteps.length; i++) {
      const dot = document.createElement('span');
      dot.className = 'onboard-dot' + (i < onboardCurrent ? ' done' : i === onboardCurrent ? ' current' : '');
      host.append(dot);
    }
  }

  function clearGateCleanup() {
    if (typeof onboardGateCleanup === 'function') {
      try { onboardGateCleanup(); } catch { /* swallow — listener already gone */ }
    }
    onboardGateCleanup = null;
  }

  function advanceOnboard() {
    if (onboardCurrent >= onboardSteps.length - 1) {
      finishOnboarding(false);
      return;
    }
    onboardCurrent++;
    renderOnboardStep();
  }

  function renderOnboardStep() {
    // Tear down the previous step: cleanup any gate listener, run the
    // outgoing step's onLeave (e.g. remove injected samples) only if
    // the next step doesn't share the same one.
    clearGateCleanup();
    // Always clear samples — each step that wants them re-injects in
    // onEnter. This keeps the live/paper sample data isolated.
    removeSampleNodes();

    const step = onboardSteps[onboardCurrent];

    // View navigation BEFORE the modal repaints so the page settles
    // under the dim backdrop while the user reads.
    if (step.view && typeof showView === 'function') {
      try { showView(step.view); } catch { /* showView guarded internally */ }
    }
    if (typeof step.onEnter === 'function') {
      try { step.onEnter(); } catch { /* injection failures are non-fatal */ }
    }

    document.getElementById('onboard-stepnum').textContent = (onboardCurrent + 1) + ' of ' + onboardSteps.length;
    document.getElementById('onboard-title').textContent = step.title;

    const body = document.getElementById('onboard-body');
    while (body.firstChild) body.removeChild(body.firstChild);
    for (const node of step.body()) body.append(node);

    renderOnboardDots();
    onboardHighlight(step.highlight || null);
    updateOnboardControls();

    // Wire the gate AFTER controls are rendered (so the "Just continue"
    // link exists to receive its click handler). Auto-advance fires
    // after a 600ms delay so the user sees their action register.
    if (step.gate && typeof step.gate.listen === 'function') {
      const advanceWithDelay = () => {
        clearGateCleanup();
        setTimeout(() => {
          // Re-check we're still on the same step before advancing —
          // a manual click on "Just continue" may have already moved
          // us forward.
          if (onboardSteps[onboardCurrent] === step) advanceOnboard();
        }, 600);
      };
      onboardGateCleanup = step.gate.listen(advanceWithDelay);
    }
  }

  function updateOnboardControls() {
    const step = onboardSteps[onboardCurrent];
    const prev = document.getElementById('onboard-prev');
    const next = document.getElementById('onboard-next');
    const body = document.getElementById('onboard-body');
    if (prev) prev.disabled = onboardCurrent === 0;
    if (!next || !body) return;

    if (step.gate) {
      // Gated step — replace the Next button with a "Waiting for…" pill
      // plus an escape link, and surface a confirm button if the gate
      // provides one (steps 8 + 9 where no real DOM target exists).
      next.classList.add('hidden');
      const gateWrap = el('div', { class: 'mt-3 flex items-center gap-3 flex-wrap' });
      gateWrap.append(el('span', { class: 'onboard-waiting' }, step.gate.description));
      if (step.gate.confirmLabel) {
        const confirmBtn = el('button', {
          type: 'button',
          class: 'border border-emerald-500/50 text-emerald-300 rounded px-3 py-1.5 hover:bg-emerald-500/10 transition text-[12px]',
        }, step.gate.confirmLabel);
        confirmBtn.addEventListener('click', () => {
          clearGateCleanup();
          advanceOnboard();
        });
        gateWrap.append(confirmBtn);
      }
      const skipLink = el('button', {
        type: 'button', class: 'onboard-skip-gate',
      }, 'Just continue →');
      skipLink.addEventListener('click', () => {
        clearGateCleanup();
        advanceOnboard();
      });
      gateWrap.append(skipLink);
      body.append(gateWrap);
    } else {
      next.classList.remove('hidden');
      next.disabled = false;
      next.textContent = onboardCurrent === onboardSteps.length - 1
        ? 'Finish'
        : 'Next';
    }
  }

  function openOnboardOverlay() {
    onboardSteps = onboardSteps || buildOnboardSteps();
    onboardCurrent = 0;
    document.getElementById('onboard-backdrop').classList.remove('hidden');
    document.getElementById('onboard-modal').classList.remove('hidden');
    // Toggle a body class so CSS can shrink the giant 82vh welcome
    // hero (and any other normally-full-height landing elements) into
    // a compact form that doesn't collide with the bottom-anchored
    // modal. Removed on close.
    document.body.classList.add('onboard-active');
    renderOnboardStep();
  }

  function closeOnboardOverlay(showToast) {
    clearGateCleanup();
    removeSampleNodes();
    const backdrop = document.getElementById('onboard-backdrop');
    if (backdrop) {
      backdrop.classList.add('hidden');
      // Clear the inline clip-path so the next time the tour opens
      // the backdrop starts unclipped (covers the full viewport) and
      // we don't briefly show a stale hole from the previous session.
      backdrop.style.clipPath = '';
    }
    document.getElementById('onboard-modal').classList.add('hidden');
    document.body.classList.remove('onboard-active');
    onboardHighlight(null);
    if (showToast) {
      const toast = document.getElementById('onboard-toast');
      if (toast) {
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 4000);
      }
    }
  }

  function finishOnboarding(viaSkip) {
    try { localStorage.setItem(ONBOARD_KEY, '1'); } catch { /* private-mode etc */ }
    closeOnboardOverlay(!viaSkip);
  }

  function initOnboarding() {
    const modal = document.getElementById('onboard-modal');
    if (!modal) return; // markup missing — nothing to wire
    document.getElementById('onboard-prev').addEventListener('click', () => {
      if (onboardCurrent > 0) {
        onboardCurrent--;
        renderOnboardStep();
      }
    });
    document.getElementById('onboard-next').addEventListener('click', () => {
      // Gated steps hide this button entirely, so this branch only
      // fires for non-gated steps (and the final Finish).
      if (onboardCurrent < onboardSteps.length - 1) {
        onboardCurrent++;
        renderOnboardStep();
      } else {
        finishOnboarding(false);
      }
    });
    document.getElementById('onboard-skip').addEventListener('click', () => {
      const ok = window.confirm('Skip the tour? You can replay it anytime via the "?" Setup Guide icon at the top of the sidebar.');
      if (ok) finishOnboarding(true);
    });
  }

  function maybeStartOnboarding() {
    let done = null;
    try { done = localStorage.getItem(ONBOARD_KEY); } catch { /* fall through */ }
    if (done === '1') return;
    openOnboardOverlay();
  }

  // ============ Health view (bear-watch ops) ============
  //
  // Mirrors the 7-check health-check.py output plus pm2 process state,
  // scheduled-task state, and the alert tail. Source endpoint:
  // GET /api/ops/health (see bots/src/server/index.ts). Re-renders on
  // each visit (cheap, no polling).

  // Format a uptime in seconds → human-friendly "2h 14m" / "3d 4h" / etc.
  function fmtUptime(sec) {
    if (sec == null || !Number.isFinite(sec)) return '—';
    sec = Math.max(0, Math.floor(sec));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + (sec % 60) + 's';
    return sec + 's';
  }

  // Format an ISO timestamp → "May 21, 14:32:05" local. Returns "—" on
  // null/invalid input.
  function fmtTs(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  // Status pill: emerald (ok), rose (bad), amber (warn). Matches the
  // pattern used in #health-pills + the workflow chips.
  function statusPill(label, kind) {
    const palette = {
      ok:   'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
      bad:  'bg-rose-500/15 text-rose-300 border-rose-500/30',
      warn: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
      idle: 'bg-zinc-700/30 text-zinc-300 border-zinc-700/60',
    };
    const cls = palette[kind] || palette.idle;
    return el('span', {
      class: 'inline-flex items-center text-[10px] font-semibold mono tracking-wide '
        + 'uppercase px-2 py-0.5 rounded border ' + cls,
    }, label);
  }

  // Colored dot for the 3 top-status indicators. Pulses when ok.
  function statusDot(kind) {
    const bg = kind === 'ok' ? 'bg-emerald-400' : (kind === 'bad' ? 'bg-rose-400' : 'bg-amber-400');
    const pulse = kind === 'ok' ? ' pulse-dot' : '';
    return el('span', { class: 'inline-block w-2 h-2 rounded-full ' + bg + pulse });
  }

  async function renderHealth() {
    const host = document.getElementById('view-health');
    if (!host) return;
    // While fetching, leave a slim loading state in place. On error,
    // show a one-line rose message + a Retry button.
    replace(host,
      el('div', { class: 'card rounded-xl py-16 px-6 text-center' },
        el('div', { class: 'text-[13px] muted' }, 'Loading health…')),
    );
    let data;
    try {
      data = await api('/api/ops/health');
    } catch (err) {
      const retryBtn = el('button', {
        class: 'border border-zinc-700 rounded px-3 py-1 text-[11px] mono '
          + 'hover:border-zinc-500 text-zinc-300 transition mt-3',
      }, 'Retry');
      retryBtn.addEventListener('click', () => renderHealth());
      replace(host,
        el('div', { class: 'card rounded-xl py-12 px-6 text-center space-y-2' },
          el('div', { class: 'text-[13px] text-rose-300' },
            'Could not load health — ' + (err && err.message ? err.message : 'unknown error')),
          retryBtn),
      );
      return;
    }

    // ── Top status row: Server / Paper-trade bot / RPC ──
    const serverKind = data.server && data.server.online ? 'ok' : 'bad';
    const paperKind = data.paperTrade && data.paperTrade.online ? 'ok' : 'bad';
    const rpcKind = data.rpc && data.rpc.reachable ? 'ok' : 'bad';

    function topCard(title, kind, valueNode, sub) {
      return el('div', { class: 'card rounded-xl p-5 flex items-center gap-4' },
        statusDot(kind),
        el('div', { class: 'flex-1 min-w-0' },
          el('div', { class: 'text-[11px] mono muted uppercase tracking-wide' }, title),
          el('div', { class: 'mono text-base value mt-0.5' }, valueNode),
          sub ? el('div', { class: 'text-[11px] muted mono mt-0.5 truncate' }, sub) : null,
        ),
      );
    }

    const serverValue = data.server && data.server.online
      ? 'up ' + fmtUptime(data.server.uptimeSec)
      : 'down';
    const serverSub = 'port ' + (data.server && data.server.port != null
      ? data.server.port : '—')
      + (data.server && data.server.version ? ' · ' + data.server.version : '');

    const paperValue = data.paperTrade && data.paperTrade.online
      ? 'live'
      : 'stalled';
    const paperSub = data.paperTrade && data.paperTrade.heartbeatAgeSec != null
      ? fmtUptime(data.paperTrade.heartbeatAgeSec) + ' since last tick'
      : 'no heartbeat file';

    const rpcValue = data.rpc && data.rpc.reachable
      ? ('slot ' + (data.rpc.slot != null ? data.rpc.slot : '—'))
      : 'unreachable';
    const rpcSub = (data.rpc && data.rpc.latencyMs != null
      ? data.rpc.latencyMs + 'ms · ' : '')
      + (data.rpc && data.rpc.url ? data.rpc.url : '');

    const topRow = el('section', { class: 'grid grid-cols-1 md:grid-cols-3 gap-4' },
      topCard('Server', serverKind, serverValue, serverSub),
      topCard('Paper-trade bot', paperKind, paperValue, paperSub),
      topCard('RPC', rpcKind, rpcValue, rpcSub),
    );

    // ── 7-check card ──
    const checks = Array.isArray(data.checks) ? data.checks : [];
    const greenCount = checks.filter((c) => c.ok).length;
    const recheckBtn = el('button', {
      class: 'border border-zinc-700 rounded px-3 py-1 text-[11px] mono '
        + 'hover:border-zinc-500 text-zinc-300 transition',
    }, 'Re-check');
    recheckBtn.addEventListener('click', () => renderHealth());

    const checksHeader = el('header', { class: 'mb-4 flex items-baseline justify-between gap-4' },
      el('div', null,
        el('div', { class: 'text-sm font-semibold text-zinc-50' }, '7-check health'),
        el('div', { class: 'text-[12px] muted mt-0.5' },
          greenCount + ' / ' + checks.length + ' green · checked ' + fmtTs(data.checkedAt)),
      ),
      recheckBtn,
    );

    const checkRows = checks.map((c) => el('div', {
      class: 'flex items-center gap-3 py-2 border-b border-zinc-800/60 last:border-b-0',
    },
      el('div', { class: 'flex-1 min-w-0' },
        el('div', { class: 'text-[13px] text-zinc-100' }, c.name),
        el('div', { class: 'text-[11px] muted mono truncate' }, c.detail || ''),
      ),
      statusPill(c.ok ? 'green' : 'red', c.ok ? 'ok' : 'bad'),
    ));

    // id="health-checks-card" is the stable selector the onboarding
    // tour Step 9 highlights. Must stay on the section element (not
    // a child) so the pulse outline frames the whole 7-check card.
    const checksCard = el('section', {
      id: 'health-checks-card',
      class: 'card rounded-xl p-5',
    },
      checksHeader,
      checks.length === 0
        ? el('div', { class: 'text-[12px] muted text-center py-4' }, 'No checks reported.')
        : el('div', null, ...checkRows),
    );

    // ── pm2 process supervisor card ──
    // Filter to only `-stratos`-suffixed apps so the panel never
    // displays processes from a sibling install (pbxtra etc) sharing
    // the same pm2 daemon, or the shared pm2-logrotate module. The
    // user explicitly wants the dashboard to feel "this install only."
    const allPm2 = Array.isArray(data.pm2) ? data.pm2 : [];
    const pm2List = allPm2.filter((p) => (p && typeof p.name === 'string' && p.name.endsWith('-stratos')));
    const pm2Header = el('header', { class: 'mb-3' },
      el('div', { class: 'text-sm font-semibold text-zinc-50' }, 'pm2 process supervisor'),
      el('div', { class: 'text-[12px] muted mt-0.5' },
        pm2List.length + ' stratos process' + (pm2List.length === 1 ? '' : 'es') + ' tracked'),
    );

    let pm2Body;
    if (pm2List.length === 0) {
      pm2Body = el('div', { class: 'text-[12px] muted py-2' },
        'pm2 not available on this host (or no PBX processes are running).');
    } else {
      const head = el('div', {
        class: 'grid grid-cols-7 gap-3 text-[10px] tracking-wide muted '
          + 'uppercase border-b border-zinc-800/60 pb-2 mb-2',
      },
        el('div', null, 'Name'),
        el('div', null, 'Status'),
        el('div', { class: 'text-right' }, 'PID'),
        el('div', { class: 'text-right' }, 'Uptime'),
        el('div', { class: 'text-right' }, 'Mem'),
        el('div', { class: 'text-right' }, 'Restarts'),
        el('div', { class: 'text-right' }, 'CPU'),
      );
      const rows = pm2List.map((p) => {
        const kind = p.status === 'online' ? 'ok' : (p.status === 'stopped' ? 'idle' : 'bad');
        return el('div', { class: 'grid grid-cols-7 gap-3 py-1.5 text-[12px] mono text-zinc-300' },
          el('div', { class: 'text-zinc-100 truncate' }, p.name || '—'),
          el('div', null, statusPill(p.status || 'unknown', kind)),
          el('div', { class: 'text-right' }, p.pid != null ? String(p.pid) : '—'),
          el('div', { class: 'text-right' }, fmtUptime(p.uptimeSec)),
          el('div', { class: 'text-right' }, p.memMb != null ? p.memMb + ' MB' : '—'),
          el('div', { class: 'text-right' }, p.restarts != null ? String(p.restarts) : '—'),
          el('div', { class: 'text-right' }, p.cpu != null ? p.cpu + '%' : '—'),
        );
      });
      pm2Body = el('div', null, head, ...rows);
    }

    const pm2Card = el('section', { class: 'card rounded-xl p-5' }, pm2Header, pm2Body);

    // ── Scheduled watchdogs card ──
    const tasks = Array.isArray(data.scheduledTasks) ? data.scheduledTasks : [];
    const tasksHeader = el('header', { class: 'mb-3' },
      el('div', { class: 'text-sm font-semibold text-zinc-50' }, 'Scheduled watchdogs'),
      el('div', { class: 'text-[12px] muted mt-0.5' },
        tasks.length + ' STRATOS-* task' + (tasks.length === 1 ? '' : 's')),
    );

    let tasksBody;
    if (tasks.length === 0) {
      tasksBody = el('div', { class: 'text-[12px] muted py-2' },
        'No scheduled watchdogs reported. Run bear-watch/register-scheduled-tasks.ps1 to install.');
    } else {
      const head = el('div', {
        class: 'grid grid-cols-5 gap-3 text-[10px] tracking-wide muted '
          + 'uppercase border-b border-zinc-800/60 pb-2 mb-2',
      },
        el('div', null, 'Name'),
        el('div', null, 'Schedule'),
        el('div', null, 'Last run'),
        el('div', null, 'Last result'),
        el('div', null, 'Next run'),
      );
      const rows = tasks.map((t) => el('div', {
        class: 'grid grid-cols-5 gap-3 py-1.5 text-[12px] mono text-zinc-300',
      },
        el('div', { class: 'text-zinc-100 truncate', title: t.name || '' }, t.name || '—'),
        el('div', { class: 'truncate' }, t.schedule || '—'),
        el('div', { class: 'truncate' }, fmtTs(t.lastRunIso)),
        el('div', { class: 'truncate' }, t.lastResult || '—'),
        el('div', { class: 'truncate' }, fmtTs(t.nextRunIso)),
      ));
      tasksBody = el('div', null, head, ...rows);
    }

    const tasksCard = el('section', { class: 'card rounded-xl p-5' },
      tasksHeader, tasksBody);

    // ── Recent alerts card ──
    // Caption now shows the canonical Layer-3 runtime path (the
    // server reads STRATOS_LAB_HOME ?? ~/.pbx-lab — see index.ts —
    // and writes there). The legacy ~/.pbx-lab/ caption was stale
    // after the three-layer architecture migration.
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];
    const alertsHeader = el('header', { class: 'mb-3 flex items-center justify-between gap-3' },
      el('div', null,
        el('div', { class: 'text-sm font-semibold text-zinc-50' }, 'Recent alerts'),
        el('div', { class: 'text-[12px] muted mt-0.5' },
          'Tail of runtime/lab/alerts.jsonl (last 10)'),
      ),
      alerts.length === 0 ? statusDot('ok') : null,
    );

    let alertsBody;
    if (alerts.length === 0) {
      alertsBody = el('div', { class: 'text-[12px] muted py-2 flex items-center gap-2' },
        el('span', { class: 'text-emerald-300' }, 'No alerts. Everything’s quiet.'));
    } else {
      const sevKind = (s) => s === 'error' ? 'bad' : (s === 'warn' ? 'warn' : 'idle');
      alertsBody = el('div', { class: 'space-y-2' },
        ...alerts.map((a) => el('div', {
          class: 'flex items-start gap-3 text-[12px] py-1 border-b border-zinc-800/40 last:border-b-0',
        },
          el('span', { class: 'mono muted shrink-0' }, fmtTs(a.ts)),
          el('span', { class: 'shrink-0' }, statusPill(a.severity || 'info', sevKind(a.severity))),
          el('span', { class: 'text-zinc-200 mono break-words' }, a.message || ''),
        )),
      );
    }

    const alertsCard = el('section', { class: 'card rounded-xl p-5' },
      alertsHeader, alertsBody);

    replace(host, topRow, checksCard, pm2Card, tasksCard, alertsCard);
  }

  // ============ Achievements view (roadmap progress) ============
  //
  // GET /api/ops/achievements returns a composite of:
  //   - profile (personality + tech_level + autonomy_level + roadmap level)
  //   - sections[] with per-task done state derived from
  //     ~/.pbx-lab/user-profile.json achievements_unlocked array
  //   - eventAchievements[] from achievements/definitions.json
  //
  // Per-section cards collapse/expand on click; the current section is
  // auto-expanded on first render. POST /api/ops/achievements/mark
  // flips a task to done and re-renders.

  // Personality color → small visible cue for the profile header. Maps
  // each known personality to a hue. Unknown ids fall through to emerald.
  function personalityColor(id) {
    switch (id) {
      case 'crypto-bro':       return '#fbbf24';   // gold
      case 'drill-sergeant':   return '#f43f5e';   // red
      case 'surf-bro':         return '#38bdf8';   // sky
      case 'quant-professor':  return '#a78bfa';   // violet
      case 'hacker':           return '#22d3ee';   // cyan
      default:                 return '#10b981';   // emerald (default)
    }
  }

  // Personality-voiced tagline keyed off personality_id. Each line ends
  // with "{done} of {total} tasks" interpolated by the caller. Default
  // is neutral.
  function personalityTagline(id, done, total) {
    const remaining = Math.max(0, total - done);
    switch (id) {
      case 'crypto-bro':
        return 'LFG ser — you’ve cleared ' + done + ' of ' + total + ' tasks. ' + remaining + ' more to the bag.';
      case 'drill-sergeant':
        return 'STATUS REPORT, OPERATOR — ' + done + ' of ' + total + ' tasks down. ' + remaining + ' remaining. Move.';
      case 'surf-bro':
        return done + ' of ' + total + ' tasks ridden, dude. ' + remaining + ' more waves coming in — stay patient.';
      case 'quant-professor':
        return 'Progress: ' + done + ' / ' + total + ' tasks (' + (total > 0 ? Math.round(done * 100 / total) : 0) + '%). Variance below — fewer surprises ahead.';
      case 'hacker':
        return 'commits: ' + done + '/' + total + ' · ' + remaining + ' tasks pending compile';
      default:
        return done + ' of ' + total + ' tasks complete. ' + remaining + ' to go.';
    }
  }

  async function renderAchievements() {
    const host = document.getElementById('view-achievements');
    if (!host) return;
    replace(host,
      el('div', { class: 'card rounded-xl py-16 px-6 text-center' },
        el('div', { class: 'text-[13px] muted' }, 'Loading achievements…')),
    );
    let data;
    try {
      data = await api('/api/ops/achievements');
    } catch (err) {
      const retryBtn = el('button', {
        class: 'border border-zinc-700 rounded px-3 py-1 text-[11px] mono '
          + 'hover:border-zinc-500 text-zinc-300 transition mt-3',
      }, 'Retry');
      retryBtn.addEventListener('click', () => renderAchievements());
      replace(host,
        el('div', { class: 'card rounded-xl py-12 px-6 text-center space-y-2' },
          el('div', { class: 'text-[13px] text-rose-300' },
            'Could not load achievements — ' + (err && err.message ? err.message : 'unknown error')),
          retryBtn),
      );
      return;
    }

    const profile = data.profile || {};
    const sections = Array.isArray(data.sections) ? data.sections : [];
    const eventAchievements = Array.isArray(data.eventAchievements) ? data.eventAchievements : [];
    // Server tells us which task IDs run through auto-detection (presently
    // Section 1 only). The remainder still use the Mark-done button.
    const autoDetected = new Set(Array.isArray(data.autoDetectedTasks) ? data.autoDetectedTasks : []);
    // Manual outliers in Section 1 that the detector intentionally CAN'T
    // verify (paper mnemonic backup, voice call). These render as a
    // user-flippable checkbox so the existing /mark endpoint still works.
    const sectionOneManualIds = new Set(['s1.t7', 's1.t14']);

    // ── Profile header card ──
    const totalDone = sections.reduce((sum, s) => sum + (s.doneTasks || 0), 0);
    const totalTasks = sections.reduce((sum, s) => sum + (s.totalTasks || 0), 0);
    // Roadmap level the user is reported to be on; fall back to the
    // first non-complete section, then to 1 if everything is done.
    let level = Number(profile.roadmap_level) || 0;
    if (!level) {
      const idx = sections.findIndex((s) => (s.doneTasks || 0) < (s.totalTasks || 0));
      level = idx === -1 ? Math.max(1, sections.length) : (idx + 1);
    }
    level = Math.max(1, Math.min(sections.length || 7, level));
    const currentSection = sections[level - 1] || sections[0];
    const sectionPct = currentSection && currentSection.totalTasks > 0
      ? Math.round((currentSection.doneTasks || 0) * 100 / currentSection.totalTasks)
      : 0;

    const avatar = el('span', {
      class: 'inline-block w-10 h-10 rounded-full',
      style: 'background:' + personalityColor(profile.personality_id),
      title: profile.personality_id || 'default',
    });
    const profileMeta = el('div', { class: 'flex-1 min-w-0' },
      el('div', { class: 'text-[13px] text-zinc-100 mono' },
        profile.personality_id || 'default',
        ' · ', profile.tech_level || '—',
        ' · ', profile.autonomy_level || '—',
      ),
      el('div', { class: 'text-lg font-semibold text-zinc-50 mt-1' },
        'You’re at Roadmap Level ', String(level), ' of ', String(sections.length || 7),
        currentSection ? ' · ' + currentSection.name : '',
      ),
      el('div', { class: 'mt-2' },
        el('div', { class: 'h-2 rounded bg-zinc-800/80 overflow-hidden' },
          el('div', { class: 'h-full bg-emerald-500', style: 'width:' + sectionPct + '%' })),
        el('div', { class: 'text-[11px] muted mono mt-1' },
          sectionPct + '% through ' + (currentSection ? currentSection.name : '')
          + ' · ' + (currentSection ? (currentSection.doneTasks + ' / ' + currentSection.totalTasks) : '0 / 0')
          + ' tasks'),
      ),
      el('div', { class: 'text-[12px] text-zinc-300 mt-2' },
        personalityTagline(profile.personality_id, totalDone, totalTasks)),
    );

    // id="achievements-profile-card" is the stable selector the
    // onboarding tour Step 10 highlights. Frames the whole "Roadmap
    // Level N · <section name> · progress bar" header card.
    const profileCard = el('section', {
      id: 'achievements-profile-card',
      class: 'card rounded-xl p-5 flex items-center gap-4',
    },
      avatar, profileMeta);

    // ── Section cards (collapsible, current section auto-expanded) ──
    const sectionCards = sections.map((sec, i) => {
      const isCurrent = (i + 1) === level;
      const pct = sec.totalTasks > 0 ? Math.round((sec.doneTasks || 0) * 100 / sec.totalTasks) : 0;
      const body = el('div', { class: isCurrent ? 'mt-4 space-y-2' : 'mt-4 space-y-2 hidden' });
      const chev = el('span', {
        class: 'text-[12px] muted mono transition-transform',
        style: 'display:inline-block;' + (isCurrent ? 'transform:rotate(90deg);' : ''),
      }, '▶');

      const header = el('header', {
        class: 'flex items-baseline justify-between gap-4 cursor-pointer select-none',
      },
        el('div', { class: 'flex items-baseline gap-3 min-w-0' },
          chev,
          el('div', { class: 'text-sm font-semibold text-zinc-50 truncate' },
            'Section ' + (i + 1) + ' · ' + (sec.name || '')),
        ),
        el('div', { class: 'flex items-baseline gap-3 shrink-0' },
          el('div', { class: 'text-[11px] muted mono' },
            (sec.doneTasks || 0) + ' / ' + (sec.totalTasks || 0)),
          el('div', { class: 'w-32 h-1.5 rounded bg-zinc-800/80 overflow-hidden' },
            el('div', { class: 'h-full bg-emerald-500', style: 'width:' + pct + '%' })),
        ),
      );
      header.addEventListener('click', () => {
        const open = !body.classList.contains('hidden');
        body.classList.toggle('hidden', open);
        chev.style.transform = open ? '' : 'rotate(90deg)';
      });

      // True for any section that contains at least one auto-detected
      // task. Currently Section 1 is the only one — see autoDetected.
      const tasks = Array.isArray(sec.tasks) ? sec.tasks : [];
      const sectionHasAuto = tasks.some((t) => autoDetected.has(t.id));

      const rows = tasks.map((task) => {
        // Stable selector so the toast-click handler can find this row,
        // expand its parent section, scroll it into view, and pulse it
        // for ~10s after a manual mark or programmatic navigation.
        const rowEl = el('div', {
          class: 'achievement-row flex items-start gap-4 py-4 px-2 border-b border-zinc-800/40 last:border-b-0 rounded-md',
          'data-task-id': task.id,
        });

        // Per-achievement badge. All achievements currently use the
        // same placeholder SVG (served via /achievements/img/:id with
        // currentColor so themes recolor it). When we ship per-task
        // art the server-side route will branch on :id.
        const badge = el('div', {
          class: 'pbx-achievement-row-badge shrink-0 w-12 h-12 flex items-center justify-center',
        });
        const badgeImg = document.createElement('img');
        badgeImg.src = '/achievements/img/' + encodeURIComponent(task.id);
        badgeImg.alt = '';
        badgeImg.width = 48; badgeImg.height = 48;
        badgeImg.loading = 'lazy';
        badge.appendChild(badgeImg);

        const checkbox = el('span', {
          class: 'inline-flex items-center justify-center w-4 h-4 rounded border shrink-0 mt-0.5 '
            + (task.done
              ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300'
              : 'border-zinc-700 text-transparent'),
        }, task.done ? '✓' : '');

        // Three render modes for the trailing control:
        //   1. auto-tracked task → small muted label (no button)
        //   2. manual outlier in Section 1 (s1.t7, s1.t14) → user-flippable
        //      checkbox that POSTs to /mark
        //   3. anything else → existing "Mark done" button
        let trailing = null;
        if (autoDetected.has(task.id)) {
          // Mode 1: server has detection logic for this one.
          trailing = el('span', {
            class: 'text-[10px] mono muted shrink-0 inline-flex items-center gap-1',
            title: task.done
              ? 'Auto-detected — last refresh confirmed this is done'
              : 'Auto-detected on refresh — no manual marking needed',
          }, el('span', { style: 'display:inline-block;' }, '↻'), 'auto-tracked');
        } else if (sectionOneManualIds.has(task.id)) {
          // Mode 2: manual outlier. Render a flippable checkbox (one-way:
          // we never auto-untick a manual claim).
          if (!task.done) {
            const manualBtn = el('button', {
              class: 'text-[10px] mono rounded px-2 py-0.5 border border-amber-500/40 '
                + 'text-amber-200 hover:bg-amber-500/10 transition shrink-0 inline-flex items-center gap-1',
              title: 'Manual — Claude can\'t verify this. Click once you\'ve done it.',
            }, el('span', null, '☐'), 'manual: mark done');
            manualBtn.addEventListener('click', async (ev) => {
              ev.stopPropagation();
              manualBtn.disabled = true;
              manualBtn.textContent = 'saving…';
              try {
                await apiPost('/api/ops/achievements/mark', { taskId: task.id });
                // Optimistic in-place update — no full re-render. Flip
                // the checkbox icon + colors, replace the button with
                // the "manual ✓" indicator, mark the row done.
                applyDoneToRow(rowEl, task);
                // Pre-register with the toast-dedupe set so the 30s
                // background poll doesn't re-toast this same id.
                const seenSet = loadToastedUnlocks();
                seenSet.add(task.id);
                saveToastedUnlocks(seenSet);
                // Toast + confetti right away (≤ 1.5s) so the user sees
                // the celebration tied to their click, not a delayed
                // poll-driven popup.
                setTimeout(() => {
                  showAchievementToast({
                    taskId: task.id,
                    title: task.title || task.id,
                    description: task.description || '',
                  });
                  achievementConfetti();
                }, 250);
              } catch (err) {
                manualBtn.disabled = false;
                manualBtn.textContent = 'retry';
                manualBtn.className = 'text-[10px] mono rounded px-2 py-0.5 border border-rose-500/40 '
                  + 'text-rose-300 hover:bg-rose-500/10 transition shrink-0';
                manualBtn.title = 'Could not mark — ' + (err && err.message ? err.message : 'error');
              }
            });
            trailing = manualBtn;
          } else {
            trailing = el('span', {
              class: 'text-[10px] mono muted shrink-0',
              title: 'Manually marked done',
            }, 'manual ✓');
          }
        } else if (!task.done) {
          // Mode 3: legacy Mark-done button for Sections 2-7 (no
          // auto-detector yet — future work).
          const markBtn = el('button', {
            class: 'text-[10px] mono rounded px-2 py-0.5 border border-emerald-500/40 '
              + 'text-emerald-300 hover:bg-emerald-500/10 transition shrink-0',
            title: 'Mark this task complete',
          }, 'Mark done');
          markBtn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            markBtn.disabled = true;
            markBtn.textContent = 'saving…';
            try {
              await apiPost('/api/ops/achievements/mark', { taskId: task.id });
              applyDoneToRow(rowEl, task);
              const seenSet = loadToastedUnlocks();
              seenSet.add(task.id);
              saveToastedUnlocks(seenSet);
              setTimeout(() => {
                showAchievementToast({
                  taskId: task.id,
                  title: task.title || task.id,
                  description: task.description || '',
                });
                achievementConfetti();
              }, 250);
            } catch (err) {
              markBtn.disabled = false;
              markBtn.textContent = 'retry';
              markBtn.className = 'text-[10px] mono rounded px-2 py-0.5 border border-rose-500/40 '
                + 'text-rose-300 hover:bg-rose-500/10 transition shrink-0';
              markBtn.title = 'Could not mark — ' + (err && err.message ? err.message : 'error');
            }
          });
          trailing = markBtn;
        }

        // Build the row's content: badge + title block + trailing control.
        const titleRow = el('div', { class: 'flex items-center gap-2 mb-1 flex-wrap' },
          checkbox,
          el('span', { class: 'text-[11px] mono muted shrink-0' }, task.id || ''),
          el('div', { class: 'text-[13.5px] font-semibold text-zinc-100' }, task.title || task.id || ''),
        );
        const descEl = el('div', { class: 'text-[12px] text-zinc-300 leading-snug' }, task.description || '');
        const titleBlock = el('div', { class: 'flex-1 min-w-0' }, titleRow, descEl);

        rowEl.appendChild(badge);
        rowEl.appendChild(titleBlock);
        if (trailing) rowEl.appendChild(trailing);
        return rowEl;
      });

      // Per-section auto-tracked footer note. Only sections that contain
      // at least one auto-detected task get the note; everything else
      // looks identical to the pre-auto-detection UI.
      const autoFooter = sectionHasAuto
        ? el('div', { class: 'text-[10px] muted mono mt-2 italic' },
            'Claude auto-tracks these — no manual marking needed. Refresh the page to re-detect.')
        : null;

      replace(body, rows.length > 0
        ? el('div', null, ...rows)
        : el('div', { class: 'text-[12px] muted text-center py-3' }, 'No tasks in this section yet.'),
        autoFooter);

      // Tag the section card with its id ('s1', 's2', ...) so the
      // toast-click → navigate handler can find it and ensure its body
      // is expanded before scrolling to the row.
      const sectionCard = el('section', {
        class: 'card rounded-xl p-5',
        'data-section-id': sec.id,
      }, header, body);
      // Expose the body's hidden-toggle so the row-pulse navigator can
      // open a collapsed section without simulating a click.
      sectionCard._body = body;
      sectionCard._chev = chev;
      return sectionCard;
    });

    // ── Event-driven achievements ──
    const eventGrid = el('div', { class: 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3' },
      ...eventAchievements.map((a) => {
        const unlocked = !!a.unlocked;
        return el('div', {
          class: 'rounded-lg p-4 border ' + (unlocked
            ? 'border-emerald-500/40 bg-emerald-500/5'
            : 'border-zinc-800/60 bg-[#0a0d13] opacity-60'),
        },
          el('div', { class: 'flex items-baseline justify-between gap-2 mb-1' },
            el('div', { class: 'text-[13px] font-semibold ' + (unlocked ? 'text-emerald-200' : 'text-zinc-400') }, a.name || a.id || ''),
            statusPill(unlocked ? 'unlocked' : 'locked', unlocked ? 'ok' : 'idle'),
          ),
          el('div', { class: 'text-[11px] text-zinc-300 leading-snug' }, a.description || ''),
          a.criteria
            ? el('div', { class: 'text-[10px] muted mono mt-2 italic' }, a.criteria)
            : null,
          unlocked && a.unlockedAt
            ? el('div', { class: 'text-[10px] mono muted mt-1' }, 'unlocked ' + fmtTs(a.unlockedAt))
            : null,
        );
      }),
    );

    const eventCard = el('section', { class: 'card rounded-xl p-5' },
      el('header', { class: 'mb-4' },
        el('div', { class: 'text-sm font-semibold text-zinc-50' }, 'Event-driven achievements'),
        el('div', { class: 'text-[12px] muted mt-0.5' },
          'Auto-unlocked from ~/.pbx-lab/events.jsonl — no manual attestation needed.'),
      ),
      eventAchievements.length === 0
        ? el('div', { class: 'text-[12px] muted py-2' }, 'No event-driven achievements defined.')
        : eventGrid,
    );

    // Top-of-page control row: a Refresh detection button that re-fetches
    // /api/ops/achievements so the user can force a re-scan after, say,
    // installing dependencies or finishing the personality quiz.
    const refreshBtn = el('button', {
      class: 'text-[11px] mono rounded px-3 py-1 border border-zinc-700 hover:border-emerald-500 '
        + 'text-zinc-200 hover:text-emerald-200 transition shrink-0 inline-flex items-center gap-1',
      title: 'Re-scan local state and update auto-tracked tasks',
    }, el('span', null, '↻'), 'Refresh detection');
    refreshBtn.addEventListener('click', () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'scanning…';
      renderAchievements();
    });
    // If the server unlocked one or more tasks during this request, show
    // a subtle inline note. (autoUnlockedThisRequest is set by index.ts.)
    const justUnlocked = Array.isArray(data.autoUnlockedThisRequest)
      ? data.autoUnlockedThisRequest : [];
    const justUnlockedNote = justUnlocked.length > 0
      ? el('span', { class: 'text-[11px] text-emerald-300 mono ml-auto' },
          'Auto-unlocked ' + justUnlocked.length + ' task' + (justUnlocked.length === 1 ? '' : 's') + ' on this refresh.')
      : null;
    const controlBar = el('div', { class: 'flex items-center gap-3 mb-1' },
      refreshBtn, justUnlockedNote);

    replace(host, controlBar, profileCard, ...sectionCards, eventCard);
  }

  // ============ dynamic header-height tracking ============
  // The sidebar's `top` + `height` reference --header-height (see
  // dashboard.html). We update that custom property whenever the
  // header's rendered height could change: initial load, viewport
  // resize, and any UI toggle that shows/hides header content (KPI
  // strip on Discover vs hidden on Achievements/Health, etc).
  //
  // Without this, the sidebar's top offset is hardcoded and either
  // leaves a gap below the header or overlaps it — depending on
  // which view's KPI visibility is active. Symptom user reported:
  // "gap between the sidebar and the header on all themes."
  (function trackHeaderHeight() {
    const root = document.documentElement;
    const header = document.querySelector('header');
    if (!header) return;

    // Round UP so the sidebar never overlaps the header at sub-pixel
    // viewport scales (high-DPI Windows scaling).
    function apply() {
      const h = Math.ceil(header.getBoundingClientRect().height);
      root.style.setProperty('--header-height', h + 'px');
    }
    apply();
    // Re-measure on viewport resize.
    window.addEventListener('resize', apply, { passive: true });
    // Re-measure when the header itself changes size (KPIs shown/hidden,
    // backup-banner appearing, etc). ResizeObserver fires on any layout-
    // affecting change inside the observed element.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(apply).observe(header);
    }
    // Also re-measure after any view switch via the nav (showView only
    // toggles `.hidden` on views, but the KPI strip + show-stopped +
    // fleet-mode-filter all flip visibility based on hasBots — which
    // can ripple to a render shortly after).
    document.querySelectorAll('#sidebar [data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        // setTimeout to let the showView toggle + any DOM updates settle
        // before re-measuring.
        setTimeout(apply, 0);
      });
    });
  })();

  // ============ theme motif injection ============
  // Themes that want a "shooting-star" atmospheric layer opt in by
  // setting --motif-enabled: 1 on :root. When that flag is set, we
  // inject N individual motif spans into <body> — each with its own
  // randomized position, animation-delay, and duration via inline
  // CSS custom properties. The theme's CSS handles the shape (via
  // background-image / pseudo content) and the keyframe animation.
  //
  // Why individual DOM elements instead of one tiled pseudo:
  //   Pure-CSS pseudos paint a SAME tile repeatedly — every visible
  //   "$" fades together because they share one animation timeline.
  //   To get per-element shooting-star independence each motif must
  //   be its own element with its own animation-delay seed.
  //
  // ~32 elements is the sweet spot for a typical 1440px viewport —
  // enough density that 2-3 are visibly peaking at any moment but
  // never crowding the screen. Counts per type are tunable.
  (function injectThemeMotifs() {
    // Defensive: skip if already injected (script loaded twice).
    if (document.querySelector('.motif-layer')) return;

    const enabled = getComputedStyle(document.documentElement)
      .getPropertyValue('--motif-enabled').trim();
    if (enabled !== '1') return;

    const layer = document.createElement('div');
    layer.className = 'motif-layer';
    layer.setAttribute('aria-hidden', 'true');

    // 48 elements total — 16 of each VARIANT. The variants are
    // generic (v1 / v2 / v3) so each theme can define its own three
    // motif shapes via .motif-v1, .motif-v2, .motif-v3 selectors
    // without the JS needing per-theme knowledge. With the 25%-duty
    // opacity envelope, ~12 are visibly peaking at any given moment.
    // Negative-delay seeding (below) keeps the visibility floor
    // around 8 — the user-requested minimum.
    const counts = { v1: 16, v2: 16, v3: 16 };
    for (const type in counts) {
      for (let i = 0; i < counts[type]; i++) {
        const span = document.createElement('span');
        span.className = 'motif motif-' + type;
        // Per-element randomness:
        //  --mx / --my : random viewport position (covers any size).
        //  --d         : NEGATIVE animation-delay so each element jumps
        //                straight into a random mid-cycle phase on
        //                first render. Without this, elements with
        //                large positive delays sit invisible for up to
        //                15s after page load — that's the "first 10-15
        //                seconds nothing loads" the user reported.
        //  --dur       : 10-16s jitter so elements with identical
        //                delays still drift out of sync over time.
        //  --dx / --dy : random direction (0-360°) + 18-38px total
        //                displacement. Visible window is only 25% of
        //                the cycle, so the user sees ~5-10px of actual
        //                motion per element — alive but not floating
        //                away.
        const angle = Math.random() * Math.PI * 2;
        const distance = 18 + Math.random() * 20;
        const dx = Math.cos(angle) * distance;
        const dy = Math.sin(angle) * distance;
        span.style.setProperty('--mx', (Math.random() * 100).toFixed(2) + 'vw');
        span.style.setProperty('--my', (Math.random() * 100).toFixed(2) + 'vh');
        span.style.setProperty('--d',  (-Math.random() * 16).toFixed(2) + 's');
        span.style.setProperty('--dur', (10 + Math.random() * 6).toFixed(2) + 's');
        span.style.setProperty('--dx', dx.toFixed(1) + 'px');
        span.style.setProperty('--dy', dy.toFixed(1) + 'px');
        layer.appendChild(span);
      }
    }

    document.body.appendChild(layer);
  })();

  // ============ Recalibrate walkthrough ============
  // Modal flow that re-runs the 5 personality-quiz questions, then
  // personality + theme picks, then POSTs the answers to
  // /api/profile/recalibrate. The endpoint writes user-profile.json
  // (hardened — see index.ts) and copies the chosen theme CSS to
  // active-theme.css so the new look applies on the next reload.
  //
  // Each step is a single question with 3-7 button options. Selecting
  // an option auto-advances to the next step. Previous + Skip nav
  // keeps the user in control. The "Save" CTA on the final step is
  // the only place that hits the network.
  (function initRecalibrate() {
    const btn = document.getElementById('recalibrate-btn');
    const overlay = document.getElementById('recalibrate-overlay');
    if (!btn || !overlay) return;

    const closeBtn = document.getElementById('recalibrate-close');
    const prevBtn  = document.getElementById('recalibrate-prev');
    const nextBtn  = document.getElementById('recalibrate-next');
    const skipBtn  = document.getElementById('recalibrate-skip');
    const doneBtn  = document.getElementById('recalibrate-done');
    const qEl      = document.getElementById('recalibrate-question');
    const hintEl   = document.getElementById('recalibrate-hint');
    const optsEl   = document.getElementById('recalibrate-options');
    const progEl   = document.getElementById('recalibrate-progress');
    const stepCurEl = document.getElementById('recalibrate-step-current');
    const stepTotEl = document.getElementById('recalibrate-step-total');
    const errEl    = document.getElementById('recalibrate-err');

    // Questions match Step 1 of .claude/skills/pbx-stratos-setup/SKILL.md.
    // Order + option values are the canonical schema; changing them
    // would desync with the profile fields the server expects.
    const STEPS = [
      { field: 'tech_level', q: 'How techy are you?',
        hint: 'Controls whether Claude explains jargon or skips the basics.',
        opts: [
          { v: 'not-technical',         l: 'Not technical at all',                  d: 'Avoid jargon. Explain every term.' },
          { v: 'comfortable-not-coder', l: 'Comfortable with computers, not a coder', d: 'Brief explanations when terms come up.' },
          { v: 'casual-coder',          l: "I've coded before, casually",          d: 'Skip basics. Explain specialized stuff.' },
          { v: 'developer',             l: "I'm a developer",                       d: 'Lean technical. Reference functions + files directly.' },
        ] },
      { field: 'communication_style', q: 'How should I talk to you?',
        hint: 'Controls response length + density.',
        opts: [
          { v: 'brief',              l: 'Brief — get to the point',         d: 'Short answers. Lists. Lead with the answer.' },
          { v: 'balanced',           l: 'Balanced — answer plus context',   d: 'Answer first, then a sentence or two of why/how.' },
          { v: 'thorough',           l: 'Thorough — teach me as we go',     d: 'Explain reasoning. Mini-tutorial mode.' },
          { v: 'match-personality',  l: 'Match the personality I pick',     d: 'Whatever vibe my personality has.' },
        ] },
      { field: 'goal', q: 'What do you want to do with this bot?',
        hint: 'Sets how deep the live-trading setup goes.',
        opts: [
          { v: 'explore',    l: 'Just curious — exploring',                d: 'Skip live-trading setup. Focus on understanding.' },
          { v: 'paper',      l: 'Paper trade and learn',                   d: 'Install paper trader, skip live wallet.' },
          { v: 'small-live', l: 'Run a small live bot (~$100)',            d: 'Full install including live wallet + Helius key.' },
          { v: 'multi-bot',  l: '$500-$1000 to deploy multiple bots',      d: 'Full install + multi-bot scaffolding + scheduled monitoring.' },
        ] },
      { field: 'consent_level', q: 'How much should I check in before doing things?',
        hint: 'Controls the consent-gate cadence.',
        opts: [
          { v: 'very-cautious', l: 'Very cautious — check everything',                d: 'Pause for confirm on every action.' },
          { v: 'cautious',      l: 'Cautious — check the big stuff',                  d: 'Confirm money moves + bot-behavior changes. Routine stuff is fine.' },
          { v: 'balanced',      l: 'Balanced — tell me, then do it',                  d: 'Announce, then act. Stop only for major calls.' },
          { v: 'hands-off',     l: 'Hands-off — do the right thing, tell me after',   d: 'Just handle it. Summarize after. Stop only for real decisions.' },
        ] },
      { field: 'autonomy_level', q: 'How much should I do vs. you do?',
        hint: 'Who drives the keyboard.',
        opts: [
          { v: 'claude-everything',  l: 'You do everything — I\'ll review',         d: 'Claude runs every command. User reviews output.' },
          { v: 'show-cool-parts',    l: 'You do most of it — show me the cool parts', d: 'Claude handles boring setup; pauses for interesting moments.' },
          { v: 'together',           l: 'We do it together — teach me as we go',     d: 'Claude explains as it goes. User learns enough to do it later.' },
          { v: 'user-driven',        l: 'I do it, you guide me',                     d: 'User types commands. Claude coaches.' },
        ] },
      { field: 'personality_id', q: 'Pick a personality',
        hint: 'Changes Claude\'s voice. Doesn\'t affect bot behavior.',
        opts: [
          { v: 'default',         l: 'Default',          d: 'Neutral, balanced, professional.' },
          { v: 'crypto-bro',      l: 'Crypto Bro',       d: 'Degen KOL who\'s "made it" — ser, ngmi, alpha, printing.' },
          { v: 'drill-sergeant',  l: 'Drill Sergeant',   d: 'Strict, terse, military — ALL-CAPS callouts.' },
          { v: 'surf-bro',        l: 'Surf Bro',         d: 'Chill, encouraging, upbeat — yo, dude, totally.' },
          { v: 'quant-professor', l: 'Quant Professor',  d: 'Formal, academic, hedged language.' },
          { v: 'hacker',          l: 'Hacker',           d: '1337, dark, lowercase, abbreviated.' },
        ] },
      { field: 'theme_id', q: 'Pick a theme',
        hint: 'Changes dashboard CSS only. Independent of personality.',
        opts: [
          { v: 'auto',     l: 'Match my personality (recommended)',   d: 'Use whatever theme the picked personality pairs with by default.' },
          { v: 'default',  l: 'Default — slate + indigo + emerald',  d: 'The reference look. Get-out-of-the-way baseline.' },
          { v: 'lambo',    l: 'Lambo — gold on matte black',          d: 'Crypto-bro luxury terminal.' },
          { v: 'matrix',   l: 'Matrix — phosphor green on black',    d: 'CRT terminal, all mono.' },
          { v: 'camo',     l: 'Camo — olive + amber military',       d: 'Disciplined, functional.' },
          { v: 'beach',    l: 'Beach — coral + teal pastels',        d: 'Chill, low-stakes vibe.' },
          { v: 'academia', l: 'Academia — cream + serif',            d: 'Working paper aesthetic. Light theme.' },
        ] },
    ];

    let stepIdx = 0;
    const answers = {};
    let currentProfile = null;

    // Swatch colors for the personality + theme picker steps. Each
    // option gets a small colored circle so the user can preview the
    // accent at a glance without committing — no hover state, no
    // network, just an inline visual hint. Personality values map to
    // their paired-theme accent; theme values map to themselves;
    // 'auto' renders as a rainbow gradient to signal "follow your
    // personality."
    const SWATCH_BY_PERSONALITY = {
      'default':         '#34d399',
      'crypto-bro':      '#d4af37',
      'drill-sergeant':  '#8fa840',
      'surf-bro':        '#ff7f6b',
      'quant-professor': '#6b4423',
      'hacker':          '#00ff66',
    };
    const SWATCH_BY_THEME = {
      'default':  '#34d399',
      'lambo':    '#d4af37',
      'matrix':   '#00ff66',
      'camo':     '#8fa840',
      'beach':    '#ff7f6b',
      'academia': '#6b4423',
    };

    // ── Render helpers ──
    function renderStep() {
      const step = STEPS[stepIdx];
      stepCurEl.textContent = String(stepIdx + 1);
      stepTotEl.textContent = String(STEPS.length);
      qEl.textContent = step.q;
      hintEl.textContent = step.hint || '';
      errEl.classList.add('hidden');

      // Progress dots.
      progEl.replaceChildren();
      for (let i = 0; i < STEPS.length; i++) {
        const dot = document.createElement('span');
        const isActive = i === stepIdx;
        const isDone = i < stepIdx;
        dot.className = 'inline-block w-1.5 h-1.5 rounded-full transition '
          + (isActive ? 'bg-emerald-400' : (isDone ? 'bg-emerald-500/60' : 'bg-zinc-700'));
        progEl.appendChild(dot);
      }

      // Option cards. Selecting one auto-advances (except on the
      // final step — Save button submits).
      const selected = answers[step.field] != null ? answers[step.field]
                       : (currentProfile && currentProfile[step.field]) || null;
      optsEl.replaceChildren();
      // Swatch lookup applies only on personality + theme picker steps;
      // everything else (the 5 quiz steps) just gets the bare label
      // + description card.
      const swatchMap = step.field === 'personality_id' ? SWATCH_BY_PERSONALITY
                       : step.field === 'theme_id' ? SWATCH_BY_THEME
                       : null;
      for (const opt of step.opts) {
        const isSelected = opt.v === selected;
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'w-full text-left border rounded p-3 transition '
          + (isSelected
              ? 'border-emerald-500/60 bg-emerald-500/10'
              : 'border-zinc-700/60 hover:border-zinc-500 hover:bg-zinc-800/40');
        const label = document.createElement('div');
        label.className = 'text-[13px] font-medium text-zinc-100';
        label.textContent = opt.l;
        const desc = document.createElement('div');
        desc.className = 'text-[11px] muted mt-0.5';
        desc.textContent = opt.d || '';
        // Build the card. If a swatch applies, wrap the label/desc
        // in a flex row with a 14px colored circle on the left so
        // the user sees the theme's accent before committing.
        if (swatchMap) {
          const swatchColor = swatchMap[opt.v];
          const swatchStyle = swatchColor
            ? `background: ${swatchColor};`
            // 'auto' = follow your personality. Show a gradient of all
            // 6 accents to telegraph "pick from any of these."
            : 'background: linear-gradient(135deg, '
              + '#34d399 0%, #d4af37 20%, #00ff66 40%, '
              + '#8fa840 60%, #ff7f6b 80%, #6b4423 100%);';
          const row = el('div', { class: 'flex items-center gap-3' },
            el('span', {
              class: 'inline-block w-3.5 h-3.5 rounded-full border border-zinc-600/50 shrink-0 shadow-sm',
              style: swatchStyle,
              'aria-hidden': 'true',
            }),
            el('div', { class: 'flex-1 min-w-0' },
              label,
              opt.d ? desc : null,
            ),
          );
          card.appendChild(row);
        } else {
          card.appendChild(label);
          if (opt.d) card.appendChild(desc);
        }
        card.addEventListener('click', () => {
          answers[step.field] = opt.v;
          if (stepIdx < STEPS.length - 1) {
            stepIdx += 1;
            renderStep();
          } else {
            renderStep();  // refresh selection highlight
          }
        });
        optsEl.appendChild(card);
      }

      // Nav state.
      prevBtn.disabled = stepIdx === 0;
      const isFinal = stepIdx === STEPS.length - 1;
      nextBtn.classList.toggle('hidden', isFinal);
      doneBtn.classList.toggle('hidden', !isFinal);
    }

    function open() {
      stepIdx = 0;
      for (const k in answers) delete answers[k];
      // Pre-fill from current profile (best effort, no token required
      // since /api/profile is local-only safe).
      fetch('/api/profile', { credentials: 'same-origin' })
        .then((r) => r.ok ? r.json() : null)
        .then((p) => { currentProfile = p && typeof p === 'object' ? p : {}; renderStep(); })
        .catch(() => { currentProfile = {}; renderStep(); });
      overlay.classList.remove('hidden');
    }

    function close() {
      overlay.classList.add('hidden');
    }

    async function submit() {
      doneBtn.disabled = true;
      doneBtn.textContent = 'Saving…';
      errEl.classList.add('hidden');
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
        const resp = await fetch('/api/profile/recalibrate', {
          method: 'POST',
          headers,
          credentials: 'same-origin',
          body: JSON.stringify(answers),
        });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          throw new Error(body.error || ('HTTP ' + resp.status));
        }
        // Show a confirmation state in the modal before the reload —
        // jumping straight to location.reload() reads as if the click
        // was ignored. ~900ms is enough to register the success
        // without making the user wait perceptibly. Modal nav and
        // content collapse into a centered "Saved" message.
        const updated = Object.keys(answers);
        qEl.textContent = '✓ Saved';
        hintEl.textContent = 'Applying your new ' +
          (updated.length === 1 ? 'preference' : 'preferences') +
          ' (' + updated.length + ' field' + (updated.length === 1 ? '' : 's') +
          ' updated). Reloading…';
        optsEl.replaceChildren();
        progEl.replaceChildren();
        prevBtn.classList.add('hidden');
        skipBtn.classList.add('hidden');
        nextBtn.classList.add('hidden');
        doneBtn.classList.add('hidden');
        // Add a single confirmation tick so the user sees the success
        // beat even on a fast network. Themed via existing emerald
        // utilities → reskins per theme automatically.
        optsEl.replaceChildren(el('div', {
          class: 'text-center py-6',
        },
          el('div', { class: 'text-5xl text-emerald-400' }, '✓'),
        ));
        await new Promise((r) => setTimeout(r, 900));
        // Force a hard reload so the new theme CSS and any restart-
        // sensitive UI bits pick up the change cleanly.
        location.reload();
      } catch (e) {
        errEl.textContent = 'Save failed: ' + (e && e.message ? e.message : String(e));
        errEl.classList.remove('hidden');
        doneBtn.disabled = false;
        doneBtn.textContent = 'Save';
      }
    }

    // Wire up.
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    prevBtn.addEventListener('click', () => { if (stepIdx > 0) { stepIdx -= 1; renderStep(); } });
    nextBtn.addEventListener('click', () => { if (stepIdx < STEPS.length - 1) { stepIdx += 1; renderStep(); } });
    skipBtn.addEventListener('click', () => {
      if (stepIdx < STEPS.length - 1) { stepIdx += 1; renderStep(); }
      else { close(); }
    });
    doneBtn.addEventListener('click', submit);
    // Click on the dim backdrop to close (but not when clicking the card).
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  })();
