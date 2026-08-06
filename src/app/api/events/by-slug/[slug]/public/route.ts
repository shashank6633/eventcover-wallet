import { type NextRequest, NextResponse } from 'next/server';
import { getDb, getConfig } from '@/lib/db';
import { deriveBookingState, soldPaxForEvent } from '@/lib/booking-state';
import type { EventRow } from '@/lib/events';
import type { TableVisibility } from '@/lib/pricing';
import { getEffectivePixelId } from '@/lib/meta-pixel';
import { listPublicMedia } from '@/lib/event-media';
import { listSlotsWithCapacity } from '@/lib/event-slots';
import { parseRsvpFields } from '@/lib/rsvp-fields';
import { listPublicZones } from '@/lib/seating-layout';
import { getPhasePricesForBooking } from '@/lib/ticket-phases';

function clampPercent(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(100, v);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type PaymentMode = 'none' | 'deposit' | 'full_cover';

/**
 * EventRow with the new payment columns the other agent is adding to the
 * `events` table. We don't depend on the canonical type yet because the
 * schema migration ships independently.
 */
type EventRowWithPayment = EventRow & {
  payment_mode?: PaymentMode | null;
  deposit_amount?: number | null;
};

/**
 * Compute the INR rupee amount to preview on the public landing page.
 *
 *   - 'none'       → null (no payment)
 *   - 'deposit'    → flat deposit amount
 *   - 'full_cover' → per-person entry fee (default pax = 1)
 *
 * IMPORTANT: This is a *display hint* only. The /api/payments/order
 * endpoint re-computes the real charge server-side using the saved pax on
 * the reservation, so what the customer actually pays may differ.
 */
function computePaymentAmount(row: EventRowWithPayment): number | null {
  const mode = (row.payment_mode || 'none') as PaymentMode;
  if (mode === 'none') return null;
  if (mode === 'deposit') return Number(row.deposit_amount || 0);
  if (mode === 'full_cover') return Number(row.entry_fee_per_person || 0) * 1;
  return null;
}

// ─── akan-events-app contract helpers ──────────────────────────────────────
// The customer-facing app (separate Next.js repo, proxies to this dashboard)
// reads venue / lineup / table types off this one payload. Everything below
// exists so a legacy row — NULL columns, empty JSON, hand-edited data —
// serializes to a sensible default instead of forcing that app to null-guard
// every field.

/** Whitelisted venue projection. `notes` is host-internal and stays server-side. */
interface PublicVenue {
  id: string;
  name: string;
  city: string;
  address: string | null;
  google_maps_url: string | null;
}

/**
 * Whitelisted artist projection. The profile numbers are omitted when 0
 * because 0 means "the host never filled this in" — the customer app renders
 * "4 members · 2 vocalists · 90 min set" only from the keys that are present.
 */
interface PublicArtist {
  id: string;
  name: string;
  about: string | null;
  social_url: string | null;
  image_data: string | null;
  vocalists?: number;
  members?: number;
  set_minutes?: number;
}

/** Raw artist columns we read. Selected explicitly so created_by / created_at never leak. */
type ArtistProfileRow = {
  id: string;
  name: string;
  about: string | null;
  social_url: string | null;
  image_data: string | null;
  vocalists: number | null;
  members: number | null;
  set_minutes: number | null;
};

/**
 * Whitelisted table-type projection. max_per_booking / inventory / time_slots
 * are host-side inventory controls — they never go out on a public payload.
 */
interface PublicTableType {
  id: string;
  name: string;
  capacity: number;
  entry_fee: number;
  info: string | null;
  visibility: TableVisibility;
  external_link: string | null;
  contact_cta_enabled: boolean;
}

const VALID_VISIBILITY = new Set<string>(['none', 'hidden', 'fast_filling', 'sold_out']);

/**
 * Upper bound on how many artists we'll resolve for one event. Guards the
 * IN() clause against SQLite's bound-parameter limit if a hand-edited
 * artist_ids blob ever carries a pathological number of ids — a 500 here
 * would take the whole landing page down.
 */
const MAX_ARTISTS = 50;

/** Parse a JSON string column into a string[]. Legacy NULL/garbage → []. */
function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    // Re-widen to unknown[] — Array.isArray() narrows unknown to any[], and
    // an implicit any would let a non-string element through the filter.
    return (parsed as unknown[]).filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
  } catch {
    return [];
  }
}

/**
 * Parse events.table_types for the public payload.
 *
 * src/lib/events.ts has a parseTableTypes() but it isn't exported and it
 * hydrates the host-only inventory fields we must not ship — so we parse
 * defensively here rather than widen that module's surface for one consumer.
 *
 * Table types marked 'hidden' are dropped entirely: that flag is the host's
 * explicit "customers must not see this" switch, and filtering it client-side
 * would still leave the name + price sitting in the network response.
 */
function parsePublicTableTypes(json: string | null): PublicTableType[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: PublicTableType[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const t = entry as Record<string, unknown>;
    if (typeof t.name !== 'string' || !t.name) continue;

    // Concealment must fail CLOSED. An absent visibility means "no badge,
    // show it" — that's the legitimate default. But a value that is present
    // and unrecognised (hand-edited data, or a future enum member like
    // 'invite_only' reaching a route that predates it) is ambiguous, and
    // guessing "visible" would leak a table the host may have meant to hide.
    // Drop the row instead.
    let visibility: TableVisibility;
    if (t.visibility == null) {
      visibility = 'none';
    } else if (typeof t.visibility === 'string' && VALID_VISIBILITY.has(t.visibility)) {
      visibility = t.visibility as TableVisibility;
    } else {
      continue;
    }
    if (visibility === 'hidden') continue;

    out.push({
      // Never mint an id here — the events lib does that on write. A
      // per-request id would break the client's selection state and the
      // phase-price lookup that keys on table_types[i].id; an empty string
      // flags "not addressable" until the host re-saves the event.
      id: typeof t.id === 'string' ? t.id : '',
      name: t.name,
      // Floor the capacity: it feeds ticket_options, which becomes the
      // customer's party-size picker. A hand-edited 2.5 would otherwise
      // render a "2.5 guests" option.
      capacity: Math.max(0, Math.floor(Number(t.capacity) || 0)),
      entry_fee: Number(t.entry_fee) || 0,
      info: typeof t.info === 'string' ? t.info : null,
      visibility,
      external_link: typeof t.external_link === 'string' ? t.external_link : null,
      contact_cta_enabled: !!t.contact_cta_enabled,
    });
  }
  return out;
}

/**
 * Resolve events.artist_ids into ordered artist rows.
 *
 * artist_ids is the host's curated running order, so we re-sort the SQL
 * result back into that order — an IN() clause returns rows in whatever
 * order SQLite likes, which would silently scramble the lineup. Ids that no
 * longer resolve (artist deleted after the event was built) are skipped.
 *
 * Deliberately NOT filtered on artists.active: the host attached these
 * artists to this event, and retiring someone from the roster later
 * shouldn't erase them from a past/announced lineup.
 */
function loadEventArtists(artistIdsJson: string | null): ArtistProfileRow[] {
  const ids = [...new Set(parseStringArray(artistIdsJson))].slice(0, MAX_ARTISTS);
  if (ids.length === 0) return [];

  const db = getDb();
  // One batched query — never N per-artist reads. artists.id is the PK, so
  // this is an index lookup per id.
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, name, about, social_url, image_data, vocalists, members, set_minutes
    FROM artists
    WHERE id IN (${placeholders})
  `).all(...ids) as ArtistProfileRow[];

  const byId = new Map(rows.map((a) => [a.id, a]));
  return ids
    .map((id) => byId.get(id))
    .filter((a): a is ArtistProfileRow => !!a);
}

/** Project an artist row, omitting the profile numbers the host left at 0. */
function projectArtist(a: ArtistProfileRow): PublicArtist {
  const out: PublicArtist = {
    id: a.id,
    name: a.name,
    about: a.about ?? null,
    social_url: a.social_url ?? null,
    image_data: a.image_data ?? null,
  };
  const vocalists = Number(a.vocalists) || 0;
  const members = Number(a.members) || 0;
  const setMinutes = Number(a.set_minutes) || 0;
  if (vocalists > 0) out.vocalists = vocalists;
  if (members > 0) out.members = members;
  if (setMinutes > 0) out.set_minutes = setMinutes;
  return out;
}

/**
 * GET /api/events/by-slug/[slug]/public
 *
 * PUBLIC, no auth. Powers the customer-facing /e/<slug> landing page.
 *
 * Carefully whitelists which event fields go out — internal pricing
 * (base_entry_fee, cover_rates), notes, and audit fields are NEVER
 * exposed here. The browser-side Pixel snippet needs `pixelId`, so we
 * compute the effective Pixel ID (event override → global) and return it.
 *
 * Also returns `venuePhone` (HOST_PHONE config) so the landing page can
 * render tel: + WhatsApp CTAs.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const cleaned = (slug || '').trim().toLowerCase();
  if (!cleaned) {
    return NextResponse.json({ ok: false, message: 'slug required' }, { status: 400 });
  }

  const db = getDb();
  const row = db.prepare('SELECT * FROM events WHERE slug = ? LIMIT 1').get(cleaned) as EventRowWithPayment | undefined;
  if (!row) {
    return NextResponse.json({ ok: false, message: 'event not found' }, { status: 404 });
  }
  // Draft events shouldn't be discoverable via the public URL — only live
  // (and arguably closed, for post-event pages). Hosts can preview drafts
  // from the admin UI which uses /api/events/[id] (authenticated).
  if (row.status === 'draft') {
    return NextResponse.json({ ok: false, message: 'event not found' }, { status: 404 });
  }
  if (!row.is_public) {
    return NextResponse.json({ ok: false, message: 'event not found' }, { status: 404 });
  }

  const pixelId = getEffectivePixelId(row.meta_pixel_id);
  const venuePhone = getConfig('HOST_PHONE', '');

  const paymentMode: PaymentMode = (row.payment_mode || 'none') as PaymentMode;
  const paymentAmount = computePaymentAmount(row);

  // Phase 2: gallery carousel below the hero. Empty array when the host
  // hasn't uploaded any extra media — the public page renders nothing in
  // that case. We deliberately use the public projection so created_by /
  // created_at never leave the server.
  const media = listPublicMedia(row.id);

  // ─── Phase 3: access_mode + slots ─────────────────────────────────────
  // accessMode tells the public page whether to gate render (invite_link)
  // or enforce phone-list on submit. invite_secret is NEVER returned —
  // the gate is enforced server-side on POST.
  //
  // slots[] is the active schedule slots projection. Empty when the event
  // uses single-slot mode (events.event_date + events.start_time). When
  // non-empty, the form renders a slot picker.
  const accessMode: 'public' | 'invite_link' | 'phone_list' =
    row.access_mode === 'invite_link' || row.access_mode === 'phone_list'
      ? row.access_mode
      : 'public';

  const slots = listSlotsWithCapacity(row.id, { activeOnly: true }).map((s) => ({
    id: s.id,
    slot_date: s.slot_date,
    start_time: s.start_time,
    end_time: s.end_time,
    label: s.label,
    max_capacity: s.max_capacity,
    remaining_capacity: s.remaining_capacity,
  }));

  // ─── Phase 4: RSVP custom fields ──────────────────────────────────────
  // Field DEFINITIONS only — never any answers from other guests. Safe to
  // ship in the public projection. Legacy events with no rsvp_fields_json
  // come through as [] via parseRsvpFields()'s defensive parsing.
  const rsvpFields = parseRsvpFields(
    (row as { rsvp_fields_json?: string | null }).rsvp_fields_json ?? null,
  );

  // ─── Seating layout ───────────────────────────────────────────────────
  // Only embed the SVG when the feature is enabled — keeps the wire size
  // small for events that don't use it. Zone capacity is exposed as
  // sold_count + capacity so the public renderer can show "X available";
  // we deliberately leak this number for UX (matches Growezzy behavior).
  const seatingEnabled = !!(row as { seating_layout_enabled?: number }).seating_layout_enabled;
  const seatingLayoutSvg = seatingEnabled
    ? (row as { seating_layout_svg?: string | null }).seating_layout_svg ?? null
    : null;
  const zones = seatingEnabled ? listPublicZones(row.id) : [];

  // ─── Per-event Settings — fee payer + GST flags ──────────────────────────
  // The booking form uses these to render the right line items on the
  // customer-facing summary ("Gateway fee +₹X" / "GST +₹Y"). We DON'T leak
  // the percentages here — the customer sees absolute INR amounts only,
  // computed server-side via /api/payments/order. This matches the rest of
  // the public payload's policy of hiding raw pricing config.
  const settingsRow = row as EventRowWithPayment & {
    payment_gateway_fee_payer?: string | null;
    platform_fee_payer?: string | null;
    gst_enabled?: number | null;
  };
  const gatewayFeePayer: 'customer' | 'host' =
    settingsRow.payment_gateway_fee_payer === 'customer' ? 'customer' : 'host';
  const platformFeePayer: 'customer' | 'host' =
    settingsRow.platform_fee_payer === 'customer' ? 'customer' : 'host';
  const gstEnabled = !!settingsRow.gst_enabled;
  // Percentages — leaked deliberately so the public booking form can render
  // the line-item breakdown ("Gateway fee +₹X") without an extra round-trip.
  // The Razorpay order is still computed server-side, so a tampered client
  // can't undercharge: /api/payments/order recomputes via computeBilling().
  const gatewayFeePct = clampPercent(Number(getConfig('PAYMENT_GATEWAY_FEE_PCT', '2')) || 0);
  const platformFeePct = clampPercent(Number(getConfig('PLATFORM_FEE_PCT', '0')) || 0);
  const gstPercent = clampPercent(Number(row.gst_percent) || 0);
  const discountPercent = clampPercent(Number(row.discount_percent) || 0);

  // ─── Phased Ticket Releases ──────────────────────────────────────────────
  // Public projection so the booking page can render the active phase
  // banner ("Early Bird · ends DATE · or when sold out") + per-scope
  // pricing overlay + a "Next: <Name> from ₹X" preview. We deliberately
  // leak the `sold` counter — same UX policy as zones — so customers see
  // urgency ("only 5 left"). Internal-only audit columns (started_at /
  // ended_at) are reshaped into the trimmed `activePhase` projection below.
  // Parsed here (rather than nearer its use below) because the phase-price
  // filter immediately after needs the set of visible table-type ids.
  const tableTypes = parsePublicTableTypes(row.table_types);

  const phaseBooking = getPhasePricesForBooking(row.id);
  const activePhase = phaseBooking.phase
    ? {
        id: phaseBooking.phase.id,
        name: phaseBooking.phase.name,
        ends_at: phaseBooking.phase.ends_at,
        ends_on_sellout: phaseBooking.phase.ends_on_sellout,
      }
    : null;
  // Hidden table types must not leak their price here. parsePublicTableTypes
  // drops them from table_types[], but a phase price rows keyed on
  // scope='table_type' + scope_id = that table's id would still ship the
  // amount, inventory and sold count — defeating the whole point of hiding
  // it server-side. Filter phase prices down to the table types that
  // actually survived the visibility pass. Non-table scopes (zone,
  // flat_entry) are unaffected.
  const visibleTableTypeIds = new Set(tableTypes.map((t) => t.id).filter(Boolean));
  const phasePrices = phaseBooking.prices
    .filter((p) => p.scope !== 'table_type' || visibleTableTypeIds.has(p.scope_id ?? ''))
    .map((p) => ({
      id: p.id,
      scope: p.scope,
      scope_id: p.scope_id,
      price: p.price,
      inventory: p.inventory,
      sold: p.sold,
      // PublicBookingForm's PhasePrice type reads `remaining`, not the raw
      // inventory/sold pair — without it every `typeof remaining === 'number'`
      // guard fell through, so a sold-out phase still rendered as bookable and
      // the "only N left" urgency line never appeared. null = unlimited,
      // matching the column semantics; floored at 0 so an oversold row (sold >
      // inventory, possible via a race at capture) reads as 0 rather than
      // negative.
      remaining: p.inventory == null ? null : Math.max(0, p.inventory - p.sold),
    }));
  const nextPhasePreview = phaseBooking.nextPhasePreview
    ? {
        name: phaseBooking.nextPhasePreview.phase.name,
        minPrice: phaseBooking.nextPhasePreview.minPrice,
        starts_after: phaseBooking.nextPhasePreview.phase.ends_at,
      }
    : null;

  // ─── akan-events-app contract — venue / lineup / table types ─────────────
  // Three cheap reads: the venue by PK, one batched artist query, and a
  // JSON column parse. All three default to null / [] on legacy rows.
  const venue = row.venue_id
    ? (db.prepare(`
        SELECT id, name, city, address, google_maps_url
        FROM venues WHERE id = ? LIMIT 1
      `).get(row.venue_id) as PublicVenue | undefined) ?? null
    : null;

  const artistRows = loadEventArtists(row.artist_ids);
  const artists = artistRows.map(projectArtist);
  // Hero artist block. Unlike artists[] this keeps the zeroes — the customer
  // app destructures a fixed shape here, and 0 already reads as "not
  // specified" on their side. `description` is our `about` column renamed to
  // match their Event type.
  const artistProfile = artistRows.length > 0
    ? {
        name: artistRows[0].name,
        description: artistRows[0].about ?? null,
        vocalists: Number(artistRows[0].vocalists) || 0,
        members: Number(artistRows[0].members) || 0,
        set_minutes: Number(artistRows[0].set_minutes) || 0,
        image: artistRows[0].image_data ?? null,
        social_url: artistRows[0].social_url ?? null,
      }
    : null;

  // Pax choices the customer picker offers, derived from the visible table
  // types (parsed above). Capacity 0 means the host never set one, so it
  // isn't a bookable option — dropping it keeps a stray "0 guests" out of
  // their dropdown. Capacities are floored at parse time, so every value
  // here is already a whole number of seats.
  const ticketOptions = [...new Set(
    tableTypes.map((t) => t.capacity).filter((c) => c > 0),
  )].sort((a, b) => a - b);

  // Derived booking state — the SAME rule the card grid uses
  // (src/lib/booking-state.ts), so a listing card and its detail page can
  // never disagree about whether an event is bookable. Hoisted out of the
  // response spread because the status mapping below reuses its pax count
  // instead of re-querying reservations.
  const capacity = Number(row.capacity) || 0;
  const bookingState = deriveBookingState(row, soldPaxForEvent(row.id));

  // ─── Status mapping ──────────────────────────────────────────────────────
  // Their contract is 'active' | 'archived' | 'sold-out'; ours internally is
  // 'draft' | 'live' | 'closed' (draft already 404'd above).
  //
  // event.status carries the CONTRACT value, because the customer app reads
  // it directly (their mapper: `event.status || 'active'`) and would choke on
  // a raw 'live'. Our own consumer — src/app/event/[slug]/page.tsx — reads
  // event.internal_status instead, so both get an unambiguous field rather
  // than sharing one key with two meanings.
  // Sold-out reuses bookingState.capacity_sold, so no second COUNT.
  // Derived FROM bookingState, not in parallel with it — otherwise the two
  // disagree. A live event dated yesterday has booking_open=false ("Event
  // has ended") but would still map to 'active' if we only tested
  // row.status, so a consumer keying off status would render an ended event
  // as bookable. Any not-open event is 'archived' unless it is specifically
  // sold out.
  const soldOut = capacity > 0 && bookingState.capacity_sold >= capacity;
  const publicStatus: 'active' | 'archived' | 'sold-out' =
    soldOut
      ? 'sold-out'
      : bookingState.booking_open
        ? 'active'
        : 'archived';

  // Strictly whitelisted projection. No prices, no internal notes, no
  // booking_types pricing leak — those go through a separate booking
  // endpoint when the customer commits.
  //
  // Seating Layout — fields are SHIPPED AT THE TOP LEVEL of the response
  // (sibling to event/media/slots) so the public page can pass them
  // directly to <PublicBookingForm/> without nesting under event. Keeping
  // the contract flat matches the rest of the public payload shape (zones,
  // rsvpFields, etc.) and avoids drift between client + server typings.
  return NextResponse.json({
    ok: true,
    event: {
      id: row.id,
      slug: row.slug,
      name: row.name,
      event_date: row.event_date,
      start_time: row.start_time,
      description: row.description,
      image_data: row.image_data,
      genre: row.genre,
      // Null the id when the venue no longer resolves (deleted row), so a
      // consumer that lazily fetches by venue_id doesn't chase a 404.
      venue_id: venue ? row.venue_id : null,
      // CONTRACT value ('active' | 'archived' | 'sold-out'). The customer
      // app reads event.status directly. Our own landing page reads
      // internal_status below instead.
      status: publicStatus,
      // Raw internal lifecycle ('live' | 'closed'; 'draft' already 404'd).
      // src/app/event/[slug]/page.tsx 404s on 'closed'.
      internal_status: row.status,
      // Phase 3 — never include invite_secret here.
      access_mode: accessMode,
      invite_message: row.invite_message ?? null,
      // ─── akan-events-app contract ──────────────────────────────────────
      // Nested here (rather than top level) because the customer app reads
      // the whole event object as one unit. Defaults are deliberate: a
      // legacy row with NULL columns serializes as null / [] / false, never
      // undefined, so that app never has to null-guard a field.
      card_image: row.card_image ?? null,
      one_line_summary: row.one_line_summary ?? null,
      tags: parseStringArray(row.tags),
      category_slot: row.category_slot === 'day' || row.category_slot === 'night'
        ? row.category_slot
        : null,
      category_label: row.category_label ?? null,
      venue,
      artists,
      terms: row.terms ?? null,
      faqs: row.faqs ?? null,
      refund_policy: row.refund_policy ?? null,
      entry_enabled: !!row.entry_enabled,
      cover_enabled: !!row.cover_enabled,
      table_types: tableTypes,
      occupancy_rule: row.occupancy_rule === 'min' ? 'min' : 'exact',
      is_recurring: !!row.is_recurring,
      // Booking availability is ALSO mirrored inside `event` because the
      // customer app reads event.booking_open / event.booking_status_label
      // (not the top-level copies). Without this, their card falls back to
      // a generic "Bookings open" label and never shows our "Selling fast"
      // or "Sold out". The top-level copies stay for our own consumers.
      booking_open: bookingState.booking_open,
      booking_status_label: bookingState.booking_status_label,
      // Retained alias for the mapped status so any consumer already
      // reading public_status keeps working after status was switched to
      // the contract value above.
      public_status: publicStatus,
    },
    media,
    slots,
    rsvpFields,
    zones,
    seatingLayoutEnabled: seatingEnabled,
    sanitizedSvg: seatingLayoutSvg,
    pixelId: pixelId || null,
    venuePhone,
    // Brand header on the public landing page reads this; it renders blank
    // when the event has no venue attached.
    venueName: venue?.name ?? '',
    paymentMode,
    paymentAmount,
    // Per-event Settings — surfaces the payer config + the percentages the
    // booking form needs to render the line-item breakdown. The Razorpay
    // order is still computed server-side via computeBilling() in
    // /api/payments/order so a tampered client can't lower the charge —
    // the percentages are non-secret platform constants, NOT trust-anchors.
    paymentGatewayFeePayer: gatewayFeePayer,
    platformFeePayer,
    gstEnabled,
    paymentGatewayFeePct: gatewayFeePct,
    platformFeePct,
    gstPercent,
    discountPercent,
    // M/F/C per-category cover rates — exposed so the booking form can render
    // the three-stepper UI with live per-category subtotals. These are
    // intentionally non-secret (every patron sees them at the door anyway)
    // and the Razorpay total is still recomputed server-side from these
    // values in /api/payments/order — a tampered client cannot lower the
    // charge by sending a different mix.
    coverRates: {
      male_stag: Number(row.cover_male_stag) || 0,
      female_stag: Number(row.cover_female_stag) || 0,
      couple: Number(row.cover_couple) || 0,
    },
    entryFeePerPerson: Number(row.entry_fee_per_person) || 0,
    // ─── Public-site card metadata (akan-events-app contract) ─────────────
    // Shipped at the TOP LEVEL rather than nested under `event` so the
    // customer app can destructure without walking the tree — matches the
    // existing flat shape of zones / rsvpFields / coverRates above.
    //
    // Defaults are deliberate: legacy events (created before these columns
    // existed) serialize as hue='sunny', featured=false, capacity=0
    // (unlimited), tagline/note=null. The customer app renders those
    // correctly without null-guarding every field. `|| ` rather than `??`
    // on hue because a hand-edited empty string must fall back too.
    // Derived booking state — computed server-side so every consumer
    // (customer app, admin preview, future native app) agrees on whether
    // this event is bookable rather than each re-deriving the rule.
    // Spread FIRST so the explicit keys below always win: if BookingState
    // ever gains a `status` or `capacity` member it would otherwise
    // silently clobber the derived values, with no type error to catch it.
    ...bookingState,
    tagline: row.tagline || null,
    hue: row.hue || 'sunny',
    featured: !!row.featured,
    note: row.note || null,
    capacity,
    // Mapped 'active' | 'archived' | 'sold-out' status, mirrored at the top
    // level so the customer app finds it whichever way it merges the two
    // levels of this payload. Nothing internal reads a top-level `status`.
    status: publicStatus,
    // Hero artist block + the pax choices derived from the visible table
    // types. Both flat for the same reason as the card metadata above.
    artist_profile: artistProfile,
    ticket_options: ticketOptions,
    // Phased Ticket Releases — see comment above.
    activePhase,
    phasePrices,
    nextPhasePreview,
  });
}
