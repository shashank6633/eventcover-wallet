'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Me { role: 'host' | 'manager' | 'cashier' | 'captain' | 'entry'; name: string }

type Health = 'not_configured' | 'untested' | 'healthy' | 'error';

interface MetaState {
  ok: boolean;
  pixelId: string;
  hasAccessToken: boolean;
  testEventCode: string;
}

const MASKED = '••••••••';

export default function MetaSettingsPage() {
  const router = useRouter();

  const [me, setMe] = useState<Me | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);

  const [pixelId, setPixelId] = useState<string>('');
  const [hasAccessToken, setHasAccessToken] = useState<boolean>(false);
  const [accessToken, setAccessToken] = useState<string>('');
  const [accessTokenEdited, setAccessTokenEdited] = useState<boolean>(false);
  const [testEventCode, setTestEventCode] = useState<string>('');
  // The value actually PERSISTED. The banner keys off this, not the input,
  // so typing a code doesn't warn before it can do any harm.
  const [savedTestEventCode, setSavedTestEventCode] = useState<string>('');
  const [stateLoaded, setStateLoaded] = useState(false);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Session-only test outcome (we don't persist test history server-side in Phase 1)
  const [sessionTestState, setSessionTestState] = useState<'idle' | 'healthy' | 'error'>('idle');
  const [testResponse, setTestResponse] = useState<string | null>(null);

  // ─── Role gate ───────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/auth/me').then((r) => r.json()).then((d) => {
      if (!d?.ok) { router.replace('/login'); return; }
      if (d.user.role !== 'host') { router.replace('/admin/settings'); return; }
      setMe(d.user);
      setMeLoaded(true);
    });
  }, [router]);

  useEffect(() => {
    if (!meLoaded) return;
    refreshState();
  }, [meLoaded]);

  function refreshState() {
    fetch('/api/settings/meta').then((r) => r.json()).then((d: MetaState) => {
      if (!d?.ok) return;
      setPixelId(d.pixelId || '');
      setHasAccessToken(!!d.hasAccessToken);
      setTestEventCode(d.testEventCode || '');
      setSavedTestEventCode(d.testEventCode || '');
      setStateLoaded(true);
    });
  }

  /**
   * Clear the test code and save immediately.
   *
   * Separate from the form's save() so the banner is a one-click fix: an
   * operator who has just been told real conversions are being discarded
   * should not have to find the right field, blank it and remember to submit.
   * Sends only the pixel id + empty code — never touches the access token,
   * which the API leaves alone when the key is absent.
   */
  async function clearTestCode() {
    setSaving(true); setError(null); setFlash(null);
    try {
      const res = await fetch('/api/settings/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pixelId: pixelId.trim(), testEventCode: '' }),
      });
      const d = await res.json();
      if (!d.ok) { setError(d.message || 'Could not clear the test code.'); return; }
      setTestEventCode(d.testEventCode || '');
      setSavedTestEventCode(d.testEventCode || '');
      setFlash('Test code cleared — conversions now go to your live dataset.');
      setTimeout(() => setFlash(null), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setSaving(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null); setFlash(null);
    try {
      const body: Record<string, string> = {
        pixelId: pixelId.trim(),
        testEventCode: testEventCode.trim(),
      };
      if (accessTokenEdited) body.accessToken = accessToken;
      const res = await fetch('/api/settings/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!d.ok) { setError(d.message || 'Save failed.'); return; }
      setPixelId(d.pixelId || '');
      setHasAccessToken(!!d.hasAccessToken);
      setTestEventCode(d.testEventCode || '');
      setSavedTestEventCode(d.testEventCode || '');
      setAccessToken('');
      setAccessTokenEdited(false);
      // A save invalidates prior test-success state (config may have changed)
      setSessionTestState('idle');
      setTestResponse(null);
      setFlash('Saved. Fire a test event to confirm the connection.');
      setTimeout(() => setFlash(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true); setError(null); setFlash(null); setTestResponse(null);
    try {
      const res = await fetch('/api/settings/meta/test', { method: 'POST' });
      const d = await res.json();
      setTestResponse(JSON.stringify(d, null, 2));
      if (d.ok) {
        setSessionTestState('healthy');
        setFlash('Test event fired. Check the Meta Events Manager → Test Events tab to confirm receipt.');
      } else {
        setSessionTestState('error');
        setError(d.message || 'Meta rejected the test event.');
      }
    } catch (err) {
      setSessionTestState('error');
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setTesting(false);
    }
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setFlash(`${label} copied.`);
      setTimeout(() => setFlash(null), 3000);
    } catch {
      setFlash(`Couldn't copy automatically — select and copy manually.`);
    }
  }

  function validPixelId(id: string): boolean {
    return /^\d{15,16}$/.test(id);
  }

  if (!meLoaded || !stateLoaded) {
    return <div className="max-w-3xl mx-auto px-4 py-8 text-slate-400">Loading…</div>;
  }

  // ─── Status derivation ──────────────────────────────────────────────────
  // not_configured: pixel ID empty
  // untested: pixel ID + access token saved, no test sent yet
  // healthy: latest test in this session succeeded
  // error: latest test in this session failed
  const health: Health =
    !pixelId ? 'not_configured' :
    sessionTestState === 'healthy' ? 'healthy' :
    sessionTestState === 'error' ? 'error' :
    (pixelId && hasAccessToken) ? 'untested' :
    'not_configured';

  const pillCls =
    health === 'healthy'        ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
    health === 'error'          ? 'bg-rose-50 text-rose-700 border-rose-200' :
    health === 'untested'       ? 'bg-amber-50 text-amber-700 border-amber-200' :
                                  'bg-slate-50 text-slate-600 border-slate-200';
  const pillLabel =
    health === 'healthy'        ? 'Connected · Healthy' :
    health === 'error'          ? 'Connection Issue' :
    health === 'untested'       ? 'Saved · Untested' :
                                  'Not configured';

  const pixelIdValid = pixelId === '' || validPixelId(pixelId);
  const accessTokenInputValue = accessTokenEdited
    ? accessToken
    : (hasAccessToken ? MASKED : '');

  const snippet = `<script>
  fbq('init', '${pixelId || 'YOUR_PIXEL_ID'}');
  fbq('track', 'PageView');
</script>`;

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 md:py-8">
      <button
        type="button"
        onClick={() => router.push('/admin/settings')}
        className="text-xs text-slate-500 hover:text-slate-900 flex items-center gap-1 mb-2"
      >
        ← Back to Settings
      </button>

      <div className="text-[11px] tracking-widest uppercase text-slate-400">Integrations</div>
      <div className="flex items-center justify-between gap-3 flex-wrap mt-1">
        <h1 className="text-2xl font-bold text-slate-900">Meta Pixel</h1>
        <span className={`text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-full border ${pillCls}`}>
          {pillLabel}
        </span>
      </div>
      <p className="text-sm text-slate-500 mt-1 max-w-2xl">
        Track event-ad performance in Meta Ads Manager. The Pixel fires browser-side on public event
        pages; the Conversions API mirrors key events server-side so conversions still match even
        when cookies are blocked. Only the host can view or change these credentials.
      </p>

      {flash && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 px-3 py-2 text-sm break-all">
          {flash}
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 px-3 py-2 text-sm">
          {error}
        </div>
      )}

      {/*
        Test-mode warning.

        A test event code is not a harmless debug flag: it is attached to EVERY
        real conversion (ticket sale, paid booking, reservation), and Meta then
        routes all of them into the Test Events tab, deliberately excluded from
        the dataset, reporting and ad optimisation. A venue can sell out while
        Ads Manager reports zero purchases, with nothing obviously wrong.
        Keyed off the SAVED value, not the input, so typing a code doesn't warn
        before it can actually do harm.
      */}
      {stateLoaded && savedTestEventCode.trim() !== '' && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <span aria-hidden className="text-amber-600 text-base leading-none mt-0.5">⚠</span>
            <div className="text-sm text-amber-900">
              <div className="font-semibold">
                Test mode is ON — real conversions are being kept out of your dataset
              </div>
              <p className="mt-1 text-amber-800">
                Every sale, booking and reservation is being tagged{' '}
                <span className="font-mono font-semibold">{savedTestEventCode}</span> and sent to
                Meta&apos;s <strong>Test Events</strong> tab only. They will <strong>not</strong>{' '}
                appear in Ads Manager and <strong>cannot</strong> be used to optimise campaigns.
              </p>
              <p className="mt-1.5 text-amber-800">
                Use this only while debugging. Clear the field below and save to go live.
              </p>
              <button
                type="button"
                onClick={clearTestCode}
                disabled={saving}
                className="mt-2.5 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
              >
                {saving ? 'Clearing…' : 'Clear test code & go live'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Configuration */}
      <form onSubmit={save} className="card mt-6 space-y-4">
        <div className="text-xs uppercase tracking-widest text-slate-500">Configuration</div>

        <div>
          <label className="label">Pixel ID</label>
          <input
            className="input font-mono text-xs"
            value={pixelId}
            onChange={(e) => setPixelId(e.target.value.replace(/\D/g, ''))}
            placeholder="1234567890123456"
            inputMode="numeric"
            maxLength={16}
          />
          {!pixelIdValid && (
            <div className="text-xs text-rose-600 mt-1">Pixel ID should be 15 or 16 digits.</div>
          )}
          <div className="text-xs text-slate-500 mt-1.5">
            Find it in Meta Business Manager → Events Manager → Data Sources → your Pixel → Settings.
          </div>
        </div>

        <div>
          <label className="label">Conversions API Access Token</label>
          <input
            className="input font-mono text-xs"
            type="password"
            value={accessTokenInputValue}
            onChange={(e) => {
              setAccessTokenEdited(true);
              setAccessToken(e.target.value);
            }}
            onFocus={() => {
              if (!accessTokenEdited && hasAccessToken) {
                // Switching to edit mode — clear the mask
                setAccessTokenEdited(true);
                setAccessToken('');
              }
            }}
            placeholder={hasAccessToken ? '' : 'EAAxxxxxxxxxxxx…'}
            autoComplete="off"
          />
          <div className="text-xs text-slate-500 mt-1.5">
            Generate it in Events Manager → Settings → Conversions API → <em>Generate access token</em>.
            {hasAccessToken && !accessTokenEdited && ' Stored token left in place unless you type a new one.'}
          </div>
        </div>

        <div className="flex gap-3 items-center">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || !pixelIdValid}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>

      {/* Test event */}
      <div className="card mt-4 space-y-4">
        <div className="text-xs uppercase tracking-widest text-slate-500">Test event</div>

        <div>
          <label className="label">Test Event Code (optional)</label>
          <input
            className="input font-mono text-xs"
            value={testEventCode}
            onChange={(e) => setTestEventCode(e.target.value)}
            placeholder="TEST12345"
          />
          <div className="text-xs text-slate-500 mt-1.5">
            While testing, grab a temporary <span className="font-mono">test_event_code</span> from
            Meta Events Manager → Test Events tab. Save it here, then fire a test — it will appear
            in the Test Events tab in real-time, confirming the integration works. Remove the code
            (and save again) once you go live so real events stop being routed to the test bucket.
          </div>
        </div>

        <div>
          <button
            type="button"
            onClick={sendTest}
            disabled={testing || !pixelId || !hasAccessToken}
            className="btn btn-secondary"
            title={!pixelId || !hasAccessToken ? 'Save Pixel ID and Access Token first' : ''}
          >
            {testing ? 'Sending…' : 'Send test PageView'}
          </button>
          {(!pixelId || !hasAccessToken) && (
            <span className="text-xs text-slate-500 ml-3">
              Save Pixel ID and Access Token first.
            </span>
          )}
        </div>

        {testResponse && (
          <div>
            <div className="text-xs text-slate-500 mb-1.5">Meta&apos;s response</div>
            <pre className="bg-slate-900 text-slate-100 text-xs p-3 rounded-lg overflow-x-auto">
{testResponse}
            </pre>
          </div>
        )}
      </div>

      {/* Snippet preview */}
      <div className="card mt-4 space-y-3">
        <div className="text-xs uppercase tracking-widest text-slate-500">Pixel snippet · injected on public event pages</div>
        <div className="text-sm text-slate-600">
          This snippet fires automatically on every public event page
          (<span className="font-mono text-xs">/event/[slug]</span>). Copy it if you also want to
          track external pages — e.g. a Wix or Carrd landing page that links into the booking flow.
        </div>
        <div className="flex gap-2 items-stretch">
          <pre className="bg-slate-900 text-slate-100 text-xs p-3 rounded-lg overflow-x-auto flex-1">
{snippet}
          </pre>
          <button
            type="button"
            onClick={() => copy(snippet, 'Snippet')}
            className="btn btn-secondary !px-4 whitespace-nowrap self-start"
          >
            Copy
          </button>
        </div>
      </div>

      {/* How it works */}
      <div className="card mt-4 space-y-2">
        <div className="text-xs uppercase tracking-widest text-slate-500 mb-1">How it works</div>
        <ul className="text-sm text-slate-600 space-y-2 leading-relaxed list-disc ml-5">
          <li>
            Customer clicks your Meta ad → lands on{' '}
            <span className="font-mono text-xs">https://wallet.akanhyd.com/event/[slug]</span> →
            Pixel auto-fires <span className="font-mono text-xs">PageView</span> and{' '}
            <span className="font-mono text-xs">ViewContent</span>.
          </li>
          <li>
            Customer submits the booking form → Pixel fires{' '}
            <span className="font-mono text-xs">Lead</span> (browser-side AND server-side CAPI for
            redundancy).
          </li>
          <li>
            Door staff issues the ticket → server fires{' '}
            <span className="font-mono text-xs">Purchase</span> with the customer&apos;s hashed
            phone + value.
          </li>
          <li>
            All conversions match back to the original ad click via the{' '}
            <span className="font-mono text-xs">_fbp</span> + <span className="font-mono text-xs">_fbc</span>{' '}
            cookies set on page load.
          </li>
        </ul>
      </div>

      <div className="mt-6 text-xs text-slate-400">
        Logged in as <span className="font-medium text-slate-600">{me?.name}</span> (host).
        Token reveals and saves are recorded in the audit log.
      </div>
    </div>
  );
}
