import { NextRequest, NextResponse } from 'next/server';
import { listTransactions } from '@/lib/transactions';
import { requireRole } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Transaction register — drives /admin/history.
 *
 * Returns a unified ledger of every entry / cover-charge movement (wallet
 * issuances + bar redemptions) joined with customer info and current status.
 * Open to host / manager / cashier; captain and entry staff don't have a
 * register-level view.
 *
 * Query params:
 *   from, to       — UTC ms (defaults to last 7 days)
 *   kind           — 'entry' | 'redemption' (omit = both)
 *   redeemedBy     — exact match on staff name
 *   q              — search across invoice/customer/phone/staff/amount
 *   limit          — capped at 5000
 */
export async function GET(req: NextRequest) {
  const session = await requireRole(['host', 'manager', 'cashier']);
  if ('forbidden' in session) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status });
  }

  const sp = req.nextUrl.searchParams;
  // `Number(x) || fallback` treated the timestamp 0 as absent, because 0 is
  // falsy — so a reconciliation script asking for the complete ledger with
  // from=0 silently got the last 7 days back, with an HTTP 200 and zero rows,
  // and reported "no transactions ever" for a venue with a full register.
  const from = numParam(sp.get('from'), Date.now() - 7 * 24 * 3600 * 1000);
  const to   = numParam(sp.get('to'),   Date.now() + 1000);
  const kindRaw = sp.get('kind');
  const kind = kindRaw === 'entry' || kindRaw === 'redemption' ? kindRaw : undefined;
  const redeemedBy = sp.get('redeemedBy') || undefined;
  const q = sp.get('q') || undefined;
  const limit = Math.min(5000, Math.max(50, Number(sp.get('limit')) || 1000));

  const result = listTransactions({ from, to, kind, redeemedBy, search: q, limit });

  return NextResponse.json({
    ok: true,
    range: { from, to },
    ...result,
  });
}

/** Parse a numeric query param, treating only absent/blank/non-numeric as "use the default". */
function numParam(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
