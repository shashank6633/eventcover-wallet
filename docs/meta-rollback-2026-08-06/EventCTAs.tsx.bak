'use client';

import { fireMetaEvent } from '@/components/MetaPixel';

/**
 * The 3 primary CTAs on the public event page. Stacks on mobile, sits in a
 * 3-column row on desktop. Each click fires the corresponding Meta Pixel
 * event:
 *
 *   - WhatsApp → Contact
 *   - Call     → Contact
 *   - Reserve  → InitiateCheckout (then scrolls to #book)
 */

interface Props {
  waUrl: string;
  telUrl: string;
}

export function EventCTAs({ waUrl, telUrl }: Props) {
  function handleReserveClick(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    fireMetaEvent('InitiateCheckout');
    // Mirror to per-event analytics dashboard. "Reserve online" is the
    // hero CTA on the public event page; we count this as a book_click
    // (the customer expressed intent to book) even though the Razorpay
    // checkout modal opens later from the form. The form fires a
    // separate checkout_started event when Razorpay actually opens.
    if (typeof window !== 'undefined') {
      window.__trackEvent?.('book_click', { ctaSource: 'reserve_online' });
    }
    const el = document.getElementById('book');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Move focus to the first input for accessibility / mobile keyboards.
      const firstInput = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        'input, textarea',
      );
      if (firstInput) {
        // Delay slightly so the scroll animation can settle before focus
        // jumps the page on some mobile browsers.
        setTimeout(() => firstInput.focus({ preventScroll: true }), 250);
      }
    }
  }

  return (
    <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3">
      <a
        href={waUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => {
          fireMetaEvent('Contact', { method: 'whatsapp' });
          if (typeof window !== 'undefined') {
            window.__trackEvent?.('book_click', { ctaSource: 'whatsapp' });
          }
        }}
        className="btn btn-primary text-base py-3 w-full"
      >
        Get pass via WhatsApp
      </a>
      <a
        href={telUrl}
        onClick={() => fireMetaEvent('Contact', { method: 'phone' })}
        className="btn btn-secondary text-base py-3 w-full"
      >
        Call to book
      </a>
      <a
        href="#book"
        onClick={handleReserveClick}
        className="btn btn-dark text-base py-3 w-full"
      >
        Reserve online
      </a>
    </div>
  );
}
