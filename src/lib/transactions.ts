/**
 * Transaction register — the source of truth for the History page.
 *
 * Unions four streams into one ledger so an operator can see every entry &
 * cover-charge movement in date order:
 *
 *   1. Wallet issuances  — money IN at the door  (Transaction = "Entry & Cover")
 *   2. Redemptions       — cover spent at bar    (Transaction = "Cover Redemption")
 *   3. Voids / refunds   — money OUT             (Transaction = "Cover Void / Refund")
 *   4. Reservation cover — the second, separate redemption ledger
 *                                                (Transaction = "Reservation Cover Redeem")
 *
 * Why 3 is its own stream and not just a status on the issuance row:
 * a void is a money movement that happens on its OWN date. Decorating the
 * issuance row means a wallet issued Monday and refunded Wednesday appears
 * nowhere at all in Wednesday's view, and looks like a plain 'Exhausted'
 * (i.e. a guest who drank it all) in Monday's. A refund could be issued and
 * reconciled away without ever surfacing. The issuance row still carries the
 * 'Voided' status so the wallet's CURRENT state is visible from any window —
 * that lookup is now keyed on the wallets in the result set rather than on the
 * report window, because the wallet is voided regardless of when you look.
 *
 * Why 4 exists: reservation cover redemptions live in `cover_redemptions`
 * (see cover-redemption.ts), a completely separate table from `redemptions`.
 * Every report in this codebase reads only `redemptions`, so money debited on
 * the reservation path was invisible to the register. It is surfaced here as
 * its own kind, with its own totals bucket — deliberately NOT merged into
 * redemptions_amount, because the two ledgers are not yet reconciled and
 * silently adding them would double-count the day someone bridges a
 * reservation to a wallet. NOTE: cashier.ts (shift settlement) and
 * analytics.ts still read `redemptions` only — this makes the money visible,
 * it does not make it settleable.
 */
import { getDb } from './db';

export type TxnKind = 'entry' | 'redemption' | 'void' | 'reservation_redemption';

export type TxnStatus =
  | 'Active'      // wallet still has balance
  | 'Exhausted'   // wallet fully redeemed
  | 'Expired'     // wallet hit expires_at
  | 'Voided'      // admin force-voided the wallet (refund)
  | 'Pending'     // redemption not yet settled by cashier
  | 'Settled'     // redemption settled
  | 'Reversed';   // redemption was reversed

export interface TransactionRow {
  /** Stable row id used for the Action column. */
  id: string;
  /** 'entry' = wallet issuance row, 'redemption' = bar redemption row. */
  kind: TxnKind;
  /** Customer-facing receipt number. Wallets use txn_id; redemptions use FB{rowid}. */
  invoice_no: string;
  /** ₹ amount for the transaction. */
  amount: number;
  /** Staff who handled it — issuer at the door for entries, captain at bar for redemptions. */
  redeemed_by: string;
  /** Joined customer info from guests table. */
  customer_name: string;
  customer_phone: string;
  /** Transaction timestamp (UTC ms). */
  created_at: number;
  /** Display label for the Transaction column. */
  transaction_type: string;
  /** Current state — drives the Status pill and the available Actions. */
  status: TxnStatus;
  /** Wallet txn_id this row belongs to. Lets the UI pivot to the full lifecycle. */
  wallet_txn_id: string;
  /** Extra context the UI may want — payment method, balance, etc. */
  payment_method?: string;
  balance?: number;
  cover_issued?: number;
  /** Door charge on an entry row. `amount` is entry_fee + cover_issued. */
  entry_fee?: number;
  expires_at?: number | null;
  /** Settlement metadata (only for redemption rows). */
  settled_by?: string | null;
  settled_at?: number | null;
}

export interface TransactionFilters {
  /** Inclusive UTC ms — defaults to last 7 days at the API layer. */
  from: number;
  /** Exclusive UTC ms. */
  to: number;
  /** Limit to a single kind. Omit = both. */
  kind?: TxnKind;
  /** Captain name (matches `redeemed_by`). 'all' or omit = no filter. */
  redeemedBy?: string;
  /** Free-text search across invoice / customer / phone / staff. */
  search?: string;
  /** Hard cap for safety. Defaults applied at API layer. */
  limit?: number;
}

export interface TransactionListResult {
  rows: TransactionRow[];
  /** Distinct staff names in the period — used for the "Redeem By" dropdown. */
  staff: string[];
  /** Roll-ups for the page header strip. */
  totals: {
    entries_count: number;
    /** Money COLLECTED at the door: entry_fee + cover_issued. */
    entries_amount: number;
    redemptions_count: number;
    redemptions_amount: number;
    settled_amount: number;
    pending_amount: number;
    /** Voids/refunds that HAPPENED in this range (not "wallets that are voided"). */
    voided_count: number;
    /** ₹ refunded by those voids. */
    voided_amount: number;
    reversed_count: number;
    /** Reservation-cover ledger — kept separate; see the file header. */
    reservation_redemptions_count: number;
    reservation_redemptions_amount: number;
  };
}

/**
 * Make sure every redemption has an invoice_no stamped on it.
 * Identical pattern to cashier.ts — the FB prefix + rowid gives a stable,
 * monotonic invoice number that won't shift if rows are added.
 *
 * Two deliberate properties:
 *
 *  • NOT window-scoped. The value is a pure function of rowid, so stamping is
 *    order-independent either way — but scoping it to the report window meant
 *    the same redemption showed FB{rowid} on the cashier screen and the
 *    `FB{id-suffix}` fallback on History until somebody happened to open the
 *    right date range. One unscoped pass converges immediately.
 *
 *  • Guarded by a cheap existence probe so this read path only writes when
 *    there is genuinely something to stamp. Once converged, /api/transactions
 *    is a pure read. (The correct home for this is redeemWallet()'s INSERT,
 *    in redemption.ts — until it moves there, this keeps History and the
 *    cashier agreeing on one invoice number.)
 */
function backfillInvoiceNumbers() {
  const db = getDb();
  const pending = db.prepare(
    `SELECT 1 FROM redemptions WHERE invoice_no IS NULL LIMIT 1`,
  ).get();
  if (!pending) return;
  db.prepare(
    `UPDATE redemptions SET invoice_no = 'FB' || rowid WHERE invoice_no IS NULL`,
  ).run();
}

function mapWalletStatus(s: string): TxnStatus {
  // Wallet voids go through voidWallet() which marks status='exhausted' AND
  // emits a wallet_void audit row. We treat 'exhausted with cover_issued > 0
  // and zero redemptions' as not-quite-voided; the source of truth for "Voided"
  // is the audit log lookup below.
  switch (s) {
    case 'active':    return 'Active';
    case 'exhausted': return 'Exhausted';
    case 'expired':   return 'Expired';
    default:          return 'Active';
  }
}

/**
 * Inspect audit_log to flip the wallet status to 'Voided' when a wallet_void
 * event exists for the txn_id.
 *
 * Keyed on the WALLETS IN THE RESULT SET, not on the report window. A wallet
 * voided last week is still voided when you look at the day it was issued; the
 * old window-bounded lookup required the issue AND the void to fall inside the
 * same filter, so a cross-day void rendered as a plain 'Exhausted' — visually
 * identical to a guest who drank the whole balance.
 */
function loadVoidedTxnIds(txnIds: string[]): Set<string> {
  if (txnIds.length === 0) return new Set();
  const db = getDb();
  const placeholders = txnIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT DISTINCT entity_id
    FROM audit_log
    WHERE action = 'wallet_void'
      AND entity_type = 'wallet'
      AND entity_id IN (${placeholders})
  `).all(...txnIds) as { entity_id: string }[];
  return new Set(rows.map((r) => r.entity_id));
}

/** Audit `details` is TEXT holding JSON; a malformed row must not kill the register. */
function parseDetails(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function mapRedemptionStatus(status: string, settled: number | null): TxnStatus {
  if (status === 'reversed') return 'Reversed';
  return settled ? 'Settled' : 'Pending';
}

export function listTransactions(filters: TransactionFilters): TransactionListResult {
  backfillInvoiceNumbers();
  const db = getDb();
  const limit = Math.min(5000, Math.max(50, filters.limit ?? 1000));
  // A void is an alteration of an entry, so it rides with the "Entries" tab
  // rather than with "Redeems".
  const wantEntrySide = filters.kind !== 'redemption';
  const wantRedeemSide = filters.kind !== 'entry';

  // ─── Entries (wallet issuances) ────────────────────────────────────────
  const entryRows = !wantEntrySide
    ? []
    : db.prepare(`
        SELECT
          w.txn_id, w.cover_issued, w.entry_fee, w.balance, w.payment_method,
          w.status, w.issued_by, w.issued_at, w.expires_at,
          g.name AS customer_name, g.phone AS customer_phone
        FROM wallets w
        LEFT JOIN guests g ON g.id = w.guest_id
        WHERE w.issued_at >= ? AND w.issued_at < ?
        ORDER BY w.issued_at DESC
        LIMIT ?
      `).all(filters.from, filters.to, limit) as Array<{
        txn_id: string; cover_issued: number; entry_fee: number; balance: number;
        payment_method: string; status: string; issued_by: string | null; issued_at: number;
        expires_at: number | null;
        customer_name: string | null; customer_phone: string | null;
      }>;

  // ─── Redemptions (cover spent at bar) ──────────────────────────────────
  const redemptionRows = !wantRedeemSide
    ? []
    : db.prepare(`
        SELECT
          r.id, r.invoice_no, r.amount, r.captain, r.status, r.created_at,
          r.settled, r.settled_by, r.settled_at, r.txn_id,
          w.cover_issued, w.expires_at,
          g.name AS customer_name, g.phone AS customer_phone
        FROM redemptions r
        LEFT JOIN wallets w ON w.txn_id = r.txn_id
        LEFT JOIN guests  g ON g.id     = w.guest_id
        WHERE r.created_at >= ? AND r.created_at < ?
        ORDER BY r.created_at DESC
        LIMIT ?
      `).all(filters.from, filters.to, limit) as Array<{
        id: string; invoice_no: string | null; amount: number; captain: string;
        status: string; created_at: number;
        settled: number | null; settled_by: string | null; settled_at: number | null;
        txn_id: string; cover_issued: number | null; expires_at: number | null;
        customer_name: string | null; customer_phone: string | null;
      }>;

  // ─── Voids / refunds (money OUT, on the date it actually happened) ─────
  const voidEventRows = !wantEntrySide
    ? []
    : db.prepare(`
        SELECT
          a.id, a.timestamp, a.actor, a.entity_id, a.details,
          w.cover_issued, w.entry_fee, w.expires_at,
          g.name AS customer_name, g.phone AS customer_phone
        FROM audit_log a
        LEFT JOIN wallets w ON w.txn_id = a.entity_id
        LEFT JOIN guests  g ON g.id     = w.guest_id
        WHERE a.action = 'wallet_void'
          AND a.entity_type = 'wallet'
          AND a.entity_id IS NOT NULL
          AND a.timestamp >= ? AND a.timestamp < ?
        ORDER BY a.timestamp DESC
        LIMIT ?
      `).all(filters.from, filters.to, limit) as Array<{
        id: number; timestamp: number; actor: string; entity_id: string; details: string | null;
        cover_issued: number | null; entry_fee: number | null; expires_at: number | null;
        customer_name: string | null; customer_phone: string | null;
      }>;

  // ─── Reservation cover redemptions (the second ledger) ─────────────────
  const reservationRedemptionRows = !wantRedeemSide
    ? []
    : db.prepare(`
        SELECT
          cr.id, cr.bill_id, cr.redeemed_amount, cr.redeemed_by, cr.status, cr.timestamp,
          cr.reservation_id,
          r.name AS customer_name, r.phone AS customer_phone
        FROM cover_redemptions cr
        LEFT JOIN reservations r ON r.id = cr.reservation_id
        WHERE cr.timestamp >= ? AND cr.timestamp < ?
        ORDER BY cr.timestamp DESC
        LIMIT ?
      `).all(filters.from, filters.to, limit) as Array<{
        id: string; bill_id: string | null; redeemed_amount: number; redeemed_by: string;
        status: string; timestamp: number; reservation_id: string;
        customer_name: string | null; customer_phone: string | null;
      }>;

  const voided = loadVoidedTxnIds(entryRows.map((w) => w.txn_id));

  // ─── Project into TransactionRow ───────────────────────────────────────
  const rows: TransactionRow[] = [];

  for (const w of entryRows) {
    const status = voided.has(w.txn_id) ? 'Voided' : mapWalletStatus(w.status);
    rows.push({
      id: `entry:${w.txn_id}`,
      kind: 'entry',
      invoice_no: w.txn_id,
      // Money COLLECTED at the door. The row is labelled "Entry & Cover" and
      // feeds the cashier's drawer reconciliation, so it must be the whole
      // sum taken from the guest — showing cover_issued alone made a ₹3,000
      // wallet (₹1,000 entry + ₹2,000 cover) read as ₹2,000 and left the
      // drawer short by the entry fee on every wallet that carried one.
      amount: w.entry_fee + w.cover_issued,
      redeemed_by: w.issued_by || '—',
      customer_name: w.customer_name || '—',
      customer_phone: w.customer_phone || '—',
      created_at: w.issued_at,
      transaction_type: 'Entry & Cover',
      status,
      wallet_txn_id: w.txn_id,
      payment_method: w.payment_method,
      balance: w.balance,
      cover_issued: w.cover_issued,
      entry_fee: w.entry_fee,
      expires_at: w.expires_at,
    });
  }

  for (const v of voidEventRows) {
    const d = parseDetails(v.details);
    // voidWallet() logs refund_amount (defaulting to balance_before). That is
    // the money actually handed back, which is what has to be reconciled.
    const refunded = d.refund_amount != null ? num(d.refund_amount) : num(d.balance_before);
    rows.push({
      id: `void:${v.id}`,
      kind: 'void',
      invoice_no: v.entity_id,
      amount: refunded,
      redeemed_by: v.actor || '—',
      customer_name: v.customer_name || '—',
      customer_phone: v.customer_phone || '—',
      created_at: v.timestamp,
      transaction_type: 'Cover Void / Refund',
      status: 'Voided',
      wallet_txn_id: v.entity_id,
      cover_issued: v.cover_issued ?? num(d.cover_issued),
      entry_fee: v.entry_fee ?? undefined,
      expires_at: v.expires_at,
    });
  }

  for (const c of reservationRedemptionRows) {
    rows.push({
      id: `resredeem:${c.id}`,
      kind: 'reservation_redemption',
      invoice_no: c.bill_id || `RC${c.id.slice(-6)}`,
      amount: c.redeemed_amount,
      redeemed_by: c.redeemed_by || '—',
      customer_name: c.customer_name || '—',
      customer_phone: c.customer_phone || '—',
      created_at: c.timestamp,
      transaction_type: 'Reservation Cover Redeem',
      // 'Pending' is literally true: the cashier's settlement queue reads
      // `redemptions` only, so nothing on this ledger can ever be settled.
      status: c.status === 'reversed' ? 'Reversed' : 'Pending',
      // Not a wallet — the reservation id is the entity this row belongs to.
      wallet_txn_id: c.reservation_id,
    });
  }

  for (const r of redemptionRows) {
    rows.push({
      id: `redeem:${r.id}`,
      kind: 'redemption',
      invoice_no: r.invoice_no ?? `FB${r.id.slice(-6)}`,
      amount: r.amount,
      redeemed_by: r.captain,
      customer_name: r.customer_name || '—',
      customer_phone: r.customer_phone || '—',
      created_at: r.created_at,
      transaction_type: 'Cover Redemption',
      status: mapRedemptionStatus(r.status, r.settled),
      wallet_txn_id: r.txn_id,
      cover_issued: r.cover_issued ?? 0,
      expires_at: r.expires_at,
      settled_by: r.settled_by,
      settled_at: r.settled_at,
    });
  }

  // ─── Filters applied in JS so the SQL stays simple ─────────────────────
  let filtered = rows;
  if (filters.redeemedBy && filters.redeemedBy !== 'all') {
    filtered = filtered.filter((r) => r.redeemed_by === filters.redeemedBy);
  }
  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase();
    filtered = filtered.filter((r) =>
      r.invoice_no.toLowerCase().includes(q) ||
      r.customer_name.toLowerCase().includes(q) ||
      r.customer_phone.toLowerCase().includes(q) ||
      r.redeemed_by.toLowerCase().includes(q) ||
      r.wallet_txn_id.toLowerCase().includes(q) ||
      String(r.amount).includes(q),
    );
  }

  // Sort: newest first
  filtered.sort((a, b) => b.created_at - a.created_at);

  // ─── Totals ────────────────────────────────────────────────────────────
  const totals = {
    entries_count: 0, entries_amount: 0,
    redemptions_count: 0, redemptions_amount: 0,
    settled_amount: 0, pending_amount: 0,
    voided_count: 0, voided_amount: 0, reversed_count: 0,
    reservation_redemptions_count: 0, reservation_redemptions_amount: 0,
  };
  for (const r of filtered) {
    switch (r.kind) {
      case 'entry':
        totals.entries_count++;
        totals.entries_amount += r.amount;
        // voided_count is counted off the void EVENT rows below, not off the
        // 'Voided' status here. The status says "this wallet is voided"
        // (true from any window); the event says "a refund happened in this
        // range", which is what the page's "N alterations in this range"
        // banner claims. Counting both would double-count a same-day void.
        break;
      case 'void':
        totals.voided_count++;
        totals.voided_amount += r.amount;
        break;
      case 'reservation_redemption':
        totals.reservation_redemptions_count++;
        if (r.status !== 'Reversed') totals.reservation_redemptions_amount += r.amount;
        break;
      default:
        totals.redemptions_count++;
        totals.redemptions_amount += r.amount;
        if (r.status === 'Settled')  totals.settled_amount += r.amount;
        if (r.status === 'Pending')  totals.pending_amount += r.amount;
        if (r.status === 'Reversed') totals.reversed_count++;
    }
  }

  // ─── Distinct staff list (across both streams) ─────────────────────────
  const staffSet = new Set<string>();
  for (const r of rows) if (r.redeemed_by && r.redeemed_by !== '—') staffSet.add(r.redeemed_by);
  const staff = Array.from(staffSet).sort();

  return { rows: filtered, staff, totals };
}

/**
 * CSV export — matches the column order the operator sees on screen.
 */
export function transactionsToCsv(rows: TransactionRow[]): string {
  const head = [
    'Invoice No', 'Amount', 'Entry Fee', 'Cover Issued', 'Redeem By',
    'Customer Name', 'Customer Mobile',
    'Date & Time', 'Transaction', 'Status', 'Wallet Txn', 'Settled By', 'Settled At',
  ];
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const fmtDate = (ms: number) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      r.invoice_no, r.amount,
      // Split shown alongside the total so a reconciler can see WHY the
      // "Entry & Cover" amount is what it is.
      r.kind === 'entry' ? r.entry_fee ?? '' : '',
      r.kind === 'entry' ? r.cover_issued ?? '' : '',
      r.redeemed_by, r.customer_name, r.customer_phone,
      fmtDate(r.created_at), r.transaction_type, r.status, r.wallet_txn_id,
      r.settled_by ?? '', r.settled_at ? fmtDate(r.settled_at) : '',
    ].map(esc).join(','));
  }
  return lines.join('\n');
}
