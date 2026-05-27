/**
 * armProcessTimeout — bounds how long a workflow subprocess may run.
 *
 * Both workflow subprocess wrappers (claude_decode.ts and
 * agentic_decode.ts) resolve their Promise only on the child's `close`
 * or `error` event. If the child never exits — a stalled `claude` CLI,
 * a wedged Python decoder — the Promise hangs forever and the whole
 * orchestrator stalls with it. This arms a kill-timer so a hung child
 * is forcibly terminated and the wrapper resolves with a timeout error
 * instead of waiting indefinitely.
 */
import type { ChildProcess } from 'node:child_process';

/** Grace period between SIGTERM and the SIGKILL escalation. */
const SIGKILL_GRACE_MS = 2000;

/**
 * Arm a kill-timer on a spawned child process. If the process has not
 * exited within `timeoutMs`, it is sent SIGTERM (escalating to SIGKILL
 * after a short grace period) and `onTimeout` fires.
 *
 * Returns a `clear()` function — call it from the process's own
 * `close`/`error` handler so the timer is cancelled when the process
 * exits normally.
 */
export function armProcessTimeout(
  proc: ChildProcess,
  timeoutMs: number,
  onTimeout: () => void,
): () => void {
  let fired = false;
  const killTimer = setTimeout(() => {
    fired = true;
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    // Escalate if SIGTERM is ignored (e.g. a child trapping signals).
    const killTimer2 = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }, SIGKILL_GRACE_MS);
    killTimer2.unref?.();
    onTimeout();
  }, timeoutMs);
  killTimer.unref?.();
  return () => { if (!fired) clearTimeout(killTimer); };
}
