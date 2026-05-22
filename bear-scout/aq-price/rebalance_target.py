"""Faithful port of the PBX on-chain rebalance engine.

An ACCURATE COPY of how the `pbx-platform` rebalance engine (`pbx_solana`,
the `YieldMaximizer` strategy) decides whether the portfolio is balanced
and how a corrective trade moves price. Ported from:

  constants/mod.rs                       — the constants
  utils.rs                               — calculate_pm25_weight_inverse_sqrt
  strategies/yield_maximizer/calculations.rs
                                         — efficiency score, proportional
                                           target allocations
  strategies/shared/rebalance_helpers.rs — should_rebalance (dead zone)
  instructions/whirlpool/math.rs         — predict_post_trade_price,
                                           max_trade_for_impact

────────────────────────────────────────────────────────────────────
KEY CORRECTION over the earlier proxy
────────────────────────────────────────────────────────────────────
The engine's target allocation is NOT proportional to 1/PM2.5. It is
proportional to EFFICIENCY = weight / price = (1/PM2.5) / price. A region
that is already expensive gets a SMALLER target allocation — the price
term is the mean-reverting force. `pm25_weight` (1/PM2.5) is only an
INPUT to efficiency, never the target itself. The accurate "is it
balanced" function is `target_allocations`, which needs BOTH PM2.5 and
price per region.

The engine targets an allocation VALUE SHARE of the portfolio, compares
it to the position's current USDC value, and only trades when the gap
exceeds a 0.15% dead zone — capped at 2.5% of the portfolio per cycle
and at the pool's price-impact limit.

PM2.5 convention: callers pass µg/m³ (e.g. 4.0). On-chain values are
stored ×10 (1-decimal fixed point); this module scales internally.
"""
from __future__ import annotations

# ── constants — pbx_solana/src/constants/mod.rs ──────────────────────
MIN_PM25_THRESHOLD = 15            # stored units; = 1.5 µg/m³ floor
WEIGHT_PRECISION = 1_000_000_000   # 1e9, fixed-point precision
PM25_DECIMAL_PRECISION = 10        # PM2.5 stored with 1 decimal place
MIN_EFFICIENCY = 100               # viability threshold (calculations.rs)
DEAD_ZONE_BPS = 15                 # rebalance_helpers.rs — 0.15% dead zone
MAX_DEFICIT_BPS = 250              # strategy_impl.rs — 2.5%/cycle clamp
DEFAULT_MAX_IMPACT_BPS = 1000      # math.rs — 10% max price impact/trade
Q64 = 1 << 64                      # Q64.64 fixed-point resolution


# ── PM2.5 weight — utils.rs::calculate_pm25_weight_inverse_sqrt ──────
def pm25_weight(pm25_ugm3: float) -> int:
    """weight = WEIGHT_PRECISION² / pm25_scaled — a linear inverse of
    PM2.5, floored at 1.5 µg/m³. This is the raw weight, an INPUT to
    `efficiency`; it is NOT the rebalance target on its own."""
    stored = round(pm25_ugm3 * PM25_DECIMAL_PRECISION)          # ×10, 1-dp
    effective = stored if stored > MIN_PM25_THRESHOLD else MIN_PM25_THRESHOLD
    pm25_scaled = effective * PM25_DECIMAL_PRECISION
    if pm25_scaled <= 0:
        return 0
    return (WEIGHT_PRECISION * WEIGHT_PRECISION) // pm25_scaled


# ── efficiency — yield_maximizer/calculations.rs ─────────────────────
PRICE_SCALE = 100_000_000  # on-chain token prices are 1e8 fixed-point


def efficiency(pm25_ugm3: float, price: float) -> int:
    """efficiency = weight / price_1e8 — 'fee distribution per dollar', the
    quantity the engine allocates proportionally to. Higher = a region
    undervalued relative to its (clean-air) weight.

    Faithful integer port: on-chain `calculate_efficiency_score` divides
    the u128 weight by the u64 1e8-scaled price, so `price` (real USD) is
    scaled by 1e8 here and the divide is integer — making both the
    allocation ratios AND the `MIN_EFFICIENCY` viability threshold match."""
    if price <= 0:
        return 0
    price_1e8 = int(price * PRICE_SCALE)
    if price_1e8 <= 0:
        return 0
    return pm25_weight(pm25_ugm3) // price_1e8


def is_viable(pm25_ugm3: float, price: float) -> bool:
    """The engine only allocates to regions whose efficiency clears the
    minimum threshold (calculations.rs::evaluate_position_efficiency)."""
    return efficiency(pm25_ugm3, price) >= MIN_EFFICIENCY


# ── target allocations — calculations.rs::calculate_proportional_allocations
def target_allocations(pm25_by_region: dict[str, float],
                        price_by_region: dict[str, float]) -> dict[str, float]:
    """THE rebalance target: each region's target portfolio share, a
    fraction summing to 1.0, proportional to efficiency = 1/(PM2.5·price).

    This is what the engine means by "balanced" — it drives the portfolio
    toward these value shares. Non-viable regions get share 0."""
    effs = {r: (efficiency(pm25_by_region[r], price_by_region[r])
                if is_viable(pm25_by_region[r], price_by_region[r]) else 0.0)
            for r in pm25_by_region}
    total = sum(effs.values())
    if total <= 0:
        return {r: 0.0 for r in pm25_by_region}
    return {r: e / total for r, e in effs.items()}


def pm25_weights_normalised(pm25_by_region: dict[str, float]) -> dict[str, float]:
    """Normalised raw 1/PM2.5 weights — the PRICE-FREE component only.
    Kept for diagnostics/ablation; NOT the engine's target (that is
    `target_allocations`, which also needs price)."""
    w = {r: pm25_weight(v) for r, v in pm25_by_region.items()}
    total = sum(w.values())
    return {r: x / total for r, x in w.items()} if total > 0 else \
        {r: 0.0 for r in pm25_by_region}


def target_weights(pm25_by_region: dict[str, float]) -> dict[str, float]:
    """DEPRECATED proxy — kept so existing callers keep running. Returns
    the normalised raw 1/PM2.5 weights (== `pm25_weights_normalised`).

    The earlier model used this AS the rebalance target — it is NOT. The
    real target (`target_allocations`) also depends on price. Anything
    still calling this is using a price-free approximation."""
    return pm25_weights_normalised(pm25_by_region)


# ── dead zone — strategies/shared/rebalance_helpers.rs::should_rebalance
def should_rebalance(target_value: float, current_value: float,
                     total_value: float) -> bool:
    """The engine rebalances a position only when its value gap exceeds
    0.15% of the whole portfolio — otherwise it sits in the dead zone."""
    return abs(target_value - current_value) > total_value * DEAD_ZONE_BPS / 10_000


def clamp_deficit(raw_deficit: float, total_value: float) -> float:
    """Per-cycle deficit clamp — a rebalance moves at most 2.5% of the
    portfolio toward target in one cycle (strategy_impl.rs)."""
    return min(raw_deficit, total_value * MAX_DEFICIT_BPS / 10_000)


# ── AMM price impact — instructions/whirlpool/math.rs ────────────────
def virtual_usdc(sqrt_price: int, liquidity: int, is_usdc_token_a: bool) -> int:
    """Virtual USDC reserves of the concentrated-liquidity pool, from L
    and sqrt_price (Q64.64) — the constant-product reserve the price-
    impact formulas use."""
    if liquidity <= 0 or sqrt_price <= 0:
        return 0
    if is_usdc_token_a:
        return (liquidity * Q64) // sqrt_price
    return (liquidity * sqrt_price) // Q64


def predict_post_trade_price(current_price: float, sqrt_price: int,
                             liquidity: int, trade_usdc: float, is_buy: bool,
                             is_usdc_token_a: bool) -> float:
    """Post-trade price after a `trade_usdc` swap — exact constant-product
    (Splash pools are full-range x·y=k):
        BUY:  new = old · ((R + T) / R)²
        SELL: new = old · ((R - T) / R)²   (T clamped to 99% of R)
    R = virtual USDC reserves, T = trade size. This is literally "what a
    trade does to the current price.\""""
    if liquidity <= 0 or sqrt_price <= 0 or trade_usdc <= 0:
        return current_price
    R = virtual_usdc(sqrt_price, liquidity, is_usdc_token_a)
    if R <= 0:
        return current_price
    if is_buy:
        ratio = (R + trade_usdc) / R
        return current_price * ratio * ratio
    eff_trade = min(trade_usdc, R * 0.99)
    ratio = (R - eff_trade) / R
    return current_price * ratio * ratio


def max_trade_for_impact(sqrt_price: int, liquidity: int,
                         is_usdc_token_a: bool,
                         max_impact_bps: int = DEFAULT_MAX_IMPACT_BPS) -> float:
    """Largest USDC trade that stays within `max_impact_bps` price impact:
        max_trade = virtual_usdc · max_impact_bps / 20_000
    (factor 20_000: impact ≈ 2·trade/reserves under constant product)."""
    if liquidity <= 0 or sqrt_price <= 0 or max_impact_bps <= 0:
        return 0.0
    return virtual_usdc(sqrt_price, liquidity, is_usdc_token_a) * max_impact_bps / 20_000
