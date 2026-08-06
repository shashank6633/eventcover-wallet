/**
 * /admin/redeem — server-side role gate for the Redeem Cover screen.
 *
 * This page used to be a pure client component, so the ONLY thing standing
 * between a cashier or door-entry user and a working redemption screen was
 * AdminShell hiding the nav link (AdminShell.tsx:196 filters NAV by role for
 * display only). Typing the URL, following a bookmark, or hitting the
 * /captain redirect configured in next.config.mjs rendered the full screen for
 * any signed-in role: they could scan guest QRs all night and read back names,
 * phone numbers and live bar balances, and the 403 only arrived if they
 * actually pressed Redeem. middleware.ts is no help — it checks cookie
 * PRESENCE, not role.
 *
 * Roles mirror the redeem API exactly (POST /api/wallets/[txnId]/redeem allows
 * host / manager / captain) and the NAV entry for this page. Keep the three
 * lists in sync: a role that can see this screen must be able to use it, and a
 * role that can use it must not be bounced from the screen.
 *
 * The gate must stay in this server component. Moving it into RedeemClient
 * would put it back on the wrong side of the trust boundary.
 */

import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { requireRole } from '@/lib/auth';
import { RedeemClient } from './RedeemClient';

export const dynamic = 'force-dynamic';

export default async function RedeemPage() {
  const session = await requireRole(['host', 'manager', 'captain']);
  if ('forbidden' in session) {
    // Unauthenticated visitors are already sent to /login by middleware, so a
    // forbidden here means "signed in, wrong role" — send them somewhere they
    // can actually work rather than showing a dead end.
    redirect('/admin');
  }

  return (
    <Suspense fallback={<Loading />}>
      <RedeemClient />
    </Suspense>
  );
}

function Loading() {
  return (
    <div className="max-w-md mx-auto px-4 py-8">
      <div className="card text-center text-slate-400">Loading…</div>
    </div>
  );
}
