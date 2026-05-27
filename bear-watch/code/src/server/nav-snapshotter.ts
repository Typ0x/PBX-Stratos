/**
 * Periodically computes per-bot NAV from on-chain balances + Jupiter
 * prices and appends to disk as line-delimited JSON. The dashboard
 * chart reads the resulting timeseries.
 *
 * Runs as a single setInterval inside the server process. If the server
 * restarts (Render redeploy), the next snapshot just resumes — gaps in
 * the timeseries are intentional and fine.
 */
import { Connection } from '@solana/web3.js';
import { readChainState } from '../../../../kernel/ts/src/chain.js';
import { getAllPrices } from './prices.js';
import type { Store, NavSnapshot } from './store.js';
import type { RegionKey } from '../../../../kernel/ts/src/regions.js';

const SNAPSHOT_INTERVAL_MS = 60_000; // every 60s

export class NavSnapshotter {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly conn: Connection,
  ) {}

  start(): void {
    if (this.timer) return;
    // Fire one immediately so dashboards have data on first load, then
    // settle into the interval cadence.
    void this.snapshot();
    this.timer = setInterval(() => void this.snapshot(), SNAPSHOT_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async snapshot(): Promise<void> {
    try {
      const wallets = this.store.listWallets();
      if (wallets.length === 0) return;

      const prices = await getAllPrices();
      const perBot: Record<string, number> = {};

      for (const w of wallets) {
        try {
          // Paper↔live fork for NAV: a live bot's NAV is priced from
          // on-chain balances; a paper bot has no chain position, so its
          // NAV is priced from its persisted SIMULATED ledger. Reading
          // chain for a paper bot would report NAV $0 every snapshot.
          const state =
            w.mode === 'paper'
              ? this.store.loadState(w.name)
              : await readChainState({
                  conn: this.conn,
                  owner: new (await import('@solana/web3.js')).PublicKey(w.pubkey),
                  name: w.name,
                  trades: 0, // not needed for NAV computation
                });
          if (!state) {
            // Paper bot with no persisted ledger yet (not launched) —
            // skip; it will appear once its first state is written.
            continue;
          }
          const usdc = Number(state.usdcBalance) / 1e6;
          const tokens = Number(state.regionBalance) / 1e6;
          const region = state.holding as RegionKey | 'USDC';
          const tokenPrice = region !== 'USDC' ? prices[region] ?? 0 : 0;
          const nav = usdc + tokens * tokenPrice;
          perBot[w.name] = nav;
        } catch (err) {
          // Skip this bot for this snapshot but keep going for others.
          console.warn(`[nav-snapshotter] read failed for '${w.name}': ${(err as Error).message}`);
        }
      }

      const total = Object.values(perBot).reduce((s, v) => s + v, 0);
      const snapshot: NavSnapshot = {
        ts: Date.now(),
        perBot,
        total,
        prices,
      };
      this.store.appendNavSnapshot(snapshot);
    } catch (err) {
      console.warn(`[nav-snapshotter] cycle failed: ${(err as Error).message}`);
    }
  }
}
