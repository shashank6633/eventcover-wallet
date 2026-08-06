/**
 * Reservation cover redemption ledger.
 *
 * Sibling module to reservation-checkin.ts. The reservation row is its own
 * wallet for booked guests: cover_amount is the total redeemable balance
 * stamped at booking time, cover_redeemed is the running sum debited by
 * captains scanning the QR.
 *
 * Concurrency: every mutation runs inside db.transaction() and re-reads the
 * reservation row inside the tx body. Two captains scanning the same QR for
 * the last few hundred rupees serialize via better-sqlite3's single-writer
 * model — the second tx sees the freshly-updated cover_redeemed and rejects
 * with a 409.
 *
 * Bill-id uniqueness: enforced by partial unique index
 * ux_cover_redemptions_active_bill on (reservation_id, bill_id) WHERE
 * bill_id IS NOT NULL AND status='success'. A reversed bill drops out of
 * the index so it can be re-billed after correction. We ALSO do a defensive
 * SELECT inside the tx to fail-fast with a friendly error rather than
 * surfacing a raw SQLITE_CONSTRAINT.
 *
 * ─── THIS IS THE VENUE'S SECOND REDEMPTION LEDGER. READ THIS BEFORE ADDING
 *     ANY REPORT THAT COUNTS MONEY. ───────────────────────────────────────
 *
 * Wallet redemptions write `redemptions` (redemption.ts). Reservation cover
 * redemptions write `cover_redemptions` — this table. They are not the same
 * ledger and nothing reconciles them.
 *
 * Current reader status:
 *   • transactions.ts (History register) — READS THIS TABLE. Rows appear as
 *     kind='reservation_redemption' in their own totals bucket, deliberately
 *     NOT summed into redemptions_amount.
 *   • cashier.ts (shift settlement), analytics.ts, analytics-dashboard.ts,
 *     dashboard.ts — STILL BLIND. Money debited here is visible on History
 *     but is never settled against the till and never reaches revenue.
 *
 * Do NOT "fix" that by having redeemCover() also INSERT a `redemptions` row:
 * `redemptions.txn_id` is `TEXT NOT NULL REFERENCES wallets(txn_id)` and a
 * reservation has no wallet (converted_wallet_txn is nullable and normally
 * null), so that row cannot legally exist. Unifying means either giving
 * bookings real wallets, or teaching the remaining readers to union this
 * table — a product decision, not a patch.
 *
 * Blast radius today is zero and structurally so: every live reservation has
 * cover_amount = 0, so `cleanAmount > balance` rejects every debit. The path
 * is live but inert until something starts populating reservations.cover_amount.
 */

import { nanoid } from 'nanoid';
import { getDb } from './db';
import { logAudit } from './audit';
import type { ReservationLedgerStatus } from './reservation-checkin';

export type CoverStatus = 'not_redeemed' | 'partially_redeemed' | 'fully_redeemed';

export interface RedemptionRow {
  id: string;
  reservation_id: string;
  bill_id: string | null;
  redeemed_amount: number;
  redeemed_by: string;
  notes: string | null;
  status: 'success' | 'reversed';
  reversed_at: number | null;
  reversed_by: string | null;
  timestamp: number;
}

export interface RedemptionState {
  cover_amount: number;
  cover_redeemed: number;
  cover_balance: number;
  cover_status: CoverStatus;
}

/**
 * Pure helper — derives cover_status from cover_amount and cover_redeemed.
 * Not stored in DB; recomputed by every read path that returns a ledger.
 */
export function computeCoverStatus(args: { coverAmount: number; coverRedeemed: number }): CoverStatus {
  if (args.coverRedeemed <= 0) return 'not_redeemed';
  if (args.coverRedeemed >= args.coverAmount) return 'fully_redeemed';
  return 'partially_redeemed';
}

/**
 * Snapshot of the cover counters for a reservation. Returns null when the
 * reservation_id does not exist.
 */
export function getRedemptionState(reservationId: string): RedemptionState | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT cover_amount, cover_redeemed FROM reservations WHERE id = ?`,
    )
    .get(reservationId) as
    | { cover_amount: number | null; cover_redeemed: number | null }
    | undefined;
  if (!row) return null;
  const coverAmount = Number(row.cover_amount ?? 0);
  const coverRedeemed = Number(row.cover_redeemed ?? 0);
  return {
    cover_amount: coverAmount,
    cover_redeemed: coverRedeemed,
    cover_balance: Math.max(0, coverAmount - coverRedeemed),
    cover_status: computeCoverStatus({ coverAmount, coverRedeemed }),
  };
}

export interface RedeemSuccess {
  ok: true;
  redemptionId: string;
  newRedeemed: number;
  newBalance: number;
  coverStatus: CoverStatus;
}

export interface RedeemFailure {
  ok: false;
  reason:
    | 'not_found'
    | 'closed'
    | 'cancelled'
    | 'invalid_amount'
    | 'over_redeem'
    | 'duplicate_bill';
  message: string;
}

export type RedeemResult = RedeemSuccess | RedeemFailure;

/**
 * Debit a redemption from a reservation's cover balance. Atomic + race-safe:
 * two simultaneous captains targeting the same balance serialize, and the
 * second sees the new cover_redeemed and rejects with 409.
 *
 * bill_id is optional — when present and non-empty the partial unique index
 * (and a pre-flight SELECT) prevent the same bill being charged twice while
 * still active. Reversing a redemption drops it from the constraint so a
 * corrected bill can be re-billed.
 */
export function redeemCover(input: {
  reservationId: string;
  amount: number;
  actor: string;
  billId?: string | null;
  notes?: string | null;
}): RedeemResult {
  const db = getDb();
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: 'invalid_amount', message: 'Amount must be a positive number.' };
  }
  // Round to 2 decimals to keep the ledger free of float drift.
  const cleanAmount = Math.round(amount * 100) / 100;
  const billId = input.billId?.trim() || null;

  const selRes = db.prepare(
    `SELECT id, cover_amount, cover_redeemed, reservation_status, status
       FROM reservations WHERE id = ?`,
  );
  const selDupBill = db.prepare(
    `SELECT id FROM cover_redemptions
      WHERE reservation_id = ? AND bill_id = ? AND status = 'success'
      LIMIT 1`,
  );
  const updRes = db.prepare(
    `UPDATE reservations SET cover_redeemed = ? WHERE id = ?`,
  );
  const insRedemption = db.prepare(
    `INSERT INTO cover_redemptions
       (id, reservation_id, bill_id, redeemed_amount, redeemed_by, notes, status, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, 'success', ?)`,
  );

  let result: RedeemResult = {
    ok: false,
    reason: 'not_found',
    message: 'Reservation not found.',
  };

  const tx = db.transaction(() => {
    const row = selRes.get(input.reservationId) as
      | {
          id: string;
          cover_amount: number | null;
          cover_redeemed: number | null;
          reservation_status: string | null;
          status: string;
        }
      | undefined;
    if (!row) {
      result = { ok: false, reason: 'not_found', message: 'Reservation not found.' };
      return;
    }
    if (row.status === 'cancelled') {
      result = { ok: false, reason: 'cancelled', message: 'Reservation is cancelled.' };
      return;
    }
    const reservationStatus = (row.reservation_status as ReservationLedgerStatus | null) ?? 'pending';
    if (reservationStatus === 'closed') {
      result = { ok: false, reason: 'closed', message: 'Reservation is closed.' };
      return;
    }
    const coverAmount = Number(row.cover_amount ?? 0);
    const coverRedeemed = Number(row.cover_redeemed ?? 0);
    const balance = Math.max(0, coverAmount - coverRedeemed);
    if (cleanAmount > balance + 1e-9) {
      result = {
        ok: false,
        reason: 'over_redeem',
        message: `Amount exceeds cover balance (₹${balance.toFixed(2)} remaining).`,
      };
      return;
    }
    if (billId) {
      const dup = selDupBill.get(input.reservationId, billId);
      if (dup) {
        result = {
          ok: false,
          reason: 'duplicate_bill',
          message: `Bill ${billId} has already been redeemed against this reservation.`,
        };
        return;
      }
    }

    const newRedeemed = Math.round((coverRedeemed + cleanAmount) * 100) / 100;
    updRes.run(newRedeemed, input.reservationId);
    const redemptionId = nanoid();
    insRedemption.run(
      redemptionId,
      input.reservationId,
      billId,
      cleanAmount,
      input.actor,
      input.notes?.trim() || null,
      Date.now(),
    );

    logAudit({
      actor: input.actor,
      action: 'reservation_redeem',
      entityType: 'reservation',
      entityId: input.reservationId,
      details: {
        redemption_id: redemptionId,
        amount: cleanAmount,
        bill_id: billId,
        before: coverRedeemed,
        after: newRedeemed,
        cover_amount: coverAmount,
        notes: input.notes?.trim() || null,
      },
    });

    result = {
      ok: true,
      redemptionId,
      newRedeemed,
      newBalance: Math.max(0, coverAmount - newRedeemed),
      coverStatus: computeCoverStatus({ coverAmount, coverRedeemed: newRedeemed }),
    };
  });
  tx();
  return result;
}

/**
 * Returns every redemption entry for a reservation, newest first. Includes
 * reversed rows for full ledger history.
 */
export function listRedemptions(reservationId: string): RedemptionRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM cover_redemptions
        WHERE reservation_id = ?
        ORDER BY timestamp DESC`,
    )
    .all(reservationId) as RedemptionRow[];
}

export interface ReverseRedemptionSuccess {
  ok: true;
  newRedeemed: number;
  newBalance: number;
  coverStatus: CoverStatus;
}

export interface ReverseRedemptionFailure {
  ok: false;
  reason: 'not_found' | 'already_reversed' | 'underflow';
  message: string;
}

export type ReverseRedemptionResult = ReverseRedemptionSuccess | ReverseRedemptionFailure;

/**
 * Reverse a redemption — Manager / host only (API enforces). Credits the
 * amount back to cover_redeemed (i.e. subtracts), flips the original row
 * to status='reversed', and recomputes cover_status downstream.
 *
 * IDOR guard: `reservationId` MUST be passed by the caller and we re-select
 * the redemption row with `WHERE id = ? AND reservation_id = ?`. See
 * reverseCheckin's docstring for the threat model.
 */
export function reverseRedemption(input: {
  redemptionId: string;
  reservationId: string;
  actor: string;
  reason?: string | null;
}): ReverseRedemptionResult {
  const db = getDb();
  const selRed = db.prepare(
    `SELECT id, reservation_id, redeemed_amount, bill_id, status
       FROM cover_redemptions WHERE id = ? AND reservation_id = ?`,
  );
  const selRes = db.prepare(
    `SELECT id, cover_amount, cover_redeemed FROM reservations WHERE id = ?`,
  );
  const updRes = db.prepare(
    `UPDATE reservations SET cover_redeemed = ? WHERE id = ?`,
  );
  const updRed = db.prepare(
    `UPDATE cover_redemptions SET status = 'reversed', reversed_at = ?, reversed_by = ? WHERE id = ?`,
  );

  let result: ReverseRedemptionResult = {
    ok: false,
    reason: 'not_found',
    message: 'Redemption entry not found.',
  };

  const tx = db.transaction(() => {
    const red = selRed.get(input.redemptionId, input.reservationId) as
      | {
          id: string;
          reservation_id: string;
          redeemed_amount: number;
          bill_id: string | null;
          status: string;
        }
      | undefined;
    if (!red) {
      result = {
        ok: false,
        reason: 'not_found',
        message: 'Redemption not found for this reservation.',
      };
      return;
    }
    if (red.status !== 'success') {
      result = { ok: false, reason: 'already_reversed', message: 'Redemption already reversed.' };
      return;
    }
    const res = selRes.get(red.reservation_id) as
      | { id: string; cover_amount: number | null; cover_redeemed: number | null }
      | undefined;
    if (!res) {
      result = { ok: false, reason: 'not_found', message: 'Reservation not found.' };
      return;
    }
    const coverAmount = Number(res.cover_amount ?? 0);
    const coverRedeemed = Number(res.cover_redeemed ?? 0);
    const newRedeemed = Math.round((coverRedeemed - red.redeemed_amount) * 100) / 100;
    if (newRedeemed < -1e-9) {
      result = {
        ok: false,
        reason: 'underflow',
        message: 'Reversing would underflow cover_redeemed counter.',
      };
      return;
    }
    const clamped = Math.max(0, newRedeemed);

    updRes.run(clamped, red.reservation_id);
    updRed.run(Date.now(), input.actor, red.id);

    logAudit({
      actor: input.actor,
      action: 'reservation_redeem_reverse',
      entityType: 'reservation',
      entityId: red.reservation_id,
      details: {
        redemption_id: red.id,
        reversed_amount: red.redeemed_amount,
        bill_id: red.bill_id,
        before: coverRedeemed,
        after: clamped,
        cover_amount: coverAmount,
        reason: input.reason?.trim() || null,
      },
    });

    result = {
      ok: true,
      newRedeemed: clamped,
      newBalance: Math.max(0, coverAmount - clamped),
      coverStatus: computeCoverStatus({ coverAmount, coverRedeemed: clamped }),
    };
  });
  tx();
  return result;
}
