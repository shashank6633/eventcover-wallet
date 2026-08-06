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
