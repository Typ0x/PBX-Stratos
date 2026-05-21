/**
 * TypeScript port of the Python predicate DSL evaluator in
 * `lab/runners/agentic-decode.py`.
 *
 * SECURITY-CRITICAL: model-derived predicates must run through this
 * hand-written recursive-descent interpreter. There is intentionally no
 * dynamic code execution anywhere in this module — a test asserts the
 * source contains none of the forbidden dynamic-eval tokens.
 *
 * The semantics here are a verbatim port of the Python functions
 * `ALIASES`, `_split_top`, `_eval_or`, `_eval_and`, `_eval_atom`,
 * `_resolve` and the comparison logic. Do not "simplify" them — several
 * subtle behaviours (UPPERCASE-only AND/OR, balanced-paren stripping,
 * bare-null then true) are deliberate and covered by differential tests.
 */

export type SnapValue = number | string | null;
export type Snapshot = Record<string, SnapValue>;

/** Mirrors the Python `ALIASES` dict verbatim. */
export const ALIASES: Record<string, string> = {
  this: 'region',
  this_region: 'region',
  self: 'region',
  held: 'region',
  self_region: 'region',
  cheapest_region: 'cheapest',
};

/** Mirrors Python's `DSLParseError`. */
export class DslParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DslParseError';
  }
}

/**
 * Parse a token as a float using Python `float()` semantics (as closely
 * as practical). Python `float()`:
 *  - trims surrounding whitespace
 *  - accepts a leading sign, `inf`/`infinity`/`nan` (case-insensitive)
 *  - accepts standard decimal / exponent notation
 *  - does NOT accept hex (`0x..`); we also reject underscores to stay
 *    conservative
 *  - rejects empty string
 * Returns `null` when the value would raise `ValueError` in Python.
 *
 * Note: JS `Number('')` is 0 and `Number('  ')` is 0 — we must reject
 * those. JS `parseFloat` is too lenient (accepts trailing garbage), so
 * we validate with a regex first.
 */
function pyFloat(token: string): number | null {
  const t = token.trim();
  if (t.length === 0) return null;
  const lower = t.toLowerCase();
  // Python float() accepts inf/infinity/nan with optional sign.
  if (/^[+-]?(inf|infinity)$/.test(lower)) {
    return lower.startsWith('-') ? -Infinity : Infinity;
  }
  if (/^[+-]?nan$/.test(lower)) return NaN;
  // Standard decimal / exponent form. No hex, no underscores, no
  // trailing/leading garbage.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

/**
 * Port of Python `_split_top`: split `s` on a padded ` SEP ` separator
 * that appears at paren-depth 0. The separator is matched literally
 * (case-sensitive) — this is why AND/OR must be UPPERCASE.
 */
function splitTop(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  let i = 0;
  const padSep = ' ' + sep + ' ';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '(') {
      depth += 1;
      buf += ch;
    } else if (ch === ')') {
      depth -= 1;
      buf += ch;
    } else if (depth === 0 && s.substr(i, padSep.length) === padSep) {
      parts.push(buf);
      buf = '';
      i += padSep.length;
      continue;
    } else {
      buf += ch;
    }
    i += 1;
  }
  parts.push(buf);
  return parts.map((p) => p.trim());
}

/** Port of Python `_eval_or`. */
function evalOr(s: string, snap: Snapshot): boolean {
  const parts = splitTop(s, 'OR');
  if (parts.length > 1) {
    return parts.some((p) => evalAnd(p, snap));
  }
  return evalAnd(s, snap);
}

/** Port of Python `_eval_and`. */
function evalAnd(s: string, snap: Snapshot): boolean {
  const parts = splitTop(s, 'AND');
  if (parts.length > 1) {
    return parts.every((p) => evalAtom(p, snap));
  }
  return evalAtom(s, snap);
}

const COMPARISON_RE = /^(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+)$/;

/** Port of Python `_eval_atom`, including the balanced-paren strip loop. */
function evalAtom(input: string, snap: Snapshot): boolean {
  let s = input.trim();
  // Verbatim balanced-scan paren stripping. Outer parens are stripped
  // ONLY when the first balanced group spans the whole string, so
  // `(a) AND (b)` is NOT stripped.
  while (s.startsWith('(') && s.endsWith(')')) {
    let d = 0;
    let last = -1;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') d += 1;
      else if (ch === ')') d -= 1;
      if (d === 0) {
        last = i;
        if (i < s.length - 1) break;
      }
    }
    if (last === s.length - 1) {
      s = s.slice(1, -1).trim();
      continue;
    }
    break;
  }
  // `NOT` is the only case-insensitive keyword.
  if (s.toUpperCase().startsWith('NOT ')) {
    return !evalAtom(s.slice(4).trim(), snap);
  }
  if (s.includes(' AND ') || s.includes(' OR ')) {
    return evalOr(s, snap);
  }
  const m = COMPARISON_RE.exec(s);
  if (!m) {
    const v = resolve(s, snap);
    // Bare term: truthiness; null then true (matches Python).
    return v !== null ? pyTruthy(v) : true;
  }
  const lhs = m[1].trim();
  const op = m[2];
  const rhs = m[3].trim();
  const lv = resolve(lhs, snap);
  const rv = resolve(rhs, snap);
  // None/null handling — w_last_action can be null on early snapshots.
  if (lv === null || rv === null) {
    if (op === '==') return lv === null && rv === null;
    if (op === '!=') return !(lv === null && rv === null);
    return false;
  }
  // Try numeric comparison first (both sides must parse as a number).
  const lvn = pyFloat(String(lv));
  const rvn = pyFloat(String(rv));
  if (lvn !== null && rvn !== null) {
    switch (op) {
      case '<':
        return lvn < rvn;
      case '<=':
        return lvn <= rvn;
      case '>':
        return lvn > rvn;
      case '>=':
        return lvn >= rvn;
      case '==':
        return lvn === rvn;
      case '!=':
        return lvn !== rvn;
    }
  }
  // Non-numeric: case-insensitive string compare for == / !=.
  const sLv = String(lv).toUpperCase();
  const sRv = String(rv).toUpperCase();
  if (op === '==') return sLv === sRv;
  if (op === '!=') return sLv !== sRv;
  throw new DslParseError(
    `cannot compare non-numeric values with ${op}: ${lhs} vs ${rhs}`,
  );
}

/**
 * Python truthiness for a resolved value. Resolved values are number |
 * string (null is handled by the caller). Mirrors `bool(v)`:
 *  - number: false iff 0 (NaN is truthy in Python — `bool(nan)` is True)
 *  - string: false iff empty
 */
function pyTruthy(v: number | string): boolean {
  if (typeof v === 'number') {
    // Python: bool(0.0) is False, bool(nan) is True, bool(inf) is True.
    return v !== 0;
  }
  return v.length > 0;
}

/** Port of Python `_resolve`, including fall-through precedence. */
function resolve(token: string, snap: Snapshot): SnapValue {
  const t = token.trim();
  // (1) quoted string literal.
  if (
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('"') && t.endsWith('"'))
  ) {
    // Python `t[1:-1]`. Replicate exactly: slice(1, -1).
    return t.slice(1, -1);
  }
  // (2) exact alias match.
  if (Object.prototype.hasOwnProperty.call(ALIASES, t)) {
    return snapGet(snap, ALIASES[t]);
  }
  // (3) suffix-strip _this/_held/_self — check base in snapshot then in
  // ALIASES, but FALL THROUGH if neither.
  for (const suffix of ['_this', '_held', '_self']) {
    if (t.endsWith(suffix)) {
      const base = t.slice(0, -suffix.length);
      if (Object.prototype.hasOwnProperty.call(snap, base)) return snap[base];
      if (Object.prototype.hasOwnProperty.call(ALIASES, base)) {
        return snapGet(snap, ALIASES[base]);
      }
    }
  }
  // (4) float() parse.
  const n = pyFloat(t);
  if (n !== null) return n;
  // (5) bare token present in snapshot.
  if (Object.prototype.hasOwnProperty.call(snap, t)) return snap[t];
  // (6) else null.
  return null;
}

/** Python `dict.get(key)` — returns null when the key is absent. */
function snapGet(snap: Snapshot, key: string): SnapValue {
  return Object.prototype.hasOwnProperty.call(snap, key) ? snap[key] : null;
}

/**
 * Faithful evaluator. Mirrors Python `_eval_or(re.sub(r'\s+',' ',
 * predicate.strip()), snap)`. Throws `DslParseError` exactly where
 * Python raises it. Bare-null term then true (intentional).
 */
export function evaluatePredicate(predicate: string, snap: Snapshot): boolean {
  const normalized = predicate.trim().replace(/\s+/g, ' ');
  return evalOr(normalized, snap);
}

/**
 * Wraps `evaluatePredicate` in try/catch then returns `false` on any
 * error. This mirrors how Python's `evaluate_rule` / `simulate_round_trips`
 * swallow eval exceptions to `fired = False`.
 */
export function safeEvaluate(predicate: string, snap: Snapshot): boolean {
  try {
    return evaluatePredicate(predicate, snap);
  } catch {
    return false;
  }
}

/**
 * Allowlist of known feature names — the snapshot fields produced by
 * `compute_snapshots` in `lab/runners/wallet-evolve.py`, plus the alias
 * keys from `ALIASES`.
 *
 * Phase 2 finalizes this list (it must stay in sync with whatever
 * `compute_snapshots` actually emits at deploy time).
 */
export const KNOWN_FEATURES: ReadonlySet<string> = new Set<string>([
  // compute_snapshots fields
  'region',
  'price',
  'spread',
  'spread_velocity_15m',
  'cheapest',
  'rank',
  'dev_60m',
  'dev_240m',
  'dev_1440m',
  'dev_velocity_15m',
  'volatility_60m',
  'flow_1',
  'flow_2',
  'flow_5',
  'flow_10',
  'hour_utc',
  'cycle_sold',
  'cycle_bought',
  'w_usdc',
  'w_pos_self',
  'w_pos_NYC',
  'w_pos_CHI',
  'w_pos_TOR',
  'w_n_trades',
  'w_last_action',
  'w_last_region',
  'w_sec_since_any_trade',
  'w_sec_since_self_trade',
  // alias keys (this/self/held/cheapest_region/...)
  ...Object.keys(ALIASES),
]);

/** The wallet-state subset of KNOWN_FEATURES — features describing the
 *  BOT'S OWN wallet (balances, trade history), not the market. */
const WALLET_FEATURES: ReadonlySet<string> = new Set(
  [...KNOWN_FEATURES].filter((f) => f.startsWith('w_')),
);

/** True if `expr` references any wallet-state (`w_*`) feature. */
function referencesWalletFeature(expr: string): boolean {
  for (const tok of expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (WALLET_FEATURES.has(tok)) return true;
  }
  return false;
}

/**
 * Strip wallet-state (`w_*`) conjuncts from an ENTRY predicate.
 *
 * A decoded entry predicate often carries clauses like `w_n_trades > 5`
 * or `w_usdc > 100` — these describe the decoded wallet's OWN activity,
 * not a market signal. Replayed on a fresh bot (0 trades, seed capital)
 * such clauses are permanently false and deadlock entry forever. An
 * entry predicate must gate on MARKET conditions only; wallet-state
 * belongs in the exit predicate, where the bot legitimately holds a
 * position.
 *
 * Only a flat top-level AND chain is rewritten. If the predicate has a
 * top-level OR, dropping a conjunct could change its meaning, so it is
 * returned untouched.
 *
 * Returns the cleaned predicate and the conjuncts removed. The cleaned
 * predicate is empty when EVERY conjunct was wallet-state — the caller
 * must treat that as an un-deployable rule.
 */
export function stripWalletTermsFromEntry(
  predicate: string,
): { predicate: string; stripped: string[] } {
  const trimmed = predicate.trim();
  // A top-level OR means this is not a pure AND chain — leave it alone.
  if (splitTop(trimmed, 'OR').length > 1) return { predicate: trimmed, stripped: [] };
  const kept: string[] = [];
  const stripped: string[] = [];
  for (const conjunct of splitTop(trimmed, 'AND')) {
    if (referencesWalletFeature(conjunct)) stripped.push(conjunct);
    else kept.push(conjunct);
  }
  if (stripped.length === 0) return { predicate: trimmed, stripped: [] };
  return { predicate: kept.join(' AND '), stripped };
}

const MAX_PREDICATE_LENGTH = 2000;
const MAX_PAREN_DEPTH = 32;
const MAX_TERM_COUNT = 100;

export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Deploy-time GATE. Fails CLOSED: any malformed syntax, any unknown
 * identifier, or any limit breach then `{ ok: false }`. Parses the
 * predicate without evaluating it.
 *
 * An identifier is "known" if it is a quoted string literal, a numeric
 * literal, an alias key, or a member of `KNOWN_FEATURES`. A suffixed
 * token (`x_self` etc.) is accepted iff its stripped base is known.
 */
export function validatePredicate(predicate: string): ValidationResult {
  if (typeof predicate !== 'string') {
    return { ok: false, error: 'predicate must be a string' };
  }
  if (predicate.length > MAX_PREDICATE_LENGTH) {
    return {
      ok: false,
      error: `predicate exceeds max length ${MAX_PREDICATE_LENGTH}`,
    };
  }
  const normalized = predicate.trim().replace(/\s+/g, ' ');
  if (normalized.length === 0) {
    return { ok: false, error: 'empty predicate' };
  }

  // Paren balance + max nesting depth.
  let depth = 0;
  let maxDepth = 0;
  for (const ch of normalized) {
    if (ch === '(') {
      depth += 1;
      if (depth > maxDepth) maxDepth = depth;
    } else if (ch === ')') {
      depth -= 1;
      if (depth < 0) {
        return { ok: false, error: 'unbalanced parentheses' };
      }
    }
  }
  if (depth !== 0) {
    return { ok: false, error: 'unbalanced parentheses' };
  }
  if (maxDepth > MAX_PAREN_DEPTH) {
    return {
      ok: false,
      error: `parenthesis nesting exceeds max depth ${MAX_PAREN_DEPTH}`,
    };
  }

  const identifiers: string[] = [];
  let termCount = 0;

  // Recursive structural walk — mirrors the interpreter's grammar but
  // collects identifiers / counts terms instead of evaluating.
  const walk = (raw: string): ValidationResult => {
    let s = raw.trim();
    if (s.length === 0) {
      return { ok: false, error: 'empty sub-expression' };
    }
    // Balanced-paren strip — same loop as evalAtom.
    while (s.startsWith('(') && s.endsWith(')')) {
      let d = 0;
      let last = -1;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(') d += 1;
        else if (ch === ')') d -= 1;
        if (d === 0) {
          last = i;
          if (i < s.length - 1) break;
        }
      }
      if (last === s.length - 1) {
        s = s.slice(1, -1).trim();
        if (s.length === 0) {
          return { ok: false, error: 'empty parenthesised expression' };
        }
        continue;
      }
      break;
    }
    // OR / AND split (top level).
    const orParts = splitTop(s, 'OR');
    if (orParts.length > 1) {
      for (const p of orParts) {
        const r = walk(p);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    const andParts = splitTop(s, 'AND');
    if (andParts.length > 1) {
      for (const p of andParts) {
        const r = walk(p);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    // NOT.
    if (s.toUpperCase().startsWith('NOT ')) {
      return walk(s.slice(4).trim());
    }
    // A leaf: either a comparison or a bare term.
    termCount += 1;
    if (termCount > MAX_TERM_COUNT) {
      return {
        ok: false,
        error: `term count exceeds max ${MAX_TERM_COUNT}`,
      };
    }
    const m = COMPARISON_RE.exec(s);
    if (m) {
      identifiers.push(m[1].trim(), m[3].trim());
    } else {
      // Bare term. A stray operator-only / unparseable fragment is
      // still treated as a bare identifier by the interpreter, so we
      // do the same and let the allowlist check below reject it.
      identifiers.push(s);
    }
    return { ok: true };
  };

  const structural = walk(normalized);
  if (!structural.ok) return structural;

  // Allowlist check on every resolved identifier.
  for (const id of identifiers) {
    const t = id.trim();
    if (t.length === 0) {
      return { ok: false, error: 'empty identifier' };
    }
    // Quoted string literal — always allowed.
    if (
      (t.startsWith("'") && t.endsWith("'") && t.length >= 2) ||
      (t.startsWith('"') && t.endsWith('"') && t.length >= 2)
    ) {
      continue;
    }
    // Numeric literal — always allowed.
    if (pyFloat(t) !== null) continue;
    // Exact alias / feature.
    if (Object.prototype.hasOwnProperty.call(ALIASES, t)) continue;
    if (KNOWN_FEATURES.has(t)) continue;
    // Suffixed token: accept iff stripped base is a known feature/alias.
    let suffixOk = false;
    for (const suffix of ['_this', '_held', '_self']) {
      if (t.endsWith(suffix)) {
        const base = t.slice(0, -suffix.length);
        if (
          KNOWN_FEATURES.has(base) ||
          Object.prototype.hasOwnProperty.call(ALIASES, base)
        ) {
          suffixOk = true;
        }
      }
    }
    if (suffixOk) continue;
    return { ok: false, error: `unknown identifier: ${t}` };
  }

  return { ok: true };
}
