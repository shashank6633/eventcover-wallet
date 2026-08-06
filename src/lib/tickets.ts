import { getDb } from './db';
import { nanoid } from 'nanoid';
import { logAudit } from './audit';
import { normalizePhone } from './users';

export type TicketCategory = 'guest_list' | 'walk_in';
export type TicketStatus = 'issued' | 'cancelled';
export type Gender = 'male' | 'female' | 'other';

export interface TicketRow {
  id: string;
  event_id: string;
  guest_id: string | null;
  customer_name: string;
  customer_phone: string;
  customer_gender: Gender | null;
  customer_notes: string | null;
  ticket_name: string;
  category: TicketCategory;
  pax: number;
  ticket_notes: string | null;
  internal_notes: string | null;
  price: number;
  paid_offline: number;
  complimentary: number;
  status: TicketStatus;
  created_at: number;
  created_by: string | null;
  // Auto-issued wallet pass txn id. Set by the offline-ticketing flow when
  // a wallet is issued alongside the ticket so the QR pass can be sent to
  // the guest's WhatsApp. NULL on rows created before this feature shipped
  // OR when wallet auto-issue is disabled.
  wallet_txn_id: string | null;
  // ─── M/F/C breakdown for parties with mixed cover categories ───────────
  // pax + price on this row already reflect the totals computed from these
  // counts × event.cover_rates. Stored separately so the door-staff list
  // can render "2M · 1F · 1C" and so future reconciliation can audit
  // "this ticket was for a Table-of-4 split 2M+2F".
  male_count: number | null;
  female_count: number | null;
  couple_count: number | null;
  // ─── Entry vs Cover split ──────────────────────────────────────────────
  // entry_amount: sunk door fee (NOT redeemable). Stored as the wallet's
  //               entryFee so reconciliation can audit "the venue collected
  //               ₹X in entry on this ticket".
  // cover_amount: redeemable bar credit. Stored as the wallet's coverIssued
  //               so the QR pass shows this as the spendable balance.
  // price        remains the grand total (entry + cover) for the list view.
  entry_amount: number | null;
  cover_amount: number | null;
}

export interface Ticket extends Omit<TicketRow, 'paid_offline' | 'complimentary'> {
  paid_offline: boolean;
  complimentary: boolean;
}

/**
 * Set the wallet_txn_id back on a ticket row after the wallet has been
 * issued. Called by the /api/tickets route once issueWallet() succeeds
 * so the linkage is auditable + future "resend pass" calls can find the
 * existing wallet instead of issuing a duplicate.
 */
export function attachWalletToTicket(ticketId: string, walletTxnId: string): void {
  const db = getDb();
  db.prepare('UPDATE tickets SET wallet_txn_id = ? WHERE id = ?').run(walletTxnId, ticketId);
}

function toTicket(row: TicketRow): Ticket {
  return {
    ...row,
    paid_offline: !!row.paid_offline,
    complimentary: !!row.complimentary,
  };
}

export function listTicketsForEvent(eventId: string): Ticket[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM tickets WHERE event_id = ? ORDER BY created_at DESC
  `).all(eventId) as TicketRow[];
  return rows.map(toTicket);
}

export function getTicket(id: string): Ticket | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined;
  return row ? toTicket(row) : null;
}

export interface CreateTicketInput {
  eventId: string;
  customerName: string;
  customerPhone: string;
  customerGender?: Gender | null;
  customerNotes?: string | null;
  ticketName: string;
  category: TicketCategory;
  pax: number;
  ticketNotes?: string | null;
  internalNotes?: string | null;
  price: number;
  paidOffline: boolean;
  complimentary: boolean;
  createdBy: string;
  // Optional M/F/C breakdown. When provided, pax + price on the row
  // already reflect the totals (caller is responsible). Stored as-is so
  // the admin list + audit can render the per-category split. All three
  // default 0 — back-compat with callers that don't supply them.
  maleCount?: number;
  femaleCount?: number;
  coupleCount?: number;
  // Optional explicit entry/cover split. When supplied, persisted to
  // entry_amount + cover_amount; callers responsible for sum === price.
  // Omit to let the row store entry=0, cover=0 (legacy single-price model
  // — price is the only number persisted, like before the split).
  entryAmount?: number;
  coverAmount?: number;
}

export function createTicket(input: CreateTicketInput): Ticket {
  // Validation
  if (!input.eventId) throw new Error('Event is required.');
  if (!input.customerName?.trim()) throw new Error('Customer name is required.');
  if (!input.customerPhone?.trim()) throw new Error('Mobile number is required.');
  if (!input.ticketName?.trim()) throw new Error('Ticket name is required.');
  if (!['guest_list', 'walk_in'].includes(input.category)) {
    throw new Error('Category must be "guest_list" or "walk_in".');
  }
  if (input.customerGender && !['male', 'female', 'other'].includes(input.customerGender)) {
    throw new Error('Gender must be male, female, or other.');
  }
  if (!Number.isFinite(input.pax) || input.pax < 1) throw new Error('PAX must be at least 1.');
  if (!Number.isFinite(input.price) || input.price < 0) throw new Error('Price must be ≥ 0.');
  if (input.paidOffline && input.complimentary) {
    throw new Error('A ticket cannot be both paid offline and complimentary.');
  }
  // A comp is "the venue gave this away". Guarding `price` alone was not enough:
  // price is only the LIST total, while entry_amount + cover_amount are what the
  // wallet is actually funded with downstream (api/tickets/route.ts computes
  // hasSplit from them and passes cover_amount straight into issueWallet as
  // spendable balance). So {price: 0, complimentary: true, coverAmount: 5000}
  // used to book as a ₹0 comp in every revenue report and in affiliate
  // attribution — both key off ticket.price — while minting ₹5,000 of
  // redeemable bar credit. The admin UI can't produce that (it derives
  // price = entry + cover client-side, so the price guard already caught it);
  // the hole was API-only, reachable by the lowest 'entry' role, and that is
  // exactly the surface the akan-events-app proxy posts to.
  //
  // INVARIANT: complimentary ⇒ price === 0 AND entry_amount === 0 AND
  // cover_amount === 0. A funded giveaway must not ride in on a ₹0 comp — it
  // needs its own explicitly-gated field and audit action.
  const compEntry = Number(input.entryAmount ?? 0);
  const compCover = Number(input.coverAmount ?? 0);
  if (input.complimentary && (input.price > 0 || compEntry > 0 || compCover > 0)) {
    throw new Error('Complimentary tickets must have price, entry and cover all 0.');
  }

  const db = getDb();
  const id = nanoid();
  const phone = normalizePhone(input.customerPhone);

  // Resolve or create guest record (so customers persist for future lookups)
  let guestId: string | null = null;
  const existingGuest = db.prepare('SELECT id FROM guests WHERE phone = ? ORDER BY created_at DESC LIMIT 1').get(phone) as { id: string } | undefined;
  if (existingGuest) {
    guestId = existingGuest.id;
  } else {
    guestId = nanoid();
    db.prepare(`
      INSERT INTO guests (id, name, phone, email, pax, source, created_at)
      VALUES (?, ?, ?, NULL, ?, 'offline_ticket', ?)
    `).run(guestId, input.customerName.trim(), phone, input.pax, Date.now());
  }

  // M/F/C breakdown — non-negative ints. Callers that don't supply them
  // (legacy admin scripts) write zeros and read back as zero, which renders
  // as no pill in the list. The pax + price coming in are already the totals;
  // we do NOT recompute here — that math is the caller's responsibility so
  // the ticket reflects exactly what the operator confirmed at submit.
  const mc = Math.max(0, Math.floor(Number(input.maleCount ?? 0)));
  const fc = Math.max(0, Math.floor(Number(input.femaleCount ?? 0)));
  const cc = Math.max(0, Math.floor(Number(input.coupleCount ?? 0)));
  // Entry/cover split — default to 0 each when caller doesn't pass them
  // (legacy single-price callers). When BOTH are 0 but price > 0, the
  // wallet auto-issue downstream treats the whole price as cover (matches
  // the prior semantics so back-compat holds).
  const entryAmt = Math.max(0, Number(input.entryAmount ?? 0));
  const coverAmt = Math.max(0, Number(input.coverAmount ?? 0));

  db.prepare(`
    INSERT INTO tickets (
      id, event_id, guest_id, customer_name, customer_phone, customer_gender,
      customer_notes, ticket_name, category, pax, ticket_notes, internal_notes,
      price, paid_offline, complimentary, status, created_at, created_by,
      male_count, female_count, couple_count,
      entry_amount, cover_amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.eventId, guestId,
    input.customerName.trim(), phone, input.customerGender ?? null,
    (input.customerNotes ?? '').trim() || null,
    input.ticketName.trim(), input.category, input.pax,
    (input.ticketNotes ?? '').trim() || null,
    (input.internalNotes ?? '').trim() || null,
    input.price, input.paidOffline ? 1 : 0, input.complimentary ? 1 : 0,
    Date.now(), input.createdBy,
    mc, fc, cc,
    entryAmt, coverAmt,
  );

  logAudit({
    actor: input.createdBy, action: 'ticket_create', entityType: 'ticket', entityId: id,
    details: {
      event_id: input.eventId, name: input.ticketName, category: input.category,
      pax: input.pax, price: input.price, comp: input.complimentary,
    },
  });

  return getTicket(id)!;
}

export function cancelTicket(id: string, actor: string): Ticket | null {
  const db = getDb();
  const existing = getTicket(id);
  if (!existing) return null;
  if (existing.status === 'cancelled') return existing;
  db.prepare("UPDATE tickets SET status = 'cancelled' WHERE id = ?").run(id);
  logAudit({ actor, action: 'ticket_cancel', entityType: 'ticket', entityId: id });
  return getTicket(id);
}

export interface CustomerLookupResult {
  found: boolean;
  name?: string;
  email?: string | null;
  gender?: Gender | null;
  lastSeenAt?: number;
}

/**
 * Look up a customer by phone across guests + tickets + wallets to pre-fill the form.
 * Returns the most recent name + (if available) gender for instant prefill on "Load".
 */
export function lookupCustomerByPhone(phone: string): CustomerLookupResult {
  const db = getDb();
  const normalized = normalizePhone(phone);
  if (!normalized) return { found: false };

  // Prefer most recent ticket (richest data — has gender)
  const ticket = db.prepare(`
    SELECT customer_name, customer_gender, created_at
    FROM tickets WHERE customer_phone = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(normalized) as { customer_name: string; customer_gender: Gender | null; created_at: number } | undefined;
  if (ticket) {
    return {
      found: true,
      name: ticket.customer_name,
      gender: ticket.customer_gender,
      lastSeenAt: ticket.created_at,
    };
  }

  // Fall back to guests table (used by wallets + reservations)
  const guest = db.prepare(`
    SELECT name, email, created_at FROM guests WHERE phone = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(normalized) as { name: string; email: string | null; created_at: number } | undefined;
  if (guest) {
    return {
      found: true,
      name: guest.name,
      email: guest.email,
      lastSeenAt: guest.created_at,
    };
  }

  return { found: false };
}
