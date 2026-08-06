import { NextResponse } from 'next/server';
import { getSession, requireRole } from '@/lib/auth';
import { lookupWallet } from '@/lib/wallet';
import { decryptPin, isPinEncryptionAvailable } from '@/lib/crypto';
import { logAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ─── In-memory rate limit ──────────────────────────────────────────────────
//
// This is the ONE endpoint in the system that turns a session into a plaintext
// payment credential, and it had no throttle of any kind — while six less
// sensitive surfaces (/api/public/wallet/[token], /api/payments/order,
// /api/auth/otp/request, …) all ship the same limiter block. txn_ids are
// listed on the wallets page and are low-entropy (VENUE-MMDD-5chars), so a
// host phone left unlocked on the DJ booth for two minutes was enough to walk
// the list and harvest every recoverable PIN in the venue as fast as the
// network allows. Every reveal is audited, but nothing slowed the burst down.
//
// Keyed on SESSION id, not IP: the threat is a borrowed/lifted host session,
// which does not change IP. Budget is generous next to real operation (a host
// reveals a PIN when a guest loses theirs — a handful a night).
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_PER_MINUTE = 5;
const RATE_HOUR_MS = 60 * 60 * 1000;
const RATE_MAX_PER_HOUR = 20;
const sessionHits = new Map<string, number[]>();
let lastCleanupAt = 0;

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  if (now - lastCleanupAt > RATE_WINDOW_MS) {
    lastCleanupAt = now;
    for (const [k, hits] of sessionHits) {
      const kept = hits.filter((t) => now - t < RATE_HOUR_MS);
      if (kept.length === 0) sessionHits.delete(k);
      else if (kept.length !== hits.length) sessionHits.set(k, kept);
    }
  }
  const fresh = (sessionHits.get(key) || []).filter((t) => now - t < RATE_HOUR_MS);
  const lastMinute = fresh.filter((t) => now - t < RATE_WINDOW_MS).length;
  if (lastMinute >= RATE_MAX_PER_MINUTE || fresh.length >= RATE_MAX_PER_HOUR) {
    sessionHits.set(key, fresh);
    return false;
  }
  fresh.push(now);
  sessionHits.set(key, fresh);
  return true;
}

/**
 * POST /api/wallets/[txnId]/reveal-pin
 *
 * Re-reads the wallet PIN for an admin when a guest has lost it. Reads the
 * AES-GCM copy in wallets.pin_enc; the bcrypt hash that redemption checks is
 * never touched by this route.
 *
 * POST, not GET, on purpose: revealing a PIN is an auditable disclosure of a
 * payment credential. A GET would be triggerable by a link prefetch, sit in
 * browser history, and land in any proxy access log as a plain URL.
 *
 * Role: host ONLY. Manager, cashier, captain and entry are all refused —
 * the PIN is what stops floor staff from spending a guest's cover behind
 * their back, so the people holding the scanner must not be able to read it.
 * Widening this to managers is a one-line change: requireRole(['host', 'manager']).
 *
 * Responses:
 *   200 { ok: true, txnId, pin }
 *   401 / 403  — not signed in / not host
 *   404        — no such wallet
 *   409        — PIN exists but is not recoverable (three distinct messages,
 *                see below); the caller shows `message` verbatim.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ txnId: string }> }) {
  const { txnId } = await ctx.params;

  const session = await requireRole(['host']);
  if ('forbidden' in session) {
    // A staff account probing this endpoint is exactly what the venue owner
    // wants to see in the trail, so log the refusal when we can name the
    // actor. requireRole drops the session on 403, hence the second read.
    const denied = await getSession();
    if (denied) {
      logAudit({
        actor: denied.name,
        action: 'wallet_pin_revealed',
        entityType: 'wallet',
        entityId: txnId,
        details: { outcome: 'denied', reason: 'role_not_host', role: denied.role },
      });
    }
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status });
  }

  // Throttle BEFORE any DB work, so a blocked attempt costs nothing, and audit
  // the refusal so a harvesting burst is visible on the History page rather
  // than just silently slowed.
  if (!checkRateLimit(session.sub)) {
    logAudit({
      actor: session.name,
      action: 'wallet_pin_revealed',
      entityType: 'wallet',
      entityId: txnId,
      details: { outcome: 'rate_limited' },
    });
    return NextResponse.json(
      {
        ok: false,
        code: 'rate_limited',
        message: 'Too many PIN reveals in a short period. Wait a minute and try again.',
      },
      { status: 429, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const wallet = lookupWallet(txnId);
  if (!wallet) {
    logAudit({
      actor: session.name,
      action: 'wallet_pin_revealed',
      entityType: 'wallet',
      entityId: txnId,
      details: { outcome: 'not_found' },
    });
    return NextResponse.json({ ok: false, message: 'Transaction not found.' }, { status: 404 });
  }

  // pin_enc was added to `wallets` after WalletWithGuest was written; lookupWallet
  // does SELECT w.*, so the column is present at runtime even though the type
  // doesn't declare it. Same raw-row read the pass routes use for event_id.
  const pinEnc = (wallet as unknown as { pin_enc?: string | null }).pin_enc ?? null;
  const keyConfigured = isPinEncryptionAvailable();

  // (a) Nothing stored. Two very different operator situations, so two very
  //     different messages — one is "fix your env", the other is "this wallet
  //     is permanently unrecoverable, re-issue it".
  if (!pinEnc) {
    const message = keyConfigured
      ? 'This wallet was issued before PIN recovery existed, so its PIN was never stored in recoverable form and cannot be shown. Issue a new wallet to give the guest a fresh PIN.'
      : 'PIN recovery is switched off on this server: WALLET_PIN_ENC_KEY is not set, so PINs are stored as one-way hashes only and cannot be shown. Set the key to make newly issued wallets recoverable — already-issued wallets stay unrecoverable.';
    logAudit({
      actor: session.name,
      action: 'wallet_pin_revealed',
      entityType: 'wallet',
      entityId: txnId,
      details: {
        outcome: 'unavailable',
        reason: keyConfigured ? 'no_ciphertext' : 'encryption_key_not_configured',
      },
    });
    return NextResponse.json(
      { ok: false, code: keyConfigured ? 'pin_not_recoverable' : 'pin_encryption_unavailable', message },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // (b) Ciphertext present but unreadable. decryptPin() returns null for a
  //     missing key, the wrong key, a malformed payload, or a failed auth tag —
  //     it never throws, so a corrupt row degrades to this message instead of
  //     a 500.
  const pin = decryptPin(pinEnc);
  if (!pin) {
    const message = keyConfigured
      ? 'The stored PIN could not be decrypted. WALLET_PIN_ENC_KEY does not match the key this wallet was issued under, or the stored value has been altered. Restore the original key, or issue a new wallet.'
      : 'This wallet has a recoverable PIN stored, but WALLET_PIN_ENC_KEY is not set on this server, so it cannot be decrypted. Restore the key this wallet was issued under and try again.';
    logAudit({
      actor: session.name,
      action: 'wallet_pin_revealed',
      entityType: 'wallet',
      entityId: txnId,
      details: {
        outcome: 'failed',
        reason: keyConfigured ? 'decrypt_failed_key_mismatch_or_tampered' : 'encryption_key_missing',
      },
    });
    return NextResponse.json(
      { ok: false, code: keyConfigured ? 'pin_undecryptable' : 'pin_key_missing', message },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // (c) Success. The PIN itself NEVER goes into the audit row — the log is
  //     readable by anyone with DB access and would otherwise become a
  //     plaintext PIN dump defeating the encryption above.
  logAudit({
    actor: session.name,
    action: 'wallet_pin_revealed',
    entityType: 'wallet',
    entityId: txnId,
    details: { outcome: 'revealed', guest: wallet.name, cover: wallet.cover_issued },
  });

  return NextResponse.json(
    { ok: true, txnId, pin },
    // A PIN must never be written to a disk cache or a shared proxy.
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
