import { NextRequest, NextResponse } from 'next/server';
import { getEvent, updateEvent, deleteEvent } from '@/lib/events';
import type { TicketDesign } from '@/lib/ticket-design';
import { validatePaxRules, validateBookingTypes } from '@/lib/events-validators';
import { requireRole } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const event = getEvent(id);
  if (!event) return NextResponse.json({ ok: false, message: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, event });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireRole(['host', 'manager']);
  if ('forbidden' in session) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status });
  }

  const { id } = await ctx.params;
  const body = await req.json();
  const patch: Record<string, unknown> = {};

  // Strings (nullable copy semantics — pass null to clear)
  for (const k of [
    'name', 'event_date', 'status', 'cover_policy', 'notes',
    'description', 'image_data', 'card_image', 'start_time', 'venue_id',
    'genre', 'terms', 'faqs',
    'slug', 'meta_pixel_id',
    'refund_policy', 'one_line_summary',
    'invite_message',
    // Per-event Settings — Inquiry contact phone override.
    'inquiry_phone',
    // Event category (Day/Night classification) — drives the customer
    // site's section grouping. Enum validation happens in updateEvent().
    'category_slot', 'category_label',
    // Public-site card metadata consumed by the customer events app.
    // hue is enum-validated in updateEvent(); tagline/note are trimmed
    // and length-capped there too.
    'tagline', 'hue', 'note',
  ]) {
    if (k in body) patch[k] = body[k];
  }

  // ─── Per-event Settings — fee payer enums + GST master toggle ──────────
  // Enum gate: only accept the two known values, otherwise drop the patch
  // entirely (keeps DB DEFAULT 'host' intact). gst_enabled is a boolean
  // master toggle separate from the gst_percent number above.
  if (body.payment_gateway_fee_payer === 'customer' || body.payment_gateway_fee_payer === 'host') {
    patch.payment_gateway_fee_payer = body.payment_gateway_fee_payer;
  }
  if (body.platform_fee_payer === 'customer' || body.platform_fee_payer === 'host') {
    patch.platform_fee_payer = body.platform_fee_payer;
  }
  if ('gst_enabled' in body) patch.gst_enabled = !!body.gst_enabled;

  // Phase 3 — invite-only access mode. Enum; ignore anything else.
  // The wizard's "Rotate link" button sends { rotate_invite_secret: true }
  // alongside (or separately from) access_mode; the events lib handles
  // minting on first switch to 'invite_link' and rotation when asked.
  if (body.access_mode === 'public' || body.access_mode === 'invite_link' || body.access_mode === 'phone_list') {
    patch.access_mode = body.access_mode;
  }
  if (body.rotate_invite_secret === true) {
    patch.rotate_invite_secret = true;
  }

  // Numbers
  for (const k of [
    'base_entry_fee', 'cover_value', 'cutoff_hour',
    'entry_fee_per_person', 'cover_male_stag', 'cover_female_stag', 'cover_couple',
    'gst_percent', 'discount_percent',
    // Public-site capacity cap. 0 = unlimited; clamped in updateEvent().
    'capacity',
  ]) {
    if (k in body) patch[k] = Number(body[k]);
  }

  // Booleans
  if ('is_public' in body) patch.is_public = !!body.is_public;
  if ('entry_enabled' in body) patch.entry_enabled = !!body.entry_enabled;
  if ('cover_enabled' in body) patch.cover_enabled = !!body.cover_enabled;
  // Public-site "pin to top of its Day/Night rail" flag.
  if ('featured' in body) patch.featured = !!body.featured;
  // Public-site "Recurring" chip. Presentational only — no repeat instances.
  if ('is_recurring' in body) patch.is_recurring = !!body.is_recurring;

  // Seating layout — accept the toggle booleans here so the wizard's
  // buildFullPayload can flip the feature on/off in one save. The SVG
  // itself is forbidden via this endpoint — callers MUST use
  // /api/events/[id]/seating-layout so sanitization stays centralised.
  if ('seating_layout_svg' in body) {
    return NextResponse.json(
      { ok: false, message: 'Use /api/events/[id]/seating-layout to update the venue SVG.' },
      { status: 400 },
    );
  }
  if ('seating_layout_enabled' in body) patch.seating_layout_enabled = !!body.seating_layout_enabled;
  if ('seating_layout_phases_enabled' in body) {
    patch.seating_layout_phases_enabled = !!body.seating_layout_phases_enabled;
  }

  // Occupancy rule (enum)
  if (body.occupancy_rule === 'exact' || body.occupancy_rule === 'min') {
    patch.occupancy_rule = body.occupancy_rule;
  }

  // Table types (validated array of {id, name, capacity, entry_fee})
  if ('table_types' in body) {
    if (!Array.isArray(body.table_types)) {
      return NextResponse.json({ ok: false, message: 'table_types must be an array.' }, { status: 400 });
    }
    const VALID_VIS = new Set(['none', 'hidden', 'fast_filling', 'sold_out']);
    const sanitized: Record<string, unknown>[] = [];
    for (const raw of body.table_types as Record<string, unknown>[]) {
      const out: Record<string, unknown> = {
        id: typeof raw.id === 'string' && raw.id ? raw.id : `tt_${Math.random().toString(36).slice(2, 9)}`,
        name: String(raw.name || '').trim(),
        capacity: Math.max(1, Number(raw.capacity) || 1),
        entry_fee: Math.max(0, Number(raw.entry_fee) || 0),
      };
      if ('info' in raw) out.info = typeof raw.info === 'string' ? raw.info : '';
      if ('visibility' in raw && typeof raw.visibility === 'string' && VALID_VIS.has(raw.visibility)) {
        out.visibility = raw.visibility;
      }
      if ('external_link' in raw) {
        const url = typeof raw.external_link === 'string' ? raw.external_link.trim() : '';
        if (url && !/^https?:\/\//i.test(url)) {
          return NextResponse.json(
            { ok: false, message: `Table "${out.name}": external link must start with http:// or https://` },
            { status: 400 },
          );
        }
        out.external_link = url || null;
      }
      if ('contact_cta_enabled' in raw) out.contact_cta_enabled = !!raw.contact_cta_enabled;
      if ('max_per_booking' in raw) out.max_per_booking = Math.max(0, Number(raw.max_per_booking) || 0);
      if ('inventory' in raw) out.inventory = Math.max(0, Number(raw.inventory) || 0);
      if ('time_slots' in raw && Array.isArray(raw.time_slots)) {
        out.time_slots = (raw.time_slots as Record<string, unknown>[]).map((s) => ({
          id: typeof s.id === 'string' && s.id ? s.id : `ts_${Math.random().toString(36).slice(2, 9)}`,
          start: String(s.start || ''),
          end: String(s.end || ''),
          quantity: Math.max(0, Number(s.quantity) || 0),
        }));
      }
      sanitized.push(out);
    }
    patch.table_types = sanitized;
  }

  // Arrays
  if ('artist_ids' in body && Array.isArray(body.artist_ids)) {
    patch.artist_ids = body.artist_ids.map(String);
  }
  if ('tags' in body && Array.isArray(body.tags)) {
    patch.tags = body.tags.map(String);
  }

  // Nested JSON
  if ('pax_rules' in body) {
    const rules = validatePaxRules(body.pax_rules);
    if (rules instanceof Error) return NextResponse.json({ ok: false, message: rules.message }, { status: 400 });
    patch.pax_rules = rules;
  }
  if ('booking_types' in body) {
    const bts = validateBookingTypes(body.booking_types);
    if (bts instanceof Error) return NextResponse.json({ ok: false, message: bts.message }, { status: 400 });
    patch.booking_types = bts;
  }
  if ('messages_config' in body && body.messages_config && typeof body.messages_config === 'object') {
    patch.messages_config = body.messages_config;
  }

  // ─── Phase 4: RSVP Form ────────────────────────────────────────────────
  // Wizard sends the whole FieldDef[] on every save. updateEvent runs it
  // through parseRsvpFields() so unknown types are dropped and ids are
  // minted for any new entries — no need to over-validate here.
  if ('rsvp_fields' in body) {
    if (Array.isArray(body.rsvp_fields)) {
      patch.rsvp_fields = body.rsvp_fields;
    } else if (body.rsvp_fields === null) {
      patch.rsvp_fields = [];
    }
  }

  // ─── Phase 4: Ticket Design ────────────────────────────────────────────
  // Wizard sends the whole design blob on every save via buildFullPayload.
  // updateEvent runs it through parseTicketDesign() so unknown fields are
  // dropped and invalid hex colors snap back to defaults — no extra
  // validation needed here. Passing null resets to defaults.
  if ('ticket_design' in body) {
    if (body.ticket_design === null) {
      patch.ticket_design = null;
    } else if (body.ticket_design && typeof body.ticket_design === 'object') {
      patch.ticket_design = body.ticket_design as Partial<TicketDesign>;
    }
  }

  const event = updateEvent(id, patch);
  if (!event) return NextResponse.json({ ok: false, message: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, event });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireRole(['host']);
  if ('forbidden' in session) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status });
  }
  const { id } = await ctx.params;
  const ok = deleteEvent(id);
  if (!ok) return NextResponse.json({ ok: false, message: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
