import { getDb, getConfig, setConfig } from './db';
import { nanoid } from 'nanoid';
import { logAudit } from './audit';
import { getProvider, type ProviderId } from './providers';
import { getEvent } from './events';
import { normalizePhone } from './users';

export type ReservationStatus = 'pending' | 'converted' | 'no_show' | 'cancelled';

/**
 * The on-the-night ledger status used by the multi-stage check-in + cover
 * redemption feature. Distinct from `status` (which tracks the booking
 * lifecycle pending→converted/no_show/cancelled driven by webhooks). Kept
 * in a separate column so the two state machines don't collide.
 */
export type ReservationLedgerStatusValue =
  | 'pending'
  | 'partially_checked_in'
  | 'fully_checked_in'
  | 'closed';

export interface ReservationRow {
  id: string;
  event_id: string | null;       // nullable now: reservations exist independently
  event_date: string | null;     // YYYY-MM-DD — survives even when event_id is null
  provider: string;
  external_ref: string | null;
  name: string;
  phone: string;
  email: string | null;
  /**
   * Total party size — physical storage column. Code that reads pax today
   * keeps working unchanged. The multi-stage check-in feature also writes
   * a parallel `total_pax` column (backfilled from `pax`) so future callers
   * can migrate to a stable name; until then `pax` remains the source of
   * truth and `total_pax` is treated as a denormalized mirror.
   */
  pax: number;
  arrival_time: string | null;
  notes: string | null;
  status: ReservationStatus;
  converted_wallet_txn: string | null;
  synced_at: number;
  raw: string | null;
  booking_time: string | null;
  tables_json: string | null;
  tags_json: string | null;
  custom_tags_json: string | null;
  preferences_json: string | null;
  bday: string | null;
  anniv: string | null;
  total_visits: number | null;
  // Phase 3: Multi-slot schedule — nullable, ignored when an event has no
  // active event_slots rows (back-compat: existing reservations keep working).
  slot_id: string | null;
  // Phase 4: RSVP form answers. JSON {fieldId: string | string[]}; NULL when
  // the event had no rsvp_fields configured at booking time. The renderer in
  // /admin/reservations joins on the live event.rsvp_fields to label them.
  rsvp_answers_json: string | null;
  // ─── Multi-stage check-in + cover redemption (reservation-as-wallet) ───
  // All numeric counters default 0 at the schema layer so legacy rows
  // never read as null. total_pax is a denormalized mirror of pax (see
  // doc above); the lib layer keeps them in sync where needed and the
  // ledger module reads pax first, total_pax second.
  /**
   * Mirror of `pax` maintained by the application layer. Use `total_pax`
   * for booked-capacity reads; `pax` for legacy compatibility. Both must
   * stay in sync — every insert/update of pax MUST also update total_pax.
   */
  total_pax: number | null;
  checked_in_pax: number | null;
  entry_amount: number | null;
  cover_amount: number | null;
  cover_redeemed: number | null;
  reservation_status: ReservationLedgerStatusValue | null;
  // ─── Seating layout ─────────────────────────────────────────────────────
  // When the event has seating_layout_enabled = 1, the public booking flow
  // stores the chosen zone here. zone_pax_count mirrors `pax` (denormalized
  // so analytics can SUM without re-joining), and zone_price_snapshot is
  // the per-seat INR the customer was QUOTED at booking time — preserved
  // even if admin later edits event_zones.price. All NULL on flat-pricing
  // events.
  zone_id: string | null;
  zone_pax_count: number | null;
  zone_price_snapshot: number | null;
  // ─── M/F/C breakdown (per-category covers) ─────────────────────────────
  // Stamped by /api/payments/verify from the genderMix the customer entered
  // on the public booking form. Used to render the "2M · 1F · 1C" pill on
  // the admin reservations list + drive door-staff expectations before scan.
  // Default 0 at schema level — legacy rows always read as 0.
  male_count: number | null;
  female_count: number | null;
  couple_count: number | null;
  // ─── Reservego prepay (online cover-payment link) ──────────────────────
  // payment_link_sent_at: unix ms when the host issued the latest link.
  // payment_link_token: the HMAC-signed token baked into /p/<token>. When
  //                      the host sends a NEW link this is overwritten so
  //                      the old link returns 410 even if HMAC-valid.
  // payment_id: FK to payments.id once the customer actually pays.
  //              NULL when the row's never paid online (manual venue
  //              settlement still flips reservations.status='converted' +
  //              writes converted_wallet_txn, but leaves payment_id NULL).
  payment_link_sent_at: number | null;
  payment_link_token: string | null;
  payment_id: string | null;
}

export function listReservationsForEvent(eventId: string): ReservationRow[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM reservations WHERE event_id = ? ORDER BY arrival_time ASC, name ASC`
  ).all(eventId) as ReservationRow[];
}

export interface ReservationWithEvent extends ReservationRow {
  event_name: string | null;
  event_status: string | null;
}

/**
 * Returns ALL reservations (assigned to an event OR unassigned). Joins
 * the event name/status when present. Sorted: most recent event_date first,
 * then arrival_time, then name.
 *
 * Used by the unified reservations admin view that shows everything in
 * one table regardless of whether an event is linked.
 */
export function listAllReservations(): ReservationWithEvent[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      r.*,
      e.name   AS event_name,
      e.status AS event_status
    FROM reservations r
    LEFT JOIN events e ON e.id = r.event_id
    ORDER BY r.event_date DESC, r.arrival_time ASC, r.name ASC
  `).all() as ReservationWithEvent[];
}

export function getReservation(id: string): ReservationRow | null {
  const db = getDb();
  return (
    (db.prepare('SELECT * FROM reservations WHERE id = ?').get(id) as ReservationRow | undefined) ?? null
  );
}

export async function syncReservationsForEvent(eventId: string, providerId: ProviderId): Promise<{
  fetched: number;
  inserted: number;
  existing: number;
}> {
  const event = getEvent(eventId);
  if (!event) throw new Error(`Event ${eventId} not found`);

  const provider = getProvider(providerId);
  const rows = await provider.fetchForDate(event.event_date);

  const db = getDb();
  const now = Date.now();
  let inserted = 0, existing = 0;

  const insert = db.prepare(`
    INSERT INTO reservations
      (id, event_id, provider, external_ref, name, phone, email, pax, total_pax, arrival_time, notes, status, synced_at, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `);

  const findExisting = db.prepare(
    `SELECT id FROM reservations WHERE provider = ? AND external_ref = ?`
  );

  const tx = db.transaction(() => {
    for (const r of rows) {
      const hit = findExisting.get(providerId, r.externalRef);
      if (hit) { existing++; continue; }
      const paxValue = Number(r.pax) || 1;
      insert.run(
        nanoid(),
        eventId,
        providerId,
        r.externalRef,
        r.name,
        r.phone,
        r.email || null,
        paxValue,
        // total_pax: mirror invariant — keep in sync with pax on every write.
        paxValue,
        r.arrivalTime || null,
        r.notes || null,
        now,
        JSON.stringify(r.raw ?? {}),
      );
      inserted++;
    }
  });
  tx();

  logAudit({
    actor: 'admin',
    action: 'reservations_sync',
    entityType: 'event',
    entityId: eventId,
    details: { provider: providerId, fetched: rows.length, inserted, existing },
  });

  return { fetched: rows.length, inserted, existing };
}

/**
 * Point a reservation at the wallet it converted into.
 *
 * Guarded and audited, unlike the bare UPDATE this used to be. There is no
 * unique index on wallets.reservation_id, no idempotency key on
 * POST /api/wallets and no dedupe on (phone, event_id), so a slow response on
 * venue wifi plus an operator re-tap minted a SECOND funded wallet with a
 * second live PIN against one booking — and repointed converted_wallet_txn at
 * it, destroying the link to the first wallet. Its two siblings below
 * (markReservationNoShow, cancelReservation) both write an audit row; this one
 * wrote nothing at all, so the pointer moved with no trace on the History page.
 *
 * Called from inside issueWallet's transaction: throwing here rolls the wallet
 * back, which is the only thing that actually prevents the duplicate.
 *
 * Two deliberate non-throw cases:
 *  - Same wallet again → no-op. issueWallet and refundable-entries both call
 *    this for the same txn (the latter on purpose, defensively), and a webhook
 *    replay can too; none of those is an error and none should double-audit.
 *  - Reservation row missing → no-op. A deleted booking is not a
 *    double-funding risk, and failing here would refuse a wallet at a till
 *    where the cash has already been taken.
 */
export function markReservationConverted(id: string, walletTxn: string) {
  const db = getDb();
  const existing = db.prepare(
    `SELECT status, converted_wallet_txn FROM reservations WHERE id = ?`,
  ).get(id) as { status: ReservationStatus; converted_wallet_txn: string | null } | undefined;

  if (!existing) return;
  if (existing.converted_wallet_txn === walletTxn) return;

  if (existing.status === 'converted' && existing.converted_wallet_txn) {
    throw new Error(
      `Reservation already converted to wallet ${existing.converted_wallet_txn}. ` +
      `Redeem that wallet instead of issuing a second one.`,
    );
  }

  db.prepare(
    `UPDATE reservations SET status = 'converted', converted_wallet_txn = ? WHERE id = ?`
  ).run(walletTxn, id);

  logAudit({
    actor: 'system',
    action: 'reservation_converted',
    entityType: 'reservation',
    entityId: id,
    details: { wallet_txn: walletTxn, previous_status: existing.status },
  });
}

export function markReservationNoShow(id: string) {
  const db = getDb();
  db.prepare(`UPDATE reservations SET status = 'no_show' WHERE id = ?`).run(id);
  logAudit({ actor: 'admin', action: 'reservation_no_show', entityType: 'reservation', entityId: id });
}

export function cancelReservation(id: string, actor: string): ReservationRow | null {
  const db = getDb();
  const existing = getReservation(id);
  if (!existing) return null;
  if (existing.status === 'cancelled') return existing;
  db.prepare(`UPDATE reservations SET status = 'cancelled' WHERE id = ?`).run(id);
  logAudit({ actor, action: 'reservation_cancel', entityType: 'reservation', entityId: id });
  return getReservation(id);
}

// ─── Manual entry ──────────────────────────────────────────────────────────

export interface CreateManualReservationInput {
  /** Booking date in YYYY-MM-DD. Required. If an event exists for this date,
   *  the reservation auto-links to it; otherwise it lands unassigned and will
   *  auto-link when an event for this date is later created. */
  eventDate: string;
  /** Explicit event override — if provided and valid, skips date-based lookup */
  eventId?: string | null;
  name: string;
  phone: string;
  email?: string | null;
  pax?: number;
  arrivalTime?: string | null;
  notes?: string | null;
  createdBy: string;
  /**
   * Phase 3: optional time slot (must belong to the resolved event). Caller
   * is responsible for capacity checks — this is an admin path used for
   * manual entry where overbooking is allowed at the host's discretion.
   */
  slotId?: string | null;
  /**
   * Phase 4: optional RSVP answers — {fieldId: string | string[]}. The caller
   * is responsible for validating these against the event's rsvp_fields (the
   * admin manual-entry path generally trusts the host so we don't re-validate
   * here). Persisted as JSON in reservations.rsvp_answers_json; pass null /
   * undefined to leave the column NULL.
   */
  rsvpAnswers?: Record<string, string | string[]> | null;
  /**
   * M/F/C breakdown — persisted to male_count / female_count / couple_count
   * on the reservation row so the admin list + door staff see the split.
   * Pass null / undefined to leave all three columns at 0 (legacy path).
   */
  genderMix?: { male: number; female: number; couple: number } | null;
}

export function createManualReservation(input: CreateManualReservationInput): ReservationRow {
  if (!input.eventDate?.trim()) throw new Error('Booking date is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.eventDate.trim())) {
    throw new Error('Booking date must be YYYY-MM-DD.');
  }
  if (!input.name?.trim()) throw new Error('Name is required.');
  if (!input.phone?.trim()) throw new Error('Phone is required.');

  // Resolve event_id: explicit override wins; otherwise look up by date.
  // No matching event found? That's fine — store with event_id = null. The
  // reservation will auto-link when an event for this date is later created
  // (handled by linkUnassignedReservationsToEvent in createEvent).
  let resolvedEventId: string | null = null;
  if (input.eventId) {
    const ev = getEvent(input.eventId);
    if (ev) resolvedEventId = ev.id;
  }
  if (!resolvedEventId) {
    const db = getDb();
    const row = db.prepare(
      `SELECT id FROM events WHERE event_date = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1`,
    ).get(input.eventDate.trim()) as { id: string } | undefined;
    if (row) resolvedEventId = row.id;
  }

  const phone = normalizePhone(input.phone);
  if (!phone) throw new Error('Invalid phone number.');

  const pax = Math.max(1, Math.floor(Number(input.pax ?? 1)));
  if (!Number.isFinite(pax)) throw new Error('PAX must be a positive integer.');

  const db = getDb();
  const id = nanoid();
  const now = Date.now();

  // Validate slot_id belongs to the resolved event before stamping it.
  // We don't enforce capacity here — manual entry is a host override path.
  let slotId: string | null = null;
  if (input.slotId && resolvedEventId) {
    const slotRow = db
      .prepare('SELECT id FROM event_slots WHERE id = ? AND event_id = ?')
      .get(input.slotId, resolvedEventId) as { id: string } | undefined;
    if (slotRow) slotId = slotRow.id;
  }

  // Stringify RSVP answers — null when no answers were supplied so we leave
  // the column NULL rather than '{}', which keeps the admin reservation view
  // able to distinguish "no answers" from "empty answers".
  const rsvpAnswersJson =
    input.rsvpAnswers && typeof input.rsvpAnswers === 'object'
      ? JSON.stringify(input.rsvpAnswers)
      : null;

  // M/F/C breakdown — non-negative ints; default 0 so legacy callers
  // omitting the field write zeros and read back as 0.
  const mxMale = Math.max(0, Math.floor(Number(input.genderMix?.male ?? 0)));
  const mxFemale = Math.max(0, Math.floor(Number(input.genderMix?.female ?? 0)));
  const mxCouple = Math.max(0, Math.floor(Number(input.genderMix?.couple ?? 0)));

  db.prepare(`
    INSERT INTO reservations
      (id, event_id, event_date, provider, external_ref, name, phone, email, pax, total_pax,
       arrival_time, notes, status, synced_at, raw, slot_id, rsvp_answers_json,
       male_count, female_count, couple_count)
    VALUES (?, ?, ?, 'manual', NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    resolvedEventId,
    input.eventDate.trim(),
    input.name.trim(),
    phone,
    input.email?.trim() || null,
    pax,
    // total_pax: mirror invariant — keep in sync with pax on every write.
    pax,
    input.arrivalTime?.trim() || null,
    input.notes?.trim() || null,
    now,
    JSON.stringify({ created_by: input.createdBy, source: 'manual' }),
    slotId,
    rsvpAnswersJson,
    mxMale,
    mxFemale,
    mxCouple,
  );

  logAudit({
    actor: input.createdBy,
    action: 'reservation_create_manual',
    entityType: 'reservation',
    entityId: id,
    details: {
      event_id: resolvedEventId,
      event_date: input.eventDate,
      attached: !!resolvedEventId,
      name: input.name,
      phone,
      pax,
    },
  });

  return getReservation(id)!;
}

// ─── Webhook ingestion (Reservego et al.) ──────────────────────────────────

/**
 * Normalized payload shape. The webhook receiver parses the provider's raw
 * JSON into this shape using permissive field-name matching, so the same
 * lib function can serve future providers too.
 */
export interface WebhookReservationPayload {
  externalRef: string;       // provider's unique reservation id
  eventDate?: string;        // ISO yyyy-mm-dd — used to resolve event_id
  eventId?: string;          // explicit event_id if Reservego knows it
  name: string;
  phone: string;
  email?: string | null;
  pax?: number;
  arrivalTime?: string | null;
  notes?: string | null;
  /** Provider status string (we map common cancelled/no-show terms below) */
  status?: string;
  /** Full original payload, kept for audit + future reprocessing */
  raw: unknown;
  /** Raw booking timestamp from Reservego — preserved verbatim for audit. */
  bookingTime?: string | null;
  /** tableNames array — stored as JSON string in tables_json. */
  tables?: string[];
  /** rsrvTags array (e.g. ["Birthday","Anniversary"]). */
  tags?: string[];
  /** custTags array (customer-level tags). */
  customTags?: string[];
  /** preferences array (e.g. ["Kids Friendly","Low Music"]). */
  preferences?: string[];
  /** Birthday YYYY-MM-DD (sliced from ISO). */
  bday?: string | null;
  /** Anniversary YYYY-MM-DD (sliced from ISO). */
  anniv?: string | null;
  /** Lifetime visit count for the guest. */
  totalVisits?: number | null;
  /**
   * Phase 4: RSVP form answers — {fieldId: string | string[]}. Most webhook
   * providers won't send this since the field defs are EventCover-specific;
   * the field is here so any provider that mirrors our public form can hand
   * answers through (e.g. a future first-party form-fill endpoint).
   */
  rsvpAnswers?: Record<string, string | string[]> | null;
}

export interface UpsertResult {
  action: 'created' | 'updated' | 'cancelled' | 'unchanged';
  reservation: ReservationRow;
}

// ─── Auto-link unassigned reservations to a newly-created event ───────────

/**
 * Called from createEvent (in lib/events.ts) right after a new event row
 * lands. Finds every reservation for that date with event_id IS NULL and
 * attaches them to the new event. This is what makes the "operator creates
 * an event → existing unassigned reservations flow in automatically"
 * behavior work.
 *
 * Returns the count linked so the createEvent caller can surface it in
 * the audit log or success message.
 */
export function linkUnassignedReservationsToEvent(eventId: string, eventDate: string): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE reservations
    SET event_id = ?
    WHERE event_id IS NULL AND event_date = ?
  `).run(eventId, eventDate);

  if (result.changes > 0) {
    logAudit({
      actor: 'system',
      action: 'reservations_auto_link',
      entityType: 'event',
      entityId: eventId,
      details: { event_date: eventDate, count: result.changes },
    });
  }
  return result.changes;
}

// ─── Search reservations (powers the Issue Cover lookup) ─────────────────

export interface ReservationSearchHit extends ReservationRow {
  event_name: string | null;
  event_status: string | null;
}

/**
 * Find reservations by phone (exact + substring) or by name (substring).
 *
 * Called from the Issue Cover page so door staff can pull up a customer's
 * reservation details (esp. pax count) when they arrive at the door — by
 * mobile number OR by name.
 *
 * Cancelled reservations are excluded. Results sorted by event_date DESC
 * (most recent upcoming bookings first).
 */
export function searchReservations(input: {
  query?: string;       // free-text — matches name OR phone (LIKE %q%)
  phone?: string;       // exact phone (after normalization) + substring fallback
  eventId?: string;     // restrict to one event
  limit?: number;
}): ReservationSearchHit[] {
  const db = getDb();
  const limit = Math.min(50, Math.max(1, input.limit || 20));

  const where: string[] = [];
  const params: (string | number)[] = [];

  if (input.phone) {
    // Try exact normalized phone first, fall back to substring on raw + digits
    const normalized = normalizePhone(input.phone);
    const digitsOnly = input.phone.replace(/\D/g, '');
    if (normalized) {
      where.push('(r.phone = ? OR r.phone LIKE ?)');
      params.push(normalized, `%${digitsOnly}%`);
    } else if (digitsOnly) {
      where.push('r.phone LIKE ?');
      params.push(`%${digitsOnly}%`);
    }
  }

  if (input.query) {
    const q = input.query.trim();
    if (q) {
      const digitsOnly = q.replace(/\D/g, '');
      if (digitsOnly && digitsOnly.length >= 4) {
        // Numeric-ish query — search both name AND phone digits
        where.push('(LOWER(r.name) LIKE LOWER(?) OR r.phone LIKE ?)');
        params.push(`%${q}%`, `%${digitsOnly}%`);
      } else {
        // Pure name search
        where.push('LOWER(r.name) LIKE LOWER(?)');
        params.push(`%${q}%`);
      }
    }
  }

  if (input.eventId) {
    where.push('r.event_id = ?');
    params.push(input.eventId);
  }

  // Don't surface cancelled reservations — operator probably isn't checking
  // someone in who already cancelled
  where.push("r.status != 'cancelled'");

  if (where.length === 0) return [];

  const sql = `
    SELECT
      r.*,
      e.name   AS event_name,
      e.status AS event_status
    FROM reservations r
    LEFT JOIN events e ON e.id = r.event_id
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE WHEN r.event_date >= date('now', 'localtime') THEN 0 ELSE 1 END,
      r.event_date ASC,
      r.synced_at DESC
    LIMIT ?
  `;
  params.push(limit);

  return db.prepare(sql).all(...params) as ReservationSearchHit[];
}

// ─── Unassigned reservations (no event yet) ───────────────────────────────

export interface UnassignedGroup {
  event_date: string;
  count: number;
  reservations: ReservationRow[];
}

/**
 * Returns reservations grouped by event_date where event_id IS NULL.
 * Powers the "Unassigned" section on /admin/reservations — operator can
 * see what's coming in and decide whether to spin up an event for that day.
 */
export function listUnassignedReservationsByDate(): UnassignedGroup[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM reservations
    WHERE event_id IS NULL AND event_date IS NOT NULL
    ORDER BY event_date ASC, arrival_time ASC, name ASC
  `).all() as ReservationRow[];

  // Group by date
  const groups = new Map<string, ReservationRow[]>();
  for (const r of rows) {
    const key = r.event_date || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  return Array.from(groups.entries())
    .map(([event_date, reservations]) => ({
      event_date,
      count: reservations.length,
      reservations,
    }))
    .sort((a, b) => a.event_date.localeCompare(b.event_date));
}

function mapInboundStatus(s: string | undefined): ReservationStatus | null {
  if (!s) return null;
  const norm = String(s).toLowerCase().trim();

  // Numeric status codes (Reservego sends an integer). Without authoritative
  // docs from Reservego, we make conservative guesses based on common
  // reservation-platform conventions:
  //   1, 2, 3  → pending (booked / confirmed / re-confirmed)
  //   4        → cancelled
  //   5        → no_show
  //   6, 7     → converted (arrived / seated / completed)
  // Unknown codes are treated as 'pending' so we never silently drop bookings.
  // The host can manually adjust the row's status in the UI if our guess
  // turns out to be wrong for any specific code.
  if (/^\d+$/.test(norm)) {
    const code = Number(norm);
    if (code === 4) return 'cancelled';
    if (code === 5) return 'no_show';
    if (code === 6 || code === 7) return 'converted';
    return 'pending';
  }

  // String values
  if (['cancelled', 'canceled', 'void', 'voided', 'rejected'].includes(norm)) return 'cancelled';
  if (['no_show', 'noshow', 'no-show', 'noshow_marked'].includes(norm)) return 'no_show';
  if (['converted', 'arrived', 'seated', 'checked_in', 'completed', 'done'].includes(norm)) return 'converted';
  return 'pending';
}

/**
 * Idempotent upsert. Matches by (provider, external_ref) — repeated deliveries
 * of the same webhook update the existing row rather than duplicating.
 */
export function upsertFromWebhook(
  payload: WebhookReservationPayload,
  provider: string,
): UpsertResult {
  if (!payload.externalRef) throw new Error('externalRef is required.');

  const db = getDb();

  // Look up an existing row first — if found, this is an UPDATE and we can
  // fill in any missing fields from the existing record (Reservego's
  // "Update Booking" webhook may send a partial payload).
  const existing = db.prepare(
    `SELECT * FROM reservations WHERE provider = ? AND external_ref = ?`,
  ).get(provider, payload.externalRef) as ReservationRow | undefined;

  // Try to auto-link this reservation to an existing event for the date.
  // No event yet? Totally fine — reservation lands with event_id = NULL and
  // shows up in the Unassigned section until the operator creates an event
  // for that date (which will auto-link it).
  let eventId: string | null = null;
  if (payload.eventId) {
    const ev = getEvent(payload.eventId);
    if (ev) eventId = ev.id;
  }
  if (!eventId && payload.eventDate) {
    const row = db.prepare(
      `SELECT id FROM events WHERE event_date = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1`,
    ).get(payload.eventDate) as { id: string } | undefined;
    if (row) eventId = row.id;
  }
  if (!eventId && existing) eventId = existing.event_id;

  // The booking date is the source of truth even when event_id is null.
  // Must be present for any reservation (NEW or update) so the Unassigned
  // view can group by date and auto-link later.
  const eventDate = payload.eventDate || existing?.event_date || null;
  if (!eventDate) {
    throw new Error('Booking date (event_date / bookingTime) is required.');
  }

  // Name + phone: required for NEW reservations, optional for updates
  const rawName = payload.name?.trim() || '';
  const rawPhone = payload.phone?.trim() || '';

  if (!existing && !rawName) throw new Error('Name is required for new reservations.');
  if (!existing && !rawPhone) throw new Error('Phone is required for new reservations.');

  const name = rawName || existing!.name;
  const phone = rawPhone ? normalizePhone(rawPhone) : existing!.phone;
  if (!phone) throw new Error('Invalid phone in payload.');

  const email = payload.email?.trim() ?? existing?.email ?? null;
  const pax = payload.pax != null
    ? Math.max(1, Math.floor(Number(payload.pax)))
    : (existing?.pax ?? 1);
  const arrivalTime = payload.arrivalTime?.trim() ?? existing?.arrival_time ?? null;
  const notes = payload.notes?.trim() ?? existing?.notes ?? null;
  const mappedStatus = mapInboundStatus(payload.status);

  // Rich Reservego fields. The `?.length` check is deliberate: when the
  // provider sends an empty array (e.g. `tableNames: []`) we treat that as
  // "no data, keep what we have" rather than "clear it". Reservego's Update
  // Booking webhook routinely sends a sparse payload — we don't want a
  // partial delivery to wipe out tags the operator already saw.
  const bookingTime = payload.bookingTime || existing?.booking_time || null;
  const tablesJson = payload.tables?.length ? JSON.stringify(payload.tables) : (existing?.tables_json ?? null);
  const tagsJson = payload.tags?.length ? JSON.stringify(payload.tags) : (existing?.tags_json ?? null);
  const customTagsJson = payload.customTags?.length ? JSON.stringify(payload.customTags) : (existing?.custom_tags_json ?? null);
  const preferencesJson = payload.preferences?.length ? JSON.stringify(payload.preferences) : (existing?.preferences_json ?? null);
  const bday = payload.bday !== undefined ? payload.bday : (existing?.bday ?? null);
  const anniv = payload.anniv !== undefined ? payload.anniv : (existing?.anniv ?? null);
  const totalVisits = payload.totalVisits != null ? Number(payload.totalVisits) : (existing?.total_visits ?? null);

  // RSVP answers — preserve existing value when the payload omits the key
  // (sparse webhook update). An explicit `null` clears the column.
  const rsvpAnswersJson =
    payload.rsvpAnswers === undefined
      ? (existing?.rsvp_answers_json ?? null)
      : payload.rsvpAnswers === null
        ? null
        : JSON.stringify(payload.rsvpAnswers);

  const now = Date.now();
  const rawJson = JSON.stringify(payload.raw ?? payload);

  if (existing) {
    db.prepare(`
      UPDATE reservations
      SET event_id = ?, event_date = ?, name = ?, phone = ?, email = ?, pax = ?, total_pax = ?,
          arrival_time = ?, notes = ?, status = ?, synced_at = ?, raw = ?,
          booking_time = ?, tables_json = ?, tags_json = ?, custom_tags_json = ?,
          preferences_json = ?, bday = ?, anniv = ?, total_visits = ?,
          rsvp_answers_json = ?
      WHERE id = ?
    `).run(
      eventId,
      eventDate,
      name,
      phone,
      email || null,
      pax,
      // total_pax: mirror invariant — keep in sync with pax on every write.
      pax,
      arrivalTime || null,
      notes || null,
      mappedStatus || existing.status,
      now,
      rawJson,
      bookingTime,
      tablesJson,
      tagsJson,
      customTagsJson,
      preferencesJson,
      bday,
      anniv,
      totalVisits,
      rsvpAnswersJson,
      existing.id,
    );

    logAudit({
      actor: `webhook:${provider}`,
      action: 'reservation_webhook_update',
      entityType: 'reservation',
      entityId: existing.id,
      details: { external_ref: payload.externalRef, status: mappedStatus, event_id: eventId },
    });

    return {
      action: mappedStatus === 'cancelled' ? 'cancelled' : 'updated',
      reservation: getReservation(existing.id)!,
    };
  }

  // Fresh insert
  const id = nanoid();
  db.prepare(`
    INSERT INTO reservations
      (id, event_id, event_date, provider, external_ref, name, phone, email, pax, total_pax,
       arrival_time, notes, status, synced_at, raw,
       booking_time, tables_json, tags_json, custom_tags_json,
       preferences_json, bday, anniv, total_visits,
       rsvp_answers_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?,
            ?)
  `).run(
    id,
    eventId,
    eventDate,
    provider,
    payload.externalRef,
    name,
    phone,
    email || null,
    pax,
    // total_pax: mirror invariant — keep in sync with pax on every write.
    pax,
    arrivalTime || null,
    notes || null,
    mappedStatus || 'pending',
    now,
    rawJson,
    bookingTime,
    tablesJson,
    tagsJson,
    customTagsJson,
    preferencesJson,
    bday,
    anniv,
    totalVisits,
    rsvpAnswersJson,
  );

  logAudit({
    actor: `webhook:${provider}`,
    action: 'reservation_webhook_create',
    entityType: 'reservation',
    entityId: id,
    details: {
      external_ref: payload.externalRef,
      event_id: eventId,
      event_date: eventDate,
      attached: !!eventId,
      name,
      pax,
    },
  });

  return { action: 'created', reservation: getReservation(id)! };
}

// ─── Webhook health / stats ────────────────────────────────────────────────

export type WebhookHealth = 'not_configured' | 'untested' | 'healthy' | 'error';

export interface WebhookStats {
  health: WebhookHealth;
  configured: boolean;
  lastAt: number;          // epoch ms, 0 if never
  lastAction: string;      // 'created' | 'updated' | 'error:...'
  lastStatus: string;
  reservationCountThisMonth: number;
}

export function getWebhookStats(provider: string = 'reservego'): WebhookStats {
  const secret = getConfig('RESERVEGO_WEBHOOK_SECRET');
  const lastAt = Number(getConfig('RESERVEGO_WEBHOOK_LAST_AT', '0')) || 0;
  const lastAction = getConfig('RESERVEGO_WEBHOOK_LAST_ACTION', '');
  const lastStatus = getConfig('RESERVEGO_WEBHOOK_LAST_STATUS', '');

  const configured = !!secret;
  let health: WebhookHealth = 'not_configured';
  if (configured) {
    if (lastAt === 0) health = 'untested';
    else if (lastAction.startsWith('error')) health = 'error';
    else health = 'healthy';
  }

  // Count reservations received from this provider in the last 30 days
  const db = getDb();
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM reservations WHERE provider = ? AND synced_at >= ?`,
  ).get(provider, since) as { c: number };

  return {
    health,
    configured,
    lastAt,
    lastAction,
    lastStatus,
    reservationCountThisMonth: row.c,
  };
}

export function recordWebhookHit(action: string, status: string) {
  setConfig('RESERVEGO_WEBHOOK_LAST_AT', String(Date.now()));
  setConfig('RESERVEGO_WEBHOOK_LAST_ACTION', action);
  setConfig('RESERVEGO_WEBHOOK_LAST_STATUS', status);
}

export function regenerateWebhookSecret(): string {
  const secret = nanoid(40);
  setConfig('RESERVEGO_WEBHOOK_SECRET', secret);
  return secret;
}
