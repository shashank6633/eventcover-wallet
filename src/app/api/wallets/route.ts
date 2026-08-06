import { NextRequest, NextResponse } from 'next/server';
import { issueWallet, listWallets } from '@/lib/wallet';
import { formatExpiry } from '@/lib/expiry';
import { getSession } from '@/lib/auth';
import { sendWalletPassPdfWhatsApp } from '@/lib/whatsapp/wallet-pass-pdf-send';
import { getConfig } from '@/lib/db';
import QRCode from 'qrcode';
import type { PaymentMethod } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_METHODS: PaymentMethod[] = ['cash', 'upi', 'card', 'online', 'comp'];

/**
 * List recent wallets.
 *
 * Authenticated: this returns every guest's name, phone and email alongside
 * their balance. `src/middleware.ts` only guards the `/admin` shell
 * (`matcher: ['/admin/:path*']`), so an API route under `/api` gets no
 * protection from it and has to check the session itself — as POST below
 * already did.
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ ok: false, message: 'Not authenticated.' }, { status: 401 });
    }
    const wallets = listWallets();
    return NextResponse.json({ ok: true, wallets });
  } catch (err) {
    return NextResponse.json({ ok: false, message: errMsg(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ ok: false, message: 'Not authenticated.' }, { status: 401 });
    }
    if (!['host', 'manager', 'entry'].includes(session.role)) {
      return NextResponse.json({ ok: false, message: 'Your role cannot issue wallets.' }, { status: 403 });
    }

    const body = await req.json();
    const { name, phone, email, pax, entryFee, coverIssued, paymentMethod, tableId, eventId, reservationId } = body || {};

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ ok: false, message: 'Name is required.' }, { status: 400 });
    }
    if (!phone || typeof phone !== 'string') {
      return NextResponse.json({ ok: false, message: 'Phone is required.' }, { status: 400 });
    }
    // ─── Money fields ────────────────────────────────────────────────────
    // issueWallet's money() gate is the authority on range: it re-checks
    // finiteness + sign, quantises to paise and enforces the per-wallet cap.
    // These two checks exist for the things that gate can't do from in there:
    //   • `!(fee >= 0)` used to admit Infinity (that comparison is false only
    //     for NaN), and a lib throw surfaces as a 500 — a client's bad number
    //     is a 400 that names the field.
    //   • a NON-NUMERIC cover was silently swallowed. `coverIssued: "1,000"`
    //     (thousands separator, trailing space, a stray unit) failed the old
    //     isNaN test, became `undefined`, and issued a ₹0 wallet while the
    //     operator was told ₹1,000 of bar credit had been loaded. Absent means
    //     no cover; present-but-unparseable is an error, not zero.
    const fee = Number(entryFee);
    if (!Number.isFinite(fee) || fee < 0) {
      return NextResponse.json({ ok: false, message: 'Invalid entry fee.' }, { status: 400 });
    }
    let cover: number | undefined;
    if (coverIssued != null) {
      cover = Number(coverIssued);
      if (!Number.isFinite(cover) || cover < 0) {
        return NextResponse.json({ ok: false, message: 'Invalid cover amount.' }, { status: 400 });
      }
    }
    if (!VALID_METHODS.includes(paymentMethod)) {
      return NextResponse.json({ ok: false, message: 'Invalid payment method.' }, { status: 400 });
    }

    const result = await issueWallet({
      name: String(name).trim(),
      phone: String(phone).trim(),
      email: email ? String(email).trim() : undefined,
      pax: Number(pax) || 1,
      entryFee: fee,
      coverIssued: cover,
      paymentMethod,
      issuedBy: session.name,
      tableId: tableId ? String(tableId) : undefined,
      eventId: eventId ? String(eventId) : undefined,
      reservationId: reservationId ? String(reservationId) : undefined,
    });

    const origin = req.nextUrl.origin;
    const captainUrl = `${origin}/admin/redeem?t=${encodeURIComponent(result.txnId)}`;
    const qrDataUrl = await QRCode.toDataURL(captainUrl, { width: 360, margin: 2 });

    // Fire-and-forget WhatsApp send of the PDF pass (tiers 2 + 3). Never blocks
    // the door staff's response — they get their PIN + QR immediately, the
    // customer receives WhatsApp seconds later in parallel. Toggle gated by
    // config (AUTO_SEND_WHATSAPP_PASS = '1' to enable).
    //
    // The plaintext PIN exists in memory exactly once, right here, before
    // hashing — so it has to be handed down now or never. The sender uses it
    // only for a cover wallet (cover_issued > 0), where it goes in the message
    // TEXT and never onto the PDF that carries the QR; an entry-only wallet
    // has no balance to redeem, so the sender drops it. Passing it
    // unconditionally is safe and keeps this call site free of tier logic.
    let whatsappQueued = false;
    const autoSend = getConfig('AUTO_SEND_WHATSAPP_PASS', '0').trim();
    if (autoSend === '1' || autoSend.toLowerCase() === 'true') {
      whatsappQueued = true;
      sendWalletPassPdfWhatsApp({
        txnId: result.txnId,
        origin,
        actor: session.name,
        pin: result.pin,
      }).catch(() => { /* logged via audit; never block this request */ });
    }

    return NextResponse.json({
      ok: true,
      txnId: result.txnId,
      pin: result.pin,
      balance: result.balance,
      expiresAt: result.expiresAt,
      expiresAtLabel: formatExpiry(result.expiresAt),
      captainUrl,
      qrDataUrl,
      whatsappQueued,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, message: errMsg(err) }, { status: 500 });
  }
}

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : 'Server error';
}
