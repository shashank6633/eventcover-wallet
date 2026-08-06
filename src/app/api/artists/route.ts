import { NextRequest, NextResponse } from 'next/server';
import { listArtists, createArtist } from '@/lib/artists';
import { requireRole } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await requireRole(['host', 'manager']);
  if ('forbidden' in session) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status });
  }
  return NextResponse.json({ ok: true, artists: listArtists() });
}

export async function POST(req: NextRequest) {
  const session = await requireRole(['host', 'manager']);
  if ('forbidden' in session) {
    return NextResponse.json({ ok: false, message: session.message }, { status: session.status });
  }

  const body = await req.json().catch(() => ({}));
  if (!body?.name) {
    return NextResponse.json({ ok: false, message: 'Artist name is required.' }, { status: 400 });
  }

  try {
    const artist = createArtist(
      {
        name: String(body.name),
        about: body.about ? String(body.about) : null,
        social_url: body.social_url ? String(body.social_url) : null,
        image_data: body.image_data ? String(body.image_data) : null,
        // Counts are clamped in createArtist — the route only allowlists keys.
        vocalists: body.vocalists == null ? null : Number(body.vocalists),
        members: body.members == null ? null : Number(body.members),
        set_minutes: body.set_minutes == null ? null : Number(body.set_minutes),
      },
      session.name,
    );
    return NextResponse.json({ ok: true, artist });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create artist.';
    return NextResponse.json({ ok: false, message: msg }, { status: 400 });
  }
}
