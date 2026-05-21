import type { RegionKey } from '../regions.js';

/**
 * In-memory bot state: what each strategy is currently holding, and a
 * rolling trade log. V2 swaps this for Postgres with compound PK
 * (strategy_id, wallet_pubkey) on wallet_state and numeric(38,9) amounts.
 *
 * The shape mirrors the v2 schema so the migration is mechanical:
 *   wallet_state:  { strategyId, holding, usdcBalance, updatedAt }
 *   trade_log:     { intentId, strategyId, venue, in, out, amountIn, amountOut, dryRun, ts }
 */

export interface WalletState {
  strategyId: string;
  holding: RegionKey | 'USDC';
  usdcBalance: bigint;
  regionBalance: bigint;
  updatedAt: number;
}

export interface TradeRecord {
  intentId: string;
  strategyId: string;
  tick: number;
  venue: string;
  inputMint: string;
  outputMint: string;
  amountIn: bigint;
  amountOutEst: bigint;
  signature: string;
  dryRun: boolean;
  ts: number;
}

const walletByStrategy: Map<string, WalletState> = new Map();
const trades: TradeRecord[] = [];

const STARTING_USDC_RAW = 100_000_000n; // 100 USDC (6 decimals) per strategy

export function initStrategyWallet(strategyId: string): WalletState {
  const existing = walletByStrategy.get(strategyId);
  if (existing) return existing;
  const fresh: WalletState = {
    strategyId,
    holding: 'USDC',
    usdcBalance: STARTING_USDC_RAW,
    regionBalance: 0n,
    updatedAt: Date.now(),
  };
  walletByStrategy.set(strategyId, fresh);
  return fresh;
}

/**
 * Seed or overwrite a strategy's wallet with explicit values. Used by the
 * server-side orchestrator to inject persisted state before each tick so
 * strategies operate on real on-disk balances, not the in-memory default.
 */
export function setStrategyWallet(state: WalletState): void {
  walletByStrategy.set(state.strategyId, state);
}

export function getWallet(strategyId: string): WalletState {
  const w = walletByStrategy.get(strategyId);
  if (!w) throw new Error(`[state] wallet not initialized for ${strategyId}`);
  return w;
}

export function recordTrade(rec: TradeRecord, newHolding: RegionKey | 'USDC', newUsdc: bigint, newRegion: bigint): void {
  trades.push(rec);
  const w = getWallet(rec.strategyId);
  w.holding = newHolding;
  w.usdcBalance = newUsdc;
  w.regionBalance = newRegion;
  w.updatedAt = rec.ts;
}

export function getTrades(strategyId?: string): TradeRecord[] {
  if (!strategyId) return trades.slice();
  return trades.filter((t) => t.strategyId === strategyId);
}

export function snapshot(): { wallets: WalletState[]; tradeCount: number } {
  return { wallets: [...walletByStrategy.values()], tradeCount: trades.length };
}
