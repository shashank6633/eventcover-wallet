'use client';

import { useEffect, useState } from 'react';
import type { Artist } from '@/lib/artists';
import { ImageUpload } from '@/components/ImageUpload';

export default function ArtistsPage() {
  const [artists, setArtists] = useState<Artist[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Artist | 'new' | null>(null);
  const [me, setMe] = useState<{ role: string } | null>(null);
  const [query, setQuery] = useState('');

  async function load() {
    setLoading(true);
    const data = await fetch('/api/artists', { cache: 'no-store' }).then((r) => r.json());
    if (data.ok) setArtists(data.artists || []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    fetch('/api/auth/me').then((r) => r.json()).then((d) => { if (d.ok) setMe(d.user); });
  }, []);

  async function remove(a: Artist) {
    if (!confirm(`Delete artist "${a.name}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/artists/${a.id}`, { method: 'DELETE' }).then((r) => r.json());
    if (!res.ok) { alert(res.message); return; }
    load();
  }

  const canDelete = me?.role === 'host';
  const filtered = query.trim()
    ? artists.filter((a) => a.name.toLowerCase().includes(query.trim().toLowerCase()))
    : artists;

  return (
    <div className="max-w-6xl mx-auto px-6 md:px-8 py-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[11px] tracking-widest uppercase text-slate-500">Talent</div>
          <h2 className="text-xl font-semibold text-slate-900 mt-1">Artists / Event Hosts</h2>
        </div>
        {!editing && (
          <button className="btn btn-dark inline-flex items-center gap-2" onClick={() => setEditing('new')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            Add Artist
          </button>
        )}
      </div>

      {editing && (
        <ArtistForm
          initial={editing === 'new' ? null : editing}
          onSave={async () => { await load(); setEditing(null); }}
          onCancel={() => setEditing(null)}
        />
      )}

      {!editing && artists.length > 0 && (
        <div className="mt-6">
          <input
            className="input max-w-sm"
            placeholder="Search by artist name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {!editing && (
        <div className="mt-4">
          {loading ? (
            <div className="card text-slate-500 text-sm">Loading…</div>
          ) : filtered.length === 0 ? (
            <EmptyState hasArtists={artists.length > 0} onAdd={() => setEditing('new')} />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map((a) => (
                <ArtistCard
                  key={a.id}
                  artist={a}
                  onEdit={() => setEditing(a)}
                  onDelete={canDelete ? () => remove(a) : undefined}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ArtistCard({ artist, onEdit, onDelete }: {
  artist: Artist;
  onEdit: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="card group p-0 overflow-hidden">
      <div className="bg-slate-100" style={{ aspectRatio: '4 / 3' }}>
        {artist.image_data ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={artist.image_data} alt={artist.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-400">
            <Initials name={artist.name} />
          </div>
        )}
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-slate-900 truncate">{artist.name}</div>
            {!artist.active && <span className="tag tag-exhausted mt-1 inline-block">Disabled</span>}
          </div>
          <div className="flex items-center gap-1">
            <button
              className="p-1.5 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition"
              onClick={onEdit}
              aria-label={`Edit ${artist.name}`}
            >
              <IconPencil />
            </button>
            {onDelete && (
              <button
                className="p-1.5 rounded text-slate-500 hover:text-rose-600 hover:bg-rose-50 transition"
                onClick={onDelete}
                aria-label={`Delete ${artist.name}`}
              >
                <IconTrash />
              </button>
            )}
          </div>
        </div>
        {artist.about && (
          <p className="text-xs text-slate-500 mt-2 line-clamp-3">{artist.about}</p>
        )}
        {artist.social_url && (
          <a
            href={artist.social_url}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-3 inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 font-medium"
          >
            <IconLink />
            <span className="truncate max-w-[180px]">{prettifyUrl(artist.social_url)}</span>
          </a>
        )}
      </div>
    </div>
  );
}

function ArtistForm({ initial, onSave, onCancel }: {
  initial: Artist | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? '');
  const [about, setAbout] = useState(initial?.about ?? '');
  const [socialUrl, setSocialUrl] = useState(initial?.social_url ?? '');
  const [imageData, setImageData] = useState<string | null>(initial?.image_data ?? null);
  // 0 is the stored "not specified" value, so show it as an empty box.
  const [members, setMembers] = useState(initial?.members ? String(initial.members) : '');
  const [vocalists, setVocalists] = useState(initial?.vocalists ? String(initial.vocalists) : '');
  const [setMinutes, setSetMinutes] = useState(initial?.set_minutes ? String(initial.set_minutes) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Artist name is required.'); return; }
    if (socialUrl.trim() && !isValidUrl(socialUrl.trim())) {
      setError('Social media URL must start with http:// or https://');
      return;
    }
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        about: about.trim() || null,
        social_url: socialUrl.trim() || null,
        image_data: imageData,
        members: Number(members) || 0,
        vocalists: Number(vocalists) || 0,
        set_minutes: Number(setMinutes) || 0,
      };
      const url = isEdit ? `/api/artists/${initial!.id}` : '/api/artists';
      const method = isEdit ? 'PATCH' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!data.ok) { setError(data.message || 'Save failed.'); return; }
      onSave();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card mt-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-slate-900">
          {isEdit ? `Edit ${initial!.name}` : 'Add artist'}
        </div>
        <button type="button" className="text-xs text-slate-500 hover:text-slate-900" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 px-3 py-2 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[220px,1fr] gap-6 items-start">
        <ImageUpload
          value={imageData}
          onChange={setImageData}
          label="Artist image"
          helperText="Drop or click. Auto-resized to 800×800. PNG · JPG · WebP."
        />

        <div className="space-y-4 min-w-0">
          <div>
            <label className="label">Artist name <span className="text-rose-600">*</span></label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Nucleya"
              autoFocus
            />
          </div>

          <div>
            <label className="label">About</label>
            <textarea
              className="input min-h-[120px]"
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              placeholder="Genre, headline tracks, what they bring to the night, fee notes…"
            />
            <div className="mt-1.5 text-xs text-slate-500">
              Shown on the artist card and (eventually) on guest-facing event pages.
            </div>
          </div>

          <div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">Members</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={members}
                  onChange={(e) => setMembers(e.target.value)}
                  placeholder="—"
                />
              </div>
              <div>
                <label className="label">Vocalists</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={vocalists}
                  onChange={(e) => setVocalists(e.target.value)}
                  placeholder="—"
                />
              </div>
              <div>
                <label className="label">Set length (minutes)</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={setMinutes}
                  onChange={(e) => setSetMinutes(e.target.value)}
                  placeholder="—"
                />
              </div>
            </div>
            <div className="mt-1.5 text-xs text-slate-500">
              Line-up detail for the guest-facing artist profile — how many on stage, how many singing,
              and how long they play in minutes. Leave blank if it isn&apos;t locked in yet.
            </div>
          </div>

          <div>
            <label className="label">Social media URL</label>
            <input
              className="input"
              type="url"
              value={socialUrl}
              onChange={(e) => setSocialUrl(e.target.value)}
              placeholder="https://instagram.com/..."
            />
            <div className="mt-1.5 text-xs text-slate-500">
              Instagram, Spotify, SoundCloud, YouTube — anything you want the guest to be able to click through to.
            </div>
          </div>
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : (isEdit ? 'Save changes' : 'Create artist')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function EmptyState({ hasArtists, onAdd }: { hasArtists: boolean; onAdd: () => void }) {
  if (hasArtists) {
    // Filtered out by search
    return (
      <div className="card text-center py-8">
        <div className="text-sm text-slate-500">No artists match your search.</div>
      </div>
    );
  }
  return (
    <div className="card text-center py-12">
      <div className="w-14 h-14 mx-auto rounded-full bg-brand-50 text-brand-600 flex items-center justify-center">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="2" width="6" height="13" rx="3"/>
          <path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"/>
        </svg>
      </div>
      <div className="text-base font-semibold text-slate-900 mt-4">No artists yet</div>
      <p className="text-sm text-slate-500 mt-1">Add DJs, performers, MCs — anyone playing your events.</p>
      <button onClick={onAdd} className="btn btn-primary mt-5 inline-flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        Add your first artist
      </button>
    </div>
  );
}

function Initials({ name }: { name: string }) {
  const init = name.split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  return <div className="text-2xl font-bold text-slate-300">{init || '?'}</div>;
}

function prettifyUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
  } catch { return url; }
}

function isValidUrl(s: string): boolean {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

function IconPencil() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9"/>
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
      <path d="M10 11v6M14 11v6"/>
    </svg>
  );
}

function IconLink() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>
  );
}
