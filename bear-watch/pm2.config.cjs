// PBX Stratos â€” pm2 supervisor config
//
// Defines the two long-running apps the bot needs:
//   1. bear-watch-server â€” Node/tsx process that hosts the dashboard,
//      live bot runner, and HTTP /health endpoint.
//   2. paper-trade-bot â€” Python paper trader that runs the 60s tick
//      loop against live market prices (no real money).
//
// Both apps get max_restarts: 9999 because the supervisor should never
// give up â€” let the meta-watchdog (STRATOS-MetaWatchdog) make the
// "this is irrecoverable" call instead.
//
// File-watch is OFF by default. Turn it on per-environment if you want
// auto-reload on .ts edits, but be aware: a pm2 reload during an open
// live position drops a tick or two. See CLAUDE.md for the
// tiered consent rule on .ts edits during open positions.

// â”€â”€â”€ load .env from repo root â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// pm2 has no built-in dotenv loader and the bot server reads everything
// from process.env. Parse repo-root .env (gitignored) and feed only the
// vars the server expects. NEVER hardcode HELIUS_MAINNET_URL here.
const { readFileSync, existsSync } = require('fs');
const { join, resolve } = require('path');
const _envPath = join(__dirname, '..', '.env');
const _env = {};
if (existsSync(_envPath)) {
  for (const line of readFileSync(_envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) _env[m[1]] = m[2];
  }
}

// ─── self-contained runtime paths ────────────────────────────────────
// Point every stratos process at the in-repo runtime/{lab,bots,config}
// directories instead of dotfiles under $HOME. This keeps state with
// the install (easier to inspect, back up, and reset) and avoids any
// collision with another installation sharing the same machine.
const _runtimePaths = {
  STRATOS_REPO_ROOT:     resolve(__dirname, '..'),
  STRATOS_BOTS_DATA_DIR: resolve(__dirname, '..', 'runtime', 'bots'),
  STRATOS_BOTS_HOME:     resolve(__dirname, '..', 'runtime', 'config'),
  STRATOS_LAB_HOME:      resolve(__dirname, '..', 'runtime', 'lab'),
};

module.exports = {
  apps: [
    {
      // -stratos suffix marks this app as the public-fork install, so
      // any other installation on the same machine sees an obviously
      // different name in `pm2 list`.
      name: "bear-watch-server-stratos",
      cwd: "./bots",
      // Avoid `npx tsx ...` on Windows: pm2 invokes node on npx.cmd
      // (treating the .cmd file as JS) and dies with `Unexpected token ':'`.
      // Use tsx via node's --import hook instead. tsx v4+ ships an
      // ESM loader at `tsx` that registers the .ts transform.
      script: "node",
      args: "--import tsx src/server/index.ts",
      max_restarts: 9999,
      restart_delay: 2000,
      watch: false,                    // see note above
      ignore_watch: ["node_modules", "*.log", "*.html", "*.css", "*.bak-baseline"],
      env: {
        ..._runtimePaths,
        NODE_ENV: "production",
        // Keep PORT 8787 — this is stratos's port. Don't change to
        // 4269 or any other installation's port.
        PORT: "8787",
        // Auto-create <runtime>/bots/local.env on first boot with
        // proper 64-hex BOT_API_TOKEN + BOT_MASTER_KEY + a fresh
        // 24-word BOT_HD_MNEMONIC. Mode 0600. The server's
        // documented dev path.
        STRATOS_ALLOW_AUTOGEN: "1",
        // RPC comes from repo .env (gitignored). Keys come from
        // <runtime>/bots/local.env (mode 0600, never echoed).
        HELIUS_MAINNET_URL: _env.HELIUS_MAINNET_URL ?? "",
      },
      // out_file is resolved relative to cwd ("./bots"), so just the filename.
      out_file: "./_server_log.txt",
      error_file: "./_server_log.txt",
      merge_logs: true,
      time: true,
    },
    {
      name: "paper-trade-bot-stratos",
      // Research code now lives under bear-scout/ (matches the scope
      // taxonomy in CLAUDE.md). Previously: ./lab/runners.
      cwd: "./bear-scout/runners",
      script: "python",
      args: "paper-trade.py",
      max_restarts: 9999,
      restart_delay: 5000,
      watch: false,
      env: {
        ..._runtimePaths,
        PYTHONUNBUFFERED: "1",
      },
      // Log paths are cwd-relative (just the filename) — see note above.
      out_file: "./_paper_trade_log.txt",
      error_file: "./_paper_trade_log.txt",
      merge_logs: true,
      time: true,
    },
  ],
};
