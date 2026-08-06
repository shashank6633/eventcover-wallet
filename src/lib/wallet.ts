import { getDb, getConfig } from './db';
import { generatePin, hashPin, generateTxnId, encryptPin } from './crypto';
import { nanoid } from 'nanoid';
import { logAudit } from './audit';
import { computeExpiresAt, defaultEventDate } from './expiry';
import { attachWalletToTable } from './tables';
import { getEvent } from './events';
import { markReservationConverted } from './reservations';
import { normalizePhone } from './users';
import type { WalletWithGuest, PaymentMethod } from './types';

/** Fallback cap on a single wallet's entry fee or cover credit, in rupees. */
const MAX_WALLET_AMOUNT_DEFAULT = 200000;

function walletAmountCap(): number {
  const n = Number(getConfig('MAX_WALLET_AMOUNT', String(MAX_WALLET_AMOUNT_DEFAULT)));
  return Number.isFinite(n) && n > 0 ? n : MAX_WALLET_AMOUNT_DEFAULT;
}

/**
 * The gate every rupee must pass before it reaches a wallets money column.
 *
 * entry_fee / cover_issued / balance are SQLite REAL and better-sqlite3 binds
 * whatever JavaScript hands it, so without this a caller could write -500
 * (a wallet the guest can never spend, dragging every SUM(cover_issued) report
 * negative), Infinity (an unlimited bar tab — `amount > balance` is false for
 * every finite amount), 100.005 (sub-paise money that evaporates on the first
 * redemption) or the literal string 'free-drinks' into a REAL column.
 *
 * REJECT rather than clamp: silently turning a ₹-500 typo into ₹0 hands the
 * guest a dead pass at a cash till while the operator believes it was funded.
 */
function money(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} must be a finite number.`);
  if (n < 0) throw new Error(`${field} cannot be negative.`);
  const cap = walletAmountCap();
  if (n > cap) throw new Error(`${field} exceeds the per-wallet cap of ₹${cap}.`);
  return Math.round(n * 100) / 100; // paise resolution — the smallest unit that exists
}

/**
 * Resolve the cutoff hour for a wallet, honouring 0 (midnight).
 *
 * `ev.cutoff_hour || fallback` treated a legitimately-configured midnight
 * cutoff as "unset" and pushed every wallet on that event out to 02:00 — two
 * hours of bar credit the venue never intended to fund, and silent, because
 * the pass's "Valid until" label then reads 02:00 as if it were deliberate.
 * Out-of-range values are rejected too: computeExpiresAt happily accepts 26
 * and rolls the expiry into the following day.
 */
function validCutoffHour(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
}

export interface IssueWalletInput {
  name: string;
  phone: string;
  email?: string;
  pax?: number;
  entryFee: number;
  coverIssued?: number;
  paymentMethod: PaymentMethod;
  issuedBy: string;
  tableId?: string;
  eventId?: string;
  reservationId?: string;
}

export interface IssueWalletResult {
  txnId: string;
  pin: string;
  guestId: string;
  balance: number;
  expiresAt: number;
}

export async function issueWallet(input: IssueWalletInput): Promise<IssueWalletResult> {
  const db = getDb();
  const venueName = getConfig('VENUE_NAME', 'Venue');
  const pinLength = Number(getConfig('PIN_LENGTH', '6')) || 6;

  // Prefer event-specific date + cutoff; fall back to global config for backward compat.
  let eventDate = getConfig('EVENT_DATE');
  let cutoffHour = validCutoffHour(getConfig('EVENT_CUTOFF_HOUR', '2')) ?? 2;
  if (input.eventId) {
    const ev = getEvent(input.eventId);
    if (!ev) throw new Error(`Event ${input.eventId} not found`);
    eventDate = ev.event_date;
    cutoffHour = validCutoffHour(ev.cutoff_hour) ?? cutoffHour;
  }
  if (!eventDate) {
    throw new Error('EVENT_DATE is not set in config.');
  }
  const expiresAt = computeExpiresAt(eventDate, cutoffHour);

  const entryFee = money(input.entryFee, 'Entry fee');
  // Missing cover means NO cover, never the entry fee. entry_fee is the door
  // charge — revenue the venue has already earned — while cover_issued is a
  // liability the guest can spend at the bar. Defaulting one to the other
  // booked the same rupees twice and handed the guest their door charge back
  // as free drinks. An entry-only wallet has nothing to redeem, which is
  // exactly what /api/tickets already passes for a ₹0 pass.
  const coverIssued = money(input.coverIssued ?? 0, 'Cover');

  // One guest row per phone, not one per issuance. createTicket already
  // resolves guests this way; wallet issuance did not, so a weekly regular
  // accumulated a fresh guest_id every visit and both repeat-rate
  // implementations — which group by guest_id and call >=2 lifetime visits
  // "returning" — reported the entire walk-in door business as ~0% repeat.
  // Normalising first is what makes '9876543210' and '+919876543210' one human.
  // Falls back to the raw input when normalisation yields nothing, so an
  // unusual number is still stored rather than blanked.
  const phone = normalizePhone(input.phone) || input.phone.trim();

  // Resolve the table BEFORE the insert. attachWalletToTable is a bare UPDATE
  // with no existence check that neither throws nor reports when it matches
  // zero rows, and wallets.table_id has no foreign key — so an id from a stale
  // tab used to be written verbatim, leaving a wallet asserting a table the
  // floor board knew nothing about, with nothing logged. An unknown table is
  // dropped to NULL instead of stored as a lie: the wallet must still issue
  // (the cash is already in the drawer), but the drop is audited below.
  // (Read directly rather than via tables.ts, which exports no single-table
  // getter — listTables() would pull the whole floor plan for one lookup.)
  let tableId: string | null = null;
  let droppedTableId: string | null = null;
  if (input.tableId) {
    const exists = db.prepare('SELECT 1 FROM venue_tables WHERE id = ?').get(input.tableId);
    if (exists) tableId = input.tableId;
    else droppedTableId = input.tableId;
  }

  let guestId = nanoid();
  const txnId = generateTxnId(venueName);
  const pin = generatePin(pinLength);
  const pinHash = await hashPin(pin);
  // Recoverable copy for the admin-only "reveal PIN" flow. Returns null when
  // WALLET_PIN_ENC_KEY isn't set — we store NULL rather than a fake-encrypted
  // value, so the admin UI can honestly report the PIN as unrecoverable
  // instead of implying it could be shown. Redemption never reads this.
  const pinEnc = encryptPin(pin);
  const now = Date.now();

  const tx = db.transaction(() => {
    const existingGuest = db.prepare(
      'SELECT id FROM guests WHERE phone = ? ORDER BY created_at DESC LIMIT 1',
    ).get(phone) as { id: string } | undefined;

    if (existingGuest) {
      guestId = existingGuest.id;
      // Refresh the details the operator just captured. wallets has no name
      // column — every screen that shows a guest name for a wallet reads it
      // through this join — so the row has to carry the name that was typed
      // for THIS wallet. The name at issue time stays pinned in the
      // issue_wallet audit row below, so history is not rewritten.
      db.prepare(
        'UPDATE guests SET name = ?, email = COALESCE(?, email), pax = ? WHERE id = ?',
      ).run(input.name, input.email || null, input.pax || 1, guestId);
    } else {
      db.prepare(`
        INSERT INTO guests (id, name, phone, email, pax, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(guestId, input.name, phone, input.email || null, input.pax || 1, 'walk_in', now);
    }

    db.prepare(`
      INSERT INTO wallets (
        txn_id, guest_id, entry_fee, cover_issued, balance,
        payment_method, pin_hash, pin_enc, status, issued_by, issued_at, expires_at,
        table_id, event_id, reservation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
    `).run(
      txnId, guestId, entryFee, coverIssued, coverIssued,
      input.paymentMethod, pinHash, pinEnc, input.issuedBy, now, expiresAt,
      tableId,
      input.eventId || null,
      input.reservationId || null,
    );

    // Both side effects run INSIDE the money transaction on purpose.
    //
    // markReservationConverted now refuses to repoint a reservation that is
    // already converted to a DIFFERENT wallet. That guard is only worth
    // anything if its rejection also undoes the wallet: there is no unique
    // index on wallets.reservation_id and no idempotency key on
    // POST /api/wallets, so a slow response plus an operator re-tap used to
    // mint a second funded wallet with a second live PIN against one booking.
    // Committing the wallet first and then swallowing the failure — which is
    // what the old post-commit try/catch did — would leave exactly the
    // double-funded state the guard exists to prevent.
    if (tableId) attachWalletToTable(tableId, txnId);
    if (input.reservationId) markReservationConverted(input.reservationId, txnId);

    logAudit({
      actor: input.issuedBy,
      action: 'issue_wallet',
      entityType: 'wallet',
      entityId: txnId,
      details: {
        entry: entryFee, cover: coverIssued, pax: input.pax || 1,
        method: input.paymentMethod, guest: input.name, phone,
        event_date: eventDate, expires_at: expiresAt, cutoff_hour: cutoffHour,
        event_id: input.eventId || null, reservation_id: input.reservationId || null,
        table_id: tableId,
        // Non-null only when the operator picked a table that no longer
        // exists; recorded so the divergence is answerable later.
        dropped_table_id: droppedTableId,
      },
    });
  });
  tx();

  return { txnId, pin, guestId, balance: coverIssued, expiresAt };
}

/**
 * The ONLY place a wallet goes active→expired.
 *
 * Two code paths expire wallets — this sweep and the redeem path in
 * redemption.ts — and whichever fires first wins. The redeem path used to flip
 * the status with a bare UPDATE and log only `redeem_blocked_expired`, which
 * records expires_at but NOT the balance that lapsed. Once flipped, the sweep
 * could never fill the gap because it only selects status='active', so the
 * breakage figure the venue wants to recognise was lost forever. Routing both
 * through here guarantees a `wallet_expired` row carrying balance_at_expiry.
 *
 * The `AND status = 'active'` in the UPDATE makes this safe to call twice:
 * whoever loses the race changes zero rows and writes no duplicate audit row.
 */
export function expireWallet(
  txnId: string,
  expiresAt: number | null,
  balanceAtExpiry: number,
  actor = 'system',
): boolean {
  const db = getDb();
  const result = db
    .prepare("UPDATE wallets SET status = 'expired' WHERE txn_id = ? AND status = 'active'")
    .run(txnId);
  if (result.changes === 0) return false;

  logAudit({
    actor,
    action: 'wallet_expired',
    entityType: 'wallet',
    entityId: txnId,
    details: { expires_at: expiresAt, balance_at_expiry: balanceAtExpiry },
  });
  return true;
}

/**
 * Rebuild the expiry a wallet SHOULD have had, for rows whose expires_at is NULL.
 *
 * NULL is not a "never expires" product feature — nothing can create one
 * (issueWallet always computes a number and computeExpiresAt throws without an
 * event date), so it is orphaned data. But sweepExpired's predicate required
 * `expires_at IS NOT NULL` and isExpired() returns false for null, which made
 * such a wallet permanently 'active', permanently redeemable, and a permanent
 * inflation of the active-liability reading. The venue has one live today
 * (DEM-0424-EHLVT, ₹1,000, issued April) that anyone holding the QR + PIN can
 * still spend.
 *
 * The rebuilt value is the same rule every other wallet follows: the IST
 * event-night that issued_at falls inside (defaultEventDate rewinds to the
 * previous day for a 1 a.m. issuance, which is exactly the wallet's own
 * event), plus that event's cutoff hour. Returns null when nothing can be
 * derived, in which case the row is left strictly alone rather than guessed at.
 */
function deriveExpiresAt(issuedAt: number, eventId: string | null): number | null {
  try {
    if (!Number.isFinite(issuedAt)) return null;
    const ev = eventId ? getEvent(eventId) : null;
    const cutoffHour =
      validCutoffHour(ev?.cutoff_hour) ?? validCutoffHour(getConfig('EVENT_CUTOFF_HOUR', '2')) ?? 2;
    const eventDate = ev?.event_date || defaultEventDate(cutoffHour, new Date(issuedAt));
    return computeExpiresAt(eventDate, cutoffHour);
  } catch {
    return null;
  }
}

/**
 * Sweep stale active wallets whose expires_at has passed, marking them 'expired'.
 * Runs once per list/lookup call. Keeps DB state in sync with the clock.
 *
 * Auditing: each wallet that transitions active→expired writes a `wallet_expired`
 * audit row. The status change is silent to the customer but must be traceable so
 * the admin can answer "my cover was still alive when I tried to redeem" disputes.
 * Actor is logged as 'system' since no human triggered it.
 *
 * NULL expires_at is picked up too (see deriveExpiresAt) and the derived value
 * is backfilled onto the row, so isExpired(), the "Valid until" label and the
 * redeem path all agree with the sweep instead of disagreeing forever.
 */
export function sweepExpired(): number {
  const db = getDb();
  const now = Date.now();
  const candidates = db.prepare(`
    SELECT txn_id, balance, expires_at, issued_at, event_id
    FROM wallets
    WHERE status = 'active'
      AND (expires_at IS NULL OR expires_at <= ?)
  `).all(now) as {
    txn_id: string; balance: number; expires_at: number | null;
    issued_at: number; event_id: string | null;
  }[];

  if (candidates.length === 0) return 0;

  let swept = 0;
  const tx = db.transaction(() => {
    for (const w of candidates) {
      let expiresAt = w.expires_at;

      if (expiresAt == null) {
        const derived = deriveExpiresAt(w.issued_at, w.event_id);
        if (derived == null) continue; // undecidable — leave the row untouched
        db.prepare('UPDATE wallets SET expires_at = ? WHERE txn_id = ?').run(derived, w.txn_id);
        logAudit({
          actor: 'system',
          action: 'wallet_expiry_backfilled',
          entityType: 'wallet',
          entityId: w.txn_id,
          details: { derived_expires_at: derived, issued_at: w.issued_at, event_id: w.event_id },
        });
        expiresAt = derived;
        if (expiresAt > now) continue; // now has a real expiry, just not due yet
      }

      if (expireWallet(w.txn_id, expiresAt, w.balance)) swept += 1;
    }
  });
  tx();

  return swept;
}

/**
 * Void an active wallet — used by admin to refund / write off a cover.
 *
 * Forces balance to 0 and marks the wallet 'exhausted' (semantically "no longer
 * spendable"). Emits a critical `wallet_void` audit row so the action is
 * unmistakable on the History page. If a refund amount is recorded it's logged
 * in the details payload.
 *
 * Returns true if a state change happened, false if the wallet was already
 * inactive (no-op, no audit).
 */
export function voidWallet(
  txnId: string,
  actor: string,
  opts: { reason?: string; refundAmount?: number } = {},
): boolean {
  const db = getDb();
  const wallet = db.prepare(`
    SELECT balance, status, cover_issued, guest_id
    FROM wallets WHERE txn_id = ?
  `).get(txnId) as { balance: number; status: string; cover_issued: number; guest_id: string } | undefined;

  if (!wallet) return false;
  if (wallet.status !== 'active') return false;

  const balanceBefore = wallet.balance;

  db.prepare(`
    UPDATE wallets
    SET balance = 0, status = 'exhausted', pin_fail_count = 0, pin_locked_until = NULL
    WHERE txn_id = ?
  `).run(txnId);

  logAudit({
    actor,
    action: 'wallet_void',
    entityType: 'wallet',
    entityId: txnId,
    details: {
      balance_before: balanceBefore,
      balance_after: 0,
      cover_issued: wallet.cover_issued,
      refund_amount: opts.refundAmount ?? balanceBefore,
      reason: opts.reason ?? null,
    },
  });

  return true;
}

export function lookupWallet(txnId: string): WalletWithGuest | null {
  sweepExpired();
  const db = getDb();
  const row = db.prepare(`
    SELECT w.*, g.name, g.phone, g.email
    FROM wallets w
    JOIN guests g ON g.id = w.guest_id
    WHERE w.txn_id = ?
  `).get(txnId) as WalletWithGuest | undefined;
  return row ?? null;
}

/**
 * A wallet row safe to hand to a list view — everything in WalletWithGuest
 * except the two secret-bearing columns.
 *
 * `pin_hash` is bcrypt (offline-crackable: a 6-digit PIN falls in seconds
 * against a single targeted wallet) and `pin_enc` is reversible AES-GCM.
 * Neither has any business leaving the server for a list, so they are
 * projected out in SQL rather than deleted afterwards — a `SELECT w.*` here
 * silently re-exports every future secret column somebody adds to `wallets`,
 * which is exactly how pin_enc leaked the day it was introduced.
 */
export type WalletListItem = Omit<WalletWithGuest, 'pin_hash'>;

export function listWallets(limit = 200): WalletListItem[] {
  sweepExpired();
  const db = getDb();
  return db.prepare(`
    SELECT w.txn_id, w.guest_id, w.entry_fee, w.cover_issued, w.balance,
           w.payment_method, w.pin_fail_count, w.pin_locked_until, w.status,
           w.issued_by, w.issued_at, w.checked_out_at, w.expires_at,
           g.name, g.phone, g.email
    FROM wallets w
    JOIN guests g ON g.id = w.guest_id
    ORDER BY w.issued_at DESC
    LIMIT ?
  `).all(limit) as WalletListItem[];
}
