/**
 * Tier 1 — FREE RESERVATION confirmation over WhatsApp. TEXT ONLY.
 *
 * A free reservation carries nothing that needs protecting: no paid entry to
 * prove at the door, no bar credit to redeem. So there is deliberately NO
 * attachment and NO QR here — sending a pass would imply an entitlement the
 * guest hasn't bought, and door staff would start scanning codes that grant
 * nothing. The guest gets their name, the event, and a booking ref to quote.
 *
 * Template the venue must approve in Interakt + Meta:
 *   Name (default):  akan_reservation_confirm      (RESERVATION_CONFIRM_TEMPLATE)
 *   Language:        en                            (RESERVATION_CONFIRM_LANG)
 *   Header:          NONE  ← must have no header at all
 *   Body:            3 variables — {{1}} guest name, {{2}} event, {{3}} ref
 *   No buttons.
 *
 * Because this template has no header we pass no headerValues; Interakt then
 * receives `headerValues: []`, which is what a header-less template expects.
 *
 * Never throws. The reservation must be created whether or not WhatsApp is
 * reachable, so every failure path returns {ok:false} with a reason.
 */

import { getConfig } from '@/lib/db';
import { getReservation } from '@/lib/reservations';
import { getReservationSummary } from '@/lib/reservation-ledger';
import { sendInteraktTemplate, splitPhone, isInteraktConfigured } from '@/lib/providers/whatsapp/interakt';
import { logAudit } from '@/lib/audit';

export interface SendReservationConfirmResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** Set when the send was deliberately skipped rather than attempted. */
  skipped?:
    | 'auto_send_off'
    | 'interakt_not_configured'
    | 'reservation_not_found'
    | 'reservation_cancelled'
    | 'no_phone';
}

export interface SendReservationConfirmInput {
  /** reservations.id */
  reservationId: string;
  /** Who triggered this (for audit). */
  actor: string;
  /**
   * Bypass the AUTO_SEND_RESERVATION_CONFIRM gate. For the manual "Resend"
   * button — a human clicking send has already made the decision the config
   * flag exists to make.
   */
  force?: boolean;
}

/** Mask for audit: keep country code + last 4, star the rest. Same shape as wallet-pass-send. */
function maskPhone(countryCode: string, phoneNumber: string): string {
  return `${countryCode}${phoneNumber.slice(-4).padStart(phoneNumber.length, '*')}`;
}

export async function sendReservationConfirmWhatsApp(
  input: SendReservationConfirmInput,
): Promise<SendReservationConfirmResult> {
  const actor = input.actor || 'system';

  if (!input.force) {
    const auto = getConfig('AUTO_SEND_RESERVATION_CONFIRM', '0').trim();
    if (auto !== '1' && auto.toLowerCase() !== 'true') {
      return { ok: false, skipped: 'auto_send_off', error: 'Auto-send reservation confirmations is off.' };
    }
  }

  // Checked before any DB work so an unconfigured venue never pays for the
  // lookups — and so this returns the same way whether or not the row exists.
  if (!isInteraktConfigured()) {
    return { ok: false, skipped: 'interakt_not_configured', error: 'Interakt not configured.' };
  }

  const reservation = getReservation(input.reservationId);
  if (!reservation) {
    return { ok: false, skipped: 'reservation_not_found', error: 'Reservation not found.' };
  }
  // `status` is the booking lifecycle (pending→converted/no_show/cancelled),
  // NOT the on-the-night ledger status. Cancelled means the guest has no
  // booking — confirming it would be actively wrong.
  if (reservation.status === 'cancelled') {
    return { ok: false, skipped: 'reservation_cancelled', error: 'Reservation is cancelled.' };
  }
  if (!reservation.phone || !reservation.phone.trim()) {
    return { ok: false, skipped: 'no_phone', error: 'Reservation has no phone number.' };
  }

  // The summary is the single source of the "RES-XXXX" derivation (its
  // buildDisplayCode). Deriving a second short code here would eventually
  // drift from what the confirmation screen and the cashier card display,
  // and a guest quoting a ref the venue can't find is a support call.
  const summary = getReservationSummary(input.reservationId);
  const bookingRef = summary?.display_code || input.reservationId;

  // Event name ladder: the joined event → the venue-wide default → a neutral
  // phrase. Never blank: Meta rejects empty template variables.
  const eventName =
    (summary?.event_name || '').trim() ||
    getConfig('EVENT_NAME', '').trim() ||
    'your booking';

  const guestName = (reservation.name || '').trim() || 'Guest';

  const { countryCode, phoneNumber } = splitPhone(reservation.phone);
  const templateName =
    getConfig('RESERVATION_CONFIRM_TEMPLATE', 'akan_reservation_confirm').trim() || 'akan_reservation_confirm';
  const languageCode = getConfig('RESERVATION_CONFIRM_LANG', 'en').trim() || 'en';

  const result = await sendInteraktTemplate({
    countryCode,
    phoneNumber,
    templateName,
    languageCode,
    // No headerValues — tier 1 is text-only by design. See the file header.
    bodyValues: [guestName, eventName, bookingRef],
    callbackData: `reservation_confirm:${input.reservationId}`,
  });

  logAudit({
    actor,
    action: result.ok ? 'reservation_confirm_whatsapp_sent' : 'reservation_confirm_whatsapp_failed',
    entityType: 'reservation',
    entityId: input.reservationId,
    details: {
      template: templateName,
      language: languageCode,
      to: maskPhone(countryCode, phoneNumber),
      booking_ref: bookingRef,
      message_id: result.messageId ?? null,
      error: result.error ?? null,
      status: result.status ?? null,
    },
  });

  return { ok: result.ok, messageId: result.messageId, error: result.error };
}
