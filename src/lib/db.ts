import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { defaultEventDate } from './expiry';

// EVENTCOVER_DB_PATH lets a test or audit run point at a throwaway COPY of the
// database instead of the live one. Unset (the normal case, including
// production) it resolves to exactly the previous hardcoded path, so this
// changes nothing at runtime.
//
// This exists because there is otherwise no way to exercise a write path —
// issuing a wallet, redeeming cover — without mutating real venue data. An
// automated audit did precisely that and left 21 bogus wallets behind.
const DB_PATH = process.env.EVENTCOVER_DB_PATH
  ? path.resolve(process.env.EVENTCOVER_DB_PATH)
  : path.join(process.cwd(), 'data', 'eventcover.db');
const DB_DIR = path.dirname(DB_PATH);

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS guests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      pax INTEGER DEFAULT 1,
      source TEXT DEFAULT 'walk_in',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallets (
      txn_id TEXT PRIMARY KEY,
      guest_id TEXT NOT NULL REFERENCES guests(id),
      entry_fee REAL NOT NULL,
      cover_issued REAL NOT NULL,
      balance REAL NOT NULL,
      payment_method TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      pin_fail_count INTEGER DEFAULT 0,
      pin_locked_until INTEGER,
      status TEXT DEFAULT 'active',
      issued_by TEXT,
      issued_at INTEGER NOT NULL,
      checked_out_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_wallets_status ON wallets(status);
    CREATE INDEX IF NOT EXISTS idx_wallets_issued_at ON wallets(issued_at DESC);

    CREATE TABLE IF NOT EXISTS redemptions (
      id TEXT PRIMARY KEY,
      txn_id TEXT NOT NULL REFERENCES wallets(txn_id),
      amount REAL NOT NULL,
      balance_before REAL NOT NULL,
      balance_after REAL NOT NULL,
      captain TEXT NOT NULL,
      order_ref TEXT,
      notes TEXT,
      status TEXT DEFAULT 'success',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_redemptions_created ON redemptions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_redemptions_txn ON redemptions(txn_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp DESC);

    CREATE TABLE IF NOT EXISTS venues (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      city            TEXT NOT NULL,
      address         TEXT,
      google_maps_url TEXT,
      notes           TEXT,
      active          INTEGER DEFAULT 1,
      created_at      INTEGER NOT NULL,
      created_by      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_venues_active ON venues(active);

    CREATE TABLE IF NOT EXISTS artists (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      about       TEXT,
      social_url  TEXT,
      image_data  TEXT,
      active      INTEGER DEFAULT 1,
      created_at  INTEGER NOT NULL,
      created_by  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_artists_active ON artists(active);

    CREATE TABLE IF NOT EXISTS tickets (
      id              TEXT PRIMARY KEY,
      event_id        TEXT NOT NULL,
      guest_id        TEXT,
      customer_name   TEXT NOT NULL,
      customer_phone  TEXT NOT NULL,
      customer_gender TEXT,
      customer_notes  TEXT,
      ticket_name     TEXT NOT NULL,
      category        TEXT NOT NULL,
      pax             INTEGER NOT NULL DEFAULT 1,
      ticket_notes    TEXT,
      internal_notes  TEXT,
      price           REAL NOT NULL DEFAULT 0,
      paid_offline    INTEGER DEFAULT 0,
      complimentary   INTEGER DEFAULT 0,
      status          TEXT DEFAULT 'issued',
      created_at      INTEGER NOT NULL,
      created_by      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tickets_phone ON tickets(customer_phone);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

    /**
     * Paid bookings — distinct from "tickets" (offline guestlist/walk-in) and "wallets" (cover-spend).
     * A booking has many booking_items (each is an individual entry line OR a table line).
     */
    CREATE TABLE IF NOT EXISTS bookings (
      id              TEXT PRIMARY KEY,
      event_id        TEXT NOT NULL,
      customer_name   TEXT NOT NULL,
      customer_phone  TEXT NOT NULL,
      customer_email  TEXT,
      type            TEXT NOT NULL,          -- 'individual' | 'table' | 'mixed'
      total_pax       INTEGER NOT NULL DEFAULT 0,
      entry_total     REAL NOT NULL DEFAULT 0,
      table_entry_total REAL NOT NULL DEFAULT 0,
      cover_total     REAL NOT NULL DEFAULT 0,
      subtotal        REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      gst_amount      REAL NOT NULL DEFAULT 0,
      final_amount    REAL NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'confirmed' | 'cancelled'
      payment_method  TEXT,                              -- 'cash' | 'upi' | 'card' | 'online' | 'comp'
      notes           TEXT,
      created_at      INTEGER NOT NULL,
      created_by      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_event ON bookings(event_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings(customer_phone);
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);

    CREATE TABLE IF NOT EXISTS booking_items (
      id              TEXT PRIMARY KEY,
      booking_id      TEXT NOT NULL,
      kind            TEXT NOT NULL,          -- 'individual' | 'table'
      table_type_id   TEXT,
      table_type_name TEXT,                   -- denormalized snapshot
      table_capacity  INTEGER,                -- denormalized snapshot (may be overridden per-line)
      table_entry_fee REAL,                   -- denormalized snapshot
      male_count      INTEGER NOT NULL DEFAULT 0,
      female_count    INTEGER NOT NULL DEFAULT 0,
      couple_count    INTEGER NOT NULL DEFAULT 0,
      pax_occupied    INTEGER NOT NULL DEFAULT 0,
      entry_amount    REAL NOT NULL DEFAULT 0,
      cover_amount    REAL NOT NULL DEFAULT 0,
      item_total      REAL NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_booking_items_booking ON booking_items(booking_id);

    CREATE TABLE IF NOT EXISTS venue_tables (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      capacity INTEGER DEFAULT 4,
      zone TEXT,
      status TEXT DEFAULT 'open',
      active_wallet_txn TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tables_status ON venue_tables(status);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      event_date TEXT NOT NULL,
      status TEXT DEFAULT 'live',
      base_entry_fee REAL NOT NULL DEFAULT 0,
      cover_policy TEXT NOT NULL DEFAULT 'equal',
      cover_value REAL DEFAULT 100,
      pax_rules TEXT DEFAULT '[]',
      cutoff_hour INTEGER DEFAULT 2,
      notes TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
    CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      email TEXT,
      role TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);

    CREATE TABLE IF NOT EXISTS otp_codes (
      id              TEXT PRIMARY KEY,
      identifier      TEXT NOT NULL,
      identifier_type TEXT NOT NULL,
      user_id         TEXT,
      code_hash       TEXT NOT NULL,
      expires_at      INTEGER NOT NULL,
      attempts        INTEGER DEFAULT 0,
      used            INTEGER DEFAULT 0,
      created_at      INTEGER NOT NULL,
      ip              TEXT,
      user_agent      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_otp_identifier ON otp_codes(identifier, used, expires_at DESC);
    CREATE INDEX IF NOT EXISTS idx_otp_created ON otp_codes(created_at DESC);

    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id),
      provider TEXT NOT NULL,
      external_ref TEXT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      pax INTEGER DEFAULT 1,
      arrival_time TEXT,
      notes TEXT,
      status TEXT DEFAULT 'pending',
      converted_wallet_txn TEXT,
      synced_at INTEGER NOT NULL,
      raw TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reservations_event ON reservations(event_id);
    CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_reservations_provider_ref
      ON reservations(provider, external_ref) WHERE external_ref IS NOT NULL;
  `);

  migrate(db);

  const seed: [string, string][] = [
    ['VENUE_NAME', 'Demo Lounge'],
    ['EVENT_NAME', 'Saturday Night'],
    ['DEFAULT_ENTRY_FEE', '1500'],
    ['PIN_LENGTH', '6'],
    ['EVENT_CUTOFF_HOUR', '2'],
    ['EVENT_DATE', defaultEventDate(2)],
    ['SESSION_SECRET', nanoid(48)],
    ['RESERVATION_PROVIDER', 'reservego-mock'],
    ['OTP_PROVIDER', 'console'],          // 'console' | 'email' | 'whatsapp'
    ['OTP_TTL_SECONDS', '300'],            // 5 minutes
    ['OTP_MAX_ATTEMPTS', '5'],
    ['OTP_REQUEST_COOLDOWN_SECONDS', '60'],
    ['OTP_LENGTH', '6'],
    // Reservego webhook integration — Bearer-token shared secret. Auto-generated
    // on first boot; host can regenerate it from /admin/settings/reservego.
    ['RESERVEGO_WEBHOOK_SECRET', nanoid(40)],
    ['RESERVEGO_WEBHOOK_LAST_AT', '0'],
    ['RESERVEGO_WEBHOOK_LAST_ACTION', ''],
    ['RESERVEGO_WEBHOOK_LAST_STATUS', ''],
    // When 'true' (default), a webhook for a date with no matching event
    // auto-creates a draft event and attaches the reservation. When 'false',
    // missing event → 404 and Reservego's delivery is rejected.
    ['RESERVEGO_AUTO_CREATE_EVENTS', 'true'],
    // Meta Pixel + Conversions API (CAPI). PIXEL_ID is the public-facing
    // identifier; ACCESS_TOKEN is sensitive (masked by /api/config).
    // TEST_EVENT_CODE is optional — when set, server-side events show up in
    // Meta's Test Events tab for verification.
    ['META_PIXEL_ID', ''],
    ['META_CAPI_ACCESS_TOKEN', ''],
    ['META_TEST_EVENT_CODE', ''],
    // WhatsApp auto-send of wallet pass PNG. When '1', POST /api/wallets
    // fires Interakt with the cover_pass template right after issue.
    // Template name + language are configurable so different venues can
    // have their own approved templates.
    ['AUTO_SEND_WHATSAPP_PASS', '0'],
    ['WALLET_PASS_TEMPLATE', 'akan_cover_pass'],
    ['WALLET_PASS_TEMPLATE_LANG', 'en'],
    // Append wallet-view URL as {{3}}; flip to '0' for legacy 2-var templates.
    ['WALLET_PASS_TEMPLATE_INCLUDE_LINK', '1'],
    // TTL (days) for the wallet-view HMAC token embedded in the {{3}} URL.
    // Customers keep this link open as a "card" — longer than the pass PNG TTL.
    ['WALLET_VIEW_TOKEN_TTL_DAYS', '90'],
    // ─── Tier 1: free reservation confirmation (TEXT ONLY, no QR) ─────────
    // A guest who reserves without paying gets a plain text confirmation.
    // No QR and no attachment by design: there is no money on the booking,
    // so there is nothing to redeem and nothing worth protecting. Door staff
    // check them in by name/phone on /admin/scan.
    //
    // Default '0': nothing goes out until the venue has an approved
    // Interakt template. Flip to '1' after approval.
    ['AUTO_SEND_RESERVATION_CONFIRM', '0'],
    ['RESERVATION_CONFIRM_TEMPLATE', 'akan_reservation_confirm'],
    ['RESERVATION_CONFIRM_LANG', 'en'],
    // ─── Tiers 2 & 3: paid ticket / cover pass (PDF + QR) ─────────────────
    // Both ride the AUTO_SEND_WHATSAPP_PASS toggle above. They need TWO
    // separate approved templates because their variable counts differ, and
    // Meta silently drops a message whose value count doesn't match:
    //   cover (tier 3): 4 vars — name, event, amount, PIN
    //   entry (tier 2): 2 vars — name, event
    // The entry key is intentionally seeded BLANK. wallet-pass-pdf-send
    // refuses to send an entry-tier pass rather than fall back to the
    // 4-variable cover template, so an unset key is a visible skip with a
    // named reason instead of an invisible non-delivery.
    ['WALLET_PASS_PDF_TEMPLATE', 'akan_cover_pass_pdf'],
    ['WALLET_PASS_PDF_TEMPLATE_ENTRY', ''],
    ['WALLET_PASS_PDF_LANG', 'en'],
    // HMAC secret used by signed-url.ts. Auto-generated on first read if
    // blank — keep empty here so each install gets a unique value.
    ['INTERNAL_TOKEN_SECRET', ''],
    // Razorpay payment gateway. MODE switches between 'test' and 'live'
    // keypairs — the host should configure both sets and just flip the
    // switch when going live. WEBHOOK_SECRET is the shared secret Razorpay
    // signs webhook payloads with (Dashboard → Webhooks).
    ['RAZORPAY_MODE', 'test'],
    ['RAZORPAY_KEY_ID', ''],
    ['RAZORPAY_KEY_SECRET', ''],
    ['RAZORPAY_WEBHOOK_SECRET', ''],
    // ─── Event Insights — analytics + cart recovery ────────────────────────
    // ANALYTICS_IP_SALT_DAILY rotates lazily on first read after UTC midnight
    // (see event-analytics.ts). _UPDATED_AT tracks the last rotation epoch.
    // CART_RECOVERY_* tunables gate the auto-sweep side-effect on the
    // insights GET — keeps Interakt traffic under the 40 req/min cap.
    ['ANALYTICS_IP_SALT_DAILY', ''],
    ['ANALYTICS_IP_SALT_UPDATED_AT', '0'],
    ['CART_RECOVERY_SWEEP_INTERVAL_SECONDS', '300'],
    ['CART_RECOVERY_MAX_PER_SWEEP', '25'],
    ['CART_RECOVERY_DEFAULT_TEMPLATE', 'akan_cart_recovery'],
    // ─── Settings V2 — Brand + General + Finance ──────────────────────────
    // Brand Page → About (rich text) + Socials (JSON array of {kind,url}, ≤5)
    ['BRAND_ABOUT_HTML', ''],
    ['BRAND_SOCIAL_LINKS_JSON', '[]'],
    // Brand Page → Website
    ['VENUE_FAVICON_URL', ''],
    ['VENUE_PUBLIC_URL', ''],
    // General → Notifications
    ['WHATSAPP_BOOKING_ALERTS_ENABLED', '0'],
    ['SALE_WEBHOOK_URL', ''],
    // Finance → Bank Details (BANK_ACCOUNT_NUMBER masked by /api/config)
    ['BANK_ACCOUNT_HOLDER', ''],
    ['BANK_ACCOUNT_NUMBER', ''],
    ['BANK_IFSC', ''],
    ['BANK_UPI_ID', ''],
    ['BANK_GSTIN', ''],
    // ─── Per-event Settings — fee structure ──────────────────────────────
    // Default processing fees applied by /api/payments/order when an event
    // is configured with its payer ("customer" pays on top vs. "host"
    // absorbs from payout). Hosts can leave these at 0 to disable a fee
    // category entirely. PAYMENT_GATEWAY_FEE_PCT defaults to Razorpay's
    // 2% standard processing rate; PLATFORM_FEE_PCT starts at 0 so venues
    // explicitly opt into a commission share.
    ['PAYMENT_GATEWAY_FEE_PCT', '2'],
    ['PLATFORM_FEE_PCT', '0'],
  ];
  const up = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  for (const [k, v] of seed) up.run(k, v);

  seedHostIfEmpty(db);
  seedVenueIfEmpty(db);
}

function seedVenueIfEmpty(db: Database.Database) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM venues').get() as { c: number };
  if (row.c > 0) return;

  const venueName = (db.prepare(`SELECT value FROM config WHERE key = 'VENUE_NAME'`).get() as { value: string } | undefined)?.value || 'My Venue';
  db.prepare(`
    INSERT INTO venues (id, name, city, address, google_maps_url, notes, active, created_at, created_by)
    VALUES (?, ?, 'Hyderabad', NULL, NULL, NULL, 1, ?, 'system')
  `).run(nanoid(), venueName, Date.now());
}

function seedHostIfEmpty(db: Database.Database) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  if (row.c > 0) return;

  const defaultPin = '1234';
  const hash = bcrypt.hashSync(defaultPin, 10);
  const id = nanoid();
  const phone = db.prepare(`SELECT value FROM config WHERE key = 'HOST_PHONE'`).get() as { value: string } | undefined;
  db.prepare(`
    INSERT INTO users (id, name, phone, email, role, pin_hash, active, created_at, created_by)
    VALUES (?, 'Host', ?, NULL, 'host', ?, 1, ?, 'system')
  `).run(id, phone?.value || '+910000000000', hash, Date.now());

  console.log('\n============================================');
  console.log('  EventCover Host account bootstrapped');
  console.log('  Phone:', phone?.value || '+910000000000');
  console.log('  PIN:  ', defaultPin);
  console.log('  ▲ Change this in /admin/staff after login.');
  console.log('============================================\n');
}

function migrate(db: Database.Database) {
  // Cashier settlement columns on redemptions
  const redCols = db.prepare('PRAGMA table_info(redemptions)').all() as { name: string }[];
  const addRedCol = (name: string, ddl: string) => {
    if (!redCols.some((c) => c.name === name)) db.exec(`ALTER TABLE redemptions ADD COLUMN ${name} ${ddl}`);
  };
  addRedCol('settled',     'INTEGER DEFAULT 0');
  addRedCol('settled_by',  'TEXT');
  addRedCol('settled_at',  'INTEGER');
  addRedCol('invoice_no',  'TEXT');
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_redemptions_settled ON redemptions(settled, created_at DESC)'); } catch { /* idempotent */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_redemptions_invoice ON redemptions(invoice_no)'); } catch { /* idempotent */ }

  const walletCols = db.prepare('PRAGMA table_info(wallets)').all() as { name: string }[];
  if (!walletCols.some((c) => c.name === 'expires_at')) {
    db.exec('ALTER TABLE wallets ADD COLUMN expires_at INTEGER');
  }
  if (!walletCols.some((c) => c.name === 'table_id')) {
    db.exec('ALTER TABLE wallets ADD COLUMN table_id TEXT');
  }
  if (!walletCols.some((c) => c.name === 'event_id')) {
    db.exec('ALTER TABLE wallets ADD COLUMN event_id TEXT');
  }
  // pin_enc — AES-256-GCM ciphertext of the plaintext PIN, so an admin can
  // re-read a PIN the guest lost. pin_hash (bcrypt) remains the ONLY thing
  // redemption verifies against; this column is read solely by the
  // admin-only reveal endpoint.
  //
  // NULL means "unrecoverable" and is the correct state for: every wallet
  // issued before this column existed (bcrypt is one-way — they can never be
  // back-filled), and any wallet issued while WALLET_PIN_ENC_KEY was unset.
  if (!walletCols.some((c) => c.name === 'pin_enc')) {
    db.exec('ALTER TABLE wallets ADD COLUMN pin_enc TEXT');
  }
  if (!walletCols.some((c) => c.name === 'reservation_id')) {
    db.exec('ALTER TABLE wallets ADD COLUMN reservation_id TEXT');
  }

  // Events wizard columns — additive so legacy event rows keep working.
  const eventCols = db.prepare('PRAGMA table_info(events)').all() as { name: string }[];
  const addEvCol = (name: string, ddl: string) => {
    if (!eventCols.some((c) => c.name === name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${ddl}`);
  };
  addEvCol('description',     'TEXT');
  addEvCol('image_data',      'TEXT');
  addEvCol('start_time',      'TEXT');
  addEvCol('is_public',       'INTEGER DEFAULT 1');
  addEvCol('venue_id',        'TEXT');
  addEvCol('artist_ids',      "TEXT DEFAULT '[]'");
  addEvCol('genre',           'TEXT');
  addEvCol('tags',            "TEXT DEFAULT '[]'");
  addEvCol('terms',           'TEXT');
  addEvCol('faqs',            'TEXT');
  addEvCol('booking_types',   "TEXT DEFAULT '[]'");
  addEvCol('messages_config', "TEXT DEFAULT '{}'");

  // ─── Public landing-page slugs + per-event Meta Pixel override ───────────
  // `slug` powers /e/<slug> public URLs (auto-generated on create/update).
  // `meta_pixel_id` lets a specific event use a different Pixel than the
  // global one (e.g. a co-branded campaign). Both are nullable.
  addEvCol('slug',            'TEXT');
  addEvCol('meta_pixel_id',   'TEXT');
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_events_slug ON events(slug) WHERE slug IS NOT NULL'); } catch { /* idempotent */ }

  // Pricing engine columns
  addEvCol('entry_fee_per_person', 'REAL DEFAULT 500');
  addEvCol('cover_male_stag',      'REAL DEFAULT 2000');
  addEvCol('cover_female_stag',    'REAL DEFAULT 1000');
  addEvCol('cover_couple',         'REAL DEFAULT 3000');
  addEvCol('entry_enabled',        'INTEGER DEFAULT 1');
  addEvCol('cover_enabled',        'INTEGER DEFAULT 1');
  addEvCol('table_types',          "TEXT DEFAULT '[]'");
  addEvCol('occupancy_rule',       "TEXT DEFAULT 'exact'");
  addEvCol('gst_percent',          'REAL DEFAULT 0');
  addEvCol('discount_percent',     'REAL DEFAULT 0');

  // ─── Per-event Settings — Inquiry phone + fee payer config ──────────────
  // inquiry_phone: optional override for the brand-page HOST_PHONE when
  //   sending Contact-host inquiry WhatsApp pings; NULL falls back to brand.
  // payment_gateway_fee_payer / platform_fee_payer: who eats the fee?
  //   • 'customer' — fee is added on top at checkout (customer sees price+fee)
  //   • 'host'     — fee is absorbed from the host's payout (default)
  // gst_enabled: master toggle for GST application (gst_percent already exists
  //   in the pricing engine block above and is reused as the rate).
  addEvCol('inquiry_phone',                  'TEXT');
  addEvCol('payment_gateway_fee_payer',      "TEXT DEFAULT 'host'");
  addEvCol('platform_fee_payer',             "TEXT DEFAULT 'host'");
  addEvCol('gst_enabled',                    'INTEGER DEFAULT 0');

  // Online payment mode per event. 'none' (default) skips Razorpay entirely;
  // 'deposit' charges a fixed deposit_amount up front; 'full_cover' charges
  // entry_fee + cover at the time of booking and auto-issues a wallet on
  // capture. Existing rows stay on 'none' so legacy events keep working.
  addEvCol('payment_mode',    "TEXT DEFAULT 'none'");
  addEvCol('deposit_amount',  'REAL DEFAULT 0');

  // ─── Growezzy P1 — Basic Info + Additional Info expansions ──────────────
  // `one_line_summary` shows in Meta Ad previews and on event listings.
  // Capped at 100 chars by the UI but stored as plain TEXT.
  // `refund_policy` rendered on the public /event/[slug] page next to T&C.
  addEvCol('one_line_summary', 'TEXT');
  addEvCol('refund_policy',    'TEXT');

  // Card image — 2:3 portrait (800×1200). Distinct from `image_data` which is
  // the 1:1 hero (Cover Image). Shown on listing cards + social-share previews.
  // Stored as base64 just like image_data; future S3 migration swaps both at once.
  addEvCol('card_image',       'TEXT');

  // ─── Growezzy P4 — RSVP Form ────────────────────────────────────────────
  // Per-event JSON array of FieldDef {id,label,type,required,options?}.
  // Empty array (column DEFAULT) = no custom fields; the public booking form
  // renders the standard fields only. Persisted as TEXT so legacy events
  // keep working without any data migration — parseRsvpFields() in
  // src/lib/events.ts handles NULL / '[]' / garbage uniformly.
  addEvCol('rsvp_fields_json', "TEXT DEFAULT '[]'");

  // ─── Payments (Razorpay) ─────────────────────────────────────────────────
  // One row per checkout attempt. We create the row in 'created' state before
  // calling Razorpay so a failed network round-trip still leaves an audit
  // trail. razorpay_order_id is filled once the upstream call returns; the
  // payment_id + signature land after the customer completes checkout.
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      reservation_id TEXT,
      event_id TEXT NOT NULL,
      razorpay_order_id TEXT NOT NULL,
      razorpay_payment_id TEXT,
      razorpay_signature TEXT,
      amount REAL NOT NULL,
      amount_paise INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      status TEXT NOT NULL DEFAULT 'created',
      payer_name TEXT,
      payer_phone TEXT,
      payer_email TEXT,
      payment_mode TEXT,
      txn_id TEXT,
      notes TEXT,
      error_code TEXT,
      error_description TEXT,
      webhook_received_at INTEGER,
      verified_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(razorpay_order_id);
    CREATE INDEX IF NOT EXISTS idx_payments_reservation ON payments(reservation_id);
    CREATE INDEX IF NOT EXISTS idx_payments_event ON payments(event_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
  `);

  // ─── Affiliate tracking ──────────────────────────────────────────────
  // Each affiliate is an external promoter with a unique ref code. Clicks
  // are logged when their link is opened (via RefCapture in the layout);
  // commissions accrue when a ticket is created against their code;
  // payouts bundle paid commissions for an affiliate at a point in time.
  db.exec(`
    CREATE TABLE IF NOT EXISTS affiliates (
      id                TEXT PRIMARY KEY,
      code              TEXT UNIQUE NOT NULL,
      name              TEXT NOT NULL,
      phone             TEXT,
      email             TEXT,
      status            TEXT NOT NULL DEFAULT 'active',
      commission_type   TEXT NOT NULL DEFAULT 'percent',
      commission_value  REAL NOT NULL DEFAULT 10,
      notes             TEXT,
      created_at        INTEGER NOT NULL,
      created_by        TEXT,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_affiliates_status ON affiliates(status);
    CREATE INDEX IF NOT EXISTS idx_affiliates_code   ON affiliates(code);

    CREATE TABLE IF NOT EXISTS affiliate_clicks (
      id           TEXT PRIMARY KEY,
      affiliate_id TEXT NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
      event_id     TEXT,
      ip           TEXT,
      user_agent   TEXT,
      referer      TEXT,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_clicks_affiliate ON affiliate_clicks(affiliate_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS affiliate_payouts (
      id           TEXT PRIMARY KEY,
      affiliate_id TEXT NOT NULL REFERENCES affiliates(id),
      amount       REAL NOT NULL,
      method       TEXT NOT NULL DEFAULT 'cash',
      reference    TEXT,
      notes        TEXT,
      paid_by      TEXT,
      paid_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payouts_affiliate ON affiliate_payouts(affiliate_id, paid_at DESC);

    CREATE TABLE IF NOT EXISTS affiliate_commissions (
      id                TEXT PRIMARY KEY,
      ticket_id         TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      affiliate_id      TEXT NOT NULL REFERENCES affiliates(id),
      event_id          TEXT,
      sale_amount       REAL NOT NULL,
      commission_type   TEXT NOT NULL,
      commission_value  REAL NOT NULL,
      commission_amount REAL NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      payout_id         TEXT REFERENCES affiliate_payouts(id),
      created_at        INTEGER NOT NULL,
      paid_at           INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_commissions_affiliate ON affiliate_commissions(affiliate_id, status);
    CREATE INDEX IF NOT EXISTS idx_commissions_ticket    ON affiliate_commissions(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_commissions_payout    ON affiliate_commissions(payout_id);

    /**
     * Many-to-many: which events is this affiliate authorized to earn on?
     * Strict attribution — a ticket only earns commission when an assignment
     * row exists for (affiliate_id, ticket.event_id).
     *
     * commission_type / commission_value are nullable — when blank, fall
     * back to the affiliate's default values.
     */
    CREATE TABLE IF NOT EXISTS affiliate_event_assignments (
      id                TEXT PRIMARY KEY,
      affiliate_id      TEXT NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
      event_id          TEXT NOT NULL REFERENCES events(id)     ON DELETE CASCADE,
      commission_type   TEXT,
      commission_value  REAL,
      created_at        INTEGER NOT NULL,
      UNIQUE(affiliate_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_assignments_event     ON affiliate_event_assignments(event_id);
    CREATE INDEX IF NOT EXISTS idx_assignments_affiliate ON affiliate_event_assignments(affiliate_id);
  `);

  // ─── Per-event Promote — affiliates.kind ────────────────────────────────
  // 'commission' (default, today's behavior) | 'tracking' (commission-free
  // channel attribution links). Tracking links share the same attribution
  // funnel as commission affiliates but always carry commission_value=0 so
  // attributeTicket() short-circuits and never accrues commissions.
  const affCols = db.prepare('PRAGMA table_info(affiliates)').all() as { name: string }[];
  const addAffCol = (name: string, ddl: string) => {
    if (!affCols.some((c) => c.name === name)) db.exec(`ALTER TABLE affiliates ADD COLUMN ${name} ${ddl}`);
  };
  addAffCol('kind', "TEXT NOT NULL DEFAULT 'commission'");
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_affiliates_kind ON affiliates(kind)'); } catch { /* idempotent */ }

  // Attribution fields stamped onto the ticket itself for fast joins + history
  const ticketCols = db.prepare('PRAGMA table_info(tickets)').all() as { name: string }[];
  const addTicketCol = (name: string, ddl: string) => {
    if (!ticketCols.some((c) => c.name === name)) db.exec(`ALTER TABLE tickets ADD COLUMN ${name} ${ddl}`);
  };
  addTicketCol('affiliate_code',    'TEXT');
  addTicketCol('affiliate_id',      'TEXT');
  addTicketCol('commission_amount', 'REAL');
  addTicketCol('commission_status', 'TEXT');

  // ─── Offline ticket → wallet bridge ─────────────────────────────────────
  // When the host issues an offline ticket via /admin/tickets we now also
  // auto-issue a wallet pass (QR + PIN) and WhatsApp it to the guest, so
  // the ticket itself doubles as the entry pass. This column stores the
  // wallets.txn_id of that auto-issued pass so we can:
  //   • Show "WhatsApp sent ✓" status next to the ticket in the admin list
  //   • Resend the pass without creating a duplicate wallet
  //   • Reconcile ticket revenue ↔ door-scan stats
  // NULL on rows issued before this feature shipped.
  addTicketCol('wallet_txn_id', 'TEXT');

  // ─── Offline ticket M/F/C breakdown ─────────────────────────────────────
  // The offline form now lets the operator enter a mixed party (e.g. 2M+1F+1C)
  // in one shot. pax + price are derived from these counts × event cover rates.
  // We persist the breakdown so the door-staff list shows "2M · 1F · 1C" next
  // to the pax cell — useful for bouncers verifying gender ratios at entry.
  // NULL/0 on tickets issued before this column existed.
  addTicketCol('male_count',   'INTEGER DEFAULT 0');
  addTicketCol('female_count', 'INTEGER DEFAULT 0');
  addTicketCol('couple_count', 'INTEGER DEFAULT 0');

  // ─── Entry vs Cover split on offline tickets ────────────────────────────
  // The single `price` column collapses both halves and can't tell the
  // door staff how much of the wallet is redeemable at the bar. Split:
  //   entry_amount  → sunk door fee (entry_fee_per_person × pax)
  //                   Stored on the wallet as entryFee.
  //   cover_amount  → redeemable bar credit (M×male_stag + F×female_stag
  //                   + C×couple). Stored on the wallet as coverIssued.
  //   price         → kept as the grand total (entry + cover) for
  //                   back-compat with the existing list display.
  // All default 0 — pre-feature rows read as 0 cleanly.
  addTicketCol('entry_amount', 'REAL DEFAULT 0');
  addTicketCol('cover_amount', 'REAL DEFAULT 0');

  // ─── Reservations: first-class data (event_id nullable + event_date col) ──
  // Originally reservations.event_id was NOT NULL, forcing every booking to
  // be tied to an existing event. That doesn't match how Reservego works:
  // bookings come in for any future date, and we may not have created the
  // event yet (or it may never become a ticketed event at all). New model:
  //   • event_id is NULLABLE — reservations can exist without an event
  //   • event_date is the source of truth for which day the booking is for
  //   • when an event is later created for that date, auto-link unassigned
  //     reservations to it (handled in lib/events.ts createEvent)
  const resCols = db.prepare('PRAGMA table_info(reservations)').all() as { name: string; notnull: number }[];
  const eventIdCol = resCols.find((c) => c.name === 'event_id');
  const needsRecreate = eventIdCol && eventIdCol.notnull === 1;
  const hasEventDate = resCols.some((c) => c.name === 'event_date');

  if (needsRecreate) {
    // SQLite doesn't support modifying constraints in place — recreate.
    // This is the canonical SQLite migration pattern (CREATE → COPY →
    // DROP → RENAME), wrapped in a transaction so it's atomic.
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN TRANSACTION;
      CREATE TABLE IF NOT EXISTS reservations_new (
        id                   TEXT PRIMARY KEY,
        event_id             TEXT REFERENCES events(id),  -- now nullable
        event_date           TEXT,                         -- new column
        provider             TEXT NOT NULL,
        external_ref         TEXT,
        name                 TEXT NOT NULL,
        phone                TEXT NOT NULL,
        email                TEXT,
        pax                  INTEGER DEFAULT 1,
        arrival_time         TEXT,
        notes                TEXT,
        status               TEXT DEFAULT 'pending',
        converted_wallet_txn TEXT,
        synced_at            INTEGER NOT NULL,
        raw                  TEXT
      );

      INSERT INTO reservations_new (
        id, event_id, event_date, provider, external_ref, name, phone, email,
        pax, arrival_time, notes, status, converted_wallet_txn, synced_at, raw
      )
      SELECT
        r.id, r.event_id,
        COALESCE(e.event_date, NULL) AS event_date,
        r.provider, r.external_ref, r.name, r.phone, r.email,
        r.pax, r.arrival_time, r.notes, r.status, r.converted_wallet_txn,
        r.synced_at, r.raw
      FROM reservations r
      LEFT JOIN events e ON e.id = r.event_id;

      DROP TABLE reservations;
      ALTER TABLE reservations_new RENAME TO reservations;

      CREATE INDEX IF NOT EXISTS idx_reservations_event  ON reservations(event_id);
      CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);
      CREATE INDEX IF NOT EXISTS idx_reservations_date   ON reservations(event_date);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_reservations_provider_ref
        ON reservations(provider, external_ref) WHERE external_ref IS NOT NULL;
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  } else if (!hasEventDate) {
    // Already nullable (newer install) but missing the event_date column.
    db.exec(`ALTER TABLE reservations ADD COLUMN event_date TEXT`);
    db.exec(`
      UPDATE reservations
      SET event_date = COALESCE(
        event_date,
        (SELECT event_date FROM events WHERE events.id = reservations.event_id)
      )
      WHERE event_date IS NULL AND event_id IS NOT NULL
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_reservations_date ON reservations(event_date)`);
  }

  // ─── Reservations: Reservego-rich fields ──────────────────────────────────
  // The webhook payload includes structured arrays (tables, tags, custom
  // tags, preferences) and customer-context fields (bday, anniv, total
  // visits) plus the raw bookingTime. Originally these were either dropped
  // or merged into a single `notes` blob. Promote them to first-class
  // columns so the UI can render them independently and so future code can
  // query/filter by tag without parsing free text.
  //
  // All additive — re-read PRAGMA after the potential table recreate above
  // so we don't ALTER a stale column list.
  const resColsForRich = db.prepare('PRAGMA table_info(reservations)').all() as { name: string }[];
  const addResCol = (name: string, ddl: string) => {
    if (!resColsForRich.some((c) => c.name === name)) db.exec(`ALTER TABLE reservations ADD COLUMN ${name} ${ddl}`);
  };
  addResCol('booking_time',      'TEXT');
  addResCol('tables_json',       'TEXT');
  addResCol('tags_json',         'TEXT');
  addResCol('custom_tags_json',  'TEXT');
  addResCol('preferences_json',  'TEXT');
  addResCol('bday',              'TEXT');
  addResCol('anniv',             'TEXT');
  addResCol('total_visits',      'INTEGER');

  // ─── Growezzy P4 — RSVP Form answers ────────────────────────────────────
  // Per-reservation JSON {fieldId: string | string[]} mirroring whatever
  // FieldDef array was on the event at booking time. NULL when the event
  // had no rsvp_fields configured. Server-side validation lives in
  // /api/reservations/public — bad payloads never reach this column.
  addResCol('rsvp_answers_json', 'TEXT');

  // ─── M/F/C — per-category guest breakdown ──────────────────────────────────
  // Booking form (PublicBookingForm) + the admin manual-reservation form now
  // capture how the party splits across Male / Female / Couple. These columns
  // are read by /admin/reservations (display pill), /admin/bookings (the
  // global Bookings dashboard joins on them) and /api/payments/verify (stamps
  // the breakdown from payments.notes onto the reservation row).
  //
  // The initial CREATE TABLE statement at the top of this file also lists
  // them, but databases that were created BEFORE this migration block was
  // added (i.e. every existing install) need an explicit ALTER TABLE — SQLite
  // doesn't auto-add columns when the schema source changes. Default 0 so
  // legacy rows read as zero across the board.
  addResCol('male_count',   'INTEGER DEFAULT 0');
  addResCol('female_count', 'INTEGER DEFAULT 0');
  addResCol('couple_count', 'INTEGER DEFAULT 0');

  // ─── Reservego prepay — guest pays cover in advance via online link ─────
  // Adds three nullable columns on reservations so the prepay flow can
  // attach to ANY reservation (Reservego inbound or manual entry — same
  // table) without a separate "prepay_tickets" sibling table.
  //
  // payment_link_sent_at  — unix ms when host issued the link. NULL = never.
  // payment_link_token    — HMAC-signed token baked into the customer URL.
  // payment_id            — FK to payments.id once the customer pays. NULL
  //                         when status='pending' (link sent but unpaid).
  addResCol('payment_link_sent_at', 'INTEGER');
  addResCol('payment_link_token',   'TEXT');
  addResCol('payment_id',           'TEXT');

  // ─── Phase 2: Coupons ────────────────────────────────────────────────────
  // event_coupons holds discount codes. event_id NULL means "venue-wide" —
  // applies to any event. discount_type is 'fixed' (INR off) or 'percent'
  // (% off, 0-100). used_count is denormalized; incremented inside the
  // payment-verify transaction so concurrent checkouts can't blow past
  // max_uses (NULL means unlimited).
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_coupons (
      id              TEXT PRIMARY KEY,
      event_id        TEXT REFERENCES events(id) ON DELETE CASCADE,
      code            TEXT NOT NULL,
      discount_type   TEXT NOT NULL CHECK(discount_type IN ('fixed','percent')),
      discount_value  REAL NOT NULL,
      max_uses        INTEGER,
      used_count      INTEGER NOT NULL DEFAULT 0,
      expires_at      INTEGER,
      active          INTEGER NOT NULL DEFAULT 1,
      notes           TEXT,
      created_at      INTEGER NOT NULL,
      created_by      TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_coupons_event_code
      ON event_coupons(IFNULL(event_id, ''), code);
    CREATE INDEX IF NOT EXISTS idx_coupons_event  ON event_coupons(event_id);
    CREATE INDEX IF NOT EXISTS idx_coupons_active ON event_coupons(active, expires_at);
  `);

  // Additive: affiliate_id stamp on coupons so affiliate-attributed
  // sales can pay commissions when a coupon is also applied. NULL
  // (default) means no affiliate is credited for redemptions of this code.
  const cpnCols = db.prepare('PRAGMA table_info(event_coupons)').all() as { name: string }[];
  const addCpnCol = (name: string, ddl: string) => {
    if (!cpnCols.some((c) => c.name === name)) db.exec(`ALTER TABLE event_coupons ADD COLUMN ${name} ${ddl}`);
  };
  addCpnCol('affiliate_id', 'TEXT REFERENCES affiliates(id) ON DELETE SET NULL');
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_coupons_affiliate ON event_coupons(affiliate_id)'); } catch { /* idempotent */ }

  // coupon_redemptions — one row per (coupon, payment) so we have a real
  // audit trail of which payment used which coupon (analytics + reversal).
  // UNIQUE(coupon_id, payment_id) makes the insert idempotent against
  // verify retries.
  db.exec(`
    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      id              TEXT PRIMARY KEY,
      coupon_id       TEXT NOT NULL REFERENCES event_coupons(id) ON DELETE CASCADE,
      payment_id      TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      event_id        TEXT,
      reservation_id  TEXT,
      discount_amount REAL NOT NULL,
      created_at      INTEGER NOT NULL,
      UNIQUE(coupon_id, payment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon  ON coupon_redemptions(coupon_id);
    CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_payment ON coupon_redemptions(payment_id);
  `);

  // ─── Phase 2: Event media gallery ───────────────────────────────────────
  // Public landing page can render a horizontal-scroll carousel below the
  // hero. image_data is the same base64 data URL the events table uses
  // (produced by ImageUpload), so no new infra required. sort_order is
  // 0-based; reorder API rewrites the column inside a tx.
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_media (
      id          TEXT PRIMARY KEY,
      event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      image_data  TEXT NOT NULL,
      caption     TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      created_by  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_event_media_event_order
      ON event_media(event_id, sort_order);
  `);

  // ─── Phase 2: payments coupon stamping ──────────────────────────────────
  // Additive — stamps the coupon used (if any) on the payment row so we
  // have an audit trail without a separate join. coupon_id refs
  // event_coupons.id; coupon_code is a denormalized snapshot of what the
  // customer typed; discount_amount is the INR reduction we applied
  // before talking to Razorpay.
  const payCols = db.prepare('PRAGMA table_info(payments)').all() as { name: string }[];
  const addPayCol = (name: string, ddl: string) => {
    if (!payCols.some((c) => c.name === name)) db.exec(`ALTER TABLE payments ADD COLUMN ${name} ${ddl}`);
  };
  addPayCol('coupon_id',       'TEXT');
  addPayCol('coupon_code',     'TEXT');
  addPayCol('discount_amount', 'REAL DEFAULT 0');
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_payments_coupon ON payments(coupon_id)'); } catch { /* idempotent */ }

  // ─── Phase 3: Invite-only + Multi-slot schedule ──────────────────────────
  //
  // (1) INVITE ONLY — three additive columns on events.
  //   • access_mode:    'public' | 'invite_link' | 'phone_list'
  //   • invite_secret:  nanoid(20) generated when access_mode flips to
  //                     'invite_link'. Nullable until then.
  //   • invite_message: optional copy shown on the soft-gate page.
  //
  // These columns are strictly additive — every existing event row gets
  // access_mode='public' by default, preserving today's behavior.
  addEvCol('access_mode',    "TEXT NOT NULL DEFAULT 'public'");
  addEvCol('invite_secret',  'TEXT');
  addEvCol('invite_message', 'TEXT');

  // ─── Phase 4: Ticket Design ──────────────────────────────────────────────
  // Per-event override of the wallet pass PNG visual layout. Stored as JSON
  // {background, accent, text, show_logo, show_date, layout} — empty object
  // or NULL means "use the built-in BRAND/INK defaults from pass-image.ts".
  // DEFAULT '{}' so legacy rows hydrate to {} and the renderer falls back
  // cleanly without a separate backfill step.
  addEvCol('ticket_design_json', "TEXT DEFAULT '{}'");

  // ─── Reservego prepay — per-event auto-send toggle ─────────────────────
  // When 1, every Reservego webhook arrival for this event auto-mints a
  // payment link + fires the Interakt template. When 0 (default), the host
  // sends links manually from /admin/reservations. Set in the wizard's
  // Settings section (Reservego sub-card). 0 by default so existing events
  // behave exactly as before this feature shipped.
  addEvCol('reservego_auto_prepay', 'INTEGER DEFAULT 0');

  // ─── Event Category — Day / Night grouping for the public website ─────
  // Two-column structure (rather than a single enum) because the public
  // event listings group by category_slot (Day vs Night sections) but
  // display category_label (Brunch / Workshop / Evening / Live Band / DJ
  // Night) on the card. Decoupling them lets the host pick a label that
  // doesn't exist in our preset list without breaking the day/night split.
  //
  // category_slot: 'day' | 'night' | NULL  (NULL on legacy rows so the
  //                                          UI can require it on publish
  //                                          without retroactively failing)
  // category_label: free-text label, validated against a preset list in UI.
  addEvCol('category_slot',  'TEXT');
  addEvCol('category_label', 'TEXT');

  // ─── akan-events-app fields — richer public-site metadata ──────────────
  // The customer-facing akan-events-app (separate Next.js app that proxies
  // to this dashboard) expects these fields on every event so its cards can
  // render with color themes, badges, feature flags, and capacity signals.
  // Adding them here means one API contract — no per-consumer branching.
  //
  //   tagline   — short catchy line under the title on cards.
  //   hue       — color theme applied to the card ('sunny' / 'tomato' /
  //               'crimson' / 'ocean' / 'mint' / 'lavender' / 'slate').
  //               Validated as an enum in the lib layer but stored as free
  //               text so future palette additions ship without migration.
  //   featured  — boolean (0/1). Cards flagged featured pin to the top of
  //               their Day/Night rail on the customer site.
  //   note      — small badge text ('Headliner', 'Selling fast', 'Local
  //               favourite') shown next to the title. Optional.
  //   capacity  — venue capacity limit for THIS event. 0 = unlimited.
  //               Used by the public route to derive booking_open/sold_out.
  addEvCol('tagline',   'TEXT');
  addEvCol('hue',       "TEXT DEFAULT 'sunny'");
  addEvCol('featured',  'INTEGER DEFAULT 0');
  addEvCol('note',      'TEXT');
  addEvCol('capacity',  'INTEGER DEFAULT 0');
  // is_recurring — flags a repeating event (weekly brunch, monthly quiz).
  // The customer site shows a "Recurring" chip and can group instances.
  // Purely presentational today; no scheduling logic is derived from it.
  addEvCol('is_recurring', 'INTEGER DEFAULT 0');

  // ─── Artist profile metadata (akan-events-app contract) ────────────────
  // The customer site renders a richer artist card for music events:
  // "4 members · 2 vocalists · 90 min set". All default 0, which the
  // projection treats as "not specified" and omits from the payload.
  const artistCols = db.prepare(`PRAGMA table_info(artists)`).all() as { name: string }[];
  const addArtistCol = (name: string, ddl: string) => {
    if (!artistCols.some((c) => c.name === name)) db.exec(`ALTER TABLE artists ADD COLUMN ${name} ${ddl}`);
  };
  addArtistCol('vocalists',   'INTEGER DEFAULT 0');
  addArtistCol('members',     'INTEGER DEFAULT 0');
  addArtistCol('set_minutes', 'INTEGER DEFAULT 0');

  // event_invitees — phone-list mode entries. Phones are stored already
  // normalized via normalizePhone(). Unique-per-event so the same phone
  // can be invited to different events. used flips to 1 inside the same
  // reservation transaction to prevent re-use.
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_invitees (
      id                   TEXT PRIMARY KEY,
      event_id             TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      phone                TEXT NOT NULL,
      name                 TEXT,
      plus_ones_allowed    INTEGER NOT NULL DEFAULT 0,
      used                 INTEGER NOT NULL DEFAULT 0,
      used_at              INTEGER,
      used_reservation_id  TEXT,
      notes                TEXT,
      created_at           INTEGER NOT NULL,
      created_by           TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_event_invitees_event_phone
      ON event_invitees(event_id, phone);
    CREATE INDEX IF NOT EXISTS idx_event_invitees_used
      ON event_invitees(event_id, used);
  `);

  // (2) MULTI-SLOT SCHEDULE — event_slots + reservations.slot_id.
  //
  // events.event_date + events.start_time stay the source of truth when
  // an event has zero active slots (back-compat — legacy events keep
  // working without any UI change).
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_slots (
      id            TEXT PRIMARY KEY,
      event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      slot_date     TEXT NOT NULL,
      start_time    TEXT NOT NULL,
      end_time      TEXT,
      label         TEXT,
      max_capacity  INTEGER,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_slots_event_order
      ON event_slots(event_id, active, sort_order);
    CREATE INDEX IF NOT EXISTS idx_event_slots_date
      ON event_slots(slot_date);
  `);

  // reservations.slot_id — nullable so legacy + single-slot events keep
  // working. Partial index keeps the hot path cheap (capacity COUNT(*)).
  // Note: re-read PRAGMA so we don't ALTER a stale column list, since the
  // reservations table may have been recreated above for nullability fix.
  const resColsForSlot = db.prepare('PRAGMA table_info(reservations)').all() as { name: string }[];
  if (!resColsForSlot.some((c) => c.name === 'slot_id')) {
    db.exec('ALTER TABLE reservations ADD COLUMN slot_id TEXT REFERENCES event_slots(id)');
  }
  try {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_reservations_slot
         ON reservations(slot_id) WHERE slot_id IS NOT NULL`,
    );
  } catch { /* idempotent */ }

  // ─── Multi-stage check-in + cover redemption (reservation-as-wallet) ─────
  //
  // The reservation row becomes its own wallet for booked guests. We add
  // additive numeric counters + a ledger-specific status that's distinct
  // from the existing booking-lifecycle `status` (pending/converted/
  // no_show/cancelled). The shared-QR scan flow at the door reads/writes
  // these columns inside db.transaction() blocks so concurrent scans
  // serialize via better-sqlite3's single-writer model.
  //
  // Naming note: we KEEP existing `pax` as physical storage and expose
  // total_pax as an alias via the lib layer. A coordinated rename would
  // collide with the webhook upsert + public booking paths that other
  // in-flight workflows are also touching. We do add a total_pax column
  // backfilled from pax for callers that want a stable schema-level name,
  // but the lib layer treats reservations.pax as the source of truth.
  const resColsForLedger = db.prepare('PRAGMA table_info(reservations)').all() as { name: string }[];
  const addLedgerCol = (name: string, ddl: string) => {
    if (!resColsForLedger.some((c) => c.name === name)) db.exec(`ALTER TABLE reservations ADD COLUMN ${name} ${ddl}`);
  };
  addLedgerCol('total_pax',          'INTEGER DEFAULT 0');
  addLedgerCol('checked_in_pax',     'INTEGER DEFAULT 0');
  addLedgerCol('entry_amount',       'REAL DEFAULT 0');
  addLedgerCol('cover_amount',       'REAL DEFAULT 0');
  addLedgerCol('cover_redeemed',     'REAL DEFAULT 0');
  addLedgerCol('reservation_status', "TEXT DEFAULT 'pending'");

  // One-time backfill: copy pax → total_pax for legacy rows where total_pax
  // is still 0 but pax has a real value. Idempotent: subsequent runs no-op
  // because the WHERE clause excludes already-backfilled rows.
  try {
    db.exec(`UPDATE reservations SET total_pax = pax WHERE (total_pax IS NULL OR total_pax = 0) AND pax > 0`);
  } catch { /* idempotent */ }

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_reservations_reservation_status ON reservations(reservation_status)`);
  } catch { /* idempotent */ }

  // Check-in ledger — append-only event log. Reversals are recorded as a
  // negative checked_in_pax row + flipping reversed_at/by on the original.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reservation_checkins (
      id              TEXT PRIMARY KEY,
      reservation_id  TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
      checked_in_pax  INTEGER NOT NULL,
      checked_in_by   TEXT NOT NULL,
      notes           TEXT,
      status          TEXT NOT NULL DEFAULT 'success',
      reversed_at     INTEGER,
      reversed_by     TEXT,
      timestamp       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_checkins_reservation ON reservation_checkins(reservation_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_checkins_timestamp ON reservation_checkins(timestamp DESC);
  `);

  // Cover redemption ledger. The partial unique index enforces "same bill_id
  // can't be charged twice while still active" — a reversed row drops out of
  // the constraint so a corrected bill can be re-billed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cover_redemptions (
      id              TEXT PRIMARY KEY,
      reservation_id  TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
      bill_id         TEXT,
      redeemed_amount REAL NOT NULL,
      redeemed_by     TEXT NOT NULL,
      notes           TEXT,
      status          TEXT NOT NULL DEFAULT 'success',
      reversed_at     INTEGER,
      reversed_by     TEXT,
      timestamp       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cover_redemptions_reservation ON cover_redemptions(reservation_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_cover_redemptions_timestamp ON cover_redemptions(timestamp DESC);
  `);
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_cover_redemptions_active_bill
         ON cover_redemptions(reservation_id, bill_id)
         WHERE bill_id IS NOT NULL AND status = 'success'`,
    );
  } catch { /* idempotent */ }

  // ─── Seating Layout — per-event venue SVG + named zones ─────────────────
  // Opt-in feature: when seating_layout_enabled, the public booking flow
  // renders the sanitized SVG inline and the chosen zone's price overrides
  // events.entry_fee_per_person. Legacy + non-seated events read 0 for the
  // enabled flag and continue using the flat-pricing flow unchanged.
  // Re-read the events column list since this migrate() runs many ALTERs.
  const evColsForSeating = db.prepare('PRAGMA table_info(events)').all() as { name: string }[];
  const addEvColSeating = (name: string, ddl: string) => {
    if (!evColsForSeating.some((c) => c.name === name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${ddl}`);
  };
  addEvColSeating('seating_layout_enabled',        'INTEGER DEFAULT 0');
  addEvColSeating('seating_layout_svg',            'TEXT');
  addEvColSeating('seating_layout_phases_enabled', 'INTEGER DEFAULT 0');

  // event_zones — one row per named SVG layer; zone_id matches the SVG id
  // attribute (admin-editable). sold_count is the denormalized counter
  // updated inside the payments/verify transaction (mirrors coupons).
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_zones (
      id          TEXT PRIMARY KEY,
      event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      zone_id     TEXT NOT NULL,
      zone_label  TEXT NOT NULL,
      price       REAL NOT NULL DEFAULT 0,
      capacity    INTEGER NOT NULL DEFAULT 0,
      sold_count  INTEGER NOT NULL DEFAULT 0,
      color       TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_event_zones_event_zone ON event_zones(event_id, zone_id);
    CREATE INDEX IF NOT EXISTS idx_event_zones_event_order ON event_zones(event_id, sort_order, created_at);
    CREATE INDEX IF NOT EXISTS idx_event_zones_active ON event_zones(event_id, active);
  `);

  // reservations.zone_id + zone_pax_count + zone_price_snapshot — link a
  // booking to its zone with a frozen per-seat price. Nullable so legacy
  // + non-seated events keep working. Re-read PRAGMA so we don't ALTER a
  // stale column list — earlier blocks may have recreated reservations.
  const resColsForZone = db.prepare('PRAGMA table_info(reservations)').all() as { name: string }[];
  const addResColZone = (name: string, ddl: string) => {
    if (!resColsForZone.some((c) => c.name === name)) db.exec(`ALTER TABLE reservations ADD COLUMN ${name} ${ddl}`);
  };
  addResColZone('zone_id',             'TEXT');
  addResColZone('zone_pax_count',      'INTEGER DEFAULT 0');
  addResColZone('zone_price_snapshot', 'REAL');
  try {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_reservations_zone
         ON reservations(zone_id) WHERE zone_id IS NOT NULL`,
    );
  } catch { /* idempotent */ }

  // payments.zone_id — denormalized snapshot for audit (mirrors coupon_id).
  const payColsForZone = db.prepare('PRAGMA table_info(payments)').all() as { name: string }[];
  if (!payColsForZone.some((c) => c.name === 'zone_id')) {
    db.exec('ALTER TABLE payments ADD COLUMN zone_id TEXT');
  }

  // ─── Event Insights — per-event analytics + cart-recovery ────────────────
  // event_analytics_events is an append-only log of customer-funnel events
  // emitted from both the client (page_view, book_click, ticket_selected,
  // checkout_started) AND the server (checkout_success, checkout_failed).
  // No FK to events(id) because seeding/cross-env replicas may race; we
  // validate event_id at write time inside event-analytics.ts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_analytics_events (
      id            TEXT PRIMARY KEY,
      event_id      TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      kind          TEXT NOT NULL CHECK(kind IN (
                       'page_view','book_click','ticket_selected',
                       'checkout_started','payment_initiated',
                       'checkout_success','checkout_failed',
                       'page_scroll_depth'
                    )),
      metadata_json TEXT,
      ip_hash       TEXT,
      user_agent    TEXT,
      timestamp     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eae_event_kind_ts
      ON event_analytics_events(event_id, kind, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_eae_event_session
      ON event_analytics_events(event_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_eae_event_ts
      ON event_analytics_events(event_id, timestamp DESC);
  `);

  // ─── Migration: widen event_analytics_events.kind CHECK constraint ─────
  // Older deployments created the table with the original 6-kind CHECK.
  // Insights v2 adds 'payment_initiated' + 'page_scroll_depth'. SQLite
  // can't ALTER a CHECK, so we rebuild via the standard rename/copy/drop
  // dance — but only when the existing constraint is missing the new
  // kinds. Detection: probe sqlite_master for the table's sql and look
  // for the new kind names.
  try {
    const tblSql = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'event_analytics_events'`,
    ).get() as { sql: string | null } | undefined;
    const sql = tblSql?.sql || '';
    if (sql && (!sql.includes('payment_initiated') || !sql.includes('page_scroll_depth'))) {
      db.exec('BEGIN');
      try {
        db.exec(`ALTER TABLE event_analytics_events RENAME TO event_analytics_events_old`);
        db.exec(`
          CREATE TABLE event_analytics_events (
            id            TEXT PRIMARY KEY,
            event_id      TEXT NOT NULL,
            session_id    TEXT NOT NULL,
            kind          TEXT NOT NULL CHECK(kind IN (
                             'page_view','book_click','ticket_selected',
                             'checkout_started','payment_initiated',
                             'checkout_success','checkout_failed',
                             'page_scroll_depth'
                          )),
            metadata_json TEXT,
            ip_hash       TEXT,
            user_agent    TEXT,
            timestamp     INTEGER NOT NULL
          );
        `);
        db.exec(`
          INSERT INTO event_analytics_events
            (id, event_id, session_id, kind, metadata_json, ip_hash, user_agent, timestamp)
          SELECT id, event_id, session_id, kind, metadata_json, ip_hash, user_agent, timestamp
          FROM event_analytics_events_old
        `);
        db.exec(`DROP TABLE event_analytics_events_old`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_eae_event_kind_ts
                 ON event_analytics_events(event_id, kind, timestamp DESC)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_eae_event_session
                 ON event_analytics_events(event_id, session_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_eae_event_ts
                 ON event_analytics_events(event_id, timestamp DESC)`);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  } catch { /* best-effort migration */ }

  // event_cart_recovery_config — per-event opt-in WhatsApp follow-up.
  // delay_minutes ∈ {30,60,120,240} matches the UI chip choices.
  // last_swept_at gates the "auto-sweep on insights GET" side-effect.
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_cart_recovery_config (
      event_id       TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
      enabled        INTEGER NOT NULL DEFAULT 0,
      delay_minutes  INTEGER NOT NULL DEFAULT 60 CHECK(delay_minutes IN (30,60,120,240)),
      template_name  TEXT NOT NULL DEFAULT 'akan_cart_recovery',
      template_lang  TEXT NOT NULL DEFAULT 'en',
      last_swept_at  INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ecrc_enabled
      ON event_cart_recovery_config(enabled, last_swept_at);
  `);

  // event_cart_recovery_attempts — one row per WhatsApp recovery send.
  // UNIQUE(source, source_id) ensures we never spam the same abandoned
  // cart twice; recovered_at is stamped when the matching payment captures.
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_cart_recovery_attempts (
      id                   TEXT PRIMARY KEY,
      event_id             TEXT NOT NULL,
      source               TEXT NOT NULL CHECK(source IN ('payment','reservation')),
      source_id            TEXT NOT NULL,
      phone                TEXT,
      customer_name        TEXT,
      template_name        TEXT NOT NULL,
      interakt_message_id  TEXT,
      sent_at              INTEGER NOT NULL,
      recovered_at         INTEGER,
      recovered_payment_id TEXT,
      error                TEXT,
      created_at           INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_ecra_source
      ON event_cart_recovery_attempts(source, source_id);
    CREATE INDEX IF NOT EXISTS idx_ecra_event_sent
      ON event_cart_recovery_attempts(event_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ecra_recovered
      ON event_cart_recovery_attempts(event_id, recovered_at);
  `);

  // ─── Per-event Manage page — Reminders, Post-Sale Comm, Recap Gallery ──
  // Strictly additive blocks. Each table is created idempotently via IF NOT
  // EXISTS. Max-2-active-schedules-per-event is enforced in the app layer
  // (src/lib/event-reminders.ts), not via a check constraint, so a host can
  // freely toggle schedules on/off without falling under the cap.
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_reminder_schedule (
      id              TEXT PRIMARY KEY,
      event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      minutes_before  INTEGER NOT NULL CHECK(minutes_before > 0 AND minutes_before <= 1440),
      enabled         INTEGER NOT NULL DEFAULT 1,
      last_fired_at   INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      created_by      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ers_event_enabled
      ON event_reminder_schedule(event_id, enabled);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_ers_event_minutes
      ON event_reminder_schedule(event_id, minutes_before);
  `);

  // event_reminder_attempts — one row per send, primary dedup via UNIQUE
  // (schedule_id, reservation_id). Allows the sweep to safely re-run.
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_reminder_attempts (
      id                  TEXT PRIMARY KEY,
      schedule_id         TEXT NOT NULL REFERENCES event_reminder_schedule(id) ON DELETE CASCADE,
      reservation_id      TEXT NOT NULL,
      sent_at             INTEGER NOT NULL,
      interakt_message_id TEXT,
      error               TEXT,
      created_at          INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_era_schedule_reservation
      ON event_reminder_attempts(schedule_id, reservation_id);
    CREATE INDEX IF NOT EXISTS idx_era_reservation
      ON event_reminder_attempts(reservation_id);
  `);

  // event_post_sale_comm — per-event template config. PK is event_id so a
  // host has exactly one config row per event (upsert semantics).
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_post_sale_comm (
      event_id          TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
      message_text      TEXT,
      attachment_kind   TEXT NOT NULL DEFAULT 'none' CHECK(attachment_kind IN ('none','pdf')),
      attachment_url    TEXT,
      enabled           INTEGER NOT NULL DEFAULT 0,
      template_text     TEXT NOT NULL DEFAULT 'event_post_sale_text',
      template_doc      TEXT NOT NULL DEFAULT 'event_post_sale_doc',
      template_lang     TEXT NOT NULL DEFAULT 'en',
      updated_at        INTEGER NOT NULL,
      updated_by        TEXT
    );
  `);

  // event_post_sale_attempts — companion ledger. UNIQUE(payment_id) is the
  // primary guard against /api/payments/verify retries re-sending the WA.
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_post_sale_attempts (
      id                  TEXT PRIMARY KEY,
      event_id            TEXT NOT NULL,
      payment_id          TEXT NOT NULL,
      reservation_id      TEXT,
      interakt_message_id TEXT,
      error               TEXT,
      sent_at             INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_epsa_payment
      ON event_post_sale_attempts(payment_id);
    CREATE INDEX IF NOT EXISTS idx_epsa_event_sent
      ON event_post_sale_attempts(event_id, sent_at DESC);
  `);

  // event_recap_media — distinct from event_media (the pre-event sales
  // gallery). Same shape so the existing reorder pattern transplants 1:1.
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_recap_media (
      id           TEXT PRIMARY KEY,
      event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      image_data   TEXT NOT NULL,
      caption      TEXT,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      created_by   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_erm_event_sort
      ON event_recap_media(event_id, sort_order);
  `);

  // ─── Settings V2 — Team: track last successful login per user ─────────────
  // Drives the "Active" vs "Pending" status pills on the Team section:
  //   • last_login_at IS NULL  → user never signed in → "Pending" (invited)
  //   • last_login_at > 0      → "Active"
  // Set by the OTP / PIN verify paths in lib/auth.ts via touchLastLogin().
  // Additive + idempotent — column may already exist from a previous boot.
  const userCols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (!userCols.some((c) => c.name === 'last_login_at')) {
    db.exec('ALTER TABLE users ADD COLUMN last_login_at INTEGER');
  }

  // ─── Phased Ticket Releases ──────────────────────────────────────────────
  // Phases are a pricing + inventory OVERLAY on top of the existing ticket
  // types (table_types JSON entries) and seating zones (event_zones rows).
  // Each phase has many prices — one per scope:
  //   • scope='table_type', scope_id = table_types[].id
  //   • scope='zone',       scope_id = event_zones.id
  //   • scope='flat_entry', scope_id = NULL (one row covers event-wide
  //                          entry_fee_per_person)
  //
  // Active-phase resolution: ordered by sort_order, first row where
  // active=1, (ends_at IS NULL OR ends_at>now), and (NOT ends_on_sellout
  // OR total_sold<total_inventory). Replaces the previous "Coming Soon"
  // stub in the wizard.
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_ticket_phases (
      id              TEXT PRIMARY KEY,
      event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      sort_order      INTEGER NOT NULL DEFAULT 0,
      active          INTEGER NOT NULL DEFAULT 1,
      ends_at         INTEGER,
      ends_on_sellout INTEGER NOT NULL DEFAULT 1,
      started_at      INTEGER,
      ended_at        INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_etp_event_order
      ON event_ticket_phases(event_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_etp_active
      ON event_ticket_phases(event_id, active);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS event_ticket_phase_prices (
      id          TEXT PRIMARY KEY,
      phase_id    TEXT NOT NULL REFERENCES event_ticket_phases(id) ON DELETE CASCADE,
      scope       TEXT NOT NULL CHECK(scope IN ('table_type','zone','flat_entry')),
      scope_id    TEXT,
      price       REAL NOT NULL,
      inventory   INTEGER,
      sold        INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      UNIQUE(phase_id, scope, scope_id)
    );
    CREATE INDEX IF NOT EXISTS idx_etpp_phase
      ON event_ticket_phase_prices(phase_id);
    CREATE INDEX IF NOT EXISTS idx_etpp_scope
      ON event_ticket_phase_prices(scope, scope_id);
  `);
}

export function getConfig(key: string, fallback = ''): string {
  const db = getDb();
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setConfig(key: string, value: string) {
  const db = getDb();
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export function getAllConfig(): Record<string, string> {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM config').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
