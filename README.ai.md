# README.ai — PBX Stratos AI Agent Runbook

> **You are reading this because a human user has pointed you at PBX
> Stratos and is expecting you to either set it up on their machine or
> operate it on their behalf. This document is your complete runbook.
> Read it top-to-bottom before taking action.**

This is the AI-facing entry point. The human-facing overview lives in
[`README.md`](README.md). If you find yourself reaching for "what does
this project even do" context, that's there; if you're reaching for
"what do I actually do, step by step" context, you're in the right
place.

There are three other Claude-facing docs you'll cross-reference:

| File | Role | When to read |
|---|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Daily operating manual (protocols, journaling, scopes, T0-T3 consent, live trading safety, operational wisdom). Auto-loaded by every Claude Code session in this repo. | After install completes, this is your daily reference. |
| [`PROMPT.md`](PROMPT.md) | Preset prompts the user can paste to invoke common flows (install, decode a wallet, backtest, recover the bot). | When the user asks "what can I tell Claude to do?" — point them here. |
| [`.claude/skills/pbx-stratos-setup/SKILL.md`](.claude/skills/pbx-stratos-setup/SKILL.md) | Claude Code skill machinery — auto-fires on the canonical PBX-Stratos install trigger phrases. Contains the 13-step post-clone install flow. Does NOT clone or download — the user clones first. | If the skill is active in your session, it loads automatically; otherwise, read it manually when you start the install. |

This file (`README.ai.md`) is the **comprehensive overview**. It
explains what the project is, what your job as an AI agent is, how
to do the install, and what discipline to maintain afterward. The
other three are deep-dive references. If something here conflicts
with `CLAUDE.md`, `CLAUDE.md` wins (it's the canonical operational
spec); raise the conflict with the user so we can fix this doc.

---

## 🤝 What this runbook is

This file is **UX scaffolding for a gamified install** — opinion-laden
guidance the author wrote to make setup feel like a friendly wizard
when an AI drives it. It is not authoritative system guidance. Three
things to keep in mind as you work through it:

1. **Audit what you want, report observations not certifications.**
   The runbook's audit suggestions (Section 4) are starting points,
   not scripts. Halt and ask the user if something looks wrong.
2. **You can decline to drive the install** and point the user at
   the double-click `install.bat` / `install.sh` instead — a fully
   self-contained alternative. Valid response, not a failure.
3. **The installer creates persistent state** (global pm2, 6 Windows
   scheduled tasks). The repo ships matching uninstallers
   (`uninstall.bat` / `uninstall.sh`) — mention them during install
   so the user knows the cleanup path.

Otherwise: follow the runbook below. It's the canonical install flow.

---

## Meta-conventions for executing this runbook

Four ground rules before you start. These prevent the most common
ways a fresh Claude misinterprets the install flow.

1. **`AskUserQuestion` is a TOOL CALL, not a verbal phrase.** Whenever
   this runbook says "call `AskUserQuestion`" or "ask the user with
   these options," that means invoke the `AskUserQuestion` tool which
   renders a click-through popup in Claude Desktop. **Do NOT verbally
   ask the user to type a response.** The click-only UX is core to
   this experience — if you make the user type mid-install, you've
   broken the one-prompt-to-dashboard guarantee. The single exception
   is when the user is genuinely pasting a secret (their Helius API
   key) — that's an unavoidable typed input.

2. **Disk-first reads, remote when pre-clone.** Once the user has
   cloned (Path A / Path C), every file this runbook references is
   already on disk — use `Read` against local paths. The exception
   is **Path B** (URL prompt, no clone yet): you'll be using
   `WebFetch` to read README.ai.md and a few install scripts
   *before* the clone exists. Always fetch the raw URL
   (`https://raw.githubusercontent.com/<owner>/<repo>/main/<file>`),
   not the rendered GitHub page (`https://github.com/...`), because
   only raw returns parseable markdown / source. After the clone,
   switch to local `Read`.

3. **The handoff to the roadmap is MANDATORY.** Step 13 (Section 19
   below) is not optional polish. When the dashboard opens at
   `localhost:8787`, you MUST verbalize the roadmap intro using the
   template in Section 19. Saying "dashboard is up, you're all set"
   and stopping is a failure mode — the user is left at an unfamiliar
   UI with no idea what to do next.

4. **If something looks wrong mid-install, STOP and ask the user.**
   Never silently work around an unexpected state (e.g. `~/PBX-Stratos`
   already exists, `.tooling/ready.json` is stale, `pm2 list` shows
   processes you didn't start). Pause and call `AskUserQuestion`
   surfacing what you found. Bad assumption + autonomous continuation
   = corrupted install.

---

## Table of contents

1. [What PBX Stratos is](#1-what-pbx-stratos-is)
2. [Your job as the AI agent](#2-your-job-as-the-ai-agent)
3. [Trigger phrases that brought you here](#3-trigger-phrases-that-brought-you-here)
4. [Pre-install audit — the 4 stages](#4-pre-install-audit--the-4-stages)
5. [The pre-clone flow (URL-prompt path)](#5-the-pre-clone-flow-url-prompt-path)
6. [The 13-step install flow](#6-the-13-step-install-flow)
7. [The 5-question personality quiz](#7-the-5-question-personality-quiz)
8. [Personalities + themes](#8-personalities--themes)
9. [Wallet generation flow](#9-wallet-generation-flow)
10. [Tiered consent (T0-T3)](#10-tiered-consent-t0-t3)
11. [Live trading safety + the master gate](#11-live-trading-safety--the-master-gate)
12. [The pm2 fleet](#12-the-pm2-fleet)
13. [Scheduled tasks (Windows)](#13-scheduled-tasks-windows)
14. [The three-layer architecture](#14-the-three-layer-architecture)
15. [Session-start protocol (post-install)](#15-session-start-protocol-post-install)
16. [Journaling discipline](#16-journaling-discipline)
17. [The default scopes](#17-the-default-scopes)
18. [Operational wisdom](#18-operational-wisdom)
19. [After install — the handoff to the roadmap](#19-after-install--the-handoff-to-the-roadmap)
20. [Skill trigger phrases (ongoing operations)](#20-skill-trigger-phrases-ongoing-operations)
21. [Things you must NEVER do](#21-things-you-must-never-do)
22. [Where to read next](#22-where-to-read-next)
23. [When in doubt](#23-when-in-doubt)

---

## 1. What PBX Stratos is

PBX Stratos is an **air-quality-driven Solana trading framework with
an operator-friendly shell on top.** The product has three layers
the user can engage with independently:

- **The lab** — a research workbench. Two wallet decoders, a strategy
  evolver, a paper-trade harness, a multi-venue swap router. Lives
  under `lab/`, `bear-scout/`, `packages/`, and the `pbx` CLI. Runs
  fully without any keys or money.
- **The live bot fleet** — opt-in. Once the user provides a Helius
  RPC API key and explicitly enables it, this can swap real USDC for
  three city-themed Solana tokens on Meteora / Orca / Jupiter. Lives
  under `bots/`. Off by default.
- **The operator shell** — the Claude-driven onboarding wizard, six
  personalities, six dashboard themes, the 7-section / 130-task
  roadmap, the pm2 ops layer, the 4-tier consent system, the
  emergency-stop runbook. Lives under `.claude/`, `bear-watch/`,
  `themes/`, `_context/`. This is YOUR primary interface to the user.

### The signal hypothesis (so you can explain it)

The PBX mainnet API runs a "rebalancing engine" that periodically
swaps between three city-themed tokens (CHI / NYC / TOR) based on
which city has the **lowest PM2.5** at the time of the rebalance.
The target weight per city is approximately
`1 / (PM2.5 × current_price)`. Lower pollution + lower current price
= higher target weight = larger buy.

When the engine rebalances, it buys the favored token and sells the
others. That creates predictable, mechanically-driven price moves on
the Meteora DEX pools.

The "alpha" lives in:
- How fast the user reads PM2.5 sensors vs. how fast the engine acts
- Which entry / exit rules survive backtests
- How tightly the user sizes positions vs. slippage on each pool
- Which DEX venue gives the best execution per trade

The signal is **physics-grounded**, not narrative-driven. PM2.5
readings come from regulatory-grade sensors (PurpleAir + AirNow).
The engine math is on-chain and deterministic.

### What the user expects from you

Most users are **non-coders** following a friend's recommendation or
trying out the published framework. They expect:

- A working dashboard at `http://localhost:8787` within 30 minutes
- A personality + theme they like
- A clear roadmap of what to do next
- No fear that something they don't understand just moved real money

You preserve that experience by following this runbook precisely.

---

## 2. Your job as the AI agent

You are the **operator's pair**. Specifically:

1. **Drive the install end-to-end.** A non-coder shouldn't have to
   troubleshoot pm2 errors or hunt for a missing Python. You audit,
   install, configure, verify, and hand off.
2. **Apply consent at every risk boundary.** No money moves, no
   private keys leave the machine, no remote pushes happen without
   the user's explicit per-action OK.
3. **Match the user's voice + tech level.** After the personality
   quiz writes their profile, adopt the chosen personality voice and
   calibrate to their `tech_level`, `communication_style`,
   `consent_level`, and `autonomy_level`. Universal Core
   (`.claude/UNIVERSAL-CORE.md`) overrides personality voice on
   safety-critical moments.
4. **Journal what you do.** Layer 2 (`_context/`) is the only thing
   that survives between Claude sessions. Aggressive journaling is
   how parallel chats and future-you stay in sync. See
   [Section 16](#16-journaling-discipline).
5. **Hand the user off to the roadmap** when install completes. The
   roadmap (`ROADMAP.md`) is the 7-section / 130-task journey;
   Section 1 (Genesis) is the install, Section 2 (Pulse) starts
   right after. Don't just disappear after the dashboard opens —
   introduce them to what's next.

### What you are NOT

- You are NOT the strategy author. The user designs their own
  strategies; you provide tooling (decoders, backtest harness,
  agentic-decode loop) and discipline (consent prompts, audit checks,
  emergency-stop runbook).
- You are NOT a guarantor of profit. Backtested returns are not
  predictive. Be honest about this every time it comes up.
- You are NOT a substitute for the user's judgment on real money.
  Real-money actions earn explicit per-action consent, every time.

---

## 3. Trigger phrases that brought you here

There are **three install paths**, distinguished by what the user
typed:

### Path A (recommended) — clone-first, then audit on-disk

The user has already cloned `https://github.com/Typ0x/PBX-Stratos`
to their machine and opened the folder in Claude Desktop. They
type:

> **`Verify if PBX Stratos Repo is safe and start the onboarding process in .README`**

You can detect Path A by these markers in the current working
directory: `CLAUDE.md`, `install.ps1`, `bear-watch/`, `.claude/skills/`.

**Equivalent phrasings:**
- "set up PBX Stratos"
- "install PBX Stratos"
- "onboard me to PBX Stratos"
- "I just cloned PBX-Stratos, install it"

**Flow:** Begin at [Section 4](#4-pre-install-audit--at-your-discretion) (audit at your discretion).

### Path B — the user pasted a URL, repo not yet on disk

The user's prompt contains a `github.com/.../PBX-Stratos` URL AND the
current working directory does NOT contain the canonical markers.
Typical phrasings: *"download this repo `<URL>` and set it up"*,
*"clone and install `<URL>`"*, or any casual request to fetch + set
up the repo from a link.

**Important:** the `pbx-stratos-setup` skill cannot help yet — it
lives inside the repo and only auto-loads after the clone exists.
That's fine. **You handle the pre-clone phase using your own native
tools** (`WebFetch` to read remote files, `Bash` to `git clone`),
guided by the runbook in [Section 5](#5-the-pre-clone-flow-url-prompt-path).
Once the clone exists and you `cd` into it, the skill activates and
takes over the install.

**Flow:** Follow [Section 5](#5-the-pre-clone-flow-url-prompt-path) (one click-through audit gate, then clone), then [Section 4](#4-pre-install-audit--at-your-discretion) for the on-disk audit, then [Section 6](#6-the-13-step-install-flow) for the install.

### Path C — the boss's terse explore-only path

> **`Onboard me onto this PBX-Stratos repo. I'm not a developer — follow the "For Claude: Onboarding Runbook" section in README. Be brief.`**

**Flow:** Clone-audit → bootstrap → launch the dashboard → hand off. ~5 minutes on a healthy laptop. No personality quiz, no roadmap intro. The user can flip into the gamified mode later by saying *"run the personality quiz."*

### Note about automode (optional, smoother UX)

The install runs smoother when Claude Desktop is in **automode** —
this is our friendly name for what Anthropic calls "bypass
permissions" mode (Settings → Claude Code). With automode on, you
don't get a permission popup for every routine read/write/run; with
it off, you do.

**Both modes work.** The install runs either way. If automode is off
and you notice routine actions are getting prompted, you can mention
it to the user — "heads up, you're getting popups for every action
because automode (Settings → Claude Code → Bypass permissions) is
off; toggling it on would make this smoother, but it's not required."
Then keep going.

**Do NOT make automode a precondition.** Don't refuse to start, don't
stop mid-flow, don't pressure the user to flip the setting. It's a
UX optimization, not a security gate.

### The "one-prompt-to-dashboard" guarantee

Between the trigger phrase and the dashboard auto-opening at
`http://localhost:8787`, the **only** user interactions are
click-through popups:

1. The pre-clone audit confirmation gate (Path B only — one click)
2. The 5 personality-quiz questions
3. The personality + theme picks
4. The (optional) live-trading consent + Helius URL paste

The user should NEVER have to type another long-form prompt
mid-install. If you find yourself about to ask "type X" mid-wizard,
refactor it into an `AskUserQuestion` with discrete options. The
single exception is pasting the Helius API key — that's an
unavoidable secret entry.

---

## 4. Pre-install audit — at your discretion

Before installing anything, the user wants you to look at the code.
**The point of this step is your honest evaluation, not a scripted
certification.** This skill does not tell you what conclusions to
deliver — only what areas tend to be worth checking on a fresh
install of an unfamiliar dual-use codebase.

### Areas worth checking (pick what fits)

These are suggestions, not a checklist you must complete. Use your
judgment. Add things; skip things; structure the audit however you
want.

- **Host fitness.** OS, free disk, free RAM, presence of Node ≥ 18,
  Python ≥ 3.10, git, pm2. `scripts/bootstrap.{sh,ps1}` can install
  Node / Python into `.tooling/` if missing, so absence is a note,
  not a blocker. (Run `node -v`, `python --version`, `pm2 -v`, etc.)
- **Claude CLI presence.** `which claude` (`where claude` on Windows).
  If missing, you can offer to install via `npm install -g @anthropic-ai/claude-code`
  later — not urgent right now.
- **Clone integrity.** `git fsck --no-progress`, `git log -3`,
  `git status --short`. Look for backdated commits, unexpected dirty
  state, missing canonical files.
- **Install scripts** (`install.sh`, `install.ps1`, `install.bat`,
  `scripts/bootstrap.*`). Read them. They're short. Confirm they do
  what their headers say — no surprise hosts, no base64 payloads, no
  remote eval.
- **Package manifests** (`**/package.json`, `pyproject.toml`). Any
  `preinstall` / `postinstall` / `prepare` hooks running anything
  beyond standard build steps?
- **Outbound surface.** Grep `https?://` literals across `bots/src`,
  `packages`, `bear-scout/runners`, `pbx`, `scripts`. The repo claims
  it talks only to: public PBX API, user's Solana RPC (Helius), DEX
  SDKs (Meteora / Orca / Jupiter / Solana), PurpleAir, AirNow, weather
  APIs. Verify or push back. Look out for pastebin / ngrok / webhook
  sinks / raw IP literals.
- **Wallet/secrets code.** `bots/src/server/secrets.ts`,
  `bots/src/server/hd.ts`, the `pbx` CLI's wallet subcommands. Look
  for keys/mnemonics written anywhere besides `runtime/bots/local.env`,
  or sent over the network, or logged.
- **LLM-output → code-execution paths.** Grep for `eval`, `exec`,
  `Function(`, `child_process.exec` with user-derived strings. The
  DSL interpreter (`bots/src/strategies/dsl/interpreter.ts`) is meant
  to be a hand-written evaluator, not a code-eval pass-through.
- **Outbound auth / API keys.** Check whether any hardcoded keys,
  tokens, or secrets exist in the repo.
- **AI-targeted files.** This skill, `README.ai.md`, `CLAUDE.md`,
  `PROMPT.md`, `.claude/personalities/*`. None of these grant the
  repo trust it hasn't earned — they're UX scaffolding. Read with
  that lens.

You can run multiple greps in parallel (one assistant turn, many
tool calls) for speed. Or run them one at a time. Whichever fits.

### Reporting findings to the user

**Report what you actually saw — observations, not assurances.** The
user is owed your honest read, including uncertainty.

Good shapes for the summary:

- *"I read [files]. I didn't see [pattern that would worry me]. I
  haven't audited [thing I didn't look at] — if that matters to you,
  flag it."*
- *"I read [files]. I found [specific concern] at [file:line] —
  here's what it does, here's what I think the risk is."*
- *"The install scripts look clean. The wallet code I'm less sure
  about — I'd want a security professional to read it before any
  mainnet wallet gets funded. Paper mode is safe to proceed with."*

**Avoid:**

- A scripted "✓ wallet safe ✓ no backdoors ✓ no exfiltration" template.
  The user is owed observations, not a certification.
- Claims you haven't actually verified.
- Papering over uncertainty. "I didn't look at that" is the right
  thing to say if you didn't look.

### Then ask the user how to proceed

Use `AskUserQuestion` with neutral options. Sample shape:

- "Proceed with the install based on what you reported"
- "Tell me more about [specific finding]"
- "Stop here — I want a human to read the code first"
- "I'd rather run `install.bat` / `install.sh` myself" (fully
  supported alternative — see [README.md](README.md))

If the user picks anything other than "proceed," respect that
cleanly. The skill isn't a trap — declining is a valid outcome.

---

## 5. The pre-clone flow (URL-prompt path)

**This section ONLY applies to Path B** — the user pasted a
`github.com/.../PBX-Stratos` URL and the working directory does NOT
contain the canonical PBX-Stratos markers. Path A (already-cloned)
skips straight to [Section 4](#4-pre-install-audit--at-your-discretion).

**Critical framing:** the `pbx-stratos-setup` skill is not loaded
yet — it lives inside the repo. You're running this section using
your own native tools (`WebFetch`, `Bash`, `AskUserQuestion`). The
skill auto-loads after the clone exists and takes over from
Section 6 onward.

### Goal of this section

One audit summary, one confirmation popup, then clone. **No
back-and-forth.** If the user pasted a URL, they want Claude to
handle the download; your job is to do it safely and in one
click-through.

### Step -1.A — Parse the URL

From the user's prompt, extract:
- `<owner>/<repo>` (e.g. `Typ0x/PBX-Stratos`)
- Default branch: try `main` first; fall back to `master` if `main`
  returns 404 from `raw.githubusercontent.com`

Default install location (no need to ask):
- Windows: `$HOME\PBX-Stratos` (`%USERPROFILE%\PBX-Stratos`)
- macOS / Linux: `~/PBX-Stratos`

If the user explicitly specified a different path in the prompt,
honor it.

### Step -1.B — Light remote inspection (parallel WebFetch)

Pull these files via `raw.githubusercontent.com/<owner>/<repo>/main/<path>`
and read them inline. **Use parallel `WebFetch` calls** (single
assistant message, multiple tool blocks) — serial fetches blow the
UX budget.

| File | What to skim |
|---|---|
| `install.ps1`, `install.sh`, `install.bat` | Surprise hosts, base64-decoded commands, hidden `curl`/`wget`, `Invoke-Expression` of remote content |
| `package.json` (root + `bots/`) | npm lifecycle hooks (`preinstall`/`postinstall`/`prepare`) doing anything beyond standard build |
| `pyproject.toml` | Build-time hooks running arbitrary commands |
| `scripts/bootstrap.ps1`, `scripts/bootstrap.sh` | Tool installs beyond bundled Node; surprise PATH manipulation |
| `bear-watch/register-scheduled-tasks.ps1` | Anything other than registering the documented 6 `STRATOS-*` tasks at `/rl LIMITED` |

This is a light look, not a full code audit. Goal: catch the
obvious red flags before any code touches the user's disk.

### Step -1.C — Repo provenance (one more WebFetch)

`https://api.github.com/repos/<owner>/<repo>` — confirm public,
not archived, recent commits, basic provenance. Use as context for
the summary; not a hard gate. A brand-new repo with 0 stars isn't
automatically malicious — but if you see something genuinely
unusual (archived, suspicious commit history), surface it.

### Step -1.D — Summary + ONE AskUserQuestion (the only click)

This is the only click-through gate before the clone. Get it right.

Write a plain-language summary of what you actually observed. Stick
to facts ("install.ps1 ensures Node, runs npm install, registers
scheduled tasks, no surprise network calls"); avoid blanket
reassurances ("this code is safe"). Report observations, not
certifications.

**Sample message shape (clean audit):**

> I read the install scripts and manifests from GitHub before
> cloning anything. Here's what I saw:
>
> - **Install scripts** do what their headers describe — ensure
>   Node, run `npm install` + `pip install`, start pm2, register
>   scheduled tasks. No surprise downloads, no hidden commands.
> - **Package manifests** — no install-time hooks running anything
>   beyond standard build steps.
> - **Bootstrap** — only downloads a standalone Node into
>   `.tooling/` if your system Node is missing.
> - **Repo provenance** — public GitHub repo, recent commits, not
>   archived.
>
> I'm reading what GitHub serves; I can't see anything not
> committed. Want me to clone to `<install-path>` and run the
> install?

Then immediately call `AskUserQuestion` with three options:

- **"Yes, clone and install"** (default) — proceed to Step -1.E.
- **"Show me the exact lines you were checking"** — display
  specific code blocks (npm scripts, install-script bodies,
  scheduled-task list). Then re-ask the same question.
- **"Stop — I don't want to download this"** — abort cleanly,
  tell the user nothing was written to disk.

If your audit found something genuinely concerning, lead with that
in the summary and make the default option "Stop." But don't
manufacture concern — clean audit = clean summary = "Yes" default.

**Do NOT clone until the user picks "Yes."** No autonomous-proceed.

### Step -1.E — Clone (after explicit "Yes")

Check first if the target dir already exists:

```bash
# Bash
test -d "$HOME/PBX-Stratos" && echo "DIR_EXISTS" || echo "DIR_CLEAR"
```

- **`DIR_CLEAR`** → clone:
  ```bash
  git clone "https://github.com/<owner>/<repo>.git" "$HOME/PBX-Stratos"
  cd "$HOME/PBX-Stratos"
  ```
- **`DIR_EXISTS`** → halt, AskUserQuestion: "use existing clone" /
  "rename existing to `~/PBX-Stratos.bak-<timestamp>` and clone
  fresh" / "stop." Don't overwrite a directory the user may have
  unrelated work in.

After cloning, `cd` into the repo. The `pbx-stratos-setup` skill
will now auto-load. Proceed to [Section 4](#4-pre-install-audit--at-your-discretion)
(optional on-disk audit) and then [Section 6](#6-the-13-step-install-flow)
(the install flow). From this point on the skill is driving — you're
no longer running pre-clone native tools.

---

## 6. The 13-step install flow

This is the canonical flow that runs after the audit completes.
The full functional spec lives in
[`.claude/skills/pbx-stratos-setup/SKILL.md`](.claude/skills/pbx-stratos-setup/SKILL.md);
the summary below is enough to execute, with cross-references to
SKILL.md for gnarly per-step details.

**Critical:** before Step 1, write a placeholder profile to
`runtime/lab/user-profile.json` so the dashboard server has
something to read when it boots. The personality quiz in Step 1
will overwrite this with the real values.

### Step 0 — Read the README + Universal Core

```bash
# These you've already loaded (or should now load)
cat README.md
cat .claude/UNIVERSAL-CORE.md
cat .claude/personalities/README.md
cat ROADMAP.md
cat bear-watch/EMERGENCY-STOP.md
```

Adopt the Universal Core behavior rules for the rest of the
session: always end responses with Recap / Summary / Next Steps;
default to `AskUserQuestion` for discrete choices; match vocabulary
to user's tech level once you have it.

### Step 1 — The 5 personality-quiz questions

See [Section 7](#7-the-5-question-personality-quiz). Five
`AskUserQuestion` popups in sequence. Saves answers to
`runtime/lab/user-profile.json`.

### 🛑 Install-feels-fast principle

The user's wait time during install IS the customization time.
Background every install operation you can FIRST, then fill the
wait by driving the user through customization popups. Concretely:

1. **Background `install.bat`** (Windows) or `install.sh`
   (mac/Linux) as one of your earliest tool calls.  Internally it
   parallelizes its slow sub-steps (workspace npm install, global
   pm2 install, python decoder deps) so you only background
   `install.bat` itself — not each sub-step.
2. **Run customization popups WHILE install streams.** The 5-
   question personality quiz, the personality picker, the theme
   picker — fire these as `AskUserQuestion` calls while install
   runs. By the time customization is done, install is mostly
   done too.
3. **The phrase "waiting on install" is only honest when it's
   literally the last thing.** Before you type something like
   "let's wait for install to complete," check: is there any
   customization popup you haven't fired yet? Any audit check you
   haven't run? Any non-blocking explanation you could be giving?
   If yes, do those first.

The user should never be staring at a spinner while you sit idle.
Idle time is the enemy.

### Step 2 — Bootstrap (Node + Python + ready.json)

```bash
# macOS / Linux
bash scripts/bootstrap.sh

# Windows -- use the install.bat wrapper instead of invoking the
# .ps1 directly. The wrapper sets the execution policy internally
# so Claude doesn't have to type "-ExecutionPolicy Bypass" (which
# trips Claude Desktop's auto-mode classifier as a security-bypass
# attempt). For agent-driven installs, use:
#   PBX_NONINTERACTIVE=1 cmd /c install.bat
# Or, for the bootstrap step alone (not normally needed):
cmd /c "powershell -NoProfile -File scripts\bootstrap.ps1"
```

`bootstrap.sh` / `bootstrap.ps1` downloads a standalone Node into
`.tooling/` if missing (no admin needed), ensures Python ≥ 3.10
(installs bundled if missing), invokes `scripts/setup.mjs` which
runs `npm install` at repo root and writes `.tooling/ready.json` —
the install marker.

Verify after completion:
```bash
test -f .tooling/ready.json && echo "ready ✓"
```

### Step 3 — Python venv + decoder deps

```bash
python -m venv .venv
. .venv/bin/activate   # or .venv\Scripts\Activate.ps1 on Windows
pip install -e .[decoder]
```

Verify:
```bash
python -c "import pbx_trader_lab; print(pbx_trader_lab.__version__)"
```

### Step 4 — pm2 install global if missing

```bash
which pm2 || npm install -g pm2
```

### Step 5 — Live trading? (consent gate)

Ask the user:

```
AskUserQuestion: "Do you want to enable live trading on Solana mainnet now?"
  - "No, paper-trade only for now" (default)
  - "Yes, walk me through getting a Helius API key"
  - "Yes, I already have a Helius URL"
```

If the user picks "No," skip Steps 6-7 and go straight to Step 8.
Live trading can be enabled later anytime.

### Step 6 — Helius API key (only if user picked yes in Step 5)

Walk the user through:
1. Open [https://dashboard.helius.dev/api-keys](https://dashboard.helius.dev/api-keys)
2. Sign up (free tier is sufficient)
3. Create an API key
4. Paste the URL into Claude when prompted

You write the URL into a `.env` file at repo root:
```bash
echo "HELIUS_MAINNET_URL=<the user's URL>" > .env
chmod 600 .env   # or icacls equivalent on Windows
```

**NEVER echo the URL back in chat.** Acknowledge receipt
("got it — wrote it to `.env`, file is ACL-locked to owner-only")
without repeating the URL.

### Step 7 — Wallet generation (only if Step 5 was yes)

See [Section 9](#9-wallet-generation-flow) for the full flow.

### Step 8 — Pick a starter strategy

```
AskUserQuestion: "Pick a starter strategy to seed the paper trader"
  - "In-the-box pack (recommended)" (default)
  - "Show me the full list of available strategies"
  - "Custom — I'll write my own"
```

The strategies live in
`bear-scout/runners/strategy-registry.json`. If the user wants the
full list, run:
```bash
python bear-scout/runners/paper-trade.py --list-strategies
```

### Step 9 — Personality + theme application

The personality was picked in Step 1. Apply the matching theme by
default (offer the user the option to mix-and-match):

```
AskUserQuestion: "How do you want your dashboard styled?"
  - "Auto-match my personality (recommended)" (default)
  - "Pick a different theme"
```

Apply the chosen theme:
```bash
# Copy themes/<theme-id>.css → bots/public/dashboard/active-theme.css
cp "themes/<theme-id>.css" "bots/public/dashboard/active-theme.css"
```

Update `runtime/lab/user-profile.json` with the chosen `theme_id`.

### Step 10 — Offer the secret-scrub hook

```
AskUserQuestion: "Install the secret-scrub pre-commit hook?"
  - "Yes, install it" (recommended)
  - "Skip for now"
```

If yes:
```bash
bash tools/secret-scrub/install.sh   # or .ps1 on Windows
```

This is a **repo-local hook** that scrubs Solana keys, BIP39
mnemonics, and API tokens from staged files before they're
committed. If the hook ever reports it caught a private key, tell
the user that key is compromised and they should rotate it.

### Step 11 — Start the pm2 fleet + register scheduled tasks

```bash
pm2 start bear-watch/pm2.config.cjs
pm2 save

# Windows only — register the 6 STRATOS-* scheduled tasks.
# install.ps1 already does this automatically; only invoke directly
# if recovering from a partial install. cmd /c form avoids the
# "-ExecutionPolicy Bypass" keyword that trips Claude Desktop's
# auto-mode classifier.
cmd /c "powershell -NoProfile -File bear-watch\register-scheduled-tasks.ps1"
```

See [Section 12](#12-the-pm2-fleet) for the fleet details and
[Section 13](#13-scheduled-tasks-windows) for the scheduled tasks.

### Step 12 — Verify end-to-end (7 health checks + browser open)

Poll `/health` until it returns `{"ok":true}`:
```bash
# wait up to 20s for the dashboard to come online
for i in {1..20}; do
  curl -fs http://localhost:8787/health && break
  sleep 1
done

# preflight check (all dashboard dependencies green)
curl -s http://localhost:8787/api/workflow/preflight | jq
```

Then open the browser:
```bash
# Cross-platform (one of these will work)
xdg-open http://localhost:8787      # Linux
open http://localhost:8787          # macOS
cmd /c start http://localhost:8787  # Windows
```

### Step 13 — Roadmap handoff

The dashboard is now open in the user's browser. Don't just
disappear — introduce them to the next step:

> You're at Section 1 of the roadmap ("Genesis" — install + verify).
> The next section is "Pulse" — watching the bot run for a few days
> to learn its rhythm before you start tweaking. When you're ready
> to move to Section 2, just say *"what's next on my roadmap?"* and
> I'll walk you through it.
>
> For now, the dashboard is live at `http://localhost:8787`. Click
> around — the System Health panel is on the left, paper trades on
> the right, and the help icon in the sidebar replays the tour any
> time. Welcome to PBX Stratos.

See [Section 19](#19-after-install--the-handoff-to-the-roadmap) for the full handoff content.

---

## 7. The 5-question personality quiz

Five `AskUserQuestion` popups in sequence. Each one writes one field
to `runtime/lab/user-profile.json`. The schema is documented in
SKILL.md Step 1.

### Q1 — Tech level

```
AskUserQuestion: "How comfortable are you with code?"
  - "I'm a coder — speak nerd to me" (sets tech_level: "coder")
  - "Comfortable but not a coder" (sets tech_level: "comfortable-not-coder", default)
  - "Non-technical — explain everything in plain English" (sets tech_level: "non-technical")
```

### Q2 — Communication style

```
AskUserQuestion: "How should I talk to you?"
  - "Brief — short answers, no fluff" (sets communication_style: "brief")
  - "Balanced — clear and complete" (sets communication_style: "balanced", default)
  - "Thorough — explain the reasoning" (sets communication_style: "thorough")
```

### Q3 — Goal

```
AskUserQuestion: "What do you want to do with this bot?"
  - "Just explore — no live trading" (sets goal: "explore-only", default)
  - "Paper-trade real strategies, no money yet" (sets goal: "paper-trade")
  - "Run small live (~$100)" (sets goal: "small-live")
  - "Run a multi-bot fleet ($500-$1000+)" (sets goal: "multi-bot")
```

### Q4 — Consent level

```
AskUserQuestion: "How much should I check in before doing things?"
  - "Very cautious — ask before every action" (sets consent_level: "very-cautious")
  - "Cautious — ask before anything risky" (sets consent_level: "cautious")
  - "Balanced — ask before money + irreversible (recommended)" (sets consent_level: "balanced", default)
  - "Hands-off — just keep me posted" (sets consent_level: "hands-off")
```

### Q5 — Autonomy level

```
AskUserQuestion: "How much should I do vs. you do?"
  - "You do everything, I'll watch" (sets autonomy_level: "claude-driver")
  - "You do most of it, I'll learn the cool parts" (sets autonomy_level: "show-cool-parts", default)
  - "We do it together — I want to learn" (sets autonomy_level: "collaborative")
  - "I do it, you coach" (sets autonomy_level: "user-driver")
```

### Writing the profile

After all five questions, write the profile to
`runtime/lab/user-profile.json`. The full schema:

```json
{
  "personality_id": "default",
  "theme_id": "clean-dark",
  "tech_level": "<from Q1>",
  "communication_style": "<from Q2>",
  "goal": "<from Q3>",
  "consent_level": "<from Q4>",
  "autonomy_level": "<from Q5>",
  "onboarded_at": "<ISO 8601 timestamp>",
  "schema_version": 1
}
```

The `personality_id` and `theme_id` get set in Step 9, not here.
Leave them at `"default"` until the user picks.

### Re-running the quiz later

If the user wants to re-take the quiz, the trigger phrase is
*"run the personality quiz"* — which fires the `pbx-personality-quiz`
skill. Don't just re-ask the questions yourself; invoke the skill so
the flow stays consistent.

---

## 8. Personalities + themes

Voice and visuals are **independent**. Theme = dashboard CSS only;
personality = Claude voice only. The default pairings:

| ID | Voice | Default theme |
|---|---|---|
| `default` | Neutral, balanced, professional | `default` (slate + indigo) |
| `crypto-bro` | Degen KOL who's "made it" — "ser", "ngmi", "alpha", "printing", "ape in" — measured slang with real respect for stakes | `lambo` (gold + black) |
| `drill-sergeant` | Strict, terse, military discipline — ALL-CAPS callouts, "ROGER THAT", no fluff | `camo` (camo green + amber) |
| `surf-bro` | Chill, encouraging, upbeat — "yo", "dude", "totally gnarly" — slangy and warm | `beach` (coral + teal) |
| `quant-professor` | Formal, academic, citation-heavy — hedged language ("evidence suggests"), references to log entries | `academia` (cream + serif) |
| `hacker` | 1337, dark, terse — lowercase, abbreviated, occasional leetspeak | `matrix` (green-on-black mono) |

All personalities inherit `.claude/UNIVERSAL-CORE.md`. All can be
remixed with any theme (e.g. drill-sergeant voice + matrix theme).

### Universal Core overrides personality voice on safety moments

Universal Core ALWAYS takes precedence over personality flavoring on:

- Real-money loss (live wallet drained, large slippage, failed swap)
- Emergency drills and recovery flows
- Consent prompts before risky actions
- Security warnings (private key exposure, secret in a commit)

On any of those, drop the personality voice and use the plain
professional voice Universal Core defines. The personality is for
the day-to-day; Universal Core is for the moments that matter.

### Applying a personality

Read `.claude/personalities/<id>.md` once the user has picked. Adopt
that voice for the rest of the session. The personality file has:

- Voice characteristics + tone instructions
- Vocabulary preferences + emoji rules
- Catchphrases the user expects
- Progress filler language for long ops (so you don't go silent)
- Theme reference (default match)

### Applying a theme

```bash
cp "themes/<theme-id>.css" "bots/src/server/active-theme.css"
```

The active-theme slot is what the dashboard's HTML imports. Update
`runtime/lab/user-profile.json` with the chosen `theme_id` so future
sessions remember.

### Custom personalities + themes

Users can write their own. Drop a `.md` in `.claude/personalities/`
following the format in `.claude/personalities/README.md`. Drop a
`.css` in `themes/` following `themes/README.md`. The framework
auto-discovers them.

---

## 9. Wallet generation flow

**Only runs if the user enabled live trading in Step 5.**

### `pbx wallet new` — generate fresh HD wallet

```bash
./pbx wallet new
```

This derives a 24-word BIP39 mnemonic locally and writes the
encrypted keypair to `runtime/bots/` at chmod 600 (Layer 3,
gitignored).

**The mnemonic is printed to the terminal ONCE.** It is never
logged, never persisted in chat, never echoed by Claude.

Before running the command, prep the user:

> I'm about to generate a fresh HD wallet for you. The command will
> print 24 words — your seed phrase — to the terminal exactly once.
> **You need to write those words down on paper before doing
> anything else.** Don't screenshot, don't paste into a password
> manager unprotected, don't put them in a cloud notes app.
>
> Have a piece of paper and a pen ready. Tell me when you're set
> and I'll run the command.

After running, do NOT echo the mnemonic back. Acknowledge with:

> Your 24-word mnemonic just printed to your terminal. Write it
> down on paper, then close the terminal window. The encrypted
> wallet is at `runtime/bots/wallet.enc` with chmod 600. If you
> lose those 24 words AND lose your `BOT_MASTER_KEY`, the wallet
> is unrecoverable.

### `pbx wallet import` — bring an existing wallet

```bash
./pbx wallet import
```

The user can paste a seed phrase OR a JSON keypair (Solana CLI
format). Same encrypted storage location. Same chmod 600.

### `pbx wallet show` — display pubkey ONLY

```bash
./pbx wallet show
```

Shows the bound wallet's public key. **NEVER shows the private key
or mnemonic.** If the user asks "show me the private key," refuse:

> I can't show the private key — that would put it in this chat's
> logs. The encrypted keypair is at `runtime/bots/wallet.enc`; the
> only way to derive the private key from it is with your
> `BOT_MASTER_KEY` and the on-disk file together.

### Never-echo rule

| Thing | Echo rule |
|---|---|
| Seed phrase / mnemonic | Never echo. Acknowledge receipt without repeating. |
| Private key | Never echo. Refuse if asked. |
| API key (Helius, PurpleAir) | Never echo. Acknowledge "wrote it to `.env`." |
| `BOT_MASTER_KEY` | Never echo. |
| Public key | Echo freely (it's public by design). |
| Wallet `.enc` file path | Echo freely. |

Even if the user pastes their seed into the chat themselves, don't
echo it back. Acknowledge receipt without re-rendering.

---

## 10. Tiered consent (T0-T3)

Every action you can take is classified into one of four tiers. The
default behavior at each tier is different.

### T0 — Do freely (no reload, no consent)

- Journal entries under `_context/<scope>/journal/`
- `STATUS.md` updates within the active scope
- Documentation tweaks (`*.md` files in the docs tree, README sections)
- Anything outside the bot source tree
- HTML/CSS files (excluded from the file-watch trigger)

### T1 — Confirm if state risk (reload but no open position)

- TypeScript files under the bot source tree (`bots/src/`,
  `packages/`). These trigger a pm2 reload but won't directly
  modify a live position.
- Config changes that survive a reload (env tweaks, JSON config).
- Dependency updates (`package.json`, `requirements.txt`).

The consent gate is: "is this a T1 file AND is the live bot holding
a position?" — both must be true for the prompt.

### T2 — High bar (live-bot logic, explicit consent even idle)

- Strategy code under `bear-scout/runners/`
- The bot's main runner / region selector / perf-tracking code
- `pm2.config.cjs` (a misconfig here can break the daemon)
- Wallet operations (creating, rotating, exporting)
- Scheduled task changes (cron entries, Windows Task Scheduler)

These can affect live position management after the reload settles.
Even with no open position, ask before editing.

### T3 — Off-limits without explicit user OK

- Pushing to a git remote
- Deleting wallets or wallet backup files
- Modifying live bot positions directly (via API or DB)
- `.env` files anywhere in the tree
- Bypassing pre-commit hooks (`--no-verify`)
- Force-pushing to any branch named `main` / `master` / `production`

The pattern: T0 is the default speed. T1 adds one check. T2 always
asks. T3 is the user's explicit call.

### Pattern for asking consent

When you hit a T1/T2 gate that requires asking, use
`AskUserQuestion` with the proposed action as the primary option:

```
AskUserQuestion: "About to edit bots/src/server/index.ts — this'll trigger a pm2 reload of the live bot. Continue?"
  - "Yes, edit and reload"
  - "Show me the diff first"
  - "Cancel"
```

For T3, refuse first, then ask if the user wants to override:

> That's a T3 action — I won't push to origin without your direct
> per-push OK in this chat. Do you want to authorize THIS push?
> ("yes push" or "no, keep local")

---

## 11. Live trading safety + the master gate

### The master gate — `HELIUS_MAINNET_URL`

`HELIUS_MAINNET_URL` is the **single env var** that gates the entire
live trading layer. Without it set, every live endpoint returns 503
and no keypair is ever used to sign a transaction. This is by
design — the absence of the env var IS the safety net.

If the user ever wants to fully disable live trading without
uninstalling, they just unset the env var. No live code runs.

### The 5 safety layers

```
1. Per-tick 240s budget in paper-trade.py  → bounds stalls
2. pm2 max_restarts: 9999                  → supervisor never gives up
3. HTTP-based meta-watchdog                → detects outages independent of pm2 PATH
4. Scheduled health-check                  → Windows toast on any failed check
5. EMERGENCY-STOP runbook                  → 4-level escalation ladder
```

### Hard rules

These apply regardless of scope or personality:

- **NEVER stop or restart the bot server while the live bot has an
  open position**, unless the user has explicitly accepted the risk
  in writing in this chat. Reason: pm2 reloads interrupt the live
  trade-monitoring loop. A trade signal arriving during the reload
  window can be missed.
- **NEVER push to a git remote by default.** The repo can contain
  confidential trading data; treat it as local-only unless the user
  explicitly enables remote push.
- **NEVER echo a private key, seed phrase, or API key in chat
  output, even if the user pastes one in.** Acknowledge receipt
  without echoing.
- **NEVER push wallet files to a remote.** Wallet files are
  gitignored by default; if you see one staged for commit, stop
  and warn.
- **Real money moves require explicit user OK.** A live swap, a
  live position open or close, a wallet drain — every one of these
  needs a clear go from the user in chat, not an inferred intent.

### `/debug/health` first — catching silent failures

Before debugging "system not doing the thing," **always** hit the
single-curl health endpoint first:

```bash
curl localhost:8787/debug/health | jq
```

`ok: false` plus the `issues` array tells you what's degraded.
Common patterns:

| Issue pattern | What it means |
|---|---|
| `price-feed:<REGION>:degraded` | Price oracle dropped that region from routing |
| `bot:<name>:stalled` | Bot has 30+ decideCalls, zero intents, zero aborts — running cleanly but predicate never fires |
| `bot:<name>:halted:<reason>` | Daily guard tripped (loss cap or trade cap). Look at `/debug/bot-stats` |

When you find a NEW class of silent failure that `/debug/health`
doesn't catch, ADD a signal to the endpoint in the same PR as the
fix. The cost of one extra `issues.push(...)` is far smaller than
the next session spent re-discovering the same blind spot.

---

## 12. The pm2 fleet

Two long-running processes form the Stratos fleet:

| Process | Role |
|---|---|
| `bear-watch-server-stratos` | Node + tsx. Serves the dashboard on port 8787. Hosts the live bot runner + the swap router (Meteora/Orca/Jupiter). Exposes `/health` + `/debug/health`. |
| `paper-trade-bot-stratos` | Python paper trader. 60s tick loop, 240s budget per tick. Runs 11+ paper strategies. Reads `bear-scout/runners/strategy-registry.json`. |

### Starting the fleet

```bash
pm2 start bear-watch/pm2.config.cjs
pm2 save                              # auto-resurrect after reboot
```

`pm2.config.cjs` sets:
- `name: "bear-watch-server-stratos"` and `name: "paper-trade-bot-stratos"`
- `max_restarts: 9999` — supervisor never gives up
- Env vars: `PORT=8787`, `STRATOS_LAB_DIR`, `STRATOS_BOTS_DIR`,
  `STRATOS_CONFIG_DIR`, `PM2_HOME` (all pointing inside the repo)

### Targeting the right process — EXACT NAME ONLY

When a script needs to restart "the server," the target is **always**
`bear-watch-server-stratos`. Never a prefix match. Never a "if it has
bear-watch in the name" loop.

If the user maintains a sibling install (like `pbxtra-bear-den`) on
the same machine, prefix-matching would catch their processes too.
The exact `-stratos` suffix is the safety boundary.

Same applies to `paper-trade-bot-stratos` — never just
`paper-trade-bot`.

### Hands-off cross-install

You may run `pm2 list` (read-only) to verify state. Seeing other
named processes (e.g. `*-pbxtra` versions) is expected if the user
has a sibling install. **You may NOT** `pm2 restart`, `pm2 stop`,
`pm2 delete`, `pm2 reload`, or `pm2 reset` any process that isn't
exact-name-matched `-stratos`.

If the user has a per-machine iron-rule file at `_context/CLAUDE.md`,
read it on first session — it'll have the per-machine specifics
(sibling install paths, identifiers to never touch, etc.).

---

## 13. Scheduled tasks (Windows)

The Windows install registers **6 STRATOS-* scheduled tasks** via
`bear-watch/register-scheduled-tasks.ps1` at `/rl LIMITED` (standard
user privileges — no admin elevation).

| Task | Schedule | What it does |
|---|---|---|
| `STRATOS-HealthCheck` | Every 5 min | Runs the health-check; fires Windows toast on failure |
| `STRATOS-WeatherPull` | Every hour | Pulls fresh PM2.5 from PurpleAir + AirNow |
| `STRATOS-DailyDigest` | 6 AM EDT | Composes daily summary of P&L, alerts, achievements |
| `STRATOS-StateBackup` | 3 AM EDT | Snapshots `runtime/` to backup location |
| `STRATOS-CodebaseBackup` | Sundays 3:30 AM EDT | Full codebase backup |
| `STRATOS-MetaWatchdog` | Every 5 min | HTTP-based outage detection (works even if pm2 PATH breaks) |

### Registering them

```powershell
# install.ps1 does this automatically. For manual re-registration,
# use the cmd /c wrapper form (avoids the "-ExecutionPolicy Bypass"
# keyword that trips Claude Desktop's auto-mode classifier).
cmd /c "powershell -NoProfile -File bear-watch\register-scheduled-tasks.ps1"
```

The script is idempotent — safe to re-run.

### Cross-install boundary

If the user has a sibling `pbxtra-bear-den` install, that install
registers its own `PBXTRA-*` scheduled tasks. You do NOT touch those.
Same iron rule applies as for the pm2 processes — exact-name only,
and `STRATOS-*` is the only prefix you act on.

### Linux / macOS equivalent

The Unix `install.sh` does NOT register cron jobs by default. The pm2
fleet handles the always-on workload. If the user wants the digest
backup + watchdog parity on Mac/Linux, document the manual cron
entries as a follow-up — don't auto-register without explicit user
OK.

---

## 14. The three-layer architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1 — FRAMEWORK (ships in github, identical for everyone)  │
│                                                                 │
│  Everything OUTSIDE _context/ and runtime/. The product.        │
│  Edits here = framework releases. No user-specific paths, no    │
│  references to maintainer-specific sibling projects, ever.      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  LAYER 2 — CONTEXT (per-user adaptive memory, gitignored)       │
│                                                                 │
│  All of _context/. Each user starts with empty Layer 2;         │
│  Claude bootstraps on first session. Never ships publicly.      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  LAYER 3 — RUNTIME (operational data, gitignored)               │
│                                                                 │
│  All of runtime/. Server writes here, Claude reads. Each user   │
│  has their own.                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### The framework boundary test

**"If it's outside `_context/` and outside `runtime/`, it ships."**

That's the entire rule. When you're editing anything outside those
two trees, you're cutting a framework release that the next user
will pull. When you're editing inside them, you're persisting state
for THIS user only.

### What lives where

| Path | Layer | Edit policy |
|---|---|---|
| `README.md`, `README.ai.md`, `CLAUDE.md`, `ROADMAP.md`, `ARCHITECTURE.md`, `INSTALL.md` | L1 | Framework — edit only as releases |
| `.claude/`, `themes/`, `bots/`, `bear-watch/`, `bear-scout/`, `scripts/`, `packages/`, `src/`, `tools/`, `docs/`, `profiles/`, `LICENSE`, `package.json`, `pyproject.toml` | L1 | Framework — edit only as releases |
| `_context/CLAUDE.md` | L2 | Per-machine notes; OPTIONAL — used for iron-rule sibling-isolation |
| `_context/MANIFEST.md` | L2 | High-level scope index |
| `_context/<scope>/MANIFEST.md` | L2 | Per-scope definition |
| `_context/<scope>/STATUS.md` | L2 | Per-scope snapshot — OVERWRITE on change |
| `_context/<scope>/journal/<YYYY-MM-DD>.md` | L2 | Per-scope append-only journal |
| `runtime/lab/user-profile.json` | L3 | Personality/theme/tech-level. Use API endpoints — direct writes desync the server's in-memory copy |
| `runtime/lab/achievements.json` | L3 | Both achievement tracks |
| `runtime/lab/events.jsonl` | L3 | Append-only event log — server is the only writer |
| `runtime/lab/alerts.jsonl` | L3 | Append-only alerts log — server is the only writer |
| `runtime/bots/local.env` | L3 | `BOT_API_TOKEN`, `BOT_MASTER_KEY`, `BOT_HD_MNEMONIC` — chmod 600 |
| `runtime/bots/wallets/` | L3 | Encrypted wallet keypairs — never write directly |
| `runtime/pm2/` | L3 | pm2 daemon home |
| `.env` (repo root) | L1-adjacent | `HELIUS_MAINNET_URL` + user secrets — chmod 600, gitignored |

### Files Claude must NEVER write directly

| Path | Why |
|---|---|
| `runtime/lab/user-profile.json` | Use the profile API endpoints. Direct writes desync the server's in-memory copy. |
| `runtime/lab/wallets/*` | Wallets contain private keys. Even a comment-only edit risks corrupting the keypair format. |
| `runtime/lab/events.jsonl` | Append-only event log — the server is the only writer. |
| `runtime/lab/alerts.jsonl` | Same. |

Reads from any of these are fine. The rule is one-way for Claude:
read, don't write.

### Bootstrapping empty Layer 2 (first run)

A fresh clone has empty `_context/`. On the first session, you bring
it up. See [Section 16](#16-journaling-discipline) for the bootstrap
steps and the journaling discipline that follows.

---

## 15. Session-start protocol (post-install)

Before the first user-facing reply in any session AFTER install,
do these checks in order:

### 1. Conditional reads (only what exists, only when stale)

For each production scope (`bear-watch`, `bear-scout`, `bear-den`):

- If `_context/<scope>/STATUS.md` exists → read it (small, ~50 lines).
- If `_context/<scope>/journal/<YYYY-MM-DD>.md` exists for today →
  tail the last ~50 lines. If today's file doesn't exist, tail
  yesterday's instead.
- If `_context/<scope>/MANIFEST.md` exists → read once per session.

For runtime:

- If `runtime/lab/user-profile.json` exists → read it. Apply
  `personality_id`, `theme_id`, `tech_level`, `communication_style`,
  `consent_level`, `autonomy_level` to every subsequent response.

### 2. mtime check before re-reading

If you've already read a file this session and need to re-check
mid-session:

1. Stat the file first (50 input tokens).
2. If LastWriteTime is at or before your prior read → SKIP.
3. If newer → re-read using tail/offset, not the whole file.

Skipping a 10KB re-read on a stale mtime saves ~2500 tokens. The
check is a 50× ROI.

### 3. If any required file is missing → bootstrap

If `_context/` is empty or the active scope's STATUS doesn't exist
→ trigger Layer 2 bootstrap (Section 16). If
`runtime/lab/user-profile.json` doesn't exist → user hasn't
completed onboarding; suggest running the setup skill.

### 4. Check git status

If there are uncommitted files you didn't create, they're likely
from a previous session that didn't finish updating STATUS. Mention
them; don't silently work around them.

---

## 16. Journaling discipline

The journal is the only thing that survives between Claude sessions
besides the framework files themselves. A chat can compact, the
window can close, the user can switch chats — the journal carries
forward.

### Bootstrapping empty Layer 2 on first run

```bash
# Create the directory tree (default scope: bear-watch)
mkdir -p _context/bear-watch/journal
touch _context/bear-watch/journal/.gitkeep

# Write empty MANIFEST.md, STATUS.md, and the first journal entry
```

`_context/bear-watch/MANIFEST.md`:

```markdown
# bear-watch — operations, monitoring, deployment

Default starting scope. Owns ops, monitoring, deployment, daemon
health, watchdog tuning, scheduled tasks, infrastructure, audit
protocols.
```

`_context/bear-watch/STATUS.md`:

```markdown
# bear-watch — STATUS

Last updated: <ISO timestamp>
Current focus: <what you're working on>
Recent work: <what just landed>
```

`_context/bear-watch/journal/<today>.md`:

```markdown
## HH:MM — Claude bootstrapped Layer 2

- Detected empty `_context/` on session start; created the bear-watch scope.
- Wrote MANIFEST.md, STATUS.md, journal/.gitkeep.
- Decision: start with bear-watch only; user can add bear-scout / bear-den later.
```

### Cadence — be AGGRESSIVE, not session-end-only

Lean toward logging MORE rather than less. Don't wait for a natural
session end that might never come.

**Log at these meaningful breakpoints — do it now when one happens,
not at session end:**

| Trigger | Why |
|---|---|
| A commit lands | Capture what + why + commit hash |
| A decision is made (especially overriding a default behavior or safety rule) | Future sessions need to know WHY |
| A surprise or discovery | Prevent re-discovery; prevent future confusion |
| A dead end was hit | Prevent future sessions from re-attempting it |
| A major topic shift in the conversation | Mark the boundary |
| You finished a chunk the user would describe as one thing | Logical unit |
| User explicitly says "log that" or "journal that" | Always |

**Do NOT log every message.** Skip:

- Quick yes/no replies
- Clarifying questions
- Simple lookups ("show me X")
- "Actually nvm" reversals
- Filler ("ok", "thanks", "got it")

**Target cadence on an active day:** ~5-15 entries per active day,
each capturing one meaningful chunk. NOT 100+ tiny entries.

**When in doubt, log it.** Over-capture beats under-capture. The
user can ignore a journal entry they don't care about — they can't
recover a decision that was never written down.

### Entry format

```markdown
## HH:MM — short topic (under 10 words)
- what was done (action verbs: "added", "fixed", "decided", "reverted", "investigated")
- what was learned / decided / surprised by (the WHY — most important part)
- commit hash(es) if applicable
- any unresolved threads (what's still open)
```

The journal is APPEND-ONLY. Never delete past entries. Past mistakes
are valuable — they prevent future sessions from making them again.

### STATUS vs journal — keep them separate

- **STATUS.md** is OVERWRITE. It says "what's true right now." When
  state changes, overwrite the relevant section. STATUS shouldn't
  accumulate; it should always be a snapshot.
- **journal/** is APPEND. It says "what happened ever." Every
  meaningful change adds a new entry. Journal never gets pruned.

Together: STATUS tells the next session where you left off; journal
tells them how you got there.

---

## 17. The default scopes

The framework ships three scopes by convention. The user is not
required to use all three; most users start with bear-watch.

| Scope | Domain |
|---|---|
| **bear-watch** | Operations, monitoring, deployment, uptime, daemon health, watchdog tuning, scheduled tasks, infrastructure, audit protocols. Default starting scope. |
| **bear-scout** | Research, strategy design, signal investigation, backtesting, wallet decoding, model fitting, predictor accuracy. |
| **bear-den** | UI, dashboard rendering, visual polish, UX, design system, UI-review tooling. |

Each scope is meant to host its own parallel Claude chat with its
own MANIFEST + STATUS + journal. Three terminal windows, three
chats, one shared project state via the journals.

### Scope is organization, NOT gatekeeping

The most important rule about scopes:

> **Any chat can fix any thing.** If you're a bear-den chat and you
> notice a bug in a bear-watch operational script, fix it. The
> scope tells you what the user usually asks you to do; it does not
> stop you from doing the right thing when you see something broken.

What COUNTS as a real reason to hand off:

- Safety rule blocks you (e.g. consent required for live-bot edits
  with an open position)
- You genuinely lack context another chat has (after reading their
  journal and still can't tell)
- User explicitly wants the work parallelized

What does NOT count:

- "This looks like UI work and I'm bear-watch" — fix it
- "This needs a backend endpoint I don't have" — build the endpoint
- "Investigating this is messy" — that's the work

### Adding new scopes

User can add custom scopes by creating
`_context/<scope>/MANIFEST.md` + `STATUS.md` + `journal/`. The
framework doesn't limit you to three.

---

## 18. Operational wisdom

A handful of patterns earned by past bugs. These apply across all
scopes.

### Reuse before you build

When adding a feature, **first check whether the repo already has
the pieces you need** and wire them together — don't write a
parallel implementation.

Concrete check before creating a new fetcher, decoder, backtest
harness, dashboard, or pipeline: grep the source tree for the
existing one. If a parallel build is genuinely warranted (different
invariants, incompatible types), say so explicitly and get a yes
from the user — don't quietly fork.

### Conflate at your peril — pricing source vs. quote-for-fill

A paper bot needs two things from a price oracle:

- (a) the current spot price for its rolling-window feature math
- (b) a quote it can simulate filling against

They look the same on the surface — both are "a number from the
price oracle" — but they have different failure modes and must use
different endpoints:

- **Pricing**: the indexer's mid-price API. Returns a price as long
  as the oracle knows about the pool, even when the swap router
  won't route to it.
- **Fill simulation**: the swap-quote API. May return
  `TOKEN_NOT_TRADABLE` even for mints with live pools and recent
  fills.

If pricing and fill both flow through the swap-quote endpoint, an
unroutable region silently drops out of the feature pipeline →
rolling features fall back to zero → predicates can never fire →
bots hold every tick with zero abort counters. Fully silent failure.
Keep them separate.

### PR-only worktree flow for risky changes

When the user asks you to commit and merge a change that touches
the bot source tree, the flow is **always**:

1. Branch off `origin/main` in an **isolated worktree** so unrelated
   dirty files don't get dragged into the PR.
2. Copy the focused diff into the clean worktree, commit with a
   tight message scoped to the one change.
3. Push to the user's own remote. Do NOT push to any other org's
   fork unless the user explicitly says so.
4. Open the PR, then squash-merge with `--delete-branch`.
5. After merge, remove the worktree and pull `origin/main` back
   into the user's primary worktree.

Treat `main` as if it were protected even if branch-protection
settings don't currently enforce it — never `git push origin main`
directly, never force-push, never bypass admin checks.

### When in doubt, read the test file before editing the source

If a function has tests, read the tests first. They tell you the
contract the function is expected to honor. Editing source without
reading tests is how regressions ship.

### Offer the secret-scrub hook, don't force it

`tools/secret-scrub/` is a pre-commit hook that detects and scrubs
Solana keys, BIP39 mnemonics, and API tokens from staged files.
It's not installed by default. When a user is setting up the repo
or whenever private keys are in play, **offer** it — explain it's
a repo-local hook, not machine-wide — then install on explicit yes.

If the hook ever reports it caught a private key, that key is
compromised. Tell the user to rotate it.

### Efficient reading patterns

Read tokens cost more than write tokens in aggregate because they
compound — re-reading the same growing journal across sessions adds
up. The discipline here is "read just the slice you need."

1. **First choice — `tail`** for ~5-10 most-recent entries:
   ```bash
   tail -50 _context/<scope>/journal/<YYYY-MM-DD>.md
   ```
2. **Second choice — Read with offset + limit**:
   ```
   Read with offset: (total_lines - 100), limit: 100
   ```
3. **Third choice — Grep first, Read second** for targeted lookups.
4. **Read the whole file ONLY when:** file is under 200 lines, OR
   you specifically need historical context for a reason you can
   name out loud.

---

## 19. After install — the handoff to the roadmap

Once Step 12 verifies all 7 health checks pass and the browser
opens at `http://localhost:8787`, **you are NOT done.** The
handoff is part of the install — not optional, not skippable.

**Why this is mandatory:** the user just installed something
complex. The dashboard at `localhost:8787` is unfamiliar UI. If
you stop at "dashboard is up" without orienting them, they're at
a wall of panels with no idea what they're looking at. The
handoff is the difference between "install succeeded" and "user
feels like they succeeded." Both have to land for the install to
count.

**Do NOT skip this step even if:**
- The install took a long time and you're tempted to wrap up
- The user seems impatient
- The handoff feels redundant because you already explained things
  during the install

The user always gets the handoff. Always.

### Verbalize the handoff (in the chosen personality voice)

> The dashboard is live at `http://localhost:8787`. You're at the
> first section of the roadmap, **Genesis** — that's the 14 tasks
> covering install + verify + first orientation. Most of those
> just got auto-completed during the setup we did together.
>
> The next section is **Pulse** (19 tasks) — watching the bot run
> for a few days to learn its rhythm before tweaking anything.
> When you're ready to move on, just say *"what's next on my
> roadmap?"* and I'll walk you through it.
>
> For right now: click around the dashboard. The System Health
> panel is on the left, paper trades on the right, and the help
> icon in the sidebar replays the tour any time. Welcome to PBX
> Stratos.

Adapt the wording to the personality. Crypto Bro: *"the dashboard
is live ser, you just unlocked the Genesis section, ngmi if you
don't click around for a few minutes."* Drill Sergeant: *"DASHBOARD
ONLINE. GENESIS SECTION COMPLETE. PROCEED TO PULSE WHEN READY.
DISMISSED."* Etc.

### Journal the install completion

Append to `_context/bear-watch/journal/<today>.md`:

```markdown
## HH:MM — install complete

- 13-step setup wizard finished cleanly.
- pm2 fleet online: bear-watch-server-stratos + paper-trade-bot-stratos.
- Dashboard at http://localhost:8787 — /health returns ok.
- 6 STRATOS-* scheduled tasks registered (Windows).
- User profile: personality_id=<X>, theme_id=<Y>, goal=<Z>,
  tech_level=<W>, communication_style=<...>, consent_level=<...>,
  autonomy_level=<...>.
- Live trading: enabled / not enabled (HELIUS_MAINNET_URL set or not).
- Handed off to roadmap Section 2 (Pulse).
```

### Common follow-up requests

The user may say one of these right after install:

| User says | What you do |
|---|---|
| "what's next on my roadmap" | Read ROADMAP.md Section 2 + walk through each task |
| "show me my achievement progress" | Read `runtime/lab/achievements.json` + present both tracks |
| "the bot looks idle, is something wrong?" | Hit `/debug/health` first, then walk through diagnostics |
| "let me see what the strategies are doing" | `python bear-scout/runners/paper-trade.py --list-strategies` + show paper trade view |
| "switch personality to <X>" | Invoke `pbx-set-personality` skill |
| "switch theme to <Y>" | Invoke `pbx-set-theme` skill |
| "the dashboard isn't loading" / "something's wrong" | Invoke `pbx-recover-bot` skill |
| "decode this wallet <addr>" | Invoke `wallet-decoder` skill |

---

## 20. Skill trigger phrases (ongoing operations)

After install, the user interacts with several skills via trigger
phrases. Each skill has its own `SKILL.md` in `.claude/skills/`.

All skills are PBX-Stratos-specific and only fire when the working
directory contains the canonical PBX-Stratos markers
(`install.bat`, `CLAUDE.md`, `bear-watch/`, `.claude/skills/`).
None of them clone or download — the user clones first.

| Skill | Canonical trigger | What it does |
|---|---|---|
| `pbx-stratos-setup` | "Verify if PBX Stratos Repo is safe and start the onboarding process in .README", "set up PBX Stratos", "install PBX Stratos", "onboard me to PBX Stratos" | The post-clone install wizard (the flow this runbook documents) |
| `pbx-personality-quiz` | "run the personality quiz", "retake the personality quiz", "recalibrate my Claude" | Re-runs the 5-question intake from the install wizard and writes updated answers to `runtime/lab/user-profile.json` |
| `pbx-set-personality` | "switch PBX Stratos personality to `<id>`", "try the `<id>` personality" | Updates `personality_id` in the profile without re-running the quiz |
| `pbx-set-theme` | "switch PBX Stratos theme to `<id>`", "change my PBX Stratos dashboard theme" | Copies `themes/<id>.css` to `bots/src/server/active-theme.css` and updates `theme_id` |
| `pbx-recover-bot` | "the PBX Stratos bot is broken", "PBX Stratos dashboard isn't loading", "I got a STRATOS alert" | Standard PBX-Stratos diagnostic runbook: pm2 status → `/debug/health` → recent alerts → recent commits → pm2 logs → prescribed fix |
| `wallet-decoder` | "decode this PBX wallet `<pubkey>`", "run the PBX Stratos wallet decoder on `<pubkey>`" | Drives the lab decoder pipeline against a Solana pubkey |

When the user says a trigger phrase, invoke the skill instead of
improvising. The skill machinery ensures consistency across users.

---

## 21. Things you must NEVER do

A consolidated list of the hard rules. If you find yourself about
to do any of these, STOP and ask the user first.

### Secrets

- **Never echo a private key, seed phrase, mnemonic, or API key in
  chat output** — even if the user pastes one in. Acknowledge
  receipt without echoing.
- **Never write secrets to journal entries or STATUS files** —
  those can be journaled across sessions and accidentally surfaced.
- **Never copy `.env` contents to a STATUS dump or a debug log.**

### Pushing + remote

- **Never push to a git remote without explicit per-push consent
  from the user in this chat.** There is no standing permission;
  every push is T3.
- **Never force-push to `main` / `master` / `production`** under
  any circumstances.
- **Never use `--no-verify`** to bypass pre-commit hooks unless the
  user explicitly asks for it. If a hook fails, diagnose the
  underlying issue.

### Live bot

- **Never restart, stop, reload, or delete pm2 processes while the
  live bot has an open position**, unless the user explicitly
  accepts the risk in this chat.
- **Never modify live bot positions directly** via API or DB. Use
  the documented endpoints.
- **Never deploy a paper strategy to live mode** without the user
  having read the disclaimer + acknowledged in this chat.

### Wallet files

- **Never delete wallets or wallet backup files** without explicit
  user OK. These are recovery surface — once gone, the user's
  encrypted keypair is unrecoverable.
- **Never edit `runtime/bots/wallets/*` directly** — even
  comment-only edits risk corrupting the format.
- **Never write directly to `runtime/lab/user-profile.json`** — use
  the profile API endpoints. Direct writes desync the server's
  in-memory copy.

### Cross-install (read `_context/CLAUDE.md` if it exists)

If the user has a sibling install on the same machine (e.g.
`pbxtra-bear-den`), there will be a per-machine notes file at
`_context/CLAUDE.md`. Read it on first session. It will have:

- Iron-rule list of paths / processes / identifiers / env vars to
  NEVER touch
- The exact-name pm2 targeting requirement
- Scheduled-task isolation rules

The default rule, even without a `_context/CLAUDE.md`:

- Never act on a pm2 process unless its name exactly matches
  `*-stratos`
- Never modify a scheduled task unless it starts with `STRATOS-`
- Never read / write under any sibling-install path

### Bypassing safety

- **Never claim "this code is safe" in a way that implies
  guaranteed safety.** Stick to observed facts ("I read the
  install scripts and didn't see X, Y, Z patterns") and let the
  user make the call.
- **Never clone or download a repo on the user's behalf.** This
  skill is post-clone only — the user is responsible for the clone
  (`git clone` or downloading the ZIP from GitHub). If the user
  pastes a URL, tell them to clone first and re-ask from inside
  the cloned folder.
- **Never skip the audit if the user asked for one.** If they
  explicitly asked "is this safe?" or "audit the code first,"
  do it — at your discretion, reporting observations not
  certifications.

---

## 22. Where to read next

Once you've absorbed this file, your daily ops reference is
[`CLAUDE.md`](CLAUDE.md). Specific deep-dives:

| File | When to read |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Daily ops manual. Auto-loaded by every session in this repo. Has the session-start protocol, journaling discipline, T0-T3 in more detail, operational wisdom, and the canonical doc-map. |
| [`PROMPT.md`](PROMPT.md) | Preset prompts the user can paste to invoke common flows. Reference when the user asks "what can I tell Claude to do?" |
| [`.claude/skills/pbx-stratos-setup/SKILL.md`](.claude/skills/pbx-stratos-setup/SKILL.md) | The functional install skill. Loaded automatically when the trigger phrase fires. Has the 13-step flow at full depth — every AskUserQuestion option, every verification command, every personality-voiced filler. |
| [`ROADMAP.md`](ROADMAP.md) | The 7-section / 130-task user journey. Source of truth for what roadmap-track achievements correspond to. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The three principles every contribution follows + where each kind of file lives + the layered safety stack + the three-layer model. |
| [`INSTALL.md`](INSTALL.md) | Manual install path (skipping Claude). Mostly for users who want to understand what the wizard does under the hood. |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Full security model: key handling, network policy, encryption details. Read before live trading. |
| [`bear-watch/EMERGENCY-STOP.md`](bear-watch/EMERGENCY-STOP.md) | 4-level escalation ladder. Read once during setup; reach for it when something is on fire. |
| [`bear-watch/audit-brief.md`](bear-watch/audit-brief.md), [`bear-watch/audit-professional.md`](bear-watch/audit-professional.md) | Audit protocols for handing off codebase reviews to other agents. |
| [`.claude/UNIVERSAL-CORE.md`](.claude/UNIVERSAL-CORE.md) | The behavior rules every Claude session in this project follows (under your chosen personality). Mission, voice, Recap/Summary/Next-Steps response shape, AskUserQuestion discipline. |
| [`.claude/personalities/<id>.md`](.claude/personalities/) | Active personality's voice + vocabulary + progress-filler language |
| [`.claude/achievements/<id>.md`](.claude/achievements/) | Active personality's achievement-celebration text (1:1 with ROADMAP task IDs) |
| `bear-scout/README.md` | Decoder framework — what each runner does, what outputs land where |
| `bots/README.md` | Live bot fleet — `pbx-bots` CLI, multi-bot orchestration, stop/drain/sweep |
| `achievements/definitions.json` | Event-driven achievement spec (auto-tracked) |

---

## 23. When in doubt

The five questions to ask yourself when you don't know what to do:

1. **Have I read this scope's STATUS + today's journal?** Most
   "what is happening" questions are answered there.
2. **Is this a T1/T2/T3 action?** If yes, ask the user before
   doing it.
3. **Is there an existing skill or doc for this?** Check
   `.claude/skills/` and the doc map above before improvising.
4. **What would the next session need to know about this
   decision?** Write a journal entry now.
5. **Could a fresh user, on a fresh machine, following this
   document and nothing else, get a working install with their
   context bootstrapped?** If the answer is "no, because of X,"
   then X belongs in this file — flag the gap to the user so we
   can add it.

The user is trusting you to keep this install consistent across
every fresh machine. The way you do that is by following this
runbook, journaling what you decide, and pausing for consent at
every risk boundary.

Welcome to PBX Stratos. Now go set it up.
