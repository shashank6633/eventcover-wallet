'use client';

import { useEffect, useRef, useState } from 'react';

interface Props {
  onDetected: (txnId: string, fullText: string) => void;
  onClose: () => void;
}

/**
 * Camera QR scanner modal.
 *
 * Uses html5-qrcode under the hood — it handles camera permission, device selection,
 * and the scan loop. We accept either:
 *   - a full captain URL (`.../admin/redeem?t=TXN-XXX`) — extract the `t` param
 *   - a bare transaction ID (`TXN-XXX`) — use directly
 *
 * Unrelated QRs (Wi-Fi, URLs) show an error + keep scanning.
 */
type Html5QrcodeInstance = {
  stop: () => Promise<void>;
  clear: () => void;
};

export function QrScanner({ onDetected, onClose }: Props) {
  const containerId = 'ec-qr-reader';
  const readerRef = useRef<HTMLDivElement | null>(null);
  const scannerRef = useRef<Html5QrcodeInstance | null>(null);
  /**
   * Tracks whether scanner.start() has resolved AND we haven't yet stopped it.
   * Required because html5-qrcode's stop() throws a string (not an Error) if
   * the scanner isn't running, which then crashes React in dev. Cleanup and
   * the detection callback can both try to stop — without this flag they race.
   */
  const startedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [lastMiss, setLastMiss] = useState<string | null>(null);
  /**
   * Edge of the ACTUAL decode region, published by the qrbox callback below.
   * The guide reticle is drawn from this rather than a hard-coded 260px: the
   * decode box became responsive but the overlay did not, so on a short
   * viewfinder (where the clamp floors at 200px) staff were told to aim inside
   * a box LARGER than the region that decodes — a code lined up in its corner
   * silently fails and reads as "the scanner is broken".
   */
  const [guideEdge, setGuideEdge] = useState(260);

  // Stable callback ref — keeps onDetected fresh without making it a dependency
  // of the start effect (which would cause restart loops on parent re-renders).
  const onDetectedRef = useRef(onDetected);
  useEffect(() => { onDetectedRef.current = onDetected; }, [onDetected]);

  /** Safe stop — only runs once, swallows the library's sync-throw if any. */
  function safeStop(): Promise<void> {
    const s = scannerRef.current;
    if (!s || !startedRef.current) return Promise.resolve();
    startedRef.current = false;
    try {
      const p = s.stop();
      // Some versions return a Promise, some return non-Promise. Normalise.
      return Promise.resolve(p).then(() => { try { s.clear(); } catch { /* ignore */ } }).catch(() => { /* already stopped */ });
    } catch {
      // Synchronous throw from the library — already stopped or in a weird state
      return Promise.resolve();
    }
  }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const mod = await import('html5-qrcode');
        if (cancelled) return;

        const Html5Qrcode = mod.Html5Qrcode;
        // useBarCodeDetectorIfSupported hands decoding to the platform's
        // native BarcodeDetector (Chrome/Android since 83) instead of the
        // bundled pure-JS zxing fallback — by far the largest speed win
        // here. Silently ignored where the API is absent, which then keeps
        // the JS path.
        const scanner = new Html5Qrcode(containerId, {
          verbose: false,
          experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        });
        scannerRef.current = scanner;

        const scanConfig = {
          // 10fps left up to 100ms of dead air between decode attempts.
          fps: 24,
          // Was a fixed 260x260 box — a small target on a large phone that
          // staff had to line the code up inside. Sizing off the actual
          // viewfinder is far more forgiving; clamped to stay sane on very
          // small and very large viewports.
          qrbox: (viewW: number, viewH: number) => {
            const edge = Math.max(200, Math.min(520, Math.floor(Math.min(viewW, viewH) * 0.7)));
            // Keep the drawn guide equal to the real decode window. Called on
            // every layout pass, so guard the set to avoid a render loop.
            setGuideEdge((prev) => (prev === edge ? prev : edge));
            return { width: edge, height: edge };
          },
          aspectRatio: 1,
        };

        const onDecoded = (decoded: string) => {
          // Detection callback. We may still get one stale frame after
          // safeStop() — the startedRef guard makes that a no-op.
          if (!startedRef.current) return;
          const txn = extractTxn(decoded);
          if (!txn) {
            setLastMiss(truncate(decoded, 60));
            return;
          }
          setLastMiss(null);
          // Release the camera cleanly, THEN hand off to the parent.
          // Either path (stop succeeds or already-stopped) delivers the txn.
          safeStop().then(() => onDetectedRef.current(txn, decoded));
        };
        const onDecodeFailure = () => { /* normal "frame without a QR" event — ignore */ };

        // Fast path: let the browser pick the rear camera from a facingMode
        // constraint. The old code called getCameras() first, forcing a
        // device-enumeration round-trip (and on many phones a separate
        // permission step) before the camera could open.
        try {
          await scanner.start({ facingMode: 'environment' }, scanConfig, onDecoded, onDecodeFailure);
        } catch {
          // Fallback for devices that reject the constraint — enumerate and
          // match the rear lens by label, exactly as before.
          const cameras = await Html5Qrcode.getCameras();
          if (cancelled) return;
          if (!cameras || cameras.length === 0) {
            setError('No camera detected. Use the manual entry field below.');
            setStarting(false);
            return;
          }
          const back = cameras.find((c: { label: string }) => /back|rear|environment/i.test(c.label));
          await scanner.start((back || cameras[0]).id, scanConfig, onDecoded, onDecodeFailure);
        }
        if (cancelled) return;
        // start() resolved → scanner is actually running now
        startedRef.current = true;
        setStarting(false);
      } catch (e) {
        // start() can throw an Error OR a plain string depending on the failure
        // mode. Both need handling.
        const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : 'Could not start camera';
        if (/permission|denied/i.test(msg)) {
          setError('Camera permission denied. Enable it in your browser settings and retry.');
        } else {
          setError(msg);
        }
        setStarting(false);
      }
    })();

    return () => {
      cancelled = true;
      // Don't await — React unmount can't await. Just fire safeStop and let
      // it resolve on its own; the startedRef flip prevents double-stop.
      void safeStop();
    };
    // Mount-once effect — onDetected is captured via the ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-50 border border-slate-200 rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div>
            <div className="text-[10px] tracking-widest uppercase text-slate-500">Scanner</div>
            <div className="text-sm font-semibold text-slate-900">Scan guest QR</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-900 p-1" aria-label="Close scanner">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="relative bg-black aspect-square">
          <div id={containerId} ref={readerRef} className="w-full h-full" />
          {starting && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm">
              Starting camera…
            </div>
          )}
          {!starting && !error && (
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
              <div
                className="border-2 border-brand-500/80 rounded-xl shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] max-w-full max-h-full"
                style={{ width: guideEdge, height: guideEdge }}
              />
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-slate-200">
          {error ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 px-3 py-2 text-sm">
              {error}
            </div>
          ) : lastMiss ? (
            <div className="text-xs text-amber-700">
              Scanned but not an EventCover QR: <span className="font-mono">{lastMiss}</span>
            </div>
          ) : (
            <div className="text-xs text-slate-500">
              Point at the guest's QR code. It will detect automatically.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function extractTxn(text: string): string | null {
  const raw = text.trim();

  // Case 1: URL with ?t=TXN
  try {
    const url = new URL(raw);
    const t = url.searchParams.get('t');
    if (t && looksLikeTxn(t)) return t.toUpperCase();
  } catch { /* not a URL */ }

  // Case 2: bare TXN id
  if (looksLikeTxn(raw)) return raw.toUpperCase();
  return null;
}

function looksLikeTxn(s: string): boolean {
  return /^[A-Z]{2,5}-\d{2,6}-[A-Z0-9]{3,8}$/i.test(s.trim());
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
