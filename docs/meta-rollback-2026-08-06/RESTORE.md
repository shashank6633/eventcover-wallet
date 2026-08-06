# Meta Pixel / CAPI — rollback to the pre-change code

Snapshot taken 6 Aug 2026, immediately BEFORE building fixes #1 (browser↔server
event dedup via eventID) and #2 (server-side Purchase on payment verify).

If the new tracking behaves worse than before, restore these five files and the
system returns to exactly the state it was in.

## Restore everything

```bash
cd ~/Desktop/Claude/eventcover-wallet-local
cp docs/meta-rollback-2026-08-06/MetaPixel.tsx.bak            src/components/MetaPixel.tsx
cp docs/meta-rollback-2026-08-06/PublicBookingForm.tsx.bak    src/components/PublicBookingForm.tsx
cp docs/meta-rollback-2026-08-06/EventCTAs.tsx.bak            "src/app/event/[slug]/EventCTAs.tsx"
cp docs/meta-rollback-2026-08-06/payments-verify-route.ts.bak src/app/api/payments/verify/route.ts
cp docs/meta-rollback-2026-08-06/meta-pixel.ts.bak            src/lib/meta-pixel.ts
npx tsc --noEmit
```

Then restart the dev server. Nothing else in the app depends on these changes.

## What each file was responsible for, before the change

| File | Role before |
|---|---|
| `MetaPixel.tsx` | Base pixel snippet + `fireMetaEvent(name, data)` — **no eventID argument**, so browser events carried no dedup key |
| `PublicBookingForm.tsx` | Fired `Lead` (845), `InitiateCheckout` (940), `Purchase` (1011) — all without a dedup key |
| `EventCTAs.tsx` | Fired `InitiateCheckout` (23) and `Contact` (54, 65) |
| `payments/verify/route.ts` | Verified the Razorpay payment and issued the wallet — **fired no Meta event at all** |
| `meta-pixel.ts` | `sendCapiEvent` + hashing helpers (Graph `v18.0`) |

Note: `meta-pixel.ts` is included only as a precaution — fixes #1 and #2 may not
need to modify it.

---

## Second batch — fixes #3 and #4 (added later the same day)

Two more files snapshotted before removing the `_fbp`/`_fbc` cookie gate on the
ticket CAPI send (#3) and making every CAPI result audited (#4).

```bash
cp docs/meta-rollback-2026-08-06/tickets-route.ts.bak             src/app/api/tickets/route.ts
cp docs/meta-rollback-2026-08-06/reservations-public-route.ts.bak src/app/api/reservations/public/route.ts
```

| File | Role before |
|---|---|
| `api/tickets/route.ts` | Fired CAPI `Purchase`, but **only when `_fbp` or `_fbc` was present**, and discarded the result |
| `api/reservations/public/route.ts` | Fired CAPI `Lead` and discarded the result |

Note `src/lib/meta-pixel.ts` gains a `logCapiResult()` helper in this batch; the
`.bak` copy of it restores the version without that export, so restore all files
from a batch together.
