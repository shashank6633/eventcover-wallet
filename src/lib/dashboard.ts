import { getDb } from './db';
import { sweepExpired } from './wallet';
import type { DashboardKpis, PaymentMethod } from './types';

/**
 * Largest value we will accept as a real rupee amount in an aggregate.
 *
 * SQLite stores money as REAL, so a single row holding Infinity (or a wildly
 * out-of-range number) makes SUM() return Infinity for the WHOLE table — and
 * JSON.stringify(Infinity) serialises to `null`, so the browser receives null
 * for every dependent KPI and the consumer (/admin/hosts calls
 * `stats.totalCoverIssued.toLocaleString(...)`) throws outright. One bad write
 * would poison every cover figure venue-wide, permanently, until the row was
 * surgically deleted.
 *
 * The real fix belongs at the write side, but a report must not be able to
 * die because of one corrupt row, so the aggregates below skip anything
 * outside [0, MONEY_CEILING]. ₹1e12 is six orders of magnitude above any
 * plausible night's takings, so no legitimate amount is ever excluded.
 */
const MONEY_CEILING = 1e12;

/** Guard for values derived in JS (division, subtraction) — never emit NaN/Infinity. */
function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

/**
 * SQL fragment: sum `expr`, ignoring rows whose value is not a sane rupee
 * amount. `expr` must be a literal column/expression written here in this
 * file — it is interpolated, never derived from a request.
 */
function sane(expr: string): string {
  return `COALESCE(SUM(CASE WHEN (${expr}) >= 0 AND (${expr}) <= ${MONEY_CEILING} THEN (${expr}) ELSE 0 END), 0)`;
}

export function computeDashboard(): DashboardKpis {
  sweepExpired();
  const db = getDb();

  const walletAgg = db.prepare(`
    SELECT
      ${sane('entry_fee')}    AS entry_total,
      ${sane('cover_issued')} AS cover_total,
      -- Outstanding bar liability: what guests can still actually spend.
      -- Only 'active' wallets qualify — see the unredeemed note below.
      ${sane("CASE WHEN status = 'active' THEN balance ELSE 0 END")} AS active_balance,
      COUNT(*) AS issued_count,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END) AS exhausted_count,
      SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired_count
    FROM wallets
  `).get() as {
    entry_total: number; cover_total: number; active_balance: number; issued_count: number;
    active_count: number; exhausted_count: number; expired_count: number;
  };

  const redeemAgg = db.prepare(`
    SELECT
      ${sane('amount')} AS redeemed_total,
      COUNT(*) AS redemption_count
    FROM redemptions
    WHERE status = 'success'
  `).get() as { redeemed_total: number; redemption_count: number };

  const payRows = db.prepare(`
    SELECT payment_method, ${sane('entry_fee')} AS amount, COUNT(*) AS count
    FROM wallets
    GROUP BY payment_method
  `).all() as { payment_method: PaymentMethod; amount: number; count: number }[];

  const paymentMix: Record<PaymentMethod, { amount: number; count: number }> = {
    cash: { amount: 0, count: 0 },
    upi: { amount: 0, count: 0 },
    card: { amount: 0, count: 0 },
    online: { amount: 0, count: 0 },
    comp: { amount: 0, count: 0 },
  };
  for (const r of payRows) {
    if (paymentMix[r.payment_method]) {
      paymentMix[r.payment_method] = { amount: finite(r.amount) || 0, count: r.count || 0 };
    }
  }

  const cover = finite(walletAgg.cover_total);
  const redeemed = finite(redeemAgg.redeemed_total);

  return {
    totalEntryFees: finite(walletAgg.entry_total),
    totalCoverIssued: cover,
    totalRedeemed: redeemed,
    /**
     * OUTSTANDING BAR LIABILITY — cover the venue still owes the bar, read off
     * wallets.balance rather than derived as (issued − redeemed).
     *
     * The old formula was SUM(cover_issued) − SUM(redemptions.amount), which is
     * lifetime issuance-minus-spend, not a balance, and silently mixed three
     * different kinds of money:
     *   • live credit   — genuinely still spendable        (should count)
     *   • lapsed credit — expired wallets; already breakage (should NOT count)
     *   • refunds       — voidWallet() zeroes balance without writing a
     *                     redemption row, so refunded money stayed on the
     *                     "still owed" line forever          (should NOT count)
     * On this venue's live data that read 36,400 when only 1,000 was actually
     * spendable, 29,400 had lapsed, and 6,000 had been refunded in cash — a
     * 36x overstatement of liability.
     *
     * Only 'active' wallets can be redeemed against (redemption.ts refuses any
     * other status), which is exactly why the status filter defines liability.
     */
    unredeemed: +finite(walletAgg.active_balance).toFixed(2),
    redemptionRate: cover > 0 ? finite(Math.round((redeemed / cover) * 1000) / 10) : 0,
    walletsIssued: walletAgg.issued_count || 0,
    walletsActive: walletAgg.active_count || 0,
    walletsExhausted: walletAgg.exhausted_count || 0,
    walletsExpired: walletAgg.expired_count || 0,
    redemptionCount: redeemAgg.redemption_count || 0,
    paymentMix,
  };
}
