/**
 * HMAC-signed URL tokens.
 *
 * Used to grant SHORT-LIVED, unauthenticated access to otherwise gated
 * endpoints. The motivating case: Interakt's server fetches the wallet
 * pass PNG over a URL we hand them — they have no session cookie. We
 * can't make the PNG world-readable (it contains the QR that grants
 * entry), so we mint a per-message signed URL that's hard to guess and
 * expires automatically.
 *
 * Token format:
 *
 *     <base64url(payload)>.<base64url(hmac)>
 *
 * Payload is JSON: { txnId, qrCodeId?, exp }    (exp = unix ms)
 * HMAC is sha256 over the raw payload b64url string, keyed by
 * INTERNAL_TOKEN_SECRET from config (auto-generated on first boot).
 *
 * Never bake real secrets into tokens (these aren't encrypted).
 */

import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { getConfig, setConfig } from './db';

const SECRET_KEY = 'INTERNAL_TOKEN_SECRET';

/**
 * Returns the HMAC secret — auto-generates one on first call if blank, so
 * the system is always operational without manual setup. We only persist
 * the secret to config so it survives restarts and verifies tokens minted
 * in past requests.
 */
function getSecret(): string {
  let secret = getConfig(SECRET_KEY, '').trim();
  if (!secret) {
    secret = randomBytes(48).toString('base64url');
    setConfig(SECRET_KEY, secret);
  }
  return secret;
}

function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function b64urlDecode(s: string): Buffer | null {
  try { return Buffer.from(s, 'base64url'); } catch { return null; }
}

export interface WalletPassPayload {
  txnId: string;
  qrCodeId?: string;
  /**
   * Discriminator — 'wallet_pass' on every token minted from now on.
   *
   * Optional because tokens minted before this field existed are still in
   * customers' WhatsApp threads for up to the 30-day TTL below. Those decode
   * with `purpose === undefined` and are accepted; see verifyWalletPassToken.
   * Once the last pre-change token has expired this can become required.
   */
  purpose?: 'wallet_pass';
  /** Unix milliseconds. */
  exp: number;
}

/**
 * Mint a signed token granting access to a wallet pass for `ttlSeconds`.
 * Default TTL: 30 days — long enough that customers can still re-open
 * the WhatsApp message a month later and the image still loads, short
 * enough that a leaked URL doesn't grant perpetual access.
 */
export function signWalletPassToken(
  input: { txnId: string; qrCodeId?: string; ttlSeconds?: number },
): string {
  const ttl = input.ttlSeconds ?? 60 * 60 * 24 * 30;  // 30 days
  const payload: WalletPassPayload = {
    txnId: input.txnId,
    qrCodeId: input.qrCodeId,
    purpose: 'wallet_pass',
    exp: Date.now() + ttl * 1000,
  };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = b64urlEncode(payloadStr);
  const sig = createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a token and return its decoded payload — or null on any failure
 * (bad format, bad signature, expired). Constant-time signature comparison
 * to avoid timing oracles.
 */
export function verifyWalletPassToken(token: string): WalletPassPayload | null {
  if (!token || typeof token !== 'string') return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;

  // Recompute and compare in constant time
  const expected = createHmac('sha256', getSecret()).update(payloadB64).digest();
  const provided = b64urlDecode(sig);
  if (!provided || provided.length !== expected.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;

  const payloadBuf = b64urlDecode(payloadB64);
  if (!payloadBuf) return null;
  let payload: WalletPassPayload;
  try {
    payload = JSON.parse(payloadBuf.toString('utf8')) as WalletPassPayload;
  } catch {
    return null;
  }
  if (!payload?.txnId || typeof payload.exp !== 'number') return null;
  if (payload.exp <= Date.now()) return null;
  // Reject tokens minted for a DIFFERENT purpose. Wallet-view tokens carry the
  // same `txnId` + `exp` shape and are signed with the same secret, so without
  // this check a leaked /w/[token] view link — 90-day TTL, handed straight to
  // the customer — also unlocked the door-scannable pass PDF for triple the
  // intended window. `undefined` is still accepted for the pre-change tokens
  // described on the payload type.
  if (payload.purpose !== undefined && payload.purpose !== 'wallet_pass') return null;
  return payload;
}

// ─── Wallet-view tokens ───────────────────────────────────────────────────
//
// Sibling pair to signWalletPassToken / verifyWalletPassToken used to gate
// the public customer-facing /w/[token] page (and its top-up API).
//
// Why a separate verifier? The pass-image URL is broadly cached by Interakt
// and WhatsApp's CDN. If we used a single token shape for both purposes, a
// leaked pass URL — which we treat as low-risk because all it does is render
// a PNG — would also grant read access to the wallet balance + the ability
// to call /topup. The `purpose` discriminator below makes the two token
// classes non-interchangeable, but ONLY because both verifiers check it.
// An earlier version of this comment claimed verifyWalletPassToken "would
// never match this payload shape's signature anyway (different HMAC input)"
// — that was wrong. Both classes are signed with the same secret, and a
// view token is a perfectly valid signature over its OWN payload; since
// that payload also carries `txnId` and `exp`, it sailed through the pass
// verifier until it grew the explicit purpose check.
//
// TTL default 90 days — longer than pass image (30d) because customers may
// keep this URL open as a "card" they revisit through the night/event.

export interface WalletViewPayload {
  txnId: string;
  /** Discriminator — must equal 'wallet_view'. */
  purpose: 'wallet_view';
  /** Unix milliseconds. */
  exp: number;
}

/**
 * Mint a signed token granting access to the wallet-view page for
 * `ttlSeconds` (default 90 days). Payload carries `purpose: 'wallet_view'`
 * so a leaked pass-image token can never impersonate a view link.
 */
export function signWalletViewToken(
  input: { txnId: string; ttlSeconds?: number },
): string {
  const ttl = input.ttlSeconds ?? 60 * 60 * 24 * 90;  // 90 days
  const payload: WalletViewPayload = {
    txnId: input.txnId,
    purpose: 'wallet_view',
    exp: Date.now() + ttl * 1000,
  };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = b64urlEncode(payloadStr);
  const sig = createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a wallet-view token and return its decoded payload — or null on any
 * failure (bad format, bad signature, expired, OR wrong purpose tag).
 *
 * The `purpose === 'wallet_view'` check is load-bearing: it's the reason a
 * leaked pass-image token can't be replayed against this verifier even
 * though both tokens share the same HMAC key.
 */
export function verifyWalletViewToken(token: string): WalletViewPayload | null {
  if (!token || typeof token !== 'string') return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;

  const expected = createHmac('sha256', getSecret()).update(payloadB64).digest();
  const provided = b64urlDecode(sig);
  if (!provided || provided.length !== expected.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;

  const payloadBuf = b64urlDecode(payloadB64);
  if (!payloadBuf) return null;
  let payload: WalletViewPayload;
  try {
    payload = JSON.parse(payloadBuf.toString('utf8')) as WalletViewPayload;
  } catch {
    return null;
  }
  if (!payload?.txnId || typeof payload.exp !== 'number') return null;
  if (payload.purpose !== 'wallet_view') return null;
  if (payload.exp <= Date.now()) return null;
  return payload;
}

// ─── Reservation QR tokens ────────────────────────────────────────────────
//
// Powers the shared-QR multi-stage check-in + cover-redemption flow. A single
// HMAC-signed token is baked into the reservation pass image and scanned at
// two stations: entry-staff for door check-in and captains for cover debit.
//
// Like wallet-view, the `purpose: 'reservation_qr'` discriminator makes this
// token class non-interchangeable with the wallet pass / wallet view tokens.
// A leaked wallet token cannot impersonate a reservation, and vice versa.
//
// Default TTL: 365 days. The token is long-lived because the same pass image
// can be reused across the booking → arrival → settlement lifecycle that
// stretches over hours-to-weeks. Practical replay protection comes from the
// reservation_status='closed' guard + remaining-pax / cover-balance checks
// the server runs inside the same transaction as the mutation.

export interface ReservationQrPayload {
  reservationId: string;
  /** Discriminator — must equal 'reservation_qr'. */
  purpose: 'reservation_qr';
  /** Unix milliseconds. */
  exp: number;
}

/**
 * Mint a signed token granting scan access to a reservation for `ttlSeconds`
 * (default 365 days). Payload carries `purpose: 'reservation_qr'` so a leaked
 * wallet token can never impersonate a reservation scan.
 */
export function signReservationQrToken(
  input: { reservationId: string; ttlSeconds?: number },
): string {
  const ttl = input.ttlSeconds ?? 60 * 60 * 24 * 365;  // 365 days
  const payload: ReservationQrPayload = {
    reservationId: input.reservationId,
    purpose: 'reservation_qr',
    exp: Date.now() + ttl * 1000,
  };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = b64urlEncode(payloadStr);
  const sig = createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a reservation QR token and return its decoded payload — or null on
 * any failure (bad format, bad signature, expired, OR wrong purpose tag).
 *
 * The `purpose === 'reservation_qr'` check is load-bearing: it prevents a
 * leaked wallet pass token from being replayed as a reservation scan.
 */
export function verifyReservationQrToken(token: string): ReservationQrPayload | null {
  if (!token || typeof token !== 'string') return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;

  const expected = createHmac('sha256', getSecret()).update(payloadB64).digest();
  const provided = b64urlDecode(sig);
  if (!provided || provided.length !== expected.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;

  const payloadBuf = b64urlDecode(payloadB64);
  if (!payloadBuf) return null;
  let payload: ReservationQrPayload;
  try {
    payload = JSON.parse(payloadBuf.toString('utf8')) as ReservationQrPayload;
  } catch {
    return null;
  }
  if (!payload?.reservationId || typeof payload.exp !== 'number') return null;
  if (payload.purpose !== 'reservation_qr') return null;
  if (payload.exp <= Date.now()) return null;
  return payload;
}

// ─── Reservego prepay tokens ──────────────────────────────────────────────
//
// Powers the prepay flow: host generates a signed link → guest opens it →
// pays through Razorpay → reservation gets linked to a real payments row.
//
// Why a separate token class (not reuse reservation_qr)?
// The QR is a door-side scanner contract (long-lived, used many times to
// debit cover at the bar). Prepay is a one-shot payment URL with a short
// TTL — leaking a prepay token grants payment-form access, leaking a QR
// grants cover-redemption access. Different blast radius → different
// purpose tag. The same SECRET signs both; the `purpose` discriminator
// makes them non-interchangeable.
//
// Default TTL: 7 days. Most venues want guests to pay within 24–72h of the
// reservation, but 7d gives slack for late-arriving messages and timezone
// edge cases. A leaked link auto-expires after 7d.

export interface ReservationPrepayPayload {
  reservationId: string;
  /** Discriminator — must equal 'reservation_prepay'. */
  purpose: 'reservation_prepay';
  /** Unix milliseconds. */
  exp: number;
}

/**
 * Mint a signed token for the prepay landing page. The customer opens
 * /p/<token> → server verifies the HMAC → renders the prepay form with
 * the reservation prefilled.
 */
export function signReservationPrepayToken(
  input: { reservationId: string; ttlSeconds?: number },
): string {
  const ttl = input.ttlSeconds ?? 60 * 60 * 24 * 7;  // 7 days
  const payload: ReservationPrepayPayload = {
    reservationId: input.reservationId,
    purpose: 'reservation_prepay',
    exp: Date.now() + ttl * 1000,
  };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = b64urlEncode(payloadStr);
  const sig = createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a prepay token and return its decoded payload — or null on any
 * failure (bad format, bad signature, expired, OR wrong purpose tag).
 *
 * The `purpose === 'reservation_prepay'` check is load-bearing: prevents a
 * leaked wallet / wallet-view / reservation-qr token from being replayed
 * here even though all four share the same HMAC key.
 */
export function verifyReservationPrepayToken(token: string): ReservationPrepayPayload | null {
  if (!token || typeof token !== 'string') return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;

  const expected = createHmac('sha256', getSecret()).update(payloadB64).digest();
  const provided = b64urlDecode(sig);
  if (!provided || provided.length !== expected.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;

  const payloadBuf = b64urlDecode(payloadB64);
  if (!payloadBuf) return null;
  let payload: ReservationPrepayPayload;
  try {
    payload = JSON.parse(payloadBuf.toString('utf8')) as ReservationPrepayPayload;
  } catch {
    return null;
  }
  if (!payload?.reservationId || typeof payload.exp !== 'number') return null;
  if (payload.purpose !== 'reservation_prepay') return null;
  if (payload.exp <= Date.now()) return null;
  return payload;
}
