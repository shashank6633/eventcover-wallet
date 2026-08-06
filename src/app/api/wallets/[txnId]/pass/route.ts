import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { lookupWallet } from '@/lib/wallet';
import { generatePassPdf } from '@/lib/pdf/pass';
import { getConfig } from '@/lib/db';
import { getEvent } from '@/lib/events';
import { logAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Generate the A6 pass PDF for a wallet — the staff-facing download, sibling
 * of the public token endpoint that WhatsApp pulls from.
 *
 * QR-ONLY, BY DESIGN. This used to demand a `qrCodeId` in the body because the
 * plaintext PIN was unrecoverable after issue, so the caller had to hand it
 * back. Two things changed:
 *   • The PDF's QR encodes the wallet txn_id, which this route already has
 *     from the path — nothing has to be supplied to draw a scannable pass.
 *   • Wallets now carry pin_enc, so a PIN *could* be recovered here. It
 *     deliberately is not. 'entry' can call this route, and door staff have no
 *     business seeing a PIN that gates bar credit; the PIN reaches the guest
 *     only in the WhatsApp message body. So this handler never reads, decrypts
 *     or logs one, and any `qrCodeId` still posted by an older client is
 *     ignored rather than parsed — an ignored field can't leak into an audit
 *     row or an error message.
 *
 * Access:
 *   • host / manager / entry — they're the ones who hand passes to guests
 *
 * Body: none required. (Legacy clients may still POST { qrCodeId }; ignored.)
 *
 * Returns: application/pdf binary stream
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ txnId: string }> }) {
  const session = await requireRole(['host', 'manager', 'entry']);
  if ('forbidden' in session) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status });
  }

  const { txnId } = await ctx.params;

  const wallet = lookupWallet(txnId);
  if (!wallet) {
    return NextResponse.json({ ok: false, message: 'Wallet not found.' }, { status: 404 });
  }

  // Only a live wallet gets a pass. This route used to check existence alone
  // and render, so a voided wallet — voidWallet() zeroes `balance` but never
  // touches `cover_issued` — still produced a clean A6 headed "COVER PASS /
  // Cover loaded INR 2,500" for credit the venue had already refunded in cash.
  // Both public endpoints already refuse the same wallet with a 410 ("handing
  // the guest a pass that will be rejected at the door is worse than a clear
  // error"), and 'entry' can call this route, so the person at the door was
  // the one able to produce the misleading document. 409 rather than 410
  // because this is the staff surface: the operator can act on it.
  if (wallet.status !== 'active') {
    const why = wallet.status === 'exhausted'
      ? 'it has been voided or fully spent'
      : wallet.status === 'expired'
        ? 'it has expired'
        : `it is ${wallet.status}`;
    return NextResponse.json(
      { ok: false, message: `No pass for ${txnId} — ${why}. Its QR will be rejected at the door.` },
      { status: 409 },
    );
  }

  // Resolve event name (per-wallet event_id wins; falls back to global config).
  // event_id was added as a wallet column in a later migration; the TS type
  // hasn't caught up, so read it off the raw row.
  let eventName = getConfig('EVENT_NAME', '') || undefined;
  const walletEventId = (wallet as unknown as { event_id?: string | null }).event_id;
  if (walletEventId) {
    try {
      const ev = getEvent(walletEventId);
      if (ev?.name) eventName = ev.name;
    } catch { /* event row missing — fall back to the global name */ }
  }

  const venueName = getConfig('VENUE_NAME', 'AKAN Hyderabad');
  const venueLogo = getConfig('VENUE_LOGO', '') || undefined;

  // Tier 3 (cover) vs tier 2 (entry-only) selects the pass label and the
  // footer wording. generatePassPdf derives the same thing from coverAmount,
  // but passing it explicitly keeps the tier decision readable at the caller.
  const hasCover = wallet.cover_issued > 0;

  const pdfBytes = await generatePassPdf({
    txnId,
    guestName: wallet.name || 'Guest',
    coverAmount: wallet.cover_issued,
    hasCover,
    eventName,
    venueName,
    venueLogo,
    expiresAt: wallet.expires_at,
  });

  logAudit({
    actor: session.name,
    action: 'pass_pdf_generated',
    entityType: 'wallet',
    entityId: txnId,
    details: {
      guest: wallet.name,
      cover: wallet.cover_issued,
      tier: hasCover ? 'cover' : 'entry',
      channel: 'download',
    },
  });

  // Match the public endpoint's naming so a guest's downloads folder reads
  // honestly — an entry-only ticket isn't a "cover pass".
  const safeId = txnId.replace(/[^A-Za-z0-9._-]/g, '') || 'pass';
  const fileName = hasCover ? `cover-pass-${safeId}.pdf` : `ticket-${safeId}.pdf`;

  return new NextResponse(Buffer.from(pdfBytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
