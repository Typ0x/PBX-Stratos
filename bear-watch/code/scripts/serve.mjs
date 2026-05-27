// Cross-platform launcher for the bots server.
//
// `npm run server` used to be `STRATOS_ALLOW_AUTOGEN=1 tsx src/server/index.ts`
// — the inline `VAR=value command` form is POSIX-shell only and silently
// fails on Windows (PowerShell / cmd), so Windows users had to set the
// env var by hand. This wrapper sets it in JS instead, so the same
// `npm run server` works identically on every OS. No new dependency.
//
// Run via: node --import tsx scripts/serve.mjs   (see package.json)
//
// Only STRATOS_ALLOW_AUTOGEN is set here — same as the old script. It does
// NOT touch HELIUS_MAINNET_URL: if you've set that, you've opted into
// live mode deliberately, and this wrapper leaves that choice alone.
// Override autogen by exporting STRATOS_ALLOW_AUTOGEN=0 before running.
process.env.STRATOS_ALLOW_AUTOGEN ??= '1';

await import('../src/server/index.ts');
