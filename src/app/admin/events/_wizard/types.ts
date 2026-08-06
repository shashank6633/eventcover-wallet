import type { BookingType, MessagesConfig, Event, TableType, OccupancyRule, CoverRates, FieldDef } from '@/lib/events';
import { DEFAULT_PRICING, DEFAULT_TABLE_TYPES } from '@/lib/pricing';
import { DEFAULT_TICKET_DESIGN, parseTicketDesign, type TicketDesign } from '@/lib/ticket-design';

/**
 * Legacy linear-step keys — preserved so any external callers still compile,
 * but the new side-nav model uses `SectionKey` instead.
 */
export type Step = 1 | 2 | 3 | 4;

/**
 * Growezzy-style side-nav sections. Order in this array drives the rendered
 * sidebar order. Each entry declares which phase it belongs to so the wizard
 * can render placeholder cards for Phase 2-4 sections without the backend
 * having a column for them yet.
 */
export type SectionKey =
  | 'basic_info'
  | 'location'
  | 'schedule'
  | 'tickets'
  | 'ticket_design'
  | 'media'
  | 'additional_info'
  | 'invite_only'
  | 'rsvp_form'
  | 'coupons'
  | 'notifications'
  | 'settings';

export interface SectionMeta {
  key: SectionKey;
  label: string;
  description: string;
  /** Icon name resolved by SideNav to one of its local SVG components. */
  icon: 'info' | 'pin' | 'calendar' | 'ticket' | 'design' | 'image' | 'doc' | 'lock' | 'form' | 'tag' | 'bell' | 'cog';
  /** 1 = built into Phase 1 (this build). 2/3/4 = planned, renders a placeholder. */
  phase: 1 | 2 | 3 | 4;
  /** True if this section must be filled before the event can go live. */
  required?: boolean;
}

export const SECTIONS: SectionMeta[] = [
  { key: 'basic_info',      label: 'Basic Info',      description: 'Name, summary & description', icon: 'info',     phase: 1, required: true },
  { key: 'location',        label: 'Location',        description: 'Venue & address',              icon: 'pin',      phase: 1 },
  { key: 'schedule',        label: 'Schedule',        description: 'Dates & time',                 icon: 'calendar', phase: 1, required: true },
  { key: 'tickets',         label: 'Tickets',         description: 'Pricing & availability',       icon: 'ticket',   phase: 1, required: true },
  { key: 'ticket_design',   label: 'Ticket Design',   description: 'Customize ticket appearance',  icon: 'design',   phase: 4 },
  { key: 'media',           label: 'Media',           description: 'Cover image & gallery',        icon: 'image',    phase: 1 },
  { key: 'additional_info', label: 'Additional Info', description: 'T&C, refund & FAQs',           icon: 'doc',      phase: 1 },
  { key: 'invite_only',     label: 'Invite Only',     description: 'Access & guest list',          icon: 'lock',     phase: 3 },
  { key: 'rsvp_form',       label: 'RSVP Form',       description: 'Attendee info',                icon: 'form',     phase: 4 },
  { key: 'coupons',         label: 'Coupons',         description: 'Discount codes & offers',      icon: 'tag',      phase: 2 },
  { key: 'notifications',   label: 'Notifications',   description: 'Auto-message templates',       icon: 'bell',     phase: 1 },
  { key: 'settings',        label: 'Settings',        description: 'Preferences & fees',           icon: 'cog',      phase: 1 },
];

/**
 * Event category — Day vs Night slot drives the customer-website grouping;
 * label is the on-card chip text. Stored as two separate columns on events
 * so future labels (e.g. "Open Mic") can be added without a schema change
 * while the day/night split stays a strict enum.
 *
 * Presets exposed via DAY_CATEGORY_LABELS / NIGHT_CATEGORY_LABELS below.
 * The wizard UI restricts selection to those; the lib validates only
 * `slot` strictly (label accepts any non-empty string ≤ 60 chars).
 */
export type CategorySlot = 'day' | 'night';

export const DAY_CATEGORY_LABELS = ['Brunch', 'Workshop', 'Evening Event'] as const;
export const NIGHT_CATEGORY_LABELS = ['Live Band', 'DJ Night'] as const;
export type CategoryLabel =
  | (typeof DAY_CATEGORY_LABELS)[number]
  | (typeof NIGHT_CATEGORY_LABELS)[number];

export interface WizardState {
  // Basic Info
  name: string;
  // Day / Night classification — mandatory before publish. Drives customer-
  // site grouping ("Day Events" vs "Night Events" sections) + the on-card
  // category chip. Both null on freshly-created drafts.
  category_slot: CategorySlot | null;
  category_label: string | null;
  // ─── Public-site metadata (consumed by the customer akan-events-app) ────
  // These don't affect venue ops — they control how the event renders on
  // the public events site: card color, featured pinning, badge text, and
  // the capacity signal that drives "Selling fast" / "Sold out".
  tagline: string;
  hue: string;
  featured: boolean;
  note: string;
  capacity: number;
  one_line_summary: string;  // Max 100 chars, shown in event previews + ad previews
  description: string;       // HTML
  slug: string;              // URL-friendly identifier; auto-generated server-side when blank
  meta_pixel_id: string;     // Per-event Meta Pixel ID override (digits only)

  // Media
  image_data: string | null; // base64 — 1:1 Cover Image (hero, 1080×1080)
  card_image: string | null; // base64 — 2:3 Card Image (listing/social, 800×1200)

  // Schedule
  event_date: string;        // YYYY-MM-DD
  start_time: string;        // "21:30"
  // Presentational flag only — shows a "Recurring" chip on the public site.
  // No repeat instances are generated from it.
  is_recurring: boolean;

  // Location
  venue_id: string;

  // (still shown on Basic Info via the public/private visibility toggle)
  is_public: boolean;

  // Artists/genre/tags — currently live under Basic Info too
  artist_ids: string[];
  genre: string;
  tags: string[];

  // Additional Info
  terms: string;
  faqs: string;
  refund_policy: string;     // Plain text, shown on /event/[slug] next to T&C

  // Tickets — Pricing & Tables
  entry_fee_per_person: number;
  cover_rates: CoverRates;
  entry_enabled: boolean;
  cover_enabled: boolean;
  table_types: TableType[];
  occupancy_rule: OccupancyRule;
  gst_percent: number;
  discount_percent: number;

  // Tickets — Online payment mode (Razorpay)
  payment_mode: 'none' | 'deposit' | 'full_cover';
  deposit_amount: number;

  // Legacy field — kept for backward compat with offline ticketing,
  // not shown in the wizard UI anymore.
  booking_types: BookingType[];

  // Notifications
  messages_config: MessagesConfig;

  // Invite Only (Phase 3)
  // access_mode controls how visitors land on /event/[slug]:
  //   • 'public'      → open booking, today's behaviour
  //   • 'invite_link' → must arrive with ?invite=<invite_secret>
  //   • 'phone_list'  → phone must be on event_invitees whitelist
  // invite_secret is server-minted on first switch to 'invite_link'; the
  // wizard never edits it directly — it shows the resulting URL + a
  // "Rotate link" button that PATCHes the event to regenerate it.
  access_mode: 'public' | 'invite_link' | 'phone_list';
  invite_secret: string | null;
  invite_message: string;

  // ─── Phase 4: RSVP Form ──────────────────────────────────────────────────
  // Per-event custom RSVP fields rendered after the standard ones on the
  // public booking form. Empty array = no custom fields. Persisted as JSON
  // in events.rsvp_fields_json — see src/lib/rsvp-fields.ts for the canonical
  // type definition + parse/validate helpers.
  rsvp_fields: FieldDef[];

  // ─── Phase 4: Ticket Design ──────────────────────────────────────────────
  // Per-event override of the wallet pass PNG visual layout. Always a fully-
  // populated TicketDesign in the wizard state (legacy events hydrate via
  // parseTicketDesign() which fills in defaults for missing fields) so the
  // editor UI never has to deal with partial / null shapes. The canonical
  // type, defaults, and hex sanitizer live in src/lib/ticket-design.ts.
  ticket_design: TicketDesign;

  // ─── Phase 5: Seating Layout ─────────────────────────────────────────────
  // Per-event opt-in for SVG-based zone pricing on the public booking flow.
  // When false (default), the existing flat entry_fee_per_person + table_types
  // flow continues unchanged. When true, the host uploads a venue SVG, named
  // layers become bookable zones (see event_zones table), and the public
  // booking page renders the SVG with interactive zone selection. The SVG
  // markup itself + the per-zone table live in their own endpoints
  // (/api/events/[id]/seating-svg + /api/events/[id]/zones) — only the
  // master toggle is part of WizardState.
  seating_layout_enabled: boolean;

  // ─── Phased Ticket Releases (Early Bird → Phase 1/2/3) ───────────────────
  // Opt-in for the per-event ticket-phases overlay. When ON, hosts can define
  // phases (event_ticket_phases) and per-(phase × ticket-type-or-zone) prices
  // (event_ticket_phase_prices) which override the static entry_fee_per_person
  // and zone prices for whichever phase is currently active. The toggle is
  // surfaced in both Tickets and Seating Layout sections — both flip the same
  // field, so enabling phases anywhere unlocks the matrix everywhere.
  seating_layout_phases_enabled: boolean;

  // ─── Settings — per-event fees & inquiry contact ─────────────────────────
  // inquiry_phone: E.164 number we WhatsApp when a customer submits a
  //   "Contact host" inquiry; empty = fall back to brand page phone.
  // payment_gateway_fee_payer / platform_fee_payer:
  //   'customer' → fee is added on top of the ticket subtotal at checkout
  //   'host'     → fee is absorbed by the host out of payout (no line item)
  // gst_enabled: master toggle for GST. When ON, gst_percent (existing
  //   pricing engine field) is applied to the post-fees subtotal at order
  //   creation time. When OFF, GST is skipped regardless of gst_percent.
  inquiry_phone: string;
  payment_gateway_fee_payer: 'customer' | 'host';
  platform_fee_payer: 'customer' | 'host';
  gst_enabled: boolean;
}

export const EMPTY_STATE: WizardState = {
  name: '',
  category_slot: null,
  category_label: null,
  tagline: '',
  hue: 'sunny',
  featured: false,
  note: '',
  capacity: 0,
  one_line_summary: '',
  description: '',
  image_data: null,
  card_image: null,
  event_date: '',
  start_time: '',
  is_recurring: false,
  is_public: true,
  artist_ids: [],
  venue_id: '',
  genre: '',
  tags: [],
  slug: '',
  meta_pixel_id: '',
  terms: '',
  faqs: '',
  refund_policy: '',
  entry_fee_per_person: DEFAULT_PRICING.entry_fee_per_person,
  cover_rates: { ...DEFAULT_PRICING.cover_rates },
  entry_enabled: DEFAULT_PRICING.entry_enabled,
  cover_enabled: DEFAULT_PRICING.cover_enabled,
  table_types: [...DEFAULT_TABLE_TYPES],
  occupancy_rule: DEFAULT_PRICING.occupancy_rule,
  gst_percent: DEFAULT_PRICING.gst_percent,
  discount_percent: DEFAULT_PRICING.discount_percent,
  payment_mode: 'none',
  deposit_amount: 0,
  booking_types: [],
  messages_config: {},
  access_mode: 'public',
  invite_secret: null,
  invite_message: '',
  rsvp_fields: [],
  ticket_design: { ...DEFAULT_TICKET_DESIGN },
  seating_layout_enabled: false,
  seating_layout_phases_enabled: false,
  inquiry_phone: '',
  payment_gateway_fee_payer: 'host',
  platform_fee_payer: 'host',
  gst_enabled: false,
};

export function hydrateFromEvent(e: Event): WizardState {
  // Cast: category_slot / category_label were added to the events table
  // (and the Event type) after the wizard shipped; older snapshots may not
  // carry them. Treat missing as nulls and let the wizard require them
  // before publish.
  const ec = e as unknown as {
    category_slot?: 'day' | 'night' | null;
    category_label?: string | null;
    tagline?: string | null;
    hue?: string | null;
    featured?: boolean | number | null;
    note?: string | null;
    capacity?: number | null;
    is_recurring?: boolean | number | null;
  };
  return {
    name: e.name,
    category_slot: ec.category_slot === 'day' || ec.category_slot === 'night' ? ec.category_slot : null,
    category_label: ec.category_label || null,
    tagline: ec.tagline || '',
    hue: ec.hue || 'sunny',
    featured: !!ec.featured,
    note: ec.note || '',
    capacity: Number(ec.capacity) || 0,
    one_line_summary:
      (e as unknown as { one_line_summary?: string | null }).one_line_summary ?? '',
    description: e.description ?? '',
    image_data: e.image_data ?? null,
    card_image:
      (e as unknown as { card_image?: string | null }).card_image ?? null,
    event_date: e.event_date,
    start_time: e.start_time ?? '',
    is_recurring: !!ec.is_recurring,
    is_public: e.is_public,
    artist_ids: e.artist_ids,
    venue_id: e.venue_id ?? '',
    genre: e.genre ?? '',
    tags: e.tags,
    slug: e.slug ?? '',
    meta_pixel_id: e.meta_pixel_id ?? '',
    terms: e.terms ?? '',
    faqs: e.faqs ?? '',
    refund_policy:
      (e as unknown as { refund_policy?: string | null }).refund_policy ?? '',
    entry_fee_per_person: e.entry_fee_per_person ?? DEFAULT_PRICING.entry_fee_per_person,
    cover_rates: e.cover_rates,
    entry_enabled: e.entry_enabled,
    cover_enabled: e.cover_enabled,
    table_types: e.table_types.length > 0 ? e.table_types : [...DEFAULT_TABLE_TYPES],
    occupancy_rule: e.occupancy_rule,
    gst_percent: e.gst_percent ?? 0,
    discount_percent: e.discount_percent ?? 0,
    payment_mode:
      (e as unknown as { payment_mode?: 'none' | 'deposit' | 'full_cover' }).payment_mode
      ?? 'none',
    deposit_amount:
      Number((e as unknown as { deposit_amount?: number }).deposit_amount) || 0,
    booking_types: e.booking_types,
    messages_config: e.messages_config,
    // Phase 3 — invite-only. The Event type does not yet declare these
    // fields, but the SELECT * in hydrate() returns them when the DB has
    // the columns. Cast through unknown so the wizard can still read them
    // without touching every list-views' type narrowing.
    access_mode:
      ((e as unknown as { access_mode?: 'public' | 'invite_link' | 'phone_list' | null })
        .access_mode) || 'public',
    invite_secret:
      (e as unknown as { invite_secret?: string | null }).invite_secret ?? null,
    invite_message:
      (e as unknown as { invite_message?: string | null }).invite_message ?? '',
    // Phase 4 — RSVP custom fields. Hydrated by the events lib into a clean
    // FieldDef[]; legacy events that pre-date the column come through as []
    // courtesy of parseRsvpFields().
    rsvp_fields: Array.isArray(
      (e as unknown as { rsvp_fields?: FieldDef[] }).rsvp_fields,
    )
      ? (e as unknown as { rsvp_fields: FieldDef[] }).rsvp_fields
      : [],
    // Phase 4 — Ticket Design. The events lib already runs the raw column
    // through parseTicketDesign() during hydrate(), so e.ticket_design is
    // always a complete TicketDesign. Re-parse defensively so older /
    // partially-typed callers can't sneak a malformed object into the
    // wizard state.
    ticket_design: parseTicketDesign(
      (e as unknown as { ticket_design?: TicketDesign | null }).ticket_design ?? null,
    ),
    // Phase 5 — Seating Layout. Event type doesn't declare this yet; the
    // SELECT * in hydrate() will populate it once the backend adds the column.
    // Coerce truthy values (number 1 / boolean true) to true so legacy events
    // without the column hydrate as `false` cleanly.
    seating_layout_enabled: !!(
      e as unknown as { seating_layout_enabled?: number | boolean | null }
    ).seating_layout_enabled,
    // Phased ticket releases — same coercion story as seating_layout_enabled.
    // Legacy events without the column hydrate as false; the wizard then
    // surfaces the toggle inside both the Tickets and Seating Layout sections.
    seating_layout_phases_enabled: !!(
      e as unknown as { seating_layout_phases_enabled?: number | boolean | null }
    ).seating_layout_phases_enabled,
    // Settings — fee/GST configuration + inquiry phone. All four fields are
    // additive and default to safe values so legacy event rows missing the
    // columns hydrate as "host pays everything, no GST".
    inquiry_phone:
      (e as unknown as { inquiry_phone?: string | null }).inquiry_phone ?? '',
    payment_gateway_fee_payer:
      ((e as unknown as { payment_gateway_fee_payer?: 'customer' | 'host' | null })
        .payment_gateway_fee_payer) === 'customer'
        ? 'customer'
        : 'host',
    platform_fee_payer:
      ((e as unknown as { platform_fee_payer?: 'customer' | 'host' | null })
        .platform_fee_payer) === 'customer'
        ? 'customer'
        : 'host',
    gst_enabled: !!(
      e as unknown as { gst_enabled?: number | boolean | null }
    ).gst_enabled,
  };
}

/**
 * Returns the keys of sections that are required but still incomplete. Used by
 * the side-nav to render red-dot indicators and by the Save & Publish button
 * to refuse to push 'live' status on a half-filled event.
 */
export function getIncompleteSections(s: WizardState): SectionKey[] {
  const out: SectionKey[] = [];
  if (
    !s.name.trim() ||
    !s.description.trim() ||
    // Category is mandatory — both slot AND a label are required so the
    // customer site can group the event correctly. We don't error on label
    // shape (any non-empty string is valid for forward-compat with future
    // presets), just on presence.
    !s.category_slot ||
    !s.category_label
  ) out.push('basic_info');
  if (!s.event_date) out.push('schedule');
  if (
    s.entry_fee_per_person <= 0 &&
    s.cover_rates.male_stag <= 0 &&
    s.cover_rates.female_stag <= 0 &&
    s.cover_rates.couple <= 0
  ) out.push('tickets');
  return out;
}

/** @deprecated Use SECTIONS instead. Kept so any legacy imports still compile. */
export const STEP_LABELS: Record<Step, string> = {
  1: 'Event Details',
  2: "Terms & Conditions, FAQ's",
  3: 'Pricing & Tables',
  4: 'Messages',
};
