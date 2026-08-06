/**
 * Derived booking availability — shared by the public detail route and the
 * public list route so both agree on when an event is bookable.
 *
 * Precedence (first match wins):
 *   1. status = 'closed'                  → closed, "Booking closed"
 *   2. event_date before today (IST)      → closed, "Event has ended"
 *   3. capacity > 0 AND sold >= capacity  → closed, "Sold out"
 *   4. capacity > 0 AND sold >= 80%       → open,   "Selling fast"
 *   5. otherwise                          → open,   "Book now"
 *
 * `sold` counts booked PAX (not reservation rows) across non-cancelled
 * reservations — a Table-of-6 consumes six seats of the venue's capacity,
 * not one. capacity = 0 means unlimited, so sold-out is never derived from
 * headcount for those events.
 *
 * The list route renders up to 100 cards per request, so it must not issue
 * one COUNT per event. `soldPaxForEvents()` batches the whole page into a
 * single GROUP BY, and `deriveBookingState()` takes the already-fetched
 * count rather than querying — keeping the N+1 impossible by construction.
 */

import { getDb } from './db';

export interface BookingState {
  booking_open: boolean;
  booking_status_label: string;
  capacity_sold: number;
}

/** Minimal row shape the derivation needs. */
export interface BookingStateInput {
  status: string;
  event_date: string;
  capacity?: number | null;
}

/** Today's date in IST — the venue's operating timezone. An event dated
 *  2026-06-15 stays bookable through the whole of that day. */
export function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * Booked pax for a set of events, in ONE query. Returns a Map keyed by
 * event_id; ids with no reservations are absent (caller treats as 0).
 * Empty input short-circuits without touching the DB.
 */
export function soldPaxForEvents(eventIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (eventIds.length === 0) return out;

  const db = getDb();
  const placeholders = eventIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT event_id, COALESCE(SUM(pax), 0) AS sold
    FROM reservations
    WHERE event_id IN (${placeholders})
      AND status NOT IN ('cancelled', 'no_show')
    GROUP BY event_id
  `).all(...eventIds) as { event_id: string; sold: number }[];

  for (const r of rows) out.set(r.event_id, Number(r.sold) || 0);
  return out;
}

/** Booked pax for a single event. Convenience wrapper for the detail route. */
export function soldPaxForEvent(eventId: string): number {
  return soldPaxForEvents([eventId]).get(eventId) ?? 0;
}

/**
 * Pure derivation — takes the pre-fetched `sold` count so callers control
 * their own query batching. No DB access here.
 */
export function deriveBookingState(row: BookingStateInput, sold: number): BookingState {
  const capacity = Number(row.capacity) || 0;

  if (row.status === 'closed') {
    return { booking_open: false, booking_status_label: 'Booking closed', capacity_sold: sold };
  }
  if (row.event_date < todayIST()) {
    return { booking_open: false, booking_status_label: 'Event has ended', capacity_sold: sold };
  }
  if (capacity > 0) {
    if (sold >= capacity) {
      return { booking_open: false, booking_status_label: 'Sold out', capacity_sold: sold };
    }
    if (sold >= capacity * 0.8) {
      return { booking_open: true, booking_status_label: 'Selling fast', capacity_sold: sold };
    }
  }
  return { booking_open: true, booking_status_label: 'Book now', capacity_sold: sold };
}
