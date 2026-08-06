import { NextResponse } from 'next/server';
import { listRedemptions } from '@/lib/redemption';
import { requireRole } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/redemptions — the full bar-spend ledger.
 *
 * SELF-AUTHENTICATING, DELIBERATELY. middleware.ts only matches
 * '/admin/:path*', so NOTHING gates /api/* by default — an API route that
 * omits this check is public to anyone who can reach the server. This one used
 * to omit it, and listRedemptions() joins guests, so an anonymous GET returned
 * every redemption amount, balance_before/after, captain name, settlement
 * state and guest name — plus the complete txn_id list, which is the only
 * secret protecting the wallet-lookup endpoints.
 *
 * Roles match /api/transactions (the other register-level view): host /
 * manager / cashier reconcile money; captain and entry staff do not get a
 * venue-wide ledger.
 */
export async function GET() {
  const session = await requireRole(['host', 'manager', 'cashier']);
  if ('forbidden' in session) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status });
  }

  const redemptions = listRedemptions();
  return NextResponse.json({ ok: true, redemptions });
}
