'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { formatMoney, relativeTime } from '@/lib/format';
import { PhoneInput } from '@/components/PhoneInput';
import type { Ticket, TicketCategory, Gender } from '@/lib/tickets';
import type { Event } from '@/lib/events';

type Step = 'identifier' | 'details';

interface LookupResult {
  found: boolean;
  name?: string;
  email?: string | null;
  gender?: Gender | null;
  lastSeenAt?: number;
}

export default function OfflineTicketingPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [eventId, setEventId] = useState('');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);

  // Customer state
  const [step, setStep] = useState<Step>('identifier');
  // `phone` is now the full E.164 string (e.g., "+917207666333"). The
  // PhoneInput component handles country code selection + per-country digit
  // validation. An empty string means "not yet valid".
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [gender, setGender] = useState<Gender>('male');
  const [customerNotes, setCustomerNotes] = useState('');
  const [loadingCustomer, setLoadingCustomer] = useState(false);
  const [lookup, setLookup] = useState<LookupResult | null>(null);

  // Ticket state
  const [ticketName, setTicketName] = useState('');
  const [category, setCategory] = useState<TicketCategory>('guest_list');
  const [ticketNotes, setTicketNotes] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [paidOffline, setPaidOffline] = useState(false);
  const [complimentary, setComplimentary] = useState(false);

  // M/F/C breakdown — operator counts heads per cover category. The form
  // auto-derives pax = M + F + 2C, entry = entry_fee_per_person × pax (sunk
  // door fee), and cover = M×male_stag + F×female_stag + C×couple (the
  // redeemable bar credit). Operator can still nudge either field manually.
  const [male, setMale] = useState(0);
  const [female, setFemale] = useState(0);
  const [couples, setCouples] = useState(0);

  // Manual overrides — null means "follow the auto-calc". A non-null string
  // means the operator typed a value into that input. Steppers reset BOTH
  // overrides so the auto-calc resumes when the head count changes.
  const [entryOverride, setEntryOverride] = useState<string | null>(null);
  const [coverOverride, setCoverOverride] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Currently selected event — used by CoverQuickPicks to surface the
  // event's per-category cover rates as one-tap fill buttons. Null while
  // the events list is still loading OR no event is selected (rare —
  // useEffect above auto-picks the soonest upcoming event).
  const selectedEvent = useMemo(
    () => events.find((e) => e.id === eventId) ?? null,
    [events, eventId],
  );

  // ── Auto-derived pax, entry, cover ────────────────────────────────────
  // pax = M + F + 2C
  // entry = entry_fee_per_person × pax  (event-level flat door fee, sunk)
  // cover = M×male_stag + F×female_stag + C×couple  (redeemable at bar)
  // total = entry + cover
  //
  // Complimentary ALWAYS forces both to 0 regardless of overrides — the
  // checkbox is the authoritative "no money changes hands" signal. Pax
  // still derives from M/F/C even on comps because the door-list needs
  // the head count.
  //
  // Manual override paths stay open per field — type into Entry or Cover
  // and the auto-calc stops overwriting that ONE field. Steppers reset
  // both overrides so the auto-calc resumes for either.
  const derivedPax = male + female + couples * 2;
  const autoEntry = useMemo(() => {
    if (!selectedEvent) return 0;
    const rate = Number(selectedEvent.entry_fee_per_person) || 0;
    return rate * derivedPax;
  }, [selectedEvent, derivedPax]);
  const autoCover = useMemo(() => {
    if (!selectedEvent) return 0;
    return (
      male * (Number(selectedEvent.cover_rates?.male_stag) || 0) +
      female * (Number(selectedEvent.cover_rates?.female_stag) || 0) +
      couples * (Number(selectedEvent.cover_rates?.couple) || 0)
    );
  }, [selectedEvent, male, female, couples]);

  const effectiveEntry = complimentary
    ? 0
    : entryOverride !== null
      ? Number(entryOverride) || 0
      : autoEntry;
  const effectiveCover = complimentary
    ? 0
    : coverOverride !== null
      ? Number(coverOverride) || 0
      : autoCover;
  const effectiveTotal = effectiveEntry + effectiveCover;

  const entryInputValue = complimentary
    ? '0'
    : entryOverride !== null
      ? entryOverride
      : String(autoEntry);
  const coverInputValue = complimentary
    ? '0'
    : coverOverride !== null
      ? coverOverride
      : String(autoCover);

  useEffect(() => {
    fetch('/api/events').then((r) => r.json()).then((d) => {
      if (d.ok) {
        const today = istTodayISO();
        const upcoming = (d.events as Event[])
          .filter((e) => e.event_date >= today && e.status !== 'closed')
          .sort((a, b) => a.event_date.localeCompare(b.event_date));
        setEvents(upcoming);
        if (upcoming.length > 0) setEventId(upcoming[0].id);
      }
      setLoadingEvents(false);
    });
  }, []);

  useEffect(() => {
    if (!eventId) { setTickets([]); return; }
    refreshTickets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  async function refreshTickets() {
    if (!eventId) return;
    const d = await fetch(`/api/tickets?eventId=${eventId}`, { cache: 'no-store' }).then((r) => r.json());
    if (d.ok) setTickets(d.tickets || []);
  }

  async function loadCustomer() {
    setError(null);
    const full = phone; // already E.164 from PhoneInput (or '' if invalid)
    if (!full) {
      setError('Enter a valid mobile number.');
      return;
    }
    setLoadingCustomer(true);
    try {
      const d = await fetch(`/api/customers/lookup?phone=${encodeURIComponent(full)}`).then((r) => r.json());
      if (d.found) {
        setName(d.name || full);
        if (d.gender) setGender(d.gender);
        setLookup(d);
        showFlash(`Welcome back, ${d.name}.`);
      } else {
        setName(full);
        setLookup({ found: false });
      }
      setStep('details');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup failed.');
    } finally {
      setLoadingCustomer(false);
    }
  }

  function showFlash(msg: string, ms = 4000) {
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), ms);
  }

  function resetForm() {
    setTicketName('');
    setCategory('guest_list');
    setTicketNotes('');
    setInternalNotes('');
    setPaidOffline(false);
    setComplimentary(false);
    setMale(0); setFemale(0); setCouples(0);
    setEntryOverride(null);
    setCoverOverride(null);
    setPhone(''); setName(''); setGender('male'); setCustomerNotes('');
    setLookup(null);
    setStep('identifier');
    setError(null);
  }

  function toggleComp(next: boolean) {
    setComplimentary(next);
    if (next) {
      setPaidOffline(false);
      // Comps force ₹0 across the board; drop any manual edits.
      setEntryOverride(null);
      setCoverOverride(null);
    }
  }

  function togglePaid(next: boolean) {
    setPaidOffline(next);
    if (next) setComplimentary(false);
  }

  // M/F/C stepper handlers — bumping any category clears BOTH manual
  // overrides so the auto-calc (entry × pax + cover from rates) takes
  // over again. Operator can edit either field afterwards.
  function bumpMale(delta: number)   { setMale(Math.max(0, male + delta));    setEntryOverride(null); setCoverOverride(null); }
  function bumpFemale(delta: number) { setFemale(Math.max(0, female + delta)); setEntryOverride(null); setCoverOverride(null); }
  function bumpCouple(delta: number) { setCouples(Math.max(0, couples + delta));setEntryOverride(null); setCoverOverride(null); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!eventId) { setError('Select an event.'); return; }
    if (!name.trim()) { setError('Customer name is required.'); return; }
    if (!ticketName.trim()) { setError('Ticket name is required.'); return; }
    // Pax comes from M/F/C derivation now. Submit requires at least one head.
    const paxN = derivedPax;
    if (!(paxN >= 1)) {
      setError('Add at least one guest (Male / Female / Couple).');
      return;
    }
    const entryN = effectiveEntry;
    const coverN = effectiveCover;
    const priceN = entryN + coverN; // grand total persisted on tickets.price
    if (entryN < 0 || coverN < 0) {
      setError('Entry and Cover charges cannot be negative.');
      return;
    }
    if (!phone) { setError('Mobile number is required.'); return; }

    const full = phone; // E.164 from PhoneInput

    setBusy(true);
    try {
      const res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          customerName: name.trim(),
          customerPhone: full,
          customerGender: gender,
          customerNotes: customerNotes.trim() || null,
          ticketName: ticketName.trim(),
          category,
          pax: paxN,
          ticketNotes: ticketNotes.trim() || null,
          internalNotes: internalNotes.trim() || null,
          price: priceN,
          paidOffline,
          complimentary,
          // M/F/C breakdown — persisted to male_count/female_count/couple_count.
          genderMix: { male, female, couple: couples },
          // Entry/cover split — server stores both on the ticket row and
          // splits them into the wallet (entryFee + coverIssued) so the QR
          // pass shows cover as the spendable balance honestly.
          entryAmount: entryN,
          coverAmount: coverN,
        }),
      });
      const data = await res.json();
      if (!data.ok) { setError(data.message); return; }
      // Build a one-line flash that surfaces BOTH the ticket save AND the
      // auto-issued wallet status. The wallet kind ('cover' | 'entry_only')
      // determines whether the QR carries a redeemable balance or just door
      // entry — copy reflects that so the host confirms they issued the
      // right kind.
      //
      // Branch matrix:
      //   - cover + WhatsApp queued      → "Cover ₹X sent on WhatsApp"
      //   - cover + WhatsApp off         → "Cover ₹X · QR Code ID NNNN"
      //   - entry_only + WhatsApp queued → "Entry pass sent on WhatsApp"
      //   - entry_only + WhatsApp off    → "Entry pass · QR Code ID NNNN"
      //   - wallet missing               → "wallet pending — issue manually"
      const w = data.wallet as {
        pin?: string;
        balance?: number;
        whatsappQueued?: boolean;
        kind?: 'cover' | 'entry_only';
      } | null;
      let flash = `✓ Ticket "${data.ticket.ticket_name}" issued to ${data.ticket.customer_name}`;
      if (w?.pin) {
        const isCover = w.kind === 'cover';
        const label = isCover
          ? `Cover ₹${(w.balance ?? 0).toLocaleString('en-IN')}`
          : 'Entry pass';
        // "queued", not "sent": the send is deliberately fire-and-forget so it
        // can't delay this response, which means the outcome isn't known yet.
        // It can still skip downstream (no phone number on the wallet, Interakt
        // not configured, or — for an entry-only pass — no 2-variable template
        // approved yet). Check Settings → WhatsApp, or the audit log, for what
        // actually went out.
        flash += w.whatsappQueued
          ? ` · ${label} queued for WhatsApp`
          : ` · ${label} · QR Code ID ${w.pin.slice(-4)}`;
      } else {
        flash += ` (wallet not auto-issued — visit Issue Cover)`;
      }
      flash += '.';
      showFlash(flash);
      resetForm();
      refreshTickets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setBusy(false);
    }
  }

  const revenue = useMemo(() => {
    return tickets
      .filter((t) => t.status === 'issued' && t.paid_offline)
      .reduce((sum, t) => sum + (t.price || 0), 0);
  }, [tickets]);

  const compCount = useMemo(
    () => tickets.filter((t) => t.status === 'issued' && t.complimentary).length,
    [tickets],
  );
  const totalIssued = useMemo(
    () => tickets.filter((t) => t.status === 'issued').length,
    [tickets],
  );

  const fullPhoneForBooking = phone; // E.164 from PhoneInput

  return (
    <div className="max-w-4xl mx-auto px-6 md:px-8 py-6">
      <div>
        <div className="text-[11px] tracking-widest uppercase text-slate-500">Door</div>
        <h2 className="text-xl font-semibold text-slate-900 mt-1">Offline Ticketing</h2>
        <p className="text-sm text-slate-500 mt-1">
          Issue guest list, walk-in, paid-offline, and complimentary entries for an upcoming event.
        </p>
      </div>

      {flash && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 px-3 py-2 text-sm">
          {flash}
        </div>
      )}

      <form onSubmit={submit} className="card mt-6 space-y-5">
        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 px-3 py-2 text-sm">
            {error}
          </div>
        )}

        {/* Event */}
        <FormRow label={<>Event <Star /></>}>
          {loadingEvents ? (
            <div className="text-sm text-slate-500">Loading events…</div>
          ) : events.length === 0 ? (
            <div className="text-sm text-slate-500">
              No upcoming events.{' '}
              <Link href="/admin/events" className="text-brand-600 hover:text-brand-700 font-medium">Create one →</Link>
            </div>
          ) : (
            <select
              className="input"
              value={eventId}
              onChange={(e) => setEventId(e.target.value)}
              required
            >
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.event_date} · {ev.name}
                </option>
              ))}
            </select>
          )}
        </FormRow>

        {/* Mobile Number + Load */}
        <FormRow label={<>Mobile Number <Star /></>}>
          {/* Stack on mobile (Load button below) so the PhoneInput gets the
              full row width and the country dropdown + national number both
              have room. Side-by-side again from md+ where horizontal space is
              ample. */}
          <div className="flex flex-col sm:flex-row gap-2">
            <PhoneInput
              value={phone}
              onChange={setPhone}
              placeholder="10-digit number"
              className="flex-1"
              required
            />
            <button
              type="button"
              onClick={loadCustomer}
              disabled={loadingCustomer || !phone}
              className="btn btn-primary px-6 sm:flex-shrink-0"
            >
              {loadingCustomer ? '…' : 'Load'}
            </button>
          </div>
          {lookup?.found && (
            <div className="mt-1.5 text-xs text-emerald-700">
              Returning customer · last seen {relativeTime(lookup.lastSeenAt!)}
            </div>
          )}
          {lookup && !lookup.found && (
            <div className="mt-1.5 text-xs text-slate-500">
              New customer — name pre-filled with phone, please edit below.
            </div>
          )}
        </FormRow>

        {step === 'details' && (
          <>
            <FormRow label={<>Name <Star /></>}>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Customer name"
              />
            </FormRow>

            <FormRow label={<>Gender <Star /></>}>
              <div className="flex gap-5 items-center pt-1.5">
                {(['male', 'female', 'other'] as Gender[]).map((g) => (
                  <label key={g} className="flex items-center gap-2 cursor-pointer text-sm">
                    <input
                      type="radio"
                      name="gender"
                      value={g}
                      checked={gender === g}
                      onChange={() => setGender(g)}
                      className="accent-brand-500"
                    />
                    <span className="text-slate-700 capitalize">{g === 'other' ? 'Others' : g}</span>
                  </label>
                ))}
              </div>
            </FormRow>

            <FormRow label="Notes">
              <input
                className="input"
                value={customerNotes}
                onChange={(e) => setCustomerNotes(e.target.value)}
                placeholder="Enter notes"
              />
            </FormRow>

            <FormRow label="Ticketing Revenue">
              <div className="text-slate-900 font-semibold py-2">{formatMoney(revenue)}</div>
              <div className="text-xs text-slate-500 -mt-1">
                {totalIssued} ticket(s) issued · {compCount} complimentary
              </div>
            </FormRow>

            <div className="h-px bg-slate-200 my-2" />

            <FormRow label={<>Ticket Name <Star /></>}>
              <input
                className="input"
                value={ticketName}
                onChange={(e) => setTicketName(e.target.value)}
                placeholder="e.g. Guest List, VIP, Comp Pass"
              />
            </FormRow>

            <FormRow label="">
              <div className="flex gap-6 items-center -mt-2">
                {(['guest_list', 'walk_in'] as TicketCategory[]).map((c) => (
                  <label key={c} className="flex items-center gap-2 cursor-pointer text-sm">
                    <input
                      type="radio"
                      name="category"
                      value={c}
                      checked={category === c}
                      onChange={() => setCategory(c)}
                      className="accent-brand-500"
                    />
                    <span className="text-slate-700">{c === 'guest_list' ? 'Guest List' : 'Walk-In'}</span>
                  </label>
                ))}
              </div>
            </FormRow>

            {/* PAX is auto-derived from M + F + 2C above — removed the
                input entirely so the operator can't enter an inconsistent
                value. The Guest Mix row already shows the running total. */}

            <FormRow label="Ticket Notes">
              <input
                className="input"
                value={ticketNotes}
                onChange={(e) => setTicketNotes(e.target.value)}
                placeholder="Enter notes (visible to customer)"
              />
            </FormRow>

            <FormRow label="Internal Notes">
              <input
                className="input"
                value={internalNotes}
                onChange={(e) => setInternalNotes(e.target.value)}
                placeholder="Enter internal notes (not visible to customer)"
              />
            </FormRow>

            {/* Guest mix — M/F/C steppers. Pax + cover are auto-derived from
                M + F + 2C and the selected event's per-category cover rates.
                Entry is auto-derived as entry_fee_per_person × pax. Operator
                can edit either Entry or Cover individually below. */}
            <FormRow label="Guest mix">
              <MfcSteppers
                event={selectedEvent}
                male={male} female={female} couples={couples}
                onMale={bumpMale} onFemale={bumpFemale} onCouple={bumpCouple}
                disabled={complimentary}
                derivedPax={derivedPax}
                autoEntry={autoEntry}
                autoCover={autoCover}
              />
            </FormRow>

            {/* Split Entry vs Cover. Entry is the sunk door fee (kept by the
                venue, not redeemable). Cover becomes the wallet's spendable
                balance at the bar. Each field can be edited independently;
                changing a stepper resets both back to auto-calc. */}
            <FormRow label="Charges">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <div className="text-[11px] font-medium text-slate-500 mb-1">
                    Entry charge <span className="text-slate-400">(door, sunk)</span>
                  </div>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">₹</span>
                    <input
                      className="input pl-8"
                      type="number"
                      min={0}
                      step="0.01"
                      value={entryInputValue}
                      onChange={(e) => setEntryOverride(e.target.value)}
                      disabled={complimentary}
                    />
                  </div>
                  {!complimentary && entryOverride !== null && Number(entryOverride) !== autoEntry && (
                    <div className="text-[10px] text-amber-700 mt-1">
                      Manual · auto-calc ₹{autoEntry.toLocaleString('en-IN')}.{' '}
                      <button type="button" onClick={() => setEntryOverride(null)} className="underline hover:text-amber-900">Reset</button>
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-[11px] font-medium text-slate-500 mb-1">
                    Cover charge <span className="text-slate-400">(bar credit)</span>
                  </div>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-emerald-600">₹</span>
                    <input
                      className="input pl-8"
                      type="number"
                      min={0}
                      step="0.01"
                      value={coverInputValue}
                      onChange={(e) => setCoverOverride(e.target.value)}
                      disabled={complimentary}
                    />
                  </div>
                  {!complimentary && coverOverride !== null && Number(coverOverride) !== autoCover && (
                    <div className="text-[10px] text-amber-700 mt-1">
                      Manual · auto-calc ₹{autoCover.toLocaleString('en-IN')}.{' '}
                      <button type="button" onClick={() => setCoverOverride(null)} className="underline hover:text-amber-900">Reset</button>
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-3 flex items-baseline justify-between border-t border-slate-100 pt-2">
                <div className="text-xs text-slate-500">
                  Total charged
                </div>
                <div className="text-base font-bold text-slate-900 font-mono">
                  {complimentary ? '₹0' : `₹${effectiveTotal.toLocaleString('en-IN')}`}
                </div>
              </div>

              <div className="flex gap-3 items-center flex-wrap mt-3">
                <label className="flex items-center gap-2 cursor-pointer text-sm whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={paidOffline}
                    onChange={(e) => togglePaid(e.target.checked)}
                    className="accent-brand-500 w-4 h-4"
                  />
                  <span className="text-slate-700">Paid Offline</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-sm whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={complimentary}
                    onChange={(e) => toggleComp(e.target.checked)}
                    className="accent-brand-500 w-4 h-4"
                  />
                  <span className="text-slate-700">Complimentary</span>
                </label>
              </div>

              {complimentary && (
                <div className="text-[11px] text-emerald-700 mt-2">
                  Complimentary — no charge. Ticket still becomes an Entry-only QR pass.
                </div>
              )}
            </FormRow>

            <div className="flex gap-3 pt-2">
              <Link
                href={`/admin/issue?phone=${encodeURIComponent(fullPhoneForBooking)}&name=${encodeURIComponent(name)}&eventId=${eventId}`}
                className="btn btn-secondary flex-1 text-center"
              >
                To Event Booking
              </Link>
              <button className="btn btn-primary flex-1" disabled={busy}>
                {busy ? 'Sending…' : 'Send'}
              </button>
            </div>
          </>
        )}
      </form>

      {/* Recent tickets for this event */}
      {eventId && tickets.length > 0 && (
        <div className="card mt-6">
          <div className="flex items-center justify-between">
            <div className="font-semibold text-slate-900">
              Recent tickets for this event
            </div>
            <div className="text-xs text-slate-500">{tickets.length} total</div>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="text-left text-slate-500 text-[11px] uppercase tracking-wider border-b border-slate-200">
                  <th className="pb-2 whitespace-nowrap">When</th>
                  <th className="pb-2">Customer</th>
                  <th className="pb-2 whitespace-nowrap">Ticket</th>
                  <th className="pb-2 whitespace-nowrap">Category</th>
                  <th className="pb-2 text-right whitespace-nowrap">PAX</th>
                  <th className="pb-2 text-right whitespace-nowrap">Price</th>
                  <th className="pb-2 whitespace-nowrap">Status</th>
                </tr>
              </thead>
              <tbody>
                {tickets.slice(0, 20).map((t) => (
                  <tr key={t.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2.5 text-slate-500 whitespace-nowrap">{relativeTime(t.created_at)}</td>
                    <td className="py-2.5 text-slate-900">
                      {t.customer_name}
                      <div className="text-xs text-slate-500 whitespace-nowrap">{t.customer_phone}</div>
                    </td>
                    <td className="py-2.5 text-slate-700 whitespace-nowrap">{t.ticket_name}</td>
                    <td className="py-2.5 text-slate-500 text-xs uppercase whitespace-nowrap">
                      {t.category === 'guest_list' ? 'Guest list' : 'Walk-in'}
                    </td>
                    <td className="py-2.5 text-right text-slate-700">
                      <div>{t.pax}</div>
                      {/* M/F/C pill — renders only when at least one category
                          counter was set on this ticket. Keeps the column
                          quiet for legacy / pre-feature rows. */}
                      {(Number(t.male_count ?? 0) +
                        Number(t.female_count ?? 0) +
                        Number(t.couple_count ?? 0)) > 0 && (
                        <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                          {Number(t.male_count ?? 0) > 0 && <span>{t.male_count}M</span>}
                          {Number(t.female_count ?? 0) > 0 && (
                            <span>{Number(t.male_count ?? 0) > 0 ? ' · ' : ''}{t.female_count}F</span>
                          )}
                          {Number(t.couple_count ?? 0) > 0 && (
                            <span>
                              {(Number(t.male_count ?? 0) > 0 || Number(t.female_count ?? 0) > 0) ? ' · ' : ''}
                              {t.couple_count}C
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 text-right text-slate-700 whitespace-nowrap">
                      {t.complimentary ? <span className="text-amber-700">Comp</span> : formatMoney(t.price)}
                    </td>
                    <td className="py-2.5 whitespace-nowrap">
                      <span className={`tag ${t.status === 'cancelled' ? 'tag-revoked' : 'tag-active'}`}>
                        {t.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function FormRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[160px,1fr] gap-2 lg:gap-4 lg:items-start">
      <div className="text-sm font-medium text-slate-700 lg:pt-2.5">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Star() {
  return <span className="text-rose-600">*</span>;
}

function istTodayISO(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date());
}

/* ────────────────────────────────────────────────────────────────────────
 * MfcSteppers — Male / Female / Couple counters with auto-calc summary
 *
 * Replaces the single-chip quick-pick UI with a three-stepper layout that
 * mirrors the public booking form. Each stepper:
 *   • Shows the category label + the per-head cover rate from the SELECTED
 *     event (e.g. "Male · ₹2000 per person")
 *   • Has − / + buttons + a number readout
 *   • Shows a running line subtotal (count × rate) so the operator sees
 *     "2 × ₹2000 = ₹4000" at a glance
 *
 * Summary strip at the bottom shows the totals the form will submit:
 *   PAX   = M + F + 2C
 *   COVER = M × male_stag + F × female_stag + C × couple
 *
 * When `disabled` (Complimentary checkbox is on) the steppers grey out and
 * the cover total visually shows "Complimentary — ₹0" so the operator can
 * tell at a glance that this ticket is comped even if the counts are set.
 *
 * Hides entirely when no event is selected OR the event has zero cover
 * rates across all three categories (e.g. paid-online-only events).
 * ──────────────────────────────────────────────────────────────────────── */
function MfcSteppers({
  event,
  male, female, couples,
  onMale, onFemale, onCouple,
  disabled,
  derivedPax,
  autoEntry,
  autoCover,
}: {
  event: Event | null;
  male: number; female: number; couples: number;
  onMale: (delta: number) => void;
  onFemale: (delta: number) => void;
  onCouple: (delta: number) => void;
  disabled?: boolean;
  derivedPax: number;
  autoEntry: number;
  autoCover: number;
}) {
  if (!event) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
        Select an event above to see the cover-rate breakdown.
      </div>
    );
  }
  const maleRate = Number(event.cover_rates?.male_stag) || 0;
  const femaleRate = Number(event.cover_rates?.female_stag) || 0;
  const coupleRate = Number(event.cover_rates?.couple) || 0;
  const noRates = maleRate <= 0 && femaleRate <= 0 && coupleRate <= 0;

  if (noRates) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
        This event has no cover rates configured. Set them in the Tickets section of the event wizard, then come back.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-2">
      <StepperRow
        label="Male"
        sub={`₹${maleRate.toLocaleString('en-IN')} per person`}
        count={male} unit={maleRate}
        onDec={() => onMale(-1)} onInc={() => onMale(+1)}
        disabled={disabled}
      />
      <StepperRow
        label="Female"
        sub={`₹${femaleRate.toLocaleString('en-IN')} per person`}
        count={female} unit={femaleRate}
        onDec={() => onFemale(-1)} onInc={() => onFemale(+1)}
        disabled={disabled}
      />
      <StepperRow
        label="Couple"
        sub={`₹${coupleRate.toLocaleString('en-IN')} per couple · 2 pax`}
        count={couples} unit={coupleRate}
        onDec={() => onCouple(-1)} onInc={() => onCouple(+1)}
        disabled={disabled}
      />
      <div className="border-t border-slate-200 pt-2 mt-1 space-y-0.5 text-xs">
        <div className="flex items-baseline justify-between">
          <div className="text-slate-500">
            <span className="font-semibold text-slate-700">{derivedPax}</span>{' '}
            {derivedPax === 1 ? 'guest' : 'guests'}
          </div>
          {disabled && (
            <span className="text-emerald-700 font-semibold font-mono">Complimentary · ₹0</span>
          )}
        </div>
        {!disabled && (
          <>
            <div className="flex items-baseline justify-between">
              <div className="text-slate-500">Entry (sunk)</div>
              <div className="font-mono text-slate-700">₹{autoEntry.toLocaleString('en-IN')}</div>
            </div>
            <div className="flex items-baseline justify-between">
              <div className="text-slate-500">Cover (redeemable)</div>
              <div className="font-mono text-emerald-700">₹{autoCover.toLocaleString('en-IN')}</div>
            </div>
            <div className="flex items-baseline justify-between border-t border-slate-100 pt-1 mt-0.5">
              <div className="text-slate-700 font-semibold">Total</div>
              <div className="font-mono text-slate-900 font-bold">
                ₹{(autoEntry + autoCover).toLocaleString('en-IN')}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StepperRow({
  label, sub, count, unit, disabled, onInc, onDec,
}: {
  label: string; sub: string; count: number; unit: number;
  disabled?: boolean; onInc: () => void; onDec: () => void;
}) {
  return (
    <div className="flex items-center gap-3 bg-white rounded-lg border border-slate-200 px-3 py-2">
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-semibold ${disabled ? 'text-slate-400' : 'text-slate-900'}`}>{label}</div>
        <div className="text-[11px] text-slate-500">{sub}</div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onDec}
          disabled={disabled || count === 0}
          aria-label={`Decrease ${label}`}
          className="w-7 h-7 rounded-md border border-slate-300 text-slate-600 text-sm font-semibold hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          −
        </button>
        <div className="min-w-[28px] text-center text-sm font-semibold text-slate-900 tabular-nums">
          {count}
        </div>
        <button
          type="button"
          onClick={onInc}
          disabled={disabled}
          aria-label={`Increase ${label}`}
          className="w-7 h-7 rounded-md border border-slate-300 text-slate-600 text-sm font-semibold hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          +
        </button>
      </div>
      <div className="min-w-[68px] text-right text-xs font-mono text-slate-600 tabular-nums">
        {count > 0 && !disabled ? `₹${(count * unit).toLocaleString('en-IN')}` : '—'}
      </div>
    </div>
  );
}
