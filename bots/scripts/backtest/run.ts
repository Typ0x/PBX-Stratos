#!/usr/bin/env tsx
/**
 * Run all candidate strategies through the backtest harness.
 *
 *   DATABASE_URL=...  (from .env.production)
 *   BIRDEYE_API_KEY=...
 *
 *   tsx bots/scripts/backtest/run.ts [--days 25] [--batch hodl|conviction|reversion|trend|all]
 */
import { fetchAlignedBars, type RegionKey } from './data.js';
import { backtest, reportTable, reportTableBySharpe, type BacktestStrategy } from './harness.js';
import {
  alwaysInMarket,
  alwaysInMarketEdge,
  hodl,
  hodlBestMomentumStart,
  hodlLowestPm25Start,
  multiTimeframeBand,
  pm25AndPriceBand,
  pm25Band,
  pm25BandAdaptive,
  pm25BandCooldown,
  pm25BandFeeAware,
  pm25BandSecondBest,
  pm25BandWithStops,
  pm25Slope,
  pm25ZScore,
  priceBand,
  regionArb,
  indexAnchoredSingle,
  reversionPatience,
  rotateOnPm25Edge,
  rotateOnReturnEdge,
  singleRegionBand,
  timeRebalance,
  trendRider,
} from './strategies.js';

function parseArgs(argv: string[]): { days: number; batch: string; skipHours: number; requireAllPrices: boolean } {
  let days = 25;
  let batch = 'all';
  let skipHours = 0;
  let requireAllPrices = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') days = Number(argv[++i]);
    else if (argv[i] === '--batch') batch = argv[++i];
    else if (argv[i] === '--skip-hours') skipHours = Number(argv[++i]);
    else if (argv[i] === '--require-all-prices') requireAllPrices = true;
  }
  return { days, batch, skipHours, requireAllPrices };
}

function buildBatch(name: string): BacktestStrategy[] {
  switch (name) {
    case 'hodl':
      return [
        hodl('NYC'),
        hodl('CHI'),
        hodl('TOR'),
        hodlLowestPm25Start(),
        hodlBestMomentumStart(),
      ];
    case 'conviction':
      return [
        rotateOnReturnEdge({ lookbackHrs: 24, edgeBps: 2500 }), // 25% over 24h
        rotateOnReturnEdge({ lookbackHrs: 48, edgeBps: 1500 }), // 15% over 48h
        rotateOnPm25Edge({ pmDeltaPct: 30 }),                    // 30% pm25 advantage
      ];
    case 'reversion':
      return [
        reversionPatience({ lookbackHrs: 168, cooldownHrs: 24 }), // 7d band, 1d cooldown
        reversionPatience({ lookbackHrs: 72, cooldownHrs: 48 }),  // 3d band, 2d cooldown
        pm25Band({ entryPct: 90, exitPct: 50, minHistoryHrs: 48 }),
        pm25Band({ entryPct: 75, exitPct: 25, minHistoryHrs: 48 }),
      ];
    case 'trend':
      return [
        trendRider({ lookbackHrs: 24, cooldownHrs: 24, minMomentumPct: 5 }),
        trendRider({ lookbackHrs: 48, cooldownHrs: 24, minMomentumPct: 3 }),
      ];
    case 'band-sweep':
      return [
        pm25Band({ name: 'BAND_85-15', entryPct: 85, exitPct: 15, minHistoryHrs: 48 }),
        pm25Band({ name: 'BAND_80-20', entryPct: 80, exitPct: 20, minHistoryHrs: 48 }),
        pm25Band({ name: 'BAND_75-25', entryPct: 75, exitPct: 25, minHistoryHrs: 48 }),
        pm25Band({ name: 'BAND_70-30', entryPct: 70, exitPct: 30, minHistoryHrs: 48 }),
        pm25Band({ name: 'BAND_65-35', entryPct: 65, exitPct: 35, minHistoryHrs: 48 }),
        pm25Band({ name: 'BAND_90-50', entryPct: 90, exitPct: 50, minHistoryHrs: 48 }),
        pm25Band({ name: 'BAND_75-25_w24', entryPct: 75, exitPct: 25, minHistoryHrs: 24 }),
        pm25Band({ name: 'BAND_75-25_w72', entryPct: 75, exitPct: 25, minHistoryHrs: 72 }),
        pm25Band({ name: 'BAND_75-25_w168', entryPct: 75, exitPct: 25, minHistoryHrs: 168 }),
      ];
    case 'band-advanced':
      return [
        // Multi-timeframe confirmation
        multiTimeframeBand({ name: 'MTF_4h-24h_70-60-30', shortHrs: 4, longHrs: 24, shortEntryPct: 70, longEntryPct: 60, exitPct: 30 }),
        multiTimeframeBand({ name: 'MTF_6h-48h_75-65-25', shortHrs: 6, longHrs: 48, shortEntryPct: 75, longEntryPct: 65, exitPct: 25 }),
        multiTimeframeBand({ name: 'MTF_12h-72h_75-65-25', shortHrs: 12, longHrs: 72, shortEntryPct: 75, longEntryPct: 65, exitPct: 25 }),
        // Fee-aware (require extra buffer)
        pm25BandFeeAware({ name: 'BAND_FEE_75-25_min5', entryPct: 75, exitPct: 25, minHistoryHrs: 12, minNetEdgePct: 5 }),
        pm25BandFeeAware({ name: 'BAND_FEE_70-30_min10', entryPct: 70, exitPct: 30, minHistoryHrs: 12, minNetEdgePct: 10 }),
        pm25BandFeeAware({ name: 'BAND_FEE_75-25_min15', entryPct: 75, exitPct: 25, minHistoryHrs: 12, minNetEdgePct: 15 }),
        // Stops overlay (winners + losers cap)
        pm25BandWithStops({ name: 'STOPS_75-25_w12_tp30_sl15', entryPct: 75, exitPct: 25, minHistoryHrs: 12, takeProfitPct: 30, stopLossPct: 15 }),
        pm25BandWithStops({ name: 'STOPS_75-25_w12_tp50_sl10', entryPct: 75, exitPct: 25, minHistoryHrs: 12, takeProfitPct: 50, stopLossPct: 10 }),
        pm25BandWithStops({ name: 'STOPS_70-30_w12_tp100_sl20', entryPct: 70, exitPct: 30, minHistoryHrs: 12, takeProfitPct: 100, stopLossPct: 20 }),
        pm25BandWithStops({ name: 'STOPS_70-30_w12_tp20_sl5', entryPct: 70, exitPct: 30, minHistoryHrs: 12, takeProfitPct: 20, stopLossPct: 5 }),
      ];
    case 'zscore':
      return [
        pm25ZScore({ entryZ: 1.5, exitZ: -0.5, lookbackHrs: 12 }),
        pm25ZScore({ entryZ: 1.0, exitZ: 0.0, lookbackHrs: 24 }),
        pm25ZScore({ entryZ: 2.0, exitZ: -1.0, lookbackHrs: 24 }),
        pm25ZScore({ entryZ: 1.5, exitZ: -0.5, lookbackHrs: 6 }),
        pm25ZScore({ entryZ: 0.5, exitZ: -0.5, lookbackHrs: 12 }),
      ];
    case 'slope':
      return [
        pm25Slope({ lookbackHrs: 3, entryDelta: 0.3, exitDelta: -0.1 }),
        pm25Slope({ lookbackHrs: 6, entryDelta: 0.5, exitDelta: 0 }),
        pm25Slope({ lookbackHrs: 12, entryDelta: 0.5, exitDelta: 0 }),
        pm25Slope({ lookbackHrs: 1, entryDelta: 0.2, exitDelta: -0.1 }),
        pm25Slope({ lookbackHrs: 24, entryDelta: 1.0, exitDelta: 0 }),
      ];
    case 'solo':
      return [
        singleRegionBand({ region: 'NYC', entryPct: 88, exitPct: 12, lookbackHrs: 12 }),
        singleRegionBand({ region: 'TOR', entryPct: 88, exitPct: 12, lookbackHrs: 12 }),
        singleRegionBand({ region: 'CHI', entryPct: 88, exitPct: 12, lookbackHrs: 12 }),
        singleRegionBand({ region: 'NYC', entryPct: 75, exitPct: 25, lookbackHrs: 12 }),
        singleRegionBand({ region: 'TOR', entryPct: 75, exitPct: 25, lookbackHrs: 12 }),
        singleRegionBand({ region: 'CHI', entryPct: 75, exitPct: 25, lookbackHrs: 12 }),
        singleRegionBand({ region: 'NYC', entryPct: 95, exitPct: 5, lookbackHrs: 6 }),
      ];
    case 'final-zone':
      return [
        // Around 80-20_w14 — try longer windows
        pm25Band({ name: '80-20_w13', entryPct: 80, exitPct: 20, minHistoryHrs: 13 }),
        pm25Band({ name: '80-20_w15', entryPct: 80, exitPct: 20, minHistoryHrs: 15 }),
        pm25Band({ name: '80-20_w16', entryPct: 80, exitPct: 20, minHistoryHrs: 16 }),
        pm25Band({ name: '80-20_w18', entryPct: 80, exitPct: 20, minHistoryHrs: 18 }),
        pm25Band({ name: '80-20_w24', entryPct: 80, exitPct: 20, minHistoryHrs: 24 }),
        // 82-18_w14 family
        pm25Band({ name: '82-18_w13', entryPct: 82, exitPct: 18, minHistoryHrs: 13 }),
        pm25Band({ name: '82-18_w15', entryPct: 82, exitPct: 18, minHistoryHrs: 15 }),
        pm25Band({ name: '82-18_w16', entryPct: 82, exitPct: 18, minHistoryHrs: 16 }),
        // Wide bands with longer windows
        pm25Band({ name: '85-15_w14', entryPct: 85, exitPct: 15, minHistoryHrs: 14 }),
        pm25Band({ name: '85-15_w16', entryPct: 85, exitPct: 15, minHistoryHrs: 16 }),
        pm25Band({ name: '88-12_w14', entryPct: 88, exitPct: 12, minHistoryHrs: 14 }),
        // Asymmetric — wider upside, tight downside
        pm25Band({ name: '75-15_w14', entryPct: 75, exitPct: 15, minHistoryHrs: 14 }),
        pm25Band({ name: '80-10_w14', entryPct: 80, exitPct: 10, minHistoryHrs: 14 }),
        pm25Band({ name: '85-10_w14', entryPct: 85, exitPct: 10, minHistoryHrs: 14 }),
      ];
    case 'tight-zone':
      return [
        // Around 78-22 / 80-20 / 82-18 with windows w7-w14
        pm25Band({ name: '80-20_w7',  entryPct: 80, exitPct: 20, minHistoryHrs: 7 }),
        pm25Band({ name: '80-20_w8',  entryPct: 80, exitPct: 20, minHistoryHrs: 8 }),
        pm25Band({ name: '80-20_w11', entryPct: 80, exitPct: 20, minHistoryHrs: 11 }),
        pm25Band({ name: '80-20_w14', entryPct: 80, exitPct: 20, minHistoryHrs: 14 }),
        pm25Band({ name: '78-22_w7',  entryPct: 78, exitPct: 22, minHistoryHrs: 7 }),
        pm25Band({ name: '78-22_w11', entryPct: 78, exitPct: 22, minHistoryHrs: 11 }),
        pm25Band({ name: '78-22_w14', entryPct: 78, exitPct: 22, minHistoryHrs: 14 }),
        pm25Band({ name: '82-18_w7',  entryPct: 82, exitPct: 18, minHistoryHrs: 7 }),
        pm25Band({ name: '82-18_w11', entryPct: 82, exitPct: 18, minHistoryHrs: 11 }),
        pm25Band({ name: '82-18_w14', entryPct: 82, exitPct: 18, minHistoryHrs: 14 }),
        // Even tighter: 84-16, 80-15
        pm25Band({ name: '84-16_w10', entryPct: 84, exitPct: 16, minHistoryHrs: 10 }),
        pm25Band({ name: '80-15_w10', entryPct: 80, exitPct: 15, minHistoryHrs: 10 }),
        pm25Band({ name: '85-20_w10', entryPct: 85, exitPct: 20, minHistoryHrs: 10 }),
      ];
    case 'iterate':
      return [
        // Window variations around w10 (the second-half-strong winner)
        pm25Band({ name: '75-25_w7',  entryPct: 75, exitPct: 25, minHistoryHrs: 7 }),
        pm25Band({ name: '75-25_w9',  entryPct: 75, exitPct: 25, minHistoryHrs: 9 }),
        pm25Band({ name: '75-25_w11', entryPct: 75, exitPct: 25, minHistoryHrs: 11 }),
        pm25Band({ name: '75-25_w14', entryPct: 75, exitPct: 25, minHistoryHrs: 14 }),
        pm25Band({ name: '75-25_w16', entryPct: 75, exitPct: 25, minHistoryHrs: 16 }),
        pm25Band({ name: '75-25_w20', entryPct: 75, exitPct: 25, minHistoryHrs: 20 }),
        // Asymmetric around 75-25 with w10
        pm25Band({ name: '78-22_w10', entryPct: 78, exitPct: 22, minHistoryHrs: 10 }),
        pm25Band({ name: '73-27_w10', entryPct: 73, exitPct: 27, minHistoryHrs: 10 }),
        pm25Band({ name: '80-20_w10', entryPct: 80, exitPct: 20, minHistoryHrs: 10 }),
        pm25Band({ name: '70-30_w10', entryPct: 70, exitPct: 30, minHistoryHrs: 10 }),
        pm25Band({ name: '82-18_w10', entryPct: 82, exitPct: 18, minHistoryHrs: 10 }),
        pm25Band({ name: '76-24_w10', entryPct: 76, exitPct: 24, minHistoryHrs: 10 }),
        // 75-25_w10 + cooldown overlay (try to reduce trades while keeping signal)
        pm25BandCooldown({ name: '75-25_w10_cd6',  entryPct: 75, exitPct: 25, lookbackHrs: 10, cooldownHrs: 6 }),
        pm25BandCooldown({ name: '75-25_w10_cd12', entryPct: 75, exitPct: 25, lookbackHrs: 10, cooldownHrs: 12 }),
        pm25BandCooldown({ name: '75-25_w10_cd18', entryPct: 75, exitPct: 25, lookbackHrs: 10, cooldownHrs: 18 }),
        // 75-25_w10 + stops (cap losses, lock winners)
        pm25BandWithStops({ name: '75-25_w10_tp30_sl10', entryPct: 75, exitPct: 25, minHistoryHrs: 10, takeProfitPct: 30, stopLossPct: 10 }),
        pm25BandWithStops({ name: '75-25_w10_tp50_sl15', entryPct: 75, exitPct: 25, minHistoryHrs: 10, takeProfitPct: 50, stopLossPct: 15 }),
        pm25BandWithStops({ name: '75-25_w10_tp20_sl5',  entryPct: 75, exitPct: 25, minHistoryHrs: 10, takeProfitPct: 20, stopLossPct: 5 }),
      ];
    case 'sweet':
      return [
        // Around the new winner BAND_75-25_w4
        pm25Band({ name: '75-25_w4', entryPct: 75, exitPct: 25, minHistoryHrs: 4 }),
        pm25Band({ name: '75-25_w5', entryPct: 75, exitPct: 25, minHistoryHrs: 5 }),
        pm25Band({ name: '78-22_w4', entryPct: 78, exitPct: 22, minHistoryHrs: 4 }),
        pm25Band({ name: '72-28_w4', entryPct: 72, exitPct: 28, minHistoryHrs: 4 }),
        pm25Band({ name: '76-26_w4', entryPct: 76, exitPct: 26, minHistoryHrs: 4 }),
        pm25Band({ name: '74-26_w4', entryPct: 74, exitPct: 26, minHistoryHrs: 4 }),
        pm25Band({ name: '75-30_w4', entryPct: 75, exitPct: 30, minHistoryHrs: 4 }),
        pm25Band({ name: '70-25_w4', entryPct: 70, exitPct: 25, minHistoryHrs: 4 }),
        pm25Band({ name: '80-25_w4', entryPct: 80, exitPct: 25, minHistoryHrs: 4 }),
        pm25Band({ name: '75-20_w4', entryPct: 75, exitPct: 20, minHistoryHrs: 4 }),
        pm25Band({ name: '75-25_w8', entryPct: 75, exitPct: 25, minHistoryHrs: 8 }),
        pm25Band({ name: '75-25_w10', entryPct: 75, exitPct: 25, minHistoryHrs: 10 }),
      ];
    case 'final':
      return [
        // ALL_IN_EDGE variants
        alwaysInMarketEdge({ name: 'ALL_IN_e60_w12', lookbackHrs: 12, minEdgePct: 60 }),
        alwaysInMarketEdge({ name: 'ALL_IN_e40_w24', lookbackHrs: 24, minEdgePct: 40 }),
        alwaysInMarketEdge({ name: 'ALL_IN_e30_w24', lookbackHrs: 24, minEdgePct: 30 }),
        alwaysInMarketEdge({ name: 'ALL_IN_e50_w24', lookbackHrs: 24, minEdgePct: 50 }),
        // BAND_2nd variants
        pm25BandSecondBest({ name: '2nd_70-30_w12', entryPct: 70, exitPct: 30, lookbackHrs: 12 }),
        pm25BandSecondBest({ name: '2nd_95-5_w12', entryPct: 95, exitPct: 5, lookbackHrs: 12 }),
        pm25BandSecondBest({ name: '2nd_85-15_w6', entryPct: 85, exitPct: 15, lookbackHrs: 6 }),
        // SOLO TOR variants (best single-region OOS)
        singleRegionBand({ name: 'SOLO_TOR_85-15_w6', region: 'TOR', entryPct: 85, exitPct: 15, lookbackHrs: 6 }),
        singleRegionBand({ name: 'SOLO_TOR_92-8_w12', region: 'TOR', entryPct: 92, exitPct: 8, lookbackHrs: 12 }),
        singleRegionBand({ name: 'SOLO_TOR_70-30_w24', region: 'TOR', entryPct: 70, exitPct: 30, lookbackHrs: 24 }),
        singleRegionBand({ name: 'SOLO_TOR_75-25_w6', region: 'TOR', entryPct: 75, exitPct: 25, lookbackHrs: 6 }),
        singleRegionBand({ name: 'SOLO_NYC_85-15_w6', region: 'NYC', entryPct: 85, exitPct: 15, lookbackHrs: 6 }),
        singleRegionBand({ name: 'SOLO_NYC_92-8_w12', region: 'NYC', entryPct: 92, exitPct: 8, lookbackHrs: 12 }),
      ];
    case 'novel':
      return [
        pm25BandSecondBest({ entryPct: 75, exitPct: 25, lookbackHrs: 12 }),
        pm25BandSecondBest({ entryPct: 88, exitPct: 12, lookbackHrs: 12 }),
        pm25BandAdaptive({ baseEntryPct: 70, baseExitPct: 30, lookbackHrs: 12, volWindow: 24 }),
        pm25BandAdaptive({ baseEntryPct: 80, baseExitPct: 20, lookbackHrs: 12, volWindow: 48 }),
        alwaysInMarket({ lookbackHrs: 6 }),
        alwaysInMarket({ lookbackHrs: 12 }),
        alwaysInMarket({ lookbackHrs: 24 }),
        alwaysInMarketEdge({ lookbackHrs: 12, minEdgePct: 20 }),
        alwaysInMarketEdge({ lookbackHrs: 12, minEdgePct: 35 }),
        alwaysInMarketEdge({ lookbackHrs: 12, minEdgePct: 50 }),
      ];
    case 'cooldown':
      return [
        pm25BandCooldown({ entryPct: 88, exitPct: 12, lookbackHrs: 12, cooldownHrs: 6 }),
        pm25BandCooldown({ entryPct: 75, exitPct: 25, lookbackHrs: 12, cooldownHrs: 12 }),
        pm25BandCooldown({ entryPct: 70, exitPct: 30, lookbackHrs: 12, cooldownHrs: 24 }),
        pm25BandCooldown({ entryPct: 80, exitPct: 20, lookbackHrs: 6, cooldownHrs: 12 }),
        pm25BandCooldown({ entryPct: 85, exitPct: 15, lookbackHrs: 12, cooldownHrs: 8 }),
      ];
    case 'band-tight':
      return [
        // Survival of low-turnover champions
        pm25Band({ name: 'BAND_95-5_w6',  entryPct: 95, exitPct: 5,  minHistoryHrs: 6 }),
        pm25Band({ name: 'BAND_92-8_w6',  entryPct: 92, exitPct: 8,  minHistoryHrs: 6 }),
        pm25Band({ name: 'BAND_88-12_w6', entryPct: 88, exitPct: 12, minHistoryHrs: 6 }),
        pm25Band({ name: 'BAND_85-15_w6', entryPct: 85, exitPct: 15, minHistoryHrs: 6 }),
        pm25Band({ name: 'BAND_85-15_w12',entryPct: 85, exitPct: 15, minHistoryHrs: 12 }),
        pm25Band({ name: 'BAND_85-15_w24',entryPct: 85, exitPct: 15, minHistoryHrs: 24 }),
        pm25Band({ name: 'BAND_88-12_w12',entryPct: 88, exitPct: 12, minHistoryHrs: 12 }),
        pm25Band({ name: 'BAND_92-8_w12', entryPct: 92, exitPct: 8,  minHistoryHrs: 12 }),
        pm25Band({ name: 'BAND_95-5_w12', entryPct: 95, exitPct: 5,  minHistoryHrs: 12 }),
      ];
    case 'band-stress':
      return [
        // Even shorter to find the floor
        pm25Band({ name: 'BAND_75-25_w4', entryPct: 75, exitPct: 25, minHistoryHrs: 4 }),
        pm25Band({ name: 'BAND_75-25_w3', entryPct: 75, exitPct: 25, minHistoryHrs: 3 }),
        // Extreme tight bands
        pm25Band({ name: 'BAND_90-10_w12', entryPct: 90, exitPct: 10, minHistoryHrs: 12 }),
        pm25Band({ name: 'BAND_80-20_w12', entryPct: 80, exitPct: 20, minHistoryHrs: 12 }),
        pm25Band({ name: 'BAND_70-30_w12', entryPct: 70, exitPct: 30, minHistoryHrs: 12 }),
        pm25Band({ name: 'BAND_85-15_w12', entryPct: 85, exitPct: 15, minHistoryHrs: 12 }),
        // Tight band, very short window
        pm25Band({ name: 'BAND_85-15_w6', entryPct: 85, exitPct: 15, minHistoryHrs: 6 }),
        pm25Band({ name: 'BAND_70-30_w6', entryPct: 70, exitPct: 30, minHistoryHrs: 6 }),
      ];
    case 'band-deep':
      return [
        // Even shorter windows
        pm25Band({ name: 'BAND_75-25_w12', entryPct: 75, exitPct: 25, minHistoryHrs: 12 }),
        pm25Band({ name: 'BAND_75-25_w8', entryPct: 75, exitPct: 25, minHistoryHrs: 8 }),
        pm25Band({ name: 'BAND_75-25_w6', entryPct: 75, exitPct: 25, minHistoryHrs: 6 }),
        // Asymmetric (early entry, late exit)
        pm25Band({ name: 'BAND_60-40_w24', entryPct: 60, exitPct: 40, minHistoryHrs: 24 }),
        pm25Band({ name: 'BAND_55-45_w24', entryPct: 55, exitPct: 45, minHistoryHrs: 24 }),
        // Inverted (try buying low pm25, selling high — opposite hypothesis)
        pm25Band({ name: 'BAND_INV_25-75_w24', entryPct: 25, exitPct: 75, minHistoryHrs: 24 }),
        // Pure price-based for comparison (does pm25 add anything?)
        priceBand({ name: 'BAND_PRICE_25-75_w24', entryPct: 25, exitPct: 75, minHistoryHrs: 24 }),
        priceBand({ name: 'BAND_PRICE_30-70_w24', entryPct: 30, exitPct: 70, minHistoryHrs: 24 }),
        // Combo: pm25 + price gates
        pm25AndPriceBand({ name: 'COMBO_pm75_px30_w24', pmEntryPct: 75, pmExitPct: 25, priceEntryPct: 30, priceExitPct: 70, lookbackHrs: 24 }),
        pm25AndPriceBand({ name: 'COMBO_pm60_px40_w24', pmEntryPct: 60, pmExitPct: 40, priceEntryPct: 40, priceExitPct: 60, lookbackHrs: 24 }),
      ];
    case 'reversion-permissive':
      return [
        reversionPatience({ name: 'REV_72h_c12_thresh3', lookbackHrs: 72, cooldownHrs: 12 }),
        reversionPatience({ name: 'REV_48h_c6', lookbackHrs: 48, cooldownHrs: 6 }),
        reversionPatience({ name: 'REV_24h_c4', lookbackHrs: 24, cooldownHrs: 4 }),
        trendRider({ name: 'TREND_12h_c6', lookbackHrs: 12, cooldownHrs: 6, minMomentumPct: 2 }),
        trendRider({ name: 'TREND_6h_c3', lookbackHrs: 6, cooldownHrs: 3, minMomentumPct: 1 }),
        trendRider({ name: 'TREND_24h_c12_pct1', lookbackHrs: 24, cooldownHrs: 12, minMomentumPct: 1 }),
      ];
    case 'region-arb':
      return [
        // Baseline (mirrors live bots)
        regionArb({ name: 'RA_e4_x3',          entryT: 0.04, exitT: 0.03 }),
        regionArb({ name: 'RA_fast_e3_x25',    entryT: 0.03, exitT: 0.025 }),
        regionArb({ name: 'RA_wide_e5_x4',     entryT: 0.05, exitT: 0.04 }),
        regionArb({ name: 'RA_deep_e6_x5',     entryT: 0.06, exitT: 0.05 }),
        // Symmetric (exitT = entryT) — capture full overshoot
        regionArb({ name: 'RA_sym_e4',         entryT: 0.04, exitT: 0.04 }),
        regionArb({ name: 'RA_sym_e5',         entryT: 0.05, exitT: 0.05 }),
        // Wider exits — patient holds
        regionArb({ name: 'RA_e4_x6',          entryT: 0.04, exitT: 0.06 }),
        regionArb({ name: 'RA_e5_x8',          entryT: 0.05, exitT: 0.08 }),
        // Back-to-mean exit (don't wait for held to be richest)
        regionArb({ name: 'RA_btm_0',          entryT: 0.04, exitT: 0.99, backToMeanExit: 0.0 }),
        regionArb({ name: 'RA_btm_p01',        entryT: 0.04, exitT: 0.99, backToMeanExit: 0.01 }),
        regionArb({ name: 'RA_btm_p02',        entryT: 0.04, exitT: 0.99, backToMeanExit: 0.02 }),
        // Rotation (no USDC layover)
        regionArb({ name: 'RA_e4_x3_rot',      entryT: 0.04, exitT: 0.03, rotation: true }),
        regionArb({ name: 'RA_btm_0_rot',      entryT: 0.04, exitT: 0.99, backToMeanExit: 0.0, rotation: true }),
        regionArb({ name: 'RA_sym_e4_rot',     entryT: 0.04, exitT: 0.04, rotation: true }),
        // Take-profit on entry price
        regionArb({ name: 'RA_e4_tp3',         entryT: 0.04, exitT: 0.99, takeProfitPct: 3 }),
        regionArb({ name: 'RA_e4_tp5',         entryT: 0.04, exitT: 0.99, takeProfitPct: 5 }),
        regionArb({ name: 'RA_e4_tp5_sl8',     entryT: 0.04, exitT: 0.99, takeProfitPct: 5, stopLossPct: 8 }),
        // Time-stop
        regionArb({ name: 'RA_e4_x3_ts24h',    entryT: 0.04, exitT: 0.03, timeStopHrs: 24 }),
        regionArb({ name: 'RA_e4_x3_ts12h',    entryT: 0.04, exitT: 0.03, timeStopHrs: 12 }),
        // Z-score adaptive entry
        regionArb({ name: 'RA_z1_x3',          entryT: 0.0,  exitT: 0.03, zscoreEntry: 1.0, zscoreLookbackHrs: 24 }),
        regionArb({ name: 'RA_z1.5_x3',        entryT: 0.0,  exitT: 0.03, zscoreEntry: 1.5, zscoreLookbackHrs: 24 }),
        regionArb({ name: 'RA_z2_x3',          entryT: 0.0,  exitT: 0.03, zscoreEntry: 2.0, zscoreLookbackHrs: 48 }),
        // Combined winners (rotation + back-to-mean + tighter entry)
        regionArb({ name: 'RA_e3_btm0_rot',    entryT: 0.03, exitT: 0.99, backToMeanExit: 0.0, rotation: true }),
        regionArb({ name: 'RA_e4_btm0_rot_ts24', entryT: 0.04, exitT: 0.99, backToMeanExit: 0.0, rotation: true, timeStopHrs: 24 }),
      ];
    case 'lab-e1':
      // First experimental batch — counter-drift mean reversion variants.
      // Targets index-anchored single-region + patient (asymmetric)
      // region-arb, biased ADDITIVE (works with the rebalancer's fire
      // pattern rather than racing it).
      return [
        // Index-anchored single-region (no cross-region rotation)
        indexAnchoredSingle({ name: 'IDX_NYC_e5_x1', region: 'NYC', entryDevPct: 0.05, exitDevPct: 0.01 }),
        indexAnchoredSingle({ name: 'IDX_NYC_e3_x1', region: 'NYC', entryDevPct: 0.03, exitDevPct: 0.01 }),
        indexAnchoredSingle({ name: 'IDX_NYC_e8_x2', region: 'NYC', entryDevPct: 0.08, exitDevPct: 0.02 }),
        indexAnchoredSingle({ name: 'IDX_TOR_e5_x1', region: 'TOR', entryDevPct: 0.05, exitDevPct: 0.01 }),
        indexAnchoredSingle({ name: 'IDX_TOR_e3_x1', region: 'TOR', entryDevPct: 0.03, exitDevPct: 0.01 }),
        indexAnchoredSingle({ name: 'IDX_CHI_e5_x1', region: 'CHI', entryDevPct: 0.05, exitDevPct: 0.01 }),
        indexAnchoredSingle({ name: 'IDX_CHI_e3_x1', region: 'CHI', entryDevPct: 0.03, exitDevPct: 0.01 }),
        // Patient (asymmetric) regionArb: wide entry, no richest-flip exit,
        // require BTM at significant overshoot.
        regionArb({ name: 'PATIENT_e15_btm10_rot', entryT: 0.15, exitT: 0.99, backToMeanExit: 0.10, rotation: true }),
        regionArb({ name: 'PATIENT_e12_btm08_rot', entryT: 0.12, exitT: 0.99, backToMeanExit: 0.08, rotation: true }),
        regionArb({ name: 'PATIENT_e10_btm05_rot', entryT: 0.10, exitT: 0.99, backToMeanExit: 0.05, rotation: true }),
        // Z-score adaptive on shorter lookbacks (existing tests use 24h+)
        regionArb({ name: 'Z_lb6_z2_btm0_rot', entryT: 0.0, exitT: 0.99, zscoreEntry: 2.0, zscoreLookbackHrs: 6, backToMeanExit: 0.0, rotation: true }),
        regionArb({ name: 'Z_lb12_z1.5_btm0_rot', entryT: 0.0, exitT: 0.99, zscoreEntry: 1.5, zscoreLookbackHrs: 12, backToMeanExit: 0.0, rotation: true }),
      ];
    case 'lab-e2':
      // Bulk parameter sweep over the lab-e1 winners. Sweeps:
      //   indexAnchoredSingle: 3 regions × 5 entry × 3 exit = 45
      //   regionArb (PATIENT family): 5 entryT × 4 BTM thresholds = 20
      //   regionArb (TIGHT family): 4 entryT × 4 exitT × {rot, no-rot} = 32
      // Plus 8 mixed control variants. Total ~105 variants.
      // Maintains additive bias.
      {
        const variants: BacktestStrategy[] = [];
        const regions: RegionKey[] = ['NYC', 'TOR', 'CHI'];

        // 3 × 5 × 3 = 45 indexAnchoredSingle variants
        for (const r of regions) {
          for (const ent of [0.02, 0.03, 0.04, 0.06, 0.08]) {
            for (const exi of [0.005, 0.01, 0.02]) {
              variants.push(indexAnchoredSingle({
                name: `IDX_${r}_e${(ent * 100).toFixed(1)}_x${(exi * 1000).toFixed(0)}`,
                region: r, entryDevPct: ent, exitDevPct: exi,
              }));
            }
          }
        }

        // 5 × 4 = 20 PATIENT regionArb variants (wide entry, BTM exit, rotation)
        for (const ent of [0.06, 0.08, 0.10, 0.12, 0.15]) {
          for (const btm of [0.0, 0.03, 0.05, 0.08]) {
            variants.push(regionArb({
              name: `PAT_e${(ent * 100).toFixed(0)}_btm${(btm * 100).toFixed(0)}_rot`,
              entryT: ent, exitT: 0.99, backToMeanExit: btm, rotation: true,
            }));
          }
        }

        // 4 × 4 × 2 = 32 TIGHT regionArb variants (exitT-driven, with/without rotation)
        for (const ent of [0.03, 0.04, 0.05, 0.06]) {
          for (const exi of [0.02, 0.03, 0.04, 0.05]) {
            for (const rot of [false, true]) {
              if (exi >= ent) continue; // skip degenerate cases
              variants.push(regionArb({
                name: `TGT_e${(ent * 100).toFixed(0)}_x${(exi * 100).toFixed(0)}${rot ? '_rot' : ''}`,
                entryT: ent, exitT: exi, rotation: rot,
              }));
            }
          }
        }

        return variants;
      }
    case 'all':
      return [
        ...buildBatch('hodl'),
        ...buildBatch('conviction'),
        ...buildBatch('reversion'),
        ...buildBatch('trend'),
        ...buildBatch('region-arb'),
        ...buildBatch('lab-e1'),
        ...buildBatch('lab-e2'),
      ];
    default:
      throw new Error(`unknown batch: ${name}`);
  }
}

function parseSplit(argv: string[]): 'all' | 'first' | 'second' {
  const i = argv.indexOf('--split');
  if (i < 0) return 'all';
  const v = argv[i + 1];
  if (v !== 'first' && v !== 'second') throw new Error('--split must be first|second');
  return v;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const split = parseSplit(argv);
  const fromIdx = argv.indexOf('--from');
  const toIdx = argv.indexOf('--to');
  const now = Date.now();
  let to: Date;
  let from: Date;
  if (fromIdx >= 0 || toIdx >= 0) {
    to = toIdx >= 0 ? new Date(argv[toIdx + 1]) : new Date(Math.floor(now / 3_600_000) * 3_600_000);
    from = fromIdx >= 0 ? new Date(argv[fromIdx + 1]) : new Date(to.getTime() - args.days * 24 * 3600 * 1000);
  } else {
    to = new Date(Math.floor(now / 3_600_000) * 3_600_000);
    from = new Date(to.getTime() - args.days * 24 * 3600 * 1000);
  }

  console.log(`\n=== Backtest @ ${new Date().toISOString()} ===`);
  console.log(`Window: ${from.toISOString()} → ${to.toISOString()}  (${args.days}d)`);
  console.log(`Batch:  ${args.batch}  split=${split}\n`);

  console.log(`Fetching bars...`);
  let bars = await fetchAlignedBars(from, to);
  if (args.skipHours > 0) {
    // Drop the first N hours of bars — useful to skip launch-spike
    // distortions where prices were extremely volatile and gappy.
    const before = bars.length;
    bars = bars.slice(args.skipHours);
    console.log(`  skipping first ${args.skipHours} hours (${before - bars.length} bars dropped)`);
  }
  if (args.requireAllPrices) {
    // Drop bars where any region's price is missing. Eliminates
    // gap-jump exploits where strategies catch a missing-data window
    // as free PnL when prices reappear.
    const before = bars.length;
    bars = bars.filter(
      (b) => b.price.CHI != null && b.price.NYC != null && b.price.TOR != null,
    );
    console.log(`  require-all-prices: dropped ${before - bars.length} bars (${bars.length} remain)`);
  }
  if (split === 'first') bars = bars.slice(0, Math.floor(bars.length / 2));
  if (split === 'second') bars = bars.slice(Math.floor(bars.length / 2));
  const withPrice = bars.filter(
    (b) => b.price.CHI != null || b.price.NYC != null || b.price.TOR != null,
  ).length;
  const withPm25 = bars.filter(
    (b) => b.pm25.CHI != null || b.pm25.NYC != null || b.pm25.TOR != null,
  ).length;
  console.log(`  ${bars.length} aligned bars: ${withPrice} have price, ${withPm25} have pm25\n`);

  if (bars.length === 0) {
    console.error('no bars — check DATABASE_URL + BIRDEYE_API_KEY');
    process.exit(1);
  }

  const strategies = buildBatch(args.batch);
  const results = strategies.map((s) => backtest(s, bars));

  console.log('═══ RANKED BY TOTAL RETURN ═══');
  console.log(reportTable(results));
  console.log('');
  console.log('═══ RANKED BY SHARPE (annualized, hourly bars) ═══');
  console.log(reportTableBySharpe(results));
  console.log('');

  // Insight summary
  const hodlBest = results.filter((r) => r.name.startsWith('HODL_')).sort((a, b) => b.pnlPct - a.pnlPct)[0];
  const overall = results.slice().sort((a, b) => b.pnlPct - a.pnlPct)[0];
  const sharpeBest = results.slice().sort((a, b) => b.sharpe - a.sharpe)[0];
  if (hodlBest && overall) {
    const gap = overall.pnlPct - hodlBest.pnlPct;
    console.log(
      `Best HODL: ${hodlBest.name} ${hodlBest.pnlPct.toFixed(2)}%  |  ` +
        `Best return: ${overall.name} ${overall.pnlPct.toFixed(2)}%  |  ` +
        `Best Sharpe: ${sharpeBest.name} ${sharpeBest.sharpe.toFixed(2)}  |  ` +
        `Gap: ${gap >= 0 ? '+' : ''}${gap.toFixed(2)}pp ${gap > 1 ? '⭐' : gap < -1 ? '✗' : ''}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
