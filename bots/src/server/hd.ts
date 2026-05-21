import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';

/**
 * BIP44/BIP39 HD derivation for Solana wallets. One 24-word mnemonic
 * roots the whole bot fleet: the funder lives at index 0, each bot
 * wallet gets the next monotonic index.
 *
 * Path convention: m/44'/501'/<index>'/0' — matches `solana-keygen
 * recover` so a user with the mnemonic can reconstruct any wallet
 * using the standard Solana CLI:
 *
 *   solana-keygen recover -o restored.json "prompt:?key=<index>'/0'"
 *
 * This means losing the entire data dir is recoverable from the
 * mnemonic alone — the encrypted keypair files on disk become a cache
 * of derived material, not the source of truth.
 */

export const FUNDER_DERIVATION_INDEX = 0;

/** Generate a fresh 24-word (256-bit entropy) BIP39 mnemonic. */
export function generateNewMnemonic(): string {
  return generateMnemonic(256);
}

/** Validate a mnemonic against the BIP39 English wordlist. Does NOT
 *  validate the checksum is correct — use `validateMnemonic` for that. */
export function isWellFormedMnemonic(s: string): boolean {
  return validateMnemonic(s);
}

/** Derive a Solana Keypair at index `i` under the standard derivation
 *  path. Index 0 is the funder; indices 1..N are bot wallets. */
export function deriveKeypair(mnemonic: string, index: number): Keypair {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`derivation index must be a non-negative integer, got ${index}`);
  }
  if (!validateMnemonic(mnemonic)) {
    throw new Error('invalid BIP39 mnemonic (failed checksum or wordlist)');
  }
  // mnemonicToSeedSync returns 64 bytes; derivePath consumes its hex form.
  const seed = mnemonicToSeedSync(mnemonic);
  const path = `m/44'/501'/${index}'/0'`;
  const { key } = derivePath(path, seed.toString('hex'));
  // key is 32 bytes — the ed25519 seed for Solana's Keypair.
  return Keypair.fromSeed(key);
}
