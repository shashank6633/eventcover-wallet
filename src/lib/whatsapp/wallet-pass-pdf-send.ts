/**
 * Tiers 2 + 3 — PAID wallet pass over WhatsApp as a PDF DOCUMENT.
 *
 * Tier 2, entry-only  (cover_issued === 0): PDF carries the QR. No PIN,
 *   because there is no balance to redeem — a PIN would be a secret that
 *   unlocks nothing, trained into guests for no reason.
 * Tier 3, cover issued (cover_issued  >  0): PDF carries the QR, and the PIN
 *   goes in the WhatsApp message TEXT — never onto the PDF. The PIN exists to
 *   stop a stolen QR screenshot from draining bar credit (see redemption.ts,
 *   verifyPin + 3-attempt lockout); printing it on the same artifact as the QR
 *   would defeat the whole point. Text placement also lets a captain take the
 *   PIN verbally without the guest opening a file at a dark bar.
 *
 * Templates the venue must approve in Interakt + Meta:
 *   Cover tier (default akan_cover_pass_pdf — WALLET_PASS_PDF_TEMPLATE)
 *     Header: DOCUMENT   Body: 4 vars — {{1}} name, {{2}} event,
 *                                       {{3}} cover amount, {{4}} PIN
 *   Entry-only tier (WALLET_PASS_PDF_TEMPLATE_ENTRY; falls back to the above)
 *     Header: DOCUMENT   Body: 2 vars — {{1}} name, {{2}} event
 *
 *   Meta approves templates by EXACT structure, so a 2-variable body and a
 *   4-variable body cannot be the same approved template. Leave
 *   WALLET_PASS_PDF_TEMPLATE_ENTRY blank only if the venue genuinely approved
 *   one template that both tiers fit.
 *
 * Never throws — the wallet must issue whether or not WhatsApp is reachable.
 */

import { getConfig } from '@/lib/db';
import { lookupWallet } from '@/lib/wallet';
import { getEvent } from '@/lib/events';
import { formatMoney } from '@/lib/format';
import { signWalletPassToken } from '@/lib/signed-url';
import { sendInteraktTemplate, splitPhone, isInteraktConfigured } from '@/lib/providers/whatsapp/interakt';
import { logAudit } from '@/lib/audit';

export interface SendWalletPassPdfResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** The public PDF URL handed to Interakt — useful for debug + audit. */
  pdfUrl?: string;
  /** Set when the send was deliberately skipped rather than attempted. */
  skipped?:
    | 'auto_send_off'
    | 'interakt_not_configured'
    | 'wallet_not_found'
    | 'wallet_voided'
    | 'no_phone'
    | 'bad_origin'
    | 'missing_pin'
    | 'entry_template_missing';
}

export interface SendWalletPassPdfInput {
  /** wallets.txn_id */
  txnId: string;
  /** Origin base URL (e.g. "https://wallet.akanhyd.com"). Can't be introspected
   *  from a fire-and-forget helper, so the request handler must pass it. */
  origin: string;
  /** Who triggered this (for audit). */
  actor: string;
  /**
   * The plaintext PIN, for cover wallets only. It exists in memory exactly
   * once — at issue time, before hashing — so the caller has to hand it down.
   * NEVER persisted or logged by this module.
   */
  pin?: string;
  /** Bypass the AUTO_SEND_WHATSAPP_PASS gate (manual "Resend" button). */
  force?: boolean;
}

/** Mask for audit: keep country code + last 4, star the rest. Same shape as wallet-pass-send. */
function maskPhone(countryCode: string, phoneNumber: string): string {
  return `${countryCode}${phoneNumber.slice(-4).padStart(phoneNumber.length, '*')}`;
}

/**
 * WhatsApp shows fileName verbatim as the attachment caption; strip anything
 * that isn't filename-safe.
 *
 * Named by TIER, mirroring both HTTP routes (public wallet-pass-pdf and admin
 * wallets/[txnId]/pass, which each pick `ticket-…` when cover_issued is 0).
 * A comp guest whose pass says "ENTRY PASS / No bar credit" must not receive it
 * captioned "cover-pass-…": that caption promises exactly what the document
 * denies, and the caption is the part the guest reads first.
 */
function safeFileName(txnId: string, hasCover: boolean): string {
  const slug = String(txnId || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40) || 'pass';
  return `${hasCover ? 'cover-pass' : 'ticket'}-${slug}.pdf`;
}

/**
 * Reduce a caller-supplied base URL to a bare `scheme://host[:port]`.
 *
 * Returns null for anything that isn't a parseable http(s) URL. The result is
 * concatenated with a live bearer token (see the pdfUrl comment below), so a
 * junk or non-http value must stop the send rather than be shipped to Interakt.
 * Normalising through URL.origin also drops any path, query or fragment an
 * injected value could smuggle in.
 */
function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Record a send we deliberately did NOT attempt.
 *
 * A skip is an operational fact, not a non-event. Five of these paths used to
 * return in silence — no audit row, no log line — while the caller had already
 * told the customer a pass was coming, so nothing in the system distinguished
 * "never attempted" from "attempted and bounced". With AUTO_SEND_WHATSAPP_PASS
 * off (its live value) that silence covered every send. The two failure paths
 * below already audit; this makes the skips match.
 */
function logSkip(
  actor: string,
  txnId: string,
  reason: NonNullable<SendWalletPassPdfResult['skipped']>,
  extra: Record<string, unknown> = {},
): void {
  logAudit({
    actor,
    action: 'wallet_pass_pdf_whatsapp_skipped',
    entityType: 'wallet',
    entityId: txnId,
    details: { reason, ...extra },
  });
}

export async function sendWalletPassPdfWhatsApp(
  input: SendWalletPassPdfInput,
): Promise<SendWalletPassPdfResult> {
  const actor = input.actor || 'system';

  if (!input.force) {
    const auto = getConfig('AUTO_SEND_WHATSAPP_PASS', '0').trim();
    if (auto !== '1' && auto.toLowerCase() !== 'true') {
      logSkip(actor, input.txnId, 'auto_send_off');
      return { ok: false, skipped: 'auto_send_off', error: 'Auto-send WhatsApp pass is off.' };
    }
  }

  if (!isInteraktConfigured()) {
    logSkip(actor, input.txnId, 'interakt_not_configured');
    return { ok: false, skipped: 'interakt_not_configured', error: 'Interakt not configured.' };
  }

  const wallet = lookupWallet(input.txnId);
  if (!wallet) {
    logSkip(actor, input.txnId, 'wallet_not_found');
    return { ok: false, skipped: 'wallet_not_found', error: 'Wallet not found.' };
  }
  if (wallet.status === 'exhausted') {
    logSkip(actor, input.txnId, 'wallet_voided', { status: wallet.status });
    return { ok: false, skipped: 'wallet_voided', error: 'Wallet is voided/exhausted.' };
  }
  if (!wallet.phone || !wallet.phone.trim()) {
    logSkip(actor, input.txnId, 'no_phone');
    return { ok: false, skipped: 'no_phone', error: 'Wallet has no phone number.' };
  }

  const coverIssued = Number(wallet.cover_issued ?? 0);
  const hasCover = coverIssued > 0;

  // Fail LOUD and early when a cover wallet arrives without its PIN. Sending a
  // 4-variable template with 3 values is accepted by Interakt's request schema
  // and then silently dropped by Meta at render time — an undeliverable message
  // with a 200 OK, which is close to impossible to diagnose weeks later.
  // Inventing a PIN is worse: it wouldn't match pin_hash, so redemption fails
  // at the bar and burns the 3-attempt lockout.
  if (hasCover && !(input.pin && input.pin.trim())) {
    logAudit({
      actor,
      action: 'wallet_pass_pdf_whatsapp_failed',
      entityType: 'wallet',
      entityId: input.txnId,
      details: {
        reason: 'missing_pin_for_cover_wallet',
        tier: 'cover',
        // Amount, not the PIN. There is no PIN to redact here — that's the bug.
        cover_issued: coverIssued,
      },
    });
    return {
      ok: false,
      skipped: 'missing_pin',
      error: 'Cover wallet requires the plaintext PIN to send the pass; caller supplied none.',
    };
  }

  // Event name ladder — mirrors wallet-pass-send so both channels say the same
  // thing about the same wallet. Never blank: Meta rejects empty variables.
  let eventName = 'tonight';
  const walletEventId = (wallet as unknown as { event_id?: string | null }).event_id;
  if (walletEventId) {
    try {
      const ev = getEvent(walletEventId);
      if (ev?.name) eventName = ev.name;
    } catch { /* event row may be gone; the fallback is fine */ }
  } else {
    const cfg = getConfig('EVENT_NAME', '').trim();
    if (cfg) eventName = cfg;
  }

  // Signed, expiring URL: Interakt's fetcher has no session cookie, and the
  // PDF contains the entry QR so it can't be world-readable.
  //
  // The token is a real 30-day bearer credential for this guest's door QR, and
  // it is valid no matter which host it is glued to — so validate the origin
  // BEFORE minting one, and never mint a credential for a URL we won't send.
  // CALLER CONTRACT: `origin` must be SERVER-DERIVED (req.nextUrl.origin or a
  // configured base URL), never a request header. All three call sites do that
  // now; payments/verify used to read the client's Origin header, which handed
  // a live token to whatever host the caller named.
  const origin = normalizeOrigin(input.origin);
  if (!origin) {
    logSkip(actor, input.txnId, 'bad_origin', { origin_raw_length: String(input.origin || '').length });
    return {
      ok: false,
      skipped: 'bad_origin',
      error: 'Caller supplied an origin that is not a valid http(s) URL; refusing to mint a pass token for it.',
    };
  }
  const token = signWalletPassToken({ txnId: input.txnId });
  const pdfUrl = `${origin}/api/public/wallet-pass-pdf/${token}`;

  const { countryCode, phoneNumber } = splitPhone(wallet.phone);

  // Two approved templates, because the tiers carry different variable counts:
  // cover = 4 ({{1}} name, {{2}} event, {{3}} amount, {{4}} PIN), entry = 2.
  const coverTemplate =
    getConfig('WALLET_PASS_PDF_TEMPLATE', 'akan_cover_pass_pdf').trim() || 'akan_cover_pass_pdf';
  const entryTemplate = getConfig('WALLET_PASS_PDF_TEMPLATE_ENTRY', '').trim();
  const languageCode = getConfig('WALLET_PASS_PDF_LANG', 'en').trim() || 'en';

  // Entry tier with no template of its own must NOT borrow the cover one.
  // This is the same failure the PIN guard above exists to prevent, from the
  // other direction: a 4-variable template sent with 2 values passes
  // Interakt's request schema, returns 200 OK, and is then dropped silently
  // by Meta at render time. Falling back would make every comp and every
  // zero-cover ticket undeliverable-but-successful-looking, which is far
  // worse to diagnose than refusing here with a named reason.
  if (!hasCover && !entryTemplate) {
    logAudit({
      actor,
      action: 'wallet_pass_pdf_whatsapp_failed',
      entityType: 'wallet',
      entityId: input.txnId,
      details: {
        reason: 'entry_template_not_configured',
        tier: 'entry_only',
        cover_template: coverTemplate,
      },
    });
    return {
      ok: false,
      skipped: 'entry_template_missing',
      error:
        'Entry-only wallet needs its own 2-variable template. Set WALLET_PASS_PDF_TEMPLATE_ENTRY ' +
        'to an approved template name; the 4-variable cover template cannot be reused.',
    };
  }

  const templateName = hasCover ? coverTemplate : entryTemplate;

  const guestName = (wallet.name || '').trim() || 'Guest';
  const bodyValues = hasCover
    ? [guestName, eventName, formatMoney(coverIssued), (input.pin as string).trim()]
    : [guestName, eventName];

  const result = await sendInteraktTemplate({
    countryCode,
    phoneNumber,
    templateName,
    languageCode,
    headerValues: [pdfUrl],
    fileName: safeFileName(input.txnId, hasCover),
    bodyValues,
    callbackData: `wallet_pass_pdf:${input.txnId}`,
  });

  logAudit({
    actor,
    action: result.ok ? 'wallet_pass_pdf_whatsapp_sent' : 'wallet_pass_pdf_whatsapp_failed',
    entityType: 'wallet',
    entityId: input.txnId,
    details: {
      template: templateName,
      language: languageCode,
      tier: hasCover ? 'cover' : 'entry_only',
      to: maskPhone(countryCode, phoneNumber),
      cover_issued: coverIssued,
      // Presence only — the PIN itself never reaches the audit log.
      pin_included: hasCover,
      message_id: result.messageId ?? null,
      error: result.error ?? null,
      status: result.status ?? null,
      // Host only. The full URL embeds the signed token; logging it would make
      // the audit table a bearer-credential store.
      pdf_url_host: new URL(pdfUrl).host,
    },
  });

  return {
    ok: result.ok,
    messageId: result.messageId,
    error: result.error,
    pdfUrl,
  };
}
