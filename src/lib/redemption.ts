import { getDb } from './db';
import { verifyPin, generateRedemptionId } from './crypto';
import { logAudit } from './audit';
import { isExpired, formatExpiry } from './expiry';
import { expireWallet } from './wallet';
import type { RedemptionWithGuest } from './types';

const PIN_MAX_ATTEMPTS = 3;
const PIN_LOCKOUT_MS = 5 * 60 * 1000;

/**
 * Every rupee that reaches the ledger goes through here.
 *
 * redeemWallet used to trust input.amount completely: its only test was
 * `input.amount > fresh.balance`, which a negative trivially passes, and
 * `balanceBefore - input.amount` then CREDITS the wallet while writing a row
 * that reads as a redemption. The single line defending that invariant lived
 * in one HTTP handler (`!(amt > 0)`), and it still admits Infinity —
 * Infinity > 0 is true, and against an Infinity balance every redemption
 * succeeds forever — and sub-paise amounts that round out of the balance while
 * landing in the ledger at full value, breaking the one invariant a dispute
 * can be settled with: cover_issued − SUM(redemptions.amount) = balance.
 *
 * Validating in the library, not the route, is what matters: the sibling
 * reservation module already does (cover-redemption.ts), and any future caller
 * — a bulk correction, a settle flow, a CSV import — inherits it here.
 *
 * Returns the paise-rounded amount, or null if it is not spendable money.
 */
function cleanAmount(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  return rounded > 0 ? rounded : null;
}

export interface RedeemInput {
  txnId: string;
  pin: string;
  amount: number;
  captain: string;
  /** Free-text reference — invoice no, table no, KOT no, whatever the bar uses. */
  orderRef?: string;
  /** Free-text note captured at redemption time (e.g. "Cash and carry", "Comp bottle"). */
  notes?: string;
}

export interface RedeemResult {
  ok: boolean;
  message: string;
  balanceAfter?: number;
  amountRedeemed?: number;
  guestName?: string;
  attemptsLeft?: number;
  lockedForMinutes?: number;
}

export async function redeemWallet(input: RedeemInput): Promise<RedeemResult> {
  const db = getDb();

  // Validate the money before touching the wallet, so a bad amount can never
  // reach the balance arithmetic or the ledger insert.
  const amount = cleanAmount(input.amount);
  if (amount === null) {
    return { ok: false, message: 'Amount must be a valid number greater than ₹0.' };
  }

  const wallet = db.prepare(`
    SELECT w.*, g.name AS guest_name
    FROM wallets w
    JOIN guests g ON g.id = w.guest_id
    WHERE w.txn_id = ?
  `).get(input.txnId) as
    | { txn_id: string; balance: number; status: string; pin_hash: string;
        pin_fail_count: number; pin_locked_until: number | null;
        expires_at: number | null; guest_name: string }
    | undefined;

  if (!wallet) return { ok: false, message: 'Transaction not found.' };

  if (wallet.status === 'active' && isExpired(wallet.expires_at)) {
    // Through expireWallet, not a bare UPDATE: this path expires as many
    // wallets as the sweep does, and whoever flips the status owes the
    // `wallet_expired` row that records the balance which lapsed. The sweep
    // can never write it afterwards (it only selects status='active').
    expireWallet(input.txnId, wallet.expires_at, wallet.balance, input.captain);
    logAudit({
      actor: input.captain, action: 'redeem_blocked_expired',
      entityType: 'wallet', entityId: input.txnId,
      details: { expires_at: wallet.expires_at },
    });
    return {
      ok: false,
      message: `Wallet expired at ${formatExpiry(wallet.expires_at)}. Cannot redeem.`,
    };
  }

  if (wallet.status !== 'active') {
    return { ok: false, message: `Wallet is ${wallet.status}. Cannot redeem.` };
  }

  const now = Date.now();
  if (wallet.pin_locked_until && wallet.pin_locked_until > now) {
    const mins = Math.ceil((wallet.pin_locked_until - now) / 60000);
    return { ok: false, message: `PIN locked. Try again in ${mins} min.`, lockedForMinutes: mins };
  }

  const pinOk = await verifyPin(input.pin, wallet.pin_hash);
  if (!pinOk) {
    // Atomic read-modify-write, in SQL, in one statement.
    //
    // The counter used to be read at the top of this function — BEFORE the
    // awaited bcrypt compare above, which yields the event loop — and written
    // back as `staleSnapshot + 1` outside any transaction. Every request that
    // entered before the first UPDATE landed therefore read the same value and
    // wrote the same number: 200 concurrent wrong PINs against one wallet
    // recorded ONE failure and never locked at all. With PIN_LENGTH 4 in this
    // venue's config the lockout is the entire brute-force defence, and the
    // stored counter was useless for fraud review because it disagreed with
    // the audit log about what had happened.
    //
    // The same statement clears a lockout whose window has already elapsed.
    // Previously pin_fail_count was reset ONLY by a successful redemption, so
    // once it hit 3 it stayed there: the next wrong PIN computed 4, tripped
    // `>= PIN_MAX_ATTEMPTS` and re-locked instantly, capping a guest who
    // fumbled three times at one attempt per five minutes for the rest of the
    // night — while the message kept promising three. (The live DB has a
    // wallet sitting in exactly that state: DEM-0424-EHLVT, pin_fail_count 3.)
    const failState = db.transaction(() => {
      db.prepare(`
        UPDATE wallets
           SET pin_fail_count = CASE
                 WHEN pin_locked_until IS NOT NULL AND pin_locked_until <= ?
                 THEN 1
                 ELSE COALESCE(pin_fail_count, 0) + 1
               END,
               pin_locked_until = CASE
                 WHEN pin_locked_until IS NOT NULL AND pin_locked_until <= ?
                 THEN NULL
                 ELSE pin_locked_until
               END
         WHERE txn_id = ?
      `).run(now, now, input.txnId);

      const row = db.prepare(
        'SELECT pin_fail_count, pin_locked_until FROM wallets WHERE txn_id = ?',
      ).get(input.txnId) as { pin_fail_count: number; pin_locked_until: number | null };

      const fails = row.pin_fail_count || 0;
      let lockedUntil = row.pin_locked_until;
      if (fails >= PIN_MAX_ATTEMPTS && (!lockedUntil || lockedUntil <= now)) {
        lockedUntil = now + PIN_LOCKOUT_MS;
        db.prepare('UPDATE wallets SET pin_locked_until = ? WHERE txn_id = ?')
          .run(lockedUntil, input.txnId);
      }
      return { fails, lockedUntil };
    })();

    logAudit({
      actor: input.captain, action: 'pin_fail',
      entityType: 'wallet', entityId: input.txnId, details: { attempt: failState.fails },
    });

    if (failState.lockedUntil && failState.lockedUntil > now) {
      // Only the attempt that crossed the threshold records the lockout, so a
      // parallel burst leaves one pin_lockout row rather than one per request.
      if (failState.fails === PIN_MAX_ATTEMPTS) {
        logAudit({
          actor: input.captain, action: 'pin_lockout',
          entityType: 'wallet', entityId: input.txnId, details: { fails: failState.fails },
        });
      }
      const mins = Math.ceil((failState.lockedUntil - now) / 60000);
      return {
        ok: false,
        message: `Too many wrong attempts. Locked for ${mins} min.`,
        lockedForMinutes: mins,
      };
    }

    const attemptsLeft = Math.max(0, PIN_MAX_ATTEMPTS - failState.fails);
    return {
      ok: false,
      message: `Incorrect QR Code ID. ${attemptsLeft} attempt(s) left.`,
      attemptsLeft,
    };
  }

  let balanceAfterOut: number | undefined;
  let insufficientBalance: number | null = null;

  const tx = db.transaction(() => {
    const fresh = db.prepare('SELECT balance, status, expires_at FROM wallets WHERE txn_id = ?')
      .get(input.txnId) as { balance: number; status: string; expires_at: number | null };

    if (isExpired(fresh.expires_at)) {
      expireWallet(input.txnId, fresh.expires_at, fresh.balance, input.captain);
      throw new Error('expired');
    }
    if (fresh.status !== 'active') {
      throw new Error('status_changed');
    }
    // A balance that is not a finite number (an Infinity or a NULL written by
    // some earlier unvalidated issue) makes `amount > balance` false for every
    // amount, i.e. an unlimited tab. Refuse to spend it at all rather than let
    // the comparison decide.
    if (!Number.isFinite(fresh.balance)) {
      throw new Error('corrupt_balance');
    }
    if (amount > fresh.balance) {
      insufficientBalance = fresh.balance;
      throw new Error('insufficient');
    }

    const balanceBefore = fresh.balance;
    const balanceAfter = Math.round((balanceBefore - amount) * 100) / 100;
    const newStatus = balanceAfter <= 0 ? 'exhausted' : 'active';

    db.prepare(`
      UPDATE wallets
      SET balance = ?, status = ?, pin_fail_count = 0, pin_locked_until = NULL
      WHERE txn_id = ?
    `).run(balanceAfter, newStatus, input.txnId);

    db.prepare(`
      INSERT INTO redemptions
        (id, txn_id, amount, balance_before, balance_after, captain, order_ref, notes, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', ?)
    `).run(
      generateRedemptionId(), input.txnId, amount,
      balanceBefore, balanceAfter, input.captain,
      input.orderRef || null, input.notes || null, now
    );

    // Audited INSIDE the transaction, as cover-redemption.ts already does.
    // Run after the commit, a crash in that window left a committed debit with
    // no audit row at all — the redemptions row still carries before/after, so
    // the money stayed traceable, but the who/when trail had a hole.
    logAudit({
      actor: input.captain, action: 'redeem',
      entityType: 'wallet', entityId: input.txnId,
      details: {
        amount,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        order_ref: input.orderRef,
        notes: input.notes,
      },
    });

    balanceAfterOut = balanceAfter;
  });

  try {
    tx();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'insufficient' && insufficientBalance !== null) {
      return { ok: false, message: `Insufficient balance. Remaining ₹${insufficientBalance}.` };
    }
    if (msg === 'expired') {
      return { ok: false, message: 'Wallet expired between lookup and redeem. Cannot redeem.' };
    }
    if (msg === 'status_changed') {
      return { ok: false, message: 'Wallet status changed. Refresh and retry.' };
    }
    if (msg === 'corrupt_balance') {
      // Deliberately NOT "Retry." — retrying can never fix it, and the captain
      // needs to escalate rather than keep scanning.
      return {
        ok: false,
        message: 'This wallet is flagged for review — its balance is not a valid amount. Call a manager.',
      };
    }
    return { ok: false, message: 'Transaction failed. Retry.' };
  }

  return {
    ok: true,
    message: `Redeemed ₹${amount}. Remaining ₹${balanceAfterOut}.`,
    amountRedeemed: amount,
    balanceAfter: balanceAfterOut,
    guestName: wallet.guest_name,
  };
}

export interface ReverseRedemptionResult {
  ok: boolean;
  message: string;
  reason?: 'not_found' | 'already_reversed' | 'wallet_missing';
  amountReturned?: number;
  balanceAfter?: number;
}

/**
 * Undo one wallet redemption — credit the amount back and mark the ledger row
 * 'reversed'.
 *
 * Nothing in this repo ever set redemptions.status = 'reversed'. The only
 * reverse endpoints operate on cover_redemptions (a different table), so
 * transactions.ts's "Reversed" pill, its reversed_count total and analytics.ts's
 * reversedAgg term were permanently dead branches — and a captain who typed
 * 5000 instead of 500 drained the wallet with no in-app remedy at all:
 * voidWallet refuses anything that is not 'active', so a wallet redeemed to
 * zero returns 409 "Wallet is exhausted." The only remaining option was hand-
 * editing SQLite on a busy Saturday, with no audit trail.
 *
 * Mirrors src/lib/cover-redemption.ts reverseRedemption: one transaction,
 * re-select by (id, txn_id) so a redemption id from another wallet can't be
 * reversed against this one, require status 'success', and reopen an
 * 'exhausted' wallet when the credit brings the balance back above zero.
 *
 * NOTE: not yet reachable over HTTP. It needs a host/manager-only route
 * (POST /api/wallets/[txnId]/redemptions/[id]/reverse) that this audit's file
 * ownership does not cover; the lib half is here so the route is a thin
 * wrapper and the reporting code above lights up the moment it lands.
 */
export function reverseRedemption(input: {
  txnId: string;
  redemptionId: string;
  actor: string;
  reason?: string | null;
}): ReverseRedemptionResult {
  const db = getDb();
  let result: ReverseRedemptionResult = {
    ok: false, reason: 'not_found', message: 'Redemption not found.',
  };

  const tx = db.transaction(() => {
    const red = db.prepare(
      `SELECT id, txn_id, amount, status FROM redemptions WHERE id = ? AND txn_id = ?`,
    ).get(input.redemptionId, input.txnId) as
      | { id: string; txn_id: string; amount: number; status: string }
      | undefined;

    if (!red) {
      result = { ok: false, reason: 'not_found', message: 'Redemption not found for this wallet.' };
      return;
    }
    if (red.status !== 'success') {
      result = { ok: false, reason: 'already_reversed', message: 'Redemption already reversed.' };
      return;
    }

    const wallet = db.prepare(
      `SELECT balance, cover_issued, status FROM wallets WHERE txn_id = ?`,
    ).get(input.txnId) as
      | { balance: number; cover_issued: number; status: string }
      | undefined;
    if (!wallet || !Number.isFinite(wallet.balance)) {
      result = { ok: false, reason: 'wallet_missing', message: 'Wallet not found or unusable.' };
      return;
    }

    const amount = cleanAmount(red.amount) ?? 0;
    const balanceAfter = Math.round((wallet.balance + amount) * 100) / 100;
    // Reopen a wallet the mis-keyed redemption had exhausted. 'expired' and
    // any other terminal status stay as they are — the credit is restored but
    // an expired wallet must not become spendable again.
    const newStatus =
      wallet.status === 'exhausted' && balanceAfter > 0 ? 'active' : wallet.status;

    db.prepare('UPDATE wallets SET balance = ?, status = ? WHERE txn_id = ?')
      .run(balanceAfter, newStatus, input.txnId);
    db.prepare("UPDATE redemptions SET status = 'reversed' WHERE id = ?").run(red.id);

    logAudit({
      actor: input.actor,
      action: 'redemption_reversed',
      entityType: 'wallet',
      entityId: input.txnId,
      details: {
        redemption_id: red.id,
        amount,
        balance_before: wallet.balance,
        balance_after: balanceAfter,
        wallet_status_before: wallet.status,
        wallet_status_after: newStatus,
        reason: input.reason ?? null,
      },
    });

    result = {
      ok: true,
      message: `Reversed ₹${amount}. Balance restored to ₹${balanceAfter}.`,
      amountReturned: amount,
      balanceAfter,
    };
  });

  tx();
  return result;
}

export function listRedemptions(limit = 200): RedemptionWithGuest[] {
  const db = getDb();
  return db.prepare(`
    SELECT r.*, g.name AS guest_name
    FROM redemptions r
    JOIN wallets w ON w.txn_id = r.txn_id
    JOIN guests g ON g.id = w.guest_id
    ORDER BY r.created_at DESC
    LIMIT ?
  `).all(limit) as RedemptionWithGuest[];
}
