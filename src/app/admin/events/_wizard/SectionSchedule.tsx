'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { WizardState } from './types';

/**
 * Schedule section (Phase 3 — multi-slot).
 *
 * Keeps the primary `event_date` + `start_time` as the back-compat fallback:
 * if there are zero active slots, public bookings still use those columns.
 * When the operator adds one or more slots, the public form shows a slot
 * picker and capacity is enforced server-side.
 *
 * Server contract — matches the Phase 3 architect spec:
 *   GET    /api/events/[id]/slots                       → { ok: true, slots: Slot[] }
 *   POST   /api/events/[id]/slots                       → { ok: true, slot: Slot }
 *   PATCH  /api/events/[id]/slots { orderedIds: [] }    → { ok: true, slots: Slot[] }  (bulk reorder)
 *   PATCH  /api/events/[id]/slots/[slotId]              → { ok: true, slot: Slot }
 *   DELETE /api/events/[id]/slots/[slotId]              → { ok: true } | 409 { attached }
 *
 * Slots are reorderable via HTML5 drag-and-drop on the grip handle and use
 * optimistic UI with rollback on failure (mirrors SectionCoupons pattern).
 *
 * The cutoff hour (when wallets expire after the event date) is still
 * managed via the Tickets section since it's part of the cover-expiry
 * policy, not the schedule itself.
 */

interface Props {
  state: WizardState;
  onChange: (patch: Partial<WizardState>) => void;
}

interface Slot {
  id: string;
  event_id: string;
  slot_date: string;       // YYYY-MM-DD
  start_time: string;      // HH:MM
  end_time: string | null; // HH:MM | null
  label: string | null;
  max_capacity: number | null;
  used_capacity?: number;  // included by GET only
  sort_order: number;
  active: 0 | 1 | boolean;
  created_at: number;
}

export function SectionSchedule({ state, onChange }: Props) {
  // The wizard URL is /admin/events?edit=<eventId>&section=schedule.
  const params = useSearchParams();
  const eventId = params.get('edit');

  return (
    <div className="card space-y-5">
      <header>
        <h2 className="text-lg font-semibold text-slate-900">Schedule</h2>
        <p className="text-sm text-slate-500 mt-1">
          When the event happens. Customers see this on the public page and in WhatsApp confirmations.
        </p>
      </header>

      {/* Primary date + start time — the fallback when no slots are configured */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="label">
            Event Date <span className="text-rose-600">*</span>
          </label>
          <input
            className="input"
            type="date"
            value={state.event_date}
            onChange={(e) => onChange({ event_date: e.target.value })}
          />
        </div>
        <div>
          <label className="label">Start Time</label>
          <input
            className="input"
            type="time"
            value={state.start_time}
            onChange={(e) => onChange({ start_time: e.target.value })}
          />
          <div className="text-[11px] text-slate-400 mt-1">
            Local time (Asia/Kolkata).
          </div>
        </div>
      </div>

      {/* Recurring flag — display metadata for the customer site, not a scheduler */}
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={state.is_recurring}
          onChange={(e) => onChange({ is_recurring: e.target.checked })}
          className="accent-brand-500 w-4 h-4 mt-0.5"
        />
        <span>
          <span className="text-sm font-medium text-slate-800">Recurring event</span>
          <span className="block text-[11px] text-slate-500">
            Shows a &ldquo;Recurring&rdquo; chip on the public site. It does not create
            repeat instances automatically — add each date as its own event.
          </span>
        </span>
      </label>

      {/* Slot manager — only renders once the event has been saved */}
      <SlotsManager eventId={eventId} />
    </div>
  );
}

// ─── Slot manager ──────────────────────────────────────────────────────────

function SlotsManager({ eventId }: { eventId: string | null }) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Drag-and-drop state.
  const dragId = useRef<string | null>(null);
  const dragOverId = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(eventId)}/slots`, {
        cache: 'no-store',
      });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.error || 'Failed to load slots.');
      const list: Slot[] = Array.isArray(d.slots) ? d.slots : [];
      // Sort defensively by sort_order then created_at.
      list.sort((a, b) => {
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        return a.created_at - b.created_at;
      });
      setSlots(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load slots.');
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => { void load(); }, [load]);

  // ─── Mutations ────────────────────────────────────────────────────────────

  async function addSlot() {
    if (!eventId || adding) return;
    setAdding(true);
    setError(null);

    // Server runs assertDate/assertTime on POST body and rejects empty strings.
    // Seed with today's date + a sensible default start time so the slot
    // persists; user can adjust inline via PATCH.
    const todayIso = new Date().toISOString().slice(0, 10);
    const defaultStart = '20:00';

    // Optimistic: insert a placeholder row at the bottom so the user gets
    // immediate feedback. If the server rejects we roll it back.
    const tempId = `tmp-${Date.now()}`;
    const nextSortOrder =
      slots.reduce((max, s) => Math.max(max, s.sort_order), -1) + 1;
    const optimistic: Slot = {
      id: tempId,
      event_id: eventId,
      slot_date: todayIso,
      start_time: defaultStart,
      end_time: null,
      label: null,
      max_capacity: null,
      used_capacity: 0,
      sort_order: nextSortOrder,
      active: 1,
      created_at: Date.now(),
    };
    setSlots((cur) => [...cur, optimistic]);

    try {
      const res = await fetch(`/api/events/${encodeURIComponent(eventId)}/slots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Server auto-computes sort_order = MAX+1, so we don't send it.
        // slot_date + start_time must pass the date/time regex.
        body: JSON.stringify({
          slot_date: todayIso,
          start_time: defaultStart,
        }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.error || d.message || 'Failed to add slot.');
      // Replace temp row with the server-issued one.
      setSlots((cur) => cur.map((s) => (s.id === tempId ? (d.slot as Slot) : s)));
    } catch (e) {
      // Roll back optimistic insert.
      setSlots((cur) => cur.filter((s) => s.id !== tempId));
      setError(e instanceof Error ? e.message : 'Failed to add slot.');
    } finally {
      setAdding(false);
    }
  }

  async function patchSlot(slot: Slot, patch: Partial<Slot>) {
    if (!eventId) return;

    // Optimistic update.
    const previous = slot;
    setSlots((cur) => cur.map((s) => (s.id === slot.id ? { ...s, ...patch } : s)));
    setBusyId(slot.id);
    setError(null);

    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/slots/${encodeURIComponent(slot.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        },
      );
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.error || 'Failed to update slot.');
      if (d.slot) {
        // Reconcile with server-authoritative row (preserve used_capacity).
        setSlots((cur) =>
          cur.map((s) =>
            s.id === slot.id
              ? { ...(d.slot as Slot), used_capacity: s.used_capacity }
              : s,
          ),
        );
      }
    } catch (e) {
      // Roll back.
      setSlots((cur) => cur.map((s) => (s.id === slot.id ? previous : s)));
      setError(e instanceof Error ? e.message : 'Failed to update slot.');
    } finally {
      setBusyId(null);
    }
  }

  async function deleteSlot(slot: Slot) {
    if (!eventId) return;
    const isTemp = slot.id.startsWith('tmp-');
    if (
      !isTemp &&
      !confirm(
        `Delete this slot?\n\nIf any bookings reference it, the server will refuse — deactivate the slot instead to preserve history.`,
      )
    ) {
      return;
    }

    // Optimistic remove.
    const snapshot = slots;
    setSlots((cur) => cur.filter((s) => s.id !== slot.id));
    setBusyId(slot.id);
    setError(null);

    if (isTemp) {
      // Was never persisted; nothing to call.
      setBusyId(null);
      return;
    }

    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/slots/${encodeURIComponent(slot.id)}`,
        { method: 'DELETE' },
      );
      const d = await res.json();

      // Slot has reservations attached — the server returns 409 with
      // { ok: false, message, attached }. The architect-prescribed UX is
      // to offer the soft-deactivate fallback (PATCH { active: false })
      // so the slot stays visible in history but stops accepting new
      // bookings. On confirm, fire the PATCH and mark active=false in
      // local state. On cancel, restore the snapshot.
      const attached = typeof d?.attached === 'number' ? d.attached : 0;
      if (res.status === 409 || attached > 0) {
        const ok = confirm(
          `${attached} reservation(s) reference this slot. Deactivate it instead? ` +
          `It will stop accepting new bookings but stay visible in history.`,
        );
        if (!ok) {
          // User declined the fallback — restore the slot in the list.
          setSlots(snapshot);
          return;
        }
        const patchRes = await fetch(
          `/api/events/${encodeURIComponent(eventId)}/slots/${encodeURIComponent(slot.id)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: false }),
          },
        );
        const patchD = await patchRes.json();
        if (!patchRes.ok || !patchD.ok) {
          throw new Error(patchD.error || patchD.message || 'Failed to deactivate slot.');
        }
        // Reconcile: keep the slot visible but flag it inactive. Prefer the
        // server-authoritative row if returned, else fall back to the
        // snapshot row patched in place.
        const updatedSlot: Slot = patchD.slot
          ? { ...(patchD.slot as Slot), used_capacity: slot.used_capacity }
          : { ...slot, active: 0 };
        setSlots(snapshot.map((s) => (s.id === slot.id ? updatedSlot : s)));
        return;
      }

      if (!res.ok || !d.ok) throw new Error(d.error || d.message || 'Failed to delete slot.');
    } catch (e) {
      // Roll back.
      setSlots(snapshot);
      setError(e instanceof Error ? e.message : 'Failed to delete slot.');
    } finally {
      setBusyId(null);
    }
  }

  async function commitReorder(orderedIds: string[]) {
    if (!eventId) return;
    setError(null);
    try {
      // Server exposes PATCH /api/events/[id]/slots with body { orderedIds }.
      // (There is no /reorder sub-route; using POST { ids } produced 404s.)
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/slots`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderedIds }),
        },
      );
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.error || d.message || 'Failed to reorder slots.');
    } catch (e) {
      // Re-load from server to undo any client-side reordering on failure.
      setError(e instanceof Error ? e.message : 'Failed to reorder slots.');
      await load();
    }
  }

  // ─── DnD handlers ────────────────────────────────────────────────────────

  function handleDragStart(id: string) {
    dragId.current = id;
  }

  function handleDragOver(e: React.DragEvent, id: string) {
    e.preventDefault();
    dragOverId.current = id;
  }

  function handleDrop() {
    const from = dragId.current;
    const to = dragOverId.current;
    dragId.current = null;
    dragOverId.current = null;
    if (!from || !to || from === to) return;

    // Skip when either id is still a temp/unsaved row — reorder only makes
    // sense for persisted slots.
    if (from.startsWith('tmp-') || to.startsWith('tmp-')) return;

    const snapshot = slots;
    const next = [...slots];
    const fromIdx = next.findIndex((s) => s.id === from);
    const toIdx = next.findIndex((s) => s.id === to);
    if (fromIdx === -1 || toIdx === -1) return;

    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);

    // Re-stamp sort_order optimistically.
    const reSorted = next.map((s, i) => ({ ...s, sort_order: i }));
    setSlots(reSorted);

    // Fire-and-forget; rollback handled inside commitReorder via load().
    void commitReorder(reSorted.map((s) => s.id)).catch(() => {
      setSlots(snapshot);
    });
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  if (!eventId) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5">
        <div className="text-sm font-semibold text-slate-700 mb-1">Time slots</div>
        <div className="text-xs text-slate-500">
          Save the event first to add multiple time slots (e.g. 7pm / 9pm / 11pm sessions).
        </div>
      </div>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-sm font-semibold text-slate-900">Time slots</div>
          <div className="text-[12px] text-slate-500">
            With zero slots, the primary date/time is used.
          </div>
        </div>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          onClick={addSlot}
          disabled={adding || !eventId}
        >
          {adding ? 'Adding…' : '+ Add another slot'}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 px-3 py-2 text-sm mb-3">
          {error}
        </div>
      )}

      {loading && slots.length === 0 ? (
        <div className="text-sm text-slate-500 py-6 text-center">Loading…</div>
      ) : slots.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-4 py-8 text-center">
          <div className="text-sm text-slate-600">
            No additional slots configured.
          </div>
          <div className="text-[12px] text-slate-400 mt-1">
            The primary date/time above is used for all bookings.
          </div>
        </div>
      ) : (
        <ul className="space-y-2">
          {slots.map((s) => (
            <SlotRow
              key={s.id}
              slot={s}
              busy={busyId === s.id}
              onPatch={(patch) => void patchSlot(s, patch)}
              onDelete={() => void deleteSlot(s)}
              onDragStart={() => handleDragStart(s.id)}
              onDragOver={(e) => handleDragOver(e, s.id)}
              onDrop={handleDrop}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── Slot row ──────────────────────────────────────────────────────────────

function SlotRow({
  slot,
  busy,
  onPatch,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  slot: Slot;
  busy: boolean;
  onPatch: (patch: Partial<Slot>) => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
}) {
  // Local controlled values so typing doesn't fire a PATCH on every keystroke.
  // We commit on blur (or when a field clearly settles, e.g. native date/time
  // pickers fire change after the picker closes).
  const [slotDate, setSlotDate] = useState(slot.slot_date);
  const [startTime, setStartTime] = useState(slot.start_time);
  const [endTime, setEndTime] = useState(slot.end_time ?? '');
  const [label, setLabel] = useState(slot.label ?? '');
  const [maxCap, setMaxCap] = useState<string>(
    slot.max_capacity == null ? '' : String(slot.max_capacity),
  );

  // Re-sync from props when the server returns an authoritative row.
  useEffect(() => { setSlotDate(slot.slot_date); }, [slot.slot_date]);
  useEffect(() => { setStartTime(slot.start_time); }, [slot.start_time]);
  useEffect(() => { setEndTime(slot.end_time ?? ''); }, [slot.end_time]);
  useEffect(() => { setLabel(slot.label ?? ''); }, [slot.label]);
  useEffect(() => {
    setMaxCap(slot.max_capacity == null ? '' : String(slot.max_capacity));
  }, [slot.max_capacity]);

  function commitDate() {
    if (slotDate !== slot.slot_date) onPatch({ slot_date: slotDate });
  }
  function commitStart() {
    if (startTime !== slot.start_time) onPatch({ start_time: startTime });
  }
  function commitEnd() {
    const next = endTime.trim() === '' ? null : endTime;
    if (next !== (slot.end_time ?? null)) onPatch({ end_time: next });
  }
  function commitLabel() {
    const next = label.trim() === '' ? null : label.trim();
    if (next !== (slot.label ?? null)) onPatch({ label: next });
  }
  function commitMaxCap() {
    const raw = maxCap.trim();
    if (raw === '') {
      if (slot.max_capacity != null) onPatch({ max_capacity: null });
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return;
    if (n !== slot.max_capacity) onPatch({ max_capacity: n });
  }

  const used = slot.used_capacity ?? 0;
  const capacityHint =
    slot.max_capacity == null
      ? used > 0
        ? `${used} booked`
        : null
      : `${used} / ${slot.max_capacity} booked`;
  const overCapacity =
    slot.max_capacity != null && used > slot.max_capacity;

  return (
    <li
      className={`rounded-xl border bg-white px-3 py-2.5 transition ${
        busy ? 'opacity-60' : ''
      } ${overCapacity ? 'border-rose-300' : 'border-slate-200'}`}
      draggable={!slot.id.startsWith('tmp-')}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-2 flex-wrap">
        {/* Drag handle */}
        <button
          type="button"
          className="cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 px-1 py-1"
          aria-label="Drag to reorder"
          title="Drag to reorder"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="6" r="1.6" />
            <circle cx="15" cy="6" r="1.6" />
            <circle cx="9" cy="12" r="1.6" />
            <circle cx="15" cy="12" r="1.6" />
            <circle cx="9" cy="18" r="1.6" />
            <circle cx="15" cy="18" r="1.6" />
          </svg>
        </button>

        {/* Date */}
        <div className="flex-1 min-w-[140px]">
          <label className="block text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">
            Date
          </label>
          <input
            className="input h-9 text-sm"
            type="date"
            value={slotDate}
            onChange={(e) => setSlotDate(e.target.value)}
            onBlur={commitDate}
            disabled={busy}
          />
        </div>

        {/* Start time */}
        <div className="w-[110px]">
          <label className="block text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">
            Start
          </label>
          <input
            className="input h-9 text-sm"
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            onBlur={commitStart}
            disabled={busy}
          />
        </div>

        {/* End time (optional) */}
        <div className="w-[110px]">
          <label className="block text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">
            End
          </label>
          <input
            className="input h-9 text-sm"
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            onBlur={commitEnd}
            disabled={busy}
            placeholder="—"
          />
        </div>

        {/* Label (optional) */}
        <div className="flex-1 min-w-[120px]">
          <label className="block text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">
            Label
          </label>
          <input
            className="input h-9 text-sm"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={commitLabel}
            disabled={busy}
            placeholder="e.g. Early show"
            maxLength={64}
          />
        </div>

        {/* Max capacity (optional) */}
        <div className="w-[110px]">
          <label className="block text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">
            Max cap
          </label>
          <input
            className="input h-9 text-sm"
            type="number"
            min={0}
            step={1}
            value={maxCap}
            onChange={(e) => setMaxCap(e.target.value)}
            onBlur={commitMaxCap}
            disabled={busy}
            placeholder="∞"
          />
        </div>

        {/* Delete */}
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="text-slate-400 hover:text-rose-600 p-1.5 disabled:opacity-50"
          aria-label="Remove slot"
          title="Remove slot"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {capacityHint && (
        <div
          className={`mt-1.5 text-[11px] ${
            overCapacity ? 'text-rose-600 font-medium' : 'text-slate-400'
          }`}
        >
          {overCapacity ? `Over capacity: ${capacityHint}` : capacityHint}
        </div>
      )}
    </li>
  );
}
