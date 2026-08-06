'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Event } from '@/lib/events';
import { SideNav } from './_wizard/SideNav';
import { SectionBasicInfo } from './_wizard/SectionBasicInfo';
import { SectionLocation } from './_wizard/SectionLocation';
import { SectionSchedule } from './_wizard/SectionSchedule';
import { SectionTickets } from './_wizard/SectionTickets';
import { SectionTicketDesign } from './_wizard/SectionTicketDesign';
import { SectionMedia } from './_wizard/SectionMedia';
import { SectionAdditionalInfo } from './_wizard/SectionAdditionalInfo';
import { SectionInviteOnly } from './_wizard/SectionInviteOnly';
import { SectionRsvpForm } from './_wizard/SectionRsvpForm';
import { SectionCoupons } from './_wizard/SectionCoupons';
import { SectionNotifications } from './_wizard/SectionNotifications';
import { SectionSettings } from './_wizard/SectionSettings';
import {
  EMPTY_STATE, hydrateFromEvent, getIncompleteSections, SECTIONS,
  type WizardState, type SectionKey,
} from './_wizard/types';

export default function EventsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <EventsClient />
    </Suspense>
  );
}

function Loading() {
  return <div className="max-w-5xl mx-auto px-6 md:px-8 py-6 text-slate-500">Loading…</div>;
}

function EventsClient() {
  const router = useRouter();
  const params = useSearchParams();
  const newParam = params.get('new');
  const editParam = params.get('edit');
  const sectionParam = params.get('section') as SectionKey | null;
  const wizardOpen = !!(newParam || editParam);

  if (!wizardOpen) return <EventsHubRedirect />;

  return (
    <EventWizard
      initialEventId={editParam || null}
      initialSection={sectionParam || 'basic_info'}
      onClose={() => router.push('/admin')}
    />
  );
}

function EventsHubRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/admin'); }, [router]);
  return <Loading />;
}

interface WizardProps {
  initialEventId: string | null;
  initialSection: SectionKey;
  onClose: () => void;
}

function EventWizard({ initialEventId, initialSection, onClose }: WizardProps) {
  const router = useRouter();
  const [eventId, setEventId] = useState<string | null>(initialEventId);
  const [active, setActive] = useState<SectionKey>(initialSection);
  const [state, setState] = useState<WizardState>(EMPTY_STATE);
  const [loading, setLoading] = useState(!!initialEventId);
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [status, setStatus] = useState<'draft' | 'live' | 'closed'>('draft');

  useEffect(() => {
    if (!initialEventId) { setLoading(false); return; }
    fetch(`/api/events/${initialEventId}`).then((r) => r.json()).then((d) => {
      if (d.ok) {
        const ev = d.event as Event;
        setState(hydrateFromEvent(ev));
        setStatus((ev.status as 'draft' | 'live' | 'closed') || 'draft');
      } else {
        setError(d.message || 'Event not found.');
      }
      setLoading(false);
    });
  }, [initialEventId]);

  function update(patch: Partial<WizardState>) {
    setState((s) => ({ ...s, ...patch }));
  }

  /**
   * Save everything we know about the event in one PATCH. The backend ignores
   * fields it doesn't recognize, so we can send the whole state without
   * per-section payload selection. Simpler than wiring per-section saves,
   * and the request body is still tiny relative to the image_data field.
   */
  function buildFullPayload(s: WizardState): Record<string, unknown> {
    return {
      name: s.name,
      // Event category — Day / Night classification used by the customer-
      // site grouping. Null on freshly-created drafts; wizard requires both
      // before publish (status = 'live').
      category_slot: s.category_slot,
      category_label: s.category_label,
      // Public-site metadata for the customer akan-events-app.
      tagline: s.tagline.trim() || null,
      hue: s.hue,
      featured: s.featured,
      note: s.note.trim() || null,
      capacity: s.capacity,
      one_line_summary: s.one_line_summary || null,
      description: s.description || null,
      event_date: s.event_date,
      start_time: s.start_time || null,
      is_recurring: s.is_recurring,
      is_public: s.is_public,
      venue_id: s.venue_id || null,
      artist_ids: s.artist_ids,
      genre: s.genre || null,
      tags: s.tags,
      slug: s.slug.trim() || null,
      meta_pixel_id: s.meta_pixel_id.trim() || null,
      image_data: s.image_data,
      card_image: s.card_image,
      terms: s.terms || null,
      faqs: s.faqs || null,
      refund_policy: s.refund_policy || null,
      entry_fee_per_person: s.entry_fee_per_person,
      cover_male_stag: s.cover_rates.male_stag,
      cover_female_stag: s.cover_rates.female_stag,
      cover_couple: s.cover_rates.couple,
      entry_enabled: s.entry_enabled,
      cover_enabled: s.cover_enabled,
      table_types: s.table_types,
      occupancy_rule: s.occupancy_rule,
      gst_percent: s.gst_percent,
      discount_percent: s.discount_percent,
      payment_mode: s.payment_mode,
      deposit_amount: s.payment_mode === 'deposit' ? s.deposit_amount : 0,
      messages_config: s.messages_config,
      // Phase 3 — invite-only gate. invite_secret is intentionally NOT sent:
      // it's server-minted on first switch to 'invite_link' and only rotated
      // via an explicit POST to /api/events/[id]/invite-secret (or the
      // wizard's "Rotate link" button, which fires its own PATCH).
      access_mode: s.access_mode,
      invite_message: s.invite_message || null,
      // Phase 4 — RSVP form. Send the entire FieldDef[] on every save;
      // events lib sanitises (drops unknown types, mints ids for new
      // entries, refuses choice-types without options).
      rsvp_fields: s.rsvp_fields,
      // Phase 4 — Ticket Design. Sent on every save; events lib runs the
      // object through parseTicketDesign() (hex sanitization + layout
      // whitelist) before stringifying into ticket_design_json.
      ticket_design: s.ticket_design,
      // Phase 5 — Seating Layout master toggle. The SVG + zone table are
      // persisted independently via /api/events/[id]/seating-svg + /zones
      // endpoints from SectionSeatingLayout (they're too heavy / too
      // mutation-heavy for the wizard-wide PATCH). Only the on/off flag
      // travels with the main payload.
      seating_layout_enabled: s.seating_layout_enabled,
      // Per-event Settings — inquiry routing + fee payer config + GST.
      // inquiry_phone is sent as empty string when blank so the backend
      // can detect "clear the override" without an explicit null marker;
      // the PATCH route normalises empty → null. Payer enums always
      // travel as 'customer' | 'host' (events lib coerces invalid values
      // back to 'host'). gst_enabled is the master switch; gst_percent
      // already travels above as part of the pricing engine fields.
      inquiry_phone: s.inquiry_phone,
      payment_gateway_fee_payer: s.payment_gateway_fee_payer,
      platform_fee_payer: s.platform_fee_payer,
      gst_enabled: s.gst_enabled,
    };
  }

  async function save(): Promise<boolean> {
    if (!state.name.trim()) { setError('Event title is required.'); setActive('basic_info'); return false; }
    if (!state.event_date) { setError('Pick an event date.'); setActive('schedule'); return false; }

    setError(null);
    setBusy(true);
    try {
      const payload = buildFullPayload(state);
      const res = eventId
        ? await fetch(`/api/events/${eventId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch('/api/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, status: 'draft' }),
          });
      const d = await res.json();
      if (!d.ok) { setError(d.message || 'Save failed.'); return false; }
      if (!eventId && d.event?.id) {
        setEventId(d.event.id);
        router.replace(`/admin/events?edit=${d.event.id}&section=${active}`);
      }
      setSavedAt(Date.now());
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    const incomplete = getIncompleteSections(state);
    if (incomplete.length > 0) {
      const labels = incomplete.map((k) => SECTIONS.find((s) => s.key === k)?.label).filter(Boolean).join(', ');
      setError(`Cannot publish — required fields missing in: ${labels}`);
      setActive(incomplete[0]);
      return;
    }
    setPublishing(true);
    try {
      const ok = await save();
      if (!ok || !eventId) return;
      const res = await fetch(`/api/events/${eventId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'live' }),
      });
      const d = await res.json();
      if (!d.ok) { setError(d.message || 'Publish failed.'); return; }
      setStatus('live');
      setSavedAt(Date.now());
    } finally {
      setPublishing(false);
    }
  }

  if (loading) return <Loading />;

  const activeMeta = SECTIONS.find((s) => s.key === active);

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-4">
      {/* Top bar */}
      <div className="flex items-center gap-3 mb-4">
        <button
          type="button"
          onClick={onClose}
          className="text-slate-500 hover:text-slate-900 inline-flex items-center gap-1 text-sm"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
          {eventId ? 'Edit Event' : 'Add Event'}
        </button>
        <div className="flex-1 min-w-0 px-3">
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Event</div>
          <div className="text-base font-semibold text-slate-900 truncate">
            {state.name || 'Untitled Event'}
          </div>
        </div>
        <StatusBadge status={status} />
        {state.slug && status === 'live' && (
          <a
            href={`/event/${state.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-slate-500 hover:text-brand-600 inline-flex items-center gap-1"
          >
            ↗ Public page
          </a>
        )}
        <button
          type="button"
          onClick={save}
          disabled={busy || publishing}
          className="btn btn-primary"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {eventId && status === 'draft' && (
          <button
            type="button"
            onClick={publish}
            disabled={busy || publishing}
            className="btn btn-secondary whitespace-nowrap"
          >
            {publishing ? 'Publishing…' : 'Save & Publish'}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 px-3 py-2 text-sm">
          {error}
        </div>
      )}

      {/* Two-column layout */}
      <div className="grid grid-cols-12 gap-4">
        <aside className="col-span-12 md:col-span-3">
          <div className="md:sticky md:top-20">
            <SideNav active={active} onSelect={setActive} state={state} />
          </div>
        </aside>
        <main className="col-span-12 md:col-span-9">
          {activeMeta && (
            <div className="mb-3 text-[10px] uppercase tracking-widest text-slate-500">
              {activeMeta.label} → {activeMeta.description}
            </div>
          )}
          {renderSection(active, state, update, eventId)}
        </main>
      </div>

      <div className="mt-5 flex items-center justify-between text-xs text-slate-400">
        <Link href="/admin" className="text-brand-600 hover:text-brand-700">
          ← Back to Events
        </Link>
        {savedAt && <span>Saved {fmtAgo(Date.now() - savedAt)}</span>}
      </div>
    </div>
  );
}

function renderSection(
  key: SectionKey,
  state: WizardState,
  update: (p: Partial<WizardState>) => void,
  eventId: string | null,
) {
  switch (key) {
    case 'basic_info':      return <SectionBasicInfo state={state} onChange={update} />;
    case 'location':        return <SectionLocation state={state} onChange={update} />;
    case 'schedule':        return <SectionSchedule state={state} onChange={update} />;
    case 'tickets':         return <SectionTickets state={state} onChange={update} eventId={eventId} />;
    case 'ticket_design':   return <SectionTicketDesign state={state} onChange={update} eventId={eventId} />;
    case 'media':           return <SectionMedia state={state} onChange={update} eventId={eventId} />;
    case 'additional_info': return <SectionAdditionalInfo state={state} onChange={update} />;
    case 'invite_only':     return <SectionInviteOnly state={state} onChange={update} eventId={eventId} />;
    case 'rsvp_form':       return <SectionRsvpForm state={state} onChange={update} />;
    case 'coupons':         return <SectionCoupons state={state} onChange={update} />;
    case 'notifications':   return <SectionNotifications state={state} onChange={update} />;
    case 'settings':        return <SectionSettings state={state} onChange={update} eventId={eventId} />;
  }
}

function StatusBadge({ status }: { status: 'draft' | 'live' | 'closed' }) {
  const styles = {
    draft:  'bg-slate-100 text-slate-700 border-slate-200',
    live:   'bg-emerald-50 text-emerald-700 border-emerald-200',
    closed: 'bg-rose-50 text-rose-700 border-rose-200',
  };
  const labels = { draft: 'Draft', live: 'Live', closed: 'Closed' };
  return (
    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border font-semibold ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

function fmtAgo(ms: number): string {
  if (ms < 5_000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  return `${Math.floor(ms / 3_600_000)} h ago`;
}
