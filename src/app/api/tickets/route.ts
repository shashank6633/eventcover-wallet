import { NextRequest, NextResponse } from 'next/server';
import {
  listTicketsForEvent,
  createTicket,
  getTicket,
  attachWalletToTicket,
  type TicketCategory,
  type Gender,
} from '@/lib/tickets';
import { attributeTicket } from '@/lib/affiliates';
import { requireRole } from '@/lib/auth';
import { getEvent } from '@/lib/events';
import { issueWallet } from '@/lib/wallet';
import { getConfig } from '@/lib/db';
import { sendWalletPassPdfWhatsApp } from '@/lib/whatsapp/wallet-pass-pdf-send';
import { logAudit } from '@/lib/audit';
import {
  getEffectivePixelId,
  getCapiAccessToken,
  getTestEventCode,
  hashSha256Lowercase,
  normalizePhoneForCapi,
  sendCapiEventAudited,
} from '@/lib/meta-pixel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await requireRole(['host', 'manager', 'entry']);
  if ('forbidden' in session) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status });
  }
  const eventId = req.nextUrl.searchParams.get('eventId') || '';
  if (!eventId) {
    return NextResponse.json({ ok: false, message: 'eventId is required.' }, { status: 400 });
  }
  return NextResponse.json({ ok: true, tickets: listTicketsForEvent(eventId) });
}

export async function POST(req: NextRequest) {
  const session = await requireRole(['host', 'manager', 'entry']);
  if ('forbidden' in session) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status });
  }

  const body = await req.json().catch(() => ({}));
  // Optional M/F/C breakdown — the offline form now ships these alongside
  // pax + price. We still trust the caller's pax total (no rate-card recompute
  // here) but normalize the counts so the ticket row carries clean
  // non-negative ints. Missing keys default to 0. The money fields are NOT
  // taken on trust — see the reconciliation block below.
  const mix = (body.genderMix ?? {}) as { male?: unknown; female?: unknown; couple?: unknown };
  const nn = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };

  // ─── Money reconciliation: price MUST equal entry + cover ─────────────────
  // price, entryAmount and coverAmount arrive as three INDEPENDENT body fields
  // and land in three independent columns, but they are not independent
  // quantities: tickets.price is what the revenue roll-up and the affiliate
  // saleAmount below are computed from, while cover_amount becomes the guest's
  // spendable wallet balance a few lines further down. Nothing downstream ever
  // compares them, so a caller that sends {price: 100, entryAmount: 1000,
  // coverAmount: 1000} books ₹100 of revenue against ₹1,000 of bar liability
  // and every report still balances. The admin form derives price from the
  // split (/admin/tickets:241 `priceN = entryN + coverN`) so it can never trip
  // this — but "the client does it right" is not an invariant, and this route
  // is reachable by the akan-events-app proxy and any stale mobile build.
  //
  // Tolerance is half a paisa: the form sends price as the literal sum of the
  // same two doubles, so an honest client is exact and only a real mismatch
  // (or float noise from a hand-built payload) can exceed it.
  const priceN = Number(body.price ?? 0);
  const entryN = Number(body.entryAmount ?? 0);
  const coverN = Number(body.coverAmount ?? 0);
  if (!Number.isFinite(entryN) || entryN < 0) {
    return NextResponse.json({ ok: false, message: 'Entry amount must be a number ≥ 0.' }, { status: 400 });
  }
  if (!Number.isFinite(coverN) || coverN < 0) {
    return NextResponse.json({ ok: false, message: 'Cover amount must be a number ≥ 0.' }, { status: 400 });
  }
  // split === 0 is the legacy single-price contract (no split columns sent):
  // the whole price is treated as cover downstream. Left working as-is.
  const split = entryN + coverN;
  if (split > 0 && Math.abs(split - priceN) > 0.005) {
    return NextResponse.json({
      ok: false,
      message: `Entry ₹${entryN} + cover ₹${coverN} must equal price ₹${priceN}.`,
    }, { status: 400 });
  }

  try {
    const ticket = createTicket({
      eventId: String(body.eventId || ''),
      customerName: String(body.customerName || ''),
      customerPhone: String(body.customerPhone || ''),
      customerGender: (body.customerGender || null) as Gender | null,
      customerNotes: body.customerNotes ?? null,
      ticketName: String(body.ticketName || ''),
      category: body.category as TicketCategory,
      pax: Number(body.pax ?? 1),
      ticketNotes: body.ticketNotes ?? null,
      internalNotes: body.internalNotes ?? null,
      price: priceN,
      paidOffline: !!body.paidOffline,
      complimentary: !!body.complimentary,
      createdBy: session.name,
      maleCount: nn(mix.male),
      femaleCount: nn(mix.female),
      coupleCount: nn(mix.couple),
      // Optional entry/cover split. When omitted, columns default to 0 +
      // the wallet treats the whole price as cover (legacy single-price
      // semantics). When supplied, entry + cover === price is enforced by
      // the reconciliation block above — server-side, not client-side.
      entryAmount: entryN,
      coverAmount: coverN,
    });

    // ─── Affiliate attribution (best-effort) ──────────────────────────────
    // Source priority for the code:
    //   1. Explicit `affiliateCode` in the request body — set by the future
    //      public booking flow.
    //   2. `ec_ref` cookie — set by RefCapture when a customer visits any
    //      page with ?ref=CODE or ?t=CODE. The latter is the per-event
    //      Tracking Link form surfaced by the Promote tab. Both URL forms
    //      resolve to the same cookie/affiliate-row lookup — the kind of
    //      link is determined by affiliate.kind on the resolved row.
    // attributeTicket() handles both kinds: kind='commission' opens an
    // affiliate_commissions row and stamps tickets.commission_status=
    // 'pending'; kind='tracking' (commission_value=0) only stamps
    // tickets.affiliate_id / affiliate_code with commission_status='none',
    // so the per-event Promote page can count clicks→sales without
    // polluting the payouts pipeline.
    // Never throws — failed attribution must not block ticket creation.
    const explicit = typeof body.affiliateCode === 'string' ? body.affiliateCode.trim() : '';
    const cookieRef = req.cookies.get('ec_ref')?.value || '';
    const affCode = explicit || cookieRef;
    let finalTicket = ticket;
    if (affCode && !ticket.complimentary && ticket.price > 0) {
      attributeTicket({
        ticketId: ticket.id,
        affiliateCode: affCode,
        eventId: ticket.event_id,
        saleAmount: ticket.price,
        pax: ticket.pax,
      });
      finalTicket = getTicket(ticket.id) ?? ticket;
    }

    // ─── Auto-issue wallet pass + WhatsApp the QR ─────────────────────────
    // Every offline ticket gets a wallet so the guest can show their QR at
    // the door. The semantic split for what that wallet contains:
    //
    //   ticket.price > 0  → cover-bearing pass
    //                       entryFee = 0, coverIssued = price
    //                       Whole ticket amount is redeemable at the bar.
    //                       Wallet balance = price.
    //
    //   ticket.price = 0  → entry-only pass (comps OR free events)
    //                       entryFee = 0, coverIssued = 0
    //                       QR works for door verification, but there's
    //                       nothing to redeem. Bouncer sees ₹0 balance.
    //
    // Note we set entryFee = 0 in BOTH cases. The historical entryFee
    // field on the wallet row represents a sunk (non-redeemable) door
    // charge — we don't have that concept in the offline-tickets flow.
    // The whole ticket price is treated as cover.
    //
    // Failures here MUST NOT roll the ticket back — the operator's intent
    // ("ticket sold") is already captured. If wallet issuance fails (e.g.
    // event has no event_date, EVENT_DATE config missing), the audit row
    // surfaces the reason and the operator can manually issue via
    // /admin/issue. Same fire-and-forget pattern as POST /api/wallets.
    let walletInfo: {
      txnId: string;
      pin: string;
      balance: number;
      expiresAt: number;
      whatsappQueued: boolean;
      kind: 'cover' | 'entry_only';
    } | null = null;
    // Honest entry/cover split into the wallet:
    //   - If the ticket carries the split columns (new model), pass them
    //     through faithfully → wallet.entryFee + wallet.coverIssued audit
    //     "venue collected ₹X entry, ₹Y is redeemable at the bar".
    //   - If the ticket only carries `price` (legacy single-price callers),
    //     fall back to treating the whole amount as cover so old behavior
    //     stays intact.
    const ticketEntry = Number(ticket.entry_amount ?? 0);
    const ticketCover = Number(ticket.cover_amount ?? 0);
    const hasSplit = ticketEntry > 0 || ticketCover > 0;
    try {
      const result = await issueWallet({
        name: ticket.customer_name,
        phone: ticket.customer_phone,
        pax: ticket.pax,
        entryFee: hasSplit ? ticketEntry : 0,
        coverIssued: hasSplit ? ticketCover : (ticket.price > 0 ? ticket.price : 0),
        // PaymentMethod enum is { cash, upi, card, online, comp }. The offline
        // form doesn't yet collect WHICH method (cash vs UPI vs card), so we
        // default paid-offline to 'cash' — the most common door payment. Comps
        // (and ₹0 entry-only passes) map to 'comp'.
        paymentMethod: ticket.complimentary || ticket.price === 0 ? 'comp' : 'cash',
        issuedBy: session.name,
        eventId: ticket.event_id,
      });
      attachWalletToTicket(ticket.id, result.txnId);
      finalTicket = getTicket(ticket.id) ?? finalTicket;

      // Fire WhatsApp send if the global toggle is on. Same gating as the
      // /admin/issue door flow — host can flip AUTO_SEND_WHATSAPP_PASS to '0'
      // to suppress (useful for comp guest lists where you don't want
      // bulk WhatsApps going out).
      let whatsappQueued = false;
      const autoSend = getConfig('AUTO_SEND_WHATSAPP_PASS', '0').trim();
      if (autoSend === '1' || autoSend.toLowerCase() === 'true') {
        whatsappQueued = true;
        const origin = req.nextUrl.origin;
        // Fire-and-forget: never block the API response on Interakt latency.
        // Errors are logged via the audit row inside sendWalletPassPdfWhatsApp.
        //
        // result.pin is the plaintext PIN — available only here, before
        // hashing. The sender puts it in the message TEXT for a cover wallet
        // (this block's ticketCover > 0 case) and ignores it for an entry-only
        // pass, which has no balance to redeem. It never reaches the PDF that
        // carries the QR, so a stolen screenshot can't drain bar credit.
        sendWalletPassPdfWhatsApp({
          txnId: result.txnId,
          origin,
          actor: session.name,
          pin: result.pin,
        }).catch(() => { /* never block ticket create */ });
      }

      walletInfo = {
        txnId: result.txnId,
        pin: result.pin,
        balance: result.balance,
        expiresAt: result.expiresAt,
        whatsappQueued,
        // 'cover' when the wallet carries redeemable balance; 'entry_only'
        // when ticket.price was 0 (comps + free events). Drives the admin
        // flash copy ("Cover ₹500 sent" vs "Entry pass sent") so the host
        // confirms the right thing was issued.
        // 'cover' = QR carries redeemable balance. With the entry/cover split
        // this is true iff coverIssued > 0 — an entry-only ticket (entry=X,
        // cover=0) gets the 'entry_only' label so the admin flash reads
        // honestly. Legacy single-price tickets fall back to checking price.
        kind: (hasSplit ? ticketCover > 0 : ticket.price > 0) ? 'cover' : 'entry_only',
      };
    } catch (err) {
      // Surface the audit row but don't fail the request — the ticket is
      // saved and the operator can issue the wallet manually if needed.
      logAudit({
        actor: session.name,
        action: 'offline_ticket_auto_wallet_failed',
        entityType: 'ticket',
        entityId: ticket.id,
        details: {
          message: err instanceof Error ? err.message : 'Failed to auto-issue wallet.',
          event_id: ticket.event_id,
          phone: ticket.customer_phone,
        },
      });
    }

    // ─── Meta CAPI Purchase ───────────────────────────────────────────────
    // Deliberately NOT gated on the _fbp/_fbc cookies any more. That gate was
    // backwards: the Conversions API exists to report conversions the browser
    // Pixel CANNOT — ad blockers, Safari ITP, and this very endpoint, which is
    // the staff-facing door-issuing screen where a staff browser has no
    // Facebook cookies at all. Requiring a cookie meant the sales least likely
    // to be tracked client-side were also skipped server-side, so they were
    // lost twice. The cookies are still forwarded when present because they
    // sharpen attribution; their absence just costs match quality, not the
    // event.
    //
    // Still correctly skipped: comps and ₹0 tickets. Those are not purchases,
    // and reporting them as Purchase with value 0 would drag down the ROAS
    // Meta optimises against.
    if (!ticket.complimentary && ticket.price > 0) {
      const accessToken = getCapiAccessToken();
      if (accessToken) {
        const event = getEvent(ticket.event_id);
        const pixelId = getEffectivePixelId(event?.meta_pixel_id);
        if (pixelId) {
          const fwd = req.headers.get('x-forwarded-for') || '';
          const clientIp = fwd.split(',')[0]?.trim() || req.headers.get('x-real-ip') || undefined;
          const userAgent = req.headers.get('user-agent') || undefined;
          const digits = normalizePhoneForCapi(ticket.customer_phone || '');

          sendCapiEventAudited(
            {
              pixelId,
              accessToken,
              eventName: 'Purchase',
              eventId: ticket.id,  // matches browser-side eventID for dedup
              actionSource: 'website',
              testEventCode: getTestEventCode() || undefined,
              userData: {
                // Hashing '' produces a valid SHA-256 that matches no human and
                // makes Meta score the payload as low quality — send nothing
                // rather than a guaranteed non-match.
                ph: digits ? [hashSha256Lowercase(digits)] : undefined,
                fbp: req.cookies.get('_fbp')?.value || undefined,
                fbc: req.cookies.get('_fbc')?.value || undefined,
                client_ip_address: clientIp,
                client_user_agent: userAgent,
              },
              customData: {
                value: ticket.price,
                currency: 'INR',
                content_name: event?.name || ticket.ticket_name,
                content_ids: [ticket.id],
                num_items: ticket.pax,
              },
            },
            {
              actor: session.name,
              entityType: 'ticket',
              entityId: ticket.id,
              eventName: 'Purchase',
              eventId: ticket.id,
              pixelId,
              value: ticket.price,
            },
          );
        }
      }
    }

    return NextResponse.json({
      ok: true,
      ticket: finalTicket,
      // wallet is null when auto-issue failed (audited but non-fatal) OR
      // wasn't attempted. Admin form uses this to render the "✓ Pass sent"
      // flash with the QR Code ID + WhatsApp delivery status.
      wallet: walletInfo,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create ticket.';
    return NextResponse.json({ ok: false, message: msg }, { status: 400 });
  }
}
