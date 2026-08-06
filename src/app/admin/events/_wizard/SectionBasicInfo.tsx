'use client';

import { useState } from 'react';
import { RichTextEditor } from '@/components/RichTextEditor';
import type { WizardState, CategorySlot } from './types';
import { DAY_CATEGORY_LABELS, NIGHT_CATEGORY_LABELS } from './types';

interface Props {
  state: WizardState;
  onChange: (patch: Partial<WizardState>) => void;
}

const SUMMARY_MAX = 100;

/**
 * Basic Info section — the canonical "what is this event?" page.
 *
 * Fields:
 *   • Event Title             (required)
 *   • URL Key (slug)          (auto-generated server-side when blank)
 *   • One-Line Summary        (NEW — shown in Meta Ad previews + event lists)
 *   • Description (rich text) (required)
 *   • Public/Private toggle
 *   • Meta Pixel ID override  (only when public)
 *
 * AI Enhance button (top-right of Description) opens a "Coming soon" modal
 * since the Claude API key flow isn't built yet.
 */
export function SectionBasicInfo({ state, onChange }: Props) {
  const [aiOpen, setAiOpen] = useState(false);
  const summaryLen = state.one_line_summary.length;
  const summaryNearLimit = summaryLen > SUMMARY_MAX * 0.9;

  function setSlug(raw: string) {
    // Sanitize as user types — kebab-case, lowercase, max 80
    const cleaned = raw
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80);
    onChange({ slug: cleaned });
  }

  return (
    <div className="card space-y-6">
      <header>
        <h2 className="text-lg font-semibold text-slate-900">Basic Info</h2>
        <p className="text-sm text-slate-500 mt-1">
          Core details that show up on the public event page, WhatsApp previews, and Meta ad cards.
        </p>
      </header>

      {/* Event Name */}
      <div>
        <label className="label">
          Event Title <span className="text-rose-600">*</span>
        </label>
        <input
          className="input"
          value={state.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="e.g. Threeory Band Live at Akan"
          maxLength={150}
        />
      </div>

      {/* Event Category — Day / Night slot + label.
          Required before publish. The customer-facing site groups events into
          a "Day Events" rail and a "Night Events" rail using category_slot,
          and shows category_label as the on-card chip. Two-step picker:
            1. Pick slot (Day / Night)
            2. Pick a preset label scoped to that slot
          Switching slots resets the label so the picker always points at a
          valid (slot, label) pair. */}
      <div>
        <label className="label">
          Category <span className="text-rose-600">*</span>
        </label>
        <CategoryPicker
          slot={state.category_slot}
          label={state.category_label}
          onChange={({ slot, label }) => onChange({ category_slot: slot, category_label: label })}
        />
        <div className="text-[11px] text-slate-400 mt-1.5">
          Drives the Day Events / Night Events sections on your public site.
        </div>
      </div>

      {/* Public site metadata — consumed by the customer-facing events app.
          These don't affect venue operations (covers, wallets, door flow);
          they control how the event card renders on the public site. */}
      <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 space-y-4">
        <div>
          <div className="text-sm font-semibold text-slate-900">Public site card</div>
          <p className="text-[11px] text-slate-500 mt-0.5">
            How this event appears on your public events site. Doesn&rsquo;t affect door operations.
          </p>
        </div>

        {/* Tagline */}
        <div>
          <label className="label">Tagline</label>
          <input
            className="input"
            value={state.tagline}
            onChange={(e) => onChange({ tagline: e.target.value.slice(0, 120) })}
            placeholder="e.g. Soulful indie covers under the stars"
            maxLength={120}
          />
          <div className="text-[11px] text-slate-400 mt-1">
            One short line under the title on the card. Max 120 characters.
          </div>
        </div>

        {/* Hue swatches */}
        <div>
          <label className="label">Card colour</label>
          <HuePicker value={state.hue} onChange={(hue) => onChange({ hue })} />
        </div>

        {/* Badge note + capacity side by side */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Badge text</label>
            <input
              className="input"
              value={state.note}
              onChange={(e) => onChange({ note: e.target.value.slice(0, 40) })}
              placeholder="e.g. Headliner"
              maxLength={40}
            />
            <div className="text-[11px] text-slate-400 mt-1">
              Small pill next to the title. Leave blank for none.
            </div>
          </div>
          <div>
            <label className="label">Capacity</label>
            <input
              className="input"
              type="number"
              min={0}
              value={state.capacity || ''}
              onChange={(e) => onChange({ capacity: Number(e.target.value) || 0 })}
              placeholder="0 = unlimited"
            />
            <div className="text-[11px] text-slate-400 mt-1">
              Drives &ldquo;Selling fast&rdquo; / &ldquo;Sold out&rdquo; on the public card.
            </div>
          </div>
        </div>

        {/* Featured toggle */}
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={state.featured}
            onChange={(e) => onChange({ featured: e.target.checked })}
            className="accent-brand-500 w-4 h-4 mt-0.5"
          />
          <span>
            <span className="text-sm font-medium text-slate-800">Feature this event</span>
            <span className="block text-[11px] text-slate-500">
              Pins the card to the top of its Day / Night section on the public site.
            </span>
          </span>
        </label>
      </div>

      {/* URL Key */}
      <div>
        <label className="label">URL Key</label>
        <input
          className="input font-mono text-sm"
          value={state.slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="e.g. threeory-band-live-2026-06-15"
        />
        <div className="text-[11px] text-slate-400 mt-1">
          Only lowercase letters, numbers, and hyphens. Leave blank to auto-generate from name + date.
          Preview: <span className="font-mono">wallet.akanhyd.com/event/{state.slug || '[auto]'}</span>
        </div>
      </div>

      {/* One-Line Summary */}
      <div>
        <div className="flex items-baseline justify-between">
          <label className="label">One-Line Summary</label>
          <span className={`text-[11px] ${summaryNearLimit ? 'text-amber-600' : 'text-slate-400'}`}>
            {summaryLen}/{SUMMARY_MAX}
          </span>
        </div>
        <textarea
          className="input min-h-[60px] resize-none"
          value={state.one_line_summary}
          onChange={(e) => onChange({ one_line_summary: e.target.value.slice(0, SUMMARY_MAX) })}
          placeholder="A relaxing weekend of yoga and wellness"
          maxLength={SUMMARY_MAX}
          rows={2}
        />
        <div className="text-[11px] text-slate-400 mt-1">
          Shown in event previews, Meta ad headlines, and search results. Keep it tight.
        </div>
      </div>

      {/* Description with AI Enhance */}
      <div>
        <div className="flex items-baseline justify-between">
          <label className="label">
            Full Description <span className="text-rose-600">*</span>
          </label>
          <button
            type="button"
            onClick={() => setAiOpen(true)}
            className="text-[11px] inline-flex items-center gap-1 text-brand-600 hover:text-brand-700 font-medium"
          >
            ✨ Enhance with AI
          </button>
        </div>
        <RichTextEditor
          value={state.description}
          onChange={(html) => onChange({ description: html })}
          placeholder="Tell guests what to expect — the artist, the vibe, special inclusions…"
          minHeight={200}
        />
      </div>

      {/* Visibility toggle */}
      <div className="pt-2 border-t border-slate-100">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="mt-1 accent-brand-500 cursor-pointer"
            checked={state.is_public}
            onChange={(e) => onChange({ is_public: e.target.checked })}
          />
          <div className="flex-1">
            <div className="text-sm font-semibold text-slate-900">Public event</div>
            <div className="text-xs text-slate-500 mt-1">
              When OFF, the public landing page returns 404 and the event is only visible to admin staff.
            </div>
          </div>
        </label>
      </div>

      {/* Meta Pixel override (only when public) */}
      {state.is_public && (
        <div className="pt-4 border-t border-slate-100">
          <div className="text-[11px] uppercase tracking-widest text-slate-500 mb-2">
            Marketing
          </div>
          <label className="label">Meta Pixel ID override</label>
          <input
            className="input font-mono text-sm"
            value={state.meta_pixel_id}
            onChange={(e) => onChange({ meta_pixel_id: e.target.value.replace(/\D/g, '') })}
            placeholder="uses venue default"
            inputMode="numeric"
            maxLength={17}
          />
          <div className="text-[11px] text-slate-400 mt-1">
            Blank = use venue-wide Pixel from{' '}
            <a href="/admin/settings/meta" target="_blank" className="text-brand-600 underline">
              Settings → Meta
            </a>.
          </div>
        </div>
      )}

      {/* AI Enhance modal stub */}
      {aiOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setAiOpen(false)}>
          <div
            className="bg-white rounded-xl border border-slate-200 max-w-md w-full p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <h3 className="text-lg font-semibold text-slate-900">✨ Enhance with AI</h3>
              <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-semibold">
                Coming · Phase 2
              </span>
            </div>
            <p className="text-sm text-slate-600">
              Once enabled, this will rewrite your description into polished marketing copy
              using Claude. We&apos;ll need a Claude API key configured under{' '}
              <span className="font-mono">Settings → AI</span> before turning this on.
            </p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setAiOpen(false)}
                className="btn btn-primary"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * CategoryPicker — two-step radio: Slot (Day/Night) → Label (preset list)
 *
 * Renders inside SectionBasicInfo directly below Event Title. Switching the
 * slot RESETS the label (a Day label is invalid under Night slot, etc.), so
 * the picker never lets the user persist a (slot, label) pair that doesn't
 * belong together.
 *
 * Preset lists live in ./types.ts (DAY_CATEGORY_LABELS / NIGHT_CATEGORY_LABELS)
 * so the public site renderer can use the same source of truth when grouping.
 * ──────────────────────────────────────────────────────────────────────── */
function CategoryPicker({
  slot,
  label,
  onChange,
}: {
  slot: CategorySlot | null;
  label: string | null;
  onChange: (next: { slot: CategorySlot | null; label: string | null }) => void;
}) {
  const labels: readonly string[] =
    slot === 'day'   ? DAY_CATEGORY_LABELS :
    slot === 'night' ? NIGHT_CATEGORY_LABELS :
    [];

  function pickSlot(next: CategorySlot) {
    if (next === slot) return;
    // Switching slots invalidates the label; reset to null so the operator
    // is forced to pick again from the new list.
    onChange({ slot: next, label: null });
  }

  return (
    <div className="space-y-2.5">
      {/* Step 1 — Day / Night */}
      <div className="grid grid-cols-2 gap-2">
        <SlotTile
          active={slot === 'day'}
          icon="☀️"
          title="Day Event"
          hint="Brunch · Workshops · Evenings"
          onClick={() => pickSlot('day')}
        />
        <SlotTile
          active={slot === 'night'}
          icon="🌙"
          title="Night Event"
          hint="Live Band · DJ Night"
          onClick={() => pickSlot('night')}
        />
      </div>

      {/* Step 2 — preset labels (filtered to the chosen slot) */}
      {slot && (
        <div className="flex flex-wrap gap-1.5">
          {labels.map((l) => {
            const active = label === l;
            return (
              <button
                key={l}
                type="button"
                onClick={() => onChange({ slot, label: l })}
                className={
                  'text-xs font-medium px-3 py-1.5 rounded-full border transition ' +
                  (active
                    ? 'bg-brand-50 border-brand-300 text-brand-800'
                    : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300')
                }
              >
                {l}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * HuePicker — swatch grid for the public-site card colour theme
 *
 * The customer-facing events app maps each hue name to a gradient/accent
 * pair. We render an approximate swatch here so the host can see roughly
 * what they're picking without leaving the wizard. The swatch colours are
 * intentionally hardcoded (not pulled from the customer app) — this is a
 * preview affordance, and coupling the two would mean a shared package
 * for five hex codes.
 * ──────────────────────────────────────────────────────────────────────── */
const HUE_SWATCHES: Array<{ id: string; label: string; css: string }> = [
  { id: 'sunny',    label: 'Sunny',    css: 'linear-gradient(135deg,#FFD166,#F5A524)' },
  { id: 'tomato',   label: 'Tomato',   css: 'linear-gradient(135deg,#FF8A65,#E64A19)' },
  { id: 'crimson',  label: 'Crimson',  css: 'linear-gradient(135deg,#EF5DA8,#C2185B)' },
  { id: 'ocean',    label: 'Ocean',    css: 'linear-gradient(135deg,#4FC3F7,#0277BD)' },
  { id: 'mint',     label: 'Mint',     css: 'linear-gradient(135deg,#7BE0AD,#009688)' },
  { id: 'lavender', label: 'Lavender', css: 'linear-gradient(135deg,#B39DFF,#6A3FD4)' },
  { id: 'slate',    label: 'Slate',    css: 'linear-gradient(135deg,#94A3B8,#475569)' },
];

function HuePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (hue: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {HUE_SWATCHES.map((h) => {
        const active = value === h.id;
        return (
          <button
            key={h.id}
            type="button"
            onClick={() => onChange(h.id)}
            title={h.label}
            aria-label={h.label}
            aria-pressed={active}
            className={
              'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition ' +
              (active
                ? 'border-brand-500 bg-white ring-2 ring-brand-100'
                : 'border-slate-200 bg-white hover:border-slate-300')
            }
          >
            <span
              className="w-5 h-5 rounded-md border border-black/10 flex-shrink-0"
              style={{ background: h.css }}
              aria-hidden
            />
            <span className={`text-xs font-medium ${active ? 'text-brand-800' : 'text-slate-600'}`}>
              {h.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SlotTile({
  active, icon, title, hint, onClick,
}: {
  active: boolean;
  icon: string;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-lg border px-3 py-2.5 text-left transition ' +
        (active
          ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-100'
          : 'border-slate-200 bg-white hover:border-slate-300')
      }
    >
      <div className="flex items-center gap-2">
        <span className="text-base" aria-hidden>{icon}</span>
        <span className={`text-sm font-semibold ${active ? 'text-brand-700' : 'text-slate-900'}`}>
          {title}
        </span>
      </div>
      <div className="text-[11px] text-slate-500 mt-0.5">{hint}</div>
    </button>
  );
}
