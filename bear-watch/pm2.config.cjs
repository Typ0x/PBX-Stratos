// PBX Stratos — pm2 supervisor config
//
// Defines the two long-running apps the bot needs:
//   1. bear-watch-server — Node/tsx process that hosts the dashboard,
//      live bot runner, and HTTP /health endpoint.
//   2. paper-trade-bot — Python paper trader that runs the 60s tick
//      loop against live market prices (no real money).
//
// Both apps get max_restarts: 9999 because the supervisor should never
// give up — let the meta-watchdog (BEARWATCH-MetaWatchdog) make the
// "this is irrecoverable" call instead.
//
// File-watch is OFF by default. Turn it on per-environment if you want
// auto-reload on .ts edits, but be aware: a pm2 reload during an open
// live position drops a tick or two. See _context/CLAUDE.md for the
// tiered consent rule on .ts edits during open positions.

module.exports = {
  apps: [
    {
      name: "bear-watch-server",
      cwd: "./bots",
      script: "npx",
      args: "tsx src/server/index.ts",
      max_restarts: 9999,
      restart_delay: 2000,
      watch: false,                    // see note above
      ignore_watch: ["node_modules", "*.log", "*.html", "*.css", "*.bak-baseline"],
      env: {
        NODE_ENV: "production",
        PORT: "8787",
        // RPC + keys come from .env (never put them in this file)
      },
      out_file: "./bots/_server_log.txt",
      error_file: "./bots/_server_log.txt",
      merge_logs: true,
      time: true,
    },
    {
      name: "paper-trade-bot",
      cwd: "./lab/runners",
      script: "python",
      args: "paper-trade.py",
      max_restarts: 9999,
      restart_delay: 5000,
      watch: false,
      env: {
        PYTHONUNBUFFERED: "1",
      },
      out_file: "./lab/runners/_paper_trade_log.txt",
      error_file: "./lab/runners/_paper_trade_log.txt",
      merge_logs: true,
      time: true,
    },
  ],
};
