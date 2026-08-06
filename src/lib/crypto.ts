import bcrypt from 'bcryptjs';
import { nanoid, customAlphabet } from 'nanoid';
import { randomInt, randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto';

const txnRand = customAlphabet('0123456789ABCDEFGHJKLMNPQRSTUVWXYZ', 5);

/**
 * Generate a numeric PIN using the CSPRNG.
 *
 * Was Math.random(), which is seeded from a predictable source and is NOT
 * safe for anything guarding value. This PIN authorises debits against a
 * guest's bar credit, so an attacker able to predict the generator could
 * mint valid PINs for other wallets. randomInt() draws from the same
 * entropy pool as key generation.
 */
export function generatePin(length = 6): string {
  let pin = '';
  for (let i = 0; i < length; i++) pin += randomInt(0, 10);
  return pin;
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 10);
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}

// ─── Reversible PIN storage (admin reveal) ─────────────────────────────────
//
// The bcrypt hash above stays the ONLY thing redemption checks — that path is
// untouched. Alongside it we keep a separately-encrypted copy so an admin can
// re-read a PIN a guest has lost.
//
// THREAT MODEL — read before changing any of this:
// Encryption only helps if the key is not stored beside the ciphertext.
// INTERNAL_TOKEN_SECRET lives in the `config` table of the SAME SQLite file
// as `wallets`, so deriving the key from it would mean a stolen .db file
// yields both halves — no better than plaintext. Therefore the key MUST come
// from the environment. When WALLET_PIN_ENC_KEY is absent we deliberately
// REFUSE to encrypt (returning null) rather than silently falling back to a
// key that provides no protection: a wallet with no ciphertext is honest
// about being unrecoverable, whereas fake encryption is not.
//
// Scheme: AES-256-GCM, random 12-byte IV per PIN, auth tag verified on read.
// Format: v1.<iv>.<tag>.<ciphertext>   (all base64url)

const PIN_ENC_VERSION = 'v1';

/**
 * Resolve the 32-byte encryption key from the environment. Accepts either a
 * 64-char hex string or any passphrase (hashed to 32 bytes via SHA-256 so
 * operators can't accidentally supply a short key). Returns null when unset —
 * callers must treat that as "encryption unavailable", not as an error.
 */
function pinEncKey(): Buffer | null {
  const raw = (process.env.WALLET_PIN_ENC_KEY || '').trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  // Any other value is stretched to exactly 32 bytes. Not a KDF — this is a
  // convenience for operators pasting a long random string, not a defence
  // against a weak passphrase. Use a 64-char hex key in production.
  return createHash('sha256').update(raw).digest();
}

/** True when the deployment can store recoverable PINs. */
export function isPinEncryptionAvailable(): boolean {
  return pinEncKey() !== null;
}

/**
 * Encrypt a plaintext PIN for at-rest storage. Returns null when no key is
 * configured — the caller stores NULL and the admin UI reports the PIN as
 * unrecoverable for that wallet.
 */
export function encryptPin(pin: string): string | null {
  const key = pinEncKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(pin, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PIN_ENC_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt a stored PIN. Returns null on ANY failure — missing key, wrong key,
 * malformed payload, or a failed auth-tag check (which means the ciphertext
 * was tampered with). Never throws: a corrupted row must degrade to "cannot
 * show this PIN", not break the admin page.
 */
export function decryptPin(encoded: string | null | undefined): string | null {
  if (!encoded) return null;
  const key = pinEncKey();
  if (!key) return null;
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== PIN_ENC_VERSION) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ct = Buffer.from(parts[3], 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function generateTxnId(venue: string): string {
  const prefix = (venue || 'EVT').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'EVT';
  const d = new Date();
  const mmdd = String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  return `${prefix}-${mmdd}-${txnRand()}`;
}

export function generateRedemptionId(): string {
  return 'RED-' + nanoid(10);
}
