# Cover Flow Audit — 6 Aug 2026

Audit of **Issue Cover / Redeem Cover** (fix pass applied) and **Abandoned Bookings** (report only).
15-agent run: 6 auditors → 3 adversarial refuters → 4 fixers → 2 gate. 63 raw findings, **58 survived refutation**.

Nothing is committed. `HEAD` is still `24382e2`.

---

## 1. Issue / Redeem Cover — what was actually broken

### The money hole (all CRITICAL)

`issueWallet()` had **no validation of any kind** on the cover amount. Whatever arrived went straight into a
SQLite `REAL` column:

| Input | Was stored | Consequence |
|---|---|---|
| `-500` | `-500` | Wallet the guest can never spend; drags every `SUM(cover_issued)` report negative |
| `1e999` | `Infinity` | **Unlimited bar tab** — `amount > balance` is false for every finite amount |
| `100.005` | `100.005` | Sub-paise money that evaporates on first redemption |

Worse, the default was wrong:

```ts
const coverIssued = input.coverIssued != null ? input.coverIssued : input.entryFee;
```

A caller that omitted `coverIssued` turned the guest's **door charge into spendable bar credit** — the same
rupees booked twice, once as revenue and once as a liability. A ₹2,500 entry-only wallet meant ₹2,500 of free drinks.

**One `Infinity` wallet would have nulled every cover KPI venue-wide, permanently** — `SUM()` returns `Inf`,
`JSON.stringify(Infinity)` is `null`, so the dashboard, both analytics screens and the cashier reconciliation
all go blank. It also 500s the pass-PDF endpoint for that guest.

### Redeem

- `redeemWallet()` had **no amount validation** — a negative amount **credited** the wallet.
- The 3-strike PIN lockout was a **lost-update race**: the counter was read and written outside the transaction.
- `pin_fail_count` never reset when a lockout expired, so a wallet was permanently stuck at one attempt per 5 min.
- A mis-keyed redemption **could never be reversed**.

What was already sound (proven by execution, not reading): the balance check and `UPDATE` are in one
transaction, and **no double-spend is possible** — 160 concurrent attempts across 4 OS processes against a
₹1,000 wallet yielded exactly 25 × ₹40 debits, balance 0, ledger sum 1,000, never negative.

### Security holes found in passing

- `GET /api/redemptions` — **completely unauthenticated**. The entire money ledger and guest list, public.
- `GET /api/wallets/[txnId]` — unauthenticated. Guest name, phone and live balance for any txn id.
- The plaintext PIN was **printed on the PNG pass right next to the QR**, put in a URL query string, and
  written to the HTTP access log. Staff forward that PNG over WhatsApp.
- `reveal-pin` had no rate limit — a host session could dump every PIN in the venue as fast as the network allowed.
- The pass URL sent to Interakt was built from the client-controlled `Origin` header — a valid pass token
  could be exfiltrated to any host the caller named.

### Reporting / analytics

- **Revenue double-counted** for every ticket-issued and payment-issued wallet — ₹3,000 collected reported as ₹6,000.
- **"Unredeemed" was not bar liability.** It mixed live credit, lapsed breakage and already-refunded money —
  a ~36× overstatement.
- Refunds (`voidWallet`) were marked `exhausted`, so they sat in the same bucket as fully-spent wallets and
  never left the liability line.
- A wallet with `expires_at = NULL` **never expired and stayed spendable forever**. The venue had one live
  with ₹1,000 on it.
- The reporting day boundary didn't match the club's business day, so one party night split across two
  report days — and three screens disagreed with each other.

---

## 2. What is fixed and independently verified

I re-ran the money paths myself against a throwaway DB copy, after the fixes:

```
ISSUE — validation
  cover = -500      -> rejected: Cover cannot be negative.
  cover = Infinity  -> rejected: Cover must be a finite number.
  cover = NaN       -> rejected: Cover must be a finite number.
  entryFee = -1     -> rejected: Entry fee cannot be negative.
  cover = 9e9       -> rejected: Cover exceeds the per-wallet cap of ₹200000.
  entryFee 2500, cover omitted -> balance 0   (door charge NOT spendable)
  cover 100.005 -> balance 100.01             (quantised to paise)

REDEEM — arithmetic
  redeem 300 of 1000 -> ok, balance 700       (exact)
  redeem -100        -> refused
  redeem 99999       -> refused: Insufficient balance. Remaining ₹700.
  wrong PIN ×3       -> 2 left / 1 left / Locked for 5 min
  correct PIN after  -> still locked
  balance after all failures: 700, untouched
```

Also verified live on `:3100`:

- `/api/config`, `/api/wallets`, `/api/redemptions` → **401** without a session; 200 with.
- `/admin/redeem` → **307** for a cashier, **200** for a host (page was split into a server component
  with a real `requireRole` gate; previously the UI only hid the nav link).
- All 8 admin pages return 200.
- `npx tsc --noEmit` exits 0; `npm run build:check` exits 0.

**One real wallet was legitimately modified** by the expiry fix: `DEM-0424-EHLVT` went `active → expired`
with **balance preserved** at ₹1,000. Derived expiry = 25 Apr 02:00 IST, the event's 2AM cutoff. Correct —
that wallet had been spendable indefinitely.

---

## 3. Still needs your decision

- **`WALLET_PASS_PDF_TEMPLATE_ENTRY` is unset**, so entry-only passes (comps, ₹0-cover tickets) refuse to
  send. This is deliberate fail-closed behaviour — Meta silently drops a message whose variable count
  doesn't match the approved template. You need a 2-variable template approved with a **Document** header.
- **Neither cover-pass template has ever been sent successfully.** Worth one live test before a busy night.
- Money is stored as `REAL` (float). Now quantised to paise on write, but migrating to **integer paise**
  would make drift structurally impossible.
- Per-wallet cap defaults to ₹200,000 (`MAX_WALLET_AMOUNT`). Adjust if you ever issue more.

---

## 4. Affiliates + Affiliate Payouts — NOT AUDITED

The affiliates agent **failed** (stalled on all 6 attempts). I have no findings for Affiliates or Payouts.

What I do know from scouting: `affiliates` and `affiliate_clicks` are both **empty** — the module has never
been used with real data, so runtime breaks are likely and static reading wouldn't catch them. This needs a
re-run before you rely on it.

---

## 5. Abandoned Bookings — audit (report only, nothing changed)

### What works

AuthZ is correct on all five routes. Concurrent sweeps genuinely do **not** double-message (proven with
two parallel sweeps — `UNIQUE(source, source_id)` makes the loser skip). The recover endpoint is idempotent
(200 then 409) and creates no financial objects. Both pages render with proper empty states. Genuinely-paid
reservations are excluded. Wallet top-ups are correctly kept out of the ledger.

### What is broken

**The definition of "abandoned" is wrong.** It is simply `reservations.status = 'pending'` — which every
phone booking, every Reservego-synced table booking, and **even a guest already checked in at the door**
still satisfies. Running the real sweep against a copy fired recovery WhatsApps at all 8 guests of one event,
including one who was `fully_checked_in`.

| Severity | Finding |
|---|---|
| CRITICAL | "Abandoned" = `status='pending'` — phone bookings and checked-in guests get "you didn't finish" |
| CRITICAL | Guest retried and **paid**, but the stale first checkout row is still messaged |
| HIGH | "Mark recovered" on a payment makes the reservation pop back as abandoned — and messages the guest |
| HIGH | "Mark recovered" on a lead sets the reservation `cancelled`, **permanently blocking online payment** |
| HIGH | **No scheduler** — recovery only fires while an admin is looking at the Overview tab |
| HIGH | Recovery attribution can essentially never match, so "Recovered" and "Revenue Recovered" are permanently 0 |
| HIGH | Headline recovery-rate KPI uses send-failures as denominator — showed **90.91%** where truth was **5%** |
| HIGH | No per-guest cap, no opt-out, no quiet hours — WABA quality-rating risk |
| MEDIUM | No throttle — 20 sends in 230ms (~5,200/min) against Interakt's 40/min |
| MEDIUM | `sent_at` stamped *before* sending, so a crashed sweep falsely reads "Reminder sent" |
| MEDIUM | No event-date guard — guests asked to "finish booking" events that already happened |
| MEDIUM | Razorpay webhook secret is empty, so captures where the browser doesn't return stay `created` → get messaged |

The WABA risk deserves emphasis: that WhatsApp number **also carries OTP login and cover-pass delivery**.
If it gets rate-limited or quality-flagged for spam, wallet issuance breaks venue-wide.

### Recommended additions (ranked)

**Do first — these stop customer complaints:**
1. **(S) Smart suppression** — never message anyone who already paid, is checked in, or was marked recovered.
   Single highest-value change; kills the "I already paid and you WhatsApped me" problem.
2. **(S) Real scheduled sweep** — token-guarded `POST /api/cron/cart-recovery` on a 5-min external schedule,
   instead of firing on a page view.
3. **(S) Quiet hours** (default 10:00–21:00 IST) with deferral. Admins review numbers at 3am; right now that
   page load is what sends the messages.
4. **(S) Dry-run preview + test-send** — "Preview recipients" with reasons, before any real sweep. Would have
   caught both CRITICALs before a guest was contacted.

**Then:**
5. **(M) Frequency cap + do-not-contact list** with STOP handling — protects the shared WhatsApp number.
6. **(M) Honest recovery reporting** — rate on delivered messages, revenue recovered, cost per recovery.
7. **(M) True resume link** — signed one-tap token restoring pax/zone/coupon and reusing the payment row.
   Lifts conversion *and* makes attribution measurable.
8. **(S) Split the outcome model** (Recovered / Dismissed / Lost) without mutating reservation status.
9. **(S) Retry queue with backoff** — today one 429 permanently burns every candidate it touched.
10. **(M) Multi-touch sequence** (t+1h → t+24h with incentive → t+3d), stop-on-conversion.
11. **(M) Discount-on-recovery** — mint a single-use coupon; makes attribution exact.
12. **(M) Template validation** against the Interakt approved list, with rendered preview.

---

## 6. Caveats on this report

- One fix bucket failed, as did the gate agent — I ran the gate myself (tsc, build, live route checks).
- I verified the **core money paths** by execution. I have **not** hand-verified all 58 findings individually;
  the fix reports carry their own before/after evidence.
- Test writes ran against `/tmp` copies via the new `EVENTCOVER_DB_PATH` override. Your real DB is clean:
  13 wallets, 5 redemptions, 17 guests, 6 events, 0 affiliates — matching the pre-run baseline exactly.
- A pre-cleanup backup exists at `data/eventcover.PRE-CLEANUP-20260806-022425.db`. Safe to delete once happy.
