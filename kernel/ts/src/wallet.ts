import { Keypair } from '@solana/web3.js';

/**
 * Load a Solana Keypair from:
 *   - `BOT_KEYPAIR_JSON` env var (JSON array of 64 bytes), or
 *   - a freshly generated keypair if not set (dry-run only — throws if used
 *     to execute a live trade).
 *
 * For v1 we accept the JSON-array format because that's what `solana-keygen`
 * emits and what the market-maker / parity-keeper already use. Turnkey wiring
 * is a v2 concern per docs/bots/v1-spec.md.
 */
export function loadBotKeypair(opts: { allowEphemeral?: boolean } = {}): Keypair {
  const raw = process.env.BOT_KEYPAIR_JSON;
  if (raw) {
    try {
      const bytes = JSON.parse(raw);
      if (!Array.isArray(bytes) || bytes.length !== 64) {
        throw new Error('BOT_KEYPAIR_JSON must be a 64-byte JSON array');
      }
      return Keypair.fromSecretKey(Uint8Array.from(bytes));
    } catch (err) {
      throw new Error(`[wallet] failed to parse BOT_KEYPAIR_JSON: ${(err as Error).message}`);
    }
  }

  if (!opts.allowEphemeral) {
    throw new Error(
      '[wallet] BOT_KEYPAIR_JSON not set. Pass { allowEphemeral: true } for dry-run only.',
    );
  }

  const kp = Keypair.generate();
  console.warn(
    `[wallet] using ephemeral keypair ${kp.publicKey.toBase58()} — DRY RUN ONLY`,
  );
  return kp;
}
