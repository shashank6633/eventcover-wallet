import { NextRequest, NextResponse } from 'next/server';
import { verifyWalletPassToken } from '@/lib/signed-url';
import { lookupWallet } from '@/lib/wallet';
import { generatePassPdf } from '@/lib/pdf/pass';
import { getConfig, getDb } from '@/lib/db';
import { getEvent } from '@/lib/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ─── Per-token rate limit ──────────────────────────────────────────────────
// Local to this file, like the limiter in /api/public/wallet/[token] — the
// symbols are deliberately not shared so tuning one surface can't throttle
// another.
//
// Keyed by TXN ID, not by IP, and that is the important part: the WhatsApp
// pass is fetched server-side by Interakt's media fetcher, so on a busy door
// every pass in the venue arrives from the same handful of egress IPs. An
// IP bucket would throttle the venue's own delivery pipeline on exactly the
// night it matters. The threat here is a single leaked 30-day token being
// looped (a forwarded WhatsApp link landing in a group chat with preview
// bots), and each wallet has its own token, so a per-token bucket contains
// that without ever penalising a busy night.
//
// Each hit costs a QR encode + a sharp rasterisation + pdf-lib assembly on
// the same single node process that serves the door scanner and the redeem
// endpoint, and Cache-Control is no-store, so nothing upstream absorbs a
// repeat. 30 renders / 10 min is far more than a guest re-opening their pass
// at the door.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 30;
const tokenHits = new Map<string, number[]>();
let lastCleanupAt = 0;

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  if (now - lastCleanupAt > 60_000) {
    lastCleanupAt = now;
    for (const [k, hits] of tokenHits) {
      const kept = hits.filter((t) => now - t < RATE_WINDOW_MS);
      if (kept.length === 0) tokenHits.delete(k);
      else if (kept.length !== hits.length) tokenHits.set(k, kept);
    }
  }
  const fresh = (tokenHits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (fresh.length >= RATE_MAX) {
    tokenHits.set(key, fresh);
    return false;
  }
  fresh.push(now);
  tokenHits.set(key, fresh);
  return true;
}

/**
 * Was this wallet killed by an admin, or simply spent to the last rupee?
 *
 * Both land in status 'exhausted' (voidWallet sets it directly;
 * redemption.ts:116 sets it whenever balanceAfter <= 0), but they are
 * opposite facts about the guest: a void is a refund/write-off, while
 * spending the tab is the wallet working exactly as sold. voidWallet always
 * writes this audit row, so its presence is the only durable marker that
 * separates the two.
 */
function wasVoided(txnId: string): boolean {
  const row = getDb().prepare(`
    SELECT 1 FROM audit_log
    WHERE entity_type = 'wallet' AND entity_id = ? AND action = 'wallet_void'
    LIMIT 1
  `).get(txnId);
  return !!row;
}

/** Positive evidence that the balance went to zero through the bar. */
function wasSpentDown(txnId: string): boolean {
  const row = getDb().prepare(`
    SELECT 1 FROM redemptions WHERE txn_id = ? AND status = 'success' LIMIT 1
  `).get(txnId);
  return !!row;
}

/**
 * GET /api/public/wallet-pass-pdf/[token]
 *
 * PUBLIC, no session — the HMAC token IS the credential. Sibling of
 * /api/public/wallet-pass/[token] (the PNG), and it exists for the same
 * reason: Interakt's media fetcher pulls the file from this URL server-side
 * and has no session cookie to present.
 *
 * Delivery tiers this serves (see the WhatsApp senders):
 *   • tier 2 — paid ticket, cover_issued === 0 : PDF carries the entry QR only
 *   • tier 3 — cover charge issued            : same PDF; the PIN travels in
 *     the WhatsApp message TEXT, never in this file
 * Tier 1 (free reservation) is text-only and never reaches this endpoint.
 *
 * The PIN is deliberately absent from the PDF. A PDF is a file the guest can
 * forward, screenshot or leave in a downloads folder; the PIN is the one
 * factor that stops a stolen QR image from draining bar credit, so it must
 * not travel in the same artefact as the QR. Note that
 * WalletPassPayload.qrCodeId is that plaintext PIN under an older alias —
 * we intentionally do NOT forward it into generatePassPdf().
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const payload = verifyWalletPassToken(token);
  if (!payload) {
    return NextResponse.json({ ok: false, message: 'Invalid or expired link.' }, { status: 404 });
  }

  // Rate limit AFTER the (cheap, in-process HMAC) token check, because the
  // token is what supplies the bucket key, and BEFORE the DB read + render,
  // which is where the cost actually is.
  if (!checkRateLimit(payload.txnId)) {
    return NextResponse.json(
      { ok: false, message: 'Too many requests. Please slow down.' },
      { status: 429, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }

  const wallet = lookupWallet(payload.txnId);
  if (!wallet) {
    return NextResponse.json({ ok: false, message: 'Wallet not found.' }, { status: 404 });
  }
  // 'exhausted' is two different events wearing one label, and only one of
  // them should kill the pass:
  //
  //   • voidWallet()          → the venue cancelled/refunded this wallet. The
  //                             credential is dead; 410 is right.
  //   • redemption-to-zero    → the guest spent every rupee of bar credit,
  //                             which is the wallet doing its job. This QR is
  //                             ALSO their door pass — they paid entry_fee for
  //                             it — so refusing it means a guest who steps out
  //                             for a smoke at 11pm reopens their WhatsApp link
  //                             and gets "Pass no longer valid." with no QR and
  //                             no explanation, and door staff have nothing to
  //                             scan and no way to tell them from someone who
  //                             never paid.
  //
  // Fails closed: an exhausted wallet with no successful redemption behind it
  // didn't get here by spending, so it is treated as void.
  if (wallet.status === 'exhausted' && (wasVoided(payload.txnId) || !wasSpentDown(payload.txnId))) {
    return NextResponse.json({ ok: false, message: 'Pass no longer valid.' }, { status: 410 });
  }

  // Resolve the event the same way the admin PDF endpoint does — per-wallet
  // event_id wins, global config is the fallback. event_id arrived in a later
  // migration and the TS type hasn't caught up, so read it off the raw row.
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

  // A spent-to-zero wallet still carries cover_issued > 0, and generatePassPdf
  // defaults hasCover to `coverAmount > 0` — which would print "COVER PASS /
  // Cover loaded INR 6,000" on a pass with nothing left to spend. Keying the
  // copy off the live balance makes it read "ENTRY PASS / No bar credit",
  // which is the truth at the door. For every wallet that was served before
  // this change (balance > 0, or an entry-only wallet with cover 0) the value
  // is identical to the old default, so the existing copy is unchanged.
  const hasCover = wallet.cover_issued > 0 && wallet.balance > 0;

  const pdfBytes = await generatePassPdf({
    txnId: payload.txnId,
    guestName: wallet.name || 'Guest',
    coverAmount: wallet.cover_issued,
    hasCover,
    eventName,
    venueName,
    venueLogo,
    expiresAt: wallet.expires_at,
  });
  const body = Buffer.from(pdfBytes);

  // txnId is HMAC-signed so it can't be attacker-chosen, but the filename lands
  // in a response header — strip anything that isn't filename-safe rather than
  // trusting the generator's alphabet to stay numeric/alpha forever.
  const safeId = payload.txnId.replace(/[^A-Za-z0-9._-]/g, '') || 'pass';
  // Entry-only wallets aren't a "cover pass" — name the file for what it is so
  // the guest's downloads folder reads honestly. Same `hasCover` the document
  // itself uses, so the filename can't promise credit the page then denies.
  const fileName = hasCover ? `cover-pass-${safeId}.pdf` : `ticket-${safeId}.pdf`;

  return new NextResponse(body as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(body.length),
      // inline, not attachment: WhatsApp/Interakt render documents in an
      // in-app viewer, and an attachment disposition makes some clients force
      // a download step before the guest can show the QR at the door.
      'Content-Disposition': `inline; filename="${fileName}"`,
      // no-store, unlike the PNG's public/1-day cache. The PNG is re-served
      // inline in the chat by WhatsApp's CDN, so caching it buys something;
      // a document header is uploaded to Meta's media store once at send time,
      // so origin caching buys nothing here and only leaves an entry
      // credential sitting in shared proxies. no-store also means rotating
      // INTERNAL_TOKEN_SECRET kills outstanding links immediately instead of
      // racing stale cached copies.
      'Cache-Control': 'private, no-store, max-age=0',
    },
  });
}
