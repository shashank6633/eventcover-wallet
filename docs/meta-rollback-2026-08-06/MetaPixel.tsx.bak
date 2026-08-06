'use client';

import Script from 'next/script';

/**
 * Meta Pixel injector. Renders the standard Meta Pixel base snippet via
 * <Script strategy="afterInteractive"> plus a <noscript> fallback img.
 *
 * Mount this once per public-facing page that should be tracked (currently
 * /event/[slug]). The base code initialises window.fbq, then any events
 * passed in `events` are fired immediately on script load.
 *
 * Subsequent custom events (e.g. on CTA click, on form submit) should be
 * fired imperatively via the exported fireMetaEvent() helper.
 */

export interface MetaPixelEvent {
  name:
    | 'PageView'
    | 'ViewContent'
    | 'InitiateCheckout'
    | 'Lead'
    | 'Purchase'
    | 'Contact';
  data?: Record<string, unknown>;
}

interface MetaPixelProps {
  pixelId: string;
  testEventCode?: string;
  events?: MetaPixelEvent[];
}

export function MetaPixel({ pixelId, testEventCode, events = [] }: MetaPixelProps) {
  if (!pixelId) return null;

  const trackCalls = events
    .map((e) =>
      e.data
        ? `fbq('track', ${JSON.stringify(e.name)}, ${JSON.stringify(e.data)});`
        : `fbq('track', ${JSON.stringify(e.name)});`,
    )
    .join('\n');

  // Per-event `test_event_code` is appended only when provided. It's the
  // standard Meta debugger pattern.
  const testCodeLine = testEventCode
    ? `fbq('set', 'test_event_code', ${JSON.stringify(testEventCode)});`
    : '';

  const snippet = `
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', ${JSON.stringify(pixelId)});
${testCodeLine}
${trackCalls}
`.trim();

  return (
    <>
      <Script
        id={`meta-pixel-${pixelId}`}
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{ __html: snippet }}
      />
      <noscript>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          height="1"
          width="1"
          style={{ display: 'none' }}
          alt=""
          src={`https://www.facebook.com/tr?id=${encodeURIComponent(
            pixelId,
          )}&ev=PageView&noscript=1`}
        />
      </noscript>
    </>
  );
}

/**
 * Fire a Meta Pixel `track` event imperatively. Safe to call before fbq has
 * loaded — the base snippet stubs fbq() with a queue, so calls are flushed
 * once fbevents.js arrives.
 *
 * No-ops cleanly on the server or when the pixel snippet was never injected
 * (e.g. event has no configured Pixel ID).
 */
export function fireMetaEvent(name: string, data?: Record<string, unknown>) {
  if (typeof window === 'undefined') return;
  const w = window as unknown as {
    fbq?: (...args: unknown[]) => void;
  };
  if (typeof w.fbq !== 'function') return;
  if (data) {
    w.fbq('track', name, data);
  } else {
    w.fbq('track', name);
  }
}
