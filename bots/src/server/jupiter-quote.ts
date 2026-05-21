/**
 * Jupiter public-API quote client — the RPC-FREE quote source for paper
 * bots.
 *
 * A paper bot must run with NO Solana RPC: it lives in the project's
 * gate-free explore-only zone. The live path quotes + executes through
 * the RPC-backed `@pbx/swap-router` (Meteora cp-amm SDK over a Helius
 * connection); that path is unchanged and still gated on
 * HELIUS_MAINNET_URL.
 *
 * This module gives paper bots an equivalent quote over plain HTTP.
 * Jupiter's public "lite" quote API
 *   https://lite-api.jup.ag/swap/v1/quote
 * routes the SAME Meteora DAMM v2 pools the bot trades for all three PBX
 * region tokens — confirmed by curl. No API key, no RPC, no SDK.
 *
 * The response shape we consume:
 *   { outAmount: string (raw base units),
 *     priceImpactPct: string (e.g. "0.0021"),
 *     routePlan: [...] }
 *
 * Rate-limit note: the lite endpoint is free-tier and rate-limited. Bots
 * tick every 6-60s; a single tick can ask for several quotes (spot price
 * for each region's NAV + the trade quote). A short in-memory cache
 * (keyed on mint pair + a coarse amount bucket) collapses those into one
 * HTTP call per ~CACHE_TTL_MS window.
 */

const JUPITER_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';

/** How long a quote stays fresh in the cache. Bots tick every 6-60s; a
 *  5s window collapses the within-tick fan-out (one spot quote per region
 *  + the trade quote) into a single HTTP request per mint-pair/amount. */
const CACHE_TTL_MS = 5_000;

/** HTTP timeout. A slow Jupiter response must not stall a bot tick — on
 *  timeout the caller treats it as "no quote this tick". */
const FETCH_TIMEOUT_MS = 8_000;

/** Minimum gap between outbound Jupiter calls. A paper bot fires several
 *  quotes per tick (a NAV spot probe per region + the trade quote);
 *  bursting them trips the free tier's rate limit (HTTP 429). Serializing
 *  the calls this far apart keeps the burst under the limit. */
const MIN_CALL_GAP_MS = 350;

/** Retry budget + backoff base for a 429 or transient network error. */
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 400;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Serialize Jupiter calls ≥ MIN_CALL_GAP_MS apart via a promise chain,
 *  so a tick's burst of quotes is spread out instead of hammering the
 *  free-tier endpoint all at once. */
let _jupiterGate: Promise<void> = Promise.resolve();
let _lastJupiterCallAt = 0;
function throttleJupiter(): Promise<void> {
  const next = _jupiterGate.then(async () => {
    const wait = MIN_CALL_GAP_MS - (Date.now() - _lastJupiterCallAt);
    if (wait > 0) await sleep(wait);
    _lastJupiterCallAt = Date.now();
  });
  _jupiterGate = next.catch(() => {});
  return next;
}

export interface JupiterQuoteParams {
  /** Input token mint (base58). */
  inputMint: string;
  /** Output token mint (base58). */
  outputMint: string;
  /** Raw base units of the input token (no decimals applied). */
  amountRaw: bigint;
  /** Max acceptable slippage in basis points. */
  slippageBps: number;
}

export interface JupiterQuote {
  /** Estimated output in raw base units. */
  outAmount: bigint;
  /** Price impact as a fraction (0.0021 = 0.21%). 0 if Jupiter omitted it. */
  priceImpactPct: number;
  /** Comma-joined list of the AMM labels the route hops through, for logs. */
  route: string;
}

interface CacheEntry {
  fetchedAt: number;
  value: JupiterQuote | null;
}

const cache = new Map<string, CacheEntry>();

/**
 * Bucket the amount so near-identical sizes share a cache entry. We
 * bucket to 3 significant figures of the raw amount — a $50.00 and a
 * $50.01 trade reuse the same quote, which is well within the noise of
 * a 5s-stale quote and keeps the free tier happy.
 */
function amountBucket(amountRaw: bigint): string {
  if (amountRaw <= 0n) return '0';
  const s = amountRaw.toString();
  if (s.length <= 3) return s;
  // Keep the 3 leading digits, zero the rest.
  return s.slice(0, 3) + '0'.repeat(s.length - 3);
}

function cacheKey(p: JupiterQuoteParams): string {
  return `${p.inputMint}|${p.outputMint}|${amountBucket(p.amountRaw)}|${p.slippageBps}`;
}

/**
 * Fetch a quote from Jupiter's public API. RPC-free. Returns null on any
 * failure — no route, HTTP error, timeout, malformed body, zero output.
 * The caller MUST treat null as "no trade this tick"; this function
 * never throws.
 */
export async function quoteJupiter(p: JupiterQuoteParams): Promise<JupiterQuote | null> {
  if (p.amountRaw <= 0n) return null;

  const key = cacheKey(p);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.value;

  const url =
    `${JUPITER_QUOTE_URL}?inputMint=${encodeURIComponent(p.inputMint)}` +
    `&outputMint=${encodeURIComponent(p.outputMint)}` +
    `&amount=${p.amountRaw.toString()}` +
    `&slippageBps=${p.slippageBps}`;

  // Up to MAX_RETRIES extra attempts. A 429 (free-tier rate limit) or a
  // network error / timeout is transient — back off and retry. A 404 or
  // other non-2xx is a real "no route" / bad request and is NOT retried.
  let value: JupiterQuote | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_BASE_MS * attempt + Math.floor(Math.random() * 250));
    }
    await throttleJupiter();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 429) continue; // rate-limited — back off and retry
      if (!res.ok) break;               // 404 / other — real failure, no retry

      const body = (await res.json()) as {
        outAmount?: string;
        priceImpactPct?: string | number;
        routePlan?: Array<{ swapInfo?: { label?: string } }>;
      };
      if (body && typeof body.outAmount === 'string' && body.outAmount.length > 0) {
        const outAmount = BigInt(body.outAmount);
        if (outAmount > 0n) {
          const impactRaw = body.priceImpactPct;
          const priceImpactPct =
            impactRaw == null ? 0 : Math.abs(Number(impactRaw)) || 0;
          const route = (body.routePlan ?? [])
            .map((r) => r.swapInfo?.label ?? '?')
            .join(' → ');
          value = { outAmount, priceImpactPct, route };
        }
      }
      break; // got a 2xx — done (value set, or null = no usable route)
    } catch {
      // Network error, timeout/abort, JSON parse failure — retry if
      // attempts remain; otherwise value stays null. Never throws.
      continue;
    }
  }

  cache.set(key, { fetchedAt: Date.now(), value });
  return value;
}

/** Test/diagnostic seam — drop the in-memory cache. */
export function _clearJupiterQuoteCache(): void {
  cache.clear();
}
