import { NextRequest, NextResponse } from 'next/server';
import { getArtist, updateArtist, deleteArtist, type ArtistPatch } from '@/lib/artists';
import { requireRole } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireRole(['host', 'manager']);
  if ('forbidden' in session) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status });
  }
  const { id } = await ctx.params;
  const a = getArtist(id);
  if (!a) return NextResponse.json({ ok: false, message: 'Not found.' }, { status: 404 });
  return NextResponse.json({ ok: true, artist: a });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireRole(['host', 'manager']);
  if ('forbidden' in session) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status });
  }
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  const patch: ArtistPatch = {};
  if (typeof body.name === 'string') patch.name = body.name;
  if ('about' in body) patch.about = body.about ?? null;
  if ('social_url' in body) patch.social_url = body.social_url ?? null;
  if ('image_data' in body) patch.image_data = body.image_data ?? null;
  if ('vocalists' in body) patch.vocalists = body.vocalists == null ? null : Number(body.vocalists);
  if ('members' in body) patch.members = body.members == null ? null : Number(body.members);
  if ('set_minutes' in body) patch.set_minutes = body.set_minutes == null ? null : Number(body.set_minutes);
  if (typeof body.active === 'boolean') patch.active = body.active;

  try {
    const a = updateArtist(id, patch, session.name);
    if (!a) return NextResponse.json({ ok: false, message: 'Not found.' }, { status: 404 });
    return NextResponse.json({ ok: true, artist: a });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Update failed.';
    return NextResponse.json({ ok: false, message: msg }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireRole(['host']);
  if ('forbidden' in session) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status });
  }
  const { id } = await ctx.params;
  const ok = deleteArtist(id, session.name);
  if (!ok) return NextResponse.json({ ok: false, message: 'Not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
