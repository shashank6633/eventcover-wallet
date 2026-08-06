'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { formatMoney } from '@/lib/format';
import { PhoneInput } from '@/components/PhoneInput';
import { ReservationSearch, type ReservationSearchHit } from '@/components/ReservationSearch';
import type { Event } from '@/lib/events';
// Imported, never redeclared. This page used to define its own local
// PaymentMethod union, which shadowed the canonical one and hid the drift from
// tsc: it offered a "Razorpay" button that /api/wallets rejects with a 400,
// at the door, after the money was taken. Importing makes the compiler enforce
// the contract with the API.
import type { PaymentMethod } from '@/lib/types';

interface IssueResult {
  txnId: string;
  pin: string;
  balance: number;
  captainUrl: string;
  qrDataUrl: string;
  guestName: string;
  expiresAt?: number;
  expiresAtLabel?: string;
}

interface TableOption { id: string; label: string; status: string; }

interface CalcResult {
  ok: boolean;
  totalPax?: number;
  entryTotal?: number;
  coverTotal?: number;
  subtotal?: number;
  finalAmount?: number;
  allValid?: boolean;
  config?: {
    entry_fee_per_person: number;
    cover_rates: { male_stag: number; female_stag: number; couple: number };
    entry_enabled: boolean;
    cover_enabled: boolean;
  };
  lines?: Array<{
    pax: number;
    entryAmount: number;
    coverAmount: number;
    total: number;
  }>;
  message?: string;
}

/**
 * Every value here must be in VALID_METHODS in /api/wallets — the type import
 * above is what guarantees it. 'comp' is intentionally absent: complimentary
 * entries live in /admin/tickets (Offline Ticketing), not at the entrance.
 */
const PAYMENTS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'online', label: 'Online' },
];

export default function IssueCoverPage() {
  return (
    <Suspense fallback={<Loading />}>
      <IssueClient />
    </Suspense>
  );
}

function Loading() {
  return <div className="max-w-2xl mx-auto px-4 py-8 text-slate-400">Loading…</div>;
}

function IssueClient() {
  const params = useSearchParams();
  const router = useRouter();
  /**
   * The reservation this wallet converts, read straight off the URL and
   * therefore cleared by rewriting the URL — see resetForNext(). It is NOT
   * mirrored into state on purpose: two sources of truth here is exactly how
   * the bug worked. "Issue next wallet" cleared eleven form fields but could
   * not clear a value that lives in the query string, so every subsequent
   * walk-in was submitted with reservationId=RES123 and kept re-pointing that
   * booking's converted_wallet_txn at a stranger, while the blue "Prefilled
   * from reservation" banner stayed on screen giving the operator no signal.
   */
  const reservationId = params.get('r') || '';
  const preferredEventId = params.get('eventId') || '';

  // Customer
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');

  // Guest mix — new
  const [male, setMale] = useState(0);
  const [female, setFemale] = useState(0);
  const [couple, setCouple] = useState(0);

  // Pricing — auto from engine, with override
  const [calc, setCalc] = useState<CalcResult | null>(null);
  const [entryOverride, setEntryOverride] = useState<string>('');
  const [coverOverride, setCoverOverride] = useState<string>('');
  const [override, setOverride] = useState(false);

  // Misc
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [tableId, setTableId] = useState('');
  const [tables, setTables] = useState<TableOption[]>([]);

  // Events
  const [events, setEvents] = useState<Event[]>([]);
  const [eventId, setEventId] = useState('');

  // Flow
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IssueResult | null>(null);

  // Load tables + events
  useEffect(() => {
    fetch('/api/tables').then((r) => r.json()).then((d) => {
      if (d.ok) setTables(d.tables.filter((t: TableOption) => t.status !== 'closed'));
    }).catch(() => {});

    fetch('/api/events').then((r) => r.json()).then((d) => {
      if (!d.ok) return;
      const list: Event[] = d.events || [];
      setEvents(list);
      const chosen = preferredEventId && list.some((e) => e.id === preferredEventId)
        ? preferredEventId
        : (list.find((e) => e.status === 'live')?.id || list[0]?.id || '');
      setEventId(chosen);
    }).catch(() => {});

    if (reservationId) {
      fetch(`/api/reservations/${reservationId}`).then((r) => r.json()).then((d) => {
        if (d.ok) {
          setName(d.reservation.name);
          setPhone(d.reservation.phone);
          setEmail(d.reservation.email || '');
          // Best-effort: treat reservation.pax as Couple if even, Stag if odd, etc.
          // Bouncer can adjust before issuing.
          const p = Number(d.reservation.pax) || 1;
          if (p % 2 === 0 && p <= 4) { setCouple(p / 2); }
          else { setMale(p); }
          if (d.reservation.event_id) setEventId(d.reservation.event_id);
        }
      }).catch(() => {});
    }
  }, [reservationId, preferredEventId]);

  // Live recalculation via the same engine the bookings page uses (debounced)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!eventId) { setCalc(null); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch('/api/bookings/calculate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventId,
            lines: [{
              kind: 'individual',
              counts: { male, female, couple },
            }],
          }),
        });
        const data = (await res.json()) as CalcResult;
        setCalc(data);
        if (!override && data.ok) {
          setEntryOverride(String(data.entryTotal ?? 0));
          setCoverOverride(String(data.coverTotal ?? 0));
        }
      } catch {
        setCalc({ ok: false, message: 'Could not calculate' });
      }
    }, 200);
  }, [eventId, male, female, couple, override]);

  function adj(set: (n: number) => void, n: number, delta: number) {
    set(Math.max(0, n + delta));
  }

  /**
   * Apply a reservation hit from the search dropdown into the form. Pre-fills
   * customer fields, splits pax into couple+stag using the same heuristic as
   * the ?r= URL-param flow, and switches the event dropdown if the
   * reservation is linked to a specific event.
   *
   * Doesn't carry the reservation id forward (no auto-mark-as-converted)
   * because the operator might be issuing a wallet for a non-pre-booked
   * guest who happens to share a phone number. If they actually want the
   * "Issue → convert reservation" flow, they go via /admin/reservations.
   */
  function applyReservation(r: ReservationSearchHit) {
    setName(r.name);
    setPhone(r.phone);
    setEmail(r.email || '');

    // Reset the existing pax breakdown before applying, so consecutive picks
    // don't accumulate.
    setMale(0); setFemale(0); setCouple(0);
    const p = Math.max(1, Number(r.pax) || 1);
    if (p % 2 === 0 && p <= 4) {
      setCouple(p / 2);
    } else {
      setMale(p);
    }

    if (r.event_id) setEventId(r.event_id);
    setError(null);
  }

  const totalPax = male + female + couple * 2;

  // Use override values if set, else engine values.
  // Complimentary entries live in /admin/tickets (Offline Ticketing) — not here at the entrance.
  const entryFinal = override ? Number(entryOverride) || 0 : (calc?.entryTotal ?? 0);
  const coverFinal = override ? Number(coverOverride) || 0 : (calc?.coverTotal ?? 0);
  const totalAtDoor = entryFinal + coverFinal;

  async function issue(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim() || !phone.trim()) { setError('Name and phone are required.'); return; }
    if (totalPax === 0) { setError('Add at least one guest (Male / Female / Couple).'); return; }
    if (entryFinal < 0 || coverFinal < 0) { setError('Entry / cover cannot be negative.'); return; }

    setBusy(true);
    try {
      const res = await fetch('/api/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          email: email.trim() || undefined,
          pax: totalPax,
          entryFee: entryFinal,
          coverIssued: coverFinal,
          paymentMethod,
          tableId: tableId || undefined,
          eventId: eventId || undefined,
          reservationId: reservationId || undefined,
        }),
      });
      const data = await res.json();
      if (!data.ok) setError(data.message || 'Failed to issue wallet.');
      else setResult({ ...data, guestName: name.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setBusy(false);
    }
  }

  function resetForNext() {
    setName(''); setPhone(''); setEmail('');
    setMale(0); setFemale(0); setCouple(0);
    setTableId(''); setPaymentMethod('cash');
    setOverride(false); setEntryOverride(''); setCoverOverride('');
    setResult(null); setError(null);
    // Drop ?r= so the next guest is not stamped onto the previous guest's
    // booking. The banner is driven by the same param, so it disappears too.
    // ?eventId= is preserved — it selects which event we're issuing for and
    // is still correct for the next walk-in.
    if (reservationId) {
      router.replace(
        `/admin/issue${preferredEventId ? `?eventId=${encodeURIComponent(preferredEventId)}` : ''}`,
        { scroll: false },
      );
    }
  }

  const currentEvent = events.find((e) => e.id === eventId);
  const rates = calc?.config?.cover_rates ?? currentEvent?.cover_rates;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <div className="text-[11px] tracking-widest uppercase text-slate-400">Entry station</div>
      <h1 className="text-2xl font-bold text-slate-900 mt-1">Issue cover</h1>
      <p className="text-sm text-slate-500 mt-1">
        Register a guest, collect entry + cover, issue a QR wallet. Cover charges follow the
        event's pricing config (Male / Female / Couple rates).
      </p>

      {reservationId && (
        <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 text-sky-700 px-3 py-2 text-sm">
          Prefilled from reservation <span className="font-mono text-xs">{reservationId}</span>.
          Issuing this wallet will mark the reservation as converted.
        </div>
      )}

      {!result && (
        <div className="mt-6">
          <ReservationSearch
            eventId={eventId}
            onPick={(r) => applyReservation(r)}
          />
        </div>
      )}

      {!result && (
        <form onSubmit={issue} className="card mt-4 space-y-5">
          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 px-4 py-3 text-sm">
              {error}
            </div>
          )}

          {/* Event */}
          <div>
            <label className="label">Event</label>
            {events.length === 0 ? (
              <div className="text-xs text-amber-700">
                No events found. <Link className="underline" href="/admin/events">Create one first →</Link>
              </div>
            ) : (
              <select className="input" value={eventId}
                      onChange={(e) => { setEventId(e.target.value); setOverride(false); }}>
                {events.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.event_date} · {ev.name} ({ev.status})
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Customer */}
          <div>
            <label className="label">Guest name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)}
                   placeholder="e.g. Rohit Kumar" autoFocus />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-4">
            <div>
              <label className="label">Phone</label>
              <PhoneInput
                value={phone}
                onChange={setPhone}
                placeholder="10-digit number"
                required
              />
            </div>
            <div>
              <label className="label">Email (optional)</label>
              <input className="input" type="email" value={email}
                     onChange={(e) => setEmail(e.target.value)} placeholder="guest@example.com" />
            </div>
          </div>

          {/* Guest mix */}
          <div>
            <div className="flex items-baseline justify-between">
              <label className="label">Guest mix <span className="text-rose-600">*</span></label>
              {rates && (
                <div className="text-[10px] uppercase tracking-wider text-slate-500">
                  Rates: M ₹{rates.male_stag} · F ₹{rates.female_stag} · C ₹{rates.couple}
                </div>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3 mt-1">
              <Counter label="Male" value={male} rate={rates?.male_stag} onAdj={(d) => adj(setMale, male, d)} onSet={setMale} />
              <Counter label="Female" value={female} rate={rates?.female_stag} onAdj={(d) => adj(setFemale, female, d)} onSet={setFemale} />
              <Counter label="Couple" value={couple} rate={rates?.couple} onAdj={(d) => adj(setCouple, couple, d)} onSet={setCouple} subLabel="2 pax" />
            </div>
          </div>

          {/* Live bill */}
          <BillCard
            calc={calc}
            totalPax={totalPax}
            override={override}
            entryOverride={entryOverride}
            coverOverride={coverOverride}
            onOverrideChange={setOverride}
            onEntryChange={setEntryOverride}
            onCoverChange={setCoverOverride}
          />

          {tables.length > 0 && (
            <div>
              <label className="label">Assign table (optional)</label>
              <select className="input" value={tableId} onChange={(e) => setTableId(e.target.value)}>
                <option value="">None</option>
                {tables.map((t) => (
                  <option key={t.id} value={t.id}>{t.label} · {t.status}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="label">Payment method</label>
            <div className="flex flex-wrap gap-2">
              {PAYMENTS.map((p) => (
                <button
                  key={p.value} type="button"
                  onClick={() => setPaymentMethod(p.value)}
                  className={`flex-1 min-w-[110px] px-4 py-2.5 rounded-lg border font-medium text-sm transition ${
                    paymentMethod === p.value
                      ? 'bg-brand-500 text-white border-brand-500'
                      : 'bg-slate-50 text-slate-700 border-slate-200 hover:border-slate-400'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <button
            className="btn btn-primary w-full"
            disabled={busy || !eventId || totalPax === 0}
          >
            {busy ? 'Issuing…' : `Issue wallet · Collect ${formatMoney(totalAtDoor)}`}
          </button>
        </form>
      )}

      {result && (
        <div className="card mt-6">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 px-4 py-2 text-sm inline-block">
            ✓ Wallet issued
          </div>
          <div className="mt-4 text-xl font-semibold text-slate-900">{result.guestName}</div>
          <div className="font-mono text-slate-400 text-sm mt-1">{result.txnId}</div>
          {result.expiresAtLabel && (
            <div className="text-xs text-amber-700 mt-2">
              Valid until <b>{result.expiresAtLabel}</b>
            </div>
          )}

          <div className="mt-6 flex flex-col md:flex-row gap-6 md:items-center">
            <div className="flex-shrink-0 bg-white rounded-xl p-4 self-center">
              <img src={result.qrDataUrl} alt="QR" width={240} height={240} />
            </div>
            <div className="flex-1 space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="kpi-label">Spendable balance</div>
                <div className="text-3xl font-bold text-emerald-700">₹{result.balance}</div>
                <div className="text-xs text-slate-500 mt-1">Cover only — entry fee is not redeemable</div>
              </div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <div className="kpi-label text-amber-700">QR Code ID (share with guest)</div>
                <div className="font-mono text-4xl font-bold text-amber-700 tracking-[0.4em] mt-1">
                  {result.pin}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-col md:flex-row gap-3">
            <button
              type="button"
              className="btn btn-primary flex-1"
              onClick={async () => {
                // PNG — best for WhatsApp inline send + fast door scans.
                // Browser-fetch the image, then open it in a new tab so the
                // operator can long-press → Save / Share.
                //
                // The PIN is NOT in this URL. It used to be (`?qrCodeId=<pin>`)
                // and the renderer stamped it in 36px under the QR, so the one
                // image staff forward over WhatsApp carried both factors —
                // anyone the guest forwarded it to could drain the full cover.
                // The request line also put the PIN verbatim into every access
                // log. The PIN reaches the guest in the message TEXT only.
                try {
                  const url = `/api/wallets/${encodeURIComponent(result.txnId)}/image`;
                  const res = await fetch(url);
                  if (!res.ok) {
                    const err = await res.json().catch(() => ({ message: 'Failed' }));
                    alert(`Could not load QR image: ${err.message}`);
                    return;
                  }
                  const blob = await res.blob();
                  const objUrl = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = objUrl;
                  a.download = `cover-pass-${result.txnId}.png`;
                  a.click();
                  URL.revokeObjectURL(objUrl);
                } catch (e) {
                  alert(e instanceof Error ? e.message : 'Network error');
                }
              }}
            >
              📱 Save QR Image (for WhatsApp)
            </button>
            <button
              type="button"
              className="btn btn-secondary flex-1"
              onClick={async () => {
                // PDF — formal receipt option (multi-page, brandable, printable).
                // No body: the route derives everything from the txn_id in the
                // path and documents that it never reads a PIN. Sending one
                // anyway just put it on the wire for nothing.
                try {
                  const res = await fetch(`/api/wallets/${encodeURIComponent(result.txnId)}/pass`, {
                    method: 'POST',
                  });
                  if (!res.ok) {
                    const err = await res.json().catch(() => ({ message: 'Failed' }));
                    alert(`Could not download pass: ${err.message}`);
                    return;
                  }
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `cover-pass-${result.txnId}.pdf`;
                  a.click();
                  URL.revokeObjectURL(url);
                } catch (e) {
                  alert(e instanceof Error ? e.message : 'Network error');
                }
              }}
            >
              ↓ Receipt PDF
            </button>
            <button className="btn btn-secondary flex-1" onClick={resetForNext}>Issue next wallet</button>
          </div>
          <div className="mt-2 flex flex-col md:flex-row gap-3">
            <a className="btn btn-secondary flex-1" href={result.captainUrl} target="_blank" rel="noreferrer">
              Open captain link
            </a>
            <CopyLinkButton url={result.captainUrl} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

/**
 * Copy-link button with explicit feedback + manual-copy fallback.
 *
 * Three paths, tried in order:
 *   1. navigator.clipboard.writeText — modern browsers in secure contexts
 *   2. document.execCommand('copy') via a hidden textarea — older browsers
 *   3. Reveal the URL inside a focused, auto-selected text input so the user
 *      can press Ctrl/Cmd+C (or long-press → Copy on mobile)
 *
 * Path 3 ALWAYS works — even inside the Preview tool's restrictive sandbox
 * where both clipboard APIs are blocked. The user is never stuck without a
 * way to grab the link.
 */
function CopyLinkButton({ url }: { url: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const fallbackRef = useRef<HTMLInputElement | null>(null);

  async function copy() {
    // Path 1: modern clipboard API
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
        flashCopied();
        return;
      }
    } catch { /* fall through */ }

    // Path 2: execCommand fallback (deprecated but still widely supported)
    try {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) { flashCopied(); return; }
    } catch { /* fall through */ }

    // Path 3: reveal a focused input — user copies manually
    setState('manual');
    // Focus + select on next tick so the input has rendered
    requestAnimationFrame(() => {
      fallbackRef.current?.focus();
      fallbackRef.current?.select();
    });
  }

  function flashCopied() {
    setState('copied');
    setTimeout(() => setState('idle'), 2200);
  }

  if (state === 'manual') {
    return (
      <div className="flex-1 flex items-stretch gap-2">
        <input
          ref={fallbackRef}
          type="text"
          readOnly
          value={url}
          className="input flex-1 text-xs font-mono"
          onClick={(e) => (e.target as HTMLInputElement).select()}
        />
        <button
          type="button"
          onClick={() => setState('idle')}
          className="btn btn-secondary"
          title="Hide"
        >
          ✕
        </button>
      </div>
    );
  }

  const label = state === 'copied' ? '✓ Copied' : 'Copy link';
  return (
    <button
      type="button"
      onClick={copy}
      className={`btn flex-1 btn-secondary ${
        state === 'copied' ? '!bg-emerald-50 !text-emerald-700 !border-emerald-200' : ''
      }`}
    >
      {label}
    </button>
  );
}

function Counter({
  label, value, rate, subLabel, onAdj, onSet,
}: {
  label: string;
  value: number;
  rate: number | undefined;
  subLabel?: string;
  onAdj: (delta: number) => void;
  onSet: (n: number) => void;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex flex-col">
        <span className="text-sm font-semibold text-slate-900 leading-tight">{label}</span>
        <span className="text-[10px] text-slate-400 uppercase tracking-wider mt-0.5 whitespace-nowrap">
          {subLabel ?? '1 pax'}
        </span>
      </div>
      {/* Plain number input — no stepper buttons. Bouncer taps and types the
          count; mobile shows a numeric keyboard. Removes the cramped −/+
          buttons that crowded out the input on narrow mobile tiles. */}
      <div className="mt-2">
        <input
          className="input text-center text-lg font-bold py-1.5 px-2"
          type="number"
          inputMode="numeric"
          pattern="[0-9]*"
          min={0}
          value={value}
          onChange={(e) => onSet(Math.max(0, Number(e.target.value) || 0))}
          aria-label={`${label} count`}
        />
      </div>
      {rate != null && rate > 0 && (
        <div className="mt-1.5 text-[10px] text-slate-400 text-center">
          ₹{rate.toLocaleString('en-IN')}/each
        </div>
      )}
    </div>
  );
}

function BillCard({
  calc, totalPax, override, entryOverride, coverOverride,
  onOverrideChange, onEntryChange, onCoverChange,
}: {
  calc: CalcResult | null;
  totalPax: number;
  override: boolean;
  entryOverride: string;
  coverOverride: string;
  onOverrideChange: (v: boolean) => void;
  onEntryChange: (v: string) => void;
  onCoverChange: (v: string) => void;
}) {
  const entry = override ? Number(entryOverride) || 0 : (calc?.entryTotal ?? 0);
  const cover = override ? Number(coverOverride) || 0 : (calc?.coverTotal ?? 0);
  const total = entry + cover;

  return (
    <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-slate-900">
          Bill · {totalPax} pax
        </div>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 cursor-pointer">
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => onOverrideChange(e.target.checked)}
            className="accent-brand-500 w-3.5 h-3.5"
          />
          Override
        </label>
      </div>

      {/* Mobile: each tile takes the full row (wide rectangle) so a big amount
          like ₹24,000 never overflows. Desktop: 3-column grid stays as before. */}
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
        <BillCell
          label="Entry"
          value={entry}
          editable={override}
          inputValue={entryOverride}
          onChange={onEntryChange}
          note="non-refundable"
        />
        <BillCell
          label="Cover"
          value={cover}
          editable={override}
          inputValue={coverOverride}
          onChange={onCoverChange}
          note="wallet"
          accent
        />
        <div className="rounded-lg bg-white border-2 border-brand-300 p-3 flex items-center justify-between sm:flex-col sm:text-center">
          <div className="flex sm:flex-col sm:items-center">
            <div className="text-[11px] uppercase tracking-wider text-brand-700 font-semibold whitespace-nowrap">
              Total
            </div>
            <div className="text-[10px] text-slate-500 sm:mt-1 ml-2 sm:ml-0 whitespace-nowrap">
              at door
            </div>
          </div>
          <div className="text-xl sm:text-xl font-bold text-brand-700 sm:mt-1 leading-none whitespace-nowrap">
            {formatMoney(total)}
          </div>
        </div>
      </div>
    </div>
  );
}

function BillCell({
  label, value, editable, inputValue, onChange, note, accent,
}: {
  label: string;
  value: number;
  editable: boolean;
  inputValue: string;
  onChange: (v: string) => void;
  note: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg bg-white border border-slate-200 p-3 flex items-center justify-between sm:flex-col sm:text-center">
      <div className="flex sm:flex-col sm:items-center">
        <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold whitespace-nowrap">
          {label}
        </div>
        <div className="text-[10px] text-slate-400 sm:mt-1 ml-2 sm:ml-0 whitespace-nowrap">
          {note}
        </div>
      </div>
      {editable ? (
        <div className="relative w-28 sm:w-full sm:mt-1">
          <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm">₹</span>
          <input
            type="number"
            min={0}
            value={inputValue}
            onChange={(e) => onChange(e.target.value)}
            className="w-full pl-4 pr-1 py-0.5 text-base font-bold text-center outline-none border-b border-slate-300 focus:border-brand-500 bg-transparent"
          />
        </div>
      ) : (
        <div className={`text-xl font-bold sm:mt-1 leading-none whitespace-nowrap ${accent ? 'text-emerald-700' : 'text-slate-900'}`}>
          {formatMoney(value)}
        </div>
      )}
    </div>
  );
}
