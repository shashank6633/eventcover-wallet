import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { soldPaxForEvents, deriveBookingState } from '@/lib/booking-state';

export const runtime = 'nodejs';
// Keep dynamic since query params drive the filter set, but rely on the
// Cache-Control header below for short-lived CDN reuse.
export const dynamic = 'force-dynamic';

/**
 * GET /api/events/public-list
 *
 * PUBLIC, no auth. Powers the customer-facing /events listing page and the
 * "Upcoming Events" preview on the landing page.
 *
 * Query params:
 *   - from   (YYYY-MM-DD)  Lower bound on event_date. Defaults to today.
 *   - to     (YYYY-MM-DD)  Upper bound on event_date. Optional.
 *   - genre  (string)      Exact match on events.genre.
 *   - q      (string)      Case-insensitive LIKE match against name + one_line_summary.
 *   - limit  (number)      Max rows. Default 24, hard cap 100.
 *
 * Returns a *whitelisted* subset of fields — no pricing, no zones, no
 * internal notes. The shape mirrors what /events and / actually need to
 * render cards.
 *
 * Cache: public, max-age=300 (5 min). Safe because we only emit live +
 * public events and the listing isn't personalized.
 */
interface PublicEventListItem {
  id: string;
  slug: string | null;
  name: string;
  eventDate: string;
  startTime: string | null;
  genre: string | null;
  cardImage: string | null;
  oneLineSummary: string | null;
  venueId: string | null;
  venueName: string | null;
  tags: string[];
  // ─── Public-site card metadata (akan-events-app contract) ──────────────
  // Mirrors the detail route's projection so the landing-page grid can
  // render fully-styled cards without a per-event round-trip.
  categorySlot: 'day' | 'night' | null;
  categoryLabel: string | null;
  tagline: string | null;
  hue: string;
  featured: boolean;
  note: string | null;
  // Derived availability — the customer app's card CTA reads these directly
  // rather than re-deriving from status/date/capacity on its side, so both
  // surfaces always agree on whether an event is bookable.
  bookingOpen: boolean;
  bookingStatusLabel: string;
  isRecurring: boolean;
}

type Row = {
  id: string;
  slug: string | null;
  name: string;
  event_date: string;
  start_time: string | null;
  genre: string | null;
  card_image: string | null;
  image_data: string | null;
  one_line_summary: string | null;
  venue_id: string | null;
  venue_name: string | null;
  tags: string | null;
  category_slot: string | null;
  category_label: string | null;
  tagline: string | null;
  hue: string | null;
  featured: number | null;
  note: string | null;
  status: string;
  capacity: number | null;
  is_recurring: number | null;
};

function isYmd(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((t) => String(t)) : [];
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const fromParam = (url.searchParams.get('from') || '').trim();
  const toParam = (url.searchParams.get('to') || '').trim();
  const genreParam = (url.searchParams.get('genre') || '').trim();
  const qParam = (url.searchParams.get('q') || '').trim();
  const limitParam = Number(url.searchParams.get('limit') || '24');

  const from = fromParam && isYmd(fromParam) ? fromParam : todayYmd();
  const to = toParam && isYmd(toParam) ? toParam : null;
  // Clamp limit to [1, 100]. NaN → default 24.
  const limit = Math.max(1, Math.min(100, Number.isFinite(limitParam) ? Math.floor(limitParam) : 24));

  const where: string[] = [
    "e.status = 'live'",
    'e.is_public = 1',
    'e.event_date >= ?',
  ];
  const params: unknown[] = [from];

  if (to) {
    where.push('e.event_date <= ?');
    params.push(to);
  }
  if (genreParam) {
    where.push('e.genre = ?');
    params.push(genreParam);
  }
  if (qParam) {
    where.push('(LOWER(e.name) LIKE ? OR LOWER(IFNULL(e.one_line_summary, \'\')) LIKE ?)');
    const needle = `%${qParam.toLowerCase()}%`;
    params.push(needle, needle);
  }

  const db = getDb();
  const sql = `
    SELECT
      e.id, e.slug, e.name, e.event_date, e.start_time, e.genre,
      e.card_image, e.image_data, e.one_line_summary, e.venue_id, e.tags,
      e.category_slot, e.category_label, e.tagline, e.hue, e.featured, e.note,
      e.status, e.capacity, e.is_recurring,
      v.name AS venue_name
    FROM events e
    LEFT JOIN venues v ON v.id = e.venue_id
    WHERE ${where.join(' AND ')}
    ORDER BY e.featured DESC, e.event_date ASC, e.start_time ASC, e.created_at ASC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params, limit) as Row[];

  // Booked-pax counts for the whole page in ONE grouped query. Doing this
  // per row would be an N+1 against reservations — at limit=100 that's 100
  // extra queries per page render.
  const soldByEvent = soldPaxForEvents(rows.map((r) => r.id));

  const events: PublicEventListItem[] = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    eventDate: r.event_date,
    startTime: r.start_time,
    genre: r.genre,
    // Card image preference: dedicated 2:3 card_image → fall back to hero image_data.
    cardImage: r.card_image || r.image_data || null,
    oneLineSummary: r.one_line_summary,
    venueId: r.venue_id,
    venueName: r.venue_name,
    tags: parseTags(r.tags),
    // Defaults match the detail route so both endpoints agree on how a
    // legacy (pre-migration) event renders on the customer site.
    categorySlot: r.category_slot === 'day' || r.category_slot === 'night' ? r.category_slot : null,
    categoryLabel: r.category_label || null,
    tagline: r.tagline || null,
    hue: r.hue || 'sunny',
    featured: !!r.featured,
    note: r.note || null,
    // Shared derivation with the detail route (src/lib/booking-state.ts) so
    // a card and its detail page never disagree about availability.
    ...(() => {
      const s = deriveBookingState(r, soldByEvent.get(r.id) ?? 0);
      return { bookingOpen: s.booking_open, bookingStatusLabel: s.booking_status_label };
    })(),
    isRecurring: !!r.is_recurring,
  }));

  const res = NextResponse.json({ ok: true, events, total: events.length });
  // 5 minute cache. Stale-while-revalidate keeps the page snappy if the
  // CDN re-fetches in the background.
  res.headers.set('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=60');
  return res;
}
