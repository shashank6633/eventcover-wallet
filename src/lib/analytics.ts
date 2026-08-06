/**
 * Analytics aggregation — drives /admin/analytics.
 *
 * Two parallel scopes:
 *   1. Lifetime  — every wallet / ticket / redemption ever created
 *   2. Range     — same KPIs scoped to a from/to window (defaults to today's shift)
 *
 * Plus a flat transaction feed (Issue / Redeem / Ticket events) with the same
 * columns as the screenshot reference:
 *   Invoice No · Customer Name · Customer Ph.no · Amount · Timestamp · Txn ·
 *   Payment Mode · Employee Name · Action
 */
import { getDb } from './db';
import { sweepExpired } from './wallet';
import type { PaymentMethod } from './types';

export interface AnalyticsKpis {
  totalCustomers: number;
  totalIncoming: number;
  totalCoverCharge: number;
  amountIssued: number;
  topUpsPreload: number;     // placeholder — not yet implemented; always 0
  totalRedeems: number;
  leftOver: number;
  editedAmount: number;
  paymentBreakdown: {
    online: number;
    cash: number;
    card: number;
    upi: number;
    ticket: number;
  };
}

export type AnalyticsTxnKind = 'Issue' | 'Redeem' | 'Top Up' | 'Ticket' | 'Void';

export interface AnalyticsTxnRow {
  id: string;                   // composite, e.g. 'issue:SKY-…' or 'redeem:rd_…'
  invoice_no: string;
  customer_name: string;
  customer_phone: string;
  amount: number;
  timestamp: number;
  kind: AnalyticsTxnKind;       // 'Issue' / 'Redeem' / 'Ticket' / 'Void'
  payment_mode: string;         // CASH / UPI / CARD / ONLINE / COMP / TICKET / —
  employee_name: string;
  /** Underlying wallet/ticket id used by the row's Action button (delete/void). */
  entity_ref: string;
  entity_type: 'wallet' | 'redemption' | 'ticket';
}

export interface AnalyticsFilters {
  /** UTC ms inclusive. Omit both for lifetime. */
  from?: number;
  /** UTC ms exclusive. */
  to?: number;
  /** Free text — invoice, name, phone, amount. */
  search?: string;
  /** Employee name (issued_by / captain / ticket created_by). */
  employee?: string;
  /** Max rows in the transaction feed. */
  limit?: number;
}

export interface AnalyticsResult {
  lifetime: AnalyticsKpis;
  range: AnalyticsKpis;
  transactions: AnalyticsTxnRow[];
  /** Distinct employee names — drives the dropdown. */
  employees: string[];
  /** Echoes the resolved range so the UI can render it. */
  rangeFrom: number;
  rangeTo: number;
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Money columns are SQLite REAL, so a plain SUM of fractional covers returns
 * things like 4367.339999999999. The KPI tiles format for display and hide it,
 * but the raw JSON is what an external reconciliation script compares against —
 * and the same concept must not serialise as 36400 on one endpoint and
 * 36399.999999999996 on another (dashboard.ts already applies .toFixed(2) to
 * its unredeemed figure; these did not).
 */
function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Wallets that are a SECOND representation of money another stream already
 * counts, and must therefore not be added again.
 *
 * POST /api/tickets writes the grand total to tickets.price and then, in the
 * same handler, issues a wallet for the same rupees (entry_fee + cover_issued)
 * and stamps the link into tickets.wallet_txn_id. /api/payments/verify does the
 * same for Razorpay and writes the wallet id into payments.txn_id. Summing all
 * three streams as if they were disjoint reported every ticket sale and every
 * online booking at exactly 2x: ₹3,000 collected showed as ₹6,000.
 *
 * The ticket / payment row is the one kept — it is what the venue actually
 * collected — and the derived wallet is dropped. Only rows the revenue queries
 * genuinely count are used to exclude, so a cancelled ticket or an uncaptured
 * payment can never silently erase its wallet's revenue.
 *
 * Deliberately NOT applied to cover_issued / amountIssued / leftOver: the bar
 * credit on a ticket-issued wallet is a real liability regardless of which
 * stream paid for it.
 */
const TICKET_LINKED_WALLETS = `
  SELECT wallet_txn_id FROM tickets
   WHERE wallet_txn_id IS NOT NULL AND status = 'issued' AND complimentary = 0
`;
const PAYMENT_LINKED_WALLETS = `
  SELECT txn_id FROM payments
   WHERE txn_id IS NOT NULL AND status = 'captured' AND verified_at IS NOT NULL
`;

/**
 * Total actually refunded by voids in scope — drives "Edited Amount".
 *
 * Was SUM(wallets.cover_issued) over every voided wallet, which overstates any
 * wallet that had already been partly spent by exactly the amount the guest
 * legitimately drank: a ₹3,000 cover with ₹1,000 drunk and ₹2,000 refunded
 * reported ₹3,000, so a manager auditing staff for suspicious voids could not
 * tell a full refund from a partial one. voidWallet already records the true
 * figure in the audit row, so read that; balance_before is the fallback for
 * older rows, since refund_amount defaults to it.
 */
function sumVoidedRefunds(from?: number, to?: number): number {
  const db = getDb();
  const inRange = from !== undefined && to !== undefined;
  const row = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(
             json_extract(details, '$.refund_amount'),
             json_extract(details, '$.balance_before'),
             0
           )), 0) AS total
    FROM audit_log
    WHERE action = 'wallet_void' AND entity_type = 'wallet' AND entity_id IS NOT NULL
    ${inRange ? 'AND timestamp >= ? AND timestamp < ?' : ''}
  `).get(...(inRange ? [from!, to!] : [])) as { total: number };
  return row.total || 0;
}

// ─── per-scope KPI computation ─────────────────────────────────────────────

/**
 * Compute the 10 KPI tiles for a given scope. When `from`/`to` are undefined
 * the scope is lifetime (no time filter).
 */
function computeKpis(from: number | undefined, to: number | undefined): AnalyticsKpis {
  const db = getDb();
  const inRange = from !== undefined && to !== undefined;

  // Wallets in scope
  const walletWhere = inRange ? 'WHERE issued_at >= ? AND issued_at < ?' : '';
  const walletParams = inRange ? [from!, to!] : [];

  const walletAgg = db.prepare(`
    SELECT
      COALESCE(SUM(entry_fee), 0)    AS entry_total,
      COALESCE(SUM(cover_issued), 0) AS cover_total,
      COUNT(*)                       AS wallet_count,
      COUNT(DISTINCT guest_id)       AS unique_guests
    FROM wallets
    ${walletWhere}
  `).get(...walletParams) as { entry_total: number; cover_total: number; wallet_count: number; unique_guests: number };

  // Revenue side of the same wallets, minus the ones a counted ticket already
  // represents (see TICKET_LINKED_WALLETS). Payment-linked wallets are NOT
  // excluded here: this scope does not sum the payments table at all, so the
  // wallet row is the only place an online booking's money is counted.
  const walletRevWhere = `${walletWhere ? `${walletWhere} AND` : 'WHERE'} txn_id NOT IN (${TICKET_LINKED_WALLETS})`;
  const walletRev = db.prepare(`
    SELECT COALESCE(SUM(entry_fee + cover_issued), 0) AS total
    FROM wallets
    ${walletRevWhere}
  `).get(...walletParams) as { total: number };

  // Payment-mode breakdown (entry+cover bundled — the amount paid for the wallet).
  // Same exclusion, otherwise a ₹3,000 ticket lands in BOTH the cash bucket
  // (via its wallet) and the ticket bucket, and the breakdown stops summing to
  // Total Incoming.
  const payRows = db.prepare(`
    SELECT payment_method,
           COALESCE(SUM(entry_fee + cover_issued), 0) AS amount
    FROM wallets
    ${walletRevWhere}
    GROUP BY payment_method
  `).all(...walletParams) as { payment_method: PaymentMethod; amount: number }[];

  const paymentBreakdown = { online: 0, cash: 0, card: 0, upi: 0, ticket: 0 };
  for (const r of payRows) {
    if (r.payment_method in paymentBreakdown) {
      paymentBreakdown[r.payment_method as keyof typeof paymentBreakdown] += r.amount || 0;
    }
  }

  // Redemptions in scope (success only — reversed redemptions feed Edited Amount)
  const redeemWhere = inRange ? "WHERE r.created_at >= ? AND r.created_at < ? AND r.status = 'success'" : "WHERE r.status = 'success'";
  const redeemAgg = db.prepare(`
    SELECT COALESCE(SUM(r.amount), 0) AS total
    FROM redemptions r
    ${redeemWhere}
  `).get(...walletParams) as { total: number };

  // Reversed redemptions feed Edited Amount alongside voids
  const reversedWhere = inRange ? "WHERE r.created_at >= ? AND r.created_at < ? AND r.status = 'reversed'" : "WHERE r.status = 'reversed'";
  const reversedAgg = db.prepare(`
    SELECT COALESCE(SUM(r.amount), 0) AS total
    FROM redemptions r
    ${reversedWhere}
  `).get(...walletParams) as { total: number };

  // Tickets in scope — count toward Total Incoming + Ticket Amount.
  // Complimentary tickets cost nothing so they're excluded from money totals.
  const ticketWhere = inRange ? "WHERE created_at >= ? AND created_at < ? AND status = 'issued' AND complimentary = 0" : "WHERE status = 'issued' AND complimentary = 0";
  const ticketAgg = db.prepare(`
    SELECT COALESCE(SUM(price), 0) AS total, COUNT(*) AS count
    FROM tickets
    ${ticketWhere}
  `).get(...walletParams) as { total: number; count: number };
  paymentBreakdown.ticket = round2(ticketAgg.total || 0);
  for (const k of Object.keys(paymentBreakdown) as (keyof typeof paymentBreakdown)[]) {
    paymentBreakdown[k] = round2(paymentBreakdown[k]);
  }

  // Voided wallets — for Edited Amount
  const voidedRefunds = inRange ? sumVoidedRefunds(from!, to!) : sumVoidedRefunds();

  const amountIssued = round2(walletAgg.cover_total || 0);
  const totalRedeems = round2(redeemAgg.total || 0);
  const editedAmount = round2(voidedRefunds + (reversedAgg.total || 0));

  return {
    totalCustomers: walletAgg.unique_guests || 0,
    totalIncoming: round2((walletRev.total || 0) + (ticketAgg.total || 0)),
    totalCoverCharge: round2(walletAgg.cover_total || 0),
    amountIssued,
    topUpsPreload: 0,
    totalRedeems,
    leftOver: round2(Math.max(0, amountIssued - totalRedeems)),
    editedAmount,
    paymentBreakdown,
  };
}

// ─── transaction feed ──────────────────────────────────────────────────────

/**
 * Flat feed of every issue / redeem / ticket event in a range.
 * Defaults to lifetime when from/to are omitted. Filter + search applied here.
 */
function listTransactionFeed(filters: AnalyticsFilters): AnalyticsTxnRow[] {
  const db = getDb();
  const limit = Math.min(5000, Math.max(50, filters.limit ?? 1000));
  const inRange = filters.from !== undefined && filters.to !== undefined;

  const rows: AnalyticsTxnRow[] = [];

  // Issues (wallet issuances)
  const issueWhere = inRange ? 'WHERE w.issued_at >= ? AND w.issued_at < ?' : '';
  const issueParams = inRange ? [filters.from!, filters.to!, limit] : [limit];
  const issues = db.prepare(`
    SELECT w.txn_id, w.cover_issued, w.entry_fee, w.payment_method, w.issued_by, w.issued_at,
           g.name AS customer_name, g.phone AS customer_phone
    FROM wallets w
    LEFT JOIN guests g ON g.id = w.guest_id
    ${issueWhere}
    ORDER BY w.issued_at DESC
    LIMIT ?
  `).all(...issueParams) as Array<{
    txn_id: string; cover_issued: number; entry_fee: number;
    payment_method: PaymentMethod; issued_by: string | null; issued_at: number;
    customer_name: string | null; customer_phone: string | null;
  }>;

  for (const w of issues) {
    rows.push({
      id: `issue:${w.txn_id}`,
      invoice_no: w.txn_id,
      customer_name: w.customer_name || '—',
      customer_phone: w.customer_phone || '—',
      amount: (w.entry_fee || 0) + (w.cover_issued || 0),
      timestamp: w.issued_at,
      kind: 'Issue',
      payment_mode: (w.payment_method || '—').toUpperCase(),
      employee_name: w.issued_by || '—',
      entity_ref: w.txn_id,
      entity_type: 'wallet',
    });
  }

  // Redemptions
  const redeemWhere = inRange
    ? "WHERE r.created_at >= ? AND r.created_at < ? AND r.status = 'success'"
    : "WHERE r.status = 'success'";
  const redeemParams = inRange ? [filters.from!, filters.to!, limit] : [limit];
  const redeems = db.prepare(`
    SELECT r.id, r.invoice_no, r.amount, r.captain, r.created_at, r.txn_id,
           w.payment_method,
           g.name AS customer_name, g.phone AS customer_phone
    FROM redemptions r
    LEFT JOIN wallets w ON w.txn_id = r.txn_id
    LEFT JOIN guests g ON g.id = w.guest_id
    ${redeemWhere}
    ORDER BY r.created_at DESC
    LIMIT ?
  `).all(...redeemParams) as Array<{
    id: string; invoice_no: string | null; amount: number; captain: string; created_at: number;
    txn_id: string; payment_method: PaymentMethod | null;
    customer_name: string | null; customer_phone: string | null;
  }>;

  for (const r of redeems) {
    rows.push({
      id: `redeem:${r.id}`,
      invoice_no: r.invoice_no ?? `FB${r.id.slice(-6)}`,
      customer_name: r.customer_name || '—',
      customer_phone: r.customer_phone || '—',
      amount: r.amount,
      timestamp: r.created_at,
      kind: 'Redeem',
      payment_mode: (r.payment_method || 'WALLET').toUpperCase(),
      employee_name: r.captain || '—',
      entity_ref: r.id,
      entity_type: 'redemption',
    });
  }

  // Tickets (Ticket-Amount stream)
  const ticketWhere = inRange
    ? "WHERE t.created_at >= ? AND t.created_at < ? AND t.status = 'issued'"
    : "WHERE t.status = 'issued'";
  const ticketParams = inRange ? [filters.from!, filters.to!, limit] : [limit];
  const tickets = db.prepare(`
    SELECT t.id, t.customer_name, t.customer_phone, t.price, t.created_at, t.created_by,
           t.complimentary, t.ticket_name
    FROM tickets t
    ${ticketWhere}
    ORDER BY t.created_at DESC
    LIMIT ?
  `).all(...ticketParams) as Array<{
    id: string; customer_name: string; customer_phone: string; price: number;
    created_at: number; created_by: string | null; complimentary: number; ticket_name: string;
  }>;

  for (const t of tickets) {
    rows.push({
      id: `ticket:${t.id}`,
      invoice_no: t.id,
      customer_name: t.customer_name || '—',
      customer_phone: t.customer_phone || '—',
      amount: t.price || 0,
      timestamp: t.created_at,
      kind: 'Ticket',
      payment_mode: t.complimentary ? 'COMP' : 'TICKET',
      employee_name: t.created_by || '—',
      entity_ref: t.id,
      entity_type: 'ticket',
    });
  }

  // Voids (refunds) and top-ups.
  //
  // AnalyticsTxnKind has always declared 'Void' and 'Top Up', and
  // AnalyticsLedger ships a rose Void pill — but nothing ever emitted either,
  // so the venue's cashier-style register simply had no line item for a
  // refund. A host who voided a ₹6,000 cover saw only the original Issue row
  // for ₹8,000 and nothing else. Neither event writes a row of its own
  // (voidWallet mutates the wallet in place; a top-up increments the balance),
  // so the audit log is the source of truth for both.
  const auditWhere = inRange ? 'AND a.timestamp >= ? AND a.timestamp < ?' : '';
  const auditParams = inRange ? [filters.from!, filters.to!, limit] : [limit];
  const walletEvents = db.prepare(`
    SELECT a.entity_id AS txn_id, a.actor, a.timestamp, a.action, a.details,
           w.payment_method,
           g.name AS customer_name, g.phone AS customer_phone
      FROM audit_log a
      LEFT JOIN wallets w ON w.txn_id = a.entity_id
      LEFT JOIN guests  g ON g.id = w.guest_id
     WHERE a.action IN ('wallet_void', 'wallet_topup_captured')
       AND a.entity_type = 'wallet' AND a.entity_id IS NOT NULL
       ${auditWhere}
     ORDER BY a.timestamp DESC
     LIMIT ?
  `).all(...auditParams) as Array<{
    txn_id: string; actor: string | null; timestamp: number; action: string;
    details: string | null; payment_method: PaymentMethod | null;
    customer_name: string | null; customer_phone: string | null;
  }>;

  for (const e of walletEvents) {
    let detail: Record<string, unknown> = {};
    try { detail = e.details ? JSON.parse(e.details) as Record<string, unknown> : {}; } catch { /* legacy free-text details */ }
    const isVoid = e.action === 'wallet_void';
    // Void amount is what was actually handed back, not the whole cover.
    const amount = Number(
      isVoid ? (detail.refund_amount ?? detail.balance_before ?? 0) : (detail.amount ?? 0),
    ) || 0;
    rows.push({
      id: `${isVoid ? 'void' : 'topup'}:${e.txn_id}:${e.timestamp}`,
      invoice_no: e.txn_id,
      customer_name: e.customer_name || '—',
      customer_phone: e.customer_phone || '—',
      amount: round2(amount),
      timestamp: e.timestamp,
      kind: isVoid ? 'Void' : 'Top Up',
      payment_mode: isVoid ? 'REFUND' : (e.payment_method || 'ONLINE').toUpperCase(),
      employee_name: e.actor || '—',
      entity_ref: e.txn_id,
      entity_type: 'wallet',
    });
  }

  // Filter + sort
  let filtered = rows;
  if (filters.employee && filters.employee !== 'all') {
    filtered = filtered.filter((r) => r.employee_name === filters.employee);
  }
  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase();
    filtered = filtered.filter((r) =>
      r.invoice_no.toLowerCase().includes(q) ||
      r.customer_name.toLowerCase().includes(q) ||
      r.customer_phone.toLowerCase().includes(q) ||
      String(r.amount).includes(q),
    );
  }
  filtered.sort((a, b) => b.timestamp - a.timestamp);
  return filtered;
}

// ─── public entry point ────────────────────────────────────────────────────

export function computeAnalytics(filters: AnalyticsFilters = {}): AnalyticsResult {
  sweepExpired();
  const now = Date.now();
  // Resolve range — default to today's shift (5 AM IST today → 5 AM IST tomorrow).
  // Cashier already encodes this; we duplicate the simple version here to avoid
  // pulling cashier's IST math into analytics. UI passes explicit values normally.
  const rangeFrom = filters.from ?? (now - 24 * 60 * 60 * 1000);
  const rangeTo = filters.to ?? now + 1000;

  const lifetime = computeKpis(undefined, undefined);
  const range = computeKpis(rangeFrom, rangeTo);
  const transactions = listTransactionFeed({
    from: rangeFrom,
    to: rangeTo,
    search: filters.search,
    employee: filters.employee,
    limit: filters.limit,
  });

  // Distinct employees across both wallets and redemptions and tickets
  const db = getDb();
  const employeeRows = db.prepare(`
    SELECT name FROM (
      SELECT DISTINCT issued_by AS name FROM wallets WHERE issued_by IS NOT NULL AND issued_by != ''
      UNION
      SELECT DISTINCT captain  AS name FROM redemptions WHERE captain IS NOT NULL AND captain != ''
      UNION
      SELECT DISTINCT created_by AS name FROM tickets WHERE created_by IS NOT NULL AND created_by != ''
    ) ORDER BY name ASC
  `).all() as { name: string }[];
  const employees = employeeRows.map((r) => r.name);

  return { lifetime, range, transactions, employees, rangeFrom, rangeTo };
}

// ─── Dashboard aggregations ─────────────────────────────────────────────────
//
// New, dashboard-oriented metrics that power the /admin/analytics "Dashboard"
// tab. These are independent from computeAnalytics (the cashier-style ledger)
// and are split into one function per chart so the UI can fetch them in
// parallel and cache them individually. All queries are read-only and
// parameterised; none of them mutate state (no sweepExpired) — the dashboard
// is a pure read endpoint.
//
// Default range = last 30 days (UTC). Callers SHOULD pass an explicit range;
// the helpers accept undefined and fall back to that default.

export interface DashboardRangeFilters {
  /** UTC ms inclusive. Defaults to now - 30d. */
  from?: number;
  /** UTC ms exclusive. Defaults to now. */
  to?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function resolveDashboardRange(f: DashboardRangeFilters): { from: number; to: number } {
  const now = Date.now();
  const to = f.to ?? now;
  const from = f.from ?? to - 30 * DAY_MS;
  return { from, to };
}

// ─── KPIs ───────────────────────────────────────────────────────────────────

export interface DashboardKpis {
  /** Sum of (wallets entry+cover) + (non-comp tickets price) + (captured payments). */
  totalRevenue: number;
  /** Count of wallets with status='active' and balance>0, issued in-range. */
  activeWallets: number;
  /** Count of reservations created in-range (any status). */
  reservationsCount: number;
  /**
   * Conversion rate = (wallets in-range w/ reservation_id) / clicks in-range.
   * Returned as a fraction 0..1, or `null` when there are no clicks in-range
   * (avoids divide-by-zero and misleading "0%" in the UI).
   */
  conversionRate: number | null;
}

export function getKpis(filters: DashboardRangeFilters = {}): DashboardKpis {
  const db = getDb();
  const { from, to } = resolveDashboardRange(filters);

  // Revenue stream 1: wallets issued in-range — entry + cover charged.
  // Wallets that a counted ticket or a captured payment already represents are
  // excluded here (see TICKET_LINKED_WALLETS / PAYMENT_LINKED_WALLETS); this
  // scope sums all three streams, so without the exclusion every ticket sale
  // and every online booking was counted twice.
  const walletRev = db.prepare(`
    SELECT COALESCE(SUM(entry_fee + cover_issued), 0) AS total
    FROM wallets
    WHERE issued_at >= ? AND issued_at < ?
      AND txn_id NOT IN (${TICKET_LINKED_WALLETS})
      AND txn_id NOT IN (${PAYMENT_LINKED_WALLETS})
  `).get(from, to) as { total: number };

  // Revenue stream 2: tickets issued in-range, paid (non-complimentary).
  const ticketRev = db.prepare(`
    SELECT COALESCE(SUM(price), 0) AS total
    FROM tickets
    WHERE created_at >= ? AND created_at < ?
      AND status = 'issued' AND complimentary = 0
  `).get(from, to) as { total: number };

  // Revenue stream 3: Razorpay payments captured in-range. These represent
  // paid online bookings. A captured payment DOES also appear as a wallet row —
  // /api/payments/verify issues one for the same money and writes the wallet id
  // back into payments.txn_id — which is exactly why stream 1 excludes it.
  const paymentRev = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM payments
    WHERE status = 'captured'
      AND verified_at IS NOT NULL
      AND verified_at >= ? AND verified_at < ?
  `).get(from, to) as { total: number };

  const totalRevenue = round2(
    (walletRev.total || 0) + (ticketRev.total || 0) + (paymentRev.total || 0),
  );

  // Active wallets — still-redeemable wallets issued in-range.
  const active = db.prepare(`
    SELECT COUNT(*) AS c
    FROM wallets
    WHERE status = 'active' AND balance > 0
      AND issued_at >= ? AND issued_at < ?
  `).get(from, to) as { c: number };

  // Reservations created in-range (synced_at is the creation timestamp;
  // see src/lib/reservations.ts:24).
  const res = db.prepare(`
    SELECT COUNT(*) AS c
    FROM reservations
    WHERE synced_at >= ? AND synced_at < ?
  `).get(from, to) as { c: number };

  // Conversion rate — wallets attributed to reservations / affiliate clicks.
  // Numerator = wallets in-range that originated from a reservation.
  // Denominator = affiliate clicks in-range.
  // Both signals approximate "intent → wallet" — when clicks==0 we cannot
  // compute a rate, so we return null and let the UI render "—".
  const clicks = db.prepare(`
    SELECT COUNT(*) AS c
    FROM affiliate_clicks
    WHERE created_at >= ? AND created_at < ?
  `).get(from, to) as { c: number };

  const convertedWallets = db.prepare(`
    SELECT COUNT(*) AS c
    FROM wallets
    WHERE reservation_id IS NOT NULL
      AND issued_at >= ? AND issued_at < ?
  `).get(from, to) as { c: number };

  const conversionRate =
    clicks.c > 0 ? Math.max(0, Math.min(1, convertedWallets.c / clicks.c)) : null;

  return {
    totalRevenue,
    activeWallets: active.c || 0,
    reservationsCount: res.c || 0,
    conversionRate,
  };
}

// ─── Revenue by event ───────────────────────────────────────────────────────

export interface RevenueByEventRow {
  eventId: string;
  eventName: string;
  eventDate: string;
  revenue: number;
  walletCount: number;
}

export interface RevenueByEventFilters extends DashboardRangeFilters {
  /** Cap on rows returned. Defaults to 10. */
  limit?: number;
}

export function getRevenueByEvent(filters: RevenueByEventFilters = {}): RevenueByEventRow[] {
  const db = getDb();
  const { from, to } = resolveDashboardRange(filters);
  const limit = Math.max(1, Math.min(100, filters.limit ?? 10));

  // Pre-aggregate each revenue stream by event_id, then UNION ALL and sum.
  // LEFT JOIN events at the end so events with zero revenue in-range are
  // excluded (they wouldn't appear in any of the three sub-queries).
  //
  // The wallets leg drops rows a counted ticket or captured payment already
  // represents — the same dedupe getKpis applies — otherwise every ticket sale
  // and online booking inflates its event's bar by 100%. wallet_count keeps
  // counting ALL wallets for the event: a ticket-issued guest is still a guest.
  const rows = db.prepare(`
    WITH per_event AS (
      SELECT event_id,
             SUM(CASE WHEN txn_id NOT IN (${TICKET_LINKED_WALLETS})
                       AND txn_id NOT IN (${PAYMENT_LINKED_WALLETS})
                      THEN entry_fee + cover_issued ELSE 0 END) AS revenue,
             COUNT(*) AS wallet_count
        FROM wallets
       WHERE event_id IS NOT NULL
         AND issued_at >= ? AND issued_at < ?
       GROUP BY event_id

      UNION ALL

      SELECT event_id,
             SUM(price) AS revenue,
             0 AS wallet_count
        FROM tickets
       WHERE event_id IS NOT NULL
         AND created_at >= ? AND created_at < ?
         AND status = 'issued' AND complimentary = 0
       GROUP BY event_id

      UNION ALL

      SELECT event_id,
             SUM(amount) AS revenue,
             0 AS wallet_count
        FROM payments
       WHERE event_id IS NOT NULL
         AND status = 'captured'
         AND verified_at IS NOT NULL
         AND verified_at >= ? AND verified_at < ?
       GROUP BY event_id
    )
    SELECT e.id           AS eventId,
           e.name         AS eventName,
           e.event_date   AS eventDate,
           COALESCE(SUM(pe.revenue), 0)      AS revenue,
           COALESCE(SUM(pe.wallet_count), 0) AS walletCount
      FROM per_event pe
      JOIN events e ON e.id = pe.event_id
     GROUP BY e.id, e.name, e.event_date
     ORDER BY revenue DESC
     LIMIT ?
  `).all(from, to, from, to, from, to, limit) as RevenueByEventRow[];

  return rows.map((r) => ({ ...r, revenue: round2(r.revenue) }));
}

// ─── Conversion funnel ──────────────────────────────────────────────────────

export interface ConversionFunnel {
  clicks: number;
  reservations: number;
  wallets: number;
  /** Percent (0..100) of clicks that became reservations; null when clicks=0. */
  clickToReservationPct: number | null;
  /** Percent (0..100) of reservations that became wallets; null when reservations=0. */
  reservationToWalletPct: number | null;
}

export function getConversionFunnel(filters: DashboardRangeFilters = {}): ConversionFunnel {
  const db = getDb();
  const { from, to } = resolveDashboardRange(filters);

  const clicks = db.prepare(`
    SELECT COUNT(*) AS c
    FROM affiliate_clicks
    WHERE created_at >= ? AND created_at < ?
  `).get(from, to) as { c: number };

  const reservations = db.prepare(`
    SELECT COUNT(*) AS c
    FROM reservations
    WHERE synced_at >= ? AND synced_at < ?
  `).get(from, to) as { c: number };

  const wallets = db.prepare(`
    SELECT COUNT(*) AS c
    FROM wallets
    WHERE issued_at >= ? AND issued_at < ?
  `).get(from, to) as { c: number };

  const clickToReservationPct =
    clicks.c > 0 ? Math.max(0, Math.min(100, (reservations.c / clicks.c) * 100)) : null;
  const reservationToWalletPct =
    reservations.c > 0 ? Math.max(0, Math.min(100, (wallets.c / reservations.c) * 100)) : null;

  return {
    clicks: clicks.c || 0,
    reservations: reservations.c || 0,
    wallets: wallets.c || 0,
    clickToReservationPct,
    reservationToWalletPct,
  };
}

// ─── Affiliate breakdown ────────────────────────────────────────────────────

export interface AffiliateBreakdownRow {
  affiliateId: string;
  affiliateName: string;
  code: string;
  attributedClicks: number;
  attributedWallets: number;
  attributedRevenue: number;
}

export interface AffiliateBreakdownFilters extends DashboardRangeFilters {
  /** Cap on rows returned. Defaults to 8. */
  limit?: number;
}

export function getAffiliateBreakdown(
  filters: AffiliateBreakdownFilters = {},
): AffiliateBreakdownRow[] {
  const db = getDb();
  const { from, to } = resolveDashboardRange(filters);
  const limit = Math.max(1, Math.min(100, filters.limit ?? 8));

  // Per-affiliate aggregates over the range. We compute clicks + wallets +
  // revenue independently and join them onto affiliates. Conversions are
  // measured as tickets carrying the affiliate_id in-range (this is the only
  // attribution stream currently wired; wallets attributed via affiliates
  // are not yet tracked — known limitation).
  //
  // Note: "attributedWallets" here actually counts attributed *tickets* —
  // we keep the field name for the spec's contract. When wallet-level
  // attribution lands, this query can union in the wallet count.
  const rows = db.prepare(`
    SELECT a.id   AS affiliateId,
           a.name AS affiliateName,
           a.code AS code,
           COALESCE(c.cnt, 0)        AS attributedClicks,
           COALESCE(t.cnt, 0)        AS attributedWallets,
           COALESCE(comm.total, 0)   AS attributedRevenue
      FROM affiliates a
      LEFT JOIN (
        SELECT affiliate_id, COUNT(*) AS cnt
          FROM affiliate_clicks
         WHERE created_at >= ? AND created_at < ?
         GROUP BY affiliate_id
      ) c ON c.affiliate_id = a.id
      LEFT JOIN (
        SELECT affiliate_id, COUNT(*) AS cnt
          FROM tickets
         WHERE affiliate_id IS NOT NULL
           AND created_at >= ? AND created_at < ?
         GROUP BY affiliate_id
      ) t ON t.affiliate_id = a.id
      LEFT JOIN (
        SELECT affiliate_id, COALESCE(SUM(sale_amount), 0) AS total
          FROM affiliate_commissions
         WHERE created_at >= ? AND created_at < ?
         GROUP BY affiliate_id
      ) comm ON comm.affiliate_id = a.id
     WHERE COALESCE(c.cnt, 0) + COALESCE(t.cnt, 0) + COALESCE(comm.total, 0) > 0
     ORDER BY attributedRevenue DESC, attributedClicks DESC
     LIMIT ?
  `).all(from, to, from, to, from, to, limit) as AffiliateBreakdownRow[];

  return rows;
}

// ─── Peak-hour heatmap ──────────────────────────────────────────────────────

export interface PeakHourCell {
  /** 0 = Sunday … 6 = Saturday (IST). */
  dayOfWeek: number;
  /** 0..23 in IST. */
  hour: number;
  /** Number of wallets issued in this (dow, hour) bucket. */
  count: number;
}

/**
 * Returns a flat list of (dow, hour, count) wallet-issuance buckets.
 *
 * SQLite's strftime treats the third argument as a modifier — passing
 * '+05:30' shifts the unix timestamp into IST before the format pieces are
 * extracted. India observes no DST so this is stable year-round.
 */
export function getPeakHourHeatmap(filters: DashboardRangeFilters = {}): PeakHourCell[] {
  const db = getDb();
  const { from, to } = resolveDashboardRange(filters);

  const rows = db.prepare(`
    SELECT CAST(strftime('%w', issued_at / 1000, 'unixepoch', '+05:30') AS INTEGER) AS dayOfWeek,
           CAST(strftime('%H', issued_at / 1000, 'unixepoch', '+05:30') AS INTEGER) AS hour,
           COUNT(*) AS count
      FROM wallets
     WHERE issued_at >= ? AND issued_at < ?
     GROUP BY dayOfWeek, hour
     ORDER BY dayOfWeek ASC, hour ASC
  `).all(from, to) as PeakHourCell[];

  return rows;
}

// ─── Repeat-customer rate ───────────────────────────────────────────────────

export interface RepeatRate {
  firstTime: number;
  returning: number;
  /** Returning ÷ (returning + firstTime) × 100; 0 when both are 0. */
  repeatRatePct: number;
}

/**
 * Classifies each guest with activity in-range as "firstTime" (this is
 * their only wallet+ticket across all time) or "returning" (>=2 lifetime
 * wallets/tickets). Repeat rate is the fraction returning.
 *
 * Phone normalization caveat: guests are keyed by `guests.id` but the
 * upstream lookups in src/lib/wallet.ts may create separate guest rows for
 * the same phone with different formatting (with/without +91). When that
 * happens, this query will count one human as two guests. Reuse a phone-
 * normalization helper before grouping if more accuracy is required.
 */
export function getRepeatRate(filters: DashboardRangeFilters = {}): RepeatRate {
  const db = getDb();
  const { from, to } = resolveDashboardRange(filters);

  // Guests with at least one wallet or ticket in-range.
  const activeGuests = db.prepare(`
    SELECT guest_id FROM wallets
     WHERE guest_id IS NOT NULL AND issued_at >= ? AND issued_at < ?
    UNION
    SELECT guest_id FROM tickets
     WHERE guest_id IS NOT NULL AND created_at >= ? AND created_at < ?
  `).all(from, to, from, to) as { guest_id: string }[];

  if (activeGuests.length === 0) {
    return { firstTime: 0, returning: 0, repeatRatePct: 0 };
  }

  // Lifetime totals for each in-range guest. Returning = lifetime total >= 2.
  const ids = activeGuests.map((g) => g.guest_id);
  const placeholders = ids.map(() => '?').join(',');
  const totals = db.prepare(`
    SELECT guest_id, SUM(n) AS total FROM (
      SELECT guest_id, COUNT(*) AS n FROM wallets WHERE guest_id IN (${placeholders}) GROUP BY guest_id
      UNION ALL
      SELECT guest_id, COUNT(*) AS n FROM tickets WHERE guest_id IN (${placeholders}) GROUP BY guest_id
    )
    GROUP BY guest_id
  `).all(...ids, ...ids) as { guest_id: string; total: number }[];

  let firstTime = 0;
  let returning = 0;
  for (const row of totals) {
    if ((row.total || 0) >= 2) returning += 1;
    else firstTime += 1;
  }

  const denom = firstTime + returning;
  const repeatRatePct = denom > 0 ? (returning / denom) * 100 : 0;

  return { firstTime, returning, repeatRatePct };
}
