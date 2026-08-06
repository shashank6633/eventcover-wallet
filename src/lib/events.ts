import { getDb } from './db';
import { nanoid } from 'nanoid';
import { logAudit } from './audit';
import { linkUnassignedReservationsToEvent } from './reservations';
import type { CoverRates, TableType, OccupancyRule } from './pricing';
import { parseTicketDesign, type TicketDesign } from './ticket-design';
import { parseRsvpFields, stringifyRsvpFields, type FieldDef } from './rsvp-fields';
export type { TableType, OccupancyRule, CoverRates } from './pricing';
export type { TicketDesign } from './ticket-design';
// Re-export so existing imports of FieldDef / RsvpFieldType from '@/lib/events'
// keep resolving. The canonical definition lives in './rsvp-fields' alongside
// the parse + validate helpers — keeping a single source of truth.
export type { FieldDef, RsvpFieldType, ValidationResult } from './rsvp-fields';

export type CoverPolicy = 'equal' | 'fixed' | 'percent';
export type EventStatus = 'draft' | 'live' | 'closed';

export interface PaxRule {
  label: string;
  min_pax: number;
  max_pax: number | null;
  fee_per_pax: number;
}

export interface TicketProduct {
  id: string;
  name: string;
  price: number;
  info: string | null;
}

export interface BookingType {
  id: string;
  name: string;
  tickets: TicketProduct[];
}

export interface MessagesConfig {
  wa_details_enabled?: boolean;
  event_location?: string;
  event_datetime?: string;
  poc_phone?: string;
  important_info?: string;
  wa_group_enabled?: boolean;
  wa_group_link?: string;
}

export interface EventRow {
  id: string;
  name: string;
  event_date: string;
  status: EventStatus;
  base_entry_fee: number;
  cover_policy: CoverPolicy;
  cover_value: number;
  pax_rules: string;
  cutoff_hour: number;
  notes: string | null;
  created_at: number;

  // Wizard fields
  description: string | null;
  image_data: string | null;     // 1:1 Cover Image (hero, 1080×1080)
  card_image: string | null;     // 2:3 Card Image (listing/social, 800×1200)
  start_time: string | null;
  is_public: number;
  venue_id: string | null;
  artist_ids: string;       // JSON
  genre: string | null;
  tags: string;             // JSON
  terms: string | null;
  faqs: string | null;
  refund_policy: string | null;
  one_line_summary: string | null;
  booking_types: string;    // JSON
  messages_config: string;  // JSON

  // Public-page slug + Meta Pixel override
  slug: string | null;
  meta_pixel_id: string | null;

  // Pricing engine columns
  entry_fee_per_person: number;
  cover_male_stag: number;
  cover_female_stag: number;
  cover_couple: number;
  entry_enabled: number;
  cover_enabled: number;
  table_types: string;      // JSON
  occupancy_rule: string;
  gst_percent: number;
  discount_percent: number;

  // ─── Per-event Settings — Inquiry phone + fee payer config ──────────────
  // inquiry_phone is NULL when the host hasn't set a per-event override;
  // notification callers fall back to HOST_PHONE config in that case.
  // gst_enabled is a 0/1 master toggle — gst_percent above is the rate
  // and is only applied when this flag is on.
  inquiry_phone: string | null;
  payment_gateway_fee_payer: 'customer' | 'host';
  platform_fee_payer: 'customer' | 'host';
  gst_enabled: number;

  // Online payment (Razorpay) — 'none' (default) skips checkout entirely;
  // 'deposit' takes a fixed deposit; 'full_cover' takes entry+cover and
  // auto-issues the wallet on capture.
  payment_mode: 'none' | 'deposit' | 'full_cover';
  deposit_amount: number | null;

  // ─── Phase 3: Invite Only ──────────────────────────────────────────────
  // access_mode controls the public booking gate:
  //   • 'public'       (default) — anyone with the link can book
  //   • 'invite_link'  — caller must supply ?invite=<secret> matching
  //                      events.invite_secret (constant-time compare)
  //   • 'phone_list'   — caller's phone must be in event_invitees
  // invite_secret is auto-minted on first switch to 'invite_link'.
  access_mode: 'public' | 'invite_link' | 'phone_list';
  invite_secret: string | null;
  invite_message: string | null;

  // ─── Phase 4: Ticket Design ──────────────────────────────────────────────
  // JSON blob holding the per-event wallet pass design overrides. Empty
  // string / NULL / '{}' all hydrate to DEFAULT_TICKET_DESIGN so the renderer
  // never has to special-case missing data.
  ticket_design_json: string | null;

  // ─── Phase 4: RSVP Form ──────────────────────────────────────────────────
  // JSON array of FieldDef. Column DEFAULT is '[]' so legacy events keep
  // working without a backfill — parseRsvpFields() handles every NULL /
  // empty-array / malformed JSON case by returning [].
  rsvp_fields_json: string;

  // ─── Seating Layout ──────────────────────────────────────────────────────
  // Opt-in feature: when enabled, the public booking flow renders the
  // sanitized SVG inline + each named zone becomes a bookable section.
  // The zone's price OVERRIDES entry_fee_per_person for the booking. Legacy
  // events read 0 here and keep the flat-pricing flow untouched.
  seating_layout_enabled: number;
  seating_layout_svg: string | null;
  seating_layout_phases_enabled: number;

  // ─── Event Category — Day / Night split + display label ─────────────────
  // category_slot powers the customer-facing site's "Day Events" vs
  // "Night Events" sections. category_label is the on-card chip ("Brunch",
  // "Live Band", etc.) — validated against a preset list in the wizard UI
  // but stored as free text so future additions don't need a schema change.
  // Both NULL on legacy rows; the wizard requires them before publish.
  category_slot: 'day' | 'night' | null;
  category_label: string | null;

  // ─── akan-events-app public-site metadata ──────────────────────────────
  // Consumed by the customer-facing Next.js app that proxies this dashboard.
  // All nullable/defaulted so legacy events keep serializing cleanly.
  tagline: string | null;
  hue: string | null;          // one of EVENT_HUES; free text for forward-compat
  featured: number;            // 0/1 — hydrated to boolean on Event
  note: string | null;         // badge text e.g. 'Headliner'
  capacity: number;            // 0 = unlimited
  is_recurring: number;        // 0/1 — hydrated to boolean on Event
}

/**
 * Card color themes the customer site supports. Validated on write; stored
 * as TEXT so a new palette entry only needs a code change here, not a
 * migration. Unknown values fall back to 'sunny' at the API projection.
 */
export const EVENT_HUES = [
  'sunny', 'tomato', 'crimson', 'ocean', 'mint', 'lavender', 'slate',
] as const;
export type EventHue = (typeof EVENT_HUES)[number];

export interface Event extends Omit<EventRow,
  'pax_rules' | 'artist_ids' | 'tags' | 'booking_types' | 'messages_config' | 'is_public'
  | 'entry_enabled' | 'cover_enabled' | 'table_types' | 'occupancy_rule'
  | 'ticket_design_json' | 'rsvp_fields_json'
  | 'seating_layout_enabled' | 'seating_layout_phases_enabled'
  | 'gst_enabled' | 'featured' | 'is_recurring'
> {
  pax_rules: PaxRule[];
  artist_ids: string[];
  tags: string[];
  booking_types: BookingType[];
  messages_config: MessagesConfig;
  is_public: boolean;
  /** Hydrated from the 0/1 column — pinned to the top of its Day/Night rail. */
  featured: boolean;
  /** Hydrated from the 0/1 column — drives the customer site's "Recurring" chip. */
  is_recurring: boolean;

  // Pricing engine (hydrated)
  entry_enabled: boolean;
  cover_enabled: boolean;
  table_types: TableType[];
  occupancy_rule: OccupancyRule;
  cover_rates: CoverRates;  // Convenience: built from cover_male_stag + cover_female_stag + cover_couple

  // Hydrated, always populated — defaults to DEFAULT_TICKET_DESIGN.
  ticket_design: TicketDesign;

  // Hydrated RSVP form field definitions. Always an array — empty when the
  // host hasn't configured any custom fields.
  rsvp_fields: FieldDef[];

  // Seating layout (hydrated booleans). seating_layout_svg stays a nullable
  // string — it's only used by the public route + admin wizard so callers
  // that don't need it can ignore it.
  seating_layout_enabled: boolean;
  seating_layout_phases_enabled: boolean;

  // ─── Per-event Settings — GST master toggle (boolean) ────────────────────
  // gst_percent above is the rate; this flag gates whether the calculator
  // actually applies it. inquiry_phone + payer enums stay the same shape as
  // in EventRow — already string / 'customer'|'host' so no hydration needed.
  gst_enabled: boolean;
}

export interface PriceResult {
  entryFee: number;
  coverIssued: number;
  ruleLabel: string | null;
  feePerPax: number;
  pax: number;
  paxNote: string;
}

// ─── Slug auto-generation ──────────────────────────────────────────────────
// Slugs power /e/<slug> public landing pages. Format: "<kebab-name>-<yyyy-mm-dd>".
// On collision (rare — would require two events with the same name AND date),
// we append "-2", "-3", etc. until we find a free slot.

function generateSlug(name: string, eventDate: string): string {
  const namePart = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  const base = namePart || 'event';
  return `${base}-${eventDate}`;
}

/**
 * Resolve a free slug by appending -2, -3, ... if the base collides.
 * `excludeId` lets updateEvent skip the row being updated (otherwise it
 * would always collide with itself).
 */
function resolveUniqueSlug(base: string, excludeId?: string): string {
  const db = getDb();
  const find = excludeId
    ? db.prepare('SELECT id FROM events WHERE slug = ? AND id != ? LIMIT 1')
    : db.prepare('SELECT id FROM events WHERE slug = ? LIMIT 1');
  let candidate = base;
  let n = 2;
  while (true) {
    const hit = excludeId ? find.get(candidate, excludeId) : find.get(candidate);
    if (!hit) return candidate;
    candidate = `${base}-${n++}`;
    if (n > 1000) {
      // Extremely defensive — if we somehow hit 1000 collisions, fall back
      // to a nanoid suffix to guarantee uniqueness.
      return `${base}-${nanoid(6)}`;
    }
  }
}

function safeJson<T>(json: string | null | undefined, fallback: T): T {
  try {
    const parsed = JSON.parse(json || '');
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function parseRules(json: string): PaxRule[] {
  const arr = safeJson<unknown>(json, []);
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (r): r is PaxRule =>
      !!r && typeof (r as PaxRule).label === 'string' &&
      Number.isFinite((r as PaxRule).min_pax) && Number.isFinite((r as PaxRule).fee_per_pax),
  );
}

function parseBookingTypes(json: string): BookingType[] {
  const arr = safeJson<unknown>(json, []);
  if (!Array.isArray(arr)) return [];
  return arr.filter((b): b is BookingType => !!b && typeof (b as BookingType).name === 'string')
    .map((b) => ({
      id: b.id || nanoid(),
      name: b.name,
      tickets: Array.isArray(b.tickets) ? b.tickets.map((t) => ({
        id: t.id || nanoid(),
        name: String(t.name || ''),
        price: Number(t.price) || 0,
        info: t.info ? String(t.info) : null,
      })) : [],
    }));
}

function parseTableTypes(json: string): TableType[] {
  const arr = safeJson<unknown>(json, []);
  if (!Array.isArray(arr)) return [];
  const VALID_VIS = new Set(['none', 'hidden', 'fast_filling', 'sold_out']);
  return arr
    .filter((t): t is TableType => !!t && typeof (t as TableType).name === 'string')
    .map((raw) => {
      const t = raw as TableType & Record<string, unknown>;
      const out: TableType = {
        id: t.id || nanoid(),
        name: String(t.name),
        capacity: Number(t.capacity) || 0,
        entry_fee: Number(t.entry_fee) || 0,
      };
      // Preserve all optional metadata so the customer-facing booking page can read it.
      if (typeof t.info === 'string') out.info = t.info;
      if (typeof t.visibility === 'string' && VALID_VIS.has(t.visibility)) {
        out.visibility = t.visibility as TableType['visibility'];
      }
      if ('external_link' in t) {
        out.external_link = typeof t.external_link === 'string' ? t.external_link : null;
      }
      if ('contact_cta_enabled' in t) out.contact_cta_enabled = !!t.contact_cta_enabled;
      if ('max_per_booking' in t) out.max_per_booking = Number(t.max_per_booking) || 0;
      if ('inventory' in t) out.inventory = Number(t.inventory) || 0;
      if (Array.isArray(t.time_slots)) {
        out.time_slots = (t.time_slots as unknown as Record<string, unknown>[]).map((s) => ({
          id: typeof s.id === 'string' && s.id ? s.id : nanoid(),
          start: String(s.start || ''),
          end: String(s.end || ''),
          quantity: Number(s.quantity) || 0,
        }));
      }
      return out;
    });
}

function hydrate(row: EventRow): Event {
  const occRule: OccupancyRule = row.occupancy_rule === 'min' ? 'min' : 'exact';
  // Strip raw JSON columns from the spread — we expose hydrated counterparts.
  // Also strip gst_enabled so we can re-emit it as boolean below.
  // `featured` and `is_recurring` are also stripped so we re-emit them as
  // booleans below (the columns are 0/1 INTEGERs; the customer app expects
  // real booleans).
  const {
    ticket_design_json: _tdj, rsvp_fields_json: _rfj, gst_enabled: _ge,
    featured: _feat, is_recurring: _rec, ...rest
  } = row;
  void _tdj;
  void _rfj;
  void _ge;
  void _feat;
  void _rec;
  // Defensive enum coercion — legacy rows may carry NULL when the migration
  // ran without the DEFAULT being applied retroactively (depends on SQLite
  // version). Fall back to 'host' so the calculator never sees an undefined
  // payer config.
  const gatewayPayer: 'customer' | 'host' =
    row.payment_gateway_fee_payer === 'customer' ? 'customer' : 'host';
  const platformPayer: 'customer' | 'host' =
    row.platform_fee_payer === 'customer' ? 'customer' : 'host';
  return {
    ...rest,
    payment_gateway_fee_payer: gatewayPayer,
    platform_fee_payer: platformPayer,
    pax_rules: parseRules(row.pax_rules),
    artist_ids: safeJson<string[]>(row.artist_ids, []),
    tags: safeJson<string[]>(row.tags, []),
    booking_types: parseBookingTypes(row.booking_types),
    messages_config: safeJson<MessagesConfig>(row.messages_config, {}),
    is_public: !!row.is_public,
    featured: !!row.featured,
    is_recurring: !!row.is_recurring,
    entry_enabled: !!row.entry_enabled,
    cover_enabled: !!row.cover_enabled,
    table_types: parseTableTypes(row.table_types),
    occupancy_rule: occRule,
    cover_rates: {
      male_stag: row.cover_male_stag ?? 2000,
      female_stag: row.cover_female_stag ?? 1000,
      couple: row.cover_couple ?? 3000,
    },
    ticket_design: parseTicketDesign(row.ticket_design_json),
    rsvp_fields: parseRsvpFields(row.rsvp_fields_json),
    seating_layout_enabled: !!row.seating_layout_enabled,
    seating_layout_phases_enabled: !!row.seating_layout_phases_enabled,
    gst_enabled: !!row.gst_enabled,
  };
}

export function listEvents(): Event[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM events ORDER BY event_date DESC, created_at DESC').all() as EventRow[];
  return rows.map(hydrate);
}

export function getEvent(id: string): Event | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
  return row ? hydrate(row) : null;
}

export function getEventForDate(dateISO: string): Event | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM events WHERE event_date = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1`,
  ).get(dateISO) as EventRow | undefined;
  return row ? hydrate(row) : null;
}

export interface CreateEventInput {
  name: string;
  event_date: string;
  base_entry_fee?: number;
  cover_policy?: CoverPolicy;
  cover_value?: number;
  pax_rules?: PaxRule[];
  cutoff_hour?: number;
  notes?: string | null;
  status?: EventStatus;

  description?: string | null;
  image_data?: string | null;
  card_image?: string | null;
  start_time?: string | null;
  is_public?: boolean;
  venue_id?: string | null;
  artist_ids?: string[];
  genre?: string | null;
  tags?: string[];
  terms?: string | null;
  faqs?: string | null;
  refund_policy?: string | null;
  one_line_summary?: string | null;
  booking_types?: BookingType[];
  messages_config?: MessagesConfig;

  // Pricing engine
  entry_fee_per_person?: number;
  cover_male_stag?: number;
  cover_female_stag?: number;
  cover_couple?: number;
  entry_enabled?: boolean;
  cover_enabled?: boolean;
  table_types?: TableType[];
  occupancy_rule?: OccupancyRule;
  gst_percent?: number;
  discount_percent?: number;

  // Optional explicit slug; if omitted, auto-generated from name + date.
  slug?: string | null;
  // Optional per-event override for Meta Pixel ID.
  meta_pixel_id?: string | null;

  // Online payment mode + (when 'deposit') the fixed deposit charged at checkout.
  payment_mode?: 'none' | 'deposit' | 'full_cover';
  deposit_amount?: number | null;

  // Invite-only gate. invite_secret is auto-minted on first switch to
  // 'invite_link' — callers don't supply it; updateEvent rotates only via
  // the explicit /api/events/[id]/invite-secret POST endpoint, or by
  // sending { rotate_invite_secret: true } alongside the patch (used by
  // the wizard's "Rotate link" button).
  access_mode?: 'public' | 'invite_link' | 'phone_list';
  invite_message?: string | null;
  rotate_invite_secret?: boolean;

  // ─── Phase 4: Ticket Design ──────────────────────────────────────────────
  // Per-event override of the wallet pass PNG layout. Pass a partial object
  // — updateEvent will run it through parseTicketDesign() so unknown fields
  // are dropped and invalid hex colors fall back to defaults. Passing null
  // resets to the column default '{}' (which hydrates to DEFAULT_TICKET_DESIGN).
  ticket_design?: Partial<TicketDesign> | null;

  // ─── Phase 4: RSVP Form ──────────────────────────────────────────────────
  // Array of FieldDef. Wizard sends the full array on every save (additive +
  // delete in one shot — much simpler than per-field PATCH). updateEvent
  // runs through parseRsvpFields() then stringifyRsvpFields() so unknown
  // types are silently dropped, choice-type fields without options are
  // rejected, and ids are minted for any new entries.
  rsvp_fields?: FieldDef[] | null;

  // ─── Seating layout toggles ──────────────────────────────────────────────
  // The actual SVG is written via the dedicated
  // /api/events/[id]/seating-layout endpoint (single sanitization choke
  // point) — these flags + a passthrough for `seating_layout_svg` are still
  // accepted so callers that already have a sanitized payload can persist
  // it. The general PATCH route forbids setting `seating_layout_svg`
  // directly to keep the sanitization surface narrow.
  seating_layout_enabled?: boolean;
  seating_layout_phases_enabled?: boolean;
  seating_layout_svg?: string | null;

  // ─── Per-event Settings — Inquiry phone + fee payer config ──────────────
  // All optional; updateEvent applies them as a flat passthrough. Enum
  // values outside 'customer' | 'host' fall back to 'host' (matches DB
  // DEFAULT). gst_enabled accepts boolean — coerced to 1/0 on write.
  inquiry_phone?: string | null;
  payment_gateway_fee_payer?: 'customer' | 'host';
  platform_fee_payer?: 'customer' | 'host';
  gst_enabled?: boolean;

  // ─── Event Category — Day / Night slot + display label ──────────────────
  // category_slot: 'day' | 'night' — drives the customer-site grouping.
  // category_label: preset chip text (e.g. 'Brunch', 'Live Band'). The wizard
  // validates against a preset list; storing as free text lets future presets
  // ship without a schema change. Pass null to clear (only valid on drafts).
  category_slot?: 'day' | 'night' | null;
  category_label?: string | null;

  // ─── akan-events-app public-site metadata ──────────────────────────────
  // tagline: short line under the title (max 120 chars, trimmed).
  // hue: validated against EVENT_HUES; anything else falls back to 'sunny'.
  // featured: coerced to 0/1.
  // note: badge text (max 40 chars, trimmed).
  // capacity: non-negative int; 0 = unlimited.
  // is_recurring: coerced to 0/1. Presentational only — flags a repeating
  //   event so the customer site can show a "Recurring" chip; it does NOT
  //   generate repeat instances.
  tagline?: string | null;
  hue?: string | null;
  featured?: boolean;
  note?: string | null;
  capacity?: number | null;
  is_recurring?: boolean;
}

export function createEvent(input: CreateEventInput): Event {
  const db = getDb();
  const id = nanoid();
  const now = Date.now();
  db.prepare(`
    INSERT INTO events (
      id, name, event_date, status, base_entry_fee, cover_policy, cover_value, pax_rules,
      cutoff_hour, notes, created_at,
      description, image_data, start_time, is_public, venue_id, artist_ids, genre, tags,
      terms, faqs, booking_types, messages_config
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.name.trim(), input.event_date,
    input.status || 'draft',
    input.base_entry_fee ?? 0,
    input.cover_policy || 'equal',
    input.cover_value == null ? 100 : input.cover_value,
    JSON.stringify(input.pax_rules || []),
    input.cutoff_hour || 2,
    input.notes || null,
    now,
    input.description || null,
    input.image_data || null,
    input.start_time || null,
    input.is_public === false ? 0 : 1,
    input.venue_id || null,
    JSON.stringify(input.artist_ids || []),
    input.genre || null,
    JSON.stringify(input.tags || []),
    input.terms || null,
    input.faqs || null,
    JSON.stringify(input.booking_types || []),
    JSON.stringify(input.messages_config || {}),
  );

  // Auto-generate a public-page slug. The DDL adds the `slug` column nullable
  // so we always insert NULL above, then patch it here in a second statement
  // — keeps the INSERT signature stable and lets us resolve collisions with
  // the row already in place. Caller can pre-supply input.slug to override
  // the auto-generated value; it's still sanitized + collision-checked.
  const explicit = input.slug?.trim() || '';
  const slugBase = explicit
    ? explicit.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || generateSlug(input.name, input.event_date)
    : generateSlug(input.name, input.event_date);
  const slug = resolveUniqueSlug(slugBase);
  // Also persist any per-event meta_pixel_id override + payment mode at create
  // time. payment_mode defaults to 'none' (matches the column DEFAULT) when
  // the caller doesn't supply one; deposit_amount only matters when mode is
  // 'deposit' but we still store whatever value was sent.
  const paymentMode: 'none' | 'deposit' | 'full_cover' =
    input.payment_mode === 'deposit' || input.payment_mode === 'full_cover'
      ? input.payment_mode
      : 'none';
  const depositAmount = input.deposit_amount != null ? Number(input.deposit_amount) : 0;

  // Invite-only — only mint the secret when the caller explicitly opts into
  // 'invite_link' at create time. 'public' (default) and 'phone_list' leave
  // invite_secret NULL until the host flips access_mode later.
  const accessMode: 'public' | 'invite_link' | 'phone_list' =
    input.access_mode === 'invite_link' || input.access_mode === 'phone_list'
      ? input.access_mode
      : 'public';
  const inviteSecret = accessMode === 'invite_link' ? nanoid(20) : null;
  const inviteMessage = input.invite_message?.trim() || null;

  // Phase 4 — ticket_design + rsvp_fields default to the column defaults
  // ('{}' and '[]'), so we only write when the caller passed something
  // meaningful. parseTicketDesign + parseRsvpFields are the same sanitizers
  // updateEvent uses, keeping create + patch behaviour identical.
  const ticketDesignJson =
    input.ticket_design == null
      ? '{}'
      : JSON.stringify(parseTicketDesign(input.ticket_design));
  const rsvpFieldsJson =
    input.rsvp_fields == null
      ? '[]'
      : stringifyRsvpFields(parseRsvpFields(JSON.stringify(input.rsvp_fields)));

  // Per-event Settings — fee payer + inquiry phone + GST master toggle.
  // All optional. Enum coerce to 'host' when missing/invalid; gst_enabled
  // defaults to 0 to match the column DEFAULT.
  const gatewayPayer: 'customer' | 'host' =
    input.payment_gateway_fee_payer === 'customer' ? 'customer' : 'host';
  const platformPayer: 'customer' | 'host' =
    input.platform_fee_payer === 'customer' ? 'customer' : 'host';
  const inquiryPhone =
    typeof input.inquiry_phone === 'string' && input.inquiry_phone.trim()
      ? input.inquiry_phone.trim()
      : null;
  const gstEnabledFlag = input.gst_enabled ? 1 : 0;

  db.prepare(`
    UPDATE events SET
      slug = ?, meta_pixel_id = ?, payment_mode = ?, deposit_amount = ?,
      refund_policy = ?, one_line_summary = ?,
      access_mode = ?, invite_secret = ?, invite_message = ?,
      ticket_design_json = ?, rsvp_fields_json = ?,
      card_image = ?,
      inquiry_phone = ?, payment_gateway_fee_payer = ?, platform_fee_payer = ?, gst_enabled = ?
    WHERE id = ?
  `).run(
    slug, input.meta_pixel_id?.trim() || null, paymentMode, depositAmount,
    input.refund_policy || null, input.one_line_summary || null,
    accessMode, inviteSecret, inviteMessage,
    ticketDesignJson, rsvpFieldsJson,
    input.card_image || null,
    inquiryPhone, gatewayPayer, platformPayer, gstEnabledFlag,
    id,
  );

  // Auto-link any unassigned Reservego reservations sitting around for this
  // date. If 4 reservations were waiting for a 2026-08-15 event, creating
  // the event now attaches all 4 in one shot — no manual click-through.
  const linked = linkUnassignedReservationsToEvent(id, input.event_date);

  logAudit({
    actor: 'admin',
    action: 'event_create',
    entityType: 'event',
    entityId: id,
    details: { name: input.name, date: input.event_date, reservations_linked: linked },
  });
  return getEvent(id)!;
}

export function updateEvent(id: string, patch: Partial<CreateEventInput>): Event | null {
  const db = getDb();
  const existing = getEvent(id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  const set = (col: string, val: string | number | null) => { fields.push(`${col} = ?`); values.push(val); };

  if (patch.name != null) set('name', String(patch.name).trim());
  if (patch.event_date != null) set('event_date', String(patch.event_date));
  if (patch.status != null) set('status', patch.status);
  if (patch.base_entry_fee != null) set('base_entry_fee', Number(patch.base_entry_fee));
  if (patch.cover_policy != null) set('cover_policy', patch.cover_policy);
  if (patch.cover_value != null) set('cover_value', Number(patch.cover_value));
  if (patch.pax_rules != null) set('pax_rules', JSON.stringify(patch.pax_rules));
  if (patch.cutoff_hour != null) set('cutoff_hour', Number(patch.cutoff_hour));
  if ('notes' in patch) set('notes', patch.notes ?? null);

  if ('description' in patch) set('description', patch.description ?? null);
  if ('image_data' in patch) set('image_data', patch.image_data ?? null);
  if ('card_image' in patch) set('card_image', patch.card_image ?? null);
  if ('start_time' in patch) set('start_time', patch.start_time ?? null);
  if (patch.is_public != null) set('is_public', patch.is_public ? 1 : 0);
  if ('venue_id' in patch) set('venue_id', patch.venue_id ?? null);
  if (patch.artist_ids != null) set('artist_ids', JSON.stringify(patch.artist_ids));
  if ('genre' in patch) set('genre', patch.genre ?? null);
  if (patch.tags != null) set('tags', JSON.stringify(patch.tags));
  if ('terms' in patch) set('terms', patch.terms ?? null);
  if ('faqs' in patch) set('faqs', patch.faqs ?? null);
  if ('refund_policy' in patch) set('refund_policy', patch.refund_policy ?? null);
  if ('one_line_summary' in patch) set('one_line_summary', patch.one_line_summary ?? null);
  if (patch.booking_types != null) set('booking_types', JSON.stringify(patch.booking_types));
  if (patch.messages_config != null) set('messages_config', JSON.stringify(patch.messages_config));

  // Pricing engine
  if (patch.entry_fee_per_person != null) set('entry_fee_per_person', Number(patch.entry_fee_per_person));
  if (patch.cover_male_stag != null) set('cover_male_stag', Number(patch.cover_male_stag));
  if (patch.cover_female_stag != null) set('cover_female_stag', Number(patch.cover_female_stag));
  if (patch.cover_couple != null) set('cover_couple', Number(patch.cover_couple));
  if (patch.entry_enabled != null) set('entry_enabled', patch.entry_enabled ? 1 : 0);
  if (patch.cover_enabled != null) set('cover_enabled', patch.cover_enabled ? 1 : 0);
  if (patch.table_types != null) set('table_types', JSON.stringify(patch.table_types));
  if (patch.occupancy_rule != null) set('occupancy_rule', patch.occupancy_rule);
  if (patch.gst_percent != null) set('gst_percent', Number(patch.gst_percent));
  if (patch.discount_percent != null) set('discount_percent', Number(patch.discount_percent));

  // ─── Per-event Settings — Inquiry phone + fee payer config ──────────────
  // inquiry_phone is nullable — empty string clears the per-event override.
  // payer enums fall back to 'host' when something invalid comes in (matches
  // the column DEFAULT). gst_enabled is the master toggle; gst_percent is
  // already handled above and stays the rate.
  if ('inquiry_phone' in patch) {
    const v = typeof patch.inquiry_phone === 'string' ? patch.inquiry_phone.trim() : '';
    set('inquiry_phone', v ? v : null);
  }
  if (patch.payment_gateway_fee_payer != null) {
    set(
      'payment_gateway_fee_payer',
      patch.payment_gateway_fee_payer === 'customer' ? 'customer' : 'host',
    );
  }
  if (patch.platform_fee_payer != null) {
    set(
      'platform_fee_payer',
      patch.platform_fee_payer === 'customer' ? 'customer' : 'host',
    );
  }
  if (patch.gst_enabled != null) set('gst_enabled', patch.gst_enabled ? 1 : 0);

  // Event category — validate enum on slot, free-text on label. Either may
  // be null (allowed on drafts; the wizard blocks publish unless both set).
  if ('category_slot' in patch) {
    const slot = patch.category_slot;
    set('category_slot', slot === 'day' || slot === 'night' ? slot : null);
  }
  if ('category_label' in patch) {
    const lbl = patch.category_label;
    set('category_label', typeof lbl === 'string' && lbl.trim() ? lbl.trim().slice(0, 60) : null);
  }

  // akan-events-app public-site metadata. Each field independently patchable
  // so the wizard can save partial state without clobbering the rest.
  if ('tagline' in patch) {
    const t = patch.tagline;
    set('tagline', typeof t === 'string' && t.trim() ? t.trim().slice(0, 120) : null);
  }
  if ('hue' in patch) {
    // Validate against the known palette; unknown values fall back to the
    // default rather than persisting garbage the customer app can't render.
    const h = typeof patch.hue === 'string' ? patch.hue.trim().toLowerCase() : '';
    set('hue', (EVENT_HUES as readonly string[]).includes(h) ? h : 'sunny');
  }
  if (patch.featured != null) set('featured', patch.featured ? 1 : 0);
  if (patch.is_recurring != null) set('is_recurring', patch.is_recurring ? 1 : 0);
  if ('note' in patch) {
    const n = patch.note;
    set('note', typeof n === 'string' && n.trim() ? n.trim().slice(0, 40) : null);
  }
  if ('capacity' in patch) {
    const c = Number(patch.capacity);
    set('capacity', Number.isFinite(c) && c > 0 ? Math.floor(c) : 0);
  }

  if (patch.payment_mode != null) {
    const m = patch.payment_mode === 'deposit' || patch.payment_mode === 'full_cover'
      ? patch.payment_mode
      : 'none';
    set('payment_mode', m);
  }
  if ('deposit_amount' in patch) {
    set('deposit_amount', patch.deposit_amount == null ? 0 : Number(patch.deposit_amount));
  }

  // Slug + Meta Pixel override. Slug behavior:
  //   • Explicit `patch.slug` (truthy) → sanitize + collision-resolve
  //   • Explicit `patch.slug === null` → leave existing slug alone (we never
  //     null out a published slug from an update — that would break links)
  //   • No patch.slug, but existing.slug is null → backfill from current
  //     (possibly updated) name + date
  if ('meta_pixel_id' in patch) set('meta_pixel_id', patch.meta_pixel_id ?? null);

  // ─── Phase 3: invite-only access mode + slot schedule ───────────────────
  //   • access_mode flipping to 'invite_link' for the first time auto-mints
  //     a nanoid(20) into invite_secret. Existing invite_secret stays put
  //     when flipping back-and-forth so shared links keep working.
  //   • rotate_invite_secret=true forces a fresh secret regardless of mode
  //     — used by the wizard "Rotate link" button. The dedicated
  //     /api/events/[id]/invite-secret POST is the canonical rotation
  //     path, but having this flag lets the UI batch a rotation alongside
  //     other edits in one save.
  //   • invite_message is freeform copy shown on the gate page.
  if ('invite_message' in patch) set('invite_message', patch.invite_message ?? null);
  let rotatedSecret = false;
  if (patch.rotate_invite_secret) {
    set('invite_secret', nanoid(20));
    rotatedSecret = true;
  }
  if (patch.access_mode != null) {
    const validModes = new Set(['public', 'invite_link', 'phone_list']);
    const newMode = validModes.has(patch.access_mode) ? patch.access_mode : 'public';
    set('access_mode', newMode);
    if (newMode === 'invite_link' && !existing.invite_secret && !rotatedSecret) {
      set('invite_secret', nanoid(20));
    }
  }

  let slugToWrite: string | null = null;
  if (patch.slug && patch.slug.trim()) {
    const cleaned = patch.slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    if (cleaned) slugToWrite = resolveUniqueSlug(cleaned, id);
  } else if (!existing.slug) {
    // Backfill — older rows from before the slug column existed land here.
    const newName = (patch.name ?? existing.name).trim();
    const newDate = patch.event_date ?? existing.event_date;
    slugToWrite = resolveUniqueSlug(generateSlug(newName, newDate), id);
  }
  if (slugToWrite) set('slug', slugToWrite);

  // ─── Phase 4: Ticket Design ─────────────────────────────────────────────
  // Run patch.ticket_design through parseTicketDesign() so we always store a
  // fully-validated object — defaults filled in for missing keys, junk hex
  // colors snapped back to brand defaults, layout enum constrained. Passing
  // null resets the column to '{}' so next hydrate falls back to DEFAULT.
  if ('ticket_design' in patch) {
    if (patch.ticket_design == null) {
      set('ticket_design_json', '{}');
    } else {
      const merged = { ...existing.ticket_design, ...patch.ticket_design };
      const normalized = parseTicketDesign(merged);
      set('ticket_design_json', JSON.stringify(normalized));
    }
  }

  // ─── Phase 4: RSVP Form ─────────────────────────────────────────────────
  // Always re-validate via stringifyRsvpFields(parseRsvpFields(stringify(input)))
  // so unknown/missing types are dropped and ids are minted for fresh
  // entries the wizard sent without one. Empty arrays + null both reset
  // to the column default '[]'.
  if ('rsvp_fields' in patch) {
    const arr = Array.isArray(patch.rsvp_fields) ? patch.rsvp_fields : [];
    // parseRsvpFields expects a string; stringify once so the sanitizer has
    // a unified entry point regardless of whether the caller already gave
    // us a clean array.
    const sanitized = parseRsvpFields(JSON.stringify(arr));
    set('rsvp_fields_json', stringifyRsvpFields(sanitized));
  }

  // ─── Seating layout passthrough ────────────────────────────────────────
  // Booleans flip 1/0 like the rest of the toggle fields. `seating_layout_svg`
  // accepts a string (already-sanitized by the caller) or null to clear.
  // The /api/events/[id]/seating-layout endpoint is the canonical
  // sanitization entry point; the general PATCH route refuses raw SVGs to
  // keep the surface narrow.
  if (patch.seating_layout_enabled != null) {
    set('seating_layout_enabled', patch.seating_layout_enabled ? 1 : 0);
  }
  if (patch.seating_layout_phases_enabled != null) {
    set('seating_layout_phases_enabled', patch.seating_layout_phases_enabled ? 1 : 0);
  }
  if ('seating_layout_svg' in patch) {
    set('seating_layout_svg', patch.seating_layout_svg ?? null);
  }

  if (fields.length === 0) return existing;
  values.push(id);
  db.prepare(`UPDATE events SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  // Don't log heavy fields (image_data, descriptions, SVG blob) — they bloat
  // the audit log. The SVG can be up to 256 KB; stamping only its byte size
  // keeps the audit trail useful without the noise.
  const lightPatch: Record<string, unknown> = { ...patch };
  delete lightPatch.image_data;
  delete lightPatch.description;
  delete lightPatch.terms;
  delete lightPatch.faqs;
  if (typeof lightPatch.seating_layout_svg === 'string') {
    lightPatch.seating_layout_svg = `(${(lightPatch.seating_layout_svg as string).length} bytes)`;
  }
  // rsvp_fields can include long option lists — keep audit lean by stamping
  // only the count rather than the full array.
  if (Array.isArray(lightPatch.rsvp_fields)) {
    lightPatch.rsvp_fields = `(${(lightPatch.rsvp_fields as unknown[]).length} field(s))`;
  }
  logAudit({ actor: 'admin', action: 'event_update', entityType: 'event', entityId: id, details: lightPatch });
  return getEvent(id);
}

export function deleteEvent(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM events WHERE id = ?').run(id);
  if (result.changes > 0) {
    logAudit({ actor: 'admin', action: 'event_delete', entityType: 'event', entityId: id });
    return true;
  }
  return false;
}

export function priceEntry(event: Event, pax: number): PriceResult {
  const p = Math.max(1, Math.floor(pax));
  let feePerPax = event.base_entry_fee;
  let ruleLabel: string | null = null;
  let paxNote = `${p} × ₹${event.base_entry_fee} (base rate)`;

  for (const rule of event.pax_rules) {
    if (p >= rule.min_pax && (rule.max_pax == null || p <= rule.max_pax)) {
      feePerPax = rule.fee_per_pax;
      ruleLabel = rule.label;
      paxNote = `${p} × ₹${rule.fee_per_pax} (${rule.label})`;
      break;
    }
  }

  const entryFee = feePerPax * p;
  let coverIssued = entryFee;
  if (event.cover_policy === 'fixed') coverIssued = event.cover_value * p;
  else if (event.cover_policy === 'percent') coverIssued = Math.round(entryFee * (event.cover_value / 100));

  return { entryFee, coverIssued, ruleLabel, feePerPax, pax: p, paxNote };
}
