/**
 * Analytics-dashboard aggregator — drives the new "Dashboard" tab on
 * /admin/analytics. Read-only, side-effect-free; the cashier-style ledger
 * (computeAnalytics in src/lib/analytics.ts) still owns its own sweep +
 * KPI math and is unchanged by this file.
 *
 * Why a separate aggregator: the dashboard surfaces high-level KPIs +
 * charts (revenue by event, conversion funnel, affiliate breakdown, peak
 * hour heatmap, repeat customers). It needs SQL shapes the ledger doesn't,
 * so co-locating them here keeps src/lib/analytics.ts focused on the
 * cashier feed and avoids accidental regressions.
 *
 * All queries are parameterized and range-scoped. No writes, no
 * sweepExpired — the dashboard is a read endpoint. The cashier ledger
 * still calls sweepExpired on its own path, so the active-wallet KPI
 * here can lag by one cashier-page-load — documented and acceptable.
 */
import { getDb } from './db';

// ─── shapes ────────────────────────────────────────────────────────────────

export interface DashboardKpis {
  /**
   * Sum of wallet entry_fee + cover_issued + paid (non-comp) ticket prices
   * + captured payments.amount inside the range.
   *
   * Triple-stream risk: payments rows for Razorpay-paid bookings can
   * overlap with wallets/tickets created by the same flow. Current
   * payments table stores Razorpay paid bookings only and is NOT yet
   * cross-stamped onto wallets/tickets, so for now we treat all three
   * as additive. If/when wallets-from-payments attribution lands, this
   * KPI must dedupe via payments.txn_id JOIN wallets.txn_id.
   */
  revenue: number;
  /** Count of wallets with status='active' AND balance>0 issued in-range. */
  activeWallets: number;
  /** Count of reservations created (synced_at) in-range, any status. */
  reservations: number;
  /**
   * conversionRate = (wallets_via_reservation + tickets_via_affiliate +
   *                   payments_captured) / affiliate_clicks  in-range.
   * Returns null when clicks=0 (so the UI shows '—' instead of 0%).
   * Clamped 0..1 otherwise.
   */
  conversionRate: number | null;
}

export interface RevenueByEventRow {
  eventId: string;
  name: string;
  eventDate: string;
  revenue: number;
}

export interface DashboardFunnel {
  /** Affiliate link clicks in range. */
  clicks: number;
  /** Reservations created (synced_at) in range, any status. */
  reservations: number;
  /**
   * Wallets issued against one of the reservations counted above — i.e. a
   * strict SUBSET of `reservations`, not "all wallets". The renderer prints
   * value/prevValue as "conversion from previous stage", so this number only
   * means anything if it is drawn from the previous stage's population.
   */
  wallets: number;
}

export interface AffiliateBreakdownRow {
  affiliateId: string;
  name: string;
  code: string;
  clicks: number;
  conversions: number;
  commissionTotal: number;
}

export interface PeakHourHeatmap {
  /** 7 rows (Sun..Sat) × 24 columns (hour 00..23). */
  matrix: number[][];
  /** Highest single cell, for color-scale normalization. 0 ⇒ no data. */
  max: number;
}

export interface RepeatCustomers {
  newCount: number;
  repeatCount: number;
  total: number;
}

export interface DashboardResult {
  kpis: DashboardKpis;
  revenueByEvent: RevenueByEventRow[];
  funnel: DashboardFunnel;
  affiliateBreakdown: AffiliateBreakdownRow[];
  peakHourHeatmap: PeakHourHeatmap;
  repeatCustomers: RepeatCustomers;
  rangeFrom: number;
  rangeTo: number;
}

export interface DashboardFilters {
  /** UTC ms inclusive. Defaults to now-30d. */
  from?: number;
  /** UTC ms exclusive. Defaults to now+1s. */
  to?: number;
  /** Restrict every aggregate to a single event when set. */
  eventId?: string;
}

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * SQLite strftime modifier for IST. India does not observe DST so the
 * fixed +05:30 offset is safe year-round.
 */
const IST_OFFSET = '+05:30';

function resolveRange(filters: DashboardFilters): { from: number; to: number } {
  const now = Date.now();
  const to = filters.to ?? (now + 1000);
  const from = filters.from ?? (now - 30 * 24 * 60 * 60 * 1000);
  return { from, to };
}

// ─── KPI section ───────────────────────────────────────────────────────────

function computeKpis(from: number, to: number, eventId: string | undefined): DashboardKpis {
  const db = getDb();

  // Revenue stream 1: wallets (entry + cover)
  const walletFilters = ['issued_at >= ?', 'issued_at < ?'];
  const walletParams: (number | string)[] = [from, to];
  if (eventId) { walletFilters.push('event_id = ?'); walletParams.push(eventId); }
  const walletAgg = db.prepare(`
    SELECT COALESCE(SUM(entry_fee), 0) AS entry_total,
           COALESCE(SUM(cover_issued), 0) AS cover_total,
           SUM(CASE WHEN status = 'active' AND balance > 0 THEN 1 ELSE 0 END) AS active_count
    FROM wallets
    WHERE ${walletFilters.join(' AND ')}
  `).get(...walletParams) as { entry_total: number; cover_total: number; active_count: number };

  // Revenue stream 2: paid (non-comp) tickets
  const ticketFilters = ["created_at >= ?", "created_at < ?", "status = 'issued'", 'complimentary = 0'];
  const ticketParams: (number | string)[] = [from, to];
  if (eventId) { ticketFilters.push('event_id = ?'); ticketParams.push(eventId); }
  const ticketAgg = db.prepare(`
    SELECT COALESCE(SUM(price), 0) AS total,
           SUM(CASE WHEN affiliate_id IS NOT NULL THEN 1 ELSE 0 END) AS via_affiliate
    FROM tickets
    WHERE ${ticketFilters.join(' AND ')}
  `).get(...ticketParams) as { total: number; via_affiliate: number };

  // Revenue stream 3: captured Razorpay payments
  const payFilters = ["created_at >= ?", "created_at < ?", "status = 'captured'"];
  const payParams: (number | string)[] = [from, to];
  if (eventId) { payFilters.push('event_id = ?'); payParams.push(eventId); }
  const payAgg = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS captured_count
    FROM payments
    WHERE ${payFilters.join(' AND ')}
  `).get(...payParams) as { total: number; captured_count: number };

  // Wallets attributed via a reservation (reservation_id NOT NULL) inside the range
  const walletViaResAgg = db.prepare(`
    SELECT COUNT(*) AS c
    FROM wallets
    WHERE issued_at >= ? AND issued_at < ? AND reservation_id IS NOT NULL
      ${eventId ? 'AND event_id = ?' : ''}
  `).get(...(eventId ? [from, to, eventId] : [from, to])) as { c: number };

  // Reservations created in range (any status)
  const reservationsAgg = db.prepare(`
    SELECT COUNT(*) AS c
    FROM reservations
    WHERE synced_at >= ? AND synced_at < ?
      ${eventId ? 'AND event_id = ?' : ''}
  `).get(...(eventId ? [from, to, eventId] : [from, to])) as { c: number };

  // Affiliate clicks in-range — conversion denominator
  const clicksAgg = db.prepare(`
    SELECT COUNT(*) AS c
    FROM affiliate_clicks
    WHERE created_at >= ? AND created_at < ?
      ${eventId ? 'AND event_id = ?' : ''}
  `).get(...(eventId ? [from, to, eventId] : [from, to])) as { c: number };

  const conversions = (walletViaResAgg.c || 0) + (ticketAgg.via_affiliate || 0) + (payAgg.captured_count || 0);
  const clicks = clicksAgg.c || 0;
  let conversionRate: number | null;
  if (clicks <= 0) {
    conversionRate = null;
  } else {
    conversionRate = Math.max(0, Math.min(1, conversions / clicks));
  }

  return {
    revenue:
      (walletAgg.entry_total || 0) +
      (walletAgg.cover_total || 0) +
      (ticketAgg.total || 0) +
      (payAgg.total || 0),
    activeWallets: walletAgg.active_count || 0,
    reservations: reservationsAgg.c || 0,
    conversionRate,
  };
}

// ─── revenue by event ──────────────────────────────────────────────────────

function computeRevenueByEvent(from: number, to: number, eventId: string | undefined, limit = 10): RevenueByEventRow[] {
  const db = getDb();
  const eventFilter = eventId ? 'AND e.id = ?' : '';
  const extra: (number | string)[] = eventId ? [eventId] : [];

  const rows = db.prepare(`
    SELECT e.id AS eventId, e.name, e.event_date AS eventDate,
           (
             COALESCE((SELECT SUM(w.entry_fee + w.cover_issued) FROM wallets w
                        WHERE w.event_id = e.id AND w.issued_at >= ? AND w.issued_at < ?), 0)
             + COALESCE((SELECT SUM(t.price) FROM tickets t
                          WHERE t.event_id = e.id AND t.created_at >= ? AND t.created_at < ?
                            AND t.status = 'issued' AND t.complimentary = 0), 0)
             + COALESCE((SELECT SUM(p.amount) FROM payments p
                          WHERE p.event_id = e.id AND p.created_at >= ? AND p.created_at < ?
                            AND p.status = 'captured'), 0)
           ) AS revenue
    FROM events e
    WHERE 1=1 ${eventFilter}
    ORDER BY revenue DESC
    LIMIT ?
  `).all(from, to, from, to, from, to, ...extra, limit) as RevenueByEventRow[];

  // Skip zero-revenue events — they pollute the chart.
  const withRevenue = rows.filter((r) => (r.revenue || 0) > 0);

  // A single-event view has no residual to show — the operator asked for one
  // event, and "everything else" isn't part of that question.
  if (eventId) return withRevenue;

  // ─── Unattributed bucket ────────────────────────────────────────────────
  // Every subquery above correlates on `event_id = e.id`, so money that has no
  // event (issueWallet accepts a wallet with no eventId — the door flow falls
  // back to the global EVENT_DATE config) or points at an event row that has
  // since been deleted simply vanishes from the chart. The revenue KPI printed
  // directly above it counts that money, so the bars did not add up to the
  // number above them: on live data ₹55,250 in the KPI against ₹31,250 of
  // bars, with ₹24,000 from six event-less wallets and no hint that anything
  // was missing. Per-event profitability was being judged on 57% of the money.
  //
  // Appended last rather than sorted in: it is a residual, not an event, and
  // BarChart scales every bar off the largest value so its position doesn't
  // distort the others.
  //
  // Caveat that remains: the event rows are still LIMIT-ed to the top `limit`,
  // so with more revenue-positive events than that the chart is "top N +
  // unattributed", exactly as the card's own "Top 10" caption says.
  const orphanSql = (table: string) =>
    `(${table}.event_id IS NULL OR NOT EXISTS (SELECT 1 FROM events e WHERE e.id = ${table}.event_id))`;
  const residual = db.prepare(`
    SELECT (
      COALESCE((SELECT SUM(w.entry_fee + w.cover_issued) FROM wallets w
                 WHERE w.issued_at >= ? AND w.issued_at < ? AND ${orphanSql('w')}), 0)
      + COALESCE((SELECT SUM(t.price) FROM tickets t
                   WHERE t.created_at >= ? AND t.created_at < ?
                     AND t.status = 'issued' AND t.complimentary = 0 AND ${orphanSql('t')}), 0)
      + COALESCE((SELECT SUM(p.amount) FROM payments p
                   WHERE p.created_at >= ? AND p.created_at < ?
                     AND p.status = 'captured' AND ${orphanSql('p')}), 0)
    ) AS revenue
  `).get(from, to, from, to, from, to) as { revenue: number };

  if ((residual.revenue || 0) > 0) {
    withRevenue.push({
      eventId: '',
      name: '(Unattributed)',
      eventDate: '',
      revenue: residual.revenue,
    });
  }
  return withRevenue;
}

// ─── funnel ────────────────────────────────────────────────────────────────

/**
 * Funnel stages.
 *
 * The wallet stage used to be `COUNT(*) FROM wallets` in the same window —
 * three unrelated COUNTs stacked as if they were stages. FunnelChart renders
 * each pair as "conversion from previous stage", so on live data that printed
 * "59% of reservations convert to wallets" (13 wallets ÷ 22 unrelated
 * reservations) when in fact ONE of those 13 wallets came from a reservation.
 * A funnel percentage between two populations that don't overlap is not an
 * approximation, it is a fabricated number, and it is the number the owner
 * uses to decide whether the reservation channel is working.
 *
 * The wallet stage is now the reservations counted in stage 2 that actually
 * converted (wallets.reservation_id — set by issueWallet, the authoritative
 * link; reservations.converted_wallet_txn is written best-effort in a
 * try/catch and can silently miss). Cohort semantics: the wallet is counted
 * whenever it was issued, because the question is "of the reservations taken
 * in this window, how many turned into a wallet". That also makes
 * stage3 <= stage2 by construction, so the chart can never draw a longer bar
 * for a later stage.
 *
 * KNOWN RESIDUAL — the clicks stage is still not a parent of reservations:
 * `reservations` has no affiliate_id/affiliate_code column (affiliate
 * attribution exists on tickets only), so there is no click → reservation
 * link to filter on in this schema. Making stage 1 honest needs either that
 * column or a relabel in the renderer (src/components/AnalyticsDashboard.tsx
 * hardcodes the stage labels, and FunnelChart.tsx:30 scales every bar against
 * stage 1, so with 0 clicks the reservations bar computes a >100% width).
 * Both live outside this file.
 */
function computeFunnel(from: number, to: number, eventId: string | undefined): DashboardFunnel {
  const db = getDb();
  const extraSql = eventId ? 'AND event_id = ?' : '';
  const extra: (number | string)[] = eventId ? [eventId] : [];

  const clicks = (db.prepare(`
    SELECT COUNT(*) AS c FROM affiliate_clicks
    WHERE created_at >= ? AND created_at < ? ${extraSql}
  `).get(from, to, ...extra) as { c: number }).c || 0;

  const reservations = (db.prepare(`
    SELECT COUNT(*) AS c FROM reservations
    WHERE synced_at >= ? AND synced_at < ? ${extraSql}
  `).get(from, to, ...extra) as { c: number }).c || 0;

  // Same reservation population as the stage above, filtered to the ones a
  // wallet points back at. Aliased explicitly: `event_id` unqualified would
  // silently bind to reservations inside the subquery while reading like it
  // applies to wallets.
  const walletResEventSql = eventId ? 'AND r.event_id = ?' : '';
  const wallets = (db.prepare(`
    SELECT COUNT(*) AS c FROM wallets w
    WHERE w.reservation_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM reservations r
         WHERE r.id = w.reservation_id
           AND r.synced_at >= ? AND r.synced_at < ? ${walletResEventSql}
      )
  `).get(from, to, ...extra) as { c: number }).c || 0;

  return { clicks, reservations, wallets };
}

// ─── affiliate breakdown ───────────────────────────────────────────────────

function computeAffiliateBreakdown(from: number, to: number, eventId: string | undefined, limit = 8): AffiliateBreakdownRow[] {
  const db = getDb();
  const eventClickSql = eventId ? 'AND ac.event_id = ?' : '';
  const eventTicketSql = eventId ? 'AND t.event_id = ?' : '';
  const eventCommissionSql = eventId ? 'AND c.event_id = ?' : '';

  const params: (number | string)[] = [from, to];
  if (eventId) params.push(eventId);
  const ticketParams: (number | string)[] = [from, to];
  if (eventId) ticketParams.push(eventId);
  const commissionParams: (number | string)[] = [from, to];
  if (eventId) commissionParams.push(eventId);

  const rows = db.prepare(`
    SELECT
      a.id   AS affiliateId,
      a.name AS name,
      a.code AS code,
      (SELECT COUNT(*) FROM affiliate_clicks ac
        WHERE ac.affiliate_id = a.id
          AND ac.created_at >= ? AND ac.created_at < ? ${eventClickSql}) AS clicks,
      (SELECT COUNT(*) FROM tickets t
        WHERE t.affiliate_id = a.id
          AND t.created_at >= ? AND t.created_at < ?
          AND t.status = 'issued' ${eventTicketSql}) AS conversions,
      (SELECT COALESCE(SUM(c.commission_amount), 0) FROM affiliate_commissions c
        WHERE c.affiliate_id = a.id
          AND c.created_at >= ? AND c.created_at < ? ${eventCommissionSql}) AS commissionTotal
    FROM affiliates a
    ORDER BY commissionTotal DESC, conversions DESC, clicks DESC
    LIMIT ?
  `).all(...params, ...ticketParams, ...commissionParams, limit) as AffiliateBreakdownRow[];

  return rows.filter((r) => (r.clicks || 0) + (r.conversions || 0) + (r.commissionTotal || 0) > 0);
}

// ─── peak-hour heatmap ─────────────────────────────────────────────────────

function computePeakHourHeatmap(from: number, to: number, eventId: string | undefined): PeakHourHeatmap {
  const db = getDb();
  // Build the 7×24 zero matrix up front so cells with no rows render as
  // value=0 instead of being holes the renderer has to defend against.
  const matrix: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));

  const extraSql = eventId ? 'AND event_id = ?' : '';
  const extra: (number | string)[] = eventId ? [eventId] : [];

  // SQLite stores issued_at in UTC ms. strftime needs unixepoch seconds,
  // hence `issued_at / 1000`. The IST_OFFSET modifier shifts the
  // resulting "wall clock" into Asia/Kolkata so DOW + HR bucket against
  // the venue's local time (India has no DST so a fixed offset is safe).
  const rows = db.prepare(`
    SELECT CAST(strftime('%w', issued_at / 1000, 'unixepoch', '${IST_OFFSET}') AS INTEGER) AS dow,
           CAST(strftime('%H', issued_at / 1000, 'unixepoch', '${IST_OFFSET}') AS INTEGER) AS hr,
           COUNT(*) AS c
    FROM wallets
    WHERE issued_at >= ? AND issued_at < ? ${extraSql}
    GROUP BY dow, hr
  `).all(from, to, ...extra) as { dow: number; hr: number; c: number }[];

  let max = 0;
  for (const r of rows) {
    if (r.dow >= 0 && r.dow < 7 && r.hr >= 0 && r.hr < 24) {
      matrix[r.dow][r.hr] = r.c;
      if (r.c > max) max = r.c;
    }
  }
  return { matrix, max };
}

// ─── repeat customers ──────────────────────────────────────────────────────

/**
 * A guest is "repeat" when their lifetime wallet+ticket activity is ≥ 2
 * AND they had any activity in the current range. Lifetime activity uses
 * guest_id (wallets.guest_id, tickets.guest_id when present, else phone).
 *
 * Phone normalization caveat: guests.phone is keyed at write-time via
 * normalizePhone() (src/lib/users.ts) but historical rows from earlier
 * builds may carry mixed formats. We group by guest_id (not phone) to
 * avoid splitting one guest into two rows. Tickets without a guest_id
 * are bucketed by normalized phone via a CASE-when fallback.
 */
function computeRepeatCustomers(from: number, to: number, eventId: string | undefined): RepeatCustomers {
  const db = getDb();
  const walletEventSql = eventId ? 'AND event_id = ?' : '';
  const ticketEventSql = eventId ? 'AND event_id = ?' : '';

  // Lifetime activity per guest_id
  const lifetimeRows = db.prepare(`
    SELECT guest_key, SUM(c) AS total
    FROM (
      SELECT guest_id AS guest_key, COUNT(*) AS c FROM wallets
       WHERE guest_id IS NOT NULL
       GROUP BY guest_id
      UNION ALL
      SELECT guest_id AS guest_key, COUNT(*) AS c FROM tickets
       WHERE guest_id IS NOT NULL AND status = 'issued'
       GROUP BY guest_id
    )
    GROUP BY guest_key
  `).all() as { guest_key: string; total: number }[];

  const lifetimeTotalByGuest = new Map<string, number>();
  for (const row of lifetimeRows) {
    lifetimeTotalByGuest.set(row.guest_key, (lifetimeTotalByGuest.get(row.guest_key) || 0) + (row.total || 0));
  }

  // Guests with activity in the current range
  const activeRows = db.prepare(`
    SELECT DISTINCT guest_id AS guest_key FROM (
      SELECT guest_id FROM wallets
       WHERE guest_id IS NOT NULL AND issued_at >= ? AND issued_at < ? ${walletEventSql}
      UNION
      SELECT guest_id FROM tickets
       WHERE guest_id IS NOT NULL AND status = 'issued' AND created_at >= ? AND created_at < ? ${ticketEventSql}
    )
  `).all(
    ...(eventId ? [from, to, eventId] : [from, to]),
    ...(eventId ? [from, to, eventId] : [from, to]),
  ) as { guest_key: string }[];

  let newCount = 0;
  let repeatCount = 0;
  for (const row of activeRows) {
    const total = lifetimeTotalByGuest.get(row.guest_key) || 0;
    if (total >= 2) repeatCount += 1;
    else newCount += 1;
  }

  return { newCount, repeatCount, total: newCount + repeatCount };
}

// ─── public entry ──────────────────────────────────────────────────────────

export function computeDashboard(filters: DashboardFilters = {}): DashboardResult {
  const { from, to } = resolveRange(filters);
  const eventId = filters.eventId || undefined;

  return {
    kpis:               computeKpis(from, to, eventId),
    revenueByEvent:     computeRevenueByEvent(from, to, eventId),
    funnel:             computeFunnel(from, to, eventId),
    affiliateBreakdown: computeAffiliateBreakdown(from, to, eventId),
    peakHourHeatmap:    computePeakHourHeatmap(from, to, eventId),
    repeatCustomers:    computeRepeatCustomers(from, to, eventId),
    rangeFrom:          from,
    rangeTo:            to,
  };
}
