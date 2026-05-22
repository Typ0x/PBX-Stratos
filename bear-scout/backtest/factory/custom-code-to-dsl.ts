/**
 * Custom-code -> DSL predicate extractor.
 *
 * Best-effort static analysis of the evolve-loop's TypeScript strategy
 * files (the ones under `~/.pbx-lab/strategies/<name>.ts`) so the SAME
 * paper-deploy bridge that handles decoded rules + translated parametric
 * configs can also handle the leaderboard's custom-code winners.
 *
 * ## Why this exists
 *
 * The factory's TOP leaderboard rows are increasingly custom-code
 * strategies — LLM-written TS files default-exporting a `FactoryStrategy`
 * whose `decide()` function returns `'hold' | 'switch' { to: ... }`.
 * Before this module `paper-deploy --top N` skipped every custom-code
 * record ("custom-code strategies are evolve-loop TypeScript; promote
 * via the evolve loop's own deploy path"). That meant the best research
 * output could never reach paper trading.
 *
 * Two paths now close that loop, each surfaced by the existing
 * `paper-deploy.ts` call site:
 *
 *   (a) **Explicit predicates in config** — the evolve generator can now
 *       emit `config.predicates: { entry, exit }` alongside the source.
 *       Most robust: no extraction, the LLM writes the DSL form directly.
 *       Handled WITHOUT this module — `paper-deploy.ts` reads the field
 *       and feeds it straight to `deployPaperRule()`.
 *
 *   (b) **Source extraction** — this module. For existing custom-code
 *       files on disk (no `config.predicates`), parse the `decide()` body
 *       and recover DSL predicates by pattern matching. ALWAYS best-
 *       effort: the returned `confidence` tells the operator how much to
 *       trust the result. The notes field calls out any heuristic the
 *       extractor relied on. Returns null when nothing reasonable can be
 *       recovered.
 *
 * ## Hard rails
 *
 * This module NEVER runs the strategy source. It does not invoke
 * dynamic-code APIs (`Function` constructor, `import()`, vm), and it
 * does not write or read live-trading config. Tests verify the entry
 * point is a pure string-in / object-out function with no side effects.
 * The downstream call is the SAME `deployPaperRule` that decoded rules
 * and translated configs use, and THAT call hard-codes `mode: 'paper'`.
 *
 * ## Approach
 *
 * No full TS parser (no new dep). Instead a small lexer + regex pass
 * over normalized source:
 *
 *   1. Locate the `decide` function body.
 *   2. Walk every `if (...) return { type: 'switch', to: <target> }`
 *      clause. Bucket by branch:
 *        - `to: 'USDC'` (or `to: 'USDC' as const`) → EXIT predicate
 *        - `to: <region>` / `to: cheapest` / `to: r` → ENTRY predicate
 *      The bucket also looks at the surrounding `if (held === 'USDC')`
 *      or `if (held !== 'USDC')` block to assign clauses that don't
 *      themselves disambiguate.
 *   3. Normalize each condition: replace `f.X`, `feats[r].X`,
 *      `arb.spread`, JS operators, dotted region literals, etc. with
 *      DSL-feature tokens and DSL operators (`AND` / `OR` / `==` / `!=`).
 *      Strip references that the DSL can't express (`ctx.history.length`,
 *      `arb.cheap`, `valid.length`, bare let-bindings) — when a clause
 *      depends on them, ELIDE the clause and lower confidence.
 *   4. Validate every produced predicate against the project's own
 *      `validatePredicate()` gate. Any predicate the validator rejects
 *      is dropped from the output (NEVER ship a predicate the
 *      orchestrator will refuse at launch time).
 *
 * If neither a valid entry nor a valid exit predicate survives the
 * pipeline, return null — the caller surfaces this as a skip.
 */
import { validatePredicate } from '../../../src/strategies/dsl/interpreter.js';

/** Output of a successful extraction. */
export interface ExtractedRule {
  /** ENTRY predicate. Fires from `holding == USDC` to enter a region. */
  entryWhen: { predicate: string; description: string };
  /** EXIT predicate. Fires from holding a region to leave it (to USDC). */
  exitWhen: { predicate: string; description: string };
  /** 0-1: heuristic confidence in the extraction. */
  confidence: number;
  /** Why confidence is what it is — surfaced to logs / deploy output so
   *  the operator can decide whether to trust the result. */
  notes: string[];
}

/**
 * Pattern-match a custom-code .ts source and extract DSL predicates from
 * its `decide()` body. Returns null when no reasonable predicate could
 * be recovered.
 *
 * Pure: no I/O, no module import, no dynamic code. Same input → same
 * output. The downstream paper-deploy call hard-codes mode='paper'.
 */
export function extractDslFromCustomCode(source: string): ExtractedRule | null {
  if (typeof source !== 'string' || source.length === 0) return null;
  // Cheap upper bound — full TS strategies in the wild sit comfortably
  // under 8 KB. A huge blob almost certainly isn't a single strategy file.
  if (source.length > 200_000) return null;

  // Strip comments so they don't confuse pattern matching.
  const stripped = stripComments(source);

  // Inline simple numeric constants — top-level `const NAME = NUMBER;`
  // bindings — so threshold checks written as `arb.spread > ENTRY`
  // become matchable as `spread > 0.16`. Without this many leader-shape
  // strategies look opaque to the extractor.
  const inlined = inlineNumericConsts(stripped);

  // Find the `decide` function body — `(ctx) => { ... }` OR `decide(ctx) { ... }`.
  const body = locateDecideBody(inlined);
  if (body == null) return null;

  // Enumerate `return { type: 'switch', to: <target> } ...` sites and
  // their guarding conditions (the `if (...)` clauses on the path to
  // that return). For each site, classify entry vs exit by the `to:`
  // value and any enclosing `held === 'USDC'` block.
  const sites = enumerateSwitchSites(body);
  if (sites.length === 0) return null;

  const entryConds: string[] = [];
  const exitConds: string[] = [];
  const notes: string[] = [];
  let elidedClauses = 0;

  for (const site of sites) {
    // The held-vs-USDC test sometimes appears INLINE on the same `if` as
    // the trading condition (e.g. `if (held === 'USDC' && f.rank === 0)`).
    // Pre-scan the guards for an inline held-test and lift it to the
    // site's branch flags so classifySite() sees the right context.
    for (const g of site.guards) {
      for (const conj of splitTopLevel(g, '&&')) {
        const b = detectUsdcBranch(conj);
        if (b === 'usdc') site.inUsdcBlock = true;
        else if (b === 'held') site.inHeldBlock = true;
      }
    }
    const role = classifySite(site);
    if (role === 'unknown') {
      // We saw a switch but can't tell which side of the trade it
      // models. Note it and move on — better to lose this clause than
      // mislabel it.
      elidedClauses++;
      continue;
    }
    const dsl = translateGuards(site.guards);
    if (dsl.elided > 0) elidedClauses += dsl.elided;
    if (dsl.predicate.length === 0) continue;
    if (role === 'entry') entryConds.push(dsl.predicate);
    else exitConds.push(dsl.predicate);
  }

  // Build OR-joined predicates per role. Multiple `if (...) return switch'
  // clauses on the same branch are alternative entries / exits.
  const entryPredicate = joinOr(entryConds);
  const exitPredicate = joinOr(exitConds);

  // Validate against the project's own DSL validator — never emit a
  // predicate the orchestrator would reject at launch time.
  const validEntry = entryPredicate ? validatePredicate(entryPredicate).ok : false;
  const validExit = exitPredicate ? validatePredicate(exitPredicate).ok : false;

  if (!validEntry && !validExit) return null;

  // Confidence model — start at 1.0 and dock for every red flag:
  //   -0.2 per elided clause (something we couldn't translate)
  //   -0.3 if entry predicate is empty (one-sided extraction)
  //   -0.3 if exit  predicate is empty
  //   -0.1 if multiple OR-clauses (alternatives are harder to verify)
  let confidence = 1.0;
  if (elidedClauses > 0) {
    confidence -= Math.min(0.6, 0.2 * elidedClauses);
    notes.push(
      `Elided ${elidedClauses} clause${elidedClauses === 1 ? '' : 's'} that depended on identifiers the DSL cannot express.`,
    );
  }
  if (!validEntry) {
    confidence -= 0.3;
    notes.push('No valid ENTRY predicate could be recovered — paper bot will never open a position.');
  }
  if (!validExit) {
    confidence -= 0.3;
    notes.push('No valid EXIT predicate could be recovered — paper bot will hold whatever it enters indefinitely.');
  }
  if (entryConds.length > 1 || exitConds.length > 1) {
    confidence -= 0.1;
    notes.push('Multiple alternative branches joined with OR — verify each makes sense before scaling capital.');
  }
  confidence = Math.max(0, Math.min(1, confidence));

  // ALWAYS surface that this is a static extraction, not the original
  // strategy. The operator should expect drift vs. the backtest.
  notes.push(
    'Best-effort extraction from custom-code source — predicates capture the same SIGNAL DIRECTION but the paper bot will not replay the backtest tick-for-tick.',
  );

  // The validator gates each side independently. If exit failed validation
  // but entry passed (or vice versa) we still ship the survivor and use a
  // safe sentinel for the failed side.
  const finalEntry = validEntry ? entryPredicate : 'rank == 99'; // never true
  const finalExit = validExit ? exitPredicate : '0 > 1'; // never true

  return {
    entryWhen: {
      predicate: finalEntry,
      description: validEntry
        ? `Extracted from ${entryConds.length} clause${entryConds.length === 1 ? '' : 's'} of decide() entry path.`
        : 'No entry predicate could be recovered — using a never-fires sentinel.',
    },
    exitWhen: {
      predicate: finalExit,
      description: validExit
        ? `Extracted from ${exitConds.length} clause${exitConds.length === 1 ? '' : 's'} of decide() exit path.`
        : 'No exit predicate could be recovered — using a never-fires sentinel.',
    },
    confidence,
    notes,
  };
}

// ─── lexical helpers ───────────────────────────────────────────────────

/**
 * Inline simple numeric constants. Matches `const NAME = -0.05;` (and
 * `let`/`var`) at any depth and rewrites every bareword occurrence of
 * `NAME` in the source to the literal value. Only purely numeric
 * literals are inlined — string / object / array bindings are left
 * alone. This is needed for leader-shape strategies that define
 * uppercase thresholds (`const ENTRY = 0.16;`) and use them inside
 * `decide()`.
 */
function inlineNumericConsts(src: string): string {
  const constRe = /\b(?:const|let|var)\s+([A-Z_][A-Z0-9_]*)\s*(?::\s*number)?\s*=\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*;/g;
  const bindings = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = constRe.exec(src))) {
    bindings.set(m[1], m[2]);
  }
  if (bindings.size === 0) return src;
  let out = src;
  for (const [name, val] of bindings) {
    // Replace every word-boundary occurrence with the numeric literal.
    // Wrap negative values in parens so adjacent operators parse cleanly
    // (e.g. `> -0.05` stays well-formed).
    const literal = val.startsWith('-') ? `(${val})` : val;
    const re = new RegExp(`\\b${name}\\b`, 'g');
    out = out.replace(re, literal);
  }
  return out;
}

/** Strip `//...EOL` and block comments. Naive but adequate for the
 *  generator's TS output. */
function stripComments(src: string): string {
  // Block comments first — non-greedy across newlines.
  let s = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Line comments — but NOT inside a string literal. Cheap approximation
  // (the generator does not emit `//` inside strings).
  s = s.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return s;
}

/**
 * Locate the body of the `decide` function. Supports the two shapes the
 * generator emits:
 *
 *   decide: (ctx) => { ... }          // arrow form
 *   decide(ctx) { ... }                // method shorthand
 *
 * Returns the body INSIDE the outer braces (with braces stripped), or
 * null if no decide function is found.
 */
function locateDecideBody(src: string): string | null {
  const anchorRe = /\bdecide\s*(?::\s*)?(?:\([^)]*\))?\s*(?:[:=]\s*\([^)]*\)\s*=>\s*)?\{/g;
  const m = anchorRe.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(start, i);
      }
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const close = findStringClose(src, i, ch);
      if (close === -1) return null;
      i = close;
    }
  }
  return null;
}

function findStringClose(src: string, openIdx: number, quote: string): number {
  for (let i = openIdx + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === quote) return i;
  }
  return -1;
}

// ─── switch-site enumeration ───────────────────────────────────────────

interface SwitchSite {
  /** The literal target string from `to: '...'`, OR the identifier name
   *  when the target is a variable (`to: cheapest`, `to: r`). */
  target: string;
  /** Conditions guarding this return, in source order. Each is the raw
   *  expression text inside the surrounding `if (...)` clauses. */
  guards: string[];
  /** True if any guarding `if` was on a branch that ALSO asserted
   *  `held === 'USDC'` (or `ctx.state.holding === 'USDC'`). */
  inUsdcBlock: boolean;
  /** True if any guarding `if` was on a branch that asserted
   *  `held !== 'USDC'` (or similar held-a-region clause). */
  inHeldBlock: boolean;
}

/**
 * Walk the decide() body looking for `return { type: 'switch', to: X }`
 * sites. For each site, record the chain of `if (...)` conditions guarding
 * it and whether the chain entered an `if (held === 'USDC')` block.
 *
 * Simplifying assumptions:
 *  - We treat sequential `if` statements at the same depth as additive
 *    (each one's condition guards its own return).
 *  - We do NOT model `else` branches' implicit negation — the LLM rarely
 *    uses `else` for switch returns; when it does, the condition is
 *    discarded and the clause is left untranslated (confidence drops).
 *  - We do NOT model `for`/`while` loops symbolically — when a return
 *    sits inside one, the loop variable is treated as opaque.
 */
function enumerateSwitchSites(body: string): SwitchSite[] {
  const sites: SwitchSite[] = [];
  type Frame = { kind: 'if'; cond: string; closeAt: number; usdcBranch: 'usdc' | 'held' | null };
  const frames: Frame[] = [];

  for (let i = 0; i < body.length; i++) {
    while (frames.length > 0 && i >= frames[frames.length - 1].closeAt) {
      frames.pop();
    }

    const ch = body[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const close = findStringClose(body, i, ch);
      if (close === -1) break;
      i = close;
      continue;
    }

    // Try to match an `if (cond) ...` opener.
    if (body[i] === 'i' && body[i + 1] === 'f' && /[\s(]/.test(body[i + 2] ?? '')) {
      if (i > 0 && /[A-Za-z0-9_$]/.test(body[i - 1])) {
        // Part of a longer identifier — skip.
      } else {
        let j = i + 2;
        while (j < body.length && /\s/.test(body[j])) j++;
        if (body[j] === '(') {
          const parenEnd = matchParen(body, j);
          if (parenEnd !== -1) {
            const cond = body.slice(j + 1, parenEnd).trim();
            let k = parenEnd + 1;
            while (k < body.length && /\s/.test(body[k])) k++;
            let closeAt: number;
            if (body[k] === '{') {
              const braceEnd = matchBrace(body, k);
              if (braceEnd === -1) {
                i = j;
                continue;
              }
              closeAt = braceEnd + 1;
            } else {
              closeAt = findStatementEnd(body, k);
            }
            frames.push({ kind: 'if', cond, closeAt, usdcBranch: detectUsdcBranch(cond) });
            i = (body[k] === '{' ? k : k - 1);
            continue;
          }
        }
      }
    }

    // Match `return { type: 'switch', to: <X> }`.
    if (body.startsWith('return', i) && (body[i + 6] === undefined || /\s/.test(body[i + 6]) || body[i + 6] === '{')) {
      const after = i + 6;
      let j = after;
      while (j < body.length && /\s/.test(body[j])) j++;
      if (body[j] === '{') {
        const objEnd = matchBrace(body, j);
        if (objEnd !== -1) {
          const obj = body.slice(j, objEnd + 1);
          const target = parseSwitchTarget(obj);
          if (target != null) {
            const guards: string[] = [];
            let inUsdc = false;
            let inHeld = false;
            for (const f of frames) {
              if (f.cond) guards.push(f.cond);
              if (f.usdcBranch === 'usdc') inUsdc = true;
              else if (f.usdcBranch === 'held') inHeld = true;
            }
            sites.push({ target, guards, inUsdcBlock: inUsdc, inHeldBlock: inHeld });
          }
          i = objEnd;
          continue;
        }
      }
    }
  }

  return sites;
}

function matchParen(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const close = findStringClose(s, i, ch);
      if (close === -1) return -1;
      i = close;
    }
  }
  return -1;
}

function matchBrace(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const close = findStringClose(s, i, ch);
      if (close === -1) return -1;
      i = close;
    }
  }
  return -1;
}

function findStatementEnd(s: string, startIdx: number): number {
  for (let i = startIdx; i < s.length; i++) {
    const ch = s[i];
    if (ch === ';' || ch === '\n') return i + 1;
    if (ch === "'" || ch === '"' || ch === '`') {
      const close = findStringClose(s, i, ch);
      if (close === -1) return s.length;
      i = close;
    } else if (ch === '{') {
      const end = matchBrace(s, i);
      if (end === -1) return s.length;
      i = end;
    } else if (ch === '(') {
      const end = matchParen(s, i);
      if (end === -1) return s.length;
      i = end;
    }
  }
  return s.length;
}

/** Detect whether an `if` condition is testing the holding for USDC.
 *  Returns 'usdc' when the branch implies held == USDC, 'held' when it
 *  implies held != USDC, and null otherwise. */
function detectUsdcBranch(cond: string): 'usdc' | 'held' | null {
  const c = cond.replace(/\s+/g, ' ');
  if (/(?:held|ctx\.state\.holding)\s*(?:===?|==)\s*['"]USDC['"]/.test(c)) return 'usdc';
  if (/['"]USDC['"]\s*(?:===?|==)\s*(?:held|ctx\.state\.holding)/.test(c)) return 'usdc';
  if (/(?:held|ctx\.state\.holding)\s*(?:!==?|!=)\s*['"]USDC['"]/.test(c)) return 'held';
  if (/['"]USDC['"]\s*(?:!==?|!=)\s*(?:held|ctx\.state\.holding)/.test(c)) return 'held';
  return null;
}

function parseSwitchTarget(obj: string): string | null {
  const flat = obj.replace(/\s+/g, ' ');
  if (!/type\s*:\s*['"]switch['"]/.test(flat)) return null;
  const m = /to\s*:\s*(?:['"]([A-Z]+)['"]|([A-Za-z_$][A-Za-z0-9_$.]*)(?:\s+as\s+const)?)/.exec(flat);
  if (!m) return null;
  return (m[1] ?? m[2]).trim();
}

// ─── classification ────────────────────────────────────────────────────

function classifySite(site: SwitchSite): 'entry' | 'exit' | 'unknown' {
  if (site.target === 'USDC') return 'exit';
  if (site.inUsdcBlock && !site.inHeldBlock) {
    if (isRegionLiteral(site.target) || isVariableTarget(site.target)) return 'entry';
  }
  if (site.inHeldBlock && (isRegionLiteral(site.target) || isVariableTarget(site.target))) {
    return 'entry';
  }
  if (isRegionLiteral(site.target)) return 'entry';
  return 'unknown';
}

function isRegionLiteral(t: string): boolean {
  return t === 'NYC' || t === 'CHI' || t === 'TOR';
}

function isVariableTarget(t: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?$/.test(t);
}

// ─── guard translation ─────────────────────────────────────────────────

interface TranslatedGuard {
  predicate: string;
  elided: number;
}

/** Translate a chain of `if (cond)` clauses into a single DSL predicate.
 *  Drops held-vs-USDC clauses (already captured by entry/exit role) and
 *  any clause referring to non-feature identifiers. */
function translateGuards(guards: string[]): TranslatedGuard {
  const parts: string[] = [];
  let elided = 0;
  for (const g of guards) {
    // A guard that is ONLY a held-vs-USDC test (e.g. `held === 'USDC'`)
    // is captured by the entry/exit role; drop the whole clause. We do
    // NOT drop a guard that MIXES the held-test with trading logic —
    // those are handled per-conjunct below.
    if (/^\s*(?:held|ctx\.state\.holding)\s*(?:===?|!==?|==|!=)\s*['"][A-Z]+['"]\s*$/.test(g)) continue;
    const conjuncts = splitTopLevel(g, '&&');
    const dsl: string[] = [];
    for (const c of conjuncts) {
      // Drop pure held-vs-USDC conjuncts — they're captured by the
      // entry/exit role, not the predicate body.
      if (detectUsdcBranch(c) != null) continue;
      const ors = splitTopLevel(c, '||');
      const orDsl: string[] = [];
      let orElided = 0;
      for (const o of ors) {
        const t = translateOneClause(o);
        if (t == null) {
          orElided++;
        } else {
          orDsl.push(t);
        }
      }
      if (orDsl.length === 0) {
        elided++;
      } else if (orDsl.length === 1 && orElided === 0) {
        dsl.push(orDsl[0]);
      } else {
        dsl.push(`(${orDsl.join(' OR ')})`);
      }
    }
    if (dsl.length > 0) parts.push(dsl.join(' AND '));
  }
  return { predicate: parts.join(' AND '), elided };
}

/** Translate a single comparison clause from the JS source into DSL.
 *  Returns null when the clause references an identifier the DSL doesn't
 *  know about. */
function translateOneClause(clause: string): string | null {
  const c = clause.trim();
  if (c.length === 0) return null;

  // Drop obviously-non-feature references early — anything depending on
  // these requires running actual TS, not pattern matching.
  const banned = [
    /\bctx\.history(?!\s*,)/,
    /\bbar\.aux\b/,
    /\bbar\.price\b/,
    /\bbar\.pm25\b/,
    /\baux\[/,
    /\bvalid\.length\b/,
    /\barb\.devs\b/,           // arb.devs[held] — opaque per-region map
    /\barb\.rich\b/,
    /\bcomputeArb\b/,
    /\bdev4\b/,
    /\bdev24\b/,
    /\bcheapestPrice\b/,
    /\bheldDev\b/,
  ];
  for (const re of banned) {
    if (re.test(c)) return null;
  }

  let s = c;

  // Replace `arb.cheap` (target-region identifier from computeArb-style
  // helpers) with `cheapest_region` — the DSL alias for the live cheapest.
  s = s.replace(/\barb\.cheap\b/g, 'cheapest_region');

  // Replace `arb.spread`, `arb.dev_*`, etc. with the bare DSL feature.
  // These are the cross-region stats that the leader-shape helpers
  // (computeArb) expose under an `arb.` wrapper.
  s = s.replace(/\barb\.([a-z_][a-z0-9_]*)/g, '$1');

  // Replace `f.X`, `feats[r].X`, `feats[held].X`, `fh.X`, `fs[i].f.X`, `self.f.X`
  // with bare `X`. The bridge's snake-case keys (`dev_240m`, `rank`, etc.)
  // line up with DSL feature names so the rewrite is straightforward.
  s = s.replace(/\b[A-Za-z_$][A-Za-z0-9_$]*\.f\.([a-z_][a-z0-9_]*)/g, '$1');
  s = s.replace(/\bfeats\[[^\]]+\]\.([a-z_][a-z0-9_]*)/g, '$1');
  s = s.replace(/\bfs\[[^\]]+\]\.f\.([a-z_][a-z0-9_]*)/g, '$1');
  s = s.replace(/\b(?:f|fh|fr|fc|fcheap|self|cheap)\.([a-z_][a-z0-9_]*)/g, '$1');

  // `is_cheapest` is a dsl-bridge convenience but NOT a DSL feature —
  // rewrite to its canonical form.
  s = s.replace(/\bis_cheapest\b\s*(?:===?|==)\s*(?:true|1)\b/g, 'rank == 0');
  s = s.replace(/\bis_cheapest\b\s*(?:===?|==)\s*(?:false|0)\b/g, 'rank != 0');
  s = s.replace(/^!is_cheapest\b/g, 'rank != 0');
  s = s.replace(/^\s*is_cheapest\s*$/g, 'rank == 0');

  // Translate JS operators to DSL operators.
  s = s.replace(/===/g, '==');
  s = s.replace(/!==/g, '!=');
  s = s.replace(/&&/g, 'AND');
  s = s.replace(/\|\|/g, 'OR');
  s = s.replace(/\bas\s+const\b/g, '');

  // Collapse whitespace.
  s = s.trim().replace(/\s+/g, ' ');
  if (s.length === 0) return null;

  if (!looksLikeDsl(s)) return null;

  return s;
}

/** Cheap pre-check: every identifier in `s` is either a number, a quoted
 *  string, a DSL operator, or one of the well-known feature names. */
function looksLikeDsl(s: string): boolean {
  const KNOWN: ReadonlySet<string> = new Set([
    'AND', 'OR', 'NOT',
    'region', 'price', 'spread', 'spread_velocity_15m', 'cheapest', 'rank',
    'dev_60m', 'dev_240m', 'dev_1440m', 'dev_velocity_15m',
    'volatility_60m', 'flow_1', 'flow_2', 'flow_5', 'flow_10', 'hour_utc',
    'cycle_sold', 'cycle_bought',
    'w_usdc', 'w_pos_self', 'w_pos_NYC', 'w_pos_CHI', 'w_pos_TOR',
    'w_n_trades', 'w_last_action', 'w_last_region',
    'w_sec_since_any_trade', 'w_sec_since_self_trade',
    'self', 'this', 'held', 'cheapest_region',
  ]);
  for (const tok of s.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (KNOWN.has(tok)) continue;
    return false;
  }
  return true;
}

/** Split a string on TOP-LEVEL occurrences of `sep`. */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === "'" || ch === '"' || ch === '`') {
      const close = findStringClose(s, i, ch);
      if (close === -1) break;
      i = close;
      continue;
    }
    if (depth === 0 && s.startsWith(sep, i)) {
      parts.push(s.slice(last, i).trim());
      i += sep.length - 1;
      last = i + 1;
    }
  }
  parts.push(s.slice(last).trim());
  return parts.filter((p) => p.length > 0);
}

function joinOr(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return parts.map((p) => `(${p})`).join(' OR ');
}
