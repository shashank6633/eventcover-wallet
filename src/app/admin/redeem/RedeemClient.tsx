'use client';

/**
 * Redeem Cover — the floor screen a captain uses to take money off a guest's
 * bar tab. Client half of the route; the role gate lives in the sibling
 * page.tsx server component (see the note there — this file must never be
 * rendered by anything that hasn't run that check first).
 */

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { formatExpiry, expiryCountdown } from '@/lib/expiry';
import { QrScanner } from '@/components/QrScanner';

interface WalletView {
  txnId: string;
  guestName: string;
  guestPhone?: string;
  balance: number;
  status: string;
  expiresAt?: number | null;
}

interface RedeemResponse {
  ok: boolean;
  message: string;
  amountRedeemed?: number;
  balanceAfter?: number;
  guestName?: string;
}

export function RedeemClient() {
  const router = useRouter();
  const params = useSearchParams();
  const initialTxn = (params.get('t') || '').trim();

  const [mode, setMode] = useState<'lookup' | 'redeem' | 'success' | 'notfound'>(initialTxn ? 'redeem' : 'lookup');
  const [lookupInput, setLookupInput] = useState(initialTxn);
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [loadingWallet, setLoadingWallet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The txn id that was attempted but couldn't be found — shown on the notfound screen. */
  const [attemptedTxn, setAttemptedTxn] = useState<string>('');

  const [pin, setPin] = useState('');
  const [reference, setReference] = useState(''); // Invoice No or Table No
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<RedeemResponse | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);

  useEffect(() => {
    if (!initialTxn) return;
    loadWallet(initialTxn);
  }, [initialTxn]);

  async function loadWallet(txn: string) {
    setLoadingWallet(true); setError(null); setWallet(null);
    setAttemptedTxn(txn);
    try {
      const res = await fetch(`/api/wallets/${encodeURIComponent(txn)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!data.ok) {
        // Switch to the dedicated notfound screen — much clearer feedback than
        // silently bouncing back to the lookup form with a tiny error banner.
        setError(data.message || 'Wallet not found.');
        setMode('notfound');
      } else {
        setWallet(data.wallet);
        setMode('redeem');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
      setMode('notfound');
    } finally {
      setLoadingWallet(false);
    }
  }

  function submitLookup(e: React.FormEvent) {
    e.preventDefault();
    const t = lookupInput.trim().toUpperCase();
    if (!t) { setError('Enter a transaction ID.'); return; }
    router.replace(`/admin/redeem?t=${encodeURIComponent(t)}`);
    loadWallet(t);
  }

  function handleScanned(txn: string) {
    setScannerOpen(false);
    setLookupInput(txn);
    router.replace(`/admin/redeem?t=${encodeURIComponent(txn)}`);
    loadWallet(txn);
  }

  async function redeem(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!wallet) return;
    if (!/^\d{4,8}$/.test(pin)) { setError('QR Code ID must be 4–8 digits.'); return; }
    const amt = Number(amount);
    if (!(amt > 0)) { setError('Enter a redeem amount greater than zero.'); return; }

    setBusy(true);
    try {
      const res = await fetch(`/api/wallets/${encodeURIComponent(wallet.txnId)}/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pin,
          amount: amt,
          orderRef: reference.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      });
      const data: RedeemResponse = await res.json();
      if (!data.ok) {
        setError(data.message);
      } else {
        setSuccess(data);
        setMode('success');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setBusy(false);
    }
  }

  function nextRedemption() {
    setWallet(null); setSuccess(null); setError(null);
    setPin(''); setReference(''); setAmount(''); setNotes(''); setLookupInput('');
    router.replace('/admin/redeem');
    setMode('lookup');
  }

  function backToLookup() {
    setError(null);
    setPin(''); setReference(''); setAmount(''); setNotes('');
    setMode('lookup');
  }

  return (
    <div className="max-w-md mx-auto px-4 py-6 md:py-8">
      <div className="text-[11px] tracking-widest uppercase text-slate-400">Floor</div>
      <h1 className="text-2xl font-bold text-slate-900 mt-1">Redeem Cover</h1>

      {mode === 'lookup' && (
        <>
          <button
            type="button"
            onClick={() => setScannerOpen(true)}
            className="btn btn-primary w-full mt-6 flex items-center justify-center gap-2"
          >
            <ScanIcon />
            Scan guest QR
          </button>

          <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-widest text-slate-500">
            <span className="flex-1 h-px bg-slate-100"></span>
            <span>or enter manually</span>
            <span className="flex-1 h-px bg-slate-100"></span>
          </div>

          <form onSubmit={submitLookup} className="card space-y-4">
            {error && <ErrorBox>{error}</ErrorBox>}
            <div>
              <label className="label">Transaction ID</label>
              <input
                className="input font-mono uppercase"
                value={lookupInput}
                onChange={(e) => setLookupInput(e.target.value.toUpperCase())}
                placeholder="e.g. SKY-0516-C21UE"
                autoComplete="off"
              />
              <div className="text-xs text-slate-500 mt-2">
                Manual fallback if the guest's phone screen is cracked or unreadable.
              </div>
            </div>
            <button className="btn btn-secondary w-full" disabled={loadingWallet}>
              {loadingWallet ? 'Looking up…' : 'Look up wallet'}
            </button>
          </form>
        </>
      )}

      {scannerOpen && (
        <QrScanner
          onDetected={(txn) => handleScanned(txn)}
          onClose={() => setScannerOpen(false)}
        />
      )}

      {/* Full-screen overlay during the post-scan lookup. Without this, the
          scanner closes and the page appears blank for a beat — looks like
          "the scanner just closed for no reason". */}
      {loadingWallet && (
        <div className="fixed inset-0 z-40 bg-black/30 flex items-center justify-center">
          <div className="bg-white rounded-2xl px-6 py-5 shadow-elevated flex items-center gap-3 max-w-xs">
            <div className="w-5 h-5 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
            <div>
              <div className="text-sm font-semibold text-slate-900">Looking up wallet…</div>
              {attemptedTxn && (
                <div className="text-[11px] font-mono text-slate-500 mt-0.5">{attemptedTxn}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {mode === 'redeem' && wallet && (
        <>
          {/* Guest header chip */}
          <div className="card mt-5 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-900 truncate">{wallet.guestName}</div>
                <div className="text-xs text-slate-500 font-mono truncate">{wallet.txnId}</div>
                {wallet.guestPhone && (
                  <div className="text-xs text-slate-500 font-mono mt-0.5">+91 {wallet.guestPhone.replace(/^\+?91/, '')}</div>
                )}
              </div>
              {wallet.expiresAt && wallet.status === 'active' && (
                <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-1 whitespace-nowrap">
                  {expiryCountdown(wallet.expiresAt)}
                </div>
              )}
            </div>
          </div>

          {/* Available Amount — prominent card */}
          <div className="card mt-3 text-center py-6">
            <div className="text-[11px] uppercase tracking-widest text-slate-500">Available Amount</div>
            <div className="text-4xl font-bold text-brand-600 mt-1">
              ₹{wallet.balance.toLocaleString('en-IN')}
            </div>
            <div className="text-xs text-slate-500 mt-2">
              Available till : {wallet.expiresAt ? formatExpiry(wallet.expiresAt) : 'No Expiry'}
            </div>
          </div>

          {wallet.status !== 'active' && (
            <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 px-3 py-2 text-sm">
              Wallet status: <b>{wallet.status}</b> — cannot redeem.
              {wallet.status === 'expired' && wallet.expiresAt && (
                <div className="mt-1 text-xs text-rose-700">
                  Expired at {formatExpiry(wallet.expiresAt)}.
                </div>
              )}
            </div>
          )}

          <form onSubmit={redeem} className="card mt-3 space-y-4">
            {error && <ErrorBox>{error}</ErrorBox>}

            <div>
              <label className="label">QR Code ID <span className="text-rose-600">*</span></label>
              <input
                className="input input-pin"
                type="tel"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={8}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                placeholder="••••••"
                autoComplete="one-time-code"
              />
            </div>

            <div>
              <label className="label">Invoice No or Table No</label>
              <input
                className="input"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="e.g. KOT#4521 or Table 7"
                autoComplete="off"
              />
            </div>

            <div>
              <label className="label">Redeem Amount (₹) <span className="text-rose-600">*</span></label>
              <input
                className="input"
                type="number"
                inputMode="decimal"
                min={1}
                step={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="500"
              />
            </div>

            <div>
              <label className="label">Notes</label>
              <textarea
                className="input"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional note for this redemption"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                onClick={backToLookup}
                className="btn btn-secondary w-full"
                disabled={busy}
              >
                Back
              </button>
              <button
                className="btn btn-primary w-full"
                disabled={busy || wallet.status !== 'active'}
              >
                {busy ? 'Redeeming…' : 'Redeem'}
              </button>
            </div>

            <button
              type="button"
              onClick={() => { backToLookup(); setScannerOpen(true); }}
              className="btn btn-secondary w-full flex items-center justify-center gap-2"
              disabled={busy}
            >
              <ScanIcon />
              Scan Again
            </button>
          </form>
        </>
      )}

      {mode === 'notfound' && (
        <div className="card mt-6">
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-center">
            <div className="w-12 h-12 mx-auto rounded-full bg-rose-500 text-white flex items-center justify-center font-bold text-xl">
              !
            </div>
            <div className="mt-3 text-base font-semibold text-rose-800">Wallet not found</div>
            <div className="mt-1 text-xs text-rose-700">{error || 'No wallet matches that QR.'}</div>
            {attemptedTxn && (
              <div className="mt-3 inline-block font-mono text-[11px] text-rose-700 bg-white border border-rose-200 rounded px-2 py-1">
                {attemptedTxn}
              </div>
            )}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => { setError(null); setMode('lookup'); setScannerOpen(true); }}
            >
              Scan again
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => { setError(null); setMode('lookup'); setLookupInput(''); router.replace('/admin/redeem'); }}
            >
              Manual lookup
            </button>
          </div>
        </div>
      )}

      {mode === 'success' && success && (
        <div className="card mt-6">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center">
            <div className="text-[11px] tracking-widest uppercase text-emerald-700">Redeemed</div>
            <div className="text-5xl font-bold text-emerald-700 mt-2">
              ₹{(success.amountRedeemed || 0).toLocaleString('en-IN')}
            </div>
            <div className="mt-4 text-slate-700">Guest: <b>{success.guestName}</b></div>
            <div className="text-slate-700">
              Remaining: <b>₹{(success.balanceAfter || 0).toLocaleString('en-IN')}</b>
            </div>
          </div>
          <button className="btn btn-primary w-full mt-4" onClick={nextRedemption}>
            Next redemption
          </button>
        </div>
      )}
    </div>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 px-4 py-3 text-sm">
      {children}
    </div>
  );
}

function ScanIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7V5a2 2 0 0 1 2-2h2"/>
      <path d="M21 7V5a2 2 0 0 0-2-2h-2"/>
      <path d="M3 17v2a2 2 0 0 0 2 2h2"/>
      <path d="M21 17v2a2 2 0 0 1-2 2h-2"/>
      <path d="M7 12h10"/>
    </svg>
  );
}
