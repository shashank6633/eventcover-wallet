import { NextRequest, NextResponse } from 'next/server';
import { lookupWallet, voidWallet } from '@/lib/wallet';
import { requireRole } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Look up one wallet by txn id — the door/bar lookup behind /admin/redeem,
 * /admin/history and the Analytics ledger.
 *
 * AUTHENTICATED. It used to have no check at all, which made the whole customer
 * table enumerable: txn ids are guessable/harvestable and this payload carries
 * guest name, mobile number and live bar balance — targeting data for a scam
 * call and a personal-data breach on its own. (middleware.ts only gates
 * /admin/*, so an /api route that doesn't check is genuinely public.)
 *
 * Gated to every staff role rather than a narrower set: all five are already
 * trusted with the wallet in front of them (redeem = host/manager/captain,
 * history + ledger = host/manager/cashier, scan = all five), so the useful line
 * here is authenticated-vs-public, and a narrower list would break a working
 * floor flow for no security gain. DELETE below stays strictly host-only —
 * reading a wallet is not reversing one.
 *
 * guestPhone stays in the payload because /admin/redeem renders it (page.tsx
 * :228) so a captain can confirm they have the right guest. Redacting it for
 * non-management would silently blank a field the floor uses today.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ txnId: string }> }) {
  const session = await requireRole(['host', 'manager', 'cashier', 'captain', 'entry']);
  if ('forbidden' in session) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status });
  }

  const { txnId } = await ctx.params;
  const wallet = lookupWallet(txnId);
  if (!wallet) {
    return NextResponse.json({ ok: false, message: 'Transaction not found.' }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    wallet: {
      txnId: wallet.txn_id,
      guestName: wallet.name,
      guestPhone: wallet.phone,
      balance: wallet.balance,
      status: wallet.status,
      entryFee: wallet.entry_fee,
      coverIssued: wallet.cover_issued,
      paymentMethod: wallet.payment_method,
      issuedAt: wallet.issued_at,
      expiresAt: wallet.expires_at,
    },
  });
}

/**
 * Void / refund a wallet.
 *
 * Body: { reason?: string; refundAmount?: number }
 *
 * Forces balance to 0 and marks the wallet exhausted. Always lands as a
 * critical `wallet_void` row in the audit log so an admin or cashier reviewing
 * History sees the reversal at a glance.
 *
 * Strictly host-only: reversing real money is an admin-only action. Manager,
 * cashier, captain and entry roles cannot void a wallet.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ txnId: string }> }) {
  const session = await requireRole(['host']);
  if ('forbidden' in session) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status });
  }

  const { txnId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : undefined;
  const refundAmount =
    typeof body?.refundAmount === 'number' && Number.isFinite(body.refundAmount) && body.refundAmount >= 0
      ? body.refundAmount
      : undefined;

  const wallet = lookupWallet(txnId);
  if (!wallet) {
    return NextResponse.json({ ok: false, message: 'Transaction not found.' }, { status: 404 });
  }
  if (wallet.status !== 'active') {
    return NextResponse.json(
      { ok: false, message: `Wallet is ${wallet.status}. Only active wallets can be voided.` },
      { status: 409 },
    );
  }

  const changed = voidWallet(txnId, session.name, { reason, refundAmount });
  if (!changed) {
    return NextResponse.json(
      { ok: false, message: 'Wallet could not be voided.' },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, txnId, status: 'exhausted', balance: 0 });
}
