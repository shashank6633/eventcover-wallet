import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { MetaPixel } from '@/components/MetaPixel';
import {
  PublicBookingForm,
  type EventSlot,
  type AccessMode,
  type ActivePhase,
  type PhasePrice,
  type NextPhasePreview,
} from '@/components/PublicBookingForm';
import { EventAnalyticsTracker } from '@/components/EventAnalyticsTracker';
import { EventCTAs } from './EventCTAs';
import type { FieldDef } from '@/lib/events';
import type { PublicZone } from '@/components/SeatingPicker';

/**
 * Public event landing page. No auth, no AdminShell.
 *
 * Renders:
 *   1. Brand header (venue name)
 *   2. Hero (event image, name, date, genre)
 *   3. Description
 *   4. Three CTAs (WhatsApp / Call / Reserve)
 *   5. Booking form
 *
 * The Meta Pixel snippet is injected only if the backend returns a non-null
 * pixelId (event override OR global setting). Initial events fired:
 *   - PageView
 *   - ViewContent (with content_name + value=0 INR)
 *
 * CTA clicks fire additional Pixel events (Contact / InitiateCheckout) via
 * the EventCTAs client component.
 */

// Force dynamic so we always re-fetch event status (so a freshly "closed"
// event 404s on the next pageview).
export const dynamic = 'force-dynamic';

interface MediaItem {
  id?: string;
  image_data: string;
  caption: string | null;
  sort_order?: number;
  position?: number;
  kind?: 'image' | 'video';
}

interface PublicEventPayload {
  ok: true;
  event: {
    id: string;
    slug: string;
    name: string;
    event_date: string;
    description: string | null;
    image_data: string | null; // base64 data URL or raw base64
    start_time: string | null;
    genre: string | null;
    venue_id: string;
    /**
     * CONTRACT status ('active' | 'archived' | 'sold-out') consumed by the
     * external customer app. Do NOT branch on this here — use
     * internal_status, which carries our own 'live' | 'closed' lifecycle.
     */
    status: string;
    /** Raw internal lifecycle. 'draft' is already 404'd by the API. */
    internal_status?: string;
    /** Phase 3: optional, defaults to 'public' for backward compat. */
    access_mode?: AccessMode | null;
    /** Phase 3: optional soft-gate copy shown above the form / on locked screen. */
    invite_message?: string | null;
  };
  pixelId: string | null;
  venuePhone: string;
  venueName: string;
  paymentMode: 'none' | 'deposit' | 'full_cover';
  paymentAmount: number | null;
  media?: MediaItem[] | null;
  /** Phase 3: active slots, optional — empty/undefined means single implicit slot. */
  slots?: EventSlot[] | null;
  /** Phase 4: host-configured custom RSVP fields. Optional/empty means none. */
  rsvpFields?: FieldDef[] | null;
  /**
   * Seating Layout — when true, the public booking form renders the
   * interactive SVG zone picker and forwards zone_id on reservation.
   * Optional/false for legacy events (the flat-pricing flow is unchanged).
   */
  seatingLayoutEnabled?: boolean;
  /**
   * Server-sanitized SVG markup. Only meaningful when
   * `seatingLayoutEnabled` is true. The backend only echoes this back when
   * the feature is on — the field is omitted otherwise to keep payloads
   * lean.
   */
  sanitizedSvg?: string | null;
  /** Public projection of event_zones for this event. */
  zones?: PublicZone[] | null;
  /**
   * Per-event Settings — fee payer + GST flags + percentages. Optional so
   * legacy API responses (pre-deploy) keep rendering with the host-pays /
   * GST-off defaults.
   */
  paymentGatewayFeePayer?: 'customer' | 'host';
  platformFeePayer?: 'customer' | 'host';
  gstEnabled?: boolean;
  paymentGatewayFeePct?: number;
  platformFeePct?: number;
  gstPercent?: number;
  discountPercent?: number;
  /** M/F/C cover rates from event config. Zero means no per-category cover. */
  coverRates?: {
    male_stag?: number;
    female_stag?: number;
    couple?: number;
  };
  entryFeePerPerson?: number;
  /**
   * Phased Ticket Releases — the currently-active phase (when one is
   * configured + live). Null/omitted for legacy events with no phases.
   */
  activePhase?: ActivePhase | null;
  /** Per-scope active phase prices (zones + table_types + flat_entry). */
  phasePrices?: PhasePrice[] | null;
  /** Optional preview of the next phase shown below the ticket picker. */
  nextPhasePreview?: NextPhasePreview | null;
}

async function getEventBySlug(slug: string): Promise<PublicEventPayload | null> {
  // Build an absolute URL for the server-side fetch. We can't rely on
  // process.env.NEXT_PUBLIC_BASE_URL being set in every environment, so
  // derive it from the incoming request headers.
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') || 'http';
  if (!host) return null;

  const url = `${proto}://${host}/api/events/by-slug/${encodeURIComponent(slug)}/public`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = (await res.json()) as PublicEventPayload | { ok: false };
    if (!json || !('ok' in json) || !json.ok) return null;
    return json;
  } catch {
    return null;
  }
}

function formatEventDate(dateIso: string): string {
  // event_date is expected as YYYY-MM-DD or ISO. Render in long form.
  try {
    const d = new Date(dateIso);
    if (Number.isNaN(d.getTime())) return dateIso;
    return d.toLocaleDateString('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return dateIso;
  }
}

function normalizeImageSrc(imageData: string | null): string | null {
  if (!imageData) return null;
  if (imageData.startsWith('data:')) return imageData;
  if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
    return imageData;
  }
  // Assume raw base64 PNG/JPEG
  return `data:image/jpeg;base64,${imageData}`;
}

function digitsOnly(phone: string): string {
  return (phone || '').replace(/\D/g, '');
}

export default async function PublicEventPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = searchParams ? await searchParams : {};
  // Phase 3 invite token — accept ?invite= from URL. May be absent for
  // public events; we still pass it through (as empty) so the form can
  // forward whatever the customer pasted.
  const rawInvite = sp?.invite;
  const inviteToken =
    typeof rawInvite === 'string'
      ? rawInvite.trim()
      : Array.isArray(rawInvite) && typeof rawInvite[0] === 'string'
        ? rawInvite[0].trim()
        : '';

  const data = await getEventBySlug(slug);
  if (!data) return notFound();

  const { event, pixelId, venuePhone, venueName } = data;
  // Phase 3 fields. Backend may not yet ship access_mode/slots — default to
  // safe public behaviour so legacy event payloads continue to render the
  // form unchanged.
  const accessMode: AccessMode = (event.access_mode || 'public') as AccessMode;
  const inviteMessage = event.invite_message || null;
  const slots: EventSlot[] = Array.isArray(data.slots) ? data.slots : [];
  // Phase 4 — custom RSVP fields. Older API responses (pre-Phase-4 deploy)
  // don't include rsvpFields; default to [] so legacy events keep rendering
  // the form with just the standard inputs.
  const rsvpFields: FieldDef[] = Array.isArray(data.rsvpFields) ? data.rsvpFields : [];
  // New payment fields default to safe values so older API responses
  // (pre-migration) don't break the page.
  const paymentMode = data.paymentMode || 'none';
  const paymentAmount = data.paymentAmount ?? null;
  // Seating Layout — defaults that keep legacy events on the flat-pricing
  // path. The backend only ships sanitizedSvg + zones when
  // seatingLayoutEnabled is true, so guarding here means an old payload
  // (pre-feature) renders exactly as it always did.
  const seatingLayoutEnabled = !!data.seatingLayoutEnabled;
  const seatingLayoutSvg =
    seatingLayoutEnabled && typeof data.sanitizedSvg === 'string'
      ? data.sanitizedSvg
      : null;
  const zones: PublicZone[] =
    seatingLayoutEnabled && Array.isArray(data.zones) ? data.zones : [];
  // Per-event Settings — fee payer + GST flags + percentages. Defaults
  // mean "host pays everything, no GST" so legacy/older API responses
  // keep rendering exactly as they did.
  const paymentGatewayFeePayer: 'customer' | 'host' =
    data.paymentGatewayFeePayer === 'customer' ? 'customer' : 'host';
  const platformFeePayer: 'customer' | 'host' =
    data.platformFeePayer === 'customer' ? 'customer' : 'host';
  const gstEnabled = !!data.gstEnabled;
  const paymentGatewayFeePct = Number(data.paymentGatewayFeePct ?? 0) || 0;
  const platformFeePct = Number(data.platformFeePct ?? 0) || 0;
  const gstPercent = Number(data.gstPercent ?? 0) || 0;
  const discountPercent = Number(data.discountPercent ?? 0) || 0;
  // M/F/C — defaults all zero so events without per-category cover rates fall
  // back to the legacy single pax input (the form checks `hasCoverRates`).
  const coverRates = {
    male_stag: Number(data.coverRates?.male_stag ?? 0) || 0,
    female_stag: Number(data.coverRates?.female_stag ?? 0) || 0,
    couple: Number(data.coverRates?.couple ?? 0) || 0,
  };
  const entryFeePerPerson = Number(data.entryFeePerPerson ?? 0) || 0;
  // Phased Ticket Releases — backend may not yet ship activePhase/phasePrices/
  // nextPhasePreview for older payloads; default to null/[] so legacy events
  // render the form with no banner and no price overrides (the form's
  // existing flat-pricing behavior is preserved when phasePrices is empty).
  const activePhase: ActivePhase | null =
    data.activePhase && typeof data.activePhase.id === 'string'
      ? data.activePhase
      : null;
  const phasePrices: PhasePrice[] = Array.isArray(data.phasePrices)
    ? data.phasePrices
    : [];
  const nextPhasePreview: NextPhasePreview | null =
    data.nextPhasePreview && typeof data.nextPhasePreview.name === 'string'
      ? data.nextPhasePreview
      : null;
  // Whitelisted media projection from backend. Sort defensively by
  // sort_order/position so we render in the curated order regardless of
  // which field the API ships with.
  const mediaItems: MediaItem[] = Array.isArray(data.media)
    ? [...data.media]
        .filter((m) => m && typeof m.image_data === 'string' && m.image_data.length > 0)
        .sort((a, b) => {
          const ao = a.sort_order ?? a.position ?? 0;
          const bo = b.sort_order ?? b.position ?? 0;
          return ao - bo;
        })
    : [];
  // Branch on internal_status — event.status now carries the external
  // contract enum ('active' | 'archived' | 'sold-out'). Fall back to the
  // mapped 'archived' so this still 404s if the API response predates the
  // internal_status field.
  const closed = event
    ? (event.internal_status ?? '') === 'closed' ||
      (!event.internal_status && event.status === 'archived')
    : false;
  if (!event || closed) return notFound();

  const dateLabel = formatEventDate(event.event_date);
  const imageSrc = normalizeImageSrc(event.image_data);

  const waText = `Hi, I'd like to book for ${event.name} on ${dateLabel}. — sent via wallet.akanhyd.com`;
  const waUrl = `https://wa.me/${digitsOnly(venuePhone)}?text=${encodeURIComponent(waText)}`;
  const telUrl = `tel:${venuePhone}`;

  return (
    <>
      <EventAnalyticsTracker
        eventId={event.id}
        eventSlug={event.slug}
        activePhaseId={activePhase?.id ?? null}
      />
      {pixelId && (
        <MetaPixel
          pixelId={pixelId}
          events={[
            { name: 'PageView' },
            {
              name: 'ViewContent',
              data: {
                content_name: event.name,
                content_type: 'event',
                value: 0,
                currency: 'INR',
              },
            },
          ]}
        />
      )}

      <main className="min-h-screen bg-[var(--bg-app)]">
        {/* Brand header */}
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-2xl px-4 py-3 flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-6 w-6 rounded-full bg-brand-500"
            />
            <span className="font-semibold text-slate-900 truncate">
              {venueName}
            </span>
          </div>
        </header>

        <div className="mx-auto max-w-2xl px-4 py-6">
          {/* Hero image */}
          {imageSrc && (
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageSrc}
                alt={event.name}
                className="w-full h-auto object-cover"
                loading="eager"
              />
            </div>
          )}

          {/* Media gallery — horizontal scroll-snap carousel. Rendered only
              when the event has additional curated media. Each tile snaps to
              start; lazy-loaded so the hero stays the priority paint. */}
          {mediaItems.length > 0 && (
            <section
              className="mt-4 -mx-4"
              aria-label={`Gallery for ${event.name}`}
            >
              <div className="overflow-x-auto snap-x snap-mandatory flex gap-3 px-4 pb-2">
                {mediaItems.map((m, idx) => {
                  const src = normalizeImageSrc(m.image_data);
                  if (!src) return null;
                  return (
                    <figure
                      key={m.id || `media-${idx}`}
                      className="shrink-0 w-64 snap-start"
                    >
                      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-card">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={src}
                          alt={m.caption || `${event.name} photo ${idx + 1}`}
                          className="w-64 h-40 object-cover"
                          loading="lazy"
                        />
                      </div>
                      {m.caption && (
                        <figcaption className="mt-1.5 text-xs text-slate-600 leading-snug line-clamp-2">
                          {m.caption}
                        </figcaption>
                      )}
                    </figure>
                  );
                })}
              </div>
            </section>
          )}

          {/* Title + date + genre */}
          <section className="mt-5">
            <h1 className="text-2xl md:text-3xl font-bold text-slate-900 leading-tight">
              {event.name}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <span className="font-medium text-brand-700">{dateLabel}</span>
              {event.start_time && (
                <>
                  <span aria-hidden>·</span>
                  <span>{event.start_time}</span>
                </>
              )}
              {event.genre && (
                <>
                  <span aria-hidden>·</span>
                  <span className="inline-block rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">
                    {event.genre}
                  </span>
                </>
              )}
            </div>
          </section>

          {/* Description — backend may pass HTML from the rich text editor */}
          {event.description && (
            <section
              className="rte-content mt-4 text-slate-700"
              dangerouslySetInnerHTML={{ __html: event.description }}
            />
          )}

          {/* CTAs */}
          <EventCTAs waUrl={waUrl} telUrl={telUrl} />

          {/* Phase 3: invite_link gate. When the event requires an invite
              link and no token was supplied via ?invite=, we hide the
              booking form entirely and show a soft-gate card. The form
              itself stays untouched so the public path (no access_mode)
              continues to render normally. */}
          {accessMode === 'invite_link' && !inviteToken ? (
            <section
              className="card mt-6 space-y-3"
              aria-label="This event requires an invite link"
            >
              <h2 className="text-lg font-bold text-slate-900">
                This event requires an invite link
              </h2>
              {inviteMessage ? (
                <p className="text-sm text-slate-700 whitespace-pre-wrap">
                  {inviteMessage}
                </p>
              ) : (
                <p className="text-sm text-slate-700">
                  Bookings for this event are by invitation only. Please open
                  the personalised link you received from the host — it ends
                  with{' '}
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">
                    ?invite=…
                  </code>
                  .
                </p>
              )}
              <p className="text-xs text-slate-500">
                If you believe you should have access, please contact the host
                via WhatsApp using the button above.
              </p>
            </section>
          ) : (
            <>
              {/* Phone-list mode: render the form, but add a soft notice so
                  the customer knows their number must be on the guest list
                  before they submit. The server enforces this. */}
              {accessMode === 'phone_list' && (
                <div
                  role="note"
                  className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
                >
                  <div className="font-semibold">Invite-only event</div>
                  <div className="mt-0.5">
                    {inviteMessage ||
                      'Your phone number must be on the guest list to complete this booking.'}
                  </div>
                </div>
              )}

              {/* Booking form */}
              <PublicBookingForm
                eventSlug={event.slug}
                eventName={event.name}
                eventDate={dateLabel}
                eventId={event.id}
                paymentMode={paymentMode}
                paymentAmount={paymentAmount}
                accessMode={accessMode}
                inviteToken={inviteToken || null}
                slots={slots}
                rsvpFields={rsvpFields}
                seatingLayoutEnabled={seatingLayoutEnabled}
                seatingLayoutSvg={seatingLayoutSvg}
                zones={zones}
                paymentGatewayFeePayer={paymentGatewayFeePayer}
                platformFeePayer={platformFeePayer}
                gstEnabled={gstEnabled}
                paymentGatewayFeePct={paymentGatewayFeePct}
                platformFeePct={platformFeePct}
                gstPercent={gstPercent}
                discountPercent={discountPercent}
                activePhase={activePhase}
                phasePrices={phasePrices}
                nextPhasePreview={nextPhasePreview}
                coverRates={coverRates}
                entryFeePerPerson={entryFeePerPerson}
              />
            </>
          )}

          <footer className="mt-10 mb-6 text-center text-xs text-slate-400">
            Powered by Akan EventCover
          </footer>
        </div>
      </main>
    </>
  );
}
