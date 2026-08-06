/**
 * Guest pass — A6 PDF generator (cover pass and entry ticket).
 *
 * Layout (strict top-to-bottom flow, no overlap):
 *   1. Header band       — logo + venue name + "COVER PASS" / "ENTRY PASS"
 *   2. Event band        — event name + event date
 *   3. QR block          — QR code with logo overlaid in center
 *   4. Guest info        — Guest name (large) · cover or entry line · Valid until
 *   5. (whitespace)
 *   6. Footer band       — T&C paragraph + "Powered by" closing line
 *
 * Design rules:
 *   • Every section is rendered through a SectionDrawer that advances a single
 *     y-cursor — no two sections can overlap because the cursor is monotonic.
 *   • The footer band's height is computed first (T&C lines + Powered by +
 *     bottom margin), then reserved as a floor. The middle flow can never
 *     descend into footer territory.
 *   • Content length is variable — long event/guest names are truncated to
 *     known widths; the T&C paragraph wraps to any number of lines.
 *   • All text in black for high-contrast print.
 *
 * This file serves delivery tiers 2 and 3 (tier 1, the free reservation, is
 * text-only and never renders a PDF):
 *   • tier 2 — paid ticket, no cover : QR is an entry credential, nothing to
 *     redeem, so the copy must not mention a PIN at all.
 *   • tier 3 — cover charge issued   : same QR, but the guest also holds bar
 *     credit that redemption.ts gates behind verifyPin(). The copy must say a
 *     PIN is needed and that it arrived on WhatsApp.
 * The PIN itself is NEVER drawn here. A PDF gets forwarded, screenshotted and
 * left in downloads folders; the PIN is the single factor that stops a copied
 * QR from draining the bar credit, so it must not ride in the same file.
 *
 * Pure function — no DB, no side effects.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type PDFImage } from 'pdf-lib';
import QRCode from 'qrcode';
import sharp from 'sharp';

// A6 in points (1 mm = 72/25.4 pt → 105 mm ≈ 297.64, 148 mm ≈ 419.53)
const A6_WIDTH = 297.64;
const A6_HEIGHT = 419.53;

const INK = rgb(0, 0, 0);
const RULE = rgb(0.85, 0.85, 0.85);

const MARGIN_X = 20;
const MARGIN_Y = 18;

/**
 * Footer copy, tier-aware.
 *
 * Kept short on purpose: the footer height is reserved before the QR is sized
 * (see footerTop below), so every extra wrapped line steals points from the
 * QR. Two lines each at 9pt keeps the QR near its 160pt cap.
 */
const TERMS_COVER =
  'Scan this QR at the door. Spending your bar credit also needs the PIN sent to you on WhatsApp - keep it private.';
const TERMS_ENTRY =
  'Scan this QR at the door. Entry pass only - it carries no bar credit and needs no PIN.';

export interface PassPdfInput {
  txnId: string;
  /**
   * The plaintext PIN under an older alias. Still accepted so existing callers
   * keep compiling, but deliberately NOT rendered — see the file header.
   */
  qrCodeId?: string;
  guestName: string;
  coverAmount: number;
  /**
   * True when the wallet carries redeemable bar credit (wallets.cover_issued
   * > 0). Drives the pass label, the amount line and the footer, because tier
   * 3 needs PIN wording and tier 2 must not mention a PIN it doesn't have.
   * Defaults to `coverAmount > 0`, so the two PDF routes — which already pass
   * cover_issued as coverAmount — get the right copy without changing.
   */
  hasCover?: boolean;
  eventName?: string;
  /**
   * The event's own date as `YYYY-MM-DD` (events.event_date) — the same field
   * the PNG pass reads. Optional so existing callers keep compiling, but pass
   * it whenever the caller has the events row: without it this file has to
   * RECONSTRUCT the date from expiresAt (see formatEventDate), and that guess
   * goes wrong the moment an event is rescheduled.
   */
  eventDate?: string | null;
  venueName?: string;
  venueLogo?: string;
  expiresAt?: number | null;
  termsText?: string;
}

export async function generatePassPdf(input: PassPdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([A6_WIDTH, A6_HEIGHT]);

  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const center = A6_WIDTH / 2;
  const contentWidth = A6_WIDTH - MARGIN_X * 2;
  const venueName = (input.venueName || 'AKAN Hyderabad').toUpperCase();

  // Tier switch. An explicit hasCover wins so a caller that knows the wallet
  // can override; otherwise the amount is the honest signal.
  const hasCover = input.hasCover ?? input.coverAmount > 0;
  // "COVER PASS" on a ticket with no cover is a promise the pass can't keep.
  const passLabel = hasCover ? 'COVER PASS' : 'ENTRY PASS';

  // ─── Load logo (PNG/JPEG only — SVG falls back to text header) ──────────
  let logoImage: PDFImage | null = null;
  if (input.venueLogo) {
    try { logoImage = await embedDataUrl(pdf, input.venueLogo); } catch { logoImage = null; }
  }

  // ─── PASS 1 — pre-compute footer height so we can reserve it ────────────
  // An explicit termsText is a venue override and is used verbatim; otherwise
  // pick the copy that matches the tier.
  const termsRaw = input.termsText || (hasCover ? TERMS_COVER : TERMS_ENTRY);
  const termsLines = wrapText(helv, termsRaw, contentWidth, 9);
  const termsHeight = termsLines.length * 11.5;
  const poweredHeight = 12;
  const footerBlockHeight = termsHeight + 8 + poweredHeight; // 8pt gap between blocks
  const footerTop = MARGIN_Y + footerBlockHeight; // y-coordinate of the footer's top edge

  // ─── PASS 2 — render everything else top-down ───────────────────────────
  const drawer = new SectionDrawer(page, A6_HEIGHT - MARGIN_Y);

  // 1. HEADER BAND — logo (left) + venue/pass (right), side-by-side.
  //    Saves ~28pt of vertical space vs stacked centered header, which lets
  //    the QR + guest info + T&C breathe at the bottom.
  if (logoImage) {
    const headerHeight = 44;
    const logoSize = 44;
    const headerTop = drawer.cursor;
    // Logo on the left
    page.drawImage(logoImage, {
      x: MARGIN_X,
      y: headerTop - logoSize,
      width: logoSize,
      height: logoSize,
    });
    // Text block on the right, vertically centered within the logo band
    const textBlockX = MARGIN_X + logoSize + 12;
    page.drawText(venueName, {
      x: textBlockX,
      y: headerTop - logoSize / 2 + 1,
      size: 13,
      font: helvBold,
      color: INK,
    });
    page.drawText(passLabel, {
      x: textBlockX,
      y: headerTop - logoSize / 2 - 11,
      size: 8,
      font: helv,
      color: INK,
    });
    drawer.advance(headerHeight);
  } else {
    // Fallback when no logo — single centered stack (still compact)
    drawer.centered(venueName, { font: helvBold, size: 13, center });
    drawer.gap(3);
    drawer.centered(passLabel, { font: helv, size: 8, center });
  }
  drawer.gap(12);
  drawer.divider(MARGIN_X, A6_WIDTH - MARGIN_X);
  drawer.gap(14);

  // 2. EVENT BAND
  if (input.eventName) {
    drawer.centered(truncateToWidth(helvBold, input.eventName, contentWidth, 11), {
      font: helvBold, size: 11, center,
    });
    drawer.gap(4);
  }
  const evDate = formatEventDate(input.eventDate, input.expiresAt);
  if (evDate) {
    drawer.centered(evDate, { font: helv, size: 8, center });
  }
  drawer.gap(12);

  // 3. QR BLOCK
  const qrSize = computeQrSize(drawer.cursor, footerTop, /* reserveBelow */ 100);
  await drawQrWithOverlay(pdf, page, {
    txnId: input.txnId,
    centerX: center,
    topY: drawer.cursor,
    size: qrSize,
    logoImage,
  });
  drawer.advance(qrSize);
  drawer.gap(12);
  drawer.divider(MARGIN_X, A6_WIDTH - MARGIN_X);
  drawer.gap(12);

  // 4. GUEST INFO
  drawer.centered(truncateToWidth(helvBold, input.guestName, contentWidth, 13), {
    font: helvBold, size: 13, center,
  });
  drawer.gap(6);
  // "Cover loaded   INR 0" reads as a broken pass on an entry-only ticket.
  //
  // "INR" here is DELIBERATE, not an oversight, and must not be "fixed" to the
  // ₹ glyph to match the PNG pass and the WhatsApp text (both of which do use
  // ₹, and agree with each other). This page is drawn with pdf-lib's standard
  // Helvetica, which is WinAnsi-encoded: drawing '₹' throws
  //   `WinAnsi cannot encode "₹" (0x20b9)`
  // and takes the whole pass down with it. Printing ₹ from here would mean
  // embedding a Unicode font — a real change with real bytes, not a formatting
  // tweak. The AMOUNT is identical across all three artefacts; only the symbol
  // differs.
  drawer.centered(
    hasCover
      ? `Cover loaded   INR ${input.coverAmount.toLocaleString('en-IN')}`
      : 'Entry pass   No bar credit',
    { font: helv, size: 10, center },
  );
  drawer.gap(4);
  if (input.expiresAt) {
    const exp = new Date(input.expiresAt).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    drawer.centered(`Valid until   ${exp}`, { font: helv, size: 9, center });
  }

  // Safety check — if middle content somehow overflowed into footer space,
  // log it (dev only). The footer still renders at its reserved position so
  // the user gets a partially-overlapping page rather than no page.
  if (drawer.cursor < footerTop) {
    /* eslint-disable no-console */
    console.warn(`[pass-pdf] content overflowed into footer area (${drawer.cursor.toFixed(1)} < ${footerTop.toFixed(1)})`);
    /* eslint-enable no-console */
  }

  // 5. FOOTER BAND (drawn at reserved bottom position)
  // T&C paragraph
  let footerY = MARGIN_Y + poweredHeight + 8 + termsHeight - 11.5;
  for (const line of termsLines) {
    drawCenteredText(page, line, { y: footerY, size: 9, font: helv, color: INK, center });
    footerY -= 11.5;
  }
  // Powered by
  drawCenteredText(page, `Powered by ${venueName}`, {
    y: MARGIN_Y,
    size: 8,
    font: helvBold,
    color: INK,
    center,
  });

  return pdf.save();
}

/**
 * The date line printed under the event name.
 *
 * Prefers the event's OWN date. This file used to receive only expiresAt and
 * reconstruct the date as `expiresAt − 24h`, which is correct only while the
 * invariant `expires_at === event_date + cutoff_hour` holds. Nothing back-fills
 * expires_at when an event is rescheduled, and live data already violates it
 * (wallet AKA-0518-V271S expires 21 May 02:00 IST — so it printed 20 May —
 * while its event's event_date is 2026-06-05). The PNG pass reads
 * events.event_date, so the two artefacts for one wallet printed different
 * dates and the PDF was the wrong one; a guest can turn up on the wrong night
 * holding the venue's own document.
 *
 * The derivation survives only as a fallback for wallets with no event link.
 * When neither input is available we print NOTHING — a blank line is honest,
 * a guessed date is not.
 */
function formatEventDate(
  eventDate: string | null | undefined,
  expiresAt: number | null | undefined,
): string | null {
  const opts = {
    timeZone: 'Asia/Kolkata',
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  } as const;
  const iso = String(eventDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    // Anchor at midnight IST — same parse as pass-image.ts's formatDate — so
    // the calendar day can't slip a day on a UTC-clock server.
    return new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00+05:30`).toLocaleString('en-IN', opts);
  }
  if (expiresAt) {
    // Legacy derivation: the event "happened" the calendar day before the
    // wallet expires. Kept only for wallets that carry no event_id.
    return new Date(expiresAt - 24 * 3600 * 1000).toLocaleString('en-IN', opts);
  }
  return null;
}

// ─── SectionDrawer — monotonic top-down cursor ─────────────────────────────

class SectionDrawer {
  cursor: number;
  constructor(private page: PDFPage, top: number) {
    this.cursor = top;
  }
  /** Move cursor down by n points. */
  gap(n: number) { this.cursor -= n; }
  /** Advance cursor by n (treats n as the drawn item's height). */
  advance(n: number) { this.cursor -= n; }
  centered(text: string, opts: { font: PDFFont; size: number; center: number }) {
    // Draw at (cursor - size) so size = ascent ~= height; advance accordingly
    drawCenteredText(this.page, text, {
      y: this.cursor - opts.size,
      size: opts.size,
      font: opts.font,
      color: INK,
      center: opts.center,
    });
    this.cursor -= opts.size;
  }
  image(img: PDFImage, opts: { centerX: number; width: number; height: number }) {
    this.page.drawImage(img, {
      x: opts.centerX - opts.width / 2,
      y: this.cursor - opts.height,
      width: opts.width,
      height: opts.height,
    });
    this.cursor -= opts.height;
  }
  divider(x1: number, x2: number) {
    this.page.drawLine({
      start: { x: x1, y: this.cursor },
      end: { x: x2, y: this.cursor },
      thickness: 0.5,
      color: RULE,
    });
  }
}

// ─── QR with logo overlay ──────────────────────────────────────────────────

async function drawQrWithOverlay(
  pdf: PDFDocument,
  page: PDFPage,
  opts: {
    txnId: string;
    centerX: number;
    topY: number;
    size: number;
    logoImage: PDFImage | null;
  },
) {
  const x = opts.centerX - opts.size / 2;
  const y = opts.topY - opts.size;

  // 4× the placed point size ≈ 288 dpi — enough that the modules stay square
  // on a laser print and on a phone screenshot of the PDF.
  const qrPngBytes = await renderQrPng(opts.txnId, Math.round(opts.size * 4));
  const qrImage = await pdf.embedPng(qrPngBytes);
  page.drawImage(qrImage, { x, y, width: opts.size, height: opts.size });

  if (opts.logoImage) {
    const overlaySize = Math.floor(opts.size * 0.22); // under H-level 30% recovery limit
    const padSize = overlaySize + 10;
    const cx = opts.centerX;
    const cy = y + opts.size / 2;
    page.drawRectangle({
      x: cx - padSize / 2,
      y: cy - padSize / 2,
      width: padSize,
      height: padSize,
      color: rgb(1, 1, 1),
    });
    page.drawImage(opts.logoImage, {
      x: cx - overlaySize / 2,
      y: cy - overlaySize / 2,
      width: overlaySize,
      height: overlaySize,
    });
  }
}

/**
 * Rasterise a QR to a PNG buffer via SVG → sharp, the same pipeline the PNG
 * pass uses (src/lib/pdf/pass-image.ts).
 *
 * PAYLOAD CONTRACT — the encoded string is the bare wallet txn_id, e.g.
 * "AKN-2608-X3F9Q", with nothing appended. It must stay byte-identical to the
 * PNG pass's payload so one captain scanner reads either artefact:
 * QrScanner.tsx's extractTxn() accepts a bare id matching
 * /^[A-Z]{2,5}-\d{2,6}-[A-Z0-9]{3,8}$/i (or a URL carrying it as ?t=). Adding
 * a prefix or a URL wrapper here would silently split the two passes apart.
 *
 * Error correction is 'H' rather than the PNG's 'M' because this pass punches
 * the venue logo through the middle of the code; 'H' recovers up to 30% and
 * the overlay covers ~5% of the area. The level changes the module grid, not
 * the payload, so both remain the same scan.
 *
 * Rendering goes through sharp instead of QRCode.toBuffer() deliberately:
 * toBuffer() only exists in the qrcode package's server entry point
 * (lib/server.js), and its package.json `browser` field maps the entry to
 * lib/browser.js, which exports no toBuffer at all. toString() exists in both,
 * so this path cannot lose its QR to a bundler resolution flip.
 */
async function renderQrPng(payload: string, pxSize: number): Promise<Buffer> {
  const qrSvg = await QRCode.toString(payload, {
    type: 'svg',
    errorCorrectionLevel: 'H',
    margin: 1,
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  // Strip the library's outer <svg> so the module paths can be re-scaled
  // inside a wrapper sized in real pixels — scaling the vector beats
  // upscaling a ~30px bitmap, which is what a plain resize would do.
  const qrInner = qrSvg
    .replace(/<\?xml[^?]*\?>/g, '')
    .replace(/<svg[^>]*>/, '')
    .replace(/<\/svg>/, '')
    .trim();
  const moduleSpan = extractQrModuleSpan(qrSvg);

  const scaled = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${pxSize}" height="${pxSize}" viewBox="0 0 ${pxSize} ${pxSize}" shape-rendering="crispEdges">
  <rect x="0" y="0" width="${pxSize}" height="${pxSize}" fill="#FFFFFF" />
  <g transform="scale(${pxSize / moduleSpan})">${qrInner}</g>
</svg>`;

  return sharp(Buffer.from(scaled))
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

/**
 * The qrcode SVG renderer emits `viewBox="0 0 N N"` where N is the module
 * count plus margin — the unit span the paths are drawn in. We need it to
 * scale those paths to pxSize.
 *
 * Throws rather than guessing: a wrong span renders a clipped or postage-stamp
 * QR that still looks like a pass, and the guest would only find out at the
 * door. A 500 at generation time is the cheaper failure.
 */
function extractQrModuleSpan(svg: string): number {
  const m = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) /) ||
            svg.match(/width="(\d+(?:\.\d+)?)"/);
  const span = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(span) || span <= 0) {
    throw new Error('[pass-pdf] could not determine QR module span from SVG');
  }
  return span;
}

/**
 * Adaptive QR size — uses all space available between the current cursor and
 * the reserved area below (footer + guest info). Caps at 160pt and floors at
 * 110pt so a long event name or T&C doesn't shrink the QR below scannable size.
 */
function computeQrSize(cursorY: number, footerTop: number, reserveBelow: number): number {
  const available = cursorY - footerTop - reserveBelow;
  return Math.max(110, Math.min(160, available));
}

// ─── Text helpers ──────────────────────────────────────────────────────────

function drawCenteredText(
  page: PDFPage, text: string,
  opts: { y: number; size: number; font: PDFFont; color: ReturnType<typeof rgb>; center: number },
) {
  const w = opts.font.widthOfTextAtSize(text, opts.size);
  page.drawText(text, {
    x: opts.center - w / 2,
    y: opts.y,
    size: opts.size,
    font: opts.font,
    color: opts.color,
  });
}

function wrapText(font: PDFFont, text: string, maxWidth: number, size: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Truncate text with an ellipsis so it fits within maxWidth at the given size. */
function truncateToWidth(font: PDFFont, text: string, maxWidth: number, size: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let lo = 0; let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const candidate = `${text.slice(0, mid)}…`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

async function embedDataUrl(pdf: PDFDocument, dataOrUrl: string): Promise<PDFImage> {
  let bytes: Uint8Array;
  let mime: string;

  if (dataOrUrl.startsWith('data:')) {
    const m = dataOrUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('invalid data URL');
    mime = m[1];
    bytes = Uint8Array.from(Buffer.from(m[2], 'base64'));
  } else {
    const res = await fetch(dataOrUrl);
    if (!res.ok) throw new Error(`logo fetch ${res.status}`);
    mime = res.headers.get('content-type') || 'image/png';
    bytes = new Uint8Array(await res.arrayBuffer());
  }

  if (mime.includes('jpeg') || mime.includes('jpg')) return pdf.embedJpg(bytes);
  if (mime.includes('svg')) {
    throw new Error('SVG logo not supported — upload PNG or JPEG via Settings → Venue Logo.');
  }
  return pdf.embedPng(bytes);
}
