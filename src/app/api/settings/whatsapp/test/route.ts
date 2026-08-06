import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { sendInteraktTemplate, splitPhone } from '@/lib/providers/whatsapp/interakt';
import { logAudit } from '@/lib/audit';
import { getConfig } from '@/lib/db';
import { lookupWallet } from '@/lib/wallet';
import { getEvent } from '@/lib/events';
import { formatMoney } from '@/lib/format';
import { signWalletPassToken, signWalletViewToken } from '@/lib/signed-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Test-send a pre-approved WhatsApp template via Interakt.
 *
 * Host-only — this is the "is the integration alive?" button on the
 * Settings → WhatsApp sub-page.
 *
 * Body:
 *   { template: string, phone: '+91…', txnId?: 'AKA-0806-…' }
 *
 * Test values are hard-coded per template — the goal is to prove the pipeline
 * works end-to-end, not to send real customer data.
 *
 * ─── Why the two cover-pass templates are here ────────────────────────────
 * akan_cover_pass_pdf (DOCUMENT header, 4-var body) and akan_cover_pass
 * (IMAGE header, 2/3-var body) are the templates the wallet flow sends, and
 * until now neither could be fired from anywhere in the product: the tool
 * offered three templates, and the only other trigger for these two is the
 * automatic send behind AUTO_SEND_WHATSAPP_PASS (off) plus an unused resend
 * endpoint with no UI. The production audit log contains zero attempts of
 * either, all time. That meant flipping auto-send on would be the first time
 * they were ever used against Meta — live, on real guests — and the specific
 * way that fails is silent: if the approved template's structure differs from
 * the payload (3 body vars vs 4, IMAGE header vs DOCUMENT), Interakt accepts
 * the request with a 2xx, the code writes a `…_sent` audit row, and Meta drops
 * the message at render time. Every guest gets nothing and the trail says it
 * worked.
 *
 * These two branches therefore read the SAME config keys and build the SAME
 * header/body shapes as the real senders (src/lib/whatsapp/wallet-pass-pdf-send.ts
 * and wallet-pass-send.ts). Hard-coding a payload here that merely resembled
 * them would test the wrong thing.
 *
 * They need a real wallet (`txnId`): both carry a media header that Interakt
 * fetches from this server, and only a real wallet mints a signed URL that
 * resolves. Everything else about the send is a test — in particular the PIN
 * variable is a fixed placeholder, never the guest's real PIN.
 */
/** Obviously-fake PIN for the {{4}} slot. Never the wallet's real PIN. */
const TEST_PIN = '000000';

/**
 * Resolve the wallet a media-header test send hangs off, plus the two body
 * values both pass templates share. The event-name ladder (wallet's event →
 * global EVENT_NAME → 'tonight') is copied from the senders deliberately:
 * Meta rejects an empty variable, so the fallback matters to the test.
 */
function resolveTestWallet(raw: unknown):
  | { txnId: string; guestName: string; eventName: string; row: { cover_issued: number; status: string } }
  | { error: string } {
  const txnId = String(raw || '').trim().toUpperCase();
  if (!txnId) {
    return {
      error:
        'This template carries a media header that Interakt fetches from this server, so the test ' +
        'needs a real wallet. Pass txnId (e.g. from Analytics → any recent pass).',
    };
  }
  const wallet = lookupWallet(txnId);
  if (!wallet) return { error: `Wallet ${txnId} not found.` };

  let eventName = 'tonight';
  const walletEventId = (wallet as unknown as { event_id?: string | null }).event_id;
  if (walletEventId) {
    try {
      const ev = getEvent(walletEventId);
      if (ev?.name) eventName = ev.name;
    } catch { /* event row gone — the fallback is fine */ }
  } else {
    const cfg = getConfig('EVENT_NAME', '').trim();
    if (cfg) eventName = cfg;
  }

  return {
    txnId,
    guestName: (wallet.name || '').trim() || 'Guest',
    eventName,
    row: { cover_issued: Number(wallet.cover_issued ?? 0), status: String(wallet.status) },
  };
}
export async function POST(req: NextRequest) {
  const session = await requireRole(['host']);
  if ('forbidden' in session) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status });
  }

  const body = await req.json().catch(() => ({}));
  const template = String(body?.template || '').trim();
  const phone = String(body?.phone || '').trim();

  if (!phone) {
    return NextResponse.json({ ok: false, message: 'Phone number is required.' }, { status: 400 });
  }

  const { countryCode, phoneNumber } = splitPhone(phone);
  if (!phoneNumber || phoneNumber.length < 7) {
    return NextResponse.json({ ok: false, message: 'Enter a valid phone with country code.' }, { status: 400 });
  }

  const venueName = getConfig('VENUE_NAME', 'AKAN Hyderabad');

  let sendInput;
  switch (template) {
    case 'akan_login_otp': {
      const testCode = String(Math.floor(1000 + Math.random() * 9000));
      sendInput = {
        countryCode,
        phoneNumber,
        templateName: 'akan_login_otp',
        languageCode: 'en',
        bodyValues: [testCode],
        // Authentication templates with a "Copy code" button require the code
        // to be passed at the button level too (Meta auto-fill needs it).
        buttonValues: { '0': [testCode] },
        callbackData: 'test:otp',
      };
      break;
    }
    case 'reservation_confirmed': {
      sendInput = {
        countryCode,
        phoneNumber,
        templateName: 'reservation_confirmed',
        languageCode: 'en',
        bodyValues: [
          'Test Guest',                           // {{1}} Guest name
          'Saturday Night Live',                  // {{2}} Event name
          new Date().toLocaleDateString('en-IN', {
            weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
          }),                                     // {{3}} Event date
          '9:00 PM',                              // {{4}} Event start time
        ],
        callbackData: 'test:reservation',
      };
      break;
    }
    case 'ticket_confirmed': {
      const testQrId = String(Math.floor(1000 + Math.random() * 9000));
      sendInput = {
        countryCode,
        phoneNumber,
        templateName: 'ticket_confirmed',
        languageCode: 'en',
        bodyValues: [
          'Test Guest',                           // {{1}} Guest name
          'GA',                                   // {{2}} Ticket tier
          'Saturday Night Live',                  // {{3}} Event name
          new Date().toLocaleDateString('en-IN', {
            weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
          }),                                     // {{4}} Event date
          'FB000001',                             // {{5}} Invoice number
          '2000',                                 // {{6}} Cover amount
          testQrId,                               // {{7}} 4-digit QR Code ID
        ],
        callbackData: 'test:ticket',
      };
      break;
    }
    // ─── Wallet pass, PDF document (tiers 2 + 3) ────────────────────────────
    case 'akan_cover_pass_pdf': {
      const wallet = resolveTestWallet(body?.txnId);
      if ('error' in wallet) {
        return NextResponse.json({ ok: false, message: wallet.error }, { status: 400 });
      }
      const coverIssued = Number(wallet.row.cover_issued ?? 0);
      const hasCover = coverIssued > 0;

      // Same two-template rule as the sender: a 2-variable entry-only body and
      // a 4-variable cover body cannot be the same approved template, and
      // borrowing the cover one for an entry pass is the silent-drop failure
      // this test exists to catch.
      const coverTemplate =
        getConfig('WALLET_PASS_PDF_TEMPLATE', 'akan_cover_pass_pdf').trim() || 'akan_cover_pass_pdf';
      const entryTemplate = getConfig('WALLET_PASS_PDF_TEMPLATE_ENTRY', '').trim();
      if (!hasCover && !entryTemplate) {
        return NextResponse.json({
          ok: false,
          message:
            `Wallet ${wallet.txnId} has no cover, so this would send the entry-only tier — but ` +
            'WALLET_PASS_PDF_TEMPLATE_ENTRY is not set. Set it to an approved 2-variable template, ' +
            'or test with a wallet that carries cover.',
        }, { status: 400 });
      }

      const pdfUrl = `${req.nextUrl.origin}/api/public/wallet-pass-pdf/${signWalletPassToken({ txnId: wallet.txnId })}`;
      const slug = wallet.txnId.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40) || 'pass';
      sendInput = {
        countryCode,
        phoneNumber,
        templateName: hasCover ? coverTemplate : entryTemplate,
        languageCode: getConfig('WALLET_PASS_PDF_LANG', 'en').trim() || 'en',
        headerValues: [pdfUrl],
        fileName: `${hasCover ? 'cover-pass' : 'ticket'}-${slug}.pdf`,
        bodyValues: hasCover
          ? [wallet.guestName, wallet.eventName, formatMoney(coverIssued), TEST_PIN]
          : [wallet.guestName, wallet.eventName],
        callbackData: `test:wallet_pass_pdf:${wallet.txnId}`,
      };
      break;
    }

    // ─── Wallet pass, PNG image ─────────────────────────────────────────────
    case 'akan_cover_pass': {
      const wallet = resolveTestWallet(body?.txnId);
      if ('error' in wallet) {
        return NextResponse.json({ ok: false, message: wallet.error }, { status: 400 });
      }
      // The PNG endpoint refuses exhausted wallets outright, so Interakt's
      // fetch would 410 and the failure would look like a template problem.
      if (wallet.row.status === 'exhausted') {
        return NextResponse.json({
          ok: false,
          message: `Wallet ${wallet.txnId} is exhausted — the pass image endpoint won't serve it. Pick an active wallet.`,
        }, { status: 400 });
      }

      const passUrl = `${req.nextUrl.origin}/api/public/wallet-pass/${signWalletPassToken({ txnId: wallet.txnId })}`;
      // Honour the same back-compat flag the sender does: venues still on a
      // 2-variable approved template set this to '0'.
      const includeLinkRaw = getConfig('WALLET_PASS_TEMPLATE_INCLUDE_LINK', '1').trim().toLowerCase();
      const bodyValues = [wallet.guestName, wallet.eventName];
      if (includeLinkRaw === '1' || includeLinkRaw === 'true') {
        const ttlDaysRaw = parseInt(getConfig('WALLET_VIEW_TOKEN_TTL_DAYS', '90').trim(), 10);
        const ttlDays = Number.isFinite(ttlDaysRaw) && ttlDaysRaw > 0 ? ttlDaysRaw : 90;
        const viewToken = signWalletViewToken({ txnId: wallet.txnId, ttlSeconds: ttlDays * 24 * 60 * 60 });
        bodyValues.push(`${req.nextUrl.origin}/w/${viewToken}`);
      }

      sendInput = {
        countryCode,
        phoneNumber,
        templateName: getConfig('WALLET_PASS_TEMPLATE', 'akan_cover_pass').trim() || 'akan_cover_pass',
        languageCode: getConfig('WALLET_PASS_TEMPLATE_LANG', 'en').trim() || 'en',
        headerValues: [passUrl],
        bodyValues,
        callbackData: `test:wallet_pass:${wallet.txnId}`,
      };
      break;
    }

    default:
      return NextResponse.json({
        ok: false,
        message:
          `Unknown template "${template}". Use akan_login_otp, reservation_confirmed, ticket_confirmed, ` +
          'akan_cover_pass_pdf, or akan_cover_pass (the last two also need a wallet txnId).',
      }, { status: 400 });
  }

  const result = await sendInteraktTemplate(sendInput);

  logAudit({
    actor: session.name,
    action: 'whatsapp_test_send',
    entityType: 'whatsapp',
    entityId: template,
    details: {
      to: `${countryCode}${phoneNumber}`,
      template,
      // The template actually sent, which for the two pass templates comes from
      // config and can differ from the requested name — that substitution is
      // half of what this test is verifying.
      sent_template: sendInput.templateName,
      venue: venueName,
      // Which wallet's signed media URL was used, so a later "who sent this
      // guest's pass to that number?" has an answer. Null for the three
      // hard-coded templates.
      txn_id: typeof body?.txnId === 'string' ? String(body.txnId).trim().toUpperCase() || null : null,
      body_value_count: Array.isArray(sendInput.bodyValues) ? sendInput.bodyValues.length : 0,
      ok: result.ok,
      status: result.status,
      error: result.error,
    },
  });

  if (!result.ok) {
    return NextResponse.json({
      ok: false,
      message: result.error || 'Send failed.',
      status: result.status,
    }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    messageId: result.messageId,
    to: `${countryCode}${phoneNumber}`,
  });
}
