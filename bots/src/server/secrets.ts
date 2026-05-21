import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * AES-256-GCM at-rest encryption for keypair JSON files. The master key
 * is derived from BOT_MASTER_KEY (env) via scrypt.
 *
 * Two resolution paths set process.env.BOT_MASTER_KEY before this module
 * is exercised (see loadOrGenerateLocalSecrets in server/index.ts):
 *   - Production: operator pins BOT_MASTER_KEY in the Render dashboard.
 *   - Local autogen: server boot generates a key, persists it to
 *     <BOTS_DATA_DIR>/local.env at mode 0600, and re-exports it into
 *     process.env. Backing up that file is critical — losing it orphans
 *     every encrypted wallet on disk.
 *
 * Format on disk (single line, base64):
 *   <salt:16> <iv:12> <ciphertext> <authtag:16>   (concatenated, raw bytes, then base64)
 *
 * Without BOT_MASTER_KEY, throws on every write. There is no plaintext
 * fallback — losing the key means losing access to the funds in any
 * encrypted wallet, which is the same security model as a hardware wallet.
 */

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function deriveKey(masterKey: string, salt: Buffer): Buffer {
  // scrypt is deliberately slow — fine here because we encrypt rarely
  // (on bot creation) and decrypt once at process startup per bot.
  return scryptSync(masterKey, salt, KEY_LEN);
}

function masterKey(): string {
  const k = process.env.BOT_MASTER_KEY;
  if (!k || k.length < 32) {
    throw new Error(
      '[secrets] BOT_MASTER_KEY env not set or too short (min 32 chars). ' +
        'Generate one via: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"',
    );
  }
  return k;
}

export function encryptToFile(path: string, plaintext: string): void {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(masterKey(), salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  mkdirSync(dirname(path), { recursive: true });
  const blob = Buffer.concat([salt, iv, ct, tag]).toString('base64');
  // Atomic write: tmp + rename. SIGKILL mid-write cannot leave a half-
  // written file at `path`. The rename(2) is atomic on POSIX.
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, blob);
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * Write a known plaintext encrypted under the current master key. Used at
 * boot to verify the key matches what was used to encrypt existing files.
 *
 * If the canary file is missing we write it (first-ever boot under a key).
 * If it exists we attempt to decrypt — failure means BOT_MASTER_KEY does
 * not match what previously encrypted data on this disk. Refuse to start
 * rather than silently re-encrypting orphaned ciphertext under a new key.
 */
const CANARY_PLAINTEXT = 'pbx-bots-canary-v1';

export function ensureMasterKeyCanary(canaryPath: string): void {
  if (!existsSync(canaryPath)) {
    encryptToFile(canaryPath, CANARY_PLAINTEXT);
    return;
  }
  try {
    const got = decryptFile(canaryPath);
    if (got !== CANARY_PLAINTEXT) {
      throw new Error(`canary plaintext mismatch (got '${got.slice(0, 20)}…')`);
    }
  } catch (err) {
    throw new Error(
      `[secrets] BOT_MASTER_KEY does not match the key that encrypted existing data ` +
        `at ${dirname(canaryPath)}. Refusing to start — losing the original key means ` +
        `losing access to every encrypted wallet here. (${(err as Error).message})`,
    );
  }
}

export function decryptFile(path: string): string {
  if (!existsSync(path)) throw new Error(`[secrets] file not found: ${path}`);
  const blob = Buffer.from(readFileSync(path, 'utf8'), 'base64');
  if (blob.length < SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error(`[secrets] ${path} is too small to be a valid encrypted blob`);
  }
  const salt = blob.subarray(0, SALT_LEN);
  const iv = blob.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(SALT_LEN + IV_LEN, blob.length - TAG_LEN);
  const key = deriveKey(masterKey(), salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}
