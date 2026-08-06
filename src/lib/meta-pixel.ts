/**
 * Meta Conversions API (CAPI) helper.
 *
 * The browser-side Pixel snippet covers ~70% of conversions. The remaining
 * 30% — Safari ITP, ad blockers, server-side ticket creation — needs CAPI
 * to fire from our backend. This module owns the request shape, hashing
 * rules, and fire-and-forget delivery so route handlers stay thin.
 *
 * Reference: https://developers.facebook.com/docs/marketing-api/conversions-api
 */

import { createHash } from 'crypto';
import { getConfig } from './db';
import { logAudit } from './audit';

const CAPI_VERSION = 'v18.0';

export type CapiEventName =
  | 'PageView'
  | 'ViewContent'
  | 'InitiateCheckout'
  | 'Lead'
  | 'Purchase'
  | 'Contact';

export interface CapiUserData {
  /** SHA-256 hashed phone numbers, e.g. ["abc123..."] — must be pre-hashed. */
  ph?: string[];
  /** SHA-256 hashed emails. */
  em?: string[];
  /** _fbp cookie value, passed through verbatim. */
  fbp?: string;
  /** _fbc cookie value, passed through verbatim. */
  fbc?: string;
  client_ip_address?: string;
  client_user_agent?: string;
}

export interface SendCapiInput {
  pixelId: string;
  accessToken: string;
  eventName: CapiEventName;
  /** Stable ID for browser-server dedup. */
  eventId: string;
  /** Unix seconds. Defaults to now. */
  eventTime?: number;
  userData: CapiUserData;
  customData?: Record<string, unknown>;
  testEventCode?: string;
  sourceUrl?: string;
  /** Defaults to 'website'. Use 'system_generated' for fully-backend triggers. */
  actionSource?: 'website' | 'system_generated' | 'app' | 'email' | 'other';
}

export interface SendCapiResult {
  ok: boolean;
  status: number;
  response: unknown;
}

// ─── Config getters ────────────────────────────────────────────────────────

/**
 * Returns the Pixel ID that should be used for a given event. Event-level
 * override wins; otherwise falls back to the venue-wide `META_PIXEL_ID`.
 * Returns '' (empty string) if neither is configured — caller should
 * treat that as "do nothing".
 */
export function getEffectivePixelId(eventOverride?: string | null): string {
  const override = (eventOverride || '').trim();
  if (override) return override;
  return getConfig('META_PIXEL_ID', '').trim();
}

export function getCapiAccessToken(): string {
  return getConfig('META_CAPI_ACCESS_TOKEN', '').trim();
}

export function getTestEventCode(): string {
  return getConfig('META_TEST_EVENT_CODE', '').trim();
}

// ─── Hashing + normalization ──────────────────────────────────────────────

/**
 * SHA-256 hex of a lowercased, trimmed string. Used for hashed PII fields
 * Meta accepts (em, ph). Meta does NOT salt — straight hash only.
 */
export function hashSha256Lowercase(s: string): string {
  return createHash('sha256').update(s.toLowerCase().trim()).digest('hex');
}

/**
 * Meta wants phone numbers as digits-only with country code, no plus sign.
 * Examples:
 *   "+91 98765 43210"  → "919876543210"
 *   "+1 (555) 123-4567" → "15551234567"
 *   "919876543210"     → "919876543210"
 */
export function normalizePhoneForCapi(phone: string): string {
  if (!phone) return '';
  return String(phone).toLowerCase().replace(/\D/g, '');
}

// ─── Send ──────────────────────────────────────────────────────────────────

/**
 * POST one event to the Conversions API.
 *
 * Caller is responsible for hashing PII fields (ph, em) — we don't auto-hash
 * because some inputs (e.g. fbp, fbc) must stay plaintext, and double-hashing
 * silently breaks attribution. Use hashSha256Lowercase + normalizePhoneForCapi
 * before passing values in.
 */
// ─── Retry ────────────────────────────────────────────────────────────────
//
// A 1000-event load test delivered 1000/1000 with zero throttling, so volume
// is not the risk. Connectivity is: an earlier run lost 11 consecutive events
// to a ~20 second local network blip. Each returned { ok: false, status: 0 },
// which nothing retried — those conversions were gone. On venue wifi that is a
// routine event, not an edge case.

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;

/**
 * Is this failure worth trying again?
 *
 * Retry ONLY what a second attempt could plausibly fix:
 *   status 0   — fetch threw: DNS, TCP reset, timeout, wifi drop
 *   5xx        — Meta's own server-side fault
 *   429        — rate limited; backing off is the prescribed response
 *
 * Deliberately NOT retried: every other 4xx. An invalid token (190), a
 * malformed payload or a wrong pixel id fails identically no matter how many
 * times it is sent — retrying burns time and hides the real error behind
 * repeated identical failures.
 */
function isRetryable(status: number): boolean {
  return status === 0 || status === 429 || (status >= 500 && status < 600);
}

/**
 * Send with bounded exponential backoff and jitter.
 *
 * Jitter matters more than usual here: a wifi drop fails EVERY in-flight event
 * at once, so a fixed backoff would have the whole batch retry in lockstep the
 * instant the network returns — a self-inflicted thundering herd against Meta.
 * Randomising each delay spreads them out.
 *
 * Worst case adds roughly 400ms + 800ms ≈ 1.2s (plus jitter) — and ONLY on a
 * failing send. A healthy send still makes exactly one request and returns in
 * ~300ms, so the happy path is untouched.
 */
export async function sendCapiEventWithRetry(
  input: SendCapiInput,
  maxAttempts = RETRY_MAX_ATTEMPTS,
): Promise<SendCapiResult & { attempts: number }> {
  let last: SendCapiResult = { ok: false, status: 0, response: { error: 'not_attempted' } };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await sendCapiEvent(input);
    if (last.ok) return { ...last, attempts: attempt };
    if (!isRetryable(last.status)) return { ...last, attempts: attempt };
    if (attempt === maxAttempts) break;

    // 400ms, 800ms, … each with up to 50% extra jitter.
    const backoff = RETRY_BASE_MS * 2 ** (attempt - 1);
    await new Promise((r) => setTimeout(r, backoff + Math.floor(Math.random() * backoff * 0.5)));
  }

  return { ...last, attempts: maxAttempts };
}

/** Where a CAPI send came from, for the audit row. */
export interface CapiAuditContext {
  actor: string;
  entityType: string;
  /** The row the conversion belongs to — ticket id, reservation id, payment id. */
  entityId: string;
  eventName: CapiEventName;
  /** The dedup key, i.e. what the browser also sent as fbq's eventID. */
  eventId: string;
  pixelId: string;
  value?: number;
}

/**
 * Record the outcome of a CAPI send — success or failure — in the audit log.
 *
 * This exists because `sendCapiEvent` NEVER THROWS: it returns
 * `{ ok: false, status, response }`. Every call site used to do
 * `.catch(() => {})`, which catches nothing, and then dropped the returned
 * value on the floor. A rejected token, a wrong pixel id, a malformed payload
 * and a perfectly delivered event were all indistinguishable — there was no
 * log line, no audit row and no counter anywhere in the system. That is what
 * made CAPI look like it "just doesn't work" with nothing to diagnose.
 *
 * Meta's error body carries `fbtrace_id` and a numeric code and contains no
 * PII, so it is stored verbatim on failure — that is the field that turns a
 * silent outage into an answer. On success only the status is kept, to avoid
 * writing an audit row per sale that is bigger than the sale.
 */
export function logCapiResult(
  result: SendCapiResult & { attempts?: number },
  ctx: CapiAuditContext,
): void {
  const slug = ctx.eventName.toLowerCase();
  logAudit({
    actor: ctx.actor,
    action: result.ok ? `meta_capi_${slug}_sent` : `meta_capi_${slug}_failed`,
    entityType: ctx.entityType,
    entityId: ctx.entityId,
    details: {
      event_id: ctx.eventId,
      pixel_id: ctx.pixelId,
      value: ctx.value,
      status: result.status,
      // How many tries it took. >1 on a SENT row means the network wobbled and
      // the retry saved a conversion that would previously have been lost —
      // the only way to see that this is earning its keep.
      attempts: result.attempts,
      response: result.ok ? undefined : result.response,
    },
  });
}

/**
 * Fire a CAPI event and audit the outcome, without making the caller wait.
 *
 * The two customer-facing call sites (ticket issue, public reservation) must
 * not pay a Meta round trip — door staff and a guest mid-booking are both
 * waiting on that response. So this stays detached, but unlike the old
 * `.catch(() => {})` the result is now always recorded.
 *
 * Caveat worth knowing: on a serverless host the instance can be frozen the
 * moment the HTTP response is returned, which can kill a detached promise
 * before it settles. Where the conversion matters more than the millisecond —
 * `/api/payments/verify`, an actual paid sale — the caller awaits instead.
 */
export function sendCapiEventAudited(input: SendCapiInput, ctx: CapiAuditContext): void {
  sendCapiEventWithRetry(input)
    .then((result) => logCapiResult(result, ctx))
    .catch((err: unknown) => {
      // Defensive: sendCapiEvent is written not to throw, but a future edit
      // (or an import-time failure) must not silently swallow the event again.
      logCapiResult(
        { ok: false, status: 0, response: { error: err instanceof Error ? err.message : 'unknown' } },
        ctx,
      );
    });
}

export async function sendCapiEvent(input: SendCapiInput): Promise<SendCapiResult> {
  if (!input.pixelId || !input.accessToken) {
    return { ok: false, status: 0, response: { error: 'pixelId and accessToken required' } };
  }

  const data: Record<string, unknown> = {
    event_name: input.eventName,
    event_time: input.eventTime ?? Math.floor(Date.now() / 1000),
    event_id: input.eventId,
    action_source: input.actionSource ?? 'website',
    user_data: input.userData,
  };
  if (input.sourceUrl) data.event_source_url = input.sourceUrl;
  if (input.customData) data.custom_data = input.customData;

  const payload: Record<string, unknown> = { data: [data] };
  if (input.testEventCode) payload.test_event_code = input.testEventCode;

  const url = `https://graph.facebook.com/${CAPI_VERSION}/${encodeURIComponent(input.pixelId)}/events?access_token=${encodeURIComponent(input.accessToken)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep as text */ }
    return { ok: res.ok, status: res.status, response: parsed };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      response: { error: err instanceof Error ? err.message : 'network_error' },
    };
  }
}
