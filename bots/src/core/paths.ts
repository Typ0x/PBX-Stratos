/**
 * Stratos runtime path resolution.
 *
 * Centralized helper so every module reads the same paths from the
 * same env vars. Each path looks at the appropriate STRATOS_* env
 * var first, then falls back to the legacy ~/.pbx-lab / ~/.pbx-bots
 * / ~/.config/pbx-bots layout for backward compatibility.
 *
 * After the self-contain migration the production paths point at
 * `<repo-root>/runtime/{lab,bots,config}/` so the install is fully
 * self-contained — but the unsuffixed fallback paths stay so users
 * who installed before the migration aren't broken.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the lab keeps user profile, achievements, events, alerts,
 *  paper-trade history. Was `~/.pbx-lab/`. */
export function resolveLabHome(): string {
  return process.env.STRATOS_LAB_HOME ?? join(homedir(), '.pbx-lab');
}

/** Where the live bot fleet keeps encrypted wallet `.enc` files
 *  + the autogen-on-first-boot `local.env`. Was `~/.pbx-bots/`. */
export function resolveBotsDataDir(): string {
  return process.env.STRATOS_BOTS_DATA_DIR ?? join(homedir(), '.pbx-bots');
}

/** Where pbx-bots CLI keeps its remote-add config (tokens, URLs).
 *  Was `~/.config/pbx-bots/`. */
export function resolveBotsConfigHome(): string {
  return process.env.STRATOS_BOTS_HOME ?? join(homedir(), '.config', 'pbx-bots');
}

export const LAB_HOME         = resolveLabHome();
export const BOTS_DATA_DIR    = resolveBotsDataDir();
export const BOTS_CONFIG_HOME = resolveBotsConfigHome();
