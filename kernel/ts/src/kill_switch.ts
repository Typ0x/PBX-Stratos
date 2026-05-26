/**
 * V1 kill switch: in-memory flag flipped by SIGUSR1 (or any process that
 * imports and calls `trip()`). Spec calls for a DB-backed flag with
 * double-check-before-send semantics — that lands in v2 when we introduce
 * Postgres. For dry-run iteration, the in-memory version is enough to prove
 * the "stop before submitting" codepath.
 *
 * Usage in runner:
 *   if (isTripped()) { log('kill switch tripped, skipping trade'); continue; }
 */
let tripped = false;

export function trip(reason: string): void {
  if (!tripped) {
    tripped = true;
    console.warn(`[kill_switch] TRIPPED: ${reason}`);
  }
}

export function isTripped(): boolean {
  return tripped;
}

export function reset(): void {
  tripped = false;
}

// SIGUSR1 trips the switch (safer than SIGTERM — caller can pick a signal
// that the process doesn't already handle). Wire once at startup.
let installed = false;
export function installSignalHandler(): void {
  if (installed) return;
  installed = true;
  process.on('SIGUSR1', () => trip('SIGUSR1 received'));
}
