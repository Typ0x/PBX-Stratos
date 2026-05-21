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
  let TOKEN = localStorage.getItem('PBX_BOT_API_TOKEN');
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
    localStorage.setItem('PBX_BOT_API_TOKEN', v);
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
      localStorage.removeItem('PBX_BOT_API_TOKEN');
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
    document.getElementById('funder-card').classList.toggle('hidden', pristine);
    document.getElementById('workflow-card').classList.toggle('hidden', pristine);
    // Performance / Trade history / Tick log / Backtest — only meaningful
    // once at least one bot exists.
    document.querySelectorAll('[data-analytics]').forEach((el) => {
      el.classList.toggle('hidden', !hasBots);
    });
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
      if (g.exitZone) gaugeChildren.push(el('div', { class: 'gauge-zone', style: `left:${g.exitZone[0]}%; right:${100-g.exitZone[1]}%; background:#ef4444` }));
      if (g.entryZone) gaugeChildren.push(el('div', { class: 'gauge-zone', style: `left:${g.entryZone[0]}%; right:${100-g.entryZone[1]}%; background:#10b981` }));
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
    paper: 'view-paper',
    live: 'view-live',
  };

  // Switch to a view by name (discover|leaderboard|paper|live). Hides
  // the other three, marks the matching nav button active, and persists
  // the choice. Unknown names fall back to 'discover'.
  function showView(name) {
    if (!VIEW_IDS[name]) name = 'discover';
    for (const [view, id] of Object.entries(VIEW_IDS)) {
      document.getElementById(id)?.classList.toggle('hidden', view !== name);
    }
    document.querySelectorAll('#nav-items .nav-btn').forEach((btn) => {
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
    document.querySelectorAll('#nav-items .nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => showView(btn.dataset.view));
    });
    const toggle = document.getElementById('nav-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const collapsed = !document.getElementById('sidebar')?.classList.contains('nav-collapsed');
        setNavCollapsed(collapsed);
      });
    }
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
      replace(host, el('div', { class: 'py-16 text-center text-[13px] muted' }, 'Loading top traders…'));
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

  bootstrapAuth().then((ready) => {
    if (!ready) { showAuth(); return; }
    refreshAll();
    setInterval(refreshAll, 15000);
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
