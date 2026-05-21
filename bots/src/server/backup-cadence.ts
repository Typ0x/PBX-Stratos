/**
 * Pure cadence logic for the recovery-phrase backup reminder.
 *
 * The modal nag follows an escalating, risk-informed cadence instead of
 * popping on every dashboard load:
 *   - never snoozed            -> prompt
 *   - 1st "remind me later"    -> snooze 24h
 *   - 2nd+ "remind me later"   -> snooze 7d
 *   - a newly *funded* (live) bot appears -> prompt now, regardless of snooze
 *   - phrase verified          -> never prompt again
 */

export const SNOOZE_FIRST_MS = 24 * 60 * 60 * 1000;      // 24 hours
export const SNOOZE_REPEAT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface BackupCadenceState {
  verifiedAt: string | null;
  snoozedUntil: string | null;
  dismissCount: number;
  liveBotsAtLastPrompt: number;
}

/** How long to snooze after the Nth "remind me later" click. The first
 *  dismissal buys 24h; every dismissal after that buys a week. */
export function backupSnoozeMs(dismissCount: number): number {
  return dismissCount <= 1 ? SNOOZE_FIRST_MS : SNOOZE_REPEAT_MS;
}

/** Whether the backup modal should auto-prompt right now. True when the
 *  phrase is unverified AND either the snooze has elapsed (or was never
 *  set) OR a new live bot has appeared since the last prompt. */
export function shouldPromptBackup(
  state: BackupCadenceState,
  liveBotCount: number,
  nowMs: number,
): boolean {
  if (state.verifiedAt) return false;
  const snoozedUntilMs = state.snoozedUntil ? Date.parse(state.snoozedUntil) : 0;
  if (Number.isNaN(snoozedUntilMs) || nowMs >= snoozedUntilMs) return true;
  return liveBotCount > (state.liveBotsAtLastPrompt || 0);
}
